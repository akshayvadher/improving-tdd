import { Injectable } from '@nestjs/common';
import { randomUUID } from 'node:crypto';

import { LendingFacade, type LoanDto } from '../lending/index.js';
import { MembershipFacade, MembershipStatus, type MemberId } from '../membership/index.js';
import type { EventBus } from '../shared/events/event-bus.js';
import type { FineRepository } from './fine.repository.js';
import {
  FineAlreadyPaidError,
  FineNotFoundError,
  type FineAssessed,
  type FineDto,
  type FineId,
  type FinesConfig,
  type MemberAutoSuspended,
} from './fines.types.js';

type IdGenerator = () => string;
type Clock = () => Date;

const MS_PER_DAY = 24 * 60 * 60 * 1000;

@Injectable()
export class FinesFacade {
  constructor(
    private readonly lending: LendingFacade,
    private readonly membership: MembershipFacade,
    private readonly repository: FineRepository,
    private readonly bus: EventBus,
    private readonly config: FinesConfig,
    private readonly newId: IdGenerator = randomUUID,
    private readonly clock: Clock = () => new Date(),
  ) {}

  async assessFinesFor(memberId: MemberId, now: Date): Promise<FineDto[]> {
    await this.membership.findMember(memberId);

    const overdueLoans = await this.listOverdueLoansFor(memberId, now);
    const assessed: FineDto[] = [];

    for (const loan of overdueLoans) {
      const alreadyFined = await this.repository.findFineByLoanId(loan.loanId);
      if (alreadyFined) {
        continue;
      }
      const fine = this.buildFine(loan, now);
      await this.repository.saveFine(fine);
      this.bus.publish(this.fineAssessedEvent(fine));
      assessed.push(fine);
    }

    return assessed;
  }

  async processOverdueLoans(now: Date): Promise<void> {
    const overdue = await this.lending.listOverdueLoans(now);
    const memberIds = distinctMemberIds(overdue);

    for (const memberId of memberIds) {
      await this.assessFinesFor(memberId, now);
      await this.maybeAutoSuspend(memberId, now);
    }
  }

  async listFinesFor(memberId: MemberId): Promise<FineDto[]> {
    return this.repository.listFinesForMember(memberId);
  }

  async findFine(fineId: FineId): Promise<FineDto> {
    const fine = await this.repository.findFineById(fineId);
    if (!fine) {
      throw new FineNotFoundError(fineId);
    }
    return fine;
  }

  async payFine(fineId: FineId): Promise<FineDto> {
    const fine = await this.repository.findFineById(fineId);
    if (!fine) {
      throw new FineNotFoundError(fineId);
    }
    if (fine.paidAt !== null) {
      throw new FineAlreadyPaidError(fineId);
    }
    const paid: FineDto = { ...fine, paidAt: this.clock() };
    await this.repository.saveFine(paid);
    return paid;
  }

  private async maybeAutoSuspend(memberId: MemberId, now: Date): Promise<void> {
    const totalUnpaidCents = await this.computeUnpaidTotal(memberId);
    if (totalUnpaidCents < this.config.suspensionThresholdCents) {
      return;
    }

    const member = await this.membership.findMember(memberId);
    if (member.status === MembershipStatus.SUSPENDED) {
      return;
    }

    await this.membership.suspend(memberId);
    this.bus.publish(this.memberAutoSuspendedEvent(memberId, totalUnpaidCents, now));
  }

  private async computeUnpaidTotal(memberId: MemberId): Promise<number> {
    const fines = await this.repository.listFinesForMember(memberId);
    return fines
      .filter((fine) => fine.paidAt === null)
      .reduce((total, fine) => total + fine.amountCents, 0);
  }

  private memberAutoSuspendedEvent(
    memberId: MemberId,
    totalUnpaidCents: number,
    suspendedAt: Date,
  ): MemberAutoSuspended {
    return {
      type: 'MemberAutoSuspended',
      memberId,
      totalUnpaidCents,
      thresholdCents: this.config.suspensionThresholdCents,
      suspendedAt,
    };
  }

  private async listOverdueLoansFor(memberId: MemberId, now: Date): Promise<LoanDto[]> {
    const loans = await this.lending.listLoansFor(memberId);
    return loans.filter((loan) => isOverdue(loan, now));
  }

  private buildFine(loan: LoanDto, now: Date): FineDto {
    const daysOverdue = daysBetween(loan.dueDate, now);
    return {
      fineId: this.newId(),
      memberId: loan.memberId,
      loanId: loan.loanId,
      amountCents: daysOverdue * this.config.dailyRateCents,
      assessedAt: now,
      paidAt: null,
    };
  }

  private fineAssessedEvent(fine: FineDto): FineAssessed {
    return {
      type: 'FineAssessed',
      fineId: fine.fineId,
      memberId: fine.memberId,
      loanId: fine.loanId,
      amountCents: fine.amountCents,
      assessedAt: fine.assessedAt,
    };
  }
}

function isOverdue(loan: LoanDto, now: Date): boolean {
  return loan.returnedAt == null && loan.dueDate.getTime() < now.getTime();
}

function distinctMemberIds(loans: LoanDto[]): MemberId[] {
  return Array.from(new Set(loans.map((loan) => loan.memberId)));
}

function daysBetween(earlier: Date, later: Date): number {
  return Math.ceil((later.getTime() - earlier.getTime()) / MS_PER_DAY);
}
