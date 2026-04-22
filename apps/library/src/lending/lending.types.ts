import type { BookId, CopyId } from '../catalog/index.js';
import type { MemberId } from '../membership/index.js';
import type { DomainEvent } from '../shared/events/event-bus.js';

export type LoanId = string;
export type ReservationId = string;

export interface LoanDto {
  loanId: LoanId;
  memberId: MemberId;
  copyId: CopyId;
  bookId: BookId;
  borrowedAt: Date;
  dueDate: Date;
  returnedAt?: Date;
}

export interface ReservationDto {
  reservationId: ReservationId;
  memberId: MemberId;
  bookId: BookId;
  reservedAt: Date;
  fulfilledAt?: Date;
}

export interface ActiveLoanWithQueuedCount {
  loan: LoanDto;
  queuedCount: number;
}

export interface OverdueLoanReport {
  loan: LoanDto;
  title: string;
  authors: string[];
}

export interface LoanOpened extends DomainEvent {
  type: 'LoanOpened';
  loanId: LoanId;
  memberId: MemberId;
  copyId: CopyId;
  bookId: BookId;
  borrowedAt: Date;
  dueDate: Date;
}

export interface LoanReturned extends DomainEvent {
  type: 'LoanReturned';
  loanId: LoanId;
  memberId: MemberId;
  copyId: CopyId;
  bookId: BookId;
  returnedAt: Date;
}

export interface ReservationQueued extends DomainEvent {
  type: 'ReservationQueued';
  reservationId: ReservationId;
  memberId: MemberId;
  bookId: BookId;
  reservedAt: Date;
}

export interface ReservationFulfilled extends DomainEvent {
  type: 'ReservationFulfilled';
  reservationId: ReservationId;
  memberId: MemberId;
  bookId: BookId;
  fulfilledAt: Date;
}

export type LendingEvent = LoanOpened | LoanReturned | ReservationQueued | ReservationFulfilled;

export class LoanNotFoundError extends Error {
  constructor(loanId: LoanId) {
    super(`Loan not found: ${loanId}`);
    this.name = 'LoanNotFoundError';
  }
}

export class CopyUnavailableError extends Error {
  constructor(copyId: CopyId) {
    super(`Copy is not available for borrowing: ${copyId}`);
    this.name = 'CopyUnavailableError';
  }
}

export class MemberIneligibleError extends Error {
  readonly reason: string;

  constructor(memberId: MemberId, reason: string) {
    super(`Member ${memberId} is not eligible to borrow: ${reason}`);
    this.name = 'MemberIneligibleError';
    this.reason = reason;
  }
}
