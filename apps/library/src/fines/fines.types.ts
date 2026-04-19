import type { MemberId } from '../membership/index.js';
import type { LoanId } from '../lending/index.js';
import type { DomainEvent } from '../shared/events/event-bus.js';

export type FineId = string;
export type AmountCents = number;

export interface FinesConfig {
  dailyRateCents: AmountCents;
  suspensionThresholdCents: AmountCents;
}

export interface FineDto {
  fineId: FineId;
  memberId: MemberId;
  loanId: LoanId;
  amountCents: AmountCents;
  assessedAt: Date;
  paidAt: Date | null;
}

export interface FineAssessed extends DomainEvent {
  type: 'FineAssessed';
  fineId: FineId;
  memberId: MemberId;
  loanId: LoanId;
  amountCents: AmountCents;
  assessedAt: Date;
}

export interface MemberAutoSuspended extends DomainEvent {
  type: 'MemberAutoSuspended';
  memberId: MemberId;
  totalUnpaidCents: AmountCents;
  thresholdCents: AmountCents;
  suspendedAt: Date;
}

export type FinesEvent = FineAssessed | MemberAutoSuspended;

export class FineNotFoundError extends Error {
  constructor(fineId: FineId) {
    super(`Fine not found: ${fineId}`);
    this.name = 'FineNotFoundError';
  }
}

export class FineAlreadyPaidError extends Error {
  constructor(fineId: FineId) {
    super(`Fine already paid: ${fineId}`);
    this.name = 'FineAlreadyPaidError';
  }
}
