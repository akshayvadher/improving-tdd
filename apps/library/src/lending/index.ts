export type { DomainEvent, EventBus, Unsubscribe } from '../shared/events/event-bus.js';
export {
  type AutoLoanOnReturnConsumer,
  type AutoLoanOnReturnConsumerDeps,
  createAutoLoanOnReturnConsumer,
} from './auto-loan-on-return.consumer.js';
export { LendingFacade } from './lending.facade.js';
export { LendingModule } from './lending.module.js';
export {
  type ActiveLoanWithQueuedCount,
  type AutoLoanFailed,
  type AutoLoanOpened,
  CopyUnavailableError,
  type LendingEvent,
  type LoanDto,
  type LoanId,
  LoanNotFoundError,
  type LoanOpened,
  type LoanReturned,
  MemberIneligibleError,
  type OverdueLoanReport,
  type ReservationDto,
  type ReservationFulfilled,
  type ReservationId,
  type ReservationQueued,
} from './lending.types.js';
