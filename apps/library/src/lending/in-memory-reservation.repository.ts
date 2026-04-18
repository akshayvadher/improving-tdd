import type { BookId } from '../catalog/index.js';
import type { ReservationDto, ReservationId } from './lending.types.js';
import type { ReservationRepository } from './reservation.repository.js';
import type { TransactionalContext } from './transactional-context.js';

export class InMemoryReservationRepository implements ReservationRepository {
  private readonly reservationsById = new Map<ReservationId, ReservationDto>();

  saveReservation(reservation: ReservationDto, ctx: TransactionalContext): void {
    const snapshot = { ...reservation };
    ctx.stage(() => {
      this.reservationsById.set(snapshot.reservationId, snapshot);
    });
  }

  async findReservationById(reservationId: ReservationId): Promise<ReservationDto | undefined> {
    return this.reservationsById.get(reservationId);
  }

  async listPendingReservationsForBook(bookId: BookId): Promise<ReservationDto[]> {
    return this.listReservationsSync()
      .filter((reservation) => reservation.bookId === bookId && reservation.fulfilledAt == null)
      .sort((a, b) => a.reservedAt.getTime() - b.reservedAt.getTime());
  }

  async listReservations(): Promise<ReservationDto[]> {
    return this.listReservationsSync();
  }

  private listReservationsSync(): ReservationDto[] {
    return Array.from(this.reservationsById.values());
  }
}
