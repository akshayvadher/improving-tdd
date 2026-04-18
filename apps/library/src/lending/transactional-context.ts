import type { DomainEvent } from '../shared/events/event-bus.js';

export interface TransactionalContext {
  run<T>(work: () => Promise<T>): Promise<T>;
  stage(apply: () => void | Promise<void>): void;
  stageEvent(event: DomainEvent): void;
}

export type TransactionalContextFactory = () => TransactionalContext;
