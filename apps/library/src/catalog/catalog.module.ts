import { Module } from '@nestjs/common';
import { Redis } from 'ioredis';
import { randomUUID } from 'node:crypto';

import { DATABASE, DatabaseModule } from '../db/database.module.js';
import type { AppDatabase } from '../db/client.js';
import { InMemoryBookCacheGateway } from '../shared/book-cache-gateway/in-memory-book-cache-gateway.js';
import { RedisBookCacheGateway } from '../shared/book-cache-gateway/redis-book-cache-gateway.js';
import type { BookCacheGateway } from '../shared/book-cache-gateway/book-cache-gateway.js';
import { InMemoryIsbnLookupGateway } from '../shared/isbn-gateway/in-memory-isbn-lookup-gateway.js';
import type { IsbnLookupGateway } from '../shared/isbn-gateway/isbn-lookup-gateway.js';
import { CatalogController } from './catalog.controller.js';
import { CatalogFacade } from './catalog.facade.js';
import { DrizzleCatalogRepository } from './drizzle-catalog.repository.js';

const CATALOG_REPOSITORY = Symbol('CatalogRepository');
const ISBN_LOOKUP_GATEWAY = Symbol('IsbnLookupGateway');
const BOOK_CACHE_GATEWAY = Symbol('BookCacheGateway');

@Module({
  imports: [DatabaseModule],
  controllers: [CatalogController],
  providers: [
    {
      provide: CATALOG_REPOSITORY,
      useFactory: (db: AppDatabase) => new DrizzleCatalogRepository(db),
      inject: [DATABASE],
    },
    {
      provide: ISBN_LOOKUP_GATEWAY,
      useClass: InMemoryIsbnLookupGateway,
    },
    {
      provide: BOOK_CACHE_GATEWAY,
      useFactory: (): BookCacheGateway => {
        const url = process.env.REDIS_URL;
        if (!url) return new InMemoryBookCacheGateway();
        return new RedisBookCacheGateway(new Redis(url));
      },
    },
    {
      provide: CatalogFacade,
      useFactory: (
        repository: DrizzleCatalogRepository,
        gateway: IsbnLookupGateway,
        cache: BookCacheGateway,
      ) => new CatalogFacade(repository, randomUUID, gateway, cache),
      inject: [CATALOG_REPOSITORY, ISBN_LOOKUP_GATEWAY, BOOK_CACHE_GATEWAY],
    },
  ],
  exports: [CatalogFacade],
})
export class CatalogModule {}
