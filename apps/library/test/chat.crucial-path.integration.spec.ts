import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { CHAT_GATEWAY, ChatModule } from '../src/chat/chat.module.js';
import type { ChatGateway } from '../src/shared/chat-gateway/chat-gateway.js';
import { InMemoryChatGateway } from '../src/shared/chat-gateway/in-memory-chat-gateway.js';
import { DomainErrorFilter } from '../src/shared/http/domain-error.filter.js';
import { streamChat } from './support/interactions/chat-interactions.js';

async function buildChatApp(gateway: ChatGateway): Promise<INestApplication> {
  const moduleRef = await Test.createTestingModule({ imports: [ChatModule] })
    .overrideProvider(CHAT_GATEWAY)
    .useValue(gateway)
    .compile();

  const app = moduleRef.createNestApplication({ logger: false });
  app.useGlobalFilters(new DomainErrorFilter());
  await app.init();
  return app;
}

describe('Chat crucial path (HTTP SSE)', () => {
  let gateway: InMemoryChatGateway;
  let app: INestApplication;

  beforeEach(async () => {
    gateway = new InMemoryChatGateway();
  });

  afterEach(async () => {
    if (app) {
      await app.close();
    }
  });

  it('streams multiple deltas then a terminal done frame for a seeded prompt', async () => {
    // given a gateway seeded with two deltas for "hello"
    gateway.reply('hello', [{ text: 'hi' }, { text: ' there' }]);
    app = await buildChatApp(gateway);

    // when the client posts a chat request
    const response = await streamChat(app, {
      messages: [{ role: 'user', content: 'hello' }],
    });

    // then HTTP 200 with SSE framing and deltas followed by done — in order
    expect(response.status).toBe(200);
    expect(response.contentType).toContain('text/event-stream');
    expect(response.frames).toEqual([
      { event: 'delta', data: { text: 'hi' } },
      { event: 'delta', data: { text: ' there' } },
      { event: 'done', data: {} },
    ]);

    // and the wire-level framing carries literal `event: delta` / `event: done`
    // lines and `data: {...}` JSON payloads — guards against silent
    // serialization drift that a structured-frame parser would hide
    expect(response.rawBody).toContain('event: delta\n');
    expect(response.rawBody).toContain('data: {"text":"hi"}\n');
    expect(response.rawBody).toContain('event: done\n');
    expect(response.rawBody).toContain('data: {}\n');
  });

  it('closes the response after the done frame with no trailing frames', async () => {
    // given a gateway seeded with one delta so we have a predictable done position
    gateway.reply('hello', [{ text: 'hi' }]);
    app = await buildChatApp(gateway);

    // when the client posts a chat request and buffers the full body
    const response = await streamChat(app, {
      messages: [{ role: 'user', content: 'hello' }],
    });

    // then `done` is the final frame — nothing appears after it
    const doneIndex = response.frames.findIndex((frame) => frame.event === 'done');
    expect(doneIndex).toBeGreaterThanOrEqual(0);
    expect(response.frames).toHaveLength(doneIndex + 1);
  });

  it('streams a single delta then done for a single-delta seeded prompt', async () => {
    // given a gateway seeded with a single delta
    gateway.reply('hello', [{ text: 'hi' }]);
    app = await buildChatApp(gateway);

    // when the client posts the chat request
    const response = await streamChat(app, {
      messages: [{ role: 'user', content: 'hello' }],
    });

    // then one delta frame then one done frame is emitted as an SSE stream
    expect(response.status).toBe(200);
    expect(response.contentType).toContain('text/event-stream');
    expect(response.frames).toEqual([
      { event: 'delta', data: { text: 'hi' } },
      { event: 'done', data: {} },
    ]);
  });

  it('returns 400 InvalidChatRequestError when messages is missing', async () => {
    // given a running chat app (no seeding needed — validation fails before streaming)
    app = await buildChatApp(gateway);

    // when the client posts a body without messages
    const response = await streamChat(app, {});

    // then a plain JSON 400 is returned (no SSE framing)
    expect(response.status).toBe(400);
    expect(response.contentType).toContain('application/json');
    const parsed = JSON.parse(response.rawBody) as {
      statusCode: number;
      error: string;
      message: string;
    };
    expect(parsed.statusCode).toBe(400);
    expect(parsed.error).toBe('InvalidChatRequestError');
    expect(parsed.message).toContain('Invalid chat request');
  });

  it('returns 400 InvalidChatRequestError when content is whitespace-only', async () => {
    // given a running chat app
    app = await buildChatApp(gateway);

    // when the client posts a message whose content is only whitespace
    const response = await streamChat(app, {
      messages: [{ role: 'user', content: '   ' }],
    });

    // then a plain JSON 400 InvalidChatRequestError is returned
    expect(response.status).toBe(400);
    expect(response.contentType).toContain('application/json');
    const parsed = JSON.parse(response.rawBody) as {
      statusCode: number;
      error: string;
    };
    expect(parsed.statusCode).toBe(400);
    expect(parsed.error).toBe('InvalidChatRequestError');
  });

  it('returns 400 InvalidChatRequestError when a role is invalid', async () => {
    // given a running chat app
    app = await buildChatApp(gateway);

    // when the client posts a message with an invalid role
    const response = await streamChat(app, {
      messages: [{ role: 'bot', content: 'hi' }],
    });

    // then a plain JSON 400 InvalidChatRequestError is returned
    expect(response.status).toBe(400);
    expect(response.contentType).toContain('application/json');
    const parsed = JSON.parse(response.rawBody) as {
      statusCode: number;
      error: string;
    };
    expect(parsed.statusCode).toBe(400);
    expect(parsed.error).toBe('InvalidChatRequestError');
  });

});
