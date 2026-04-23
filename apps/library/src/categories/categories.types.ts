export type CategoryId = string;

export interface Category {
  id: CategoryId;
  name: string;
  createdAt: Date;
}

export class CategoryNotFoundError extends Error {
  constructor(identifier: string) {
    super(`Category not found: ${identifier}`);
    this.name = 'CategoryNotFoundError';
  }
}

export class DuplicateCategoryError extends Error {
  constructor(name: string) {
    super(`A category with name ${name} already exists`);
    this.name = 'DuplicateCategoryError';
  }
}

export class InvalidCategoryError extends Error {
  readonly reason: string;

  constructor(reason: string) {
    super(`Invalid category: ${reason}`);
    this.name = 'InvalidCategoryError';
    this.reason = reason;
  }
}

export class InvalidCategoriesQueryError extends Error {
  readonly reason: string;

  constructor(reason: string) {
    super(`Invalid categories query: ${reason}`);
    this.name = 'InvalidCategoriesQueryError';
    this.reason = reason;
  }
}
