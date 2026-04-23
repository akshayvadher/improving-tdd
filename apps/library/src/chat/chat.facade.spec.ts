import { describe, expect, it } from 'vitest';

import type { ChatDelta } from '../shared/chat-gateway/chat-delta.js';
import type { ChatGateway } from '../shared/chat-gateway/chat-gateway.js';
import { InMemoryChatGateway } from '../shared/chat-gateway/in-memory-chat-gateway.js';
import { createChatFacade } from './chat.configuration.js';
import type { ChatFacade } from './chat.facade.js';
import { type ChatFrame, type ChatMessage, InvalidChatRequestError } from './chat.types.js';
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

describe('chat — gateway failures', () => {
  it('yields only a terminal error frame when the gateway throws before streaming (AC-5.2)', async () => {
    // given a throwing wrapper armed to fail BEFORE any delta yields
    const delegate = new InMemoryChatGateway();
    const gateway = new ThrowingOnceChatGateway(delegate);
    gateway.armFailureBeforeStream(new Error('upstream down'));
    const facade = createChatFacade({ gateway });

    // when the facade streams the request
    const frames = await collectFrames(facade, sampleChatRequest());

    // then the ONLY frame is the terminal error — no done frame follows
    expect(frames).toEqual([{ type: 'error', message: 'upstream down' }]);
  });

  it('yields prior deltas then a terminal error frame when the gateway throws mid-stream (AC-5.3)', async () => {
    // given an underlying gateway seeded with two deltas for "hi"
    const delegate = new InMemoryChatGateway();
    delegate.reply('hi', [{ text: 'hel' }, { text: 'lo' }]);
    const gateway = new ThrowingOnceChatGateway(delegate);
    const facade = createChatFacade({ gateway });

    // when the facade streams — we pull the first frame, arm a mid-stream
    // failure between yields, then drain the rest. This pins AC-5.3's timing:
    // the arming fires AFTER the first delta has surfaced.
    const iterator = facade
      .streamChat({
        messages: [{ role: 'user', content: 'hi' }],
      })
      [Symbol.asyncIterator]();
    const frames: ChatFrame[] = [];
    const first = await iterator.next();
    if (!first.done) frames.push(first.value);
    gateway.armFailureMidStream(new Error('midway'));
    for (;;) {
      const next = await iterator.next();
      if (next.done) break;
      frames.push(next.value);
    }

    // then the first delta surfaces, then a terminal error frame — no done
    expect(frames).toEqual([
      { type: 'delta', text: 'hel' },
      { type: 'error', message: 'midway' },
    ]);
  });

  it('succeeds end-to-end on the next streamChat call after a failure has fired (AC-5.4)', async () => {
    // given a gateway seeded for "hi" and armed to fail once before streaming
    const delegate = new InMemoryChatGateway();
    delegate.reply('hi', [{ text: 'hello' }]);
    const gateway = new ThrowingOnceChatGateway(delegate);
    gateway.armFailureBeforeStream(new Error('transient'));
    const facade = createChatFacade({ gateway });

    // when the first call fires the armed error
    const firstFrames = await collectFrames(facade, {
      messages: [{ role: 'user', content: 'hi' }],
    });

    // then a terminal error frame is produced
    expect(firstFrames).toEqual([{ type: 'error', message: 'transient' }]);

    // and when the facade streams again (arming is single-shot, now clear)
    const secondFrames = await collectFrames(facade, {
      messages: [{ role: 'user', content: 'hi' }],
    });

    // then the second call succeeds end to end — deltas then done
    expect(secondFrames).toEqual([{ type: 'delta', text: 'hello' }, { type: 'done' }]);
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

// --- ThrowingOnceChatGateway -----------------------------------------------
// Spec-local wrapper that decorates a real in-memory ChatGateway and throws on
// the next stream() call (before-stream) or on the next yield within an
// already-open stream (mid-stream) when armed. Single-shot — clears the arming
// after firing so the subsequent call behaves normally. Mirrors
// ThrowingOnceIsbnLookupGateway in catalog.facade.spec.ts:551-573 — the
// streaming-port twin of that teaching moment. Intentionally NOT exported —
// this is the canonical teaching moment for Principle 13.
class ThrowingOnceChatGateway implements ChatGateway {
  private armedError: Error | null = null;
  private armedPhase: 'before-stream' | 'mid-stream' = 'before-stream';

  constructor(private readonly delegate: ChatGateway) {}

  armFailureBeforeStream(error: Error): void {
    this.armedError = error;
    this.armedPhase = 'before-stream';
  }

  armFailureMidStream(error: Error): void {
    this.armedError = error;
    this.armedPhase = 'mid-stream';
  }

  async *stream(messages: ChatMessage[]): AsyncIterable<ChatDelta> {
    if (this.armedError && this.armedPhase === 'before-stream') {
      const err = this.armedError;
      this.armedError = null;
      throw err;
    }
    for await (const delta of this.delegate.stream(messages)) {
      if (this.armedError && this.armedPhase === 'mid-stream') {
        const err = this.armedError;
        this.armedError = null;
        throw err;
      }
      yield delta;
    }
  }
}
