import { asc, eq, ilike } from 'drizzle-orm';
import type { PgDatabase, QueryResultHKT } from 'drizzle-orm/pg-core';

import { categories } from '../db/schema/index.js';
import type { CategoryRepository } from './category.repository.js';
import { DuplicateCategoryError, type Category, type CategoryId } from './categories.types.js';

type CategoryRow = typeof categories.$inferSelect;

// Either a postgres-js Drizzle database (production) or a PGlite Drizzle
// database (pglite test substrate). Both extend PgDatabase, which exposes the
// query-builder surface this repository needs.
type AnyPgDatabase = PgDatabase<QueryResultHKT, Record<string, unknown>>;

const UNIQUE_VIOLATION = '23505';
const MAX_PREFIX_RESULTS = 100;

export class DrizzleCategoryRepository implements CategoryRepository {
  constructor(private readonly db: AnyPgDatabase) {}

  async save(category: Category): Promise<void> {
    try {
      await this.db.insert(categories).values(toRow(category));
    } catch (error) {
      if (isUniqueViolation(error)) {
        throw new DuplicateCategoryError(category.name);
      }
      throw error;
    }
  }

  async findById(id: CategoryId): Promise<Category | undefined> {
    const [row] = await this.db.select().from(categories).where(eq(categories.id, id));
    return row ? toDto(row) : undefined;
  }

  async findByNamePrefix(prefix: string): Promise<Category[]> {
    const rows = await this.db
      .select()
      .from(categories)
      .where(ilike(categories.name, `${prefix}%`))
      .orderBy(asc(categories.name))
      .limit(MAX_PREFIX_RESULTS);
    return rows.map(toDto);
  }
}

function toRow(category: Category): CategoryRow {
  return {
    id: category.id,
    name: category.name,
    createdAt: category.createdAt,
  };
}

function toDto(row: CategoryRow): Category {
  return {
    id: row.id,
    name: row.name,
    createdAt: row.createdAt,
  };
}

function isUniqueViolation(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    (error as { code?: string }).code === UNIQUE_VIOLATION
  );
}
