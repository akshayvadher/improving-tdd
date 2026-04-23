import { beforeEach, describe, expect, it } from 'vitest';
import { createCatalogFacade } from '../catalog/catalog.configuration.js';
import type { BookId } from '../catalog/index.js';
import { CopyStatus } from '../catalog/index.js';
import { sampleNewBook, sampleNewCopy } from '../catalog/sample-catalog-data.js';
import { createMembershipFacade } from '../membership/membership.configuration.js';
import { sampleNewMember } from '../membership/sample-membership-data.js';
import { InMemoryEventBus } from '../shared/events/in-memory-event-bus.js';
import {
  type AutoLoanOnReturnConsumer,
  createAutoLoanOnReturnConsumer,
} from './auto-loan-on-return.consumer.js';
import { InMemoryLoanRepository } from './in-memory-loan.repository.js';
import { InMemoryReservationRepository } from './in-memory-reservation.repository.js';
import { InMemoryTransactionalContext } from './in-memory-transactional-context.js';
import { createLendingFacade } from './lending.configuration.js';
import type { LendingFacade } from './lending.facade.js';
import type { AutoLoanFailed, AutoLoanOpened, LoanDto, ReservationDto } from './lending.types.js';
import type { LoanRepository } from './loan.repository.js';
import type { TransactionalContext } from './transactional-context.js';

function sequentialIds(prefix: string): () => string {
  let counter = 0;
  return () => `${prefix}-${++counter}`;
}

const FIXED_NOW = new Date('2030-01-15T00:00:00Z');
const fixedClock = (): Date => new Date(FIXED_NOW.getTime());

// --- Scene builder ----------------------------------------------------------
// Real factory-wired facades for every collaborator (principle 7). The
// InMemoryReservationRepository is the shared instance that both the
// LendingFacade (via its reservationRepository override) and the consumer
// (via its `reservations` dep) hold — so the consumer and the facade see the
// same reservation rows.

interface ConsumerScene {
  bus: InMemoryEventBus;
  catalog: ReturnType<typeof createCatalogFacade>;
  membership: ReturnType<typeof createMembershipFacade>;
  reservations: InMemoryReservationRepository;
  lending: LendingFacade;
  consumer: AutoLoanOnReturnConsumer;
  seedAvailableCopy(): Promise<{ copyId: string; bookId: string }>;
  seedMember(name?: string): Promise<{ memberId: string }>;
}

interface SceneOverrides {
  loanRepository?: LoanRepository;
}

