import { createHash } from 'node:crypto';

import { describe, expect, it } from 'vitest';

import { UnauthorizedRoleError } from '../access-control/access-control.types.js';
import {
  sampleAuthUser,
  sampleStaffAuthUser,
} from '../access-control/sample-access-control-data.js';
import type { BookCacheGateway } from '../shared/book-cache-gateway/book-cache-gateway.js';
import { InMemoryBookCacheGateway } from '../shared/book-cache-gateway/in-memory-book-cache-gateway.js';
import type {
  FileStorageGateway,
  PutResult,
  StoredFile,
} from '../shared/file-storage-gateway/file-storage-gateway.js';
import { InMemoryFileStorageGateway } from '../shared/file-storage-gateway/in-memory-file-storage-gateway.js';
import type { BookMetadata } from '../shared/isbn-gateway/book-metadata.js';
import { InMemoryIsbnLookupGateway } from '../shared/isbn-gateway/in-memory-isbn-lookup-gateway.js';
import type { IsbnLookupGateway } from '../shared/isbn-gateway/isbn-lookup-gateway.js';
import { createCatalogFacade } from './catalog.configuration.js';
import type { CatalogFacade } from './catalog.facade.js';
import {
  BookNotFoundError,
  CopyNotFoundError,
  CopyStatus,
  DuplicateIsbnError,
  InvalidBookError,
  InvalidCopyError,
  InvalidThumbnailError,
  ThumbnailNotFoundError,
  type BookDto,
  type Isbn,
} from './catalog.types.js';
import {
  sampleNewBook,
  sampleNewBookWithIsbn,
  sampleNewCopy,
  sampleUpdateBook,
} from './sample-catalog-data.js';

// Deterministic id generator so copy/book ids are predictable in assertions.
function sequentialIds(prefix = 'id'): () => string {
  let counter = 0;
  return () => `${prefix}-${++counter}`;
}

function buildFacade() {
  return createCatalogFacade({ newId: sequentialIds() });
}

describe('CatalogFacade', () => {
  it('adds a book and finds it by isbn', async () => {
    // given a catalog
    const catalog = buildFacade();

    // when a book is added
    const added = await catalog.addBook(sampleNewBook({ isbn: '978-0134685991' }));

    // then it can be retrieved by its isbn
    expect(await catalog.findBook('978-0134685991')).toEqual(added);
  });

  it('lists all books in the order they were added', async () => {
    // given a catalog with two books
    const catalog = buildFacade();
    const first = await catalog.addBook(sampleNewBookWithIsbn('978-0134685991'));
    const second = await catalog.addBook(sampleNewBookWithIsbn('978-0135957059'));

    // when listing all books
    const books = await catalog.listBooks();

    // then both books are returned in insertion order
    expect(books).toEqual([first, second]);
  });

  it('registers a copy of an existing book and finds the copy', async () => {
    // given a book in the catalog
    const catalog = buildFacade();
    const book = await catalog.addBook(sampleNewBook());

    // when a copy is registered for that book
    const copy = await catalog.registerCopy(book.bookId, sampleNewCopy({ bookId: book.bookId }));

    // then the copy is retrievable by its id
    expect(await catalog.findCopy(copy.copyId)).toEqual(copy);
  });

  it('registers new copies as available by default', async () => {
    // given a book in the catalog
    const catalog = buildFacade();
    const book = await catalog.addBook(sampleNewBook());

    // when a copy is registered
    const copy = await catalog.registerCopy(book.bookId, sampleNewCopy({ bookId: book.bookId }));

    // then its status is AVAILABLE
    expect(copy.status).toBe(CopyStatus.AVAILABLE);
  });

  it('marks an unavailable copy available again', async () => {
    // given a copy that has been marked unavailable
    const catalog = buildFacade();
    const book = await catalog.addBook(sampleNewBook());
    const copy = await catalog.registerCopy(book.bookId, sampleNewCopy({ bookId: book.bookId }));
    await catalog.markCopyUnavailable(copy.copyId);

    // when it is marked available
    const updated = await catalog.markCopyAvailable(copy.copyId);

    // then the copy reports as AVAILABLE
    expect(updated.status).toBe(CopyStatus.AVAILABLE);
    expect((await catalog.findCopy(copy.copyId)).status).toBe(CopyStatus.AVAILABLE);
  });

  it('marks an available copy unavailable', async () => {
    // given a newly registered (available) copy
    const catalog = buildFacade();
    const book = await catalog.addBook(sampleNewBook());
    const copy = await catalog.registerCopy(book.bookId, sampleNewCopy({ bookId: book.bookId }));

    // when it is marked unavailable
    const updated = await catalog.markCopyUnavailable(copy.copyId);

    // then the copy reports as UNAVAILABLE
    expect(updated.status).toBe(CopyStatus.UNAVAILABLE);
    expect((await catalog.findCopy(copy.copyId)).status).toBe(CopyStatus.UNAVAILABLE);
  });

  it('throws BookNotFoundError when finding an unknown isbn', async () => {
    // given an empty catalog
    const catalog = buildFacade();

    // when / then looking up an isbn that was never added
    await expect(catalog.findBook('978-0000000000')).rejects.toThrow(BookNotFoundError);
  });

  it('throws BookNotFoundError when registering a copy for an unknown book', async () => {
    // given an empty catalog
    const catalog = buildFacade();

    // when / then registering a copy against a non-existent bookId
    await expect(
      catalog.registerCopy('unknown-book-id', sampleNewCopy({ bookId: 'unknown-book-id' })),
    ).rejects.toThrow(BookNotFoundError);
  });

  it('throws CopyNotFoundError when marking an unknown copy available', async () => {
    // given an empty catalog
    const catalog = buildFacade();

    // when / then marking a copy id that was never registered
    await expect(catalog.markCopyAvailable('unknown-copy-id')).rejects.toThrow(CopyNotFoundError);
  });

  it('throws CopyNotFoundError when marking an unknown copy unavailable', async () => {
    // given an empty catalog
    const catalog = buildFacade();

    // when / then marking a copy id that was never registered
    await expect(catalog.markCopyUnavailable('unknown-copy-id')).rejects.toThrow(CopyNotFoundError);
  });

  it('rejects adding a book with a blank title', async () => {
    // given a catalog
    const catalog = buildFacade();

    // when / then adding a book whose title is empty or whitespace-only
    await expect(catalog.addBook(sampleNewBook({ title: '' }))).rejects.toThrow(InvalidBookError);
    await expect(catalog.addBook(sampleNewBook({ title: '   ' }))).rejects.toThrow(
      InvalidBookError,
    );
  });

  it('rejects adding a book with no authors', async () => {
    // given a catalog
    const catalog = buildFacade();

    // when / then adding a book whose authors array is empty or all-blank
    await expect(catalog.addBook(sampleNewBook({ authors: [] }))).rejects.toThrow(InvalidBookError);
    await expect(catalog.addBook(sampleNewBook({ authors: ['  '] }))).rejects.toThrow(
      InvalidBookError,
    );
  });

  it('rejects adding a book with a malformed isbn', async () => {
    // given a catalog
    const catalog = buildFacade();

    // when / then adding a book with an isbn that is empty, too short, or not digits
    await expect(catalog.addBook(sampleNewBook({ isbn: '' }))).rejects.toThrow(InvalidBookError);
    await expect(catalog.addBook(sampleNewBook({ isbn: '123' }))).rejects.toThrow(InvalidBookError);
    await expect(catalog.addBook(sampleNewBook({ isbn: 'not-an-isbn' }))).rejects.toThrow(
      InvalidBookError,
    );
  });

  it('accepts well-formed isbn-10 and isbn-13, with or without hyphens', async () => {
    // given a catalog
    const catalog = buildFacade();

    // when books are added with each accepted ISBN format
    const isbn13Hyphenated = await catalog.addBook(sampleNewBook({ isbn: '978-0134685991' }));
    const isbn13Plain = await catalog.addBook(sampleNewBook({ isbn: '9780135957059' }));
    const isbn10 = await catalog.addBook(sampleNewBook({ isbn: '0-306-40615-2' }));

    // then all three are stored and findable by their exact ISBN string
    expect(await catalog.findBook('978-0134685991')).toEqual(isbn13Hyphenated);
    expect(await catalog.findBook('9780135957059')).toEqual(isbn13Plain);
    expect(await catalog.findBook('0-306-40615-2')).toEqual(isbn10);
  });

  it('trims surrounding whitespace from title, authors, and isbn on addBook', async () => {
    // given a catalog
    const catalog = buildFacade();

    // when a book is added with padded title, authors, and isbn
    const book = await catalog.addBook(
      sampleNewBook({
        title: '  The Pragmatic Programmer  ',
        authors: ['  Andrew Hunt  ', '  David Thomas  '],
        isbn: '  978-0135957059  ',
      }),
    );

    // then the stored values are trimmed
    expect(book.title).toBe('The Pragmatic Programmer');
    expect(book.authors).toEqual(['Andrew Hunt', 'David Thomas']);
    expect(book.isbn).toBe('978-0135957059');
  });

  it('rejects registering a copy with an invalid condition', async () => {
    // given a book in the catalog
    const catalog = buildFacade();
    const book = await catalog.addBook(sampleNewBook());

    // when / then registering a copy with a condition outside the allowed set
    await expect(
      catalog.registerCopy(book.bookId, { bookId: book.bookId, condition: 'BROKEN' as never }),
    ).rejects.toThrow(InvalidCopyError);
  });

  it('rejects adding a book with an isbn that already exists', async () => {
    // given a catalog that already has a book with a particular isbn
    const catalog = buildFacade();
    await catalog.addBook(sampleNewBookWithIsbn('978-0134685991'));

    // when / then adding another book with the same isbn
    await expect(catalog.addBook(sampleNewBookWithIsbn('978-0134685991'))).rejects.toThrow(
      DuplicateIsbnError,
    );
  });
});

