import { CatalogFacade } from './catalog.facade.js';
import type { CatalogRepository } from './catalog.repository.js';
import { InMemoryCatalogRepository } from './in-memory-catalog.repository.js';

export interface CatalogOverrides {
  repository?: CatalogRepository;
  newId?: () => string;
}

export function createCatalogFacade(overrides: CatalogOverrides = {}): CatalogFacade {
  const repository = overrides.repository ?? new InMemoryCatalogRepository();
  const newId = overrides.newId;
  return newId ? new CatalogFacade(repository, newId) : new CatalogFacade(repository);
}
