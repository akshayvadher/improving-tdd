import { beforeEach, describe, expect, it } from 'vitest';

import { CatalogFacade } from '../catalog/catalog.facade.js';
import { createCatalogFacade } from '../catalog/catalog.configuration.js';
import { InMemoryCatalogRepository } from '../catalog/in-memory-catalog.repository.js';
import {
  BookNotFoundError,
  CopyStatus,
  type BookDto,
  type BookId,
  type CopyDto,
  type CopyId,
  type Isbn,
  type NewBookDto,
  type NewCopyDto,
} from '../catalog/index.js';
import { sampleNewBook, sampleNewCopy } from '../catalog/sample-catalog-data.js';
import { createMembershipFacade } from '../membership/membership.configuration.js';
import { sampleNewMember } from '../membership/sample-membership-data.js';
import { InMemoryEventBus } from '../shared/events/in-memory-event-bus.js';
import { InMemoryReservationRepository } from './in-memory-reservation.repository.js';
import { createLendingFacade, type LendingOverrides } from './lending.configuration.js';
import type { ReservationDto } from './lending.types.js';
import type { ReservationRepository } from './reservation.repository.js';
import type { TransactionalContext } from './transactional-context.js';
import { CopyUnavailableError, LoanNotFoundError, MemberIneligibleError } from './lending.types.js';
import { sampleBorrowRequest, sampleReserveRequest } from './sample-lending-data.js';

function sequentialIds(prefix: string): () => string {
  let counter = 0;
  return () => `${prefix}-${++counter}`;
}

// Frozen clock — borrow uses it for `borrowedAt`/`dueDate`, return uses it for
// `returnedAt`. Deterministic times make event payload assertions trivial.
const FIXED_NOW = new Date('2030-01-15T00:00:00Z');
const fixedClock = (): Date => new Date(FIXED_NOW.getTime());

// --- Scene builder ------------------------------------------------------------
// We use the REAL Catalog and Membership facades, wired with their own
// in-memory defaults via their factory functions. No hand-rolled fakes — the
// other modules already ship zero-I/O test doubles (that's what `createXFacade`
// is for). The tests exercise real cross-module behavior at milliseconds.

interface Scene {
  facade: ReturnType<typeof createLendingFacade>;
  catalog: ReturnType<typeof createCatalogFacade>;
  membership: ReturnType<typeof createMembershipFacade>;
  bus: InMemoryEventBus;
  seedAvailableCopy(): Promise<{ copyId: string; bookId: BookId }>;
  seedMember(name?: string): Promise<{ memberId: string }>;
}

function buildScene(): Scene {
  return buildSceneWith({});
}

function buildSceneWith(extra: Partial<LendingOverrides>): Scene {
  const catalog = createCatalogFacade({ newId: sequentialIds('cat') });
  const membership = createMembershipFacade({ newId: sequentialIds('mem') });
  const bus = new InMemoryEventBus();
  const facade = createLendingFacade({
    catalogFacade: catalog,
    membershipFacade: membership,
    eventBus: bus,
    newId: sequentialIds('loan'),
    clock: fixedClock,
    ...extra,
  });

  // Unique ISBN / email per seeded artefact so real uniqueness rules are satisfied.
  let copySeq = 0;
  let memberSeq = 0;

  return {
    facade,
    catalog,
    membership,
    bus,
    async seedAvailableCopy() {
      copySeq += 1;
      const isbn = `978-${String(copySeq).padStart(10, '0')}`;
      const book = await catalog.addBook(sampleNewBook({ isbn }));
      const copy = await catalog.registerCopy(book.bookId, sampleNewCopy({ bookId: book.bookId }));
      return { copyId: copy.copyId, bookId: copy.bookId };
    },
    async seedMember(name = 'Member') {
      memberSeq += 1;
      const member = await membership.registerMember(
        sampleNewMember({ name, email: `member-${memberSeq}@lib.test` }),
      );
      return { memberId: member.memberId };
    },
  };
}

function eventTypes(bus: InMemoryEventBus): string[] {
  return bus.collected().map((event) => event.type);
}

