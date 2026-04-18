import { Injectable } from '@nestjs/common';
import { randomUUID } from 'node:crypto';

import { CatalogFacade, CopyStatus, type BookId, type CopyId } from '../catalog/index.js';
import { MembershipFacade, type MemberId } from '../membership/index.js';
import type { EventBus } from '../shared/events/event-bus.js';
import {
  CopyUnavailableError,
  LoanNotFoundError,
  MemberIneligibleError,
  type LoanDto,
  type LoanId,
  type LoanOpened,
  type LoanReturned,
  type ReservationDto,
  type ReservationFulfilled,
  type ReservationQueued,
} from './lending.types.js';
import type { LoanRepository } from './loan.repository.js';
import type { ReservationRepository } from './reservation.repository.js';
import type { TransactionalContext, TransactionalContextFactory } from './transactional-context.js';

type IdGenerator = () => string;
type Clock = () => Date;

const LOAN_DURATION_DAYS = 14;

@Injectable()
export class LendingFacade {
  constructor(
    private readonly catalog: CatalogFacade,
    private readonly membership: MembershipFacade,
    private readonly loans: LoanRepository,
    private readonly reservations: ReservationRepository,
    private readonly bus: EventBus,
    private readonly txFactory: TransactionalContextFactory,
    private readonly newId: IdGenerator = randomUUID,
    private readonly clock: Clock = () => new Date(),
  ) {}

  async borrow(memberId: MemberId, copyId: CopyId): Promise<LoanDto> {
    await this.requireEligible(memberId);
    const copy = await this.catalog.findCopy(copyId);
    if (copy.status !== CopyStatus.AVAILABLE) {
      throw new CopyUnavailableError(copyId);
    }

    const loan = this.buildLoan(memberId, copy.copyId, copy.bookId);
    const tx = this.txFactory();
    // Lending's tx wraps ONLY Lending's own writes (principle 7: cross-module
    // consistency via events/happens-before, not shared transactions). If the
    // loan insert fails, Catalog's copy-state change has not yet happened.
    await tx.run(async () => {
      this.loans.saveLoan(loan, tx);
      tx.stageEvent(this.loanOpenedEvent(loan));
    });
    await this.catalog.markCopyUnavailable(copyId);
    return loan;
  }

  async returnLoan(loanId: LoanId): Promise<LoanDto> {
    const loan = await this.loans.findLoanById(loanId);
    if (!loan) {
      throw new LoanNotFoundError(loanId);
    }

    const returnedAt = this.clock();
    const returned: LoanDto = { ...loan, returnedAt };

    const tx = this.txFactory();
    // Atomicity target: the loan update + reservation fulfillment. If the
    // reservation write fails, the loan update rolls back with it. Cross-module
    // Catalog side-effects run AFTER commit (principle 7).
    await tx.run(async () => {
      this.loans.saveLoan(returned, tx);
      await this.fulfillNextReservation(returned.bookId, returnedAt, tx);
      tx.stageEvent(this.loanReturnedEvent(returned));
    });
    await this.catalog.markCopyAvailable(returned.copyId);
    return returned;
  }

  async reserve(memberId: MemberId, bookId: BookId): Promise<ReservationDto> {
    await this.requireEligible(memberId);

    const reservation: ReservationDto = {
      reservationId: this.newId(),
      memberId,
      bookId,
      reservedAt: this.clock(),
    };

    const tx = this.txFactory();
    await tx.run(async () => {
      this.reservations.saveReservation(reservation, tx);
      tx.stageEvent(this.reservationQueuedEvent(reservation));
    });
    return reservation;
  }

  async listOverdueLoans(now: Date): Promise<LoanDto[]> {
    const all = await this.loans.listLoans();
    return all.filter((loan) => loan.returnedAt == null && loan.dueDate.getTime() < now.getTime());
  }

  listLoansFor(memberId: MemberId): Promise<LoanDto[]> {
    return this.loans.listLoansForMember(memberId);
  }

  private async requireEligible(memberId: MemberId): Promise<void> {
    const eligibility = await this.membership.checkEligibility(memberId);
    if (!eligibility.eligible) {
      throw new MemberIneligibleError(memberId, eligibility.reason ?? 'INELIGIBLE');
    }
  }

  private buildLoan(memberId: MemberId, copyId: CopyId, bookId: BookId): LoanDto {
    const borrowedAt = this.clock();
    return {
      loanId: this.newId(),
      memberId,
      copyId,
      bookId,
      borrowedAt,
      dueDate: addDays(borrowedAt, LOAN_DURATION_DAYS),
    };
  }

  private async fulfillNextReservation(
    bookId: BookId,
    fulfilledAt: Date,
    tx: TransactionalContext,
  ): Promise<void> {
    const pending = await this.reservations.listPendingReservationsForBook(bookId);
    const [next] = pending;
    if (!next) {
      return;
    }
    const fulfilled: ReservationDto = { ...next, fulfilledAt };
    this.reservations.saveReservation(fulfilled, tx);
    tx.stageEvent(this.reservationFulfilledEvent(fulfilled));
  }

  private loanOpenedEvent(loan: LoanDto): LoanOpened {
    return {
      type: 'LoanOpened',
      loanId: loan.loanId,
      memberId: loan.memberId,
      copyId: loan.copyId,
      bookId: loan.bookId,
      borrowedAt: loan.borrowedAt,
      dueDate: loan.dueDate,
    };
  }

  private loanReturnedEvent(loan: LoanDto): LoanReturned {
    return {
      type: 'LoanReturned',
      loanId: loan.loanId,
      memberId: loan.memberId,
      copyId: loan.copyId,
      bookId: loan.bookId,
      returnedAt: loan.returnedAt as Date,
    };
  }

  private reservationQueuedEvent(reservation: ReservationDto): ReservationQueued {
    return {
      type: 'ReservationQueued',
      reservationId: reservation.reservationId,
      memberId: reservation.memberId,
      bookId: reservation.bookId,
      reservedAt: reservation.reservedAt,
    };
  }

  private reservationFulfilledEvent(reservation: ReservationDto): ReservationFulfilled {
    return {
      type: 'ReservationFulfilled',
      reservationId: reservation.reservationId,
      memberId: reservation.memberId,
      bookId: reservation.bookId,
      fulfilledAt: reservation.fulfilledAt as Date,
    };
  }
}

function addDays(base: Date, days: number): Date {
  const result = new Date(base.getTime());
  result.setDate(result.getDate() + days);
  return result;
}
