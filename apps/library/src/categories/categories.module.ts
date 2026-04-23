import { Module } from '@nestjs/common';

import type { AppDatabase } from '../db/client.js';
import { DATABASE, DatabaseModule } from '../db/database.module.js';
import { CategoriesController } from './categories.controller.js';
import { CategoriesFacade } from './categories.facade.js';
import type { CategoryRepository } from './category.repository.js';
import { DrizzleCategoryRepository } from './drizzle-category.repository.js';

const CATEGORY_REPOSITORY = Symbol('CategoryRepository');

@Module({
  imports: [DatabaseModule],
  controllers: [CategoriesController],
  providers: [
    {
      provide: CATEGORY_REPOSITORY,
      useFactory: (db: AppDatabase) => new DrizzleCategoryRepository(db),
      inject: [DATABASE],
    },
    {
      provide: CategoriesFacade,
      useFactory: (repository: CategoryRepository) => new CategoriesFacade(repository),
      inject: [CATEGORY_REPOSITORY],
    },
  ],
  exports: [CategoriesFacade],
})
export class CategoriesModule {}
