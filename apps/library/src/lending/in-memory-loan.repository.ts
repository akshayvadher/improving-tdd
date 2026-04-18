import type { BookId } from '../catalog/index.js';
import type { MemberId } from '../membership/index.js';
import type { LoanDto, LoanId } from './lending.types.js';
import type { LoanRepository } from './loan.repository.js';
import type { TransactionalContext } from './transactional-context.js';

export class InMemoryLoanRepository implements LoanRepository {
  private readonly loansById = new Map<LoanId, LoanDto>();

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

  private listLoansSync(): LoanDto[] {
    return Array.from(this.loansById.values());
  }
}