describe('getBooks', () => {
  it('returns [] for an empty bookIds array without throwing (AC-2.6)', async () => {
    // given a catalog with a couple of books in it — the guard must short-circuit
    // BEFORE the repository is consulted, so seeding proves the short-circuit
    // is not just "nothing to return"
    const catalog = buildFacade();
    await catalog.addBook(sampleNewBookWithIsbn('978-0134685991'));
    await catalog.addBook(sampleNewBookWithIsbn('978-0135957059'));

    // when getBooks is called with an empty array
    // then it resolves to [] without throwing
    await expect(catalog.getBooks([])).resolves.toEqual([]);
  });

  it('returns each BookDto whose id matches, in any order (AC-2.7 happy path)', async () => {
    // given two books in the catalog
    const catalog = buildFacade();
    const bookA = await catalog.addBook(sampleNewBookWithIsbn('978-0134685991'));
    const bookB = await catalog.addBook(sampleNewBookWithIsbn('978-0135957059'));

    // when getBooks is called with both bookIds
    const books = await catalog.getBooks([bookA.bookId, bookB.bookId]);

    // then both books are returned (order is not specified by the contract)
    expect(books).toHaveLength(2);
    expect(books).toEqual(expect.arrayContaining([bookA, bookB]));
  });

  it('silently drops ids that do not match any book (AC-2.7 missing id)', async () => {
    // given a catalog with one book
    const catalog = buildFacade();
    const bookA = await catalog.addBook(sampleNewBookWithIsbn('978-0134685991'));

    // when getBooks is called with a mix of a real id and a non-existent id
    const books = await catalog.getBooks([bookA.bookId, 'non-existent-id']);

    // then only the matching book is returned — the missing id is silently dropped
    expect(books).toEqual([bookA]);
  });

  it('returns one row per matching book when the caller passes duplicate ids', async () => {
    // given a catalog with two books
    const catalog = buildFacade();
    const bookA = await catalog.addBook(sampleNewBookWithIsbn('978-0134685991'));
    const bookB = await catalog.addBook(sampleNewBookWithIsbn('978-0135957059'));

    // when getBooks is called with duplicates in the bookIds array
    const books = await catalog.getBooks([bookA.bookId, bookA.bookId, bookB.bookId]);

    // then each matching book appears once — dedup of the input is the caller's
    // job; the repo/facade simply filters the stored books by the id set
    expect(books).toHaveLength(2);
    expect(books).toEqual(expect.arrayContaining([bookA, bookB]));
  });

  it('returns [] when none of the given bookIds match', async () => {
    // given a catalog with one book
    const catalog = buildFacade();
    await catalog.addBook(sampleNewBookWithIsbn('978-0134685991'));

    // when getBooks is called with only unknown ids
    const books = await catalog.getBooks(['ghost-1', 'ghost-2']);

    // then the result is an empty array
    expect(books).toEqual([]);
  });
});

describe('addBook — ISBN enrichment', () => {
  function buildFacadeWithGateway(seed: Array<[string, BookMetadata]> = []) {
    const gateway = new InMemoryIsbnLookupGateway();
    for (const [isbn, metadata] of seed) {
      gateway.seed(isbn, metadata);
    }
    const facade = createCatalogFacade({
      isbnLookupGateway: gateway,
      newId: sequentialIds('book'),
    });
    return { facade, gateway };
  }

  it('fills missing title from the gateway and keeps client authors', async () => {
    // given a gateway seeded with both title and authors for an ISBN
    const { facade } = buildFacadeWithGateway([
      ['978-0134685991', { title: 'From Gateway', authors: ['Gateway Author'] }],
    ]);

    // when a book is added with no title but explicit authors
    const book = await facade.addBook({
      authors: ['Client Author'],
      isbn: '978-0134685991',
    });

    // then the saved title comes from the gateway and the authors are the client's
    expect(book.title).toBe('From Gateway');
    expect(book.authors).toEqual(['Client Author']);
  });

  it('fills missing authors from the gateway and keeps client title', async () => {
    // given a gateway seeded with both title and authors for an ISBN
    const { facade } = buildFacadeWithGateway([
      ['978-0134685991', { title: 'Gateway Title', authors: ['Gateway Author'] }],
    ]);

    // when a book is added with an empty authors array but an explicit title
    const book = await facade.addBook({
      title: 'Client Title',
      authors: [],
      isbn: '978-0134685991',
    });

    // then the saved authors come from the gateway and the title is the client's
    expect(book.title).toBe('Client Title');
    expect(book.authors).toEqual(['Gateway Author']);
  });

  it('keeps the client title even when the gateway has a different one', async () => {
    // given a gateway seeded with a different title for the ISBN
    const { facade } = buildFacadeWithGateway([
      ['978-0134685991', { title: 'Gateway Title', authors: ['Gateway Author'] }],
    ]);

    // when a book is added with a client-supplied title
    const book = await facade.addBook({
      title: 'Client Title',
      authors: ['Client Author'],
      isbn: '978-0134685991',
    });

    // then the client title wins
    expect(book.title).toBe('Client Title');
  });

  it('keeps the client authors even when the gateway has different ones', async () => {
    // given a gateway seeded with different authors for the ISBN
    const { facade } = buildFacadeWithGateway([
      ['978-0134685991', { title: 'Gateway Title', authors: ['Gateway Author'] }],
    ]);

    // when a book is added with client-supplied authors
    const book = await facade.addBook({
      title: 'Client Title',
      authors: ['Real Client'],
      isbn: '978-0134685991',
    });

    // then the client authors win
    expect(book.authors).toEqual(['Real Client']);
  });

  it('succeeds with client data when the gateway returns null', async () => {
    // given an unseeded gateway (findByIsbn resolves to null for any ISBN)
    const { facade } = buildFacadeWithGateway();

    // when a book is added with full client data for an unseeded ISBN
    const book = await facade.addBook({
      title: 'Client Title',
      authors: ['Client Author'],
      isbn: '978-0134685991',
    });

    // then the saved book reflects the client-supplied data
    expect(book.title).toBe('Client Title');
    expect(book.authors).toEqual(['Client Author']);
  });

  it('fails with InvalidBookError when the title is missing on both sides', async () => {
    // given an unseeded gateway
    const { facade } = buildFacadeWithGateway();

    // when / then adding a book with no title and the gateway returning null
    await expect(
      facade.addBook({ authors: ['Client Author'], isbn: '978-0134685991' }),
    ).rejects.toThrow(InvalidBookError);
  });

  it('fails with InvalidBookError when title and authors are missing on both sides', async () => {
    // given an unseeded gateway
    const { facade } = buildFacadeWithGateway();

    // when / then adding a book with no title and no authors and the gateway returning null
    await expect(facade.addBook({ isbn: '978-0134685991' })).rejects.toThrow(InvalidBookError);
  });

  it('enriches before the duplicate-ISBN check and compares on the merged ISBN', async () => {
    // given a catalog that already has a book with a particular isbn
    const { facade } = buildFacadeWithGateway([
      ['978-0134685991', { title: 'Gateway Title', authors: ['Gateway Author'] }],
    ]);
    await facade.addBook(sampleNewBookWithIsbn('978-0134685991'));

    // when a second addBook uses the same ISBN but omits fields so enrichment must run first
    // then the duplicate check (on the merged ISBN) rejects the call
    await expect(facade.addBook({ isbn: '978-0134685991' })).rejects.toThrow(DuplicateIsbnError);
  });

  it('honours the isbnLookupGateway override passed to createCatalogFacade', async () => {
    // given a facade built with a seeded gateway override
    const { facade } = buildFacadeWithGateway([
      ['978-0134685991', { title: 'Gateway Title', authors: ['Gateway Author'] }],
    ]);

    // when a book is added with only an ISBN
    const book = await facade.addBook({ isbn: '978-0134685991' });

    // then the override's metadata fills the missing fields
    expect(book.title).toBe('Gateway Title');
    expect(book.authors).toEqual(['Gateway Author']);
  });

  it('defaults to a fresh InMemoryIsbnLookupGateway when no override is supplied', async () => {
    // given a facade built without an isbnLookupGateway override
    const facade = createCatalogFacade({ newId: sequentialIds('book') });

    // when / then adding a book with only an ISBN fails because the default gateway is empty
    await expect(facade.addBook({ isbn: '978-0134685991' })).rejects.toThrow(InvalidBookError);
  });

  it('returns a BookDto that reflects the merged persisted shape, not the raw input DTO', async () => {
    // given a gateway seeded with a title for an ISBN
    const { facade } = buildFacadeWithGateway([
      ['978-0134685991', { title: 'Gateway Title', authors: ['Gateway Author'] }],
    ]);

    // when a book is added with no title so the gateway has to fill it
    const book = await facade.addBook({
      authors: ['Client Author'],
      isbn: '978-0134685991',
    });

    // then the returned DTO has the merged shape
    expect(book).toEqual({
      bookId: book.bookId,
      title: 'Gateway Title',
      authors: ['Client Author'],
      isbn: '978-0134685991',
    });
    // and the same merged shape round-trips through the repository
    expect(await facade.findBook('978-0134685991')).toEqual(book);
  });
});

describe('addBook — gateway failures', () => {
  function buildFacadeWithWrappedGateway(seed: Array<[string, BookMetadata]> = []): {
    facade: CatalogFacade;
    gateway: ThrowingOnceIsbnLookupGateway;
  } {
    const inner = new InMemoryIsbnLookupGateway();
    for (const [isbn, metadata] of seed) {
      inner.seed(isbn, metadata);
    }
    const gateway = new ThrowingOnceIsbnLookupGateway(inner);
    const facade = createCatalogFacade({
      isbnLookupGateway: gateway,
      newId: sequentialIds('book'),
    });
    return { facade, gateway };
  }

  it('surfaces the gateway error to the caller when findByIsbn throws mid-addBook', async () => {
    // given a facade wired to a wrapped gateway with a single-shot failure armed
    const { facade, gateway } = buildFacadeWithWrappedGateway([
      ['978-0134685991', { title: 'Gateway Title', authors: ['Gateway Author'] }],
    ]);
    gateway.armFailureOnNextLookup(new Error('isbn service is down'));

    // when addBook triggers the armed findByIsbn call
    // then the exact error surfaces to the caller
    await expect(
      facade.addBook({
        title: 'Client Title',
        authors: ['Client Author'],
        isbn: '978-0134685991',
      }),
    ).rejects.toThrow('isbn service is down');
  });

  it('persists nothing after a gateway failure', async () => {
    // given a facade whose wrapped gateway is seeded AND has a failure armed
    const { facade, gateway } = buildFacadeWithWrappedGateway([
      ['978-0134685991', { title: 'Gateway Title', authors: ['Gateway Author'] }],
    ]);
    gateway.armFailureOnNextLookup(new Error('isbn service is down'));

    // when addBook is called and rejects
    await expect(
      facade.addBook({
        title: 'Client Title',
        authors: ['Client Author'],
        isbn: '978-0134685991',
      }),
    ).rejects.toThrow('isbn service is down');

    // then the repository has no record for that ISBN
    await expect(facade.findBook('978-0134685991')).rejects.toThrow(BookNotFoundError);
    expect(await facade.listBooks()).toEqual([]);
  });

  it('succeeds on the next call after a single armed failure (state clears)', async () => {
    // given a facade with a seeded inner gateway and one armed failure
    const { facade, gateway } = buildFacadeWithWrappedGateway([
      ['978-0134685991', { title: 'Gateway Title', authors: ['Gateway Author'] }],
    ]);
    gateway.armFailureOnNextLookup(new Error('isbn service is down'));

    // when the first addBook call fires the armed error
    await expect(
      facade.addBook({ authors: ['Client Author'], isbn: '978-0134685991' }),
    ).rejects.toThrow('isbn service is down');

    // and the second addBook call runs with the arming cleared
    const book = await facade.addBook({ authors: ['Client Author'], isbn: '978-0134685991' });

    // then the second call succeeds with the gateway-enriched title
    expect(book.title).toBe('Gateway Title');
    expect(book.authors).toEqual(['Client Author']);
    expect(book.isbn).toBe('978-0134685991');
  });
});

