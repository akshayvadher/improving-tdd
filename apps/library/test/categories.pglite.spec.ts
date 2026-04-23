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
});
