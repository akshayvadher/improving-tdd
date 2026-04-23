import { describe, expect, it } from 'vitest';

import type { AutoLoanOnReturnConsumer } from './auto-loan-on-return.consumer.js';
import { LendingModule } from './lending.module.js';

// AC-3.12 / AC-3.13 — NestJS lifecycle wiring. LendingModule implements
// OnModuleInit / OnModuleDestroy and must delegate to the consumer's
// start()/stop() so the subscription is active while the app is running.
// A full `Test.createTestingModule([LendingModule])` boot would require
// DATABASE_URL + Postgres (DatabaseModule is a hard dependency); instead we
// instantiate the class directly with a recording consumer stub. This is the
// narrowest test that proves the lifecycle contract without reaching for
// integration infrastructure.

describe('LendingModule — NestJS lifecycle', () => {
  function buildRecordingConsumer(): {
    consumer: AutoLoanOnReturnConsumer;
    events: string[];
  } {
    const events: string[] = [];
    const consumer: AutoLoanOnReturnConsumer = {
      start(): void {
        events.push('start');
      },
      stop(): void {
        events.push('stop');
      },
    };
    return { consumer, events };
  }

  it('calls consumer.start() during onModuleInit (AC-3.12, AC-3.13)', () => {
    const { consumer, events } = buildRecordingConsumer();
    const module = new LendingModule(consumer);

    module.onModuleInit();

    expect(events).toEqual(['start']);
  });

  it('calls consumer.stop() during onModuleDestroy (AC-3.13)', () => {
    const { consumer, events } = buildRecordingConsumer();
    const module = new LendingModule(consumer);

    module.onModuleInit();
    module.onModuleDestroy();

    expect(events).toEqual(['start', 'stop']);
  });

  it('does not start the consumer at construction time — only on onModuleInit', () => {
    const { consumer, events } = buildRecordingConsumer();
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    const _module = new LendingModule(consumer);

    expect(events).toEqual([]);
  });
});