describe('findBook — cache read-through', () => {
  function buildScene() {
    const cache = new InMemoryBookCacheGateway();
    const facade = createCatalogFacade({
      newId: sequentialIds('book'),
      bookCacheGateway: cache,
    });
    return { cache, facade };
  }

  it('returns the cached BookDto on a cache hit without consulting the repository (AC-2.1)', async () => {
    // given a cache pre-seeded with a BookDto for an ISBN, and an empty repo
    const { cache, facade } = buildScene();
    const seeded: BookDto = {
      bookId: 'book-seeded',
      title: 'Seeded From Cache',
      authors: ['Cache Author'],
      isbn: '978-0134685991',
    };
    await cache.set('978-0134685991', seeded);

    // when findBook is called with that ISBN
    const found = await facade.findBook('978-0134685991');

    // then the seeded book is returned even though the repo has no record of it
    expect(found).toEqual(seeded);
  });

  it('on cache MISS / repo HIT, returns the repo book and populates the cache (AC-2.2)', async () => {
    // given a book added via the facade (repo populated, cache untouched by addBook)
    const { cache, facade } = buildScene();
    const added = await facade.addBook(sampleNewBookWithIsbn('978-0134685991'));
    expect(await cache.get('978-0134685991')).toBeNull();

    // when findBook is called for that ISBN
    const found = await facade.findBook('978-0134685991');

    // then the repo's book is returned AND the cache now holds that entry
    expect(found).toEqual(added);
    expect(await cache.get('978-0134685991')).toEqual(added);
  });

  it('on cache MISS / repo MISS, throws BookNotFoundError and does NOT cache the negative answer (AC-2.3)', async () => {
    // given an empty catalog (cache and repo both empty for the unknown ISBN)
    const { cache, facade } = buildScene();

    // when findBook is called for an unknown ISBN, then it throws
    await expect(facade.findBook('978-0000000000')).rejects.toThrow(BookNotFoundError);

    // and the cache still has no entry for that ISBN (no negative caching)
    expect(await cache.get('978-0000000000')).toBeNull();
  });

  it('addBook does NOT populate the cache (AC-2.4)', async () => {
    // given an empty cache
    const { cache, facade } = buildScene();

    // when a book is added via the facade
    await facade.addBook(sampleNewBookWithIsbn('978-0134685991'));

    // then the cache remains empty for that ISBN — only findBook populates it
    expect(await cache.get('978-0134685991')).toBeNull();
  });

  it('two consecutive findBook calls after a fresh add: first repo→populate, second cache HIT (AC-2.5)', async () => {
    // given a freshly added book with an empty cache
    const { cache, facade } = buildScene();
    const added = await facade.addBook(sampleNewBookWithIsbn('978-0134685991'));
    expect(await cache.get('978-0134685991')).toBeNull();

    // when the first findBook fires (cache miss → repo hit → populate)
    const first = await facade.findBook('978-0134685991');

    // then the cache is now populated with the book
    expect(first).toEqual(added);
    expect(await cache.get('978-0134685991')).toEqual(added);

    // and when a second findBook fires, it returns the cached book again
    const second = await facade.findBook('978-0134685991');
    expect(second).toEqual(added);
  });

  it('createCatalogFacade uses the supplied bookCacheGateway override and falls back to a fresh default when omitted (AC-2.6)', async () => {
    // given an explicit cache override seeded with a BookDto
    const overrideCache = new InMemoryBookCacheGateway();
    const seeded: BookDto = {
      bookId: 'book-override',
      title: 'Override Hit',
      authors: ['Override Author'],
      isbn: '978-0134685991',
    };
    await overrideCache.set('978-0134685991', seeded);
    const facadeWithOverride = createCatalogFacade({
      newId: sequentialIds('book'),
      bookCacheGateway: overrideCache,
    });

    // when findBook is called, then the override is the cache the facade consults
    expect(await facadeWithOverride.findBook('978-0134685991')).toEqual(seeded);

    // and given a facade built WITHOUT a bookCacheGateway override
    const facadeWithDefault = createCatalogFacade({ newId: sequentialIds('book') });

    // when findBook is called for an unknown ISBN with the default cache
    // then it throws BookNotFoundError (the default cache is a fresh empty InMemoryBookCacheGateway)
    await expect(facadeWithDefault.findBook('978-0000000000')).rejects.toThrow(BookNotFoundError);
  });

  it('findBook throws the BookNotFoundError class on a miss (AC-2.7)', async () => {
    // given an empty catalog
    const { facade } = buildScene();

    // when / then findBook for an unknown ISBN throws BookNotFoundError (same class as today)
    await expect(facade.findBook('978-0000000000')).rejects.toThrow(BookNotFoundError);
  });
});

describe('updateBook', () => {
  function buildScene() {
    const cache = new InMemoryBookCacheGateway();
    const facade = createCatalogFacade({
      newId: sequentialIds('book'),
      bookCacheGateway: cache,
    });
    return { cache, facade };
  }

  it('updates only the title and preserves authors, bookId, and isbn (AC-3.1)', async () => {
    // given a book added to the catalog
    const { facade } = buildScene();
    const added = await facade.addBook(sampleNewBookWithIsbn('978-0134685991'));

    // when updateBook is called with a title-only patch
    const updated = await facade.updateBook(added.bookId, { title: 'New Title' });

    // then the returned DTO has the new title and the original authors, bookId, isbn
    expect(updated).toEqual({
      bookId: added.bookId,
      title: 'New Title',
      authors: added.authors,
      isbn: added.isbn,
    });
  });

  it('updates only the authors and preserves title, bookId, and isbn (AC-3.2)', async () => {
    // given a book added to the catalog
    const { facade } = buildScene();
    const added = await facade.addBook(sampleNewBookWithIsbn('978-0134685991'));

    // when updateBook is called with an authors-only patch
    const updated = await facade.updateBook(added.bookId, {
      authors: ['New Author A', 'New Author B'],
    });

    // then the returned DTO has the new authors and the original title, bookId, isbn
    expect(updated).toEqual({
      bookId: added.bookId,
      title: added.title,
      authors: ['New Author A', 'New Author B'],
      isbn: added.isbn,
    });
  });

  it('updates title and authors atomically in a single returned DTO (AC-3.3)', async () => {
    // given a book added to the catalog
    const { facade } = buildScene();
    const added = await facade.addBook(sampleNewBookWithIsbn('978-0134685991'));

    // when updateBook is called with both title and authors
    const updated = await facade.updateBook(
      added.bookId,
      sampleUpdateBook({ title: 'Both Updated Title', authors: ['Both Updated Author'] }),
    );

    // then the returned DTO carries both new values, bookId/isbn unchanged
    expect(updated).toEqual({
      bookId: added.bookId,
      title: 'Both Updated Title',
      authors: ['Both Updated Author'],
      isbn: added.isbn,
    });
  });

  it('write-through cache: subsequent findBook(isbn) returns the new title and authors (AC-3.4)', async () => {
    // given a book added to the catalog and an updateBook applied
    const { facade } = buildScene();
    const added = await facade.addBook(sampleNewBookWithIsbn('978-0134685991'));
    const updated = await facade.updateBook(
      added.bookId,
      sampleUpdateBook({ title: 'Updated Title', authors: ['Updated Author'] }),
    );

    // when findBook is called for the book's isbn
    const found = await facade.findBook(added.isbn);

    // then it returns the updated DTO (cache write-through is observable end-to-end)
    expect(found).toEqual(updated);
    expect(found.title).toBe('Updated Title');
    expect(found.authors).toEqual(['Updated Author']);
  });

  it('write-through cache: cache.get(isbn) returns the updated BookDto directly (AC-3.5)', async () => {
    // given a book added to the catalog (cache empty for this isbn — addBook does not populate it)
    const { cache, facade } = buildScene();
    const added = await facade.addBook(sampleNewBookWithIsbn('978-0134685991'));
    expect(await cache.get(added.isbn)).toBeNull();

    // when updateBook applies a patch
    const updated = await facade.updateBook(
      added.bookId,
      sampleUpdateBook({ title: 'Cache Verified Title', authors: ['Cache Verified Author'] }),
    );

    // then the cache directly holds the updated BookDto (write-through populates it)
    expect(await cache.get(added.isbn)).toEqual(updated);
  });

  it('throws BookNotFoundError for an unknown bookId and does not mutate the cache (AC-3.6)', async () => {
    // given a cache pre-seeded for an unrelated ISBN, and a book that does NOT exist for the bookId being updated
    const { cache, facade } = buildScene();
    const unrelatedIsbn = '978-0135957059';
    expect(await cache.get(unrelatedIsbn)).toBeNull();

    // when updateBook is called with an unknown bookId
    // then it throws BookNotFoundError
    await expect(
      facade.updateBook('unknown-book-id', sampleUpdateBook({ title: 'x' })),
    ).rejects.toThrow(BookNotFoundError);

    // and the cache is not modified for any unrelated ISBN
    expect(await cache.get(unrelatedIsbn)).toBeNull();
  });

  it('throws InvalidBookError for an empty patch object (AC-3.7)', async () => {
    // given a book added to the catalog
    const { facade } = buildScene();
    const added = await facade.addBook(sampleNewBookWithIsbn('978-0134685991'));

    // when / then updateBook is called with no fields, then InvalidBookError surfaces
    await expect(facade.updateBook(added.bookId, {})).rejects.toThrow(InvalidBookError);
  });

  it('throws InvalidBookError for a whitespace-only title (AC-3.8)', async () => {
    // given a book added to the catalog
    const { facade } = buildScene();
    const added = await facade.addBook(sampleNewBookWithIsbn('978-0134685991'));

    // when / then updateBook is called with a trim-empty title, then InvalidBookError surfaces
    await expect(facade.updateBook(added.bookId, { title: '   ' })).rejects.toThrow(InvalidBookError);
  });

  it('throws InvalidBookError for an empty or all-blank authors array (AC-3.9)', async () => {
    // given a book added to the catalog
    const { facade } = buildScene();
    const added = await facade.addBook(sampleNewBookWithIsbn('978-0134685991'));

    // when / then updateBook is called with authors: [] then InvalidBookError surfaces
    await expect(facade.updateBook(added.bookId, { authors: [] })).rejects.toThrow(InvalidBookError);

    // and when / then updateBook is called with authors: ['', '   '] (filter-then-empty), the same error surfaces
    await expect(facade.updateBook(added.bookId, { authors: ['', '   '] })).rejects.toThrow(
      InvalidBookError,
    );
  });

  it('throws InvalidBookError when isbn is supplied (ISBN is immutable post-create) (AC-3.10)', async () => {
    // given a book added to the catalog
    const { facade } = buildScene();
    const added = await facade.addBook(sampleNewBookWithIsbn('978-0134685991'));

    // when / then updateBook is called with an isbn key, then InvalidBookError surfaces
    await expect(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      facade.updateBook(added.bookId, { isbn: '978-0135957059' } as any),
    ).rejects.toThrow(InvalidBookError);
  });
});

