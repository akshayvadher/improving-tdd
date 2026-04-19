import { Controller, Get, HttpCode, Param, Patch, Post } from '@nestjs/common';

import type { MemberId } from '../membership/index.js';
import { FinesFacade } from './fines.facade.js';
import type { FineDto, FineId } from './fines.types.js';

@Controller()
export class FinesController {
  constructor(private readonly facade: FinesFacade) {}

  @Post('members/:memberId/fines/assessments')
  @HttpCode(200)
  assessFinesFor(@Param('memberId') memberId: MemberId): Promise<FineDto[]> {
    return this.facade.assessFinesFor(memberId, new Date());
  }

  @Post('fines/batch/process')
  @HttpCode(204)
  async processOverdueLoans(): Promise<void> {
    await this.facade.processOverdueLoans(new Date());
  }

  @Get('members/:memberId/fines')
  listFinesFor(@Param('memberId') memberId: MemberId): Promise<FineDto[]> {
    return this.facade.listFinesFor(memberId);
  }

  @Get('fines/:fineId')
  findFine(@Param('fineId') fineId: FineId): Promise<FineDto> {
    return this.facade.findFine(fineId);
  }

  @Patch('fines/:fineId/paid')
  payFine(@Param('fineId') fineId: FineId): Promise<FineDto> {
    return this.facade.payFine(fineId);
  }
}
