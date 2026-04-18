import type { DomainEvent, EventBus } from './event-bus.js';

export class InMemoryEventBus implements EventBus {
  private events: DomainEvent[] = [];

  publish<T extends DomainEvent>(event: T): void {
    this.events.push(event);
  }

  collected(): readonly DomainEvent[] {
    return this.events;
  }

  clear(): void {
    this.events = [];
  }
}
