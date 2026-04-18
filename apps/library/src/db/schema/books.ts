import { pgTable, text, uuid } from 'drizzle-orm/pg-core';

// Teaching-artifact simplification:
// The spec lists a separate `authors` table + `book_authors` join. For the demo
// we store authors as `text[]` on the book row instead. The domain Book already
// exposes `authors: string[]`; adding a join table would multiply migration and
// repository scope without changing the teaching points. Swap to a join table
// when a real product needs author biographies, disambiguation, or merging.
export const books = pgTable('books', {
  bookId: uuid('book_id').primaryKey(),
  title: text('title').notNull(),
  authors: text('authors').array().notNull(),
  isbn: text('isbn').notNull().unique(),
});
