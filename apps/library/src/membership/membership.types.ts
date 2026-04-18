export type MemberId = string;

export type MembershipTier = 'STANDARD' | 'PREMIUM';

export const MembershipTier = {
  STANDARD: 'STANDARD',
  PREMIUM: 'PREMIUM',
} as const satisfies Record<string, MembershipTier>;

export type MembershipStatus = 'ACTIVE' | 'SUSPENDED';

export const MembershipStatus = {
  ACTIVE: 'ACTIVE',
  SUSPENDED: 'SUSPENDED',
} as const satisfies Record<string, MembershipStatus>;

export interface NewMemberDto {
  name: string;
  email: string;
}

export interface MemberDto {
  memberId: MemberId;
  name: string;
  email: string;
  tier: MembershipTier;
  status: MembershipStatus;
}

export interface EligibilityDto {
  memberId: MemberId;
  eligible: boolean;
  reason?: string;
}

export class MemberNotFoundError extends Error {
  constructor(identifier: string) {
    super(`Member not found: ${identifier}`);
    this.name = 'MemberNotFoundError';
  }
}

export class DuplicateEmailError extends Error {
  constructor(email: string) {
    super(`A member with email ${email} already exists`);
    this.name = 'DuplicateEmailError';
  }
}
