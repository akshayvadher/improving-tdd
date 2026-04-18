import { z } from 'zod';

import { InvalidMemberError } from './membership.types.js';

// Simple format check: one @, non-empty local part, a dotted domain. Not
// RFC 5322 — good enough for a domain invariant; exotic addresses can be
// rejected at the transport layer if the business ever cares.
const EMAIL_FORMAT = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export const NewMemberSchema = z.object({
  name: z
    .string({ required_error: 'name is required' })
    .trim()
    .min(1, 'name is required'),
  email: z
    .string({ required_error: 'email is required' })
    .trim()
    .min(1, 'email is required')
    .refine(
      (email) => EMAIL_FORMAT.test(email),
      (email) => ({ message: `email format is invalid: ${email}` }),
    ),
});

export function parseNewMember(input: unknown): z.infer<typeof NewMemberSchema> {
  const result = NewMemberSchema.safeParse(input);
  if (!result.success) {
    throw new InvalidMemberError(result.error.issues[0]?.message ?? 'invalid input');
  }
  return result.data;
}
