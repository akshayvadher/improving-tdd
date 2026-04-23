import { describe, expect, it } from 'vitest';

import { createCategoriesFacade } from './categories.configuration.js';
import { CategoriesController } from './categories.controller.js';
import { InvalidCategoriesQueryError } from './categories.types.js';

// The controller's startsWith guard is a pure function of its input — no Nest
// boot needed to verify it. This spec fills the gap left by "no HTTP-through-
// Postgres crucial-path test for Categories" (explicit spec non-goal): the 400
// path on missing/blank startsWith must still be covered somewhere.

// The guard throws synchronously (before a Promise is returned); Nest's
// exception filter handles sync throws from Promise-returning handlers just
// fine at the HTTP layer, but a direct-call unit test must assert on the sync
// throw rather than use `.rejects`.

describe('CategoriesController', () => {
  describe('listByPrefix', () => {
    it('throws InvalidCategoriesQueryError when startsWith is undefined', () => {
      // given a controller backed by an in-memory facade
      const controller = new CategoriesController(createCategoriesFacade());

      // when / then listByPrefix is called without any startsWith at all
      expect(() => controller.listByPrefix(undefined)).toThrow(InvalidCategoriesQueryError);
    });

    it('throws InvalidCategoriesQueryError when startsWith is an empty string', () => {
      // given a controller backed by an in-memory facade
      const controller = new CategoriesController(createCategoriesFacade());

      // when / then listByPrefix is called with an empty startsWith
      expect(() => controller.listByPrefix('')).toThrow(InvalidCategoriesQueryError);
    });

    it('throws InvalidCategoriesQueryError when startsWith is whitespace only', () => {
      // given a controller backed by an in-memory facade
      const controller = new CategoriesController(createCategoriesFacade());

      // when / then listByPrefix is called with a whitespace-only startsWith
      expect(() => controller.listByPrefix('   ')).toThrow(InvalidCategoriesQueryError);
    });

    it('returns an empty array for a valid prefix against an empty repository', async () => {
      // given a controller wired to a facade over an empty in-memory repo
      const controller = new CategoriesController(createCategoriesFacade());

      // when listByPrefix is called with a non-blank prefix
      const matches = await controller.listByPrefix('a');

      // then the guard passes and the facade returns []
      expect(matches).toEqual([]);
    });
  });
});
