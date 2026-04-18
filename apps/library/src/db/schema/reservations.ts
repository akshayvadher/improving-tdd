import { pgTable, timestamp, uuid } from 'drizzle-orm/pg-core';

import { books } from './books.js';
import { members } from './members.js';

export const reservations = pgTable('reservations', {
  reservationId: uuid('reservation_id').primaryKey(),
  memberId: uuid('member_id')
    .notNull()
    .references(() => members.memberId),
  bookId: uuid('book_id')
    .notNull()
    .references(() => books.bookId),
  reservedAt: timestamp('reserved_at', { withTimezone: true }).notNull(),
  fulfilledAt: timestamp('fulfilled_at', { withTimezone: true }),
});
