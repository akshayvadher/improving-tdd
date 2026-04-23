import { InMemoryChatGateway } from '../shared/chat-gateway/in-memory-chat-gateway.js';
import type { ChatGateway } from '../shared/chat-gateway/chat-gateway.js';
import { ChatFacade } from './chat.facade.js';

export interface ChatOverrides {
  gateway?: ChatGateway;
}

export function createChatFacade(overrides: ChatOverrides = {}): ChatFacade {
  const gateway = overrides.gateway ?? new InMemoryChatGateway();
  return new ChatFacade(gateway);
}
