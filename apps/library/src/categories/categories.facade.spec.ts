import { describe, expect, it } from 'vitest';

import { createCategoriesFacade } from './categories.configuration.js';
import {
  CategoryNotFoundError,
  DuplicateCategoryError,
  InvalidCategoryError,
} from './categories.types.js';

// Deterministic id generator so category ids are predictable in assertions.
function sequentialIds(prefix = 'category'): () => string {
  let counter = 0;
  return () => `${prefix}-${++counter}`;
}

// Frozen clock so createdAt is predictable.
const FIXED_NOW = new Date('2030-01-15T12:00:00.000Z');
const fixedClock = (): Date => FIXED_NOW;

describe('CategoriesFacade', () => {
  describe('createCategory', () => {
    it('returns a Category with the given name, a generated id, and a createdAt stamped from the clock', async () => {
      // given a facade wired with deterministic id/clock factories
      const categories = createCategoriesFacade({
        newId: sequentialIds(),
        clock: fixedClock,
      });

      // when a category is created with a name
      const category = await categories.createCategory({ name: 'Fiction' });

      // then the returned Category carries the name, the generated id, and the clock's timestamp
      expect(category.id).toBe('category-1');
      expect(category.name).toBe('Fiction');
      expect(category.createdAt).toEqual(FIXED_NOW);
    });

    it('persists the created category so it can be found by id afterwards', async () => {
      // given a facade
      const categories = createCategoriesFacade({ newId: sequentialIds(), clock: fixedClock });

      // when a category is created
      const created = await categories.createCategory({ name: 'Fiction' });

      // then the same category is retrievable by id
      const found = await categories.findCategoryById(created.id);
      expect(found).toEqual(created);
    });

    it('trims surrounding whitespace from the name before persisting', async () => {
      // given a facade
      const categories = createCategoriesFacade({ newId: sequentialIds(), clock: fixedClock });

      // when a category is created with a padded name
      const created = await categories.createCategory({ name: '  Fiction  ' });

      // then the stored name is trimmed
      expect(created.name).toBe('Fiction');
    });

    it('throws DuplicateCategoryError when a second create uses the same name', async () => {
      // given a facade that already has a "Fiction" category
      const categories = createCategoriesFacade({ newId: sequentialIds(), clock: fixedClock });
      await categories.createCategory({ name: 'Fiction' });

      // when a second create uses the same name, then it rejects with DuplicateCategoryError
      await expect(categories.createCategory({ name: 'Fiction' })).rejects.toBeInstanceOf(
        DuplicateCategoryError,
      );
    });

    it('throws InvalidCategoryError when the name is an empty string', async () => {
      // given a facade
      const categories = createCategoriesFacade();

      // when / then creating with an empty name rejects with InvalidCategoryError
      await expect(categories.createCategory({ name: '' })).rejects.toBeInstanceOf(
        InvalidCategoryError,
      );
    });

    it('throws InvalidCategoryError when the name is whitespace only', async () => {
      // given a facade
      const categories = createCategoriesFacade();

      // when / then creating with a whitespace-only name rejects with InvalidCategoryError
      await expect(categories.createCategory({ name: '   ' })).rejects.toBeInstanceOf(
        InvalidCategoryError,
      );
    });

    it('calls the injected newId factory once per create so ids are deterministic', async () => {
      // given a facade wired with a sequential id generator
      const categories = createCategoriesFacade({
        newId: sequentialIds('cat'),
        clock: fixedClock,
      });

      // when three distinct categories are created in order
      const first = await categories.createCategory({ name: 'Fiction' });
      const second = await categories.createCategory({ name: 'History' });
      const third = await categories.createCategory({ name: 'Science' });

      // then the ids come from the injected generator in sequence
      expect(first.id).toBe('cat-1');
      expect(second.id).toBe('cat-2');
      expect(third.id).toBe('cat-3');
    });

    it('calls the injected clock for createdAt so timestamps are deterministic', async () => {
      // given a facade whose clock advances by one day per call
      const timestamps = [
        new Date('2030-01-15T00:00:00.000Z'),
        new Date('2030-01-16T00:00:00.000Z'),
      ];
      let tick = 0;
      const categories = createCategoriesFacade({
        newId: sequentialIds(),
        clock: () => timestamps[tick++]!,
      });

      // when two categories are created in order
      const first = await categories.createCategory({ name: 'Fiction' });
      const second = await categories.createCategory({ name: 'History' });

      // then each category carries the clock reading taken at its creation
      expect(first.createdAt).toEqual(timestamps[0]);
      expect(second.createdAt).toEqual(timestamps[1]);
    });
  });

  describe('findCategoryById', () => {
    it('returns the stored category for a known id', async () => {
      // given a facade with one stored category
      const categories = createCategoriesFacade({ newId: sequentialIds(), clock: fixedClock });
      const created = await categories.createCategory({ name: 'Fiction' });

      // when the category is looked up by id
      const found = await categories.findCategoryById(created.id);

      // then the stored category is returned
      expect(found).toEqual(created);
    });

    it('throws CategoryNotFoundError for an unknown id', async () => {
      // given an empty facade
      const categories = createCategoriesFacade();

      // when / then a lookup with an unknown id rejects with CategoryNotFoundError
      await expect(categories.findCategoryById('unknown-id')).rejects.toBeInstanceOf(
        CategoryNotFoundError,
      );
    });
  });

  describe('listByPrefix', () => {
    // Seeds in this block deliberately avoid lowercase-before-uppercase ambiguity
    // ('apple' vs 'Art'). JS localeCompare (en-US) orders case-mixed names
    // differently from Postgres default collation (byte order). Every seed here
    // sorts identically under both collations, keeping the facade spec an honest
    // mirror of the PGlite spec. See categories.pglite.spec.ts for the
    // substrate-ordering findings.
    it('returns matches sorted by name ASC for a given prefix', async () => {
      // given four categories seeded with names that sort identically under JS and Postgres collation
      const categories = createCategoriesFacade({ newId: sequentialIds(), clock: fixedClock });
      await categories.createCategory({ name: 'Apple' });
      await categories.createCategory({ name: 'art' });
      await categories.createCategory({ name: 'Banana' });
      await categories.createCategory({ name: 'blueberry' });

      // when the prefix 'a' is queried
      const matches = await categories.listByPrefix('a');

      // then only the a-prefixed names are returned, in ASC order
      expect(matches.map((category) => category.name)).toEqual(['Apple', 'art']);
    });

    it('returns [] when no category name matches the prefix', async () => {
      // given a facade with a couple of unrelated categories
      const categories = createCategoriesFacade({ newId: sequentialIds(), clock: fixedClock });
      await categories.createCategory({ name: 'Fiction' });
      await categories.createCategory({ name: 'History' });

      // when a prefix that matches nothing is queried
      const matches = await categories.listByPrefix('zzz');

      // then the result is an empty array, not an error
      expect(matches).toEqual([]);
    });

    it('matches case-insensitively so prefix "a" finds both "Apple" and "art"', async () => {
      // given names with mixed casing
      const categories = createCategoriesFacade({ newId: sequentialIds(), clock: fixedClock });
      await categories.createCategory({ name: 'Apple' });
      await categories.createCategory({ name: 'art' });
      await categories.createCategory({ name: 'Banana' });

      // when the lowercase prefix 'a' is queried
      const matches = await categories.listByPrefix('a');

      // then both case variants are in the result (set check; order asserted elsewhere)
      const names = matches.map((category) => category.name);
      expect(names).toHaveLength(2);
      expect(new Set(names)).toEqual(new Set(['Apple', 'art']));
    });

    it('caps the result at 100 rows even when more categories match the prefix', async () => {
      // given 101 cat-prefixed categories seeded via a loop (names sort identically under JS and Postgres)
      const categories = createCategoriesFacade({ newId: sequentialIds('cat'), clock: fixedClock });
      for (let index = 0; index <= 100; index += 1) {
        await categories.createCategory({ name: `cat${String(index).padStart(3, '0')}` });
      }

      // when the prefix 'cat' is queried
      const matches = await categories.listByPrefix('cat');

      // then exactly 100 rows come back and the first one is 'cat000' (ordered ASC)
      expect(matches).toHaveLength(100);
      expect(matches[0]?.name).toBe('cat000');
      expect(matches[99]?.name).toBe('cat099');
    });
  });
});
