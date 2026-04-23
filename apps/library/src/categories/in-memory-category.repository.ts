import type { CategoryRepository } from './category.repository.js';
import { DuplicateCategoryError, type Category, type CategoryId } from './categories.types.js';

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
}
