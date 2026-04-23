import { Test } from '@nestjs/testing';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { ChatFacade } from './chat.facade.js';
import { CHAT_GATEWAY, ChatModule } from './chat.module.js';

// AC-2.10 / AC-2.11 — module wiring. The `pnpm --filter library build` step
// catches type-level wiring, but the AC specifically demands a runtime
// `Test.createTestingModule(...).compile()` assertion so any missing provider
// surfaces here rather than at first HTTP boot.
//
// AC-4.6 — Slice 4 factory-selection smoke test. Verifies env-driven adapter
// choice without invoking `.stream()`, so no network call is made.

describe('ChatModule — wiring', () => {
  let originalApiKey: string | undefined;

  beforeEach(() => {
    originalApiKey = process.env.OPENAI_API_KEY;
  });

  afterEach(() => {
    if (originalApiKey === undefined) {
      delete process.env.OPENAI_API_KEY;
    } else {
      process.env.OPENAI_API_KEY = originalApiKey;
    }
  });

  it('resolves ChatFacade via the in-memory gateway factory when OPENAI_API_KEY is unset', async () => {
    // given OPENAI_API_KEY is unset (Slice 4 real-adapter branch is not taken)
    delete process.env.OPENAI_API_KEY;

    // when the Nest testing module compiles just ChatModule
    const moduleRef = await Test.createTestingModule({ imports: [ChatModule] }).compile();

    // then ChatFacade resolves with no unresolved-provider errors
    try {
      const facade = moduleRef.get(ChatFacade);
      expect(facade).toBeInstanceOf(ChatFacade);
    } finally {
      await moduleRef.close();
    }
  });

  it('instantiates InMemoryChatGateway when OPENAI_API_KEY is unset', async () => {
    delete process.env.OPENAI_API_KEY;

    const moduleRef = await Test.createTestingModule({ imports: [ChatModule] }).compile();

    try {
      const gateway = moduleRef.get(CHAT_GATEWAY);
      expect(gateway.constructor.name).toBe('InMemoryChatGateway');
    } finally {
      await moduleRef.close();
    }
  });

  it('instantiates OpenAiChatGateway when OPENAI_API_KEY is set', async () => {
    process.env.OPENAI_API_KEY = 'test-key-does-not-call-network';

    const moduleRef = await Test.createTestingModule({ imports: [ChatModule] }).compile();

    try {
      const gateway = moduleRef.get(CHAT_GATEWAY);
      expect(gateway.constructor.name).toBe('OpenAiChatGateway');
    } finally {
      await moduleRef.close();
    }
  });
});
