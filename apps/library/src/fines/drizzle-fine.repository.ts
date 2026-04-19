import { eq } from 'drizzle-orm';

import type { AppDatabase } from '../db/client.js';
import { fines } from '../db/schema/index.js';
import type { LoanId } from '../lending/index.js';
import type { MemberId } from '../membership/index.js';
import type { FineRepository } from './fine.repository.js';
import type { FineDto, FineId } from './fines.types.js';

type FineRow = typeof fines.$inferSelect;

export class DrizzleFineRepository implements FineRepository {
  constructor(private readonly db: AppDatabase) {}

  async saveFine(fine: FineDto): Promise<void> {
    const row = toRow(fine);
    await this.db
      .insert(fines)
      .values(row)
      .onConflictDoUpdate({ target: fines.fineId, set: row });
  }

  async findFineById(fineId: FineId): Promise<FineDto | undefined> {
    const [row] = await this.db.select().from(fines).where(eq(fines.fineId, fineId));
    return row ? toDto(row) : undefined;
  }

  async findFineByLoanId(loanId: LoanId): Promise<FineDto | undefined> {
    const [row] = await this.db.select().from(fines).where(eq(fines.loanId, loanId));
    return row ? toDto(row) : undefined;
  }

  async listFinesForMember(memberId: MemberId): Promise<FineDto[]> {
    const rows = await this.db.select().from(fines).where(eq(fines.memberId, memberId));
    return rows.map(toDto);
  }
}

function toRow(fine: FineDto): FineRow {
  return {
    fineId: fine.fineId,
    memberId: fine.memberId,
    loanId: fine.loanId,
    amountCents: fine.amountCents,
    assessedAt: fine.assessedAt,
    paidAt: fine.paidAt,
  };
}

function toDto(row: FineRow): FineDto {
  return {
    fineId: row.fineId,
    memberId: row.memberId,
    loanId: row.loanId,
    amountCents: row.amountCents,
    assessedAt: row.assessedAt,
    paidAt: row.paidAt,
  };
}
