import { Body, Controller, Get, Param, Patch, Post } from '@nestjs/common';

import { MembershipFacade } from './membership.facade.js';
import type {
  EligibilityDto,
  MemberDto,
  MemberId,
  MembershipTier,
  NewMemberDto,
} from './membership.types.js';

interface UpgradeTierBody {
  tier: MembershipTier;
}

@Controller('members')
export class MembershipController {
  constructor(private readonly facade: MembershipFacade) {}

  @Post()
  registerMember(@Body() dto: NewMemberDto): Promise<MemberDto> {
    return this.facade.registerMember(dto);
  }

  @Get(':id')
  findMember(@Param('id') id: MemberId): Promise<MemberDto> {
    return this.facade.findMember(id);
  }

  @Patch(':id/suspend')
  suspend(@Param('id') id: MemberId): Promise<MemberDto> {
    return this.facade.suspend(id);
  }

  @Patch(':id/reactivate')
  reactivate(@Param('id') id: MemberId): Promise<MemberDto> {
    return this.facade.reactivate(id);
  }

  @Patch(':id/tier')
  upgradeTier(@Param('id') id: MemberId, @Body() body: UpgradeTierBody): Promise<MemberDto> {
    return this.facade.upgradeTier(id, body.tier);
  }

  @Get(':id/eligibility')
  checkEligibility(@Param('id') id: MemberId): Promise<EligibilityDto> {
    return this.facade.checkEligibility(id);
  }
}
