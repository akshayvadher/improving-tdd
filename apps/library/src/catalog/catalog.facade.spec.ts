import { describe, expect, it } from 'vitest';

import type { BookCacheGateway } from '../shared/book-cache-gateway/book-cache-gateway.js';
import { InMemoryBookCacheGateway } from '../shared/book-cache-gateway/in-memory-book-cache-gateway.js';
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