function buildConsumerScene(overrides: SceneOverrides = {}): ConsumerScene {
  const bus = new InMemoryEventBus();
  const catalog = createCatalogFacade({ newId: sequentialIds('cat') });
  const membership = createMembershipFacade({ newId: sequentialIds('mem') });
  const reservations = new InMemoryReservationRepository();
  const txFactory = () => new InMemoryTransactionalContext(bus);
  const lending = createLendingFacade({
    catalogFacade: catalog,
    membershipFacade: membership,
    reservationRepository: reservations,
    eventBus: bus,
    txFactory,
    newId: sequentialIds('loan'),
    clock: fixedClock,
    ...(overrides.loanRepository ? { loanRepository: overrides.loanRepository } : {}),
  });
  const consumer = createAutoLoanOnReturnConsumer({
    bus,
    membership,
    reservations,
    lending,
    txFactory,
    clock: fixedClock,
  });
  consumer.start();

  let copySeq = 0;
  let memberSeq = 0;

  return {
    bus,
    catalog,
    membership,
    reservations,
    lending,
    consumer,
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

describe('AutoLoanOnReturnConsumer', () => {
  let scene: ConsumerScene;

  beforeEach(() => {
    scene = buildConsumerScene();
  });

  describe('happy path (AC-1.12)', () => {
    it('opens a new loan for the head-of-queue reserver on the same returned copy', async () => {
      // given a copy of book B currently loaned to Alice and a pending
      // reservation for book B by Bob
      const copy = await scene.seedAvailableCopy();
      const alice = await scene.seedMember('Alice');
      const bob = await scene.seedMember('Bob');
      const aliceLoan = await scene.lending.borrow(alice.memberId, copy.copyId);
      await scene.lending.reserve(bob.memberId, copy.bookId);
      scene.bus.clear();

      // when alice returns the loan
      await scene.lending.returnLoan(aliceLoan.loanId);

      // then a new loan was opened for bob on the same copy
      const bobLoans = await scene.lending.listLoansFor(bob.memberId);
      expect(bobLoans).toHaveLength(1);
      expect(bobLoans[0]?.copyId).toBe(copy.copyId);
      expect(bobLoans[0]?.bookId).toBe(copy.bookId);
      expect(bobLoans[0]?.returnedAt).toBeUndefined();

      // and the bus shows LoanReturned -> LoanOpened (from borrow) ->
      // AutoLoanOpened (from the consumer, after borrow resolves).
      expect(eventTypes(scene.bus)).toEqual(['LoanReturned', 'LoanOpened', 'AutoLoanOpened']);

      // the reservation is marked fulfilled by the claim-first write
      const [reservation] = await scene.reservations.listReservations();
      expect(reservation?.fulfilledAt).toEqual(FIXED_NOW);
    });

    it('marks the copy UNAVAILABLE in catalog after the consumer opens the new loan (AC-1.14)', async () => {
      const copy = await scene.seedAvailableCopy();
      const alice = await scene.seedMember('Alice');
      const bob = await scene.seedMember('Bob');
      const aliceLoan = await scene.lending.borrow(alice.memberId, copy.copyId);
      await scene.lending.reserve(bob.memberId, copy.bookId);

      await scene.lending.returnLoan(aliceLoan.loanId);

      // the new borrow by the consumer drives catalog.markCopyUnavailable,
      // so the copy ends UNAVAILABLE despite the return briefly freeing it
      expect((await scene.catalog.findCopy(copy.copyId)).status).toBe(CopyStatus.UNAVAILABLE);
    });
  });

  describe('empty queue (AC-1.15)', () => {
    it('is a no-op when no pending reservations exist for the returned book', async () => {
      // given alice has a loan and no reservations exist
      const copy = await scene.seedAvailableCopy();
      const alice = await scene.seedMember('Alice');
      const aliceLoan = await scene.lending.borrow(alice.memberId, copy.copyId);
      scene.bus.clear();

      // when alice returns the loan
      await scene.lending.returnLoan(aliceLoan.loanId);

      // then no new loan exists and only LoanReturned is on the bus
      const allLoans = await scene.lending.listLoansFor(alice.memberId);
      expect(allLoans).toHaveLength(1);
      expect(allLoans[0]?.returnedAt).toEqual(FIXED_NOW);
      expect(eventTypes(scene.bus)).toEqual(['LoanReturned']);
      expect((await scene.catalog.findCopy(copy.copyId)).status).toBe(CopyStatus.AVAILABLE);
    });
  });

  describe('eligibility cascade (AC-2.1 – AC-2.8)', () => {
    it('skips an ineligible head-of-queue reservation and opens the loan for the next eligible reserver (AC-2.5)', async () => {
      // given two pending reservations for book B — the first by a suspended
      // member, the second by an eligible member — and a current loan on a
      // copy of B
      const copy = await scene.seedAvailableCopy();
      const alice = await scene.seedMember('Alice');
      const suspended = await scene.seedMember('Suspended');
      const eligible = await scene.seedMember('Eligible');
      const aliceLoan = await scene.lending.borrow(alice.memberId, copy.copyId);
      await scene.lending.reserve(suspended.memberId, copy.bookId);
      await scene.lending.reserve(eligible.memberId, copy.bookId);
      await scene.membership.suspend(suspended.memberId);
      scene.bus.clear();

      // when alice returns the loan
      await scene.lending.returnLoan(aliceLoan.loanId);

      // then the eligible second-in-queue member got the loan on the same copy
      const eligibleLoans = await scene.lending.listLoansFor(eligible.memberId);
      expect(eligibleLoans).toHaveLength(1);
      expect(eligibleLoans[0]?.copyId).toBe(copy.copyId);
      expect(eligibleLoans[0]?.bookId).toBe(copy.bookId);

      // and the suspended member got no loan
      expect(await scene.lending.listLoansFor(suspended.memberId)).toEqual([]);

      // and the suspended reservation is still pending (fulfilledAt
      // undefined), while the eligible one was claim-first fulfilled by the
      // consumer before borrow ran.
      const reservations = await scene.reservations.listReservations();
      const suspendedReservation = reservations.find((r) => r.memberId === suspended.memberId);
      const eligibleReservation = reservations.find((r) => r.memberId === eligible.memberId);
      expect(suspendedReservation?.fulfilledAt).toBeUndefined();
      expect(eligibleReservation?.fulfilledAt).toEqual(FIXED_NOW);

      // and the bus shows LoanReturned (from returnLoan), LoanOpened (from
      // the consumer's borrow), AutoLoanOpened (from the consumer after
      // borrow resolved).
      expect(eventTypes(scene.bus)).toEqual(['LoanReturned', 'LoanOpened', 'AutoLoanOpened']);
    });

    it('walks past multiple ineligible reservations and stops at the first eligible one (AC-2.1, AC-2.3)', async () => {
      // given four pending reservations for book B in queue order:
      //   1. suspended  (skip)
      //   2. suspended  (skip)
      //   3. eligible   (<- gets the loan)
      //   4. eligible   (would get a loan if the consumer kept looping)
      // and a current loan on a copy of B.
      const copy = await scene.seedAvailableCopy();
      const alice = await scene.seedMember('Alice');
      const suspendedOne = await scene.seedMember('SuspendedOne');
      const suspendedTwo = await scene.seedMember('SuspendedTwo');
      const firstEligible = await scene.seedMember('FirstEligible');
      const secondEligible = await scene.seedMember('SecondEligible');
      const aliceLoan = await scene.lending.borrow(alice.memberId, copy.copyId);
      await scene.lending.reserve(suspendedOne.memberId, copy.bookId);
      await scene.lending.reserve(suspendedTwo.memberId, copy.bookId);
      await scene.lending.reserve(firstEligible.memberId, copy.bookId);
      await scene.lending.reserve(secondEligible.memberId, copy.bookId);
      await scene.membership.suspend(suspendedOne.memberId);
      await scene.membership.suspend(suspendedTwo.memberId);
      scene.bus.clear();

      // when alice returns the loan
      await scene.lending.returnLoan(aliceLoan.loanId);

      // then exactly the FIRST eligible reserver received a loan on this copy
      const firstEligibleLoans = await scene.lending.listLoansFor(firstEligible.memberId);
      expect(firstEligibleLoans).toHaveLength(1);
      expect(firstEligibleLoans[0]?.copyId).toBe(copy.copyId);

      // and neither suspended member nor the second eligible member got a loan
      expect(await scene.lending.listLoansFor(suspendedOne.memberId)).toEqual([]);
      expect(await scene.lending.listLoansFor(suspendedTwo.memberId)).toEqual([]);
      expect(await scene.lending.listLoansFor(secondEligible.memberId)).toEqual([]);

      // and the bus shows exactly one LoanOpened and one AutoLoanOpened —
      // the consumer did not continue iterating after the first eligible
      // borrow
      expect(eventTypes(scene.bus)).toEqual(['LoanReturned', 'LoanOpened', 'AutoLoanOpened']);
    });

    it('is a no-op when every queued reservation is ineligible (AC-2.4, AC-2.6)', async () => {
      // given two pending reservations for book B, both by suspended members
      const copy = await scene.seedAvailableCopy();
      const alice = await scene.seedMember('Alice');
      const suspendedOne = await scene.seedMember('SuspendedOne');
      const suspendedTwo = await scene.seedMember('SuspendedTwo');
      const aliceLoan = await scene.lending.borrow(alice.memberId, copy.copyId);
      await scene.lending.reserve(suspendedOne.memberId, copy.bookId);
      await scene.lending.reserve(suspendedTwo.memberId, copy.bookId);
      await scene.membership.suspend(suspendedOne.memberId);
      await scene.membership.suspend(suspendedTwo.memberId);
      scene.bus.clear();

      // when alice returns the loan
      await scene.lending.returnLoan(aliceLoan.loanId);

      // then no new loan exists for either suspended member
      expect(await scene.lending.listLoansFor(suspendedOne.memberId)).toEqual([]);
      expect(await scene.lending.listLoansFor(suspendedTwo.memberId)).toEqual([]);

      // both reservations stay pending
      const reservations = await scene.reservations.listReservations();
      for (const reservation of reservations) {
        expect(reservation.fulfilledAt).toBeUndefined();
      }

      // bus shows only LoanReturned — no LoanOpened, no AutoLoanOpened, no AutoLoanFailed
      expect(eventTypes(scene.bus)).toEqual(['LoanReturned']);

      // copy remains AVAILABLE
      expect((await scene.catalog.findCopy(copy.copyId)).status).toBe(CopyStatus.AVAILABLE);
    });

    it('is a no-op when the single pending reservation is ineligible (AC-2.4, AC-2.6)', async () => {
      // given one pending reservation for book B by a suspended member
      const copy = await scene.seedAvailableCopy();
      const alice = await scene.seedMember('Alice');
      const suspended = await scene.seedMember('Suspended');
      const aliceLoan = await scene.lending.borrow(alice.memberId, copy.copyId);
      await scene.lending.reserve(suspended.memberId, copy.bookId);
      await scene.membership.suspend(suspended.memberId);
      scene.bus.clear();

      // when alice returns the loan
      await scene.lending.returnLoan(aliceLoan.loanId);

      // then no new loan, no additional events beyond LoanReturned
      expect(await scene.lending.listLoansFor(suspended.memberId)).toEqual([]);
      expect(eventTypes(scene.bus)).toEqual(['LoanReturned']);

      // reservation stays pending
      const [reservation] = await scene.reservations.listReservations();
      expect(reservation?.fulfilledAt).toBeUndefined();

      // copy remains AVAILABLE
      expect((await scene.catalog.findCopy(copy.copyId)).status).toBe(CopyStatus.AVAILABLE);
    });
  });

  describe('lifecycle (AC-1.11)', () => {
    it('start() called twice without stop() is a no-op — single subscription', async () => {
      // given a second start() call on an already-started consumer
      scene.consumer.start();
      const copy = await scene.seedAvailableCopy();
      const alice = await scene.seedMember('Alice');
      const bob = await scene.seedMember('Bob');
      const aliceLoan = await scene.lending.borrow(alice.memberId, copy.copyId);
      await scene.lending.reserve(bob.memberId, copy.bookId);
      scene.bus.clear();

      // when the loan is returned
      await scene.lending.returnLoan(aliceLoan.loanId);

      // then bob still gets exactly one loan (handler did not fire twice)
      const bobLoans = await scene.lending.listLoansFor(bob.memberId);
      expect(bobLoans).toHaveLength(1);
      expect(eventTypes(scene.bus).filter((t) => t === 'LoanOpened')).toEqual(['LoanOpened']);
    });

    it('stop() detaches the handler so subsequent returns do not trigger the consumer', async () => {
      const copy = await scene.seedAvailableCopy();
      const alice = await scene.seedMember('Alice');
      const bob = await scene.seedMember('Bob');
      const aliceLoan = await scene.lending.borrow(alice.memberId, copy.copyId);
      await scene.lending.reserve(bob.memberId, copy.bookId);
      scene.bus.clear();

      scene.consumer.stop();
      await scene.lending.returnLoan(aliceLoan.loanId);

      // no new loan for bob — consumer was not subscribed
      expect(await scene.lending.listLoansFor(bob.memberId)).toEqual([]);
      expect(eventTypes(scene.bus)).toEqual(['LoanReturned']);
    });
  });

  describe('AutoLoanOpened event (AC-3.5, AC-3.6)', () => {
    it('publishes AutoLoanOpened AFTER borrow resolves with the new loanId, bookId, memberId, and reservationId', async () => {
      const copy = await scene.seedAvailableCopy();
      const alice = await scene.seedMember('Alice');
      const bob = await scene.seedMember('Bob');
      const aliceLoan = await scene.lending.borrow(alice.memberId, copy.copyId);
      const bobReservation = await scene.lending.reserve(bob.memberId, copy.bookId);
      scene.bus.clear();

      await scene.lending.returnLoan(aliceLoan.loanId);

      const bobLoans = await scene.lending.listLoansFor(bob.memberId);
      expect(bobLoans).toHaveLength(1);
      const bobLoan = bobLoans[0] as LoanDto;

      // order: LoanReturned (returnLoan) -> LoanOpened (borrow) -> AutoLoanOpened (consumer)
      expect(eventTypes(scene.bus)).toEqual(['LoanReturned', 'LoanOpened', 'AutoLoanOpened']);

      const autoOpened = scene.bus.collected().find((e) => e.type === 'AutoLoanOpened') as
        | AutoLoanOpened
        | undefined;
      expect(autoOpened).toBeDefined();
      expect(autoOpened?.loanId).toBe(bobLoan.loanId);
      expect(autoOpened?.bookId).toBe(copy.bookId);
      expect(autoOpened?.memberId).toBe(bob.memberId);
      expect(autoOpened?.reservationId).toBe(bobReservation.reservationId);
      expect(autoOpened?.openedAt).toEqual(FIXED_NOW);
    });
  });

  describe('failure policy (AC-3.7 – AC-3.10)', () => {
    it('publishes AutoLoanFailed and un-fulfills the claim when borrow throws mid-consumer', async () => {
      // Use a loan repository that fails on the NEXT new-loan save. Alice's
      // initial borrow happens first (unarmed), Alice's returnLoan updates
      // the existing loan (not a new one), and the consumer's borrow for Bob
      // is the first new-loan save after arming — so that is the one that
      // throws.
      const throwingLoans = new ThrowingOnceLoanRepository();
      const altScene = buildConsumerScene({ loanRepository: throwingLoans });
      const copy = await altScene.seedAvailableCopy();
      const alice = await altScene.seedMember('Alice');
      const bob = await altScene.seedMember('Bob');
      const aliceLoan = await altScene.lending.borrow(alice.memberId, copy.copyId);
      await altScene.lending.reserve(bob.memberId, copy.bookId);
      altScene.bus.clear();

      throwingLoans.armFailureOnNextNewLoan(new Error('loan store is down'));

      // returnLoan resolves normally — the consumer swallows its error
      await expect(altScene.lending.returnLoan(aliceLoan.loanId)).resolves.toMatchObject({
        loanId: aliceLoan.loanId,
      });

      // bob got no loan
      expect(await altScene.lending.listLoansFor(bob.memberId)).toEqual([]);

      // reservation un-fulfilled: bob stays in the pending queue for next return
      const [reservation] = await altScene.reservations.listReservations();
      expect(reservation?.fulfilledAt).toBeUndefined();

      // bus shows LoanReturned and AutoLoanFailed — no LoanOpened, no AutoLoanOpened
      expect(eventTypes(altScene.bus)).toEqual(['LoanReturned', 'AutoLoanFailed']);

      const failed = altScene.bus.collected().find((e) => e.type === 'AutoLoanFailed') as
        | AutoLoanFailed
        | undefined;
      expect(failed).toBeDefined();
      expect(failed?.bookId).toBe(copy.bookId);
      expect(failed?.reservationId).toBe(reservation?.reservationId);
      expect(failed?.memberId).toBe(reservation?.memberId);
      expect(failed?.reason).toBe('loan store is down');
      expect(failed?.failedAt).toEqual(FIXED_NOW);
    });

    it('publishes AutoLoanFailed with the ORIGINAL borrow error even when the un-fulfill write itself throws', async () => {
      // Pathological case: borrow fails AND the subsequent un-fulfill write
      // also fails. The consumer still publishes AutoLoanFailed (so operators
      // see the failure) and uses the original borrow error message — the
      // un-fulfill error is swallowed. Reservation is left fulfilled-but-no-loan.
      const throwingLoans = new ThrowingOnceLoanRepository();
      const throwingReservations = new ThrowingOnTrigger();
      const bus = new InMemoryEventBus();
      const catalog = createCatalogFacade({ newId: sequentialIds('cat') });
      const membership = createMembershipFacade({ newId: sequentialIds('mem') });
      const txFactory = () => new InMemoryTransactionalContext(bus);
      const lending = createLendingFacade({
        catalogFacade: catalog,
        membershipFacade: membership,
        loanRepository: throwingLoans,
        reservationRepository: throwingReservations,
        eventBus: bus,
        txFactory,
        newId: sequentialIds('loan'),
        clock: fixedClock,
      });
      const consumer = createAutoLoanOnReturnConsumer({
        bus,
        membership,
        reservations: throwingReservations,
        lending,
        txFactory,
        clock: fixedClock,
      });
      consumer.start();

      const book = await catalog.addBook(sampleNewBook({ isbn: '978-0000000999' }));
      const copy = await catalog.registerCopy(book.bookId, sampleNewCopy({ bookId: book.bookId }));
      const alice = await membership.registerMember(
        sampleNewMember({ name: 'Alice', email: 'alice-9@lib.test' }),
      );
      const bob = await membership.registerMember(
        sampleNewMember({ name: 'Bob', email: 'bob-9@lib.test' }),
      );
      const aliceLoan = await lending.borrow(alice.memberId, copy.copyId);
      await lending.reserve(bob.memberId, book.bookId);
      bus.clear();

      // Save counts so far: bob.reserve above is call #1. The consumer's
      // claim write is call #2 (must succeed so there is a claim to un-fulfill).
      // The un-fulfill is call #3 (arm to fail so the swallow path fires).
      throwingLoans.armFailureOnNextNewLoan(new Error('loan store is down'));
      throwingReservations.armNthSaveFailure(3, new Error('reservation store is down'));

      await expect(lending.returnLoan(aliceLoan.loanId)).resolves.toMatchObject({
        loanId: aliceLoan.loanId,
      });

      // AutoLoanFailed still emitted with the ORIGINAL borrow error message
      expect(eventTypes(bus)).toEqual(['LoanReturned', 'AutoLoanFailed']);
      const failed = bus.collected().find((e) => e.type === 'AutoLoanFailed') as
        | AutoLoanFailed
        | undefined;
      expect(failed?.reason).toBe('loan store is down');
      expect(failed?.memberId).toBe(bob.memberId);

      // Reservation is left fulfilled (un-fulfill swallowed) — known
      // pathological state per architecture.
      const [reservation] = await throwingReservations.listReservations();
      expect(reservation?.fulfilledAt).toEqual(FIXED_NOW);

      consumer.stop();
    });
  });

  describe('claim-first concurrency (AC-3.3, AC-3.4)', () => {
    it('opens exactly one loan per reservation when two concurrent returns race on the same book', async () => {
      // Seed: book B with two copies, both currently loaned to different
      // members; two pending reservations for book B by M1 (queued first)
      // and M2 (queued second). Trigger both returns in parallel.
      const book = await scene.catalog.addBook(sampleNewBook({ isbn: '978-0000001001' }));
      const copyA = await scene.catalog.registerCopy(
        book.bookId,
        sampleNewCopy({ bookId: book.bookId }),
      );
      const copyB = await scene.catalog.registerCopy(
        book.bookId,
        sampleNewCopy({ bookId: book.bookId }),
      );
      const alice = await scene.seedMember('Alice');
      const carol = await scene.seedMember('Carol');
      const m1 = await scene.seedMember('M1');
      const m2 = await scene.seedMember('M2');
      const aliceLoan = await scene.lending.borrow(alice.memberId, copyA.copyId);
      const carolLoan = await scene.lending.borrow(carol.memberId, copyB.copyId);
      const r1 = await scene.lending.reserve(m1.memberId, book.bookId);
      const r2 = await scene.lending.reserve(m2.memberId, book.bookId);
      scene.bus.clear();

      // Race: both returns resolve concurrently. Each fan-out runs its
      // consumer handler. Claim-first ensures each reservation gets claimed
      // by exactly one consumer run, even if the handlers interleave.
      await Promise.all([
        scene.lending.returnLoan(aliceLoan.loanId),
        scene.lending.returnLoan(carolLoan.loanId),
      ]);

      // Exactly one loan per reserver
      const m1Loans = await scene.lending.listLoansFor(m1.memberId);
      const m2Loans = await scene.lending.listLoansFor(m2.memberId);
      expect(m1Loans).toHaveLength(1);
      expect(m2Loans).toHaveLength(1);

      // Each loan is on ONE of the returned copies (either order acceptable)
      const loanCopyIds = [m1Loans[0]?.copyId, m2Loans[0]?.copyId].sort();
      const returnedCopyIds = [copyA.copyId, copyB.copyId].sort();
      expect(loanCopyIds).toEqual(returnedCopyIds);

      // Both reservations fulfilled exactly once
      const reservations = await scene.reservations.listReservations();
      const r1Row = reservations.find((r) => r.reservationId === r1.reservationId);
      const r2Row = reservations.find((r) => r.reservationId === r2.reservationId);
      expect(r1Row?.fulfilledAt).toEqual(FIXED_NOW);
      expect(r2Row?.fulfilledAt).toEqual(FIXED_NOW);

      // Exactly two AutoLoanOpened events on the bus — one per reservation.
      const autoOpened = scene.bus
        .collected()
        .filter((e) => e.type === 'AutoLoanOpened') as AutoLoanOpened[];
      expect(autoOpened).toHaveLength(2);
      const claimedReservationIds = autoOpened.map((e) => e.reservationId).sort();
      expect(claimedReservationIds).toEqual([r1.reservationId, r2.reservationId].sort());

      // No AutoLoanFailed: the race resolved cleanly.
      expect(scene.bus.collected().filter((e) => e.type === 'AutoLoanFailed')).toEqual([]);
    });
  });

  describe('re-entrancy safety inside the LoanReturned fan-out (AC-3.11 applied)', () => {
    it('a second LoanReturned subscriber added alongside the consumer still fires cleanly', async () => {
      // The consumer's handler calls borrow which publishes LoanOpened —
      // that re-entrant publish happens while we are inside the outer
      // LoanReturned fan-out. Snapshot-before-iterate on the bus protects
      // the iteration target. This test exercises the guarantee end-to-end:
      // a second LoanReturned subscriber fires exactly once per outer
      // publish even when the consumer re-publishes mid-fan-out.
      const extraLoanReturnedCount = { value: 0 };
      scene.bus.subscribe<import('./lending.types.js').LoanReturned>('LoanReturned', async () => {
        extraLoanReturnedCount.value += 1;
      });

      const copy = await scene.seedAvailableCopy();
      const alice = await scene.seedMember('Alice');
      const bob = await scene.seedMember('Bob');
      const aliceLoan = await scene.lending.borrow(alice.memberId, copy.copyId);
      await scene.lending.reserve(bob.memberId, copy.bookId);
      scene.bus.clear();

      await scene.lending.returnLoan(aliceLoan.loanId);

      // The extra subscriber fired exactly once for the single LoanReturned
      // publish — the re-entrant publishes from inside the consumer did not
      // corrupt or duplicate its invocation.
      expect(extraLoanReturnedCount.value).toBe(1);

      // The consumer's full happy-path still completed end-to-end.
      expect(await scene.lending.listLoansFor(bob.memberId)).toHaveLength(1);
      expect(eventTypes(scene.bus)).toEqual(['LoanReturned', 'LoanOpened', 'AutoLoanOpened']);
    });
  });

  describe('claim-first write ordering (AC-3.1, AC-3.2)', () => {
    it('persists reservation.fulfilledAt BEFORE lending.borrow inspects the repo', async () => {
      // AC-3.1 demands the claim write happens BEFORE borrow runs. We prove
      // this by snapshotting the reservation state from inside the loan
      // repository's saveLoan — which is called during borrow's own
      // transaction, strictly AFTER the consumer's claim tx has committed.
      // If the order were reversed (borrow first, claim second), saveLoan
      // would observe an undefined fulfilledAt.
      const observedReservationState: ReservationDto[] = [];
      const sharedReservations = new InMemoryReservationRepository();
      const spyingLoans = new SnapshottingLoanRepository(
        sharedReservations,
        observedReservationState,
      );
      const bus = new InMemoryEventBus();
      const catalog = createCatalogFacade({ newId: sequentialIds('cat') });
      const membership = createMembershipFacade({ newId: sequentialIds('mem') });
      const txFactory = () => new InMemoryTransactionalContext(bus);
      const lending = createLendingFacade({
        catalogFacade: catalog,
        membershipFacade: membership,
        loanRepository: spyingLoans,
        reservationRepository: sharedReservations,
        eventBus: bus,
        txFactory,
        newId: sequentialIds('loan'),
        clock: fixedClock,
      });
      const consumer = createAutoLoanOnReturnConsumer({
        bus,
        membership,
        reservations: sharedReservations,
        lending,
        txFactory,
        clock: fixedClock,
      });
      consumer.start();

      const book = await catalog.addBook(sampleNewBook({ isbn: '978-0000002001' }));
      const copy = await catalog.registerCopy(book.bookId, sampleNewCopy({ bookId: book.bookId }));
      const alice = await membership.registerMember(
        sampleNewMember({ name: 'Alice', email: 'alice-order@lib.test' }),
      );
      const bob = await membership.registerMember(
        sampleNewMember({ name: 'Bob', email: 'bob-order@lib.test' }),
      );
      const aliceLoan = await lending.borrow(alice.memberId, copy.copyId);
      const bobReservation = await lending.reserve(bob.memberId, book.bookId);

      // Reset the snapshot ledger so only the consumer-driven borrow is observed.
      observedReservationState.length = 0;

      await lending.returnLoan(aliceLoan.loanId);

      // Exactly one saveLoan happened during the consumer's borrow (for Bob).
      // That call must have observed Bob's reservation already fulfilled — the
      // proof that claim-first wrote through its own txFactory.run and
      // committed before borrow began.
      const bobRow = observedReservationState.find(
        (r) => r.reservationId === bobReservation.reservationId,
      );
      expect(bobRow).toBeDefined();
      expect(bobRow?.fulfilledAt).toEqual(FIXED_NOW);

      consumer.stop();
    });
  });

  describe('un-fulfill ordering and queue recovery (AC-3.8, AC-3.9a)', () => {
    it('un-fulfilled reservation is re-visible to listPendingReservationsForBook after the failure', async () => {
      // AC-3.8 says the un-fulfill write truly reverts fulfilledAt to the
      // "pending again" state. The sharp assertion is that a fresh call to
      // listPendingReservationsForBook(bookId) returns the reservation —
      // i.e. the next incoming LoanReturned for this book would pick it up
      // again, matching the spec's "reserver stays in queue for next return"
      // rationale.
      const throwingLoans = new ThrowingOnceLoanRepository();
      const altScene = buildConsumerScene({ loanRepository: throwingLoans });
      const copy = await altScene.seedAvailableCopy();
      const alice = await altScene.seedMember('Alice');
      const bob = await altScene.seedMember('Bob');
      const aliceLoan = await altScene.lending.borrow(alice.memberId, copy.copyId);
      const bobReservation = await altScene.lending.reserve(bob.memberId, copy.bookId);
      altScene.bus.clear();

      throwingLoans.armFailureOnNextNewLoan(new Error('loan store is down'));

      await altScene.lending.returnLoan(aliceLoan.loanId);

      // Un-fulfill must make Bob's reservation pending again for this book —
      // the queue-walking post-condition of the failure policy.
      const pending = await altScene.reservations.listPendingReservationsForBook(copy.bookId);
      expect(pending.map((r) => r.reservationId)).toContain(bobReservation.reservationId);
      const bobRow = pending.find((r) => r.reservationId === bobReservation.reservationId);
      expect(bobRow?.fulfilledAt).toBeUndefined();
    });

    it('the un-fulfill write has committed BEFORE AutoLoanFailed is published', async () => {
      // AC-3.9a: the operator reading the failure event must be able to trust
      // that the reservation is already back in the pending queue at the
      // moment the event arrives — otherwise retry logic on the failure
      // signal would race with the un-fulfill. Prove it by snapshotting the
      // reservation repo from inside an AutoLoanFailed subscriber.
      const throwingLoans = new ThrowingOnceLoanRepository();
      const altScene = buildConsumerScene({ loanRepository: throwingLoans });
      const copy = await altScene.seedAvailableCopy();
      const alice = await altScene.seedMember('Alice');
      const bob = await altScene.seedMember('Bob');
      const aliceLoan = await altScene.lending.borrow(alice.memberId, copy.copyId);
      const bobReservation = await altScene.lending.reserve(bob.memberId, copy.bookId);

      let fulfilledAtOnFailurePublish: Date | undefined = new Date('9999-01-01');
      altScene.bus.subscribe<AutoLoanFailed>('AutoLoanFailed', async (event) => {
        const row = await altScene.reservations.findReservationById(event.reservationId);
        fulfilledAtOnFailurePublish = row?.fulfilledAt;
      });

      altScene.bus.clear();
      throwingLoans.armFailureOnNextNewLoan(new Error('loan store is down'));

      await altScene.lending.returnLoan(aliceLoan.loanId);

      // At the moment the failure event was observed, the reservation row was
      // already un-fulfilled.
      expect(fulfilledAtOnFailurePublish).toBeUndefined();
      // Sanity: the event actually fired and targeted Bob's reservation.
      const failed = altScene.bus.collected().find((e) => e.type === 'AutoLoanFailed') as
        | AutoLoanFailed
        | undefined;
      expect(failed?.reservationId).toBe(bobReservation.reservationId);
      expect(failed?.memberId).toBe(bob.memberId);
    });
  });

  describe('publish-error propagation (AC-3.10)', () => {
    it('propagates a throwing AutoLoanOpened subscriber out of returnLoan — the try/catch wraps borrow only', async () => {
      // The consumer's internal try/catch wraps borrow only. Errors from
      // publishing AutoLoanOpened are bus-handler-error semantics: they
      // propagate. returnLoan's publish of LoanReturned therefore rejects,
      // which is the spec's intended "loud on publish failure" behaviour.
      scene.bus.subscribe<AutoLoanOpened>('AutoLoanOpened', async () => {
        throw new Error('downstream AutoLoanOpened consumer exploded');
      });

      const copy = await scene.seedAvailableCopy();
      const alice = await scene.seedMember('Alice');
      const bob = await scene.seedMember('Bob');
      const aliceLoan = await scene.lending.borrow(alice.memberId, copy.copyId);
      await scene.lending.reserve(bob.memberId, copy.bookId);
      scene.bus.clear();

      await expect(scene.lending.returnLoan(aliceLoan.loanId)).rejects.toThrow(
        'downstream AutoLoanOpened consumer exploded',
      );
    });

    it('releases the per-book mutex when the handler throws — the next return on the same book processes normally', async () => {
      // Regression against a latent deadlock: if the per-book mutex map does
      // not clear on handler error, a book that saw ONE publish-error would
      // stall every future LoanReturned for that book. The finally-clause on
      // runExclusive guards this. Exercise it by making the first return's
      // consumer run throw via a publish-error subscriber, then run a second
      // return on the same book and assert the consumer still processes it.
      let shouldThrow = true;
      scene.bus.subscribe<AutoLoanOpened>('AutoLoanOpened', async () => {
        if (shouldThrow) {
          shouldThrow = false;
          throw new Error('one-shot poisoned subscriber');
        }
      });

      // Seed: one book, TWO copies, two pending reservations.
      const book = await scene.catalog.addBook(sampleNewBook({ isbn: '978-0000003001' }));
      const copyA = await scene.catalog.registerCopy(
        book.bookId,
        sampleNewCopy({ bookId: book.bookId }),
      );
      const copyB = await scene.catalog.registerCopy(
        book.bookId,
        sampleNewCopy({ bookId: book.bookId }),
      );
      const alice = await scene.seedMember('Alice');
      const carol = await scene.seedMember('Carol');
      const m1 = await scene.seedMember('M1');
      const m2 = await scene.seedMember('M2');
      const aliceLoan = await scene.lending.borrow(alice.memberId, copyA.copyId);
      const carolLoan = await scene.lending.borrow(carol.memberId, copyB.copyId);
      await scene.lending.reserve(m1.memberId, book.bookId);
      await scene.lending.reserve(m2.memberId, book.bookId);

      // First return: handler throws out of the consumer (publish error). The
      // mutex finally-clause MUST release so the second return is not stuck.
      await expect(scene.lending.returnLoan(aliceLoan.loanId)).rejects.toThrow(
        'one-shot poisoned subscriber',
      );

      // Second return on the SAME book: the mutex must have released; the
      // consumer should process normally (the one-shot subscriber is disarmed).
      await scene.lending.returnLoan(carolLoan.loanId);

      // At least one of M1/M2 now has a loan — the mutex was not deadlocked.
      // (The first consumer run actually DID open a loan before its publish
      // threw; borrow completed successfully prior to publishAutoLoanOpened.)
      const m1Loans = await scene.lending.listLoansFor(m1.memberId);
      const m2Loans = await scene.lending.listLoansFor(m2.memberId);
      const totalReserverLoans = m1Loans.length + m2Loans.length;
      expect(totalReserverLoans).toBeGreaterThanOrEqual(1);
    });
  });
});

// --- Spec-local failure wrappers --------------------------------------------
// Mirror of ThrowingOnceReservationRepository / ThrowingOnceLoanRepository in
// lending.facade.spec.ts. Kept spec-local per the Nabrdalik convention — these
// are not production wiring and must not leak across spec files.

class ThrowingOnceLoanRepository implements LoanRepository {
  private readonly delegate = new InMemoryLoanRepository();
  private readonly knownLoanIds = new Set<string>();
  private failOnNextNewLoan: Error | null = null;

  armFailureOnNextNewLoan(error: Error): void {
    this.failOnNextNewLoan = error;
  }

  saveLoan(loan: LoanDto, ctx: TransactionalContext): void {
    const isUpdate = this.knownLoanIds.has(loan.loanId);
    if (this.failOnNextNewLoan && !isUpdate) {
      const error = this.failOnNextNewLoan;
      this.failOnNextNewLoan = null;
      throw error;
    }
    this.delegate.saveLoan(loan, ctx);
    this.knownLoanIds.add(loan.loanId);
  }

  findLoanById(loanId: string): Promise<LoanDto | undefined> {
    return this.delegate.findLoanById(loanId);
  }

  listLoansForMember(memberId: string): Promise<LoanDto[]> {
    return this.delegate.listLoansForMember(memberId);
  }

  listLoansForBook(bookId: BookId): Promise<LoanDto[]> {
    return this.delegate.listLoansForBook(bookId);
  }

  listLoans(): Promise<LoanDto[]> {
    return this.delegate.listLoans();
  }

  listActiveLoansWithQueuedReservations(): ReturnType<
    LoanRepository['listActiveLoansWithQueuedReservations']
  > {
    return this.delegate.listActiveLoansWithQueuedReservations();
  }
}

class ThrowingOnTrigger extends InMemoryReservationRepository {
  private saveCount = 0;
  private failureByCallIndex = new Map<number, Error>();

  armNthSaveFailure(n: number, error: Error): void {
    this.failureByCallIndex.set(n, error);
  }

  override saveReservation(reservation: ReservationDto, ctx: TransactionalContext): void {
    this.saveCount += 1;
    const error = this.failureByCallIndex.get(this.saveCount);
    if (error) {
      this.failureByCallIndex.delete(this.saveCount);
      throw error;
    }
    super.saveReservation(reservation, ctx);
  }
}

// Records the reservation-repo state at the moment a NEW loan's saveLoan is
// invoked (saveLoan is also called for returnLoan's update path — we skip
// those so `observed` captures only the creations that matter for the
// claim-first test). Used by the claim-first ordering test (AC-3.1) to prove
// the consumer's claim write has already committed BEFORE borrow's saveLoan
// runs — the snapshot in `observed` must show the reservation as fulfilled.
class SnapshottingLoanRepository implements LoanRepository {
  private readonly delegate = new InMemoryLoanRepository();
  private readonly knownLoanIds = new Set<string>();

  constructor(
    private readonly reservations: InMemoryReservationRepository,
    private readonly observed: ReservationDto[],
  ) {}

  saveLoan(loan: LoanDto, ctx: TransactionalContext): void {
    const isUpdate = this.knownLoanIds.has(loan.loanId);
    if (!isUpdate) {
      void this.reservations.listReservations().then((rows) => {
        for (const row of rows) this.observed.push({ ...row });
      });
    }
    this.delegate.saveLoan(loan, ctx);
    this.knownLoanIds.add(loan.loanId);
  }

  findLoanById(loanId: string): Promise<LoanDto | undefined> {
    return this.delegate.findLoanById(loanId);
  }

  listLoansForMember(memberId: string): Promise<LoanDto[]> {
    return this.delegate.listLoansForMember(memberId);
  }

  listLoansForBook(bookId: BookId): Promise<LoanDto[]> {
    return this.delegate.listLoansForBook(bookId);
  }

  listLoans(): Promise<LoanDto[]> {
    return this.delegate.listLoans();
  }

  listActiveLoansWithQueuedReservations(): ReturnType<
    LoanRepository['listActiveLoansWithQueuedReservations']
  > {
    return this.delegate.listActiveLoansWithQueuedReservations();
  }
}
