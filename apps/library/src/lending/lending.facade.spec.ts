import { beforeEach, describe, expect, it } from 'vitest';

import {
  CopyStatus,
  type BookId,
  type CatalogFacade,
  type CopyDto,
  type CopyId,
} from '../catalog/index.js';
import type {
  EligibilityDto,
  MemberId,
  MembershipFacade,
} from '../membership/index.js';
import { InMemoryEventBus } from '../shared/events/in-memory-event-bus.js';
import { InMemoryReservationRepository } from './in-memory-reservation.repository.js';
import { createLendingFacade, type LendingOverrides } from './lending.configuration.js';
import type { ReservationDto } from './lending.types.js';
import type { ReservationRepository } from './reservation.repository.js';
import type { TransactionalContext } from './transactional-context.js';
import {
  CopyUnavailableError,
  LoanNotFoundError,
  MemberIneligibleError,
} from './lending.types.js';
import { sampleBorrowRequest, sampleReserveRequest } from './sample-lending-data.js';

// Deterministic ids so loan/reservation ids are predictable in assertions.
function sequentialIds(prefix: string): () => string {
  let counter = 0;
  return () => `${prefix}-${++counter}`;
}

// Frozen clock — borrow uses it for `borrowedAt`/`dueDate`, return uses it for
// `returnedAt`. Deterministic times make event payload assertions trivial.
const FIXED_NOW = new Date('2030-01-15T00:00:00Z');
const fixedClock = (): Date => new Date(FIXED_NOW.getTime());

// --- Minimal hand-written fakes for OTHER modules' facades (principle 7). -----
// Only the methods Lending actually calls are implemented. No vi.fn — plain
// objects so the tests read like production wiring.

interface FakeCatalog {
  seedCopy(copy: CopyDto): void;
  markCopyAvailableThrowsWith(error: Error): void;
  findCopy(copyId: CopyId): CopyDto;
  markCopyAvailable(copyId: CopyId): CopyDto;
  markCopyUnavailable(copyId: CopyId): CopyDto;
}

function fakeCatalogFacade(): FakeCatalog {
  const copies = new Map<CopyId, CopyDto>();
  let availableError: Error | null = null;

  const requireCopy = (copyId: CopyId): CopyDto => {
    const copy = copies.get(copyId);
    if (!copy) {
      throw new Error(`fake catalog has no copy: ${copyId}`);
    }
    return copy;
  };

  return {
    seedCopy(copy) {
      copies.set(copy.copyId, { ...copy });
    },
    markCopyAvailableThrowsWith(error) {
      availableError = error;
    },
    findCopy(copyId) {
      return requireCopy(copyId);
    },
    markCopyAvailable(copyId) {
      if (availableError) {
        throw availableError;
      }
      const updated: CopyDto = { ...requireCopy(copyId), status: CopyStatus.AVAILABLE };
      copies.set(copyId, updated);
      return updated;
    },
    markCopyUnavailable(copyId) {
      const updated: CopyDto = { ...requireCopy(copyId), status: CopyStatus.UNAVAILABLE };
      copies.set(copyId, updated);
      return updated;
    },
  };
}

interface FakeMembership {
  setEligibility(memberId: MemberId, eligibility: EligibilityDto): void;
  checkEligibility(memberId: MemberId): EligibilityDto;
}

function fakeMembershipFacade(): FakeMembership {
  const eligibilityByMember = new Map<MemberId, EligibilityDto>();
  return {
    setEligibility(memberId, eligibility) {
      eligibilityByMember.set(memberId, eligibility);
    },
    checkEligibility(memberId) {
      return eligibilityByMember.get(memberId) ?? { memberId, eligible: true };
    },
  };
}

// --- Scene builder ------------------------------------------------------------

interface Scene {
  facade: ReturnType<typeof createLendingFacade>;
  catalog: FakeCatalog;
  membership: FakeMembership;
  bus: InMemoryEventBus;
  seedAvailableCopy(overrides?: Partial<CopyDto>): CopyDto;
}

function buildScene(): Scene {
  return buildSceneWith({});
}

