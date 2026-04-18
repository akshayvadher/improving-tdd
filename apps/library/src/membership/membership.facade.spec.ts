import { describe, expect, it } from 'vitest';

import { createMembershipFacade } from './membership.configuration.js';
import {
  DuplicateEmailError,
  MemberNotFoundError,
  MembershipStatus,
  MembershipTier,
} from './membership.types.js';
import { sampleNewMember, sampleNewMemberWithEmail } from './sample-membership-data.js';

// Deterministic id generator so member ids are predictable in assertions.
function sequentialIds(prefix = 'member'): () => string {
  let counter = 0;
  return () => `${prefix}-${++counter}`;
}

function buildFacade() {
  return createMembershipFacade({ newId: sequentialIds() });
}

describe('MembershipFacade', () => {
  it('registers a member with an id, STANDARD tier, and ACTIVE status by default', async () => {
    // given a membership module
    const membership = buildFacade();

    // when a member is registered
    const member = await membership.registerMember(sampleNewMember());

    // then the member has an id, default STANDARD tier, and ACTIVE status
    expect(member.memberId).toBeTruthy();
    expect(member.tier).toBe(MembershipTier.STANDARD);
    expect(member.status).toBe(MembershipStatus.ACTIVE);
  });

  it('finds a registered member by memberId', async () => {
    // given a registered member
    const membership = buildFacade();
    const registered = await membership.registerMember(sampleNewMember());

    // when the member is looked up by id
    const found = await membership.findMember(registered.memberId);

    // then the stored member is returned
    expect(found).toEqual(registered);
  });

  it('suspends an active member', async () => {
    // given an active member
    const membership = buildFacade();
    const member = await membership.registerMember(sampleNewMember());

    // when the member is suspended
    const suspended = await membership.suspend(member.memberId);

    // then the member's status is SUSPENDED
    expect(suspended.status).toBe(MembershipStatus.SUSPENDED);
    expect((await membership.findMember(member.memberId)).status).toBe(MembershipStatus.SUSPENDED);
  });

  it('reactivates a suspended member', async () => {
    // given a member that has been suspended
    const membership = buildFacade();
    const member = await membership.registerMember(sampleNewMember());
    await membership.suspend(member.memberId);

    // when the member is reactivated
    const reactivated = await membership.reactivate(member.memberId);

    // then the member's status is ACTIVE again
    expect(reactivated.status).toBe(MembershipStatus.ACTIVE);
    expect((await membership.findMember(member.memberId)).status).toBe(MembershipStatus.ACTIVE);
  });

  it('upgrades a member tier from STANDARD to PREMIUM', async () => {
    // given a member on the default STANDARD tier
    const membership = buildFacade();
    const member = await membership.registerMember(sampleNewMember());

    // when the tier is upgraded to PREMIUM
    const upgraded = await membership.upgradeTier(member.memberId, MembershipTier.PREMIUM);

    // then the member's tier is PREMIUM
    expect(upgraded.tier).toBe(MembershipTier.PREMIUM);
    expect((await membership.findMember(member.memberId)).tier).toBe(MembershipTier.PREMIUM);
  });

  it('reports an active member as eligible', async () => {
    // given an active member
    const membership = buildFacade();
    const member = await membership.registerMember(sampleNewMember());

    // when eligibility is checked
    const eligibility = await membership.checkEligibility(member.memberId);

    // then the member is eligible
    expect(eligibility.eligible).toBe(true);
    expect(eligibility.memberId).toBe(member.memberId);
  });

  it('reports a suspended member as ineligible with reason SUSPENDED', async () => {
    // given a suspended member
    const membership = buildFacade();
    const member = await membership.registerMember(sampleNewMember());
    await membership.suspend(member.memberId);

    // when eligibility is checked
    const eligibility = await membership.checkEligibility(member.memberId);

    // then the member is not eligible and the reason is SUSPENDED
    expect(eligibility.eligible).toBe(false);
    expect(eligibility.reason).toBe('SUSPENDED');
  });

  it('rejects registering a member with an email that already exists', async () => {
    // given a member already registered with a particular email
    const membership = buildFacade();
    await membership.registerMember(sampleNewMemberWithEmail('ada.lovelace@example.com'));

    // when / then registering another member with the same email
    await expect(
      membership.registerMember(sampleNewMemberWithEmail('ada.lovelace@example.com')),
    ).rejects.toThrow(DuplicateEmailError);
  });

  it('throws MemberNotFoundError when suspending an unknown member', async () => {
    // given an empty membership module
    const membership = buildFacade();

    // when / then suspending a member id that was never registered
    await expect(membership.suspend('unknown-member-id')).rejects.toThrow(MemberNotFoundError);
  });

  it('throws MemberNotFoundError when reactivating an unknown member', async () => {
    // given an empty membership module
    const membership = buildFacade();

    // when / then reactivating a member id that was never registered
    await expect(membership.reactivate('unknown-member-id')).rejects.toThrow(MemberNotFoundError);
  });

  it('throws MemberNotFoundError when upgrading the tier of an unknown member', async () => {
    // given an empty membership module
    const membership = buildFacade();

    // when / then upgrading the tier of a member id that was never registered
    await expect(
      membership.upgradeTier('unknown-member-id', MembershipTier.PREMIUM),
    ).rejects.toThrow(MemberNotFoundError);
  });

  it('throws MemberNotFoundError when checking eligibility of an unknown member', async () => {
    // given an empty membership module
    const membership = buildFacade();

    // when / then checking eligibility for a member id that was never registered
    await expect(membership.checkEligibility('unknown-member-id')).rejects.toThrow(
      MemberNotFoundError,
    );
  });
});
