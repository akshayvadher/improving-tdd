import type { CopyCondition, Isbn, NewBookDto, NewCopyDto } from './catalog.types.js';

export function sampleNewBook(overrides: Partial<NewBookDto> = {}): NewBookDto {
  return {
    title: 'The Pragmatic Programmer',
    authors: ['Andrew Hunt', 'David Thomas'],
    isbn: '978-0135957059',
    ...overrides,
  };
}

export function sampleNewBookWithIsbn(isbn: Isbn): NewBookDto {
  return sampleNewBook({ isbn });
}

export function sampleNewCopy(overrides: Partial<NewCopyDto> = {}): NewCopyDto {
  return {
    bookId: 'book-placeholder-id',
    condition: 'GOOD' satisfies CopyCondition,
    ...overrides,
  };
}
