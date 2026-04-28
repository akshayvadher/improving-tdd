export type BookId = string;
export type CopyId = string;
export type Isbn = string;

export type CopyStatus = 'AVAILABLE' | 'UNAVAILABLE';

export const CopyStatus = {
  AVAILABLE: 'AVAILABLE',
  UNAVAILABLE: 'UNAVAILABLE',
} as const satisfies Record<string, CopyStatus>;

export type CopyCondition = 'NEW' | 'GOOD' | 'FAIR' | 'POOR';

export interface NewBookDto {
  title?: string;
  authors?: string[];
  isbn: Isbn;
}

export interface UpdateBookDto {
  title?: string;
  authors?: string[];
}

export interface BookDto {
  bookId: BookId;
  title: string;
  authors: string[];
  isbn: Isbn;
}

export interface NewCopyDto {
  bookId: BookId;
  condition: CopyCondition;
}

export interface CopyDto {
  copyId: CopyId;
  bookId: BookId;
  condition: CopyCondition;
  status: CopyStatus;
}

export class BookNotFoundError extends Error {
  constructor(identifier: string) {
    super(`Book not found: ${identifier}`);
    this.name = 'BookNotFoundError';
  }
}

export class CopyNotFoundError extends Error {
  constructor(copyId: CopyId) {
    super(`Copy not found: ${copyId}`);
    this.name = 'CopyNotFoundError';
  }
}

export class DuplicateIsbnError extends Error {
  constructor(isbn: Isbn) {
    super(`A book with ISBN ${isbn} already exists`);
    this.name = 'DuplicateIsbnError';
  }
}

export class InvalidBookError extends Error {
  readonly reason: string;

  constructor(reason: string) {
    super(`Invalid book: ${reason}`);
    this.name = 'InvalidBookError';
    this.reason = reason;
  }
}

export class InvalidCopyError extends Error {
  readonly reason: string;

  constructor(reason: string) {
    super(`Invalid copy: ${reason}`);
    this.name = 'InvalidCopyError';
    this.reason = reason;
  }
}
