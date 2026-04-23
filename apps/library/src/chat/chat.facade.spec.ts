import { describe, expect, it } from 'vitest';

import { InMemoryChatGateway } from '../shared/chat-gateway/in-memory-chat-gateway.js';
import { createChatFacade } from './chat.configuration.js';
import type { ChatFacade } from './chat.facade.js';
import { type ChatFrame, InvalidChatRequestError } from './chat.types.js';
import * as chatBarrel from './index.js';
import { sampleChatRequest, sampleUserMessage } from './sample-chat-data.js';

async function collectFrames(facade: ChatFacade, dto: unknown): Promise<ChatFrame[]> {
  const frames: ChatFrame[] = [];
  for await (const frame of facade.streamChat(dto)) {
    frames.push(frame);
  }
  return frames;
}

describe('ChatFacade — happy path', () => {
  it('yields each delta as a frame then a terminal done frame', async () => {
    // given a gateway seeded for "hello" with two deltas
    const gateway = new InMemoryChatGateway();
    gateway.reply('hello', [{ text: 'hi' }, { text: ' there' }]);
    const facade = createChatFacade({ gateway });

    // when the facade streams a request whose last user message is "hello"
    const frames = await collectFrames(facade, sampleChatRequest());

    // then deltas come first in order, followed by exactly one terminal done
    expect(frames).toEqual([
      { type: 'delta', text: 'hi' },
      { type: 'delta', text: ' there' },
      { type: 'done' },
    ]);
  });

  it('yields only a done frame when the gateway produces no deltas', async () => {
    // given a gateway seeded with an empty delta sequence
    const gateway = new InMemoryChatGateway();
    gateway.reply('silence', []);
    const facade = createChatFacade({ gateway });

    // when the facade streams the request
    const frames = await collectFrames(facade, {
      messages: [sampleUserMessage('silence')],
    });

    // then only a terminal done frame is yielded
    expect(frames).toEqual([{ type: 'done' }]);
  });

  it('uses a fresh in-memory gateway when no override is supplied', async () => {
    // given a facade built without any overrides
    const facade = createChatFacade();

    // when the facade streams an unseeded prompt
    const frames = await collectFrames(facade, sampleChatRequest());

    // then the default in-memory gateway yields its default-delta sequence
    expect(frames).toEqual([{ type: 'delta', text: '…' }, { type: 'done' }]);
  });
});

describe('ChatFacade — validation', () => {
  it('rejects a request with an empty messages array', async () => {
    // given a facade with the default in-memory gateway
    const facade = createChatFacade();

    // when streamChat is called with messages.length === 0
    // then InvalidChatRequestError is thrown, naming the failing constraint
    await expect(collectFrames(facade, { messages: [] })).rejects.toMatchObject({
      name: 'InvalidChatRequestError',
      message: expect.stringContaining('messages must contain at least one entry'),
    });
  });

  it('rejects a message whose role is not user, assistant, or system', async () => {
    // given a facade with the default in-memory gateway
    const facade = createChatFacade();

    // when streamChat is called with an unknown role
    // then InvalidChatRequestError is thrown — ZodError never leaks
    const call = collectFrames(facade, { messages: [{ role: 'bot', content: 'hi' }] });
    await expect(call).rejects.toBeInstanceOf(InvalidChatRequestError);
  });

  it('rejects a message whose content is whitespace-only', async () => {
    // given a facade with the default in-memory gateway
    const facade = createChatFacade();

    // when streamChat is called with only-whitespace content
    // then InvalidChatRequestError is thrown
    const call = collectFrames(facade, { messages: [{ role: 'user', content: '   ' }] });
    await expect(call).rejects.toBeInstanceOf(InvalidChatRequestError);
  });

  it('trims surrounding whitespace on non-empty content', async () => {
    // given a gateway seeded for the trimmed key "hello"
    const gateway = new InMemoryChatGateway();
    gateway.reply('hello', [{ text: 'hi' }]);
    const facade = createChatFacade({ gateway });

    // when the request's content arrives with surrounding whitespace
    const frames = await collectFrames(facade, {
      messages: [{ role: 'user', content: '  hello  ' }],
    });

    // then the trimmed content routes to the seeded script
    expect(frames).toEqual([{ type: 'delta', text: 'hi' }, { type: 'done' }]);
  });

  it('rejects a body missing the messages property entirely', async () => {
    // given a facade with the default in-memory gateway
    const facade = createChatFacade();

    // when streamChat is called with {}
    // then InvalidChatRequestError is thrown
    await expect(collectFrames(facade, {})).rejects.toBeInstanceOf(InvalidChatRequestError);
  });
});

describe('createChatFacade — gateway wiring (AC-2.9)', () => {
  it('uses the supplied gateway override instead of the in-memory default', async () => {
    // given an explicit override gateway whose scripted reply would never be
    // produced by a fresh default (which yields only '…')
    const override = new InMemoryChatGateway();
    override.reply('hello', [{ text: 'from-override' }]);
    const facade = createChatFacade({ gateway: override });

    // when the facade streams the seeded prompt
    const frames: ChatFrame[] = [];
    for await (const frame of facade.streamChat(sampleChatRequest())) {
      frames.push(frame);
    }

    // then the override's script produced the delta — proving the override ran
    expect(frames).toEqual([{ type: 'delta', text: 'from-override' }, { type: 'done' }]);
  });
});


describe('chat barrel (AC-2.12)', () => {
  it('re-exports exactly the public surface and keeps internals private', () => {
    // then the documented public surface is present at runtime / type level
    expect(chatBarrel.ChatFacade).toBeDefined();
    expect(chatBarrel.ChatModule).toBeDefined();
    expect(chatBarrel.InvalidChatRequestError).toBeDefined();

    // and internals are NOT re-exported — grepping the barrel's own keys
    // guards against an accidental `export * from './chat.schema.js'` slipping in
    const keys = Object.keys(chatBarrel);
    expect(keys).not.toContain('parseChatRequest');
    expect(keys).not.toContain('ChatController');
    expect(keys).not.toContain('InMemoryChatGateway');
    expect(keys).not.toContain('ChatGateway');
  });
});
