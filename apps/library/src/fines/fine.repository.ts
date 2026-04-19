import type { LoanId } from '../lending/index.js';
import type { MemberId } from '../membership/index.js';
import type { FineDto, FineId } from './fines.types.js';

export interface FineRepository {
  saveFine(fine: FineDto): Promise<void>;
  findFineById(fineId: FineId): Promise<FineDto | undefined>;
  findFineByLoanId(loanId: LoanId): Promise<FineDto | undefined>;
  listFinesForMember(memberId: MemberId): Promise<FineDto[]>;
}
