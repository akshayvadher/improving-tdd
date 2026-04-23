import { randomUUID } from 'node:crypto';

import { CategoriesFacade } from './categories.facade.js';
import type { CategoryRepository } from './category.repository.js';
import { InMemoryCategoryRepository } from './in-memory-category.repository.js';

export interface CategoriesOverrides {
  repository?: CategoryRepository;
  newId?: () => string;
  clock?: () => Date;
}

export function createCategoriesFacade(overrides: CategoriesOverrides = {}): CategoriesFacade {
  const repository = overrides.repository ?? new InMemoryCategoryRepository();
  const newId = overrides.newId ?? randomUUID;
  const clock = overrides.clock ?? (() => new Date());
  return new CategoriesFacade(repository, newId, clock);
}
