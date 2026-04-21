import { Module } from '@nestjs/common';
import { randomUUID } from 'node:crypto';

import { DATABASE, DatabaseModule } from '../db/database.module.js';
import type { AppDatabase } from '../db/client.js';
import { InMemoryIsbnLookupGateway } from '../shared/isbn-gateway/in-memory-isbn-lookup-gateway.js';
import type { IsbnLookupGateway } from '../shared/isbn-gateway/isbn-lookup-gateway.js';
import { CatalogController } from './catalog.controller.js';
import { CatalogFacade } from './catalog.facade.js';
import { DrizzleCatalogRepository } from './drizzle-catalog.repository.js';

const CATALOG_REPOSITORY = Symbol('CatalogRepository');
const ISBN_LOOKUP_GATEWAY = Symbol('IsbnLookupGateway');

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
      provide: CatalogFacade,
      useFactory: (repository: DrizzleCatalogRepository, gateway: IsbnLookupGateway) =>
        new CatalogFacade(repository, randomUUID, gateway),
      inject: [CATALOG_REPOSITORY, ISBN_LOOKUP_GATEWAY],
    },
  ],
  exports: [CatalogFacade],
})
export class CatalogModule {}
