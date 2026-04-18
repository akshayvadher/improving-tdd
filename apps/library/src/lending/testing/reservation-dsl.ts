import type { BookId } from '../../catalog/index.js';
import type { MemberId } from '../../membership/index.js';
import type { LendingFacade } from '../lending.facade.js';
import type { ReservationRepository } from '../reservation.repository.js';

// A tiny DSL for reservation-queue tests. Reads like a whiteboard sketch:
//   await after(alice).reserves(book);
//   expect(queueFor(book)).toEqual([alice, bob, carol]);
// Keeps tests at the requirement level of abstraction (principle 11).

export interface ReservationScene {
  readonly lending: LendingFacade;
  readonly reservations: ReservationRepository;
}

export function queueBuilder(scene: ReservationScene) {
  return {
    async queueFor(bookId: BookId): Promise<MemberId[]> {
      const pending = await scene.reservations.listPendingReservationsForBook(bookId);
      return pending.map((reservation) => reservation.memberId);
    },
    after(memberId: MemberId) {
      return {
        async reserves(bookId: BookId): Promise<void> {
          await scene.lending.reserve(memberId, bookId);
        },
      };
    },
    async whenReturned(loanId: string): Promise<void> {
      await scene.lending.returnLoan(loanId);
    },
  };
}

export type ReservationDsl = ReturnType<typeof queueBuilder>;
