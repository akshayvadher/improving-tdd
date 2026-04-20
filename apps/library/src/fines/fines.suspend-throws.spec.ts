// This file contains the single hand-rolled fake in the Fines unit suite.
// Every other Fines test uses real factory-wired facades. This test exists
// because the real MembershipFacade cannot be induced to throw at the exact
// mid-batch moment without corrupting state other tests rely on. See
// GUIDE.md Principle 7 (b).
//
// The behaviour under test is:
//   "when Membership.suspend throws mid-batch, fines that were already
//    recorded must persist; MemberAutoSuspended must not fire for the
//    failed member; later members must not be reached."
//
// A hand-rolled wrapper that delegates every method to the real facade
// and throws on the first suspend call is the only honest way to observe
// this failure mode. If you are adding another hand-rolled fake under
// `apps/library/src/fines/`, the test probably belongs somewhere else,
// or needs the same kind of justification in prose.

import { beforeEach, describe, expect, it } from 'vitest';

import {
  MembershipFacade,
  type EligibilityDto,
  type MemberDto,
  type MemberId,
  type MembershipTier,
  type NewMemberDto,
} from '../membership/index.js';
import { createMembershipFacade } from '../membership/membership.configuration.js';
import { InMemoryMembershipRepository } from '../membership/in-memory-membership.repository.js';
import { sampleFinesConfig } from './sample-fines-data.js';
import type { FinesConfig } from './fines.types.js';
import {
  assessedEvents,
  autoSuspendedEvents,
  buildScene,
  FIXED_NOW,
  sequentialIds,
  type Scene,
} from './testing/scene.js';

// ThrowingOnceMembershipFacade wraps a real MembershipFacade (built via
// createMembershipFacade so every other method — registerMember, findMember,
// checkEligibility, reactivate, upgradeTier — behaves exactly as in the rest
// of the Fines suite) and throws a deterministic error on the FIRST call to
// `suspend` only. Subsequent suspend calls delegate normally.
//
// Why extend rather than Pick<>: MembershipFacade is a class with private
// fields (`repository`, `newId`), so TypeScript treats it nominally. To
// satisfy FinesFacade's constructor parameter type (MembershipFacade) and
// createLendingFacade({ membershipFacade }) without `as unknown as`, the
// cleanest path is to extend the class and override every method. A
// trivial InMemoryMembershipRepository is passed to super; because every
// method is overridden to delegate to `this.delegate`, super's internal
// repo/newId are never reached at runtime.
class ThrowingOnceMembershipFacade extends MembershipFacade {
  private hasThrown = false;

  constructor(
    private readonly delegate: MembershipFacade,
    private readonly errorToThrow: Error,
  ) {
    super(new InMemoryMembershipRepository());
  }

  override registerMember(dto: NewMemberDto): Promise<MemberDto> {
    return this.delegate.registerMember(dto);
  }

  override findMember(memberId: MemberId): Promise<MemberDto> {
    return this.delegate.findMember(memberId);
  }

  override suspend(memberId: MemberId): Promise<MemberDto> {
    if (!this.hasThrown) {
      this.hasThrown = true;
      return Promise.reject(this.errorToThrow);
    }
    return this.delegate.suspend(memberId);
  }

  override reactivate(memberId: MemberId): Promise<MemberDto> {
    return this.delegate.reactivate(memberId);
  }

  override upgradeTier(memberId: MemberId, tier: MembershipTier): Promise<MemberDto> {
    return this.delegate.upgradeTier(memberId, tier);
  }

  override checkEligibility(memberId: MemberId): Promise<EligibilityDto> {
    return this.delegate.checkEligibility(memberId);
  }
}

describe('FinesFacade', () => {
  describe('when Membership.suspend throws mid-batch (hand-rolled fake)', () => {
    let scene: Scene;
    let alice: { memberId: string };
    let bob: { memberId: string };
    let aliceLoanId: string;
    let thrownError: unknown;

    const suspendError = new Error('membership store is down');

    beforeEach(async () => {
      // given a scene with Membership wrapped in a throwing-once facade, and
      // a low threshold so a single modestly-overdue loan trips suspension
      const config: FinesConfig = sampleFinesConfig({
        suspensionThresholdCents: 100,
        dailyRateCents: 10,
      });
      const realMembership = createMembershipFacade({ newId: sequentialIds('mem') });
      const throwingMembership = new ThrowingOnceMembershipFacade(realMembership, suspendError);
      scene = buildScene({ config, membership: throwingMembership });

      // and two members, each with an overdue loan; the first member's fine
      // (10 days * 10 cents = 100 cents) hits the threshold and triggers suspend
      alice = await scene.seedMember('Alice');
      bob = await scene.seedMember('Bob');
      const aliceLoan = await scene.seedOverdueLoanFor(alice.memberId, 10);
      aliceLoanId = aliceLoan.loanId;
      await scene.seedOverdueLoanFor(bob.memberId, 10);
      scene.bus.clear();

      // when processOverdueLoans runs, the first suspend call throws and the
      // error propagates out of the batch. Cache the rejected error so each
      // `it` below can assert one invariant against the aftermath.
      thrownError = await scene.fines.processOverdueLoans(FIXED_NOW).then(
        () => undefined,
        (error: unknown) => error,
      );
    });

    it('propagates the error to the caller (AC-5.3 propagation)', () => {
      // then the batch rejected with the exact error the throwing facade raised
      expect(thrownError).toBeInstanceOf(Error);
      expect((thrownError as Error).message).toBe('membership store is down');
    });

    it('persists fines recorded before the throw (AC-5.4 non-rollback)', async () => {
      // then the fine recorded for Alice BEFORE the suspend call remains in
      // the repository — not rolled back
      const aliceFines = await scene.fines.listFinesFor(alice.memberId);
      expect(aliceFines).toHaveLength(1);
      expect(aliceFines[0]?.loanId).toBe(aliceLoanId);
      expect(aliceFines[0]?.amountCents).toBe(100);
    });

    it('keeps FineAssessed events on the bus (AC-5.5)', () => {
      // then the FineAssessed event published before the throw remains on the bus
      const assessed = assessedEvents(scene.bus);
      expect(assessed).toHaveLength(1);
      expect(assessed[0]?.memberId).toBe(alice.memberId);
      expect(assessed[0]?.loanId).toBe(aliceLoanId);
    });

    it('does NOT publish MemberAutoSuspended for the member whose suspend threw (AC-5.6)', () => {
      // then no MemberAutoSuspended is emitted for Alice (or anyone else)
      expect(autoSuspendedEvents(scene.bus)).toEqual([]);
    });

    it('halts processing before the second member is reached (AC-5.3 halt semantics)', async () => {
      // then Bob's fines are empty — the batch stopped at the throw and never
      // moved on to process the second member
      const bobFines = await scene.fines.listFinesFor(bob.memberId);
      expect(bobFines).toEqual([]);
    });
  });
});
