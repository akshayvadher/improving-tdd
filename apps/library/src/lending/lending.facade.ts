import { Injectable } from '@nestjs/common';
import { randomUUID } from 'node:crypto';

import { AccessControlFacade, type AuthUser } from '../access-control/index.js';
import {
  BookNotFoundError,
  CatalogFacade,
  CopyStatus,
  type BookId,
  type CopyId,
} from '../catalog/index.js';
import { MembershipFacade, type MemberId } from '../membership/index.js';
import type { EventBus } from '../shared/events/event-bus.js';
import {
  CopyUnavailableError,
  LoanNotFoundError,
  MemberIneligibleError,
  type ActiveLoanWithQueuedCount,
  type LoanDto,
  type LoanId,
  type LoanOpened,
  type LoanReturned,
  type OverdueLoanReport,
  type ReservationDto,
  type ReservationQueued,
} from './lending.types.js';
import type { LoanRepository } from './loan.repository.js';
import type { ReservationRepository } from './reservation.repository.js';
import type { TransactionalContextFactory } from './transactional-context.js';

type IdGenerator = () => string;
type Clock = () => Date;

const LOAN_DURATION_DAYS = 14;

@Injectable()
export class LendingFacade {
  constructor(
    private readonly catalog: CatalogFacade,
    private readonly membership: MembershipFacade,
    private readonly accessControl: AccessControlFacade,
    private readonly loans: LoanRepository,
    private readonly reservations: ReservationRepository,
    private readonly bus: EventBus,
    private readonly txFactory: TransactionalContextFactory,
    private readonly newId: IdGenerator = randomUUID,
    private readonly clock: Clock = () => new Date(),
  ) {}

  async borrow(authUser: AuthUser, copyId: CopyId): Promise<LoanDto> {
    this.accessControl.authorize(authUser, 'lending', 'borrow');
    await this.requireEligible(authUser.memberId);
    const copy = await this.catalog.findCopy(copyId);
    if (copy.status !== CopyStatus.AVAILABLE) {
      throw new CopyUnavailableError(copyId);
    }

    const loan = this.buildLoan(authUser.memberId, copy.copyId, copy.bookId);
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
    // Atomicity target: the loan update alone. Reservation-queue walking is
    // the consumer's job now — see AutoLoanOnReturnConsumer. Cross-module
    // Catalog side-effect runs AFTER commit (principle 7), and LoanReturned
    // publishes AFTER the copy has been marked available so post-commit
    // consumers observe the fully-consistent state.
    await tx.run(async () => {
      this.loans.saveLoan(returned, tx);
    });
    await this.catalog.markCopyAvailable(returned.copyId);
    await this.bus.publish(this.loanReturnedEvent(returned));
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

  async listOverdueLoansWithTitles(now: Date): Promise<OverdueLoanReport[]> {
    const overdue = await this.listOverdueLoans(now);
    if (overdue.length === 0) return [];
    const bookIds = Array.from(new Set(overdue.map((loan) => loan.bookId)));
    const books = await this.catalog.getBooks(bookIds);
    const byId = new Map(books.map((book) => [book.bookId, book]));
    return overdue.map((loan) => {
      const book = byId.get(loan.bookId);
      if (!book) throw new BookNotFoundError(loan.bookId);
      return { loan, title: book.title, authors: book.authors };
    });
  }

  listLoansFor(memberId: MemberId): Promise<LoanDto[]> {
    return this.loans.listLoansForMember(memberId);
  }

  listActiveLoansWithQueuedReservations(): Promise<ActiveLoanWithQueuedCount[]> {
    return this.loans.listActiveLoansWithQueuedReservations();
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
}

function addDays(base: Date, days: number): Date {
  const result = new Date(base.getTime());
  result.setDate(result.getDate() + days);
  return result;
}
