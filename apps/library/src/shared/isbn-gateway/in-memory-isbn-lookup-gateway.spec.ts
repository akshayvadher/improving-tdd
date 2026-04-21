import { describe, expect, it } from 'vitest';

import { InMemoryIsbnLookupGateway } from './in-memory-isbn-lookup-gateway.js';

describe('InMemoryIsbnLookupGateway', () => {
  it('returns seeded metadata for a matching ISBN', async () => {
    // given a gateway seeded with metadata for an ISBN
    const gateway = new InMemoryIsbnLookupGateway();
    const metadata = {
      title: 'The Pragmatic Programmer',
      authors: ['Andrew Hunt', 'David Thomas'],
    };
    gateway.seed('isbn-A', metadata);

    // when findByIsbn is called with that ISBN
    const found = await gateway.findByIsbn('isbn-A');

    // then the seeded metadata is returned
    expect(found).toEqual(metadata);
  });

  it('returns null for an ISBN that was never seeded', async () => {
    // given a fresh gateway with no seeded entries
    const gateway = new InMemoryIsbnLookupGateway();

    // when findByIsbn is called with an unseeded ISBN
    const found = await gateway.findByIsbn('never-seeded');

    // then null is returned
    expect(found).toBeNull();
  });

  it('stores multiple ISBNs independently', async () => {
    // given a gateway seeded with two distinct ISBNs
    const gateway = new InMemoryIsbnLookupGateway();
    const metadataA = { title: 'Refactoring', authors: ['Martin Fowler'] };
    const metadataB = { title: 'Clean Code', authors: ['Robert C. Martin'] };
    gateway.seed('isbn-A', metadataA);
    gateway.seed('isbn-B', metadataB);

    // when each ISBN is looked up
    const foundA = await gateway.findByIsbn('isbn-A');
    const foundB = await gateway.findByIsbn('isbn-B');

    // then each returns its own seeded metadata
    expect(foundA).toEqual(metadataA);
    expect(foundB).toEqual(metadataB);
  });

  it('returns a thenable so callers can await the lookup', async () => {
    // given a gateway seeded with metadata for an ISBN
    const gateway = new InMemoryIsbnLookupGateway();
    const metadata = { title: 'Domain-Driven Design', authors: ['Eric Evans'] };
    gateway.seed('isbn-A', metadata);

    // when findByIsbn is called without awaiting
    const pending = gateway.findByIsbn('isbn-A');

    // then the return value is a thenable that resolves to the seeded metadata
    expect(typeof (pending as { then?: unknown }).then).toBe('function');
    expect(await pending).toEqual(metadata);
  });

  it('replaces previous metadata when the same ISBN is re-seeded', async () => {
    // given a gateway already seeded with metadata for an ISBN
    const gateway = new InMemoryIsbnLookupGateway();
    const original = { title: 'Old Title', authors: ['Old Author'] };
    const replacement = { title: 'New Title', authors: ['New Author'] };
    gateway.seed('isbn-A', original);

    // when the same ISBN is seeded again with different metadata
    gateway.seed('isbn-A', replacement);

    // then findByIsbn returns the replacement (last write wins)
    expect(await gateway.findByIsbn('isbn-A')).toEqual(replacement);
  });
});
