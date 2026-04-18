import type { DomainEvent, EventBus } from '../shared/events/event-bus.js';
import type { TransactionalContext } from './transactional-context.js';

// Stage-and-commit: repos call `stage()` for writes and `stageEvent()` for events.
// On `run()` success, staged writes apply to the live maps and staged events are
// published to the bus. On throw, both buffers are discarded so the live state
// and the bus remain untouched. This mirrors the atomicity a DB transaction gives.
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
      this.discard();
      throw error;
    }
  }

  private async commit(): Promise<void> {
    const writes = this.staged;
    const events = this.events;
    this.staged = [];
    this.events = [];
    for (const apply of writes) {
      await apply();
    }
    events.forEach((event) => this.bus.publish(event));
  }

  private discard(): void {
    this.staged = [];
    this.events = [];
  }
}
