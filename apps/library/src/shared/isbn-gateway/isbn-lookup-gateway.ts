import type { BookMetadata } from './book-metadata.js';

export interface IsbnLookupGateway {
  findByIsbn(isbn: string): Promise<BookMetadata | null>;
}
