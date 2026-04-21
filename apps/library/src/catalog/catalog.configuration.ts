import { randomUUID } from 'node:crypto';

import { InMemoryIsbnLookupGateway } from '../shared/isbn-gateway/in-memory-isbn-lookup-gateway.js';
import type { IsbnLookupGateway } from '../shared/isbn-gateway/isbn-lookup-gateway.js';
import { CatalogFacade } from './catalog.facade.js';
import type { CatalogRepository } from './catalog.repository.js';
import { InMemoryCatalogRepository } from './in-memory-catalog.repository.js';

export interface CatalogOverrides {
  repository?: CatalogRepository;
  newId?: () => string;
  isbnLookupGateway?: IsbnLookupGateway;
}

export function createCatalogFacade(overrides: CatalogOverrides = {}): CatalogFacade {
  const repository = overrides.repository ?? new InMemoryCatalogRepository();
  const newId = overrides.newId ?? randomUUID;
  const isbnLookupGateway = overrides.isbnLookupGateway ?? new InMemoryIsbnLookupGateway();
  return new CatalogFacade(repository, newId, isbnLookupGateway);
}
