import type { BookId } from '../catalog/index.js';
import type { MemberId } from '../membership/index.js';
import type { ActiveLoanWithQueuedCount, LoanDto, LoanId } from './lending.types.js';
import type { LoanRepository } from './loan.repository.js';
import type { TransactionalContext } from './transactional-context.js';

interface ReservationView {
  pendingReservationCountForBook(bookId: BookId): Promise<number>;
}

const NoReservations: ReservationView = {
  pendingReservationCountForBook: () => Promise.resolve(0),
};

export class InMemoryLoanRepository implements LoanRepository {
  private readonly loansById = new Map<LoanId, LoanDto>();
  private readonly reservationView: ReservationView;

  constructor(reservationView: ReservationView = NoReservations) {
    this.reservationView = reservationView;
  }

  saveLoan(loan: LoanDto, ctx: TransactionalContext): void {
    const snapshot = { ...loan };
    ctx.stage(() => {
      this.loansById.set(snapshot.loanId, snapshot);
    });
  }

  async findLoanById(loanId: LoanId): Promise<LoanDto | undefined> {
    return this.loansById.get(loanId);
  }

  async listLoansForMember(memberId: MemberId): Promise<LoanDto[]> {
    return this.listLoansSync().filter((loan) => loan.memberId === memberId);
  }

  async listLoansForBook(bookId: BookId): Promise<LoanDto[]> {
    return this.listLoansSync().filter((loan) => loan.bookId === bookId);
  }

  async listLoans(): Promise<LoanDto[]> {
    return this.listLoansSync();
  }

  async listActiveLoansWithQueuedReservations(): Promise<ActiveLoanWithQueuedCount[]> {
    const active = this.listLoansSync().filter((loan) => loan.returnedAt == null);
    return Promise.all(
      active.map(async (loan) => ({
        loan,
        queuedCount: await this.reservationView.pendingReservationCountForBook(loan.bookId),
      })),
    );
  }

  private listLoansSync(): LoanDto[] {
    return Array.from(this.loansById.values());
  }
}
