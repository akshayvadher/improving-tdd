import { Module } from '@nestjs/common';

import { DATABASE, DatabaseModule } from '../db/database.module.js';
import type { AppDatabase } from '../db/client.js';
import { CatalogController } from './catalog.controller.js';
import { CatalogFacade } from './catalog.facade.js';
import { DrizzleCatalogRepository } from './drizzle-catalog.repository.js';

const CATALOG_REPOSITORY = Symbol('CatalogRepository');

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
      provide: CatalogFacade,
      useFactory: (repository: DrizzleCatalogRepository) => new CatalogFacade(repository),
      inject: [CATALOG_REPOSITORY],
    },
  ],
  exports: [CatalogFacade],
})
export class CatalogModule {}