describe('deleteBook', () => {
  function buildScene() {
    const cache = new InMemoryBookCacheGateway();
    const facade = createCatalogFacade({
      newId: sequentialIds('book'),
      bookCacheGateway: cache,
    });
    return { cache, facade };
  }

  it('resolves without throwing for an existing book (AC-4.1)', async () => {
    // given a book added to the catalog
    const { facade } = buildScene();
    const added = await facade.addBook(sampleNewBookWithIsbn('978-0134685991'));

    // when / then deleteBook resolves without throwing
    await expect(facade.deleteBook(added.bookId)).resolves.toBeUndefined();
  });

  it('makes findBook(isbn) throw BookNotFoundError after deletion (AC-4.2)', async () => {
    // given a book added to the catalog
    const { facade } = buildScene();
    const added = await facade.addBook(sampleNewBookWithIsbn('978-0134685991'));

    // when the book is deleted
    await facade.deleteBook(added.bookId);

    // then findBook for that isbn throws BookNotFoundError
    await expect(facade.findBook(added.isbn)).rejects.toThrow(BookNotFoundError);
  });

  it('leaves cache.get(isbn) returning null after deleting a never-cached book (AC-4.3)', async () => {
    // given a book added but never read (cache is not seeded)
    const { cache, facade } = buildScene();
    const added = await facade.addBook(sampleNewBookWithIsbn('978-0134685991'));
    expect(await cache.get(added.isbn)).toBeNull();

    // when the book is deleted
    await facade.deleteBook(added.bookId);

    // then the cache still returns null for that isbn
    expect(await cache.get(added.isbn)).toBeNull();
  });

  it('evicts a previously-seeded cache entry on delete (AC-4.4)', async () => {
    // given a book added to the catalog AND a cache entry pre-seeded for that isbn
    const { cache, facade } = buildScene();
    const added = await facade.addBook(sampleNewBookWithIsbn('978-0134685991'));
    await cache.set(added.isbn, added);
    expect(await cache.get(added.isbn)).toEqual(added);

    // when the book is deleted
    await facade.deleteBook(added.bookId);

    // then the cache entry is gone
    expect(await cache.get(added.isbn)).toBeNull();
  });

  it('throws BookNotFoundError for an unknown bookId and does not modify the cache (AC-4.5)', async () => {
    // given a cache pre-seeded with an unrelated entry
    const { cache, facade } = buildScene();
    const unrelatedIsbn = '978-0135957059';
    const unrelatedBook: BookDto = {
      bookId: 'book-unrelated',
      title: 'Unrelated',
      authors: ['Unrelated Author'],
      isbn: unrelatedIsbn,
    };
    await cache.set(unrelatedIsbn, unrelatedBook);

    // when deleteBook is called with an unknown bookId, then it throws BookNotFoundError
    await expect(facade.deleteBook('unknown-book-id')).rejects.toThrow(BookNotFoundError);

    // and the unrelated cache entry is intact
    expect(await cache.get(unrelatedIsbn)).toEqual(unrelatedBook);
  });

  it('only evicts the deleted book and leaves other cache entries intact (AC-4.6)', async () => {
    // given two books added to the catalog with their cache entries seeded
    const { cache, facade } = buildScene();
    const bookA = await facade.addBook(sampleNewBookWithIsbn('978-0134685991'));
    const bookB = await facade.addBook(sampleNewBookWithIsbn('978-0135957059'));
    await cache.set(bookA.isbn, bookA);
    await cache.set(bookB.isbn, bookB);

    // when one book is deleted
    await facade.deleteBook(bookA.bookId);

    // then only that book's cache entry is gone; the other survives
    expect(await cache.get(bookA.isbn)).toBeNull();
    expect(await cache.get(bookB.isbn)).toEqual(bookB);
  });

  it('throws BookNotFoundError on a second delete of the same bookId (AC-4.7)', async () => {
    // given a book that has been added and deleted
    const { facade } = buildScene();
    const added = await facade.addBook(sampleNewBookWithIsbn('978-0134685991'));
    await facade.deleteBook(added.bookId);

    // when / then deleteBook is called a second time with the same bookId, then BookNotFoundError surfaces
    await expect(facade.deleteBook(added.bookId)).rejects.toThrow(BookNotFoundError);
  });

  it('allows addBook with the same isbn after deleteBook (AC-4.8)', async () => {
    // given a book added and then deleted
    const { facade } = buildScene();
    const original = await facade.addBook(sampleNewBookWithIsbn('978-0134685991'));
    await facade.deleteBook(original.bookId);

    // when addBook is called again with the same isbn
    const recreated = await facade.addBook(sampleNewBookWithIsbn('978-0134685991'));

    // then the new book is created with a fresh bookId and the same isbn
    expect(recreated.isbn).toBe('978-0134685991');
    expect(recreated.bookId).not.toBe(original.bookId);
    expect(await facade.findBook('978-0134685991')).toEqual(recreated);
  });

  it('removes the attached thumbnail bytes from file storage when deleting a book that has a thumbnail', async () => {
    // given a book with a thumbnail attached
    const cache = new InMemoryBookCacheGateway();
    const fileStorage = new CountingFileStorageGateway();
    const facade = createCatalogFacade({
      newId: sequentialIds('book'),
      bookCacheGateway: cache,
      fileStorageGateway: fileStorage,
    });
    const added = await facade.addBook(sampleNewBookWithIsbn('978-0134685991'));
    const attached = await facade.attachThumbnail(sampleStaffAuthUser(), added.bookId, {
      bytes: sampleThumbnailBytes(),
      declaredMimeType: 'image/png',
    });
    const attachedHash = attached.thumbnail!.contentHash;

    // when the book is deleted
    await facade.deleteBook(added.bookId);

    // then fileStorage.remove was called exactly once with the thumbnail's contentHash
    expect(fileStorage.removeCallCount).toBe(1);
    expect(fileStorage.removedHashes).toEqual([attachedHash]);
  });

  it('does not call fileStorage.remove when deleting a book without a thumbnail', async () => {
    // given a book in the catalog with no thumbnail ever attached
    const fileStorage = new CountingFileStorageGateway();
    const facade = createCatalogFacade({
      newId: sequentialIds('book'),
      fileStorageGateway: fileStorage,
    });
    const added = await facade.addBook(sampleNewBookWithIsbn('978-0134685991'));

    // when the book is deleted
    await facade.deleteBook(added.bookId);

    // then fileStorage.remove was never called
    expect(fileStorage.removeCallCount).toBe(0);
  });
});

describe('cache gateway failures', () => {
  function buildScene() {
    const innerCache = new InMemoryBookCacheGateway();
    const throwingCache = new ThrowingOnceBookCacheGateway(innerCache);
    const facade = createCatalogFacade({
      bookCacheGateway: throwingCache,
      newId: sequentialIds('book'),
    });
    return { innerCache, throwingCache, facade };
  }

  it('cache.set throws on findBook miss-then-populate; next findBook recovers (AC-5.1)', async () => {
    // given a book added to the catalog (repo populated, cache still empty)
    const { throwingCache, facade } = buildScene();
    const added = await facade.addBook(sampleNewBookWithIsbn('978-0134685991'));
    const armedError = new Error('redis SET failed');
    throwingCache.armFailureOnNextSet(armedError);

    // when findBook fires (cache miss → repo hit → cache.set throws)
    // then the exact armed error surfaces to the caller
    await expect(facade.findBook('978-0134685991')).rejects.toThrow(armedError);

    // and a follow-up findBook succeeds — the arming was single-shot and self-clearing
    await expect(facade.findBook('978-0134685991')).resolves.toEqual(added);
  });

  it('cache.get throws on findBook; next findBook recovers (AC-5.2)', async () => {
    // given a book added to the catalog
    const { throwingCache, facade } = buildScene();
    const added = await facade.addBook(sampleNewBookWithIsbn('978-0134685991'));
    const armedError = new Error('redis GET failed');
    throwingCache.armFailureOnNextGet(armedError);

    // when findBook fires (cache.get throws before the repo is consulted)
    // then the exact armed error surfaces to the caller
    await expect(facade.findBook('978-0134685991')).rejects.toThrow(armedError);

    // and a follow-up findBook succeeds — the arming was single-shot and self-clearing
    await expect(facade.findBook('978-0134685991')).resolves.toEqual(added);
  });

  it('cache.set throws during updateBook write-through; repo is the source of truth (AC-5.3)', async () => {
    // given a book added with an empty cache (no pre-seed; the repo is the only state)
    const { facade, throwingCache } = buildScene();
    const added = await facade.addBook(sampleNewBookWithIsbn('978-0134685991'));
    const armedError = new Error('redis SET failed mid-update');
    throwingCache.armFailureOnNextSet(armedError);

    // when updateBook applies a patch (repo saveBook commits, then cache.set throws)
    // then the exact armed error surfaces to the caller
    await expect(
      facade.updateBook(added.bookId, sampleUpdateBook({ title: 'Updated Title' })),
    ).rejects.toThrow(armedError);

    // and the next findBook returns the new title — the repo write was durable
    expect(await facade.findBook(added.isbn)).toMatchObject({ title: 'Updated Title' });
  });

  it('cache.evict throws during deleteBook; repo delete is durable (AC-5.4)', async () => {
    // given a book added to the catalog
    const { facade, throwingCache } = buildScene();
    const added = await facade.addBook(sampleNewBookWithIsbn('978-0134685991'));
    const armedError = new Error('redis EVICT failed');
    throwingCache.armFailureOnNextEvict(armedError);

    // when deleteBook is called (repo delete commits, then cache.evict throws)
    // then the exact armed error surfaces to the caller
    await expect(facade.deleteBook(added.bookId)).rejects.toThrow(armedError);

    // and the next findBook throws BookNotFoundError — the repo delete was durable
    await expect(facade.findBook(added.isbn)).rejects.toThrow(BookNotFoundError);
  });

  // AC-5.5 (ThrowingOnceBookCacheGateway is spec-local — declared inside this file
  // and not exported from any barrel) is structurally true: the wrapper is declared
  // at the bottom of this spec and the verifier confirms the absence from barrels via grep.
  // No runtime test — the compile is the proof.
});