describe('LendingFacade', () => {
  let scene: Scene;

  beforeEach(() => {
    scene = buildScene();
  });

  describe('borrow', () => {
    it('opens a loan and emits a LoanOpened event', async () => {
      // given an available copy and a registered member
      const copy = await scene.seedAvailableCopy();
      const alice = await scene.seedMember('Alice');
      const { memberId, copyId } = sampleBorrowRequest({
        memberId: alice.memberId,
        copyId: copy.copyId,
      });

      // when the member borrows the copy
      const loan = await scene.facade.borrow(memberId, copyId);

      // then the loan is persisted with the right owner and copy
      expect(loan.memberId).toBe(alice.memberId);
      expect(loan.copyId).toBe(copy.copyId);
      expect(loan.bookId).toBe(copy.bookId);
      expect(loan.returnedAt).toBeUndefined();
      expect(await scene.facade.listLoansFor(alice.memberId)).toEqual([loan]);

      // and a LoanOpened event was emitted on the bus
      expect(eventTypes(scene.bus)).toEqual(['LoanOpened']);
    });

    it('marks the copy unavailable in the catalog when a loan opens', async () => {
      const copy = await scene.seedAvailableCopy();
      const alice = await scene.seedMember('Alice');

      await scene.facade.borrow(alice.memberId, copy.copyId);

      // then the real catalog reflects the copy as unavailable
      expect((await scene.catalog.findCopy(copy.copyId)).status).toBe(CopyStatus.UNAVAILABLE);
    });

    it('rejects with MemberIneligibleError when the member is suspended, touching nothing', async () => {
      // given a suspended member and an available copy
      const copy = await scene.seedAvailableCopy();
      const alice = await scene.seedMember('Alice');
      await scene.membership.suspend(alice.memberId);

      // when the member tries to borrow
      await expect(scene.facade.borrow(alice.memberId, copy.copyId)).rejects.toBeInstanceOf(
        MemberIneligibleError,
      );

      // then no loan was recorded, no event emitted, and the copy is still available
      expect(await scene.facade.listLoansFor(alice.memberId)).toEqual([]);
      expect(scene.bus.collected()).toEqual([]);
      expect((await scene.catalog.findCopy(copy.copyId)).status).toBe(CopyStatus.AVAILABLE);
    });

    it('rejects with CopyUnavailableError when the copy is already checked out', async () => {
      // given a copy that has been borrowed by someone else
      const copy = await scene.seedAvailableCopy();
      const alice = await scene.seedMember('Alice');
      const bob = await scene.seedMember('Bob');
      await scene.facade.borrow(alice.memberId, copy.copyId);
      scene.bus.clear();

      // when bob tries to borrow it
      await expect(scene.facade.borrow(bob.memberId, copy.copyId)).rejects.toBeInstanceOf(
        CopyUnavailableError,
      );

      // then no new loan was recorded for bob and no event emitted
      expect(await scene.facade.listLoansFor(bob.memberId)).toEqual([]);
      expect(scene.bus.collected()).toEqual([]);
    });
  });

  describe('returnLoan', () => {
    it('closes the loan with returnedAt and emits a LoanReturned event', async () => {
      const copy = await scene.seedAvailableCopy();
      const alice = await scene.seedMember('Alice');
      const loan = await scene.facade.borrow(alice.memberId, copy.copyId);
      scene.bus.clear();

      const returned = await scene.facade.returnLoan(loan.loanId);

      expect(returned.returnedAt).toEqual(FIXED_NOW);
      expect((await scene.facade.listLoansFor(alice.memberId))[0]?.returnedAt).toEqual(FIXED_NOW);
      expect(eventTypes(scene.bus)).toEqual(['LoanReturned']);
    });

    it('marks the copy available in the catalog on return', async () => {
      const copy = await scene.seedAvailableCopy();
      const alice = await scene.seedMember('Alice');
      const loan = await scene.facade.borrow(alice.memberId, copy.copyId);

      await scene.facade.returnLoan(loan.loanId);

      expect((await scene.catalog.findCopy(copy.copyId)).status).toBe(CopyStatus.AVAILABLE);
    });

    it('fulfills a pending reservation and emits both LoanReturned and ReservationFulfilled', async () => {
      // given alice has borrowed the book and bob has reserved it
      const copy = await scene.seedAvailableCopy();
      const alice = await scene.seedMember('Alice');
      const bob = await scene.seedMember('Bob');
      const loan = await scene.facade.borrow(alice.memberId, copy.copyId);
      await scene.facade.reserve(bob.memberId, copy.bookId);
      scene.bus.clear();

      // when alice returns the book
      await scene.facade.returnLoan(loan.loanId);

      // then both events are emitted in the same transaction
      expect(eventTypes(scene.bus).sort()).toEqual(['LoanReturned', 'ReservationFulfilled']);
    });

    it('throws LoanNotFoundError when returning an unknown loan, with no events', async () => {
      await expect(scene.facade.returnLoan('never-issued')).rejects.toBeInstanceOf(
        LoanNotFoundError,
      );
      expect(scene.bus.collected()).toEqual([]);
    });
  });

  describe('reserve', () => {
    it('persists a reservation and emits a ReservationQueued event', async () => {
      const copy = await scene.seedAvailableCopy();
      const alice = await scene.seedMember('Alice');
      const { memberId, bookId } = sampleReserveRequest({
        memberId: alice.memberId,
        bookId: copy.bookId,
      });

      const reservation = await scene.facade.reserve(memberId, bookId);

      expect(reservation.memberId).toBe(alice.memberId);
      expect(reservation.bookId).toBe(bookId);
      expect(reservation.fulfilledAt).toBeUndefined();
      expect(eventTypes(scene.bus)).toEqual(['ReservationQueued']);
    });

    it('rejects with MemberIneligibleError when the member is suspended, touching nothing', async () => {
      const copy = await scene.seedAvailableCopy();
      const alice = await scene.seedMember('Alice');
      await scene.membership.suspend(alice.memberId);

      await expect(scene.facade.reserve(alice.memberId, copy.bookId)).rejects.toBeInstanceOf(
        MemberIneligibleError,
      );

      expect(scene.bus.collected()).toEqual([]);
    });
  });

  describe('listOverdueLoans', () => {
    it('returns loans whose dueDate is before now and which have not been returned', async () => {
      const copyOne = await scene.seedAvailableCopy();
      const copyTwo = await scene.seedAvailableCopy();
      const alice = await scene.seedMember('Alice');
      const bob = await scene.seedMember('Bob');
      const first = await scene.facade.borrow(alice.memberId, copyOne.copyId);
      const second = await scene.facade.borrow(bob.memberId, copyTwo.copyId);

      const wayLater = new Date(first.dueDate.getTime() + 24 * 60 * 60 * 1000);
      const overdue = await scene.facade.listOverdueLoans(wayLater);

      const overdueIds = overdue.map((loan) => loan.loanId).sort();
      expect(overdueIds).toEqual([first.loanId, second.loanId].sort());
    });

    it('excludes returned loans and loans still within their due date', async () => {
      const copyOne = await scene.seedAvailableCopy();
      const copyTwo = await scene.seedAvailableCopy();
      const alice = await scene.seedMember('Alice');
      const bob = await scene.seedMember('Bob');
      const returned = await scene.facade.borrow(alice.memberId, copyOne.copyId);
      await scene.facade.borrow(bob.memberId, copyTwo.copyId);
      await scene.facade.returnLoan(returned.loanId);

      const beforeDue = new Date(FIXED_NOW.getTime() + 60 * 60 * 1000);
      const overdue = await scene.facade.listOverdueLoans(beforeDue);

      expect(overdue).toEqual([]);
    });
  });

  describe('listLoansFor', () => {
    it('returns every loan belonging to the given member', async () => {
      const copyOne = await scene.seedAvailableCopy();
      const copyTwo = await scene.seedAvailableCopy();
      const copyThree = await scene.seedAvailableCopy();
      const alice = await scene.seedMember('Alice');
      const bob = await scene.seedMember('Bob');
      const first = await scene.facade.borrow(alice.memberId, copyOne.copyId);
      const second = await scene.facade.borrow(alice.memberId, copyTwo.copyId);
      await scene.facade.borrow(bob.memberId, copyThree.copyId);

      const alicesLoans = await scene.facade.listLoansFor(alice.memberId);

      expect(alicesLoans.map((loan) => loan.loanId).sort()).toEqual(
        [first.loanId, second.loanId].sort(),
      );
    });
  });

  describe('listActiveLoansWithQueuedReservations', () => {
    // AC-1.9 is satisfied by this whole describe block: facade-only exercise,
    // reuses the existing buildScene() harness, no new fakes / mocks.
    it('returns an empty array when no loans exist (AC-1.1)', async () => {
      const result = await scene.facade.listActiveLoansWithQueuedReservations();

      expect(result).toEqual([]);
    });

    it('reports queuedCount=0 for an active loan whose book has no reservations (AC-1.2)', async () => {
      const copy = await scene.seedAvailableCopy();
      const alice = await scene.seedMember('Alice');
      const loan = await scene.facade.borrow(alice.memberId, copy.copyId);

      const result = await scene.facade.listActiveLoansWithQueuedReservations();

      expect(result).toEqual([{ loan, queuedCount: 0 }]);
    });

    it('reports queuedCount=1 when one pending reservation exists on the same book (AC-1.3)', async () => {
      const copy = await scene.seedAvailableCopy();
      const alice = await scene.seedMember('Alice');
      const bob = await scene.seedMember('Bob');
      const loan = await scene.facade.borrow(alice.memberId, copy.copyId);
      await scene.facade.reserve(bob.memberId, copy.bookId);

      const result = await scene.facade.listActiveLoansWithQueuedReservations();

      expect(result).toEqual([{ loan, queuedCount: 1 }]);
    });

    it('reports queuedCount=3 when three pending reservations exist on the same book (AC-1.4)', async () => {
      const copy = await scene.seedAvailableCopy();
      const alice = await scene.seedMember('Alice');
      const bob = await scene.seedMember('Bob');
      const carol = await scene.seedMember('Carol');
      const dave = await scene.seedMember('Dave');
      const loan = await scene.facade.borrow(alice.memberId, copy.copyId);
      await scene.facade.reserve(bob.memberId, copy.bookId);
      await scene.facade.reserve(carol.memberId, copy.bookId);
      await scene.facade.reserve(dave.memberId, copy.bookId);

      const result = await scene.facade.listActiveLoansWithQueuedReservations();

      expect(result).toEqual([{ loan, queuedCount: 3 }]);
    });

    it('does not count fulfilled reservations toward queuedCount (AC-1.5)', async () => {
      // Setup: two reservations get fulfilled by borrowing+returning a copy
      // (returnLoan fulfils the oldest pending reservation for that book).
      // Then a third reservation is left pending, and a fresh active loan is
      // opened on the same book. Expected queuedCount === 1.
      const isbn = '978-9999999001';
      const book = await scene.catalog.addBook(sampleNewBook({ isbn }));
      const copyA = await scene.catalog.registerCopy(
        book.bookId,
        sampleNewCopy({ bookId: book.bookId }),
      );
      const copyB = await scene.catalog.registerCopy(
        book.bookId,
        sampleNewCopy({ bookId: book.bookId }),
      );
      const copyC = await scene.catalog.registerCopy(
        book.bookId,
        sampleNewCopy({ bookId: book.bookId }),
      );
      const alice = await scene.seedMember('Alice');
      const bob = await scene.seedMember('Bob');
      const carol = await scene.seedMember('Carol');
      const dave = await scene.seedMember('Dave');

      // Two reservations that will be fulfilled.
      await scene.facade.reserve(bob.memberId, book.bookId);
      await scene.facade.reserve(carol.memberId, book.bookId);

      // First borrow-return cycle fulfils bob's reservation.
      const loanA = await scene.facade.borrow(alice.memberId, copyA.copyId);
      await scene.facade.returnLoan(loanA.loanId);

      // Second borrow-return cycle fulfils carol's reservation.
      const loanB = await scene.facade.borrow(alice.memberId, copyB.copyId);
      await scene.facade.returnLoan(loanB.loanId);

      // A third reservation stays pending, and a fresh active loan is opened.
      await scene.facade.reserve(dave.memberId, book.bookId);
      const activeLoan = await scene.facade.borrow(alice.memberId, copyC.copyId);

      const result = await scene.facade.listActiveLoansWithQueuedReservations();

      expect(result).toEqual([{ loan: activeLoan, queuedCount: 1 }]);
    });

    it('reports queuedCount=0 when all reservations on the loan\'s book have been fulfilled', async () => {
      const isbn = '978-9999999004';
      const book = await scene.catalog.addBook(sampleNewBook({ isbn }));
      const copyA = await scene.catalog.registerCopy(
        book.bookId,
        sampleNewCopy({ bookId: book.bookId }),
      );
      const copyB = await scene.catalog.registerCopy(
        book.bookId,
        sampleNewCopy({ bookId: book.bookId }),
      );
      const alice = await scene.seedMember('Alice');
      const bob = await scene.seedMember('Bob');
      const carol = await scene.seedMember('Carol');
      const dave = await scene.seedMember('Dave');

      // Two reservations that will both be fulfilled.
      await scene.facade.reserve(bob.memberId, book.bookId);
      await scene.facade.reserve(carol.memberId, book.bookId);

      // First borrow-return cycle fulfils bob's reservation.
      const loanA1 = await scene.facade.borrow(alice.memberId, copyA.copyId);
      await scene.facade.returnLoan(loanA1.loanId);

      // Second borrow-return cycle fulfils carol's reservation. The book now
      // has zero pending reservations and two fulfilled ones.
      const loanA2 = await scene.facade.borrow(alice.memberId, copyA.copyId);
      await scene.facade.returnLoan(loanA2.loanId);

      // A fresh active loan is opened on the same book — no pending
      // reservations remain.
      const activeLoan = await scene.facade.borrow(dave.memberId, copyB.copyId);

      const result = await scene.facade.listActiveLoansWithQueuedReservations();

      expect(result).toEqual([{ loan: activeLoan, queuedCount: 0 }]);
    });

    it('excludes returned loans even when pending reservations exist on the book (AC-1.6)', async () => {
      const isbn = '978-9999999002';
      const book = await scene.catalog.addBook(sampleNewBook({ isbn }));
      const copyA = await scene.catalog.registerCopy(
        book.bookId,
        sampleNewCopy({ bookId: book.bookId }),
      );
      const copyB = await scene.catalog.registerCopy(
        book.bookId,
        sampleNewCopy({ bookId: book.bookId }),
      );
      const alice = await scene.seedMember('Alice');
      const bob = await scene.seedMember('Bob');
      const carol = await scene.seedMember('Carol');

      // Loan that will be returned.
      const returnedLoan = await scene.facade.borrow(alice.memberId, copyA.copyId);
      // Loan that stays active.
      const activeLoan = await scene.facade.borrow(bob.memberId, copyB.copyId);
      // Reserve AFTER the returned loan is already borrowed, so the return
      // leaves it pending (return fulfils the oldest pending reservation,
      // which here is carol's — but there are two reservations queued before
      // return? No: we reserve once, and returning fulfils it. Instead, we
      // return first, THEN reserve, so the reservation stays pending).
      await scene.facade.returnLoan(returnedLoan.loanId);
      await scene.facade.reserve(carol.memberId, book.bookId);

      const result = await scene.facade.listActiveLoansWithQueuedReservations();

      expect(result).toEqual([{ loan: activeLoan, queuedCount: 1 }]);
    });

    it('reports the per-book count for each active loan across different books (AC-1.7)', async () => {
      const copyOne = await scene.seedAvailableCopy();
      const copyTwo = await scene.seedAvailableCopy();
      const alice = await scene.seedMember('Alice');
      const bob = await scene.seedMember('Bob');
      const carol = await scene.seedMember('Carol');
      const dave = await scene.seedMember('Dave');

      const loanOne = await scene.facade.borrow(alice.memberId, copyOne.copyId);
      const loanTwo = await scene.facade.borrow(bob.memberId, copyTwo.copyId);

      // Two pending reservations on book one, zero on book two.
      await scene.facade.reserve(carol.memberId, copyOne.bookId);
      await scene.facade.reserve(dave.memberId, copyOne.bookId);

      const result = await scene.facade.listActiveLoansWithQueuedReservations();

      const byLoanId = new Map(result.map((row) => [row.loan.loanId, row]));
      expect(byLoanId.get(loanOne.loanId)).toEqual({ loan: loanOne, queuedCount: 2 });
      expect(byLoanId.get(loanTwo.loanId)).toEqual({ loan: loanTwo, queuedCount: 0 });
      expect(result).toHaveLength(2);
    });

    it('returns both active loans on the same book with the same per-book count (AC-1.8)', async () => {
      const isbn = '978-9999999003';
      const book = await scene.catalog.addBook(sampleNewBook({ isbn }));
      const copyA = await scene.catalog.registerCopy(
        book.bookId,
        sampleNewCopy({ bookId: book.bookId }),
      );
      const copyB = await scene.catalog.registerCopy(
        book.bookId,
        sampleNewCopy({ bookId: book.bookId }),
      );
      const alice = await scene.seedMember('Alice');
      const bob = await scene.seedMember('Bob');
      const carol = await scene.seedMember('Carol');

      const loanA = await scene.facade.borrow(alice.memberId, copyA.copyId);
      const loanB = await scene.facade.borrow(bob.memberId, copyB.copyId);
      await scene.facade.reserve(carol.memberId, book.bookId);

      const result = await scene.facade.listActiveLoansWithQueuedReservations();

      const byLoanId = new Map(result.map((row) => [row.loan.loanId, row]));
      expect(result).toHaveLength(2);
      expect(byLoanId.get(loanA.loanId)).toEqual({ loan: loanA, queuedCount: 1 });
      expect(byLoanId.get(loanB.loanId)).toEqual({ loan: loanB, queuedCount: 1 });
    });
  });

  describe('listOverdueLoansWithTitles', () => {
    // These tests use buildSceneWith() so we can swap in a spec-local
    // RecordingCatalogFacade that wraps the real CatalogFacade and records
    // every call to getBooks. Same pattern as ThrowingOnceReservationRepository
    // (this file) and ThrowingOnceIsbnLookupGateway (catalog.facade.spec.ts).

    it('returns [] and never calls catalog.getBooks when no loans are overdue (AC-2.1)', async () => {
      // given a scene with a recording wrapper around the real catalog facade,
      // and a couple of books seeded so the short-circuit has something to skip
      const innerCatalog = createCatalogFacade({ newId: sequentialIds('cat') });
      const recording = new RecordingCatalogFacade(innerCatalog);
      const membership = createMembershipFacade({ newId: sequentialIds('mem') });
      const bus = new InMemoryEventBus();
      const facade = createLendingFacade({
        catalogFacade: recording,
        membershipFacade: membership,
        eventBus: bus,
        newId: sequentialIds('loan'),
        clock: fixedClock,
      });
      await innerCatalog.addBook(sampleNewBook({ isbn: '978-0000000001' }));

      // when listOverdueLoansWithTitles is called with no overdue loans
      const reports = await facade.listOverdueLoansWithTitles(FIXED_NOW);

      // then the result is [] and getBooks was never invoked
      expect(reports).toEqual([]);
      expect(recording.getBooksCalls).toEqual([]);
    });

    it('returns a single OverdueLoanReport with its book title and authors (AC-2.2)', async () => {
      // given one book with known title+authors and a single overdue loan on it
      const book = await scene.catalog.addBook(
        sampleNewBook({
          title: 'Refactoring',
          authors: ['Martin Fowler'],
          isbn: '978-0201485677',
        }),
      );
      const copy = await scene.catalog.registerCopy(
        book.bookId,
        sampleNewCopy({ bookId: book.bookId }),
      );
      const alice = await scene.seedMember('Alice');
      const loan = await scene.facade.borrow(alice.memberId, copy.copyId);

      // when the clock is advanced past the due date
      const wayLater = new Date(loan.dueDate.getTime() + 24 * 60 * 60 * 1000);
      const reports = await scene.facade.listOverdueLoansWithTitles(wayLater);

      // then a single enriched report is returned
      expect(reports).toEqual([
        { loan, title: 'Refactoring', authors: ['Martin Fowler'] },
      ]);
    });

    it('returns three reports across three distinct books, each with its own title+authors (AC-2.3)', async () => {
      // given three books each with its own title+authors, and three overdue loans
      const bookA = await scene.catalog.addBook(
        sampleNewBook({ title: 'A-Title', authors: ['A-Author'], isbn: '978-1111111111' }),
      );
      const bookB = await scene.catalog.addBook(
        sampleNewBook({ title: 'B-Title', authors: ['B-Author'], isbn: '978-2222222222' }),
      );
      const bookC = await scene.catalog.addBook(
        sampleNewBook({ title: 'C-Title', authors: ['C-Author'], isbn: '978-3333333333' }),
      );
      const copyA = await scene.catalog.registerCopy(
        bookA.bookId,
        sampleNewCopy({ bookId: bookA.bookId }),
      );
      const copyB = await scene.catalog.registerCopy(
        bookB.bookId,
        sampleNewCopy({ bookId: bookB.bookId }),
      );
      const copyC = await scene.catalog.registerCopy(
        bookC.bookId,
        sampleNewCopy({ bookId: bookC.bookId }),
      );
      const alice = await scene.seedMember('Alice');
      const bob = await scene.seedMember('Bob');
      const carol = await scene.seedMember('Carol');
      const loanA = await scene.facade.borrow(alice.memberId, copyA.copyId);
      const loanB = await scene.facade.borrow(bob.memberId, copyB.copyId);
      const loanC = await scene.facade.borrow(carol.memberId, copyC.copyId);

      const wayLater = new Date(loanA.dueDate.getTime() + 24 * 60 * 60 * 1000);
      const reports = await scene.facade.listOverdueLoansWithTitles(wayLater);

      // then three entries come back — one per loan, each with its own book's
      // title+authors. Order is not asserted (spec calls it out as "same order
      // as listOverdueLoans returns them" but the test stays robust to impl).
      expect(reports).toHaveLength(3);
      const byLoanId = new Map(reports.map((row) => [row.loan.loanId, row]));
      expect(byLoanId.get(loanA.loanId)).toEqual({
        loan: loanA,
        title: 'A-Title',
        authors: ['A-Author'],
      });
      expect(byLoanId.get(loanB.loanId)).toEqual({
        loan: loanB,
        title: 'B-Title',
        authors: ['B-Author'],
      });
      expect(byLoanId.get(loanC.loanId)).toEqual({
        loan: loanC,
        title: 'C-Title',
        authors: ['C-Author'],
      });
    });

    it('dedups bookIds when multiple overdue loans share the same book (AC-2.4)', async () => {
      // given a scene wired with a recording catalog wrapper, two books, and
      // three overdue loans across those two books (book A has two loans,
      // book B has one)
      const innerCatalog = createCatalogFacade({ newId: sequentialIds('cat') });
      const recording = new RecordingCatalogFacade(innerCatalog);
      const membership = createMembershipFacade({ newId: sequentialIds('mem') });
      const bus = new InMemoryEventBus();
      const facade = createLendingFacade({
        catalogFacade: recording,
        membershipFacade: membership,
        eventBus: bus,
        newId: sequentialIds('loan'),
        clock: fixedClock,
      });

      const bookA = await innerCatalog.addBook(
        sampleNewBook({ title: 'Shared Book', authors: ['Shared Author'], isbn: '978-4444444444' }),
      );
      const bookB = await innerCatalog.addBook(
        sampleNewBook({ title: 'Solo Book', authors: ['Solo Author'], isbn: '978-5555555555' }),
      );
      const copyA1 = await innerCatalog.registerCopy(
        bookA.bookId,
        sampleNewCopy({ bookId: bookA.bookId }),
      );
      const copyA2 = await innerCatalog.registerCopy(
        bookA.bookId,
        sampleNewCopy({ bookId: bookA.bookId }),
      );
      const copyB = await innerCatalog.registerCopy(
        bookB.bookId,
        sampleNewCopy({ bookId: bookB.bookId }),
      );
      const alice = await membership.registerMember(
        sampleNewMember({ name: 'Alice', email: 'alice@example.com' }),
      );
      const bob = await membership.registerMember(
        sampleNewMember({ name: 'Bob', email: 'bob@example.com' }),
      );
      const carol = await membership.registerMember(
        sampleNewMember({ name: 'Carol', email: 'carol@example.com' }),
      );
      const loanA1 = await facade.borrow(alice.memberId, copyA1.copyId);
      const loanA2 = await facade.borrow(bob.memberId, copyA2.copyId);
      const loanB = await facade.borrow(carol.memberId, copyB.copyId);

      const wayLater = new Date(loanA1.dueDate.getTime() + 24 * 60 * 60 * 1000);
      const reports = await facade.listOverdueLoansWithTitles(wayLater);

      // then the three loans each get their enriched report — two with bookA,
      // one with bookB
      expect(reports).toHaveLength(3);
      const byLoanId = new Map(reports.map((row) => [row.loan.loanId, row]));
      expect(byLoanId.get(loanA1.loanId)).toEqual({
        loan: loanA1,
        title: 'Shared Book',
        authors: ['Shared Author'],
      });
      expect(byLoanId.get(loanA2.loanId)).toEqual({
        loan: loanA2,
        title: 'Shared Book',
        authors: ['Shared Author'],
      });
      expect(byLoanId.get(loanB.loanId)).toEqual({
        loan: loanB,
        title: 'Solo Book',
        authors: ['Solo Author'],
      });

      // and getBooks was called once with a de-duplicated pair of bookIds
      expect(recording.getBooksCalls).toHaveLength(1);
      const passed = recording.getBooksCalls[0] as BookId[];
      expect(passed).toHaveLength(2);
      expect(new Set(passed)).toEqual(new Set([bookA.bookId, bookB.bookId]));
    });

    it('throws BookNotFoundError carrying the offending bookId when the catalog drops a book (AC-2.5)', async () => {
      // given a scene wired with a wrapper that simulates catalog drift —
      // getBooks always returns [] regardless of input, so every overdue loan
      // looks like it references a vanished book
      const innerCatalog = createCatalogFacade({ newId: sequentialIds('cat') });
      const dropping = new DroppingBookIdsCatalogFacade(innerCatalog);
      const membership = createMembershipFacade({ newId: sequentialIds('mem') });
      const bus = new InMemoryEventBus();
      const facade = createLendingFacade({
        catalogFacade: dropping,
        membershipFacade: membership,
        eventBus: bus,
        newId: sequentialIds('loan'),
        clock: fixedClock,
      });

      const book = await innerCatalog.addBook(sampleNewBook({ isbn: '978-6666666666' }));
      const copy = await innerCatalog.registerCopy(
        book.bookId,
        sampleNewCopy({ bookId: book.bookId }),
      );
      const alice = await membership.registerMember(
        sampleNewMember({ name: 'Alice', email: 'alice-drift@example.com' }),
      );
      const loan = await facade.borrow(alice.memberId, copy.copyId);

      // when the clock is advanced past the due date and the composition runs
      const wayLater = new Date(loan.dueDate.getTime() + 24 * 60 * 60 * 1000);

      // then a BookNotFoundError is raised naming the offending bookId
      await expect(facade.listOverdueLoansWithTitles(wayLater)).rejects.toThrow(BookNotFoundError);
      await expect(facade.listOverdueLoansWithTitles(wayLater)).rejects.toThrow(book.bookId);
    });
  });

  describe('atomicity', () => {
    // principle 5 extension: atomicity across functions
    // The transactional context stages the loan save + the fulfillment-reservation
    // save + the events, and only commits when the whole block resolves. If the
    // fulfillment write throws, the loan save and events must also be discarded.
    // Cross-module catalog calls live OUTSIDE the tx (principle 7 — cross-module
    // consistency is via happens-before, not a shared transaction).
    it('rolls back the loan save and emits no events when the reservation write fails mid-transaction', async () => {
      const reservations = new ThrowingOnceReservationRepository();
      const altScene = buildSceneWith({ reservationRepository: reservations });
      const copy = await altScene.seedAvailableCopy();
      const alice = await altScene.seedMember('Alice');
      const bob = await altScene.seedMember('Bob');
      const loan = await altScene.facade.borrow(alice.memberId, copy.copyId);
      await altScene.facade.reserve(bob.memberId, copy.bookId);
      altScene.bus.clear();

      reservations.armFailureOnNextSave(new Error('reservation store is down'));

      await expect(altScene.facade.returnLoan(loan.loanId)).rejects.toThrow(
        'reservation store is down',
      );

      const stored = (await altScene.facade.listLoansFor(alice.memberId))[0];
      expect(stored?.returnedAt).toBeUndefined();
      expect(altScene.bus.collected()).toEqual([]);
    });

    it('rolls back both LoanReturned and ReservationFulfilled when the tx aborts', async () => {
      const reservations = new ThrowingOnceReservationRepository();
      const altScene = buildSceneWith({ reservationRepository: reservations });
      const copy = await altScene.seedAvailableCopy();
      const alice = await altScene.seedMember('Alice');
      const bob = await altScene.seedMember('Bob');
      const loan = await altScene.facade.borrow(alice.memberId, copy.copyId);
      await altScene.facade.reserve(bob.memberId, copy.bookId);
      altScene.bus.clear();

      reservations.armFailureOnNextSave(new Error('reservation store is down'));

      await expect(altScene.facade.returnLoan(loan.loanId)).rejects.toThrow(
        'reservation store is down',
      );

      expect(altScene.bus.collected()).toEqual([]);
      expect((await altScene.facade.listLoansFor(alice.memberId))[0]?.returnedAt).toBeUndefined();
    });
  });
});

