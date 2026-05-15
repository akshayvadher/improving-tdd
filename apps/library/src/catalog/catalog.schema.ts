import { createHash } from 'node:crypto';
import { z } from 'zod';

import { InvalidBookError, InvalidCopyError, InvalidThumbnailError } from './catalog.types.js';

type SupportedThumbnailMime = 'image/jpeg' | 'image/png' | 'image/webp';

const MAX_THUMBNAIL_BYTES = 2 * 1024 * 1024;

const PNG_MAGIC = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
const JPEG_MAGIC = [0xff, 0xd8, 0xff];
const WEBP_RIFF_MAGIC = [0x52, 0x49, 0x46, 0x46];
const WEBP_FORMAT_MAGIC = [0x57, 0x45, 0x42, 0x50];

function hasPrefix(bytes: Uint8Array, prefix: number[], offset = 0): boolean {
  if (bytes.byteLength < offset + prefix.length) return false;
  for (let i = 0; i < prefix.length; i++) {
    if (bytes[offset + i] !== prefix[i]) return false;
  }
  return true;
}

function sniffImageMime(bytes: Uint8Array): SupportedThumbnailMime | null {
  if (hasPrefix(bytes, JPEG_MAGIC)) return 'image/jpeg';
  if (hasPrefix(bytes, PNG_MAGIC)) return 'image/png';
  if (hasPrefix(bytes, WEBP_RIFF_MAGIC) && hasPrefix(bytes, WEBP_FORMAT_MAGIC, 8)) {
    return 'image/webp';
  }
  return null;
}

// ISBN-10 (9 digits + digit or X) or ISBN-13 (13 digits), with optional
// hyphens or spaces allowed anywhere. Not a checksum check — that belongs
// in a richer validator if the business ever needs it.
function isValidIsbn(raw: string): boolean {
  const normalized = raw.replace(/[\s-]/g, '');
  return /^\d{9}[\dX]$/.test(normalized) || /^\d{13}$/.test(normalized);
}

const IsbnSchema = z
  .string({ required_error: 'isbn is required' })
  .trim()
  .min(1, 'isbn is required')
  .refine(isValidIsbn, (raw) => ({ message: `isbn format is invalid: ${raw}` }));

export const NewBookSchema = z.object({
  title: z.string({ required_error: 'title is required' }).trim().min(1, 'title is required'),
  authors: z
    .array(z.string().trim())
    .transform((authors) => authors.filter((author) => author.length > 0))
    .refine((authors) => authors.length > 0, 'at least one author is required'),
  isbn: IsbnSchema,
});

export const UpdateBookSchema = z
  .object({
    title: z.string({ required_error: 'title is required' }).trim().min(1, 'title is required').optional(),
    authors: z
      .array(z.string().trim())
      .transform((authors) => authors.filter((author) => author.length > 0))
      .refine((authors) => authors.length > 0, 'at least one author is required')
      .optional(),
  })
  .strict('isbn cannot be updated')
  .refine(
    (dto) => dto.title !== undefined || dto.authors !== undefined,
    'at least one of title or authors must be provided',
  );

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

export function parseUpdateBook(input: unknown): z.infer<typeof UpdateBookSchema> {
  const result = UpdateBookSchema.safeParse(input);
  if (!result.success) {
    throw new InvalidBookError(result.error.issues[0]?.message ?? 'invalid input');
  }
  return result.data;
}

export function parseIsbn(input: unknown): string {
  const result = IsbnSchema.safeParse(input);
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

export interface ParsedThumbnailUpload {
  bytes: Uint8Array;
  mimeType: SupportedThumbnailMime;
  contentHash: string;
  byteLength: number;
}

export function parseThumbnailUpload(input: {
  bytes: Uint8Array;
  declaredMimeType: string;
}): ParsedThumbnailUpload {
  const { bytes, declaredMimeType } = input;
  if (bytes.byteLength === 0) {
    throw new InvalidThumbnailError('empty');
  }
  if (bytes.byteLength > MAX_THUMBNAIL_BYTES) {
    throw new InvalidThumbnailError('oversize');
  }
  const sniffedMime = sniffImageMime(bytes);
  if (sniffedMime === null) {
    throw new InvalidThumbnailError('unsupported mime');
  }
  if (sniffedMime !== declaredMimeType) {
    throw new InvalidThumbnailError('mime mismatch');
  }
  const contentHash = createHash('sha256').update(bytes).digest('hex');
  return {
    bytes,
    mimeType: sniffedMime,
    contentHash,
    byteLength: bytes.byteLength,
  };
}
