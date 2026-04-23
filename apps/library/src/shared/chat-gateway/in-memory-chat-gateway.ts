import type { ChatMessage } from '../../chat/chat.types.js';
import type { ChatDelta } from './chat-delta.js';
import type { ChatGateway } from './chat-gateway.js';

/**
 * In-memory scripted ChatGateway for tests and the zero-config default.
 *
 * Seeding: call `reply(userContent, deltas)` to script a response for a given
 * last-user-message `content`. Keys are normalized by trimming only — NOT
 * lowercased. Tests that need case-insensitive matching should seed multiple
 * keys.
 *
 * Unseeded behaviour: when the last message's role is not `'user'`, or its
 * trimmed content does not match a seeded key, the adapter yields a single
 * innocuous default delta `{ text: '…' }` and then completes. It never throws
 * on unseeded input — silent defaults keep low-seeding happy-path tests terse
 * while content-sensitive tests still fail on delta comparisons.
 */
export class InMemoryChatGateway implements ChatGateway {
  private readonly scripts = new Map<string, ChatDelta[]>();

  reply(userContent: string, deltas: ChatDelta[]): void {
    this.scripts.set(userContent.trim(), deltas);
  }

  async *stream(messages: ChatMessage[]): AsyncIterable<ChatDelta> {
    const deltas = this.scriptFor(messages) ?? [{ text: '…' }];
    for (const delta of deltas) {
      yield delta;
    }
  }

  private scriptFor(messages: ChatMessage[]): ChatDelta[] | undefined {
    const last = messages[messages.length - 1];
    if (!last || last.role !== 'user') return undefined;
    return this.scripts.get(last.content.trim());
  }
}
