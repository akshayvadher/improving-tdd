import type { LoanId } from '../lending/index.js';
import type { MemberId } from '../membership/index.js';
import type { FineRepository } from './fine.repository.js';
import type { FineDto, FineId } from './fines.types.js';

export class InMemoryFineRepository implements FineRepository {
  private readonly finesById = new Map<FineId, FineDto>();

  async saveFine(fine: FineDto): Promise<void> {
    this.finesById.set(fine.fineId, { ...fine });
  }

  async findFineById(fineId: FineId): Promise<FineDto | undefined> {
    const stored = this.finesById.get(fineId);
    return stored ? { ...stored } : undefined;
  }

  async findFineByLoanId(loanId: LoanId): Promise<FineDto | undefined> {
    for (const fine of this.finesById.values()) {
      if (fine.loanId === loanId) {
        return { ...fine };
      }
    }
    return undefined;
  }

  async listFinesForMember(memberId: MemberId): Promise<FineDto[]> {
    return Array.from(this.finesById.values())
      .filter((fine) => fine.memberId === memberId)
      .map((fine) => ({ ...fine }));
  }
}
