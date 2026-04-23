import type { CategoryRepository } from './category.repository.js';
import { DuplicateCategoryError, type Category, type CategoryId } from './categories.types.js';

const MAX_PREFIX_RESULTS = 100;

export class InMemoryCategoryRepository implements CategoryRepository {
  private readonly categoriesById = new Map<CategoryId, Category>();

  async save(category: Category): Promise<void> {
    for (const existing of this.categoriesById.values()) {
      if (existing.id !== category.id && existing.name === category.name) {
        throw new DuplicateCategoryError(category.name);
      }
    }
    this.categoriesById.set(category.id, { ...category });
  }

  async findById(id: CategoryId): Promise<Category | undefined> {
    const stored = this.categoriesById.get(id);
    return stored ? { ...stored } : undefined;
  }

  async findByNamePrefix(prefix: string): Promise<Category[]> {
    const lowerPrefix = prefix.toLowerCase();
    const matches: Category[] = [];
    for (const category of this.categoriesById.values()) {
      if (category.name.toLowerCase().startsWith(lowerPrefix)) {
        matches.push({ ...category });
      }
    }
    matches.sort((a, b) => a.name.localeCompare(b.name));
    return matches.slice(0, MAX_PREFIX_RESULTS);
  }
}
