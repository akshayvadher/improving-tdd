import { Injectable } from '@nestjs/common';
import { randomUUID } from 'node:crypto';

import type { CatalogRepository } from './catalog.repository.js';
import { parseNewBook, parseNewCopy } from './catalog.schema.js';
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
} from './catalog.types.js';

type IdGenerator = () => string;

@Injectable()
export class CatalogFacade {
  constructor(
    private readonly repository: CatalogRepository,
    private readonly newId: IdGenerator = randomUUID,
  ) {}

  async addBook(dto: NewBookDto): Promise<BookDto> {
    const { title, authors, isbn } = parseNewBook(dto);

    const existing = await this.repository.findBookByIsbn(isbn);
    if (existing) {
      throw new DuplicateIsbnError(isbn);
    }

    const book: BookDto = { bookId: this.newId(), title, authors, isbn };
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
