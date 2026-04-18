export interface DomainEvent {
  readonly type: string;
}

export interface EventBus {
  publish<T extends DomainEvent>(event: T): void;
}
