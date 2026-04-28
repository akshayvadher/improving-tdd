import type { OnModuleDestroy } from '@nestjs/common';
import type { Redis } from 'ioredis';

import type { BookDto, Isbn } from '../../catalog/catalog.types.js';
import type { BookCacheGateway } from './book-cache-gateway.js';

// JSON serialization is the Redis adapter's I/O detail; the port stays on `BookDto`.
// `onModuleDestroy` quits the client when Nest tears down the app.
export class RedisBookCacheGateway implements BookCacheGateway, OnModuleDestroy {
  constructor(private readonly client: Redis) {}

  async get(isbn: Isbn): Promise<BookDto | null> {
    const raw = await this.client.get(this.key(isbn));
    if (raw === null) return null;
    return JSON.parse(raw) as BookDto;
  }

  async set(isbn: Isbn, book: BookDto): Promise<void> {
    await this.client.set(this.key(isbn), JSON.stringify(book));
  }

  async evict(isbn: Isbn): Promise<void> {
    await this.client.del(this.key(isbn));
  }

  async onModuleDestroy(): Promise<void> {
    await this.client.quit();
  }

  private key(isbn: Isbn): string {
    return `catalog:book:isbn:${isbn}`;
  }
}
