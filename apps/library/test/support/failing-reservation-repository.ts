import type { ReservationDto } from '../../src/lending/lending.types.js';
import type { ReservationRepository } from '../../src/lending/reservation.repository.js';
import type { TransactionalContext } from '../../src/lending/transactional-context.js';

/**
 * A one-shot, test-only wrapper around `ReservationRepository`.
 *
 * Why this exists: to prove the atomicity contract on `returnLoan` against a
 * real Postgres container we need a write inside the transaction to fail
 * deterministically. Rather than adding a test-only flag to production code,
 * we wrap the real repo and, when armed, stage a throw via the
 * `TransactionalContext`. Because `ctx.stage` schedules the callback inside
 * the active `db.transaction`, Postgres rolls back everything the enclosing
 * `returnLoan` call wrote — which is the contract we want to exercise.
 *
 * The "once" part is deliberate: arm once, fire once, then the wrapper
 * delegates transparently so subsequent saves work normally if the test needs
 * them.
 */
export class FailingOnceReservationRepository implements ReservationRepository {
  private failOnNextSave = false;

  constructor(private readonly delegate: ReservationRepository) {}

  armFailure(): void {
    this.failOnNextSave = true;
  }

  saveReservation(reservation: ReservationDto, ctx: TransactionalContext): void {
    if (this.failOnNextSave) {
      this.failOnNextSave = false;
      ctx.stage(async () => {
        throw new Error('injected fulfillment failure');
      });
      return;
    }
    this.delegate.saveReservation(reservation, ctx);
  }

  findReservationById(id: string): Promise<ReservationDto | undefined> {
    return this.delegate.findReservationById(id);
  }

  listPendingReservationsForBook(bookId: string): Promise<ReservationDto[]> {
    return this.delegate.listPendingReservationsForBook(bookId);
  }

  listReservations(): Promise<ReservationDto[]> {
    return this.delegate.listReservations();
  }
}

interface FacadeWithReservationRepo {
  reservations: ReservationRepository;
}

/**
 * Replaces the `LendingFacade`'s reservation repo with a `FailingOnceReservationRepository`
 * and returns the wrapper so the test can arm it. The cast is deliberate: the
 * real facade field is `private readonly`, and for this test we need to reach
 * past that encapsulation to inject a failure — this is the only place the
 * harness is allowed to do so.
 */
export function installFailingReservationRepo(facade: object): FailingOnceReservationRepository {
  const internals = facade as FacadeWithReservationRepo;
  const wrapper = new FailingOnceReservationRepository(internals.reservations);
  internals.reservations = wrapper;
  return wrapper;
}
