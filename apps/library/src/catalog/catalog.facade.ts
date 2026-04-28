import { Injectable } from '@nestjs/common';
import { randomUUID } from 'node:crypto';

import { InMemoryBookCacheGateway } from '../shared/book-cache-gateway/in-memory-book-cache-gateway.js';
import type { BookCacheGateway } from '../shared/book-cache-gateway/book-cache-gateway.js';
import { InMemoryIsbnLookupGateway } from '../shared/isbn-gateway/in-memory-isbn-lookup-gateway.js';
import type { IsbnLookupGateway } from '../shared/isbn-gateway/isbn-lookup-gateway.js';
import type { CatalogRepository } from './catalog.repository.js';
import { parseIsbn, parseNewBook, parseNewCopy, parseUpdateBook } from './catalog.schema.js';
import {
  BookNotFoundError,
  CopyNotFoundError,
  CopyStatus,
  DuplicateIsbnError,
  type BookDto,
  type BookId,
  type CopyDto,
  type CopyId,
  type Isbn,
  type NewBookDto,
  type NewCopyDto,
  type UpdateBookDto,
} from './catalog.types.js';

type IdGenerator = () => string;

@Injectable()
export class CatalogFacade {
  constructor(
    private readonly repository: CatalogRepository,
    private readonly newId: IdGenerator = randomUUID,
    private readonly isbnGateway: IsbnLookupGateway = new InMemoryIsbnLookupGateway(),
    private readonly cache: BookCacheGateway = new InMemoryBookCacheGateway(),
  ) {}

  async addBook(dto: NewBookDto): Promise<BookDto> {
    const isbn = parseIsbn(dto.isbn);

    const enrichment = await this.isbnGateway.findByIsbn(isbn);
    const merged = {
      title: dto.title ?? enrichment?.title,
      authors: dto.authors?.length ? dto.authors : enrichment?.authors,
      isbn,
    };

    const parsed = parseNewBook(merged);

    const existing = await this.repository.findBookByIsbn(parsed.isbn);
    if (existing) {
      throw new DuplicateIsbnError(parsed.isbn);
    }

    const book: BookDto = {
      bookId: this.newId(),
      title: parsed.title,
      authors: parsed.authors,
      isbn: parsed.isbn,
    };
    await this.repository.saveBook(book);
    return book;
  }

  async updateBook(bookId: BookId, dto: UpdateBookDto): Promise<BookDto> {
    const parsed = parseUpdateBook(dto);
    const existing = await this.repository.findBookById(bookId);
    if (!existing) {
      throw new BookNotFoundError(bookId);
    }
    const updated: BookDto = {
      ...existing,
      ...(parsed.title !== undefined ? { title: parsed.title } : {}),
      ...(parsed.authors !== undefined ? { authors: parsed.authors } : {}),
    };
    await this.repository.saveBook(updated);
    await this.cache.set(existing.isbn, updated);
    return updated;
  }

  async deleteBook(bookId: BookId): Promise<void> {
    const existing = await this.repository.findBookById(bookId);
    if (!existing) {
      throw new BookNotFoundError(bookId);
    }
    await this.repository.deleteBook(bookId);
    await this.cache.evict(existing.isbn);
  }

  async findBook(isbn: Isbn): Promise<BookDto> {
    const cached = await this.cache.get(isbn);
    if (cached) return cached;
    const book = await this.repository.findBookByIsbn(isbn);
    if (!book) {
      throw new BookNotFoundError(isbn);
    }
    await this.cache.set(isbn, book);
    return book;
  }

  listBooks(): Promise<BookDto[]> {
    return this.repository.listBooks();
  }

  async getBooks(bookIds: BookId[]): Promise<BookDto[]> {
    if (bookIds.length === 0) return [];
    return this.repository.listBooksByIds(bookIds);
  }

  async registerCopy(bookId: BookId, dto: NewCopyDto): Promise<CopyDto> {
    const { condition } = parseNewCopy(dto);

    const book = await this.repository.findBookById(bookId);
    if (!book) {
      throw new BookNotFoundError(bookId);
    }

    const copy: CopyDto = {
      copyId: this.newId(),
      bookId,
      condition,
      status: CopyStatus.AVAILABLE,
    };
    await this.repository.saveCopy(copy);
    return copy;
  }

  async findCopy(copyId: CopyId): Promise<CopyDto> {
    const copy = await this.repository.findCopyById(copyId);
    if (!copy) {
      throw new CopyNotFoundError(copyId);
    }
    return copy;
  }

  markCopyAvailable(copyId: CopyId): Promise<CopyDto> {
    return this.updateCopyStatus(copyId, CopyStatus.AVAILABLE);
  }

  markCopyUnavailable(copyId: CopyId): Promise<CopyDto> {
    return this.updateCopyStatus(copyId, CopyStatus.UNAVAILABLE);
  }

  private async updateCopyStatus(copyId: CopyId, status: CopyStatus): Promise<CopyDto> {
    const copy = await this.repository.findCopyById(copyId);
    if (!copy) {
      throw new CopyNotFoundError(copyId);
    }

    const updated: CopyDto = { ...copy, status };
    await this.repository.saveCopy(updated);
    return updated;
  }
}
