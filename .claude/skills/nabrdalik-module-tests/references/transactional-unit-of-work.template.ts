// Transactional context — only for atomicity WITHIN a single module. Cross-module
// coordination goes through events, not through a shared transaction (see principle 7).
// Repositories call stage() for writes and stageEvent() for events. On run() success,
// both buffers apply. On throw, both buffers are discarded and nothing persists.

import type { DomainEvent, EventBus } from './event-bus-and-collector.template.js';

// principle 5: the same interface a Drizzle/Postgres context implements in production.
export interface TransactionalContext {
  run<T>(work: () => Promise<T>): Promise<T>;
  stage(apply: () => void | Promise<void>): void;
  stageEvent(event: DomainEvent): void;
}

// principle 4: in-memory stage-and-commit keeps atomicity tests in-milliseconds.
export class InMemoryTransactionalContext implements TransactionalContext {
  private staged: Array<() => void | Promise<void>> = [];
  private events: DomainEvent[] = [];

  constructor(private readonly bus: EventBus) {}

  stage(apply: () => void | Promise<void>): void {
    this.staged.push(apply);
  }

  stageEvent(event: DomainEvent): void {
    this.events.push(event);
  }

  async run<T>(work: () => Promise<T>): Promise<T> {
    try {
      const result = await work();
      await this.commit();
      return result;
    } catch (error) {
      // principle 1: a unit test can force `work` to throw and assert nothing persisted.
      this.discard();
      throw error;
    }
  }

  private async commit(): Promise<void> {
    const writes = this.staged;
    const events = this.events;
    this.staged = [];
    this.events = [];
    for (const apply of writes) await apply();
    events.forEach((event) => this.bus.publish(event));
  }

  private discard(): void {
    this.staged = [];
    this.events = [];
  }
}
