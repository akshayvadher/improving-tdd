import { Body, Controller, Get, Param, Patch, Post, Query } from '@nestjs/common';

import type { BookId, CopyId } from '../catalog/index.js';
import type { MemberId } from '../membership/index.js';
import { LendingFacade } from './lending.facade.js';
import type {
  ActiveLoanWithQueuedCount,
  LoanDto,
  LoanId,
  OverdueLoanReport,
  ReservationDto,
} from './lending.types.js';

interface BorrowBody {
  memberId: MemberId;
  copyId: CopyId;
}

interface ReserveBody {
  memberId: MemberId;
  bookId: BookId;
}

@Controller()
export class LendingController {
  constructor(private readonly facade: LendingFacade) {}

  @Post('loans')
  borrow(@Body() body: BorrowBody): Promise<LoanDto> {
    return this.facade.borrow(body.memberId, body.copyId);
  }

  @Patch('loans/:loanId/return')
  returnLoan(@Param('loanId') loanId: LoanId): Promise<LoanDto> {
    return this.facade.returnLoan(loanId);
  }

  @Post('reservations')
  reserve(@Body() body: ReserveBody): Promise<ReservationDto> {
    return this.facade.reserve(body.memberId, body.bookId);
  }

  @Get('loans/overdue')
  listOverdueLoans(@Query('now') now?: string): Promise<LoanDto[]> {
    const at = now ? new Date(now) : new Date();
    return this.facade.listOverdueLoans(at);
  }

  @Get('loans/overdue/with-titles')
  listOverdueLoansWithTitles(@Query('now') now?: string): Promise<OverdueLoanReport[]> {
    const at = now ? new Date(now) : new Date();
    return this.facade.listOverdueLoansWithTitles(at);
  }

  @Get('loans/active-with-reservation-counts')
  listActiveLoansWithQueuedReservations(): Promise<ActiveLoanWithQueuedCount[]> {
    return this.facade.listActiveLoansWithQueuedReservations();
  }

  @Get('members/:memberId/loans')
  listLoansFor(@Param('memberId') memberId: MemberId): Promise<LoanDto[]> {
    return this.facade.listLoansFor(memberId);
  }
}
