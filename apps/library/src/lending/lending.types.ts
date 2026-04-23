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

export interface ReservationUnfulfilled extends DomainEvent {
  type: 'ReservationUnfulfilled';
  reservationId: ReservationId;
  memberId: MemberId;
  bookId: BookId;
  unfulfilledAt: Date;
}

export interface AutoLoanOpened extends DomainEvent {
  readonly type: 'AutoLoanOpened';
  readonly bookId: BookId;
  readonly loanId: LoanId;
  readonly memberId: MemberId;
  readonly reservationId: ReservationId;
  readonly openedAt: Date;
}

export interface AutoLoanFailed extends DomainEvent {
  readonly type: 'AutoLoanFailed';
  readonly bookId: BookId;
  readonly reservationId: ReservationId;
  readonly memberId: MemberId;
  readonly reason: string;
  readonly failedAt: Date;
}

export type LendingEvent =
  | LoanOpened
  | LoanReturned
  | ReservationQueued
  | ReservationFulfilled
  | ReservationUnfulfilled
  | AutoLoanOpened
  | AutoLoanFailed;

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
