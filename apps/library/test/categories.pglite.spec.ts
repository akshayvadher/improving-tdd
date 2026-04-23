import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { DrizzleCategoryRepository } from '../src/categories/drizzle-category.repository.js';
import { sampleCategory } from '../src/categories/sample-categories-data.js';
import {
  DuplicateCategoryError,
  type Category,
} from '../src/categories/categories.types.js';
import { categories } from '../src/db/schema/index.js';
import { startPglite, type PgliteFixture } from './support/pglite.js';

// Same CategoryRepository contract as categories.facade.spec.ts, but exercised
// against a real Postgres query engine via PGlite (WASM, in-process). No Docker.
// If this spec is red, the PGlite substrate isn't working — this is the
// load-bearing verification of test/support/pglite.ts.

describe('DrizzleCategoryRepository (real Postgres via PGlite)', () => {
  let fixture: PgliteFixture;
  let repository: DrizzleCategoryRepository;

  beforeAll(async () => {
    fixture = await startPglite();
    repository = new DrizzleCategoryRepository(fixture.db);
  });

  afterAll(async () => {
    if (fixture) {
      await fixture.close();
    }
  });

  beforeEach(async () => {
    // Each test gets an empty categories table so rows from earlier cases
    // don't leak into findById assertions or collide on the name UNIQUE.
    await fixture.db.delete(categories);
  });

  it('round-trips a saved category through save and findById with every field preserved', async () => {
    // given a fully-populated category DTO
    const category: Category = sampleCategory({
      id: '11111111-1111-1111-1111-111111111111',
      name: 'Fiction',
      createdAt: new Date('2030-01-15T12:00:00.000Z'),
    });

    // when it is saved and then fetched by id
    await repository.save(category);
    const found = await repository.findById(category.id);

    // then every field round-trips identically
    expect(found).toBeDefined();
    expect(found?.id).toBe(category.id);
    expect(found?.name).toBe(category.name);
    expect(found?.createdAt.getTime()).toBe(category.createdAt.getTime());
  });

  it('returns undefined from findById for an unknown id', async () => {
    // given no category with this id has been saved

    // when findById is called with an unknown id
    const found = await repository.findById('99999999-9999-9999-9999-999999999999');

    // then the repository reports miss as undefined, matching the interface contract
    expect(found).toBeUndefined();
  });

  it('throws DuplicateCategoryError when save is called with a name that already exists', async () => {
    // given a category named "Fiction" already saved
    await repository.save(
      sampleCategory({
        id: '22222222-2222-2222-2222-222222222222',
        name: 'Fiction',
      }),
    );

    // when a second save uses the same name but a different id
    const duplicate = sampleCategory({
      id: '33333333-3333-3333-3333-333333333333',
      name: 'Fiction',
    });

    // then it rejects with DuplicateCategoryError — exercises the Postgres 23505 catch path
    await expect(repository.save(duplicate)).rejects.toBeInstanceOf(DuplicateCategoryError);
  });

  describe('findByNamePrefix', () => {
    // Ordering note: Postgres under PGlite uses its default ("C"-like) collation,
    // which sorts by code point — every uppercase letter precedes every lowercase
    // letter. JS localeCompare (en-US) uses case-insensitive primary ordering.
    // Seeds here are chosen so both substrates observably agree, keeping the
    // "same contract, two substrates" teaching point honest. If a future seed
    // puts lowercase-first under JS but uppercase-first under Postgres, the unit
    // and PGlite specs would disagree — that's a real divergence to surface, not
    // a flaky test.

    function seedCategory(name: string, id: string): Category {
      return sampleCategory({
        id,
        name,
        createdAt: new Date('2030-01-15T12:00:00.000Z'),
      });
    }

    it('returns matching categories for a prefix sorted ASC by name', async () => {
      // given four categories with names that sort identically under JS and Postgres collation
      await repository.save(seedCategory('Apple', '10000000-0000-0000-0000-000000000001'));
      await repository.save(seedCategory('art', '10000000-0000-0000-0000-000000000002'));
      await repository.save(seedCategory('Banana', '10000000-0000-0000-0000-000000000003'));
      await repository.save(seedCategory('Cat', '10000000-0000-0000-0000-000000000004'));

      // when the prefix 'a' is queried
      const matches = await repository.findByNamePrefix('a');

      // then both a-prefixed names come back in ASC order (uppercase before lowercase under PG's default collation)
      expect(matches.map((category) => category.name)).toEqual(['Apple', 'art']);
    });

    it('returns a single match for a prefix with only one hit', async () => {
      // given four seeded categories
      await repository.save(seedCategory('Apple', '20000000-0000-0000-0000-000000000001'));
      await repository.save(seedCategory('art', '20000000-0000-0000-0000-000000000002'));
      await repository.save(seedCategory('Banana', '20000000-0000-0000-0000-000000000003'));
      await repository.save(seedCategory('Cat', '20000000-0000-0000-0000-000000000004'));

      // when the prefix 'b' is queried
      const matches = await repository.findByNamePrefix('b');

      // then only Banana comes back
      expect(matches.map((category) => category.name)).toEqual(['Banana']);
    });

    it('returns [] for a prefix with no matches', async () => {
      // given seeded categories that do not start with 'z'
      await repository.save(seedCategory('Apple', '30000000-0000-0000-0000-000000000001'));
      await repository.save(seedCategory('Banana', '30000000-0000-0000-0000-000000000002'));

      // when an unmatched prefix is queried
      const matches = await repository.findByNamePrefix('z');

      // then the result is an empty array (contract: miss is [], not an error)
      expect(matches).toEqual([]);
    });

    it('matches case-insensitively via ILIKE — uppercase rows satisfy a lowercase prefix', async () => {
      // given a single uppercase-only name
      await repository.save(seedCategory('ALPHA', '40000000-0000-0000-0000-000000000001'));

      // when the lowercase prefix 'a' is queried
      const matches = await repository.findByNamePrefix('a');

      // then the uppercase row is returned, proving ILIKE really is case-insensitive
      expect(matches.map((category) => category.name)).toEqual(['ALPHA']);
    });

    it('caps the result at 100 rows when more than 100 categories match the prefix', async () => {
      // given 101 cat-prefixed categories seeded via a loop
      const rows: Category[] = [];
      for (let index = 0; index <= 100; index += 1) {
        const name = `cat${String(index).padStart(3, '0')}`;
        const id = `50000000-0000-0000-0000-${String(index).padStart(12, '0')}`;
        rows.push(seedCategory(name, id));
      }
      for (const row of rows) {
        await repository.save(row);
      }

      // when the prefix 'cat' is queried
      const matches = await repository.findByNamePrefix('cat');

      // then exactly 100 rows come back, starting from 'cat000' (ASC order check)
      expect(matches).toHaveLength(100);
      expect(matches[0]?.name).toBe('cat000');
      expect(matches[99]?.name).toBe('cat099');
    });
  });
});
