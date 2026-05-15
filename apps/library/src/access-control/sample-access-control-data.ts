import type { AuthUser } from './access-control.types.js';

export function sampleAuthUser(overrides: Partial<AuthUser> = {}): AuthUser {
  return {
    memberId: 'member-placeholder-id',
    role: 'MEMBER',
    ...overrides,
  };
}

export function sampleStaffAuthUser(overrides: Partial<AuthUser> = {}): AuthUser {
  return {
    memberId: 'staff-placeholder-id',
    role: 'STAFF',
    ...overrides,
  };
}