// Spec-local wrapper that decorates a real CatalogFacade and records every
// call to getBooks. Lets the overdue-with-titles tests observe the dedup
// behaviour (AC-2.4) and the short-circuit (AC-2.1) without resorting to
// vi.fn / vi.spyOn. Mirrors the ThrowingOnce* wrappers used elsewhere in
// this codebase (lending.facade.spec.ts ThrowingOnceReservationRepository,
// catalog.facade.spec.ts ThrowingOnceIsbnLookupGateway).
class RecordingCatalogFacade extends CatalogFacade {
  readonly getBooksCalls: BookId[][] = [];

  constructor(private readonly delegate: CatalogFacade) {
    // Placeholder super-state — every method is overridden to delegate, so
    // the repo/newId/gateway on this instance are never exercised.
    super(new InMemoryCatalogRepository());
  }

  override getBooks(bookIds: BookId[]): Promise<BookDto[]> {
    this.getBooksCalls.push([...bookIds]);
    return this.delegate.getBooks(bookIds);
  }

  override addBook(dto: NewBookDto): Promise<BookDto> {
    return this.delegate.addBook(dto);
  }

  override findBook(isbn: Isbn): Promise<BookDto> {
    return this.delegate.findBook(isbn);
  }

  override listBooks(): Promise<BookDto[]> {
    return this.delegate.listBooks();
  }

