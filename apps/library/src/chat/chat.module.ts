// Environment configuration:
//   OPENAI_API_KEY — optional. Slice 4 wires the real OpenAiChatGateway when
//   this is set to a non-empty string; this slice ships with the factory
//   already reading the env var but both branches instantiating the
//   InMemoryChatGateway until the real adapter lands. No `.env` file
//   convention exists in this repo; export the variable in the shell or a
//   process manager before booting the HTTP server.

import { Module } from '@nestjs/common';

import type { ChatGateway } from '../shared/chat-gateway/chat-gateway.js';
import { InMemoryChatGateway } from '../shared/chat-gateway/in-memory-chat-gateway.js';
import { ChatFacade } from './chat.facade.js';

export const CHAT_GATEWAY = Symbol('ChatGateway');

function selectChatGateway(): ChatGateway {
  const apiKey = process.env.OPENAI_API_KEY;
  if (apiKey) {
    // TODO(Slice 4): return new OpenAiChatGateway({ apiKey });
    return new InMemoryChatGateway();
  }
  return new InMemoryChatGateway();
}

@Module({
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
