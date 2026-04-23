// Outbound streaming port for the chat module.
// Placement mirrors IsbnLookupGateway under src/shared/. Consumed only by the
// chat module — if another module needs chat capabilities, route through
// ChatFacade, not this port.

import type { ChatMessage } from '../../chat/chat.types.js';
import type { ChatDelta } from './chat-delta.js';

export interface ChatGateway {
  stream(messages: ChatMessage[]): AsyncIterable<ChatDelta>;
}