  override registerCopy(bookId: BookId, dto: NewCopyDto): Promise<CopyDto> {
    return this.delegate.registerCopy(bookId, dto);
  }

  override findCopy(copyId: CopyId): Promise<CopyDto> {
    return this.delegate.findCopy(copyId);
  }

  override markCopyAvailable(copyId: CopyId): Promise<CopyDto> {
    return this.delegate.markCopyAvailable(copyId);
  }

  override markCopyUnavailable(copyId: CopyId): Promise<CopyDto> {
    return this.delegate.markCopyUnavailable(copyId);
  }
}

// Spec-local wrapper that simulates catalog drift (AC-2.5): every getBooks
// call returns [] regardless of input, while every other method delegates to
// the real inner facade so borrow/etc. still work during test setup.
class DroppingBookIdsCatalogFacade extends CatalogFacade {
  constructor(private readonly delegate: CatalogFacade) {
    super(new InMemoryCatalogRepository());
  }

  override getBooks(_bookIds: BookId[]): Promise<BookDto[]> {
    return Promise.resolve([]);
  }

  override addBook(dto: NewBookDto): Promise<BookDto> {
    return this.delegate.addBook(dto);
  }

  override findBook(isbn: Isbn): Promise<BookDto> {
    return this.delegate.findBook(isbn);
  }

