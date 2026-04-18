import type { BookId } from '../catalog/index.js';
import type { ReservationDto, ReservationId } from './lending.types.js';
import type { TransactionalContext } from './transactional-context.js';

export interface ReservationRepository {
  saveReservation(reservation: ReservationDto, ctx: TransactionalContext): void;
  findReservationById(reservationId: ReservationId): Promise<ReservationDto | undefined>;
  listPendingReservationsForBook(bookId: BookId): Promise<ReservationDto[]>;
  listReservations(): Promise<ReservationDto[]>;
}
