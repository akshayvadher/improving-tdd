import { describe, expect, it } from 'vitest';

import type { BookDto } from '../../catalog/catalog.types.js';
import type { BookCacheGateway } from './book-cache-gateway.js';
import { InMemoryBookCacheGateway } from './in-memory-book-cache-gateway.js';

function sampleBook(overrides: Partial<BookDto> = {}): BookDto {
  return {
    bookId: 'book-1',
    title: 'The Pragmatic Programmer',
    authors: ['Andrew Hunt', 'David Thomas'],
    isbn: '978-0135957059',
    ...overrides,
  };
}

describe('InMemoryBookCacheGateway', () => {
  it('returns null for an ISBN that was never set', async () => {
    // given a fresh cache with no entries
    const cache: BookCacheGateway = new InMemoryBookCacheGateway();

    // when get is called for an ISBN that was never set
    const found = await cache.get('978-0000000000');

    // then null is returned
    expect(found).toBe(null);
  });

  it('returns the exact BookDto previously set for an ISBN', async () => {
    // given a cache with a book set for an ISBN
    const cache = new InMemoryBookCacheGateway();
    const book = sampleBook({ isbn: '978-0134685991' });
    await cache.set(book.isbn, book);

    // when get is called with that ISBN
    const found = await cache.get(book.isbn);

    // then the same BookDto is returned
    expect(found).toEqual(book);
  });

  it('replaces the previous value when set is called again on the same key (last write wins)', async () => {
    // given a cache that already has a book set for an ISBN
    const cache = new InMemoryBookCacheGateway();
    const original = sampleBook({ isbn: '978-0134685991', title: 'Old Title' });
    const replacement = sampleBook({ isbn: '978-0134685991', title: 'New Title' });
    await cache.set(original.isbn, original);

    // when the same ISBN is set again with a different BookDto
    await cache.set(replacement.isbn, replacement);

    // then get returns the replacement (last write wins)
    expect(await cache.get(replacement.isbn)).toEqual(replacement);
  });

  it('causes the next get to return null after evict on an existing key', async () => {
    // given a cache with a book set for an ISBN
    const cache = new InMemoryBookCacheGateway();
    const book = sampleBook({ isbn: '978-0134685991' });
    await cache.set(book.isbn, book);

    // when that ISBN is evicted
    await cache.evict(book.isbn);

    // then the next get for that ISBN returns null
    expect(await cache.get(book.isbn)).toBe(null);
  });

  it('resolves without throwing when evict is called for an absent key', async () => {
    // given a fresh cache with no entries
    const cache = new InMemoryBookCacheGateway();

    // when / then evicting an ISBN that was never set resolves without throwing
    await expect(cache.evict('978-0000000000')).resolves.toBeUndefined();
  });

  it('stores two distinct ISBNs independently — set/evict on one does not affect the other', async () => {
    // given a cache with two distinct ISBNs each holding their own BookDto
    const cache = new InMemoryBookCacheGateway();
    const bookA = sampleBook({ bookId: 'book-A', isbn: '978-0134685991' });
    const bookB = sampleBook({ bookId: 'book-B', isbn: '978-0135957059' });
    await cache.set(bookA.isbn, bookA);
    await cache.set(bookB.isbn, bookB);

    // when one ISBN is evicted
    await cache.evict(bookA.isbn);

    // then only that ISBN's entry is gone; the other is untouched
    expect(await cache.get(bookA.isbn)).toBe(null);
    expect(await cache.get(bookB.isbn)).toEqual(bookB);
  });

  it('satisfies the BookCacheGateway port (get, set, evict signatures)', async () => {
    // given a fresh InMemoryBookCacheGateway typed as the port
    const cache: BookCacheGateway = new InMemoryBookCacheGateway();
    const book = sampleBook({ isbn: '978-0134685991' });

    // when each method is called through the port type
    // then each returns a Promise (await resolves) — the assignment above is the
    // compile-time proof that the in-memory class implements the port.
    await expect(cache.set(book.isbn, book)).resolves.toBeUndefined();
    await expect(cache.get(book.isbn)).resolves.toEqual(book);
    await expect(cache.evict(book.isbn)).resolves.toBeUndefined();
  });
});
