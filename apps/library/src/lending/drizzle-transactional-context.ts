import type { AppDatabase } from '../db/client.js';
import type { DomainEvent, EventBus } from '../shared/events/event-bus.js';
import type { TransactionalContext } from './transactional-context.js';

// Drizzle context: `run()` wraps `db.transaction(tx => work())`. Inside the block,
// `stage()` executes the write closure immediately against the live tx handle —
// Postgres commits on success and rolls back on throw. Staged writes are tracked
// so `run()` can await them before committing. Events are buffered and published
// only after the transaction commits so consumers never see events from an
// aborted transaction.
export class DrizzleTransactionalContext implements TransactionalContext {
  private events: DomainEvent[] = [];
  private pending: Promise<void>[] = [];
  private activeTx: AppDatabase | undefined;

  constructor(
    private readonly db: AppDatabase,
    private readonly bus: EventBus,
  ) {}

  get handle(): AppDatabase {
    return this.activeTx ?? this.db;
  }

  stage(apply: () => void | Promise<void>): void {
    const result = apply();
    if (result && typeof (result as Promise<void>).then === 'function') {
      this.pending.push(result as Promise<void>);
    }
  }

  stageEvent(event: DomainEvent): void {
    this.events.push(event);
  }

  async run<T>(work: () => Promise<T>): Promise<T> {
    this.events = [];
    this.pending = [];
    try {
      const result = await this.db.transaction(async (tx) => {
        this.activeTx = tx as unknown as AppDatabase;
        const value = await work();
        await Promise.all(this.pending);
        return value;
      });
      await this.publishEvents();
      return result;
    } catch (error) {
      this.events = [];
      this.pending = [];
      throw error;
    } finally {
      this.activeTx = undefined;
    }
  }

  private async publishEvents(): Promise<void> {
    const toPublish = this.events;
    this.events = [];
    for (const event of toPublish) {
      await this.bus.publish(event);
    }
  }
}
