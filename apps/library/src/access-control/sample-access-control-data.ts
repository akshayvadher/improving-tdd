import type { AuthUser } from './access-control.types.js';

export function sampleAuthUser(overrides: Partial<AuthUser> = {}): AuthUser {
  return {
    memberId: 'member-placeholder-id',
    role: 'MEMBER',
    ...overrides,
  };
}
