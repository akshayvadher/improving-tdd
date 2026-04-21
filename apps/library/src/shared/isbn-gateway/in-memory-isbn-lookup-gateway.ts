import type { BookMetadata } from './book-metadata.js';
import type { IsbnLookupGateway } from './isbn-lookup-gateway.js';

export class InMemoryIsbnLookupGateway implements IsbnLookupGateway {
  private readonly entries = new Map<string, BookMetadata>();

  seed(isbn: string, metadata: BookMetadata): void {
    this.entries.set(isbn, metadata);
  }

  async findByIsbn(isbn: string): Promise<BookMetadata | null> {
    return this.entries.get(isbn) ?? null;
  }
}
