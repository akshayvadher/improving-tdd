import type { ChatMessage, ChatRequest } from './chat.types.js';

export function sampleUserMessage(content = 'hello'): ChatMessage {
  return { role: 'user', content };
}

export function sampleChatRequest(overrides: Partial<ChatRequest> = {}): ChatRequest {
  return { messages: overrides.messages ?? [sampleUserMessage()] };
}
