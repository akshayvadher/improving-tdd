// AutoLoanOnReturnConsumer subscribes to LoanReturned and walks the pending
// reservation queue for the returned book. Slice 3 layers in:
//   - Claim-first: write `fulfilledAt = now` on the candidate reservation
//     BEFORE calling lending.borrow(...). A concurrent consumer run that
//     subsequently calls listPendingReservationsForBook sees the claim and
//     skips past this reservation. This tightens (but does not eliminate) the
//     race; a DB unique constraint is the real fix and is out of scope here.
//   - Failure policy: wrap borrow in try/catch. On failure, un-fulfill the
//     claim so the reserver stays in queue for next return, and publish
//     AutoLoanFailed with the borrow error message. The consumer never
//     re-throws — returnLoan's HTTP caller always sees success.
//   - AutoLoanOpened: emitted after borrow resolves successfully. The event
//     order for one consumer run is LoanReturned -> LoanOpened -> AutoLoanOpened.
//
// Reservation write path (architecture decision #1a): the consumer owns its
// own TransactionalContextFactory. Both the claim and the un-fulfill run
// inside fresh txs from this factory. Each tx bundles ONE reservation write
// with ONE staged event (ReservationFulfilled or ReservationUnfulfilled) —
// if the write rejects, the event never publishes. This is the tx actually
// earning its keep: a subscriber that reacts to ReservationFulfilled by
// notifying the reserver can trust that the reservation is committed.
import type { BookId } from '../catalog/index.js';
import type { MembershipFacade } from '../membership/index.js';
import type { EventBus, Unsubscribe } from '../shared/events/event-bus.js';
import type { LendingFacade } from './lending.facade.js';
import type {
  AutoLoanFailed,
  AutoLoanOpened,
  LoanDto,
  LoanReturned,
  ReservationDto,
  ReservationFulfilled,
  ReservationUnfulfilled,
} from './lending.types.js';
import type { ReservationRepository } from './reservation.repository.js';
import type { TransactionalContextFactory } from './transactional-context.js';

export interface AutoLoanOnReturnConsumerDeps {
  bus: EventBus;
  membership: MembershipFacade;
  reservations: ReservationRepository;
  lending: LendingFacade;
  txFactory: TransactionalContextFactory;
  clock?: () => Date;
}

export interface AutoLoanOnReturnConsumer {
  start(): void;
  stop(): void;
}

export function createAutoLoanOnReturnConsumer(
  deps: AutoLoanOnReturnConsumerDeps,
): AutoLoanOnReturnConsumer {
  const clock = deps.clock ?? (() => new Date());
  let unsubscribe: Unsubscribe | undefined;

  // Per-book mutex: serialises consumer runs for the SAME book so concurrent
  // returns of different copies don't both pick the same head-of-queue
  // reservation before either has claim-written. Without this, the JS event
  // loop lets two handlers observe the pending list as [R1, R2] simultaneously
  // before either writes a claim, and both open loans for R1's member. The
  // real fix is a DB unique constraint on (bookId, memberId) where
  // fulfilledAt IS NULL — out of scope for this feature; this map is the
  // single-node equivalent.
  const bookLocks = new Map<BookId, Promise<void>>();

  const runExclusive = async (bookId: BookId, work: () => Promise<void>): Promise<void> => {
    const prior = bookLocks.get(bookId) ?? Promise.resolve();
    const next = prior.then(work, work);
    bookLocks.set(bookId, next);
    try {
      await next;
    } finally {
      if (bookLocks.get(bookId) === next) {
        bookLocks.delete(bookId);
      }
    }
  };

  const claimReservation = async (reservation: ReservationDto): Promise<ReservationDto> => {
    const fulfilledAt = clock();
    const claimed: ReservationDto = { ...reservation, fulfilledAt };
    const tx = deps.txFactory();
    // Atomicity target: the reservation write + the ReservationFulfilled
    // event. If saveReservation throws, tx.run rejects BEFORE stageEvent
    // runs AND BEFORE the staged events publish — downstream subscribers
    // never see a ReservationFulfilled for a claim that didn't land.
    await tx.run(async () => {
      deps.reservations.saveReservation(claimed, tx);
      const event: ReservationFulfilled = {
        type: 'ReservationFulfilled',
        reservationId: claimed.reservationId,
        memberId: claimed.memberId,
        bookId: claimed.bookId,
        fulfilledAt,
      };
      tx.stageEvent(event);
    });
    return claimed;
  };

  const tryUnfulfillClaim = async (reservation: ReservationDto): Promise<void> => {
    const { fulfilledAt: _discarded, ...rest } = reservation;
    const unfulfilled: ReservationDto = rest;
    const tx = deps.txFactory();
    try {
      // Atomicity target: the un-fulfill write + the ReservationUnfulfilled
      // event. If the write throws, no ReservationUnfulfilled is published.
      // AutoLoanFailed still fires OUTSIDE this tx (loud failure for the
      // operator) — it is decoupled from the tx on purpose.
      await tx.run(async () => {
        deps.reservations.saveReservation(unfulfilled, tx);
        const event: ReservationUnfulfilled = {
          type: 'ReservationUnfulfilled',
          reservationId: unfulfilled.reservationId,
          memberId: unfulfilled.memberId,
          bookId: unfulfilled.bookId,
          unfulfilledAt: clock(),
        };
        tx.stageEvent(event);
      });
    } catch {
      // Swallow: reservation left fulfilled-but-no-loan, no ReservationUnfulfilled
      // published (tx rolled back). AutoLoanFailed still fires below so the
      // operator can investigate. Spec calls this acceptable pathological state.
    }
  };

  const publishAutoLoanOpened = async (
    loan: LoanDto,
    reservation: ReservationDto,
  ): Promise<void> => {
    const event: AutoLoanOpened = {
      type: 'AutoLoanOpened',
      bookId: loan.bookId,
      loanId: loan.loanId,
      memberId: loan.memberId,
      reservationId: reservation.reservationId,
      openedAt: clock(),
    };
    await deps.bus.publish(event);
  };

  const publishAutoLoanFailed = async (
    reservation: ReservationDto,
    reason: string,
  ): Promise<void> => {
    const event: AutoLoanFailed = {
      type: 'AutoLoanFailed',
      bookId: reservation.bookId,
      reservationId: reservation.reservationId,
      memberId: reservation.memberId,
      reason,
      failedAt: clock(),
    };
    await deps.bus.publish(event);
  };

  const attemptAutoLoan = async (reservation: ReservationDto, copyId: string): Promise<void> => {
    const claimed = await claimReservation(reservation);
    let loan: LoanDto;
    try {
      loan = await deps.lending.borrow({ memberId: reservation.memberId, role: 'MEMBER' }, copyId);
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      await tryUnfulfillClaim(claimed);
      await publishAutoLoanFailed(claimed, reason);
      return;
    }
    await publishAutoLoanOpened(loan, claimed);
  };

  const handle = async (event: LoanReturned): Promise<void> => {
    await runExclusive(event.bookId, async () => {
      const pending = await deps.reservations.listPendingReservationsForBook(event.bookId);
      for (const reservation of pending) {
        const eligibility = await deps.membership.checkEligibility(reservation.memberId);
        if (!eligibility.eligible) {
          continue;
        }
        await attemptAutoLoan(reservation, event.copyId);
        return;
      }
    });
  };

  return {
    start(): void {
      if (unsubscribe) {
        return;
      }
      unsubscribe = deps.bus.subscribe<LoanReturned>('LoanReturned', handle);
    },
    stop(): void {
      unsubscribe?.();
      unsubscribe = undefined;
    },
  };
}
