import type { NewMemberDto } from './membership.types.js';

export function sampleNewMember(overrides: Partial<NewMemberDto> = {}): NewMemberDto {
  return {
    name: 'Ada Lovelace',
    email: 'ada.lovelace@example.com',
    ...overrides,
  };
}

export function sampleNewMemberWithEmail(email: string): NewMemberDto {
  return sampleNewMember({ email });
}
