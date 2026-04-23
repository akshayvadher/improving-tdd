export interface DomainEvent {
  readonly type: string;
}

export type Unsubscribe = () => void;

export interface EventBus {
  publish<T extends DomainEvent>(event: T): Promise<void>;
  subscribe<T extends DomainEvent>(
    type: T['type'],
    handler: (event: T) => Promise<void>,
  ): Unsubscribe;
}
