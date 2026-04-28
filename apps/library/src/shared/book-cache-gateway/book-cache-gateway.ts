import type { BookDto, Isbn } from '../../catalog/catalog.types.js';

export interface BookCacheGateway {
  get(isbn: Isbn): Promise<BookDto | null>;
  set(isbn: Isbn, book: BookDto): Promise<void>;
  evict(isbn: Isbn): Promise<void>;
}
