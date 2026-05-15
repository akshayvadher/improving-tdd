import { randomUUID } from 'node:crypto';

import { AccessControlFacade } from '../access-control/access-control.facade.js';
import { createAccessControlFacade } from '../access-control/access-control.configuration.js';
import { InMemoryBookCacheGateway } from '../shared/book-cache-gateway/in-memory-book-cache-gateway.js';
import type { BookCacheGateway } from '../shared/book-cache-gateway/book-cache-gateway.js';
import { InMemoryFileStorageGateway } from '../shared/file-storage-gateway/in-memory-file-storage-gateway.js';
import type { FileStorageGateway } from '../shared/file-storage-gateway/file-storage-gateway.js';
import { InMemoryIsbnLookupGateway } from '../shared/isbn-gateway/in-memory-isbn-lookup-gateway.js';
import type { IsbnLookupGateway } from '../shared/isbn-gateway/isbn-lookup-gateway.js';
import { CatalogFacade } from './catalog.facade.js';
import type { CatalogRepository } from './catalog.repository.js';
import { InMemoryCatalogRepository } from './in-memory-catalog.repository.js';

export interface CatalogOverrides {
  repository?: CatalogRepository;
  newId?: () => string;
  isbnLookupGateway?: IsbnLookupGateway;
  bookCacheGateway?: BookCacheGateway;
  fileStorageGateway?: FileStorageGateway;
  accessControl?: AccessControlFacade;
}

export function createCatalogFacade(overrides: CatalogOverrides = {}): CatalogFacade {
  const repository = overrides.repository ?? new InMemoryCatalogRepository();
  const newId = overrides.newId ?? randomUUID;
  const isbnLookupGateway = overrides.isbnLookupGateway ?? new InMemoryIsbnLookupGateway();
  const bookCacheGateway = overrides.bookCacheGateway ?? new InMemoryBookCacheGateway();
  const fileStorageGateway = overrides.fileStorageGateway ?? new InMemoryFileStorageGateway();
  const accessControl = overrides.accessControl ?? createAccessControlFacade();
  return new CatalogFacade(
    repository,
    newId,
    isbnLookupGateway,
    bookCacheGateway,
    accessControl,
    fileStorageGateway,
  );
}
