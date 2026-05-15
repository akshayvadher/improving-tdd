import { describe, expect, it } from 'vitest';

import { createAccessControlFacade } from './access-control.configuration.js';
import { UnauthorizedRoleError, UnknownActionError } from './access-control.types.js';
import { POLICY } from './policy.js';
import { sampleAuthUser, sampleStaffAuthUser } from './sample-access-control-data.js';

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

  it('AC-8: permits a STAFF user to perform catalog.uploadThumbnail', () => {
    // given
    const facade = createAccessControlFacade();
    const staff = sampleStaffAuthUser();

    // when / then
    expect(() => facade.authorize(staff, 'catalog', 'uploadThumbnail')).not.toThrow();
  });

  it('AC-9: throws UnauthorizedRoleError when a MEMBER attempts catalog.uploadThumbnail', () => {
    // given
    const facade = createAccessControlFacade();
    const member = sampleAuthUser({ memberId: 'member-up-1', role: 'MEMBER' });

    // when
    const act = () => facade.authorize(member, 'catalog', 'uploadThumbnail');

    // then
    expect(act).toThrow(UnauthorizedRoleError);
    try {
      act();
    } catch (error) {
      const err = error as UnauthorizedRoleError;
      expect(err.memberId).toBe('member-up-1');
      expect(err.role).toBe('MEMBER');
      expect(err.moduleName).toBe('catalog');
      expect(err.action).toBe('uploadThumbnail');
    }
  });

  it('AC-10: throws UnauthorizedRoleError when an ACCOUNT attempts catalog.uploadThumbnail', () => {
    // given
    const facade = createAccessControlFacade();
    const account = sampleAuthUser({ memberId: 'member-acc-up-1', role: 'ACCOUNT' });

    // when
    const act = () => facade.authorize(account, 'catalog', 'uploadThumbnail');

    // then
    expect(act).toThrow(UnauthorizedRoleError);
    try {
      act();
    } catch (error) {
      const err = error as UnauthorizedRoleError;
      expect(err.memberId).toBe('member-acc-up-1');
      expect(err.role).toBe('ACCOUNT');
      expect(err.moduleName).toBe('catalog');
      expect(err.action).toBe('uploadThumbnail');
    }
  });

  it('AC-11: permits a STAFF user to perform catalog.removeThumbnail', () => {
    // given
    const facade = createAccessControlFacade();
    const staff = sampleStaffAuthUser();

    // when / then
    expect(() => facade.authorize(staff, 'catalog', 'removeThumbnail')).not.toThrow();
  });

  it('AC-12: throws UnauthorizedRoleError when a MEMBER attempts catalog.removeThumbnail', () => {
    // given
    const facade = createAccessControlFacade();
    const member = sampleAuthUser({ memberId: 'member-rm-1', role: 'MEMBER' });

    // when
    const act = () => facade.authorize(member, 'catalog', 'removeThumbnail');

    // then
    expect(act).toThrow(UnauthorizedRoleError);
    try {
      act();
    } catch (error) {
      const err = error as UnauthorizedRoleError;
      expect(err.memberId).toBe('member-rm-1');
      expect(err.role).toBe('MEMBER');
      expect(err.moduleName).toBe('catalog');
      expect(err.action).toBe('removeThumbnail');
    }
  });

  it('AC-13: POLICY.catalog snapshots uploadThumbnail and removeThumbnail as STAFF-only and authorize honors that exact data', () => {
    // given
    const facade = createAccessControlFacade();

    // when / then — snapshot the policy data, then prove authorize reads it
    expect(POLICY.catalog?.uploadThumbnail).toEqual(['STAFF']);
    expect(POLICY.catalog?.removeThumbnail).toEqual(['STAFF']);
    expect(() => facade.authorize(sampleStaffAuthUser(), 'catalog', 'uploadThumbnail')).not.toThrow();
    expect(() => facade.authorize(sampleStaffAuthUser(), 'catalog', 'removeThumbnail')).not.toThrow();
    expect(() =>
      facade.authorize(sampleAuthUser({ role: 'MEMBER' }), 'catalog', 'uploadThumbnail'),
    ).toThrow(UnauthorizedRoleError);
    expect(() =>
      facade.authorize(sampleAuthUser({ role: 'MEMBER' }), 'catalog', 'removeThumbnail'),
    ).toThrow(UnauthorizedRoleError);
  });

  it('AC-14: sampleStaffAuthUser returns a STAFF-roled AuthUser and the override-spread replaces memberId while preserving the STAFF role', () => {
    // given / when
    const defaultStaff = sampleStaffAuthUser();
    const overridden = sampleStaffAuthUser({ memberId: 'staff-42' });

    // then — default is a STAFF user that the facade actually accepts for staff-only actions
    expect(defaultStaff.role).toBe('STAFF');
    const facade = createAccessControlFacade();
    expect(() => facade.authorize(defaultStaff, 'catalog', 'uploadThumbnail')).not.toThrow();

    // and — override replaces memberId, role still STAFF (override-spread convention)
    expect(overridden.memberId).toBe('staff-42');
    expect(overridden.role).toBe('STAFF');
    expect(overridden.memberId).not.toBe(defaultStaff.memberId);
  });
});
