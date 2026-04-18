// Typed event bus shared across modules. Production may wire a real broker; unit
// tests use InMemoryEventBus and read collected() to assert on emitted events.

export interface DomainEvent {
  readonly type: string;
}

// principle 5: same interface, in-memory implementation for tests.
// principle 3: events cross module boundaries but the bus itself is a shared primitive.
export interface EventBus {
  publish<T extends DomainEvent>(event: T): void;
}

export class InMemoryEventBus implements EventBus {
  private events: DomainEvent[] = [];

  publish<T extends DomainEvent>(event: T): void {
    this.events.push(event);
  }

  // Test-only accessor. Production implementations do not expose this.
  collected(): readonly DomainEvent[] {
    return this.events;
  }

  clear(): void {
    this.events = [];
  }
}

// Example usage inside a spec:
//   const bus = new InMemoryEventBus();
//   const facade = createThingFacade({ eventBus: bus });
//   await facade.doSomething();
//   expect(bus.collected()).toEqual([{ type: 'ThingHappened', thingId: 'thing-1' }]);
