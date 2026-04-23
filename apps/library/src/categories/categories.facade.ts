import { Injectable } from '@nestjs/common';
import { randomUUID } from 'node:crypto';

import type { CategoryRepository } from './category.repository.js';
import { parseNewCategory } from './categories.schema.js';
import { CategoryNotFoundError, type Category, type CategoryId } from './categories.types.js';

type IdGenerator = () => string;
type Clock = () => Date;

export interface NewCategoryDto {
  name: string;
}

@Injectable()
export class CategoriesFacade {
  constructor(
    private readonly repository: CategoryRepository,
    private readonly newId: IdGenerator = randomUUID,
    private readonly clock: Clock = () => new Date(),
  ) {}

  async createCategory(dto: NewCategoryDto): Promise<Category> {
    const { name } = parseNewCategory(dto);
    const category: Category = {
      id: this.newId(),
      name,
      createdAt: this.clock(),
    };
    await this.repository.save(category);
    return category;
  }

  async findCategoryById(id: CategoryId): Promise<Category> {
    const category = await this.repository.findById(id);
    if (!category) {
      throw new CategoryNotFoundError(id);
    }
    return category;
  }

  async listByPrefix(prefix: string): Promise<Category[]> {
    return this.repository.findByNamePrefix(prefix);
  }
}
