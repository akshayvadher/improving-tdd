import { z } from 'zod';

import { InvalidCategoryError } from './categories.types.js';

export const NewCategorySchema = z.object({
  name: z.string({ required_error: 'name is required' }).trim().min(1, 'name is required'),
});

export function parseNewCategory(input: unknown): z.infer<typeof NewCategorySchema> {
  const result = NewCategorySchema.safeParse(input);
  if (!result.success) {
    throw new InvalidCategoryError(result.error.issues[0]?.message ?? 'invalid input');
  }
  return result.data;
}
