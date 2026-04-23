import type { Category, CategoryId } from './categories.types.js';

export interface CategoryRepository {
  save(category: Category): Promise<void>;
  findById(id: CategoryId): Promise<Category | undefined>;
  /**
   * Return every category whose `name` starts with `prefix`, case-insensitively.
   *
   * Contract honored by every implementation:
   * - Case-insensitive prefix match (`ILIKE 'prefix%'` at the SQL layer; a
   *   case-insensitive `startsWith` check in memory).
   * - Results sorted by `name` ascending.
   * - Hard-capped at 100 rows.
   * - No matches yields `[]`, not an error.
   */
  findByNamePrefix(prefix: string): Promise<Category[]>;
}