  override listBooks(): Promise<BookDto[]> {
    return this.delegate.listBooks();
  }

  override registerCopy(bookId: BookId, dto: NewCopyDto): Promise<CopyDto> {
    return this.delegate.registerCopy(bookId, dto);
  }

  override findCopy(copyId: CopyId): Promise<CopyDto> {
    return this.delegate.findCopy(copyId);
  }

  override markCopyAvailable(copyId: CopyId): Promise<CopyDto> {
    return this.delegate.markCopyAvailable(copyId);
  }

  override markCopyUnavailable(copyId: CopyId): Promise<CopyDto> {
    return this.delegate.markCopyUnavailable(copyId);
  }
}

// Real InMemoryReservationRepository that throws on the next saveReservation
// after being armed. This one we DO hand-roll, because it is Lending's OWN
// repository (principle 5: in-memory doubles for your module's data, with
// precise failure injection when needed).
class ThrowingOnceReservationRepository implements ReservationRepository {
  private readonly delegate = new InMemoryReservationRepository();
  private nextError: Error | null = null;

  armFailureOnNextSave(error: Error): void {
    this.nextError = error;
  }

  saveReservation(reservation: ReservationDto, ctx: TransactionalContext): void {
    if (this.nextError) {
      const error = this.nextError;
      this.nextError = null;
      throw error;
    }
    this.delegate.saveReservation(reservation, ctx);
  }

  findReservationById(reservationId: string): Promise<ReservationDto | undefined> {
    return this.delegate.findReservationById(reservationId);
  }

  listPendingReservationsForBook(bookId: BookId): Promise<ReservationDto[]> {
    return this.delegate.listPendingReservationsForBook(bookId);
  }

  listReservations(): Promise<ReservationDto[]> {
    return this.delegate.listReservations();
  }
}
