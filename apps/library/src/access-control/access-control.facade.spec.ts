import { describe, expect, it } from 'vitest';

import { createAccessControlFacade } from './access-control.configuration.js';
import { UnauthorizedRoleError, UnknownActionError } from './access-control.types.js';
import { POLICY } from './policy.js';
import { sampleAuthUser } from './sample-access-control-data.js';

describe('AccessControlFacade', () => {
  it('AC-1: permits a MEMBER to perform lending.borrow', () => {
    // given
    const facade = createAccessControlFacade();
    const member = sampleAuthUser({ role: 'MEMBER' });

    // when / then
    expect(() => facade.authorize(member, 'lending', 'borrow')).not.toThrow();
  });

  it('AC-2: throws UnauthorizedRoleError carrying memberId, role, moduleName, action when an ACCOUNT attempts lending.borrow', () => {
    // given
    const facade = createAccessControlFacade();
    const account = sampleAuthUser({ memberId: 'member-acc-1', role: 'ACCOUNT' });

    // when
    const act = () => facade.authorize(account, 'lending', 'borrow');

    // then
    expect(act).toThrow(UnauthorizedRoleError);
    try {
      act();
    } catch (error) {
      const err = error as UnauthorizedRoleError;
      expect(err.memberId).toBe('member-acc-1');
      expect(err.role).toBe('ACCOUNT');
      expect(err.moduleName).toBe('lending');
      expect(err.action).toBe('borrow');
    }
  });

  it('AC-3: throws UnknownActionError carrying moduleName + action for an unknown action under a known module', () => {
    // given
    const facade = createAccessControlFacade();
    const member = sampleAuthUser({ role: 'MEMBER' });

    // when
    const act = () => facade.authorize(member, 'lending', 'unknown-action');

    // then
    expect(act).toThrow(UnknownActionError);
    try {
      act();
    } catch (error) {
      const err = error as UnknownActionError;
      expect(err.moduleName).toBe('lending');
      expect(err.action).toBe('unknown-action');
    }
  });

  it('AC-4: throws UnknownActionError carrying moduleName + action for an unknown module', () => {
    // given
    const facade = createAccessControlFacade();
    const member = sampleAuthUser({ role: 'MEMBER' });

    // when
    const act = () => facade.authorize(member, 'unknown-module', 'borrow');

    // then
    expect(act).toThrow(UnknownActionError);
    try {
      act();
    } catch (error) {
      const err = error as UnknownActionError;
      expect(err.moduleName).toBe('unknown-module');
      expect(err.action).toBe('borrow');
    }
  });

  it('AC-5: UnauthorizedRoleError message includes the role, module, and action for debuggability', () => {
    // given
    const facade = createAccessControlFacade();
    const account = sampleAuthUser({ role: 'ACCOUNT' });

    // when / then
    expect(() => facade.authorize(account, 'lending', 'borrow')).toThrow(
      /role ACCOUNT.*lending\.borrow/,
    );
  });

  it('AC-6: is data-driven — POLICY.lending.borrow is [MEMBER] and authorize honors that exact data', () => {
    // given
    const facade = createAccessControlFacade();

    // when / then — snapshot the policy data, then prove authorize reads it
    expect(POLICY.lending?.borrow).toEqual(['MEMBER']);
    expect(() => facade.authorize(sampleAuthUser({ role: 'MEMBER' }), 'lending', 'borrow')).not.toThrow();
    expect(() => facade.authorize(sampleAuthUser({ role: 'ACCOUNT' }), 'lending', 'borrow')).toThrow(
      UnauthorizedRoleError,
    );
  });

  it('AC-7: authorize returns void on success (no value to consume)', () => {
    // given
    const facade = createAccessControlFacade();

    // when
    const result = facade.authorize(sampleAuthUser({ role: 'MEMBER' }), 'lending', 'borrow');

    // then
    expect(result).toBeUndefined();
  });
});
