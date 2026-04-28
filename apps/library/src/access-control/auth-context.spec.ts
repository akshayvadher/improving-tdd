import { afterEach, describe, expect, it } from 'vitest';

import { lookupAuthUser, resetRolesForDemo, setRoleForDemo } from './auth-context.js';

// The auth-context module owns process-level singleton state (a Record<MemberId, Role>
// living at module scope). That's intentional: it stands in for an external auth lookup
// in this teaching demo, and the controller / integration tests need a single source
// of truth they can seed. Module-singleton state is unusual in this codebase, so each
// test resets it via `resetRolesForDemo()` to keep tests independent.

describe('auth-context', () => {
  afterEach(() => {
    resetRolesForDemo();
  });

  it('defaults to a MEMBER AuthUser for any memberId not in the map', () => {
    const result = lookupAuthUser('member-unseeded');

    expect(result).toEqual({ memberId: 'member-unseeded', role: 'MEMBER' });
  });

  it('returns the ACCOUNT role after setRoleForDemo seeds the memberId as ACCOUNT', () => {
    setRoleForDemo('member-seeded', 'ACCOUNT');

    const result = lookupAuthUser('member-seeded');

    expect(result).toEqual({ memberId: 'member-seeded', role: 'ACCOUNT' });
  });

  it('reverts a previously-seeded memberId back to MEMBER after resetRolesForDemo', () => {
    setRoleForDemo('member-seeded', 'ACCOUNT');
    resetRolesForDemo();

    const result = lookupAuthUser('member-seeded');

    expect(result).toEqual({ memberId: 'member-seeded', role: 'MEMBER' });
  });
});