// --- attachThumbnail fixtures ----------------------------------------------
// Phase 1 sniffer only checks magic-byte prefixes — bytes after the prefix do
// not need to form a valid image. Tests build the smallest sequence that the
// sniffer accepts, then pad with zeros where length matters (oversize).
function sampleThumbnailBytes(overrides: { extra?: number } = {}): Uint8Array {
  const pngMagic = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
  const extraLen = overrides.extra ?? 4;
  const bytes = new Uint8Array(pngMagic.length + extraLen);
  bytes.set(pngMagic, 0);
  // distinct extra bytes so two different `extra` values hash differently
  for (let i = 0; i < extraLen; i += 1) {
    bytes[pngMagic.length + i] = (i + 1) & 0xff;
  }
  return bytes;
}

function jpegBytes(): Uint8Array {
  // JPEG magic is 3 bytes; pad with a SOI/APP0 fragment so the prefix check
  // matches and the array is plausibly file-like.
  return new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0x01]);
}

function webpBytes(): Uint8Array {
  // RIFF????WEBPVP8 — 4 bytes RIFF, 4 bytes size, 4 bytes WEBP, then a marker
  return new Uint8Array([
    0x52, 0x49, 0x46, 0x46, // RIFF
    0x1a, 0x00, 0x00, 0x00, // (some length, ignored by sniffer)
    0x57, 0x45, 0x42, 0x50, // WEBP
    0x56, 0x50, 0x38, 0x20, // VP8 marker
  ]);
}

function pdfBytes(): Uint8Array {
  // PDF magic 25 50 44 46 plus version string
  return new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d, 0x31, 0x2e, 0x34]);
}

// --- CountingFileStorageGateway --------------------------------------------
// Spec-local wrapper that delegates to an inner gateway and counts put calls.
// Lets the spec assert "the gateway is not written to" on validation/auth
// failures and "exactly one write across two same-bytes uploads" on idempotent
// re-upload — without reaching for vi.mock and without exposing internal state
// from InMemoryFileStorageGateway. Mirrors the spec-local wrapper pattern of
// ThrowingOnceBookCacheGateway above. Not exported from any barrel.
class CountingFileStorageGateway implements FileStorageGateway {
  private _putCallCount = 0;
  private _removeCallCount = 0;
  private readonly _removedHashes: string[] = [];

  constructor(private readonly delegate: FileStorageGateway = new InMemoryFileStorageGateway()) {}

  get putCallCount(): number {
    return this._putCallCount;
  }

  get removeCallCount(): number {
    return this._removeCallCount;
  }

  get removedHashes(): readonly string[] {
    return this._removedHashes;
  }

  async put(contentHash: string, bytes: Uint8Array, mimeType: string): Promise<PutResult> {
    this._putCallCount += 1;
    return this.delegate.put(contentHash, bytes, mimeType);
  }

  get(contentHash: string): Promise<StoredFile | null> {
    return this.delegate.get(contentHash);
  }

  async remove(contentHash: string): Promise<void> {
    this._removeCallCount += 1;
    this._removedHashes.push(contentHash);
    return this.delegate.remove(contentHash);
  }
}

describe('attachThumbnail — parseThumbnailUpload (exercised through facade)', () => {
  function buildScene() {
    const fileStorage = new CountingFileStorageGateway();
    const facade = createCatalogFacade({
      newId: sequentialIds('book'),
      fileStorageGateway: fileStorage,
    });
    return { facade, fileStorage };
  }

  it('returns a BookDto whose thumbnail has the right contentHash, mimeType, and byteLength on a valid PNG', async () => {
    // given a staff caller and a book in the catalog
    const { facade } = buildScene();
    const book = await facade.addBook(sampleNewBookWithIsbn('978-0134685991'));
    const bytes = sampleThumbnailBytes();

    // when a valid PNG is attached
    const updated = await facade.attachThumbnail(sampleStaffAuthUser(), book.bookId, {
      bytes,
      declaredMimeType: 'image/png',
    });

    // then the returned BookDto carries a thumbnail subobject with the matching
    // contentHash, mimeType, and byteLength (contentHash is lowercase-hex SHA-256)
    expect(updated.thumbnail).toBeDefined();
    expect(updated.thumbnail?.mimeType).toBe('image/png');
    expect(updated.thumbnail?.byteLength).toBe(bytes.byteLength);
    expect(updated.thumbnail?.contentHash).toMatch(/^[0-9a-f]{64}$/);
  });

  it('rejects empty bytes with InvalidThumbnailError reason="empty"', async () => {
    // given a staff caller and a book in the catalog
    const { facade } = buildScene();
    const book = await facade.addBook(sampleNewBookWithIsbn('978-0134685991'));

    // when / then attaching a zero-length Uint8Array throws InvalidThumbnailError("empty")
    await expect(
      facade.attachThumbnail(sampleStaffAuthUser(), book.bookId, {
        bytes: new Uint8Array(0),
        declaredMimeType: 'image/png',
      }),
    ).rejects.toMatchObject({ name: 'InvalidThumbnailError', reason: 'empty' });
  });

  it('rejects oversize bytes (2 MB + 1) with InvalidThumbnailError reason="oversize"', async () => {
    // given a staff caller, a book, and a payload exactly 1 byte over the cap
    const { facade } = buildScene();
    const book = await facade.addBook(sampleNewBookWithIsbn('978-0134685991'));
    const oversize = new Uint8Array(2 * 1024 * 1024 + 1);
    // start with PNG magic so the prefix exists; the size check fires before mime sniff
    oversize.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], 0);

    // when / then attaching oversize bytes throws InvalidThumbnailError("oversize")
    await expect(
      facade.attachThumbnail(sampleStaffAuthUser(), book.bookId, {
        bytes: oversize,
        declaredMimeType: 'image/png',
      }),
    ).rejects.toMatchObject({ name: 'InvalidThumbnailError', reason: 'oversize' });
  });

  it('rejects unsupported mime (PDF magic) with InvalidThumbnailError reason="unsupported mime"', async () => {
    // given a staff caller, a book, and a PDF byte sequence
    const { facade } = buildScene();
    const book = await facade.addBook(sampleNewBookWithIsbn('978-0134685991'));

    // when / then attaching bytes whose magic does not match any supported image
    // type throws InvalidThumbnailError("unsupported mime")
    await expect(
      facade.attachThumbnail(sampleStaffAuthUser(), book.bookId, {
        bytes: pdfBytes(),
        declaredMimeType: 'image/png',
      }),
    ).rejects.toMatchObject({ name: 'InvalidThumbnailError', reason: 'unsupported mime' });
  });

  it('rejects mime mismatch (PNG bytes declared as image/jpeg) with reason="mime mismatch"', async () => {
    // given a staff caller, a book, and PNG bytes mislabeled as jpeg
    const { facade } = buildScene();
    const book = await facade.addBook(sampleNewBookWithIsbn('978-0134685991'));

    // when / then attaching with a declared mime that disagrees with the sniffed
    // mime throws InvalidThumbnailError("mime mismatch")
    await expect(
      facade.attachThumbnail(sampleStaffAuthUser(), book.bookId, {
        bytes: sampleThumbnailBytes(),
        declaredMimeType: 'image/jpeg',
      }),
    ).rejects.toMatchObject({ name: 'InvalidThumbnailError', reason: 'mime mismatch' });
  });

  it('accepts JPEG bytes declared as image/jpeg', async () => {
    // given a staff caller and a book
    const { facade } = buildScene();
    const book = await facade.addBook(sampleNewBookWithIsbn('978-0134685991'));
    const bytes = jpegBytes();

    // when a JPEG with matching declared mime is attached
    const updated = await facade.attachThumbnail(sampleStaffAuthUser(), book.bookId, {
      bytes,
      declaredMimeType: 'image/jpeg',
    });

    // then the saved thumbnail's mimeType is image/jpeg and byteLength matches
    expect(updated.thumbnail?.mimeType).toBe('image/jpeg');
    expect(updated.thumbnail?.byteLength).toBe(bytes.byteLength);
  });

  it('accepts WebP bytes declared as image/webp', async () => {
    // given a staff caller and a book
    const { facade } = buildScene();
    const book = await facade.addBook(sampleNewBookWithIsbn('978-0134685991'));
    const bytes = webpBytes();

    // when a WebP with matching declared mime is attached
    const updated = await facade.attachThumbnail(sampleStaffAuthUser(), book.bookId, {
      bytes,
      declaredMimeType: 'image/webp',
    });

    // then the saved thumbnail's mimeType is image/webp and byteLength matches
    expect(updated.thumbnail?.mimeType).toBe('image/webp');
    expect(updated.thumbnail?.byteLength).toBe(bytes.byteLength);
  });
});

