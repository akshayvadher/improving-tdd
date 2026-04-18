import { eq } from 'drizzle-orm';

import type { BookId } from '../catalog/index.js';
import type { AppDatabase } from '../db/client.js';
import { loans } from '../db/schema/index.js';
import type { MemberId } from '../membership/index.js';
import type { LoanDto, LoanId } from './lending.types.js';
import type { LoanRepository } from './loan.repository.js';
import type { TransactionalContext } from './transactional-context.js';
import { DrizzleTransactionalContext } from './drizzle-transactional-context.js';

type LoanRow = typeof loans.$inferSelect;

export class DrizzleLoanRepository implements LoanRepository {
  constructor(private readonly db: AppDatabase) {}

  saveLoan(loan: LoanDto, ctx: TransactionalContext): void {
    const handle = handleFrom(ctx, this.db);
    const row = toRow(loan);
    ctx.stage(async () => {
      await handle
        .insert(loans)
        .values(row)
        .onConflictDoUpdate({ target: loans.loanId, set: row });
    });
  }

  async findLoanById(loanId: LoanId): Promise<LoanDto | undefined> {
    const [row] = await this.db.select().from(loans).where(eq(loans.loanId, loanId));
    return row ? toDto(row) : undefined;
  }

  async listLoansForMember(memberId: MemberId): Promise<LoanDto[]> {
    const rows = await this.db.select().from(loans).where(eq(loans.memberId, memberId));
    return rows.map(toDto);
  }

  async listLoansForBook(bookId: BookId): Promise<LoanDto[]> {
    const rows = await this.db.select().from(loans).where(eq(loans.bookId, bookId));
    return rows.map(toDto);
  }

  async listLoans(): Promise<LoanDto[]> {
    const rows = await this.db.select().from(loans);
    return rows.map(toDto);
  }
}

function handleFrom(ctx: TransactionalContext, fallback: AppDatabase): AppDatabase {
  return ctx instanceof DrizzleTransactionalContext ? ctx.handle : fallback;
}

function toRow(loan: LoanDto): LoanRow {
  return {
    loanId: loan.loanId,
    memberId: loan.memberId,
    copyId: loan.copyId,
    bookId: loan.bookId,
    borrowedAt: loan.borrowedAt,
    dueDate: loan.dueDate,
    returnedAt: loan.returnedAt ?? null,
  };
}

function toDto(row: LoanRow): LoanDto {
  const dto: LoanDto = {
    loanId: row.loanId,
    memberId: row.memberId,
    copyId: row.copyId,
    bookId: row.bookId,
    borrowedAt: row.borrowedAt,
    dueDate: row.dueDate,
  };
  if (row.returnedAt) {
    dto.returnedAt = row.returnedAt;
  }
  return dto;
}
