import type { DomainEvent, EventBus, Unsubscribe } from './event-bus.js';

type Handler = (event: DomainEvent) => Promise<void>;

export class InMemoryEventBus implements EventBus {
  private readonly handlersByType = new Map<string, Handler[]>();
  private collectedEvents: DomainEvent[] = [];

  async publish<T extends DomainEvent>(event: T): Promise<void> {
    this.collectedEvents.push(event);
    const subscribers = this.handlersByType.get(event.type);
    if (!subscribers || subscribers.length === 0) {
      return;
    }
    // Snapshot before iterating so handlers that (un)subscribe or re-publish
    // during fan-out cannot mutate this publish's iteration target.
    const snapshot = subscribers.slice();
    for (const handler of snapshot) {
      await handler(event);
    }
  }

  subscribe<T extends DomainEvent>(
    type: T['type'],
    handler: (event: T) => Promise<void>,
  ): Unsubscribe {
    const entry = handler as Handler;
    const list = this.handlersByType.get(type) ?? [];
    list.push(entry);
    this.handlersByType.set(type, list);
    return () => this.removeHandler(type, entry);
  }

  collected(): readonly DomainEvent[] {
    return this.collectedEvents;
  }

  clear(): void {
    this.collectedEvents = [];
  }

  private removeHandler(type: string, entry: Handler): void {
    const current = this.handlersByType.get(type);
    if (!current) {
      return;
    }
    const index = current.indexOf(entry);
    if (index >= 0) {
      current.splice(index, 1);
    }
  }
}
