import { eq } from 'drizzle-orm';

import type { AppDatabase } from '../db/client.js';
import { books, copies } from '../db/schema/index.js';
import type { CatalogRepository } from './catalog.repository.js';
import {
  CopyStatus,
  type BookDto,
  type BookId,
  type CopyCondition,
  type CopyDto,
  type CopyId,
  type Isbn,
} from './catalog.types.js';

type BookRow = typeof books.$inferSelect;
type CopyRow = typeof copies.$inferSelect;

export class DrizzleCatalogRepository implements CatalogRepository {
  constructor(private readonly db: AppDatabase) {}

  async saveBook(book: BookDto): Promise<void> {
    await this.db
      .insert(books)
      .values(toBookRow(book))
      .onConflictDoUpdate({ target: books.bookId, set: toBookRow(book) });
  }

  async findBookById(bookId: BookId): Promise<BookDto | undefined> {
    const [row] = await this.db.select().from(books).where(eq(books.bookId, bookId));
    return row ? toBookDto(row) : undefined;
  }

  async findBookByIsbn(isbn: Isbn): Promise<BookDto | undefined> {
    const [row] = await this.db.select().from(books).where(eq(books.isbn, isbn));
    return row ? toBookDto(row) : undefined;
  }

  async listBooks(): Promise<BookDto[]> {
    const rows = await this.db.select().from(books);
    return rows.map(toBookDto);
  }

  async saveCopy(copy: CopyDto): Promise<void> {
    await this.db
      .insert(copies)
      .values(toCopyRow(copy))
      .onConflictDoUpdate({ target: copies.copyId, set: toCopyRow(copy) });
  }

  async findCopyById(copyId: CopyId): Promise<CopyDto | undefined> {
    const [row] = await this.db.select().from(copies).where(eq(copies.copyId, copyId));
    return row ? toCopyDto(row) : undefined;
  }
}

function toBookRow(book: BookDto): BookRow {
  return {
    bookId: book.bookId,
    title: book.title,
    authors: [...book.authors],
    isbn: book.isbn,
  };
}

function toBookDto(row: BookRow): BookDto {
  return {
    bookId: row.bookId,
    title: row.title,
    authors: [...row.authors],
    isbn: row.isbn,
  };
}

function toCopyRow(copy: CopyDto): CopyRow {
  return {
    copyId: copy.copyId,
    bookId: copy.bookId,
    condition: copy.condition,
    status: copy.status,
  };
}

function toCopyDto(row: CopyRow): CopyDto {
  return {
    copyId: row.copyId,
    bookId: row.bookId,
    condition: row.condition as CopyCondition,
    status: row.status as CopyStatus,
  };
}
