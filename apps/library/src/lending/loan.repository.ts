import type { BookId } from '../catalog/index.js';
import type { MemberId } from '../membership/index.js';
import type { ActiveLoanWithQueuedCount, LoanDto, LoanId } from './lending.types.js';
import type { TransactionalContext } from './transactional-context.js';

export interface LoanRepository {
  saveLoan(loan: LoanDto, ctx: TransactionalContext): void;
  findLoanById(loanId: LoanId): Promise<LoanDto | undefined>;
  listLoansForMember(memberId: MemberId): Promise<LoanDto[]>;
  listLoansForBook(bookId: BookId): Promise<LoanDto[]>;
  listLoans(): Promise<LoanDto[]>;
  listActiveLoansWithQueuedReservations(): Promise<ActiveLoanWithQueuedCount[]>;
}
