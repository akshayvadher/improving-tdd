import { beforeEach, describe, expect, it } from 'vitest';

import { createCatalogFacade } from '../catalog/catalog.configuration.js';
import { CopyStatus, type BookId } from '../catalog/index.js';
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
