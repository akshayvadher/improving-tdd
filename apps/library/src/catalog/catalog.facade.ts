import { Injectable } from '@nestjs/common';
import { randomUUID } from 'node:crypto';

import type { CatalogRepository } from './catalog.repository.js';
import {
  BookNotFoundError,
  CopyNotFoundError,
  CopyStatus,
  DuplicateIsbnError,
  InvalidBookError,
  InvalidCopyError,
  type BookDto,
  type BookId,
  type CopyCondition,
  type CopyDto,
  type CopyId,
  type Isbn,
  type NewBookDto,
  type NewCopyDto,
} from './catalog.types.js';

type IdGenerator = () => string;

// ISBN-10 (9 digits + digit-or-X) OR ISBN-13 (13 digits), with optional
// hyphens or spaces allowed anywhere. Not a checksum check — that belongs
// in a richer validator if the business ever needs it.
const VALID_CONDITIONS: ReadonlySet<CopyCondition> = new Set(['NEW', 'GOOD', 'FAIR', 'POOR']);

function normalizeIsbn(raw: string): string {
  return raw.replace(/[\s-]/g, '');
}

function isValidIsbn(raw: string): boolean {
  const normalized = normalizeIsbn(raw);
  return /^\d{9}[\dX]$/.test(normalized) || /^\d{13}$/.test(normalized);
}

@Injectable()
export class CatalogFacade {
  constructor(
    private readonly repository: CatalogRepository,
    private readonly newId: IdGenerator = randomUUID,
  ) {}

  async addBook(dto: NewBookDto): Promise<BookDto> {
    const title = dto.title?.trim() ?? '';
    if (title.length === 0) {
      throw new InvalidBookError('title is required');
    }

    const authors = (dto.authors ?? []).map((author) => author?.trim() ?? '').filter((author) => author.length > 0);
    if (authors.length === 0) {
      throw new InvalidBookError('at least one author is required');
    }

    const isbn = dto.isbn?.trim() ?? '';
    if (isbn.length === 0) {
      throw new InvalidBookError('isbn is required');
    }
    if (!isValidIsbn(isbn)) {
      throw new InvalidBookError(`isbn format is invalid: ${isbn}`);
    }

    const existing = await this.repository.findBookByIsbn(isbn);
    if (existing) {
      throw new DuplicateIsbnError(isbn);
    }

    const book: BookDto = {
      bookId: this.newId(),
      title,
      authors,
      isbn,
    };
    await this.repository.saveBook(book);
    return book;
  }

  async findBook(isbn: Isbn): Promise<BookDto> {
    const book = await this.repository.findBookByIsbn(isbn);
    if (!book) {
      throw new BookNotFoundError(isbn);
    }
    return book;
  }

  listBooks(): Promise<BookDto[]> {
    return this.repository.listBooks();
  }

  async registerCopy(bookId: BookId, dto: NewCopyDto): Promise<CopyDto> {
    if (!dto.condition || !VALID_CONDITIONS.has(dto.condition)) {
      throw new InvalidCopyError(
        `condition must be one of NEW, GOOD, FAIR, POOR (got: ${String(dto.condition)})`,
      );
    }

    const book = await this.repository.findBookById(bookId);
    if (!book) {
      throw new BookNotFoundError(bookId);
    }

    const copy: CopyDto = {
      copyId: this.newId(),
      bookId,
      condition: dto.condition,
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
