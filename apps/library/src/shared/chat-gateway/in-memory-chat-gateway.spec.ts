import { describe, expect, it } from 'vitest';

import type { ChatMessage } from '../../chat/chat.types.js';
import type { ChatDelta } from './chat-delta.js';
import { InMemoryChatGateway } from './in-memory-chat-gateway.js';

async function collect(stream: AsyncIterable<ChatDelta>): Promise<ChatDelta[]> {
  const deltas: ChatDelta[] = [];
  for await (const delta of stream) {
    deltas.push(delta);
  }
  return deltas;
}

function userSays(content: string): ChatMessage[] {
  return [{ role: 'user', content }];
}

describe('InMemoryChatGateway', () => {
  it('yields seeded deltas in order for a matching last-user message', async () => {
    // given a gateway seeded for the prompt "hello"
    const gateway = new InMemoryChatGateway();
    gateway.reply('hello', [{ text: 'hi' }, { text: ' there' }]);

    // when stream is called with "hello" as the last user message
    const deltas = await collect(gateway.stream(userSays('hello')));

    // then the seeded deltas are yielded in order, then the stream completes
    expect(deltas).toEqual([{ text: 'hi' }, { text: ' there' }]);
  });

  it('scopes seeded deltas to the specific last-user content', async () => {
    // given a gateway seeded with distinct replies for two prompts
    const gateway = new InMemoryChatGateway();
    gateway.reply('hello', [{ text: 'hi' }]);
    gateway.reply('bye', [{ text: 'goodbye' }]);

    // when each prompt is streamed in turn
    const helloDeltas = await collect(gateway.stream(userSays('hello')));
    const byeDeltas = await collect(gateway.stream(userSays('bye')));

    // then each prompt routes to its own seeded delta sequence
    expect(helloDeltas).toEqual([{ text: 'hi' }]);
    expect(byeDeltas).toEqual([{ text: 'goodbye' }]);
  });

  it('yields a single default delta and completes when the prompt is unseeded', async () => {
    // given a fresh gateway with nothing seeded
    const gateway = new InMemoryChatGateway();

    // when stream is called with an unseeded last-user message
    const deltas = await collect(gateway.stream(userSays('anything')));

    // then a single innocuous default delta is yielded, then completion
    expect(deltas).toEqual([{ text: '…' }]);
  });

  it('treats a last-assistant message as unseeded and yields the default delta', async () => {
    // given a gateway that HAS seeded "hello" — but the prompt's last role is assistant
    const gateway = new InMemoryChatGateway();
    gateway.reply('hello', [{ text: 'hi' }]);

    // when stream is called with an assistant-role tail (not a user turn)
    const deltas = await collect(
      gateway.stream([
        { role: 'user', content: 'hello' },
        { role: 'assistant', content: 'hello' },
      ]),
    );

    // then the seeded script is NOT used; the default delta fires
    expect(deltas).toEqual([{ text: '…' }]);
  });

  it('treats a last-system message as unseeded and yields the default delta', async () => {
    // given a gateway that HAS seeded "hello" — but the prompt's last role is system
    const gateway = new InMemoryChatGateway();
    gateway.reply('hello', [{ text: 'hi' }]);

    // when stream is called with a system-role tail (not a user turn)
    const deltas = await collect(
      gateway.stream([
        { role: 'user', content: 'hello' },
        { role: 'system', content: 'hello' },
      ]),
    );

    // then the seeded script is NOT used; the default delta fires
    expect(deltas).toEqual([{ text: '…' }]);
  });

  it('matches seeded keys exactly after trim — case-sensitive, no lowercasing', async () => {
    // given a gateway seeded for the lowercase key "hello"
    const gateway = new InMemoryChatGateway();
    gateway.reply('hello', [{ text: 'hi' }]);

    // when stream is called with a mixed-case tail
    const deltas = await collect(gateway.stream(userSays('Hello')));

    // then "Hello" does NOT match the seeded "hello" key — default delta instead
    expect(deltas).toEqual([{ text: '…' }]);
  });
});
