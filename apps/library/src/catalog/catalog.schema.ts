import { z } from 'zod';

import { InvalidBookError, InvalidCopyError } from './catalog.types.js';

// ISBN-10 (9 digits + digit or X) or ISBN-13 (13 digits), with optional
// hyphens or spaces allowed anywhere. Not a checksum check — that belongs
// in a richer validator if the business ever needs it.
function isValidIsbn(raw: string): boolean {
  const normalized = raw.replace(/[\s-]/g, '');
  return /^\d{9}[\dX]$/.test(normalized) || /^\d{13}$/.test(normalized);
}

export const NewBookSchema = z.object({
  title: z.string({ required_error: 'title is required' }).trim().min(1, 'title is required'),
  authors: z
    .array(z.string().trim())
    .transform((authors) => authors.filter((author) => author.length > 0))
    .refine((authors) => authors.length > 0, 'at least one author is required'),
  isbn: z
    .string({ required_error: 'isbn is required' })
    .trim()
    .min(1, 'isbn is required')
    .refine(isValidIsbn, (raw) => ({ message: `isbn format is invalid: ${raw}` })),
});

export const NewCopySchema = z.object({
  bookId: z.string(),
  condition: z.enum(['NEW', 'GOOD', 'FAIR', 'POOR'], {
    errorMap: () => ({ message: 'condition must be one of NEW, GOOD, FAIR, POOR' }),
  }),
});

export function parseNewBook(input: unknown): z.infer<typeof NewBookSchema> {
  const result = NewBookSchema.safeParse(input);
  if (!result.success) {
    throw new InvalidBookError(result.error.issues[0]?.message ?? 'invalid input');
  }
  return result.data;
}

export function parseNewCopy(input: unknown): z.infer<typeof NewCopySchema> {
  const result = NewCopySchema.safeParse(input);
  if (!result.success) {
    throw new InvalidCopyError(result.error.issues[0]?.message ?? 'invalid input');
  }
  return result.data;
}
