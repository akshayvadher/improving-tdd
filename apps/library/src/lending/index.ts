export { LendingFacade } from './lending.facade.js';
export { LendingModule } from './lending.module.js';
export {
  CopyUnavailableError,
  LoanNotFoundError,
  MemberIneligibleError,
  type LendingEvent,
  type LoanDto,
  type LoanId,
  type LoanOpened,
  type LoanReturned,
  type ReservationDto,
  type ReservationFulfilled,
  type ReservationId,
  type ReservationQueued,
} from './lending.types.js';
export type { DomainEvent, EventBus } from '../shared/events/event-bus.js';
