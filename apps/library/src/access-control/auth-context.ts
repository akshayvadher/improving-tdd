import type { MemberId } from '../membership/index.js';
import type { AuthUser, Role } from './access-control.types.js';

// Static role assignments for the demo. In a real system this comes from auth.
// Anything not in the map defaults to MEMBER (the common case for a public library catalog).
const ROLES_BY_MEMBER_ID: Record<string, Role> = {};

export function lookupAuthUser(memberId: MemberId): AuthUser {
  return { memberId, role: ROLES_BY_MEMBER_ID[memberId] ?? 'MEMBER' };
}

export function setRoleForDemo(memberId: MemberId, role: Role): void {
  ROLES_BY_MEMBER_ID[memberId] = role;
}

export function resetRolesForDemo(): void {
  for (const k of Object.keys(ROLES_BY_MEMBER_ID)) delete ROLES_BY_MEMBER_ID[k];
}