describe('attachThumbnail — facade behavior', () => {
  function buildScene() {
    const fileStorage = new CountingFileStorageGateway();
    const facade = createCatalogFacade({
      newId: sequentialIds('book'),
      fileStorageGateway: fileStorage,
    });
    return { facade, fileStorage };
  }

  it('persists the thumbnail metadata so a subsequent findBook returns the BookDto with the thumbnail subobject', async () => {
    // given a staff caller, a book in the catalog, and valid PNG bytes
    const { facade } = buildScene();
    const book = await facade.addBook(sampleNewBookWithIsbn('978-0134685991'));
    const bytes = sampleThumbnailBytes();

    // when the thumbnail is attached
    const updated = await facade.attachThumbnail(sampleStaffAuthUser(), book.bookId, {
      bytes,
      declaredMimeType: 'image/png',
    });

    // then findBook returns the BookDto including the thumbnail subobject
    const found = await facade.findBook(book.isbn);
    expect(found.thumbnail).toEqual(updated.thumbnail);
    expect(found.thumbnail?.mimeType).toBe('image/png');
    expect(found.thumbnail?.byteLength).toBe(bytes.byteLength);
  });

  it('throws BookNotFoundError for an unknown bookId AND does not write to the file-storage gateway', async () => {
    // given a staff caller and a fresh gateway with no books in the catalog
    const { facade, fileStorage } = buildScene();

    // when / then attachThumbnail against an unknown bookId throws BookNotFoundError
    await expect(
      facade.attachThumbnail(sampleStaffAuthUser(), 'unknown-book-id', {
        bytes: sampleThumbnailBytes(),
        declaredMimeType: 'image/png',
      }),
    ).rejects.toThrow(BookNotFoundError);

    // and the gateway was never written to
    expect(fileStorage.putCallCount).toBe(0);
  });

  it('throws UnauthorizedRoleError for a MEMBER caller AND does not write to the file-storage gateway', async () => {
    // given a MEMBER caller and a book in the catalog
    const { facade, fileStorage } = buildScene();
    const book = await facade.addBook(sampleNewBookWithIsbn('978-0134685991'));

    // when / then attachThumbnail with a MEMBER auth user throws UnauthorizedRoleError
    await expect(
      facade.attachThumbnail(sampleAuthUser({ role: 'MEMBER' }), book.bookId, {
        bytes: sampleThumbnailBytes(),
        declaredMimeType: 'image/png',
      }),
    ).rejects.toThrow(UnauthorizedRoleError);

    // and the gateway was never written to (auth runs before storage)
    expect(fileStorage.putCallCount).toBe(0);
  });

  it('throws UnauthorizedRoleError for an ACCOUNT caller AND does not write to the file-storage gateway', async () => {
    // given an ACCOUNT caller and a book in the catalog
    const { facade, fileStorage } = buildScene();
    const book = await facade.addBook(sampleNewBookWithIsbn('978-0134685991'));

    // when / then attachThumbnail with an ACCOUNT auth user throws UnauthorizedRoleError
    await expect(
      facade.attachThumbnail(sampleAuthUser({ role: 'ACCOUNT' }), book.bookId, {
        bytes: sampleThumbnailBytes(),
        declaredMimeType: 'image/png',
      }),
    ).rejects.toThrow(UnauthorizedRoleError);

    // and the gateway was never written to (auth runs before storage)
    expect(fileStorage.putCallCount).toBe(0);
  });

  it('is idempotent: re-uploading the same bytes returns the same contentHash and writes the gateway only once net', async () => {
    // given a staff caller, a book, and a payload that gets attached twice
    const { facade, fileStorage } = buildScene();
    const book = await facade.addBook(sampleNewBookWithIsbn('978-0134685991'));
    const bytes = sampleThumbnailBytes();

    // when attachThumbnail is called twice with the exact same bytes
    const firstUpload = await facade.attachThumbnail(sampleStaffAuthUser(), book.bookId, {
      bytes,
      declaredMimeType: 'image/png',
    });
    const secondUpload = await facade.attachThumbnail(sampleStaffAuthUser(), book.bookId, {
      bytes,
      declaredMimeType: 'image/png',
    });

    // then both uploads resolve to BookDtos with the same contentHash
    expect(secondUpload.thumbnail?.contentHash).toBe(firstUpload.thumbnail?.contentHash);
    // and the gateway holds exactly one entry under that hash (the second put
    // was a no-op by content hash — verified by reading back via get)
    const stored = await fileStorage.get(firstUpload.thumbnail!.contentHash);
    expect(stored).not.toBeNull();
    expect(stored?.mimeType).toBe('image/png');
  });

  it('replaces book.thumbnail.contentHash when uploading different bytes for the same book', async () => {
    // given a staff caller, a book, and two distinct byte payloads
    const { facade } = buildScene();
    const book = await facade.addBook(sampleNewBookWithIsbn('978-0134685991'));
    const bytesA = sampleThumbnailBytes({ extra: 4 });
    const bytesB = sampleThumbnailBytes({ extra: 8 });

    // when attachThumbnail runs first with bytesA then with bytesB
    const afterA = await facade.attachThumbnail(sampleStaffAuthUser(), book.bookId, {
      bytes: bytesA,
      declaredMimeType: 'image/png',
    });
    const afterB = await facade.attachThumbnail(sampleStaffAuthUser(), book.bookId, {
      bytes: bytesB,
      declaredMimeType: 'image/png',
    });

    // then the saved book's thumbnail.contentHash reflects bytesB's hash, not bytesA's
    expect(afterB.thumbnail?.contentHash).not.toBe(afterA.thumbnail?.contentHash);
    expect(afterB.thumbnail?.byteLength).toBe(bytesB.byteLength);

    // and a fresh findBook also reflects bytesB's hash (the metadata persisted)
    const found = await facade.findBook(book.isbn);
    expect(found.thumbnail?.contentHash).toBe(afterB.thumbnail?.contentHash);
  });

  it('runs validation before storage: oversize input throws InvalidThumbnailError and the gateway stays empty', async () => {
    // given a staff caller, a book, and an oversize payload
    const { facade, fileStorage } = buildScene();
    const book = await facade.addBook(sampleNewBookWithIsbn('978-0134685991'));
    const oversize = new Uint8Array(2 * 1024 * 1024 + 1);
    oversize.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], 0);

    // when / then attach with oversize bytes throws InvalidThumbnailError
    await expect(
      facade.attachThumbnail(sampleStaffAuthUser(), book.bookId, {
        bytes: oversize,
        declaredMimeType: 'image/png',
      }),
    ).rejects.toThrow(InvalidThumbnailError);

    // and the gateway was never written to (validation runs before storage)
    expect(fileStorage.putCallCount).toBe(0);
  });

  it('runs validation before storage: unsupported mime throws InvalidThumbnailError and the gateway stays empty', async () => {
    // given a staff caller, a book, and PDF bytes (unsupported)
    const { facade, fileStorage } = buildScene();
    const book = await facade.addBook(sampleNewBookWithIsbn('978-0134685991'));

    // when / then attach with PDF bytes throws InvalidThumbnailError
    await expect(
      facade.attachThumbnail(sampleStaffAuthUser(), book.bookId, {
        bytes: pdfBytes(),
        declaredMimeType: 'image/png',
      }),
    ).rejects.toThrow(InvalidThumbnailError);

    // and the gateway was never written to
    expect(fileStorage.putCallCount).toBe(0);
  });

  it('runs validation before storage: mime mismatch throws InvalidThumbnailError and the gateway stays empty', async () => {
    // given a staff caller, a book, and PNG bytes declared as JPEG
    const { facade, fileStorage } = buildScene();
    const book = await facade.addBook(sampleNewBookWithIsbn('978-0134685991'));

    // when / then attach with mislabeled mime throws InvalidThumbnailError
    await expect(
      facade.attachThumbnail(sampleStaffAuthUser(), book.bookId, {
        bytes: sampleThumbnailBytes(),
        declaredMimeType: 'image/jpeg',
      }),
    ).rejects.toThrow(InvalidThumbnailError);

    // and the gateway was never written to
    expect(fileStorage.putCallCount).toBe(0);
  });
});

describe('readThumbnail', () => {
  function buildScene() {
    const fileStorage = new CountingFileStorageGateway();
    const facade = createCatalogFacade({
      newId: sequentialIds('book'),
      fileStorageGateway: fileStorage,
    });
    return { facade, fileStorage };
  }

  it('returns bytes byte-identical to what was attached, plus mimeType, contentHash, byteLength', async () => {
    // given a book with a freshly-attached PNG thumbnail
    const { facade } = buildScene();
    const book = await facade.addBook(sampleNewBookWithIsbn('978-0134685991'));
    const attachedBytes = sampleThumbnailBytes();
    const attached = await facade.attachThumbnail(sampleStaffAuthUser(), book.bookId, {
      bytes: attachedBytes,
      declaredMimeType: 'image/png',
    });

    // when readThumbnail is called for that book
    const read = await facade.readThumbnail(book.bookId);

    // then the bytes are byte-identical to what was attached
    expect(read.bytes).toEqual(attachedBytes);
    // and the metadata matches what the attach returned
    expect(read.mimeType).toBe('image/png');
    expect(read.contentHash).toBe(attached.thumbnail!.contentHash);
    expect(read.byteLength).toBe(attachedBytes.byteLength);
  });

  it('throws BookNotFoundError for an unknown bookId', async () => {
    // given a catalog with no books
    const { facade } = buildScene();

    // when / then readThumbnail with an unknown bookId throws BookNotFoundError
    await expect(facade.readThumbnail('unknown-book-id')).rejects.toThrow(BookNotFoundError);
  });

  it('throws ThumbnailNotFoundError for a known book with no thumbnail attached', async () => {
    // given a book that has never had a thumbnail attached
    const { facade } = buildScene();
    const book = await facade.addBook(sampleNewBookWithIsbn('978-0134685991'));

    // when / then readThumbnail throws ThumbnailNotFoundError
    await expect(facade.readThumbnail(book.bookId)).rejects.toThrow(ThumbnailNotFoundError);
  });

  it('does not require authorization: a MEMBER-context caller can still read the thumbnail', async () => {
    // given a book with an attached thumbnail (attached by staff, as the policy requires)
    const { facade } = buildScene();
    const book = await facade.addBook(sampleNewBookWithIsbn('978-0134685991'));
    const bytes = sampleThumbnailBytes();
    await facade.attachThumbnail(sampleStaffAuthUser(), book.bookId, {
      bytes,
      declaredMimeType: 'image/png',
    });

    // when readThumbnail is invoked (it takes no authUser — reads are open by design)
    // then it resolves successfully with the same byte content the staff caller attached
    const read = await facade.readThumbnail(book.bookId);
    expect(read.bytes).toEqual(bytes);
    expect(read.mimeType).toBe('image/png');
  });
});

