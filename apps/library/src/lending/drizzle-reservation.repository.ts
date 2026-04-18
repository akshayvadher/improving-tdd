import { and, asc, eq, isNull } from 'drizzle-orm';

import type { BookId } from '../catalog/index.js';
import type { AppDatabase } from '../db/client.js';
import { reservations } from '../db/schema/index.js';
import type { ReservationDto, ReservationId } from './lending.types.js';
import type { ReservationRepository } from './reservation.repository.js';
import type { TransactionalContext } from './transactional-context.js';
import { DrizzleTransactionalContext } from './drizzle-transactional-context.js';

type ReservationRow = typeof reservations.$inferSelect;

export class DrizzleReservationRepository implements ReservationRepository {
  constructor(private readonly db: AppDatabase) {}

  saveReservation(reservation: ReservationDto, ctx: TransactionalContext): void {
    const handle = handleFrom(ctx, this.db);
    const row = toRow(reservation);
    ctx.stage(async () => {
      await handle
        .insert(reservations)
        .values(row)
        .onConflictDoUpdate({ target: reservations.reservationId, set: row });
    });
  }

  async findReservationById(reservationId: ReservationId): Promise<ReservationDto | undefined> {
    const [row] = await this.db
      .select()
      .from(reservations)
      .where(eq(reservations.reservationId, reservationId));
    return row ? toDto(row) : undefined;
  }

  async listPendingReservationsForBook(bookId: BookId): Promise<ReservationDto[]> {
    const rows = await this.db
      .select()
      .from(reservations)
      .where(and(eq(reservations.bookId, bookId), isNull(reservations.fulfilledAt)))
      .orderBy(asc(reservations.reservedAt));
    return rows.map(toDto);
  }

  async listReservations(): Promise<ReservationDto[]> {
    const rows = await this.db.select().from(reservations);
    return rows.map(toDto);
  }
}

function handleFrom(ctx: TransactionalContext, fallback: AppDatabase): AppDatabase {
  return ctx instanceof DrizzleTransactionalContext ? ctx.handle : fallback;
}

function toRow(reservation: ReservationDto): ReservationRow {
  return {
    reservationId: reservation.reservationId,
    memberId: reservation.memberId,
    bookId: reservation.bookId,
    reservedAt: reservation.reservedAt,
    fulfilledAt: reservation.fulfilledAt ?? null,
  };
}

function toDto(row: ReservationRow): ReservationDto {
  const dto: ReservationDto = {
    reservationId: row.reservationId,
    memberId: row.memberId,
    bookId: row.bookId,
    reservedAt: row.reservedAt,
  };
  if (row.fulfilledAt) {
    dto.fulfilledAt = row.fulfilledAt;
  }
  return dto;
}
