// Real adapter: translates the OpenAI SDK's streaming chat-completions response
// into the port's AsyncIterable<ChatDelta>. Consumed only by the chat module
// (ChatModule's useFactory instantiates this when OPENAI_API_KEY is set).
//
// Default model: `gpt-4o-mini`. Hard-coded; no per-request override in scope.
// Documented under `OPENAI_API_KEY` in the chat module header.
//
// Errors (network, auth, rate-limit, malformed chunk) are NOT caught here.
// They propagate out of the async iterator and are shaped into terminal
// `{ type: 'error' }` frames by ChatFacade (see Slice 5).

import OpenAI from 'openai';

import type { ChatMessage } from '../../chat/chat.types.js';
import type { ChatDelta } from './chat-delta.js';
import type { ChatGateway } from './chat-gateway.js';

const DEFAULT_MODEL = 'gpt-4o-mini';

export class OpenAiChatGateway implements ChatGateway {
  private readonly apiKey: string;
  private readonly model: string;
  private client: OpenAI | undefined;

  constructor(options: { apiKey: string; model?: string }) {
    this.apiKey = options.apiKey;
    this.model = options.model ?? DEFAULT_MODEL;
  }

  async *stream(messages: ChatMessage[]): AsyncIterable<ChatDelta> {
    const client = this.resolveClient();
    const completion = await client.chat.completions.create({
      model: this.model,
      messages: messages.map(({ role, content }) => ({ role, content })),
      stream: true,
    });

    for await (const chunk of completion) {
      const content = chunk.choices[0]?.delta?.content;
      if (content) {
        yield { text: content };
      }
    }
  }

  private resolveClient(): OpenAI {
    // Lazy client construction keeps the Nest module boot cheap and lets
    // tests supply a fake key without the SDK performing any IO.
    //
    // Assumption: the OpenAI SDK constructor is side-effect-free (no network,
    // no key validation). Verified against openai@^6.34.0. If a future major
    // tightens this, the factory-selection test in `chat.module.spec.ts` will
    // silently flip from "no network" to "hits network" — re-verify on bump.
    if (!this.client) {
      this.client = new OpenAI({ apiKey: this.apiKey });
    }
    return this.client;
  }
}