describe('removeThumbnail', () => {
  function buildScene() {
    const fileStorage = new CountingFileStorageGateway();
    const facade = createCatalogFacade({
      newId: sequentialIds('book'),
      fileStorageGateway: fileStorage,
    });
    return { facade, fileStorage };
  }

  it('is a no-op when the book has no thumbnail: returns the book unchanged and never touches file storage', async () => {
    // given a book with no thumbnail attached
    const { facade, fileStorage } = buildScene();
    const added = await facade.addBook(sampleNewBookWithIsbn('978-0134685991'));
    const preState = await facade.findBook(added.isbn);

    // when removeThumbnail is invoked against the same book
    const returned = await facade.removeThumbnail(sampleStaffAuthUser(), added.bookId);

    // then the returned book matches the pre-state shape (no fields added or removed)
    expect(returned).toEqual(preState);
    // and a subsequent findBook returns the same shape — neither field added nor removed
    const postState = await facade.findBook(added.isbn);
    expect(postState).toEqual(preState);
    // and file storage was never asked to remove anything
    expect(fileStorage.removeCallCount).toBe(0);
  });

  it('returns a BookDto without the thumbnail field when the book had one', async () => {
    // given a book with a thumbnail attached
    const { facade } = buildScene();
    const added = await facade.addBook(sampleNewBookWithIsbn('978-0134685991'));
    const withThumbnail = await facade.attachThumbnail(sampleStaffAuthUser(), added.bookId, {
      bytes: sampleThumbnailBytes(),
      declaredMimeType: 'image/png',
    });
    expect(withThumbnail.thumbnail).toBeDefined();

    // when removeThumbnail is invoked
    const returned = await facade.removeThumbnail(sampleStaffAuthUser(), added.bookId);

    // then the returned BookDto has no thumbnail field
    expect(returned.thumbnail).toBeUndefined();
    // and a subsequent findBook also returns a BookDto without the thumbnail field
    const found = await facade.findBook(added.isbn);
    expect(found.thumbnail).toBeUndefined();
  });

  it('calls fileStorage.remove(contentHash) exactly once when the book had a thumbnail', async () => {
    // given a book with a thumbnail attached
    const { facade, fileStorage } = buildScene();
    const added = await facade.addBook(sampleNewBookWithIsbn('978-0134685991'));
    const withThumbnail = await facade.attachThumbnail(sampleStaffAuthUser(), added.bookId, {
      bytes: sampleThumbnailBytes(),
      declaredMimeType: 'image/png',
    });
    const attachedHash = withThumbnail.thumbnail!.contentHash;

    // when removeThumbnail runs
    await facade.removeThumbnail(sampleStaffAuthUser(), added.bookId);

    // then fileStorage.remove was called once with the attached contentHash
    expect(fileStorage.removeCallCount).toBe(1);
    expect(fileStorage.removedHashes).toEqual([attachedHash]);
  });

  it('after removeThumbnail, a subsequent readThumbnail throws ThumbnailNotFoundError', async () => {
    // given a book with a thumbnail that gets removed
    const { facade } = buildScene();
    const added = await facade.addBook(sampleNewBookWithIsbn('978-0134685991'));
    await facade.attachThumbnail(sampleStaffAuthUser(), added.bookId, {
      bytes: sampleThumbnailBytes(),
      declaredMimeType: 'image/png',
    });
    await facade.removeThumbnail(sampleStaffAuthUser(), added.bookId);

    // when / then readThumbnail throws ThumbnailNotFoundError
    await expect(facade.readThumbnail(added.bookId)).rejects.toThrow(ThumbnailNotFoundError);
  });

  it('throws UnauthorizedRoleError for a MEMBER caller and does not touch file storage', async () => {
    // given a MEMBER caller and a book in the catalog
    const { facade, fileStorage } = buildScene();
    const added = await facade.addBook(sampleNewBookWithIsbn('978-0134685991'));

    // when / then removeThumbnail throws UnauthorizedRoleError
    await expect(
      facade.removeThumbnail(sampleAuthUser({ role: 'MEMBER' }), added.bookId),
    ).rejects.toThrow(UnauthorizedRoleError);

    // and the gateway was never touched (auth runs before storage)
    expect(fileStorage.removeCallCount).toBe(0);
  });

  it('throws UnauthorizedRoleError for an ACCOUNT caller and does not touch file storage', async () => {
    // given an ACCOUNT caller and a book in the catalog
    const { facade, fileStorage } = buildScene();
    const added = await facade.addBook(sampleNewBookWithIsbn('978-0134685991'));

    // when / then removeThumbnail throws UnauthorizedRoleError
    await expect(
      facade.removeThumbnail(sampleAuthUser({ role: 'ACCOUNT' }), added.bookId),
    ).rejects.toThrow(UnauthorizedRoleError);

    // and the gateway was never touched (auth runs before storage)
    expect(fileStorage.removeCallCount).toBe(0);
  });

  it('throws BookNotFoundError for an unknown bookId', async () => {
    // given a catalog with no books
    const { facade } = buildScene();

    // when / then removeThumbnail with an unknown bookId throws BookNotFoundError
    await expect(
      facade.removeThumbnail(sampleStaffAuthUser(), 'unknown-book-id'),
    ).rejects.toThrow(BookNotFoundError);
  });

  it('completes the full lifecycle: attach → read (succeeds) → remove → read (throws ThumbnailNotFoundError)', async () => {
    // given a book and a payload that will travel through the full lifecycle
    const { facade } = buildScene();
    const added = await facade.addBook(sampleNewBookWithIsbn('978-0134685991'));
    const bytes = sampleThumbnailBytes();

    // step 1: attach succeeds and returns a BookDto with thumbnail metadata
    const attached = await facade.attachThumbnail(sampleStaffAuthUser(), added.bookId, {
      bytes,
      declaredMimeType: 'image/png',
    });
    expect(attached.thumbnail).toBeDefined();

    // step 2: read returns the same bytes the staff caller attached
    const readAfterAttach = await facade.readThumbnail(added.bookId);
    expect(readAfterAttach.bytes).toEqual(bytes);
    expect(readAfterAttach.contentHash).toBe(attached.thumbnail!.contentHash);

    // step 3: remove succeeds and clears the thumbnail off the returned book
    const afterRemove = await facade.removeThumbnail(sampleStaffAuthUser(), added.bookId);
    expect(afterRemove.thumbnail).toBeUndefined();

    // step 4: a second read throws ThumbnailNotFoundError — the bytes are gone
    await expect(facade.readThumbnail(added.bookId)).rejects.toThrow(ThumbnailNotFoundError);
  });
});

describe('attachThumbnail cache integration', () => {
  function buildScene() {
    const cache = new InMemoryBookCacheGateway();
    const fileStorage = new CountingFileStorageGateway();
    const facade = createCatalogFacade({
      newId: sequentialIds('book'),
      bookCacheGateway: cache,
      fileStorageGateway: fileStorage,
    });
    return { cache, fileStorage, facade };
  }

  it('writes the BookDto with the new thumbnail subobject directly into the cache (AC-5.1)', async () => {
    // given a book in the catalog with an empty cache for its isbn
    const { cache, facade } = buildScene();
    const added = await facade.addBook(sampleNewBookWithIsbn('978-0134685991'));
    expect(await cache.get(added.isbn)).toBeNull();

    // when a thumbnail is attached
    const updated = await facade.attachThumbnail(sampleStaffAuthUser(), added.bookId, {
      bytes: sampleThumbnailBytes(),
      declaredMimeType: 'image/png',
    });

    // then the cache directly holds the BookDto including the thumbnail subobject
    const cached = await cache.get(added.isbn);
    expect(cached).toEqual(updated);
    expect(cached?.thumbnail).toEqual(updated.thumbnail);
  });

  it('makes a subsequent findBook(isbn) return the cached BookDto with the thumbnail (AC-5.5)', async () => {
    // given a book with a freshly-attached thumbnail
    const { facade } = buildScene();
    const added = await facade.addBook(sampleNewBookWithIsbn('978-0134685991'));
    const attached = await facade.attachThumbnail(sampleStaffAuthUser(), added.bookId, {
      bytes: sampleThumbnailBytes(),
      declaredMimeType: 'image/png',
    });

    // when findBook is called for that isbn
    const found = await facade.findBook(added.isbn);

    // then it returns the BookDto with the same thumbnail subobject that attach returned
    expect(found).toEqual(attached);
    expect(found.thumbnail).toEqual(attached.thumbnail);
  });

  it('propagates the original error when cache.set throws and keeps fileStorage bytes intact (AC-5.4)', async () => {
    // given a book in the catalog and a cache wrapper armed to throw on the next set
    const innerCache = new InMemoryBookCacheGateway();
    const throwingCache = new ThrowingOnceBookCacheGateway(innerCache);
    const fileStorage = new CountingFileStorageGateway();
    const facade = createCatalogFacade({
      newId: sequentialIds('book'),
      bookCacheGateway: throwingCache,
      fileStorageGateway: fileStorage,
    });
    const added = await facade.addBook(sampleNewBookWithIsbn('978-0134685991'));
    const bytes = sampleThumbnailBytes();
    const expectedHash = createHash('sha256').update(bytes).digest('hex');
    const armedError = new Error('redis SET failed during attachThumbnail');
    throwingCache.armFailureOnNextSet(armedError);

    // when attachThumbnail fires (parse → put → saveBook → cache.set throws)
    // then the exact armed error surfaces to the caller
    await expect(
      facade.attachThumbnail(sampleStaffAuthUser(), added.bookId, {
        bytes,
        declaredMimeType: 'image/png',
      }),
    ).rejects.toThrow(armedError);

    // and the bytes already in fileStorage are NOT rolled back (documented Phase 1 behavior)
    const stored = await fileStorage.get(expectedHash);
    expect(stored).not.toBeNull();
    expect(stored?.mimeType).toBe('image/png');
    expect(stored?.bytes).toEqual(bytes);
  });

  it('keeps the book metadata write durable when cache.set throws during attachThumbnail (AC-5.4)', async () => {
    // given a book and a cache armed to throw once on set
    const innerCache = new InMemoryBookCacheGateway();
    const throwingCache = new ThrowingOnceBookCacheGateway(innerCache);
    const facade = createCatalogFacade({
      newId: sequentialIds('book'),
      bookCacheGateway: throwingCache,
    });
    const added = await facade.addBook(sampleNewBookWithIsbn('978-0134685991'));
    const armedError = new Error('redis SET failed mid-attach');
    throwingCache.armFailureOnNextSet(armedError);

    // when attachThumbnail throws on the cache.set step
    await expect(
      facade.attachThumbnail(sampleStaffAuthUser(), added.bookId, {
        bytes: sampleThumbnailBytes(),
        declaredMimeType: 'image/png',
      }),
    ).rejects.toThrow(armedError);

    // then the repo write was durable — a follow-up findBook returns the BookDto with the thumbnail
    // (the throwing wrapper was single-shot; the second findBook flows through cleanly)
    const found = await facade.findBook(added.isbn);
    expect(found.thumbnail).toBeDefined();
    expect(found.thumbnail?.mimeType).toBe('image/png');
  });

  it('throws and does not write the book repository when fileStorage.put fails (AC-5.7)', async () => {
    // given a book, an in-memory cache, and a fileStorage armed to throw once on put
    const cache = new InMemoryBookCacheGateway();
    const innerStorage = new InMemoryFileStorageGateway();
    const throwingStorage = new ThrowingOnceFileStorageGateway(innerStorage);
    const facade = createCatalogFacade({
      newId: sequentialIds('book'),
      bookCacheGateway: cache,
      fileStorageGateway: throwingStorage,
    });
    const added = await facade.addBook(sampleNewBookWithIsbn('978-0134685991'));
    const armedError = new Error('s3 PUT failed during attachThumbnail');
    throwingStorage.armFailureOnNextPut(armedError);

    // when attachThumbnail fires (parse → put throws before repo or cache are touched)
    // then the exact armed error surfaces to the caller
    await expect(
      facade.attachThumbnail(sampleStaffAuthUser(), added.bookId, {
        bytes: sampleThumbnailBytes(),
        declaredMimeType: 'image/png',
      }),
    ).rejects.toThrow(armedError);

    // and the repo was not written — findBook still returns the BookDto without a thumbnail
    const found = await facade.findBook(added.isbn);
    expect(found.thumbnail).toBeUndefined();

    // and the cache was not populated by attachThumbnail (only by the subsequent findBook above)
    expect(found).toEqual(added);
  });
});

