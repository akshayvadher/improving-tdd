import { z } from 'zod';

import { InvalidChatRequestError, type ChatRequest } from './chat.types.js';

const chatMessageSchema = z.object({
  role: z.enum(['user', 'assistant', 'system']),
  content: z
    .string()
    .transform((s) => s.trim())
    .refine((s) => s.length > 0, 'content must be non-empty after trim'),
});

const chatRequestSchema = z.object({
  messages: z.array(chatMessageSchema).min(1, 'messages must contain at least one entry'),
});

export function parseChatRequest(input: unknown): ChatRequest {
  const result = chatRequestSchema.safeParse(input);
  if (!result.success) {
    throw new InvalidChatRequestError(result.error.issues[0]?.message ?? 'invalid input');
  }
  return result.data;
}
