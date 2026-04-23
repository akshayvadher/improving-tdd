// Environment configuration:
//   OPENAI_API_KEY — optional. When set to a non-empty string, the chat module
//   wires the real OpenAiChatGateway. When absent or empty, it falls back to
//   the in-memory default so `pnpm test` stays network-free. No `.env` file
//   convention exists in this repo; export the variable in the shell or a
//   process manager before booting the HTTP server.

import { Module } from '@nestjs/common';

import type { ChatGateway } from '../shared/chat-gateway/chat-gateway.js';
import { InMemoryChatGateway } from '../shared/chat-gateway/in-memory-chat-gateway.js';
import { OpenAiChatGateway } from '../shared/chat-gateway/openai-chat-gateway.js';
import { ChatController } from './chat.controller.js';
import { ChatFacade } from './chat.facade.js';

export const CHAT_GATEWAY = Symbol('ChatGateway');

function selectChatGateway(): ChatGateway {
  const apiKey = process.env.OPENAI_API_KEY;
  if (apiKey) {
    return new OpenAiChatGateway({ apiKey });
  }
  return new InMemoryChatGateway();
}

@Module({
  controllers: [ChatController],
  providers: [
    {
      provide: CHAT_GATEWAY,
      useFactory: selectChatGateway,
    },
    {
      provide: ChatFacade,
      useFactory: (gateway: ChatGateway) => new ChatFacade(gateway),
      inject: [CHAT_GATEWAY],
    },
  ],
  exports: [ChatFacade],
})
export class ChatModule {}