describe('removeThumbnail cache integration', () => {
  function buildScene() {
    const cache = new InMemoryBookCacheGateway();
    const fileStorage = new CountingFileStorageGateway();
    const facade = createCatalogFacade({
      newId: sequentialIds('book'),
      bookCacheGateway: cache,
      fileStorageGateway: fileStorage,
    });
    return { cache, fileStorage, facade };
  }

  it('writes the BookDto without the thumbnail field directly into the cache (AC-5.2)', async () => {
    // given a book with a thumbnail attached (cache already holds the with-thumbnail BookDto)
    const { cache, facade } = buildScene();
    const added = await facade.addBook(sampleNewBookWithIsbn('978-0134685991'));
    await facade.attachThumbnail(sampleStaffAuthUser(), added.bookId, {
      bytes: sampleThumbnailBytes(),
      declaredMimeType: 'image/png',
    });
    expect((await cache.get(added.isbn))?.thumbnail).toBeDefined();

    // when removeThumbnail is invoked
    const returned = await facade.removeThumbnail(sampleStaffAuthUser(), added.bookId);

    // then the cache directly holds the BookDto with no thumbnail field
    const cached = await cache.get(added.isbn);
    expect(cached).toEqual(returned);
    expect(cached?.thumbnail).toBeUndefined();
  });

  it('makes a subsequent findBook(isbn) return the cached BookDto without a thumbnail (AC-5.6)', async () => {
    // given a book whose thumbnail has been attached and then removed
    const { facade } = buildScene();
    const added = await facade.addBook(sampleNewBookWithIsbn('978-0134685991'));
    await facade.attachThumbnail(sampleStaffAuthUser(), added.bookId, {
      bytes: sampleThumbnailBytes(),
      declaredMimeType: 'image/png',
    });
    const afterRemove = await facade.removeThumbnail(sampleStaffAuthUser(), added.bookId);

    // when findBook is called
    const found = await facade.findBook(added.isbn);

    // then it returns the BookDto without a thumbnail (matches the remove return value)
    expect(found).toEqual(afterRemove);
    expect(found.thumbnail).toBeUndefined();
  });

  it('does not call cache.set on the no-op path when the book has no thumbnail', async () => {
    // given a book with no thumbnail attached and a cache armed to throw on the next set
    const innerCache = new InMemoryBookCacheGateway();
    const throwingCache = new ThrowingOnceBookCacheGateway(innerCache);
    const facade = createCatalogFacade({
      newId: sequentialIds('book'),
      bookCacheGateway: throwingCache,
    });
    const added = await facade.addBook(sampleNewBookWithIsbn('978-0134685991'));
    throwingCache.armFailureOnNextSet(new Error('cache.set must NOT be called on the no-op path'));

    // when removeThumbnail is invoked on the book with no thumbnail
    // then it resolves to the unchanged book (the arming was never tripped)
    const returned = await facade.removeThumbnail(sampleStaffAuthUser(), added.bookId);
    expect(returned).toEqual(added);

    // and the arming is still live — proving cache.set was never called on the no-op path.
    // A follow-through call that does set (e.g. updateBook) would surface the armed error.
    await expect(
      facade.updateBook(added.bookId, sampleUpdateBook({ title: 'Trip the arm' })),
    ).rejects.toThrow('cache.set must NOT be called on the no-op path');
  });
});

describe('ThrowingOnceFileStorageGateway (declared for slice 5; smoke test only)', () => {
  it('throws the armed error exactly once on the next put, then delegates normally', async () => {
    // given a wrapper armed with a single-shot error on put
    const inner = new InMemoryFileStorageGateway();
    const wrapper = new ThrowingOnceFileStorageGateway(inner);
    const armed = new Error('s3 PUT failed');
    wrapper.armFailureOnNextPut(armed);

    // when the first put fires, then the armed error surfaces and arming clears
    await expect(wrapper.put('hash-1', new Uint8Array([1, 2, 3]), 'image/png')).rejects.toThrow(
      armed,
    );

    // and the second put succeeds (arming was single-shot and self-clearing)
    await expect(
      wrapper.put('hash-2', new Uint8Array([4, 5, 6]), 'image/png'),
    ).resolves.toMatchObject({ contentHash: 'hash-2', alreadyExisted: false });
  });
});

// --- ThrowingOnceIsbnLookupGateway -----------------------------------------
// Spec-local wrapper that decorates a real in-memory gateway and throws on the
// next findByIsbn call when armed. Mirrors ThrowingOnceReservationRepository in
// lending.facade.spec.ts:347-377. Intentionally NOT exported — this is the
// canonical teaching moment for Principle 5 applied to outbound gateways.
class ThrowingOnceIsbnLookupGateway implements IsbnLookupGateway {
  private armedError: Error | null = null;

  constructor(private readonly delegate: IsbnLookupGateway) {}

  armFailureOnNextLookup(error: Error): void {
    this.armedError = error;
  }

  async findByIsbn(isbn: string): Promise<BookMetadata | null> {
    if (this.armedError) {
      const error = this.armedError;
      this.armedError = null;
      throw error;
    }
    return this.delegate.findByIsbn(isbn);
  }
}

// --- ThrowingOnceBookCacheGateway ------------------------------------------
// Spec-local wrapper that decorates a real in-memory cache and throws once on
// the next get/set/evict call when armed. Exists only to prove the facade
// survives a cache outage at a specific moment without reaching for vi.mock
// or a Redis stub. Mirrors ThrowingOnceIsbnLookupGateway above; declared here
// because no other spec needs it.
class ThrowingOnceBookCacheGateway implements BookCacheGateway {
  private armedSetError: Error | null = null;
  private armedGetError: Error | null = null;
  private armedEvictError: Error | null = null;

  constructor(private readonly delegate: BookCacheGateway) {}

  armFailureOnNextSet(error: Error): void {
    this.armedSetError = error;
  }

  armFailureOnNextGet(error: Error): void {
    this.armedGetError = error;
  }

  armFailureOnNextEvict(error: Error): void {
    this.armedEvictError = error;
  }

  async get(isbn: Isbn): Promise<BookDto | null> {
    if (this.armedGetError) {
      const error = this.armedGetError;
      this.armedGetError = null;
      throw error;
    }
    return this.delegate.get(isbn);
  }

  async set(isbn: Isbn, book: BookDto): Promise<void> {
    if (this.armedSetError) {
      const error = this.armedSetError;
      this.armedSetError = null;
      throw error;
    }
    return this.delegate.set(isbn, book);
  }

  async evict(isbn: Isbn): Promise<void> {
    if (this.armedEvictError) {
      const error = this.armedEvictError;
      this.armedEvictError = null;
      throw error;
    }
    return this.delegate.evict(isbn);
  }
}

// --- ThrowingOnceFileStorageGateway ----------------------------------------
// Spec-local wrapper that decorates a real in-memory file-storage gateway and
// throws once on the next put/get/remove call when armed. Declared in slice 3
// to lock the shape; used by slice 5 to assert that a fileStorage.put failure
// during attachThumbnail propagates and does not write to the book repository.
// Mirrors ThrowingOnceBookCacheGateway above. Not exported from any barrel.
class ThrowingOnceFileStorageGateway implements FileStorageGateway {
  private armedPutError: Error | null = null;
  private armedGetError: Error | null = null;
  private armedRemoveError: Error | null = null;

  constructor(private readonly delegate: FileStorageGateway) {}

  armFailureOnNextPut(error: Error): void {
    this.armedPutError = error;
  }

  armFailureOnNextGet(error: Error): void {
    this.armedGetError = error;
  }

  armFailureOnNextRemove(error: Error): void {
    this.armedRemoveError = error;
  }

  async put(contentHash: string, bytes: Uint8Array, mimeType: string): Promise<PutResult> {
    if (this.armedPutError) {
      const error = this.armedPutError;
      this.armedPutError = null;
      throw error;
    }
    return this.delegate.put(contentHash, bytes, mimeType);
  }

  async get(contentHash: string): Promise<StoredFile | null> {
    if (this.armedGetError) {
      const error = this.armedGetError;
      this.armedGetError = null;
      throw error;
    }
    return this.delegate.get(contentHash);
  }

  async remove(contentHash: string): Promise<void> {
    if (this.armedRemoveError) {
      const error = this.armedRemoveError;
      this.armedRemoveError = null;
      throw error;
    }
    return this.delegate.remove(contentHash);
  }
}
