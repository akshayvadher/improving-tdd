import type { Category, CategoryId } from './categories.types.js';

export interface CategoryRepository {
  save(category: Category): Promise<void>;
  findById(id: CategoryId): Promise<Category | undefined>;
}
