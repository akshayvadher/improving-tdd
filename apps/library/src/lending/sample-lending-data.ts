import type { BookId, CopyId } from '../catalog/index.js';
import type { MemberId } from '../membership/index.js';

export interface BorrowRequest {
  memberId: MemberId;
  copyId: CopyId;
}

export interface ReserveRequest {
  memberId: MemberId;
  bookId: BookId;
}

export function sampleBorrowRequest(overrides: Partial<BorrowRequest> = {}): BorrowRequest {
  return {
    memberId: 'member-placeholder-id',
    copyId: 'copy-placeholder-id',
    ...overrides,
  };
}

export function sampleReserveRequest(overrides: Partial<ReserveRequest> = {}): ReserveRequest {
  return {
    memberId: 'member-placeholder-id',
    bookId: 'book-placeholder-id',
    ...overrides,
  };
}