function buildSceneWith(extra: Partial<LendingOverrides>): Scene {
  const catalog = fakeCatalogFacade();
  const membership = fakeMembershipFacade();
  const bus = new InMemoryEventBus();
  const facade = createLendingFacade({
    catalogFacade: catalog as unknown as CatalogFacade,
    membershipFacade: membership as unknown as MembershipFacade,
    eventBus: bus,
    newId: sequentialIds('loan'),
    clock: fixedClock,
    ...extra,
  });

  let copySeq = 0;
  return {
    facade,
    catalog,
    membership,
    bus,
    seedAvailableCopy(overrides = {}) {
      copySeq += 1;
      const copy: CopyDto = {
        copyId: `copy-${copySeq}`,
        bookId: `book-${copySeq}`,
        condition: 'GOOD',
        status: CopyStatus.AVAILABLE,
        ...overrides,
      };
      catalog.seedCopy(copy);
      return copy;
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
      // given an available copy in the catalog
      const copy = scene.seedAvailableCopy();
      const { memberId, copyId } = sampleBorrowRequest({
        memberId: 'alice',
        copyId: copy.copyId,
      });

      // when the member borrows the copy
      const loan = await scene.facade.borrow(memberId, copyId);

      // then the loan is persisted with the right owner and copy
      expect(loan.memberId).toBe('alice');
      expect(loan.copyId).toBe(copy.copyId);
      expect(loan.bookId).toBe(copy.bookId);
      expect(loan.returnedAt).toBeUndefined();
      expect(await scene.facade.listLoansFor('alice')).toEqual([loan]);

      // and a LoanOpened event was emitted on the bus
      expect(eventTypes(scene.bus)).toEqual(['LoanOpened']);
    });

    it('marks the copy unavailable in the catalog when a loan opens', async () => {
      // given an available copy
      const copy = scene.seedAvailableCopy();

      // when a member borrows it
      await scene.facade.borrow('alice', copy.copyId);

      // then the catalog reflects the copy as unavailable
      expect(scene.catalog.findCopy(copy.copyId).status).toBe(CopyStatus.UNAVAILABLE);
    });

    it('rejects with MemberIneligibleError when membership reports ineligible, touching nothing', async () => {
      // given a suspended member and an available copy
      const copy = scene.seedAvailableCopy();
      scene.membership.setEligibility('alice', {
        memberId: 'alice',
        eligible: false,
        reason: 'SUSPENDED',
      });

      // when the member tries to borrow
      await expect(scene.facade.borrow('alice', copy.copyId)).rejects.toBeInstanceOf(
        MemberIneligibleError,
      );

      // then no loan was recorded, no event emitted, and the copy is still available
      expect(await scene.facade.listLoansFor('alice')).toEqual([]);
      expect(scene.bus.collected()).toEqual([]);
      expect(scene.catalog.findCopy(copy.copyId).status).toBe(CopyStatus.AVAILABLE);
    });

    it('rejects with CopyUnavailableError when the catalog reports the copy unavailable', async () => {
      // given a copy that is already checked out
      const copy = scene.seedAvailableCopy({ status: CopyStatus.UNAVAILABLE });

      // when a member tries to borrow it
      await expect(scene.facade.borrow('alice', copy.copyId)).rejects.toBeInstanceOf(
        CopyUnavailableError,
      );

      // then no loan was recorded and no event emitted
      expect(await scene.facade.listLoansFor('alice')).toEqual([]);
      expect(scene.bus.collected()).toEqual([]);
    });
  });

  describe('returnLoan', () => {
    it('closes the loan with returnedAt and emits a LoanReturned event', async () => {
      // given a member with an open loan
      const copy = scene.seedAvailableCopy();
      const loan = await scene.facade.borrow('alice', copy.copyId);
      scene.bus.clear();

      // when the loan is returned
      const returned = await scene.facade.returnLoan(loan.loanId);

      // then the returned loan has a returnedAt matching the fixed clock
      expect(returned.returnedAt).toEqual(FIXED_NOW);
      expect((await scene.facade.listLoansFor('alice'))[0]?.returnedAt).toEqual(FIXED_NOW);

      // and a LoanReturned event was emitted
      expect(eventTypes(scene.bus)).toEqual(['LoanReturned']);
    });

    it('marks the copy available in the catalog on return', async () => {
      // given a borrowed copy
      const copy = scene.seedAvailableCopy();
      const loan = await scene.facade.borrow('alice', copy.copyId);

      // when the loan is returned
      await scene.facade.returnLoan(loan.loanId);

      // then the catalog reflects the copy as available again
      expect(scene.catalog.findCopy(copy.copyId).status).toBe(CopyStatus.AVAILABLE);
    });

    it('fulfills a pending reservation and emits both LoanReturned and ReservationFulfilled', async () => {
      // given alice has borrowed the book and bob has reserved it
      const copy = scene.seedAvailableCopy();
      const loan = await scene.facade.borrow('alice', copy.copyId);
      await scene.facade.reserve('bob', copy.bookId);
      scene.bus.clear();

      // when alice returns the book
      await scene.facade.returnLoan(loan.loanId);

      // then both events are emitted in the same transaction
      expect(eventTypes(scene.bus).sort()).toEqual(['LoanReturned', 'ReservationFulfilled']);
    });

    it('throws LoanNotFoundError when returning an unknown loan, with no events', async () => {
      // given an empty lending module

      // when returning an id that was never recorded
      await expect(scene.facade.returnLoan('never-issued')).rejects.toBeInstanceOf(
        LoanNotFoundError,
      );

      // then nothing was emitted
      expect(scene.bus.collected()).toEqual([]);
    });
  });

  describe('reserve', () => {
    it('persists a reservation and emits a ReservationQueued event', async () => {
      // given a book in the catalog
      const copy = scene.seedAvailableCopy();
      const { memberId, bookId } = sampleReserveRequest({
        memberId: 'alice',
        bookId: copy.bookId as BookId,
      });

      // when the member reserves the book
      const reservation = await scene.facade.reserve(memberId, bookId);

      // then a reservation was returned with the right owner and book
      expect(reservation.memberId).toBe('alice');
      expect(reservation.bookId).toBe(bookId);
      expect(reservation.fulfilledAt).toBeUndefined();

      // and a ReservationQueued event was emitted
      expect(eventTypes(scene.bus)).toEqual(['ReservationQueued']);
    });

    it('rejects with MemberIneligibleError when membership reports ineligible, touching nothing', async () => {
      // given a suspended member
      scene.membership.setEligibility('alice', {
        memberId: 'alice',
        eligible: false,
        reason: 'SUSPENDED',
      });

      // when the member tries to reserve
      await expect(scene.facade.reserve('alice', 'book-1')).rejects.toBeInstanceOf(
        MemberIneligibleError,
      );

      // then nothing was emitted
      expect(scene.bus.collected()).toEqual([]);
    });
  });

  describe('listOverdueLoans', () => {
    it('returns loans whose dueDate is before now and which have not been returned', async () => {
      // given two borrows, both with dueDates 14 days after FIXED_NOW
      const copyOne = scene.seedAvailableCopy();
      const copyTwo = scene.seedAvailableCopy();
      const first = await scene.facade.borrow('alice', copyOne.copyId);
      const second = await scene.facade.borrow('bob', copyTwo.copyId);

      // when checking overdue loans at a moment past the due date
      const wayLater = new Date(first.dueDate.getTime() + 24 * 60 * 60 * 1000);
      const overdue = await scene.facade.listOverdueLoans(wayLater);

      // then both overdue loans are returned
      const overdueIds = overdue.map((loan) => loan.loanId).sort();
      expect(overdueIds).toEqual([first.loanId, second.loanId].sort());
    });

    it('excludes returned loans and loans still within their due date', async () => {
      // given one loan that has been returned and one fresh loan
      const copyOne = scene.seedAvailableCopy();
      const copyTwo = scene.seedAvailableCopy();
      const returned = await scene.facade.borrow('alice', copyOne.copyId);
      await scene.facade.borrow('bob', copyTwo.copyId);
      await scene.facade.returnLoan(returned.loanId);

      // when checking overdue at a moment before any due date
      const beforeDue = new Date(FIXED_NOW.getTime() + 60 * 60 * 1000);
      const overdue = await scene.facade.listOverdueLoans(beforeDue);

      // then no loans are reported overdue
      expect(overdue).toEqual([]);
    });
  });

  describe('listLoansFor', () => {
    it('returns every loan belonging to the given member', async () => {
      // given alice has two loans and bob has one
      const copyOne = scene.seedAvailableCopy();
      const copyTwo = scene.seedAvailableCopy();
      const copyThree = scene.seedAvailableCopy();
      const first = await scene.facade.borrow('alice', copyOne.copyId);
      const second = await scene.facade.borrow('alice', copyTwo.copyId);
      await scene.facade.borrow('bob', copyThree.copyId);

      // when listing alice's loans
      const alicesLoans = await scene.facade.listLoansFor('alice');

      // then exactly alice's two loans come back
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
      // given alice borrowed the book and bob has a pending reservation for it
      // (the pending reservation is what triggers the fulfillment save inside returnLoan)
      const reservations = new ThrowingOnceReservationRepository();
      const altScene = buildSceneWith({ reservationRepository: reservations });
      const copy = altScene.seedAvailableCopy();
      const loan = await altScene.facade.borrow('alice', copy.copyId);
      await altScene.facade.reserve('bob', copy.bookId);
      altScene.bus.clear();

      // and the next reservation write (the fulfillment inside returnLoan) will throw
      reservations.armFailureOnNextSave(new Error('reservation store is down'));

      // when the loan is returned
      await expect(altScene.facade.returnLoan(loan.loanId)).rejects.toThrow('reservation store is down');

      // then the loan still shows as not returned
      const stored = (await altScene.facade.listLoansFor('alice'))[0];
      expect(stored?.returnedAt).toBeUndefined();

      // and no LoanReturned or ReservationFulfilled event was published
      expect(altScene.bus.collected()).toEqual([]);
    });

    it('rolls back both LoanReturned and ReservationFulfilled when the tx aborts', async () => {
      const reservations = new ThrowingOnceReservationRepository();
      const altScene = buildSceneWith({ reservationRepository: reservations });
      const copy = altScene.seedAvailableCopy();
      const loan = await altScene.facade.borrow('alice', copy.copyId);
      await altScene.facade.reserve('bob', copy.bookId);
      altScene.bus.clear();

      reservations.armFailureOnNextSave(new Error('reservation store is down'));

      await expect(altScene.facade.returnLoan(loan.loanId)).rejects.toThrow('reservation store is down');

      expect(altScene.bus.collected()).toEqual([]);
      expect((await altScene.facade.listLoansFor('alice'))[0]?.returnedAt).toBeUndefined();
    });
  });
});

// Real InMemoryReservationRepository that throws on the next saveReservation
// after being armed. Used to force a mid-transaction failure so we can observe
// whether staged writes and events get rolled back.
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
      // Throw synchronously inside the tx's work() callback so staged writes
      // never commit. Simulates what Postgres would do when an INSERT fails
      // mid-transaction — the surrounding db.transaction aborts.
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
