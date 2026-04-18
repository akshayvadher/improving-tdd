import { pgTable, timestamp, uuid } from 'drizzle-orm/pg-core';

import { books } from './books.js';
import { copies } from './copies.js';
import { members } from './members.js';

export const loans = pgTable('loans', {
  loanId: uuid('loan_id').primaryKey(),
  memberId: uuid('member_id')
    .notNull()
    .references(() => members.memberId),
  copyId: uuid('copy_id')
    .notNull()
    .references(() => copies.copyId),
  bookId: uuid('book_id')
    .notNull()
    .references(() => books.bookId),
  borrowedAt: timestamp('borrowed_at', { withTimezone: true }).notNull(),
  dueDate: timestamp('due_date', { withTimezone: true }).notNull(),
  returnedAt: timestamp('returned_at', { withTimezone: true }),
});
