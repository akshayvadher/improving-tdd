import type { Category } from './categories.types.js';

export function sampleCategory(overrides: Partial<Category> = {}): Category {
  return {
    id: '00000000-0000-0000-0000-000000000001',
    name: 'Fiction',
    createdAt: new Date('2030-01-15T00:00:00.000Z'),
    ...overrides,
  };
}
