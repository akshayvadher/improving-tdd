export type ChatMessage = {
  role: 'user' | 'assistant' | 'system';
  content: string;
};

export type ChatRequest = {
  messages: ChatMessage[];
};

export class InvalidChatRequestError extends Error {
  constructor(reason: string) {
    super(`Invalid chat request: ${reason}`);
    this.name = 'InvalidChatRequestError';
  }
}

// Internal plumbing — NOT re-exported from index.ts.
export type ChatFrame =
  | { type: 'delta'; text: string }
  | { type: 'done' }
  | { type: 'error'; message: string };
