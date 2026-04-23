import { Injectable } from '@nestjs/common';
import type { ChatGateway } from '../shared/chat-gateway/chat-gateway.js';
import { InMemoryChatGateway } from '../shared/chat-gateway/in-memory-chat-gateway.js';
import { parseChatRequest } from './chat.schema.js';
import type { ChatFrame, ChatMessage } from './chat.types.js';

@Injectable()
export class ChatFacade {
  constructor(private readonly gateway: ChatGateway = new InMemoryChatGateway()) {}

  streamChat(dto: unknown): AsyncIterable<ChatFrame> {
    const { messages } = parseChatRequest(dto);
    return this.streamFrames(messages);
  }

  private async *streamFrames(messages: ChatMessage[]): AsyncIterable<ChatFrame> {
    try {
      for await (const delta of this.gateway.stream(messages)) {
        yield { type: 'delta', text: delta.text };
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      yield { type: 'error', message };
      return;
    }
    yield { type: 'done' };
  }
}
