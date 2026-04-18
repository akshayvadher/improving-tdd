import { pgTable, text, uuid } from 'drizzle-orm/pg-core';

import { books } from './books.js';

export const copies = pgTable('copies', {
  copyId: uuid('copy_id').primaryKey(),
  bookId: uuid('book_id')
    .notNull()
    .references(() => books.bookId),
  condition: text('condition').notNull(),
  status: text('status').notNull(),
});
