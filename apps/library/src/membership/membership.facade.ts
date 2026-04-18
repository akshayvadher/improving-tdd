import { Injectable } from '@nestjs/common';
import { randomUUID } from 'node:crypto';

import type { MembershipRepository } from './membership.repository.js';
import {
  DuplicateEmailError,
  InvalidMemberError,
  MemberNotFoundError,
  MembershipStatus,
  MembershipTier,
  type EligibilityDto,
  type MemberDto,
  type MemberId,
  type NewMemberDto,
} from './membership.types.js';

// Simple format check: one @, non-empty local part, a dotted domain.
// Not RFC 5322 — good enough for a domain invariant; exotic addresses can
// be rejected at the transport layer if the business ever cares.
const EMAIL_FORMAT = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

type IdGenerator = () => string;

@Injectable()
export class MembershipFacade {
  constructor(
    private readonly repository: MembershipRepository,
    private readonly newId: IdGenerator = randomUUID,
  ) {}

  async registerMember(dto: NewMemberDto): Promise<MemberDto> {
    const name = dto.name?.trim() ?? '';
    if (name.length === 0) {
      throw new InvalidMemberError('name is required');
    }

    const email = dto.email?.trim() ?? '';
    if (email.length === 0) {
      throw new InvalidMemberError('email is required');
    }
    if (!EMAIL_FORMAT.test(email)) {
      throw new InvalidMemberError(`email format is invalid: ${email}`);
    }

    const existing = await this.repository.findMemberByEmail(email);
    if (existing) {
      throw new DuplicateEmailError(email);
    }

    const member: MemberDto = {
      memberId: this.newId(),
      name,
      email,
      tier: MembershipTier.STANDARD,
      status: MembershipStatus.ACTIVE,
    };
    await this.repository.saveMember(member);
    return member;
  }

  async findMember(memberId: MemberId): Promise<MemberDto> {
    const member = await this.repository.findMemberById(memberId);
    if (!member) {
      throw new MemberNotFoundError(memberId);
    }
    return member;
  }

  suspend(memberId: MemberId): Promise<MemberDto> {
    return this.updateMemberStatus(memberId, MembershipStatus.SUSPENDED);
  }

  reactivate(memberId: MemberId): Promise<MemberDto> {
    return this.updateMemberStatus(memberId, MembershipStatus.ACTIVE);
  }

  async upgradeTier(memberId: MemberId, tier: MembershipTier): Promise<MemberDto> {
    const member = await this.repository.findMemberById(memberId);
    if (!member) {
      throw new MemberNotFoundError(memberId);
    }

    const updated: MemberDto = { ...member, tier };
    await this.repository.saveMember(updated);
    return updated;
  }

  async checkEligibility(memberId: MemberId): Promise<EligibilityDto> {
    const member = await this.repository.findMemberById(memberId);
    if (!member) {
      throw new MemberNotFoundError(memberId);
    }

    if (member.status === MembershipStatus.SUSPENDED) {
      return { memberId, eligible: false, reason: 'SUSPENDED' };
    }
    return { memberId, eligible: true };
  }

  private async updateMemberStatus(memberId: MemberId, status: MembershipStatus): Promise<MemberDto> {
    const member = await this.repository.findMemberById(memberId);
    if (!member) {
      throw new MemberNotFoundError(memberId);
    }

    const updated: MemberDto = { ...member, status };
    await this.repository.saveMember(updated);
    return updated;
  }
}
