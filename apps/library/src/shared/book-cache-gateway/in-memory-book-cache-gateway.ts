import type { BookDto, Isbn } from '../../catalog/catalog.types.js';
import type { BookCacheGateway } from './book-cache-gateway.js';

export class InMemoryBookCacheGateway implements BookCacheGateway {
  private readonly entries = new Map<Isbn, BookDto>();

  async get(isbn: Isbn): Promise<BookDto | null> {
    return this.entries.get(isbn) ?? null;
  }

  async set(isbn: Isbn, book: BookDto): Promise<void> {
    this.entries.set(isbn, book);
  }

  async evict(isbn: Isbn): Promise<void> {
    this.entries.delete(isbn);
  }
}
