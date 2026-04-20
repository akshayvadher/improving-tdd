import { beforeEach, describe, expect, it } from 'vitest';

import { MemberNotFoundError, MembershipStatus } from '../membership/index.js';
import { sampleFinesConfig } from './sample-fines-data.js';
import {
  assessedEvents,
  autoSuspendedEvents,
  buildScene,
  FIXED_NOW,
  type Scene,
} from './testing/scene.js';
import { FineAlreadyPaidError, FineNotFoundError, type FinesConfig } from './fines.types.js';

describe('FinesFacade', () => {
  let scene: Scene;

  beforeEach(() => {
    scene = buildScene();
  });

  describe('assessFinesFor', () => {
    it('returns [] and persists nothing when the member has zero overdue loans', async () => {
      // given a registered member with no loans at all
      const alice = await scene.seedMember('Alice');

      // when fines are assessed for the member
      const assessed = await scene.fines.assessFinesFor(alice.memberId, FIXED_NOW);

      // then the returned list is empty, the repository is empty, and no events fired
      expect(assessed).toEqual([]);
      expect(await scene.repository.listFinesForMember(alice.memberId)).toEqual([]);
      expect(scene.bus.collected()).toEqual([]);
    });

    it('persists one fine with amountCents = daysOverdue * dailyRate for a single overdue loan', async () => {
      // given a member with one loan that is 10 days overdue and the default 25-cent daily rate
      const alice = await scene.seedMember('Alice');
      const loan = await scene.seedOverdueLoanFor(alice.memberId, 10);
      scene.bus.clear(); // drop the LoanOpened so we isolate FineAssessed

      // when fines are assessed at FIXED_NOW
      const assessed = await scene.fines.assessFinesFor(alice.memberId, FIXED_NOW);

      // then exactly one fine is returned with the expected shape
      expect(assessed).toHaveLength(1);
      const [fine] = assessed;
      expect(fine?.memberId).toBe(alice.memberId);
      expect(fine?.loanId).toBe(loan.loanId);
      expect(fine?.amountCents).toBe(10 * sampleFinesConfig().dailyRateCents);
      expect(fine?.paidAt).toBeNull();
      expect(fine?.assessedAt).toEqual(FIXED_NOW);

      // and the same fine is persisted in the repository
      expect(await scene.repository.listFinesForMember(alice.memberId)).toEqual(assessed);
    });

    it('persists one fine per overdue loan when the member has multiple', async () => {
      // given a member with three loans overdue by 5, 10, and 20 days respectively
      const alice = await scene.seedMember('Alice');
      const loanA = await scene.seedOverdueLoanFor(alice.memberId, 5);
      const loanB = await scene.seedOverdueLoanFor(alice.memberId, 10);
      const loanC = await scene.seedOverdueLoanFor(alice.memberId, 20);
      scene.bus.clear();

      // when fines are assessed at FIXED_NOW
      const assessed = await scene.fines.assessFinesFor(alice.memberId, FIXED_NOW);

      // then one fine was produced per overdue loan
      expect(assessed).toHaveLength(3);
      const loanIds = assessed.map((fine) => fine.loanId).sort();
      expect(loanIds).toEqual([loanA.loanId, loanB.loanId, loanC.loanId].sort());

      // and the returned array matches what was saved to the repository
      const stored = await scene.repository.listFinesForMember(alice.memberId);
      expect(stored.map((fine) => fine.fineId).sort()).toEqual(
        assessed.map((fine) => fine.fineId).sort(),
      );
    });

    it('emits one FineAssessed event per assessed fine with matching fields', async () => {
      // given a member with two overdue loans (7 and 14 days past due)
      const alice = await scene.seedMember('Alice');
      const loanA = await scene.seedOverdueLoanFor(alice.memberId, 7);
      const loanB = await scene.seedOverdueLoanFor(alice.memberId, 14);
      scene.bus.clear();

      // when fines are assessed
      const assessed = await scene.fines.assessFinesFor(alice.memberId, FIXED_NOW);

      // then exactly one FineAssessed event fired per fine with matching payloads
      const events = assessedEvents(scene.bus);
      expect(events).toHaveLength(2);

      const byLoanId = new Map(events.map((event) => [event.loanId, event]));
      for (const fine of assessed) {
        const event = byLoanId.get(fine.loanId);
        expect(event).toBeDefined();
        expect(event?.fineId).toBe(fine.fineId);
        expect(event?.memberId).toBe(fine.memberId);
        expect(event?.amountCents).toBe(fine.amountCents);
        expect(event?.assessedAt).toEqual(fine.assessedAt);
      }

      // and the set of loan ids on the events covers both overdue loans
      expect([...byLoanId.keys()].sort()).toEqual([loanA.loanId, loanB.loanId].sort());
    });

    it('propagates MemberNotFoundError and persists nothing for an unknown member', async () => {
      // given an id that was never registered with Membership

      // when fines are assessed for that id, the Membership lookup propagates
      await expect(scene.fines.assessFinesFor('ghost-member', FIXED_NOW)).rejects.toBeInstanceOf(
        MemberNotFoundError,
      );

      // then nothing was persisted and no events fired...
      expect(scene.bus.collected()).toEqual([]);

      // and the repository still looks clean when we assess for a real member afterwards
      const alice = await scene.seedMember('Alice');
      const assessedForReal = await scene.fines.assessFinesFor(alice.memberId, FIXED_NOW);
      expect(assessedForReal).toEqual([]);
      expect(await scene.repository.listFinesForMember(alice.memberId)).toEqual([]);
    });
  });

  describe('processOverdueLoans', () => {
    it('is a no-op when there are no overdue loans in the system (AC-3.1)', async () => {
      // given a scene with registered members but no overdue loans
      const alice = await scene.seedMember('Alice');
      const bob = await scene.seedMember('Bob');

      // when the batch runs
      await scene.fines.processOverdueLoans(FIXED_NOW);

      // then nothing was persisted and no events fired
      expect(await scene.repository.listFinesForMember(alice.memberId)).toEqual([]);
      expect(await scene.repository.listFinesForMember(bob.memberId)).toEqual([]);
      expect(scene.bus.collected()).toEqual([]);
    });

    it('assesses one fine per overdue loan grouped per member across N distinct members (AC-3.2)', async () => {
      // given three members each with overdue loans (below suspension threshold)
      // default threshold is 500 cents; keeping each member under threshold
      // (max total here is 10 days * 25 cents = 250 cents).
      const alice = await scene.seedMember('Alice');
      const bob = await scene.seedMember('Bob');
      const carol = await scene.seedMember('Carol');

      const aliceLoan1 = await scene.seedOverdueLoanFor(alice.memberId, 5);
      const aliceLoan2 = await scene.seedOverdueLoanFor(alice.memberId, 10);
      const bobLoan = await scene.seedOverdueLoanFor(bob.memberId, 7);
      const carolLoan1 = await scene.seedOverdueLoanFor(carol.memberId, 3);
      const carolLoan2 = await scene.seedOverdueLoanFor(carol.memberId, 4);
      scene.bus.clear();

      // when the batch runs
      await scene.fines.processOverdueLoans(FIXED_NOW);

      // then every overdue loan produced exactly one fine, grouped per member
      const aliceFines = await scene.repository.listFinesForMember(alice.memberId);
      const bobFines = await scene.repository.listFinesForMember(bob.memberId);
      const carolFines = await scene.repository.listFinesForMember(carol.memberId);

      expect(aliceFines.map((fine) => fine.loanId).sort()).toEqual(
        [aliceLoan1.loanId, aliceLoan2.loanId].sort(),
      );
      expect(bobFines.map((fine) => fine.loanId).sort()).toEqual([bobLoan.loanId]);
      expect(carolFines.map((fine) => fine.loanId).sort()).toEqual(
        [carolLoan1.loanId, carolLoan2.loanId].sort(),
      );

      // and every fine carries the correct member id (grouping, not a cross-wire)
      expect(aliceFines.every((fine) => fine.memberId === alice.memberId)).toBe(true);
      expect(bobFines.every((fine) => fine.memberId === bob.memberId)).toBe(true);
      expect(carolFines.every((fine) => fine.memberId === carol.memberId)).toBe(true);

      // and one FineAssessed event per overdue loan fired
      expect(assessedEvents(scene.bus)).toHaveLength(5);
    });

    it('does NOT suspend or emit MemberAutoSuspended when total unpaid stays below the threshold (AC-3.3)', async () => {
      // given a member whose resulting fines stay below threshold
      // one loan * 19 days * 25 cents = 475 cents, below the 500-cent threshold
      const alice = await scene.seedMember('Alice');
      await scene.seedOverdueLoanFor(alice.memberId, 19);
      scene.bus.clear();

      // when the batch runs
      await scene.fines.processOverdueLoans(FIXED_NOW);

      // then the member stays ACTIVE, no suspension happened
      const member = await scene.membership.findMember(alice.memberId);
      expect(member.status).toBe(MembershipStatus.ACTIVE);

      // and no MemberAutoSuspended event appears on the bus
      expect(autoSuspendedEvents(scene.bus)).toEqual([]);

      // and the fine itself WAS persisted (the below-threshold case still accrues)
      const fines = await scene.repository.listFinesForMember(alice.memberId);
      expect(fines).toHaveLength(1);
      expect(fines[0]?.amountCents).toBe(19 * sampleFinesConfig().dailyRateCents);
    });

    it('calls suspend once and emits exactly one MemberAutoSuspended with full fields at/above threshold (AC-3.4)', async () => {
      // given a member whose two overdue loans cross the threshold together
      // using a smaller config so the math reads cleanly: 2 loans * 10 days * 10 cents = 200 cents = threshold
      const config: FinesConfig = sampleFinesConfig({
        suspensionThresholdCents: 200,
        dailyRateCents: 10,
      });
      scene = buildScene({ config });

      const alice = await scene.seedMember('Alice');
      await scene.seedOverdueLoanFor(alice.memberId, 10);
      await scene.seedOverdueLoanFor(alice.memberId, 10);
      scene.bus.clear();

      // when the batch runs
      await scene.fines.processOverdueLoans(FIXED_NOW);

      // then exactly one MemberAutoSuspended event is emitted with every expected field
      const suspended = autoSuspendedEvents(scene.bus);
      expect(suspended).toHaveLength(1);
      const [event] = suspended;
      expect(event?.memberId).toBe(alice.memberId);
      expect(event?.totalUnpaidCents).toBe(200);
      expect(event?.thresholdCents).toBe(200);
      expect(event?.suspendedAt).toEqual(FIXED_NOW);

      // and the REAL MembershipFacade was used — the member is now SUSPENDED end-to-end.
      // This is the proof the facade wasn't stubbed: querying membership reflects state.
      const member = await scene.membership.findMember(alice.memberId);
      expect(member.status).toBe(MembershipStatus.SUSPENDED);
    });

    it('still assesses fines for an already-suspended member but does not re-suspend or re-publish (AC-3.5)', async () => {
      // given a member who borrows while eligible, then is manually suspended, and now has an overdue loan
      const alice = await scene.seedMember('Alice');
      const overdueLoan = await scene.seedOverdueLoanFor(alice.memberId, 20); // would cross threshold on its own
      await scene.membership.suspend(alice.memberId);
      scene.bus.clear();

      // when the batch runs against the now-suspended member
      await scene.fines.processOverdueLoans(FIXED_NOW);

      // then the fine was still assessed and a FineAssessed event was emitted
      const fines = await scene.repository.listFinesForMember(alice.memberId);
      expect(fines).toHaveLength(1);
      expect(fines[0]?.loanId).toBe(overdueLoan.loanId);
      expect(assessedEvents(scene.bus)).toHaveLength(1);

      // and no second suspension event fired (already suspended is a no-op)
      expect(autoSuspendedEvents(scene.bus)).toEqual([]);

      // and the member is still SUSPENDED (state unchanged)
      const member = await scene.membership.findMember(alice.memberId);
      expect(member.status).toBe(MembershipStatus.SUSPENDED);
    });

    describe('idempotency', () => {
      it('running twice over the same overdue loans persists exactly one fine per loan (AC-4.5)', async () => {
        // given a member with two overdue loans
        const alice = await scene.seedMember('Alice');
        const loanA = await scene.seedOverdueLoanFor(alice.memberId, 5);
        const loanB = await scene.seedOverdueLoanFor(alice.memberId, 8);
        scene.bus.clear();

        // when processOverdueLoans runs twice with the same overdue set
        await scene.fines.processOverdueLoans(FIXED_NOW);
        const finesAfterFirstRun = await scene.fines.listFinesFor(alice.memberId);
        await scene.fines.processOverdueLoans(FIXED_NOW);
        const finesAfterSecondRun = await scene.fines.listFinesFor(alice.memberId);

        // then only one fine exists per loan across both runs
        expect(finesAfterFirstRun).toHaveLength(2);
        expect(finesAfterSecondRun).toHaveLength(2);

        // and the fine ids did not change between runs (no new fines created)
        expect(finesAfterSecondRun.map((fine) => fine.fineId).sort()).toEqual(
          finesAfterFirstRun.map((fine) => fine.fineId).sort(),
        );

        // and the set of loan ids still matches what was overdue
        expect(finesAfterSecondRun.map((fine) => fine.loanId).sort()).toEqual(
          [loanA.loanId, loanB.loanId].sort(),
        );
      });

      it('does NOT re-emit FineAssessed for loans already fined on the second run (AC-4.6)', async () => {
        // given a member with two overdue loans
        const alice = await scene.seedMember('Alice');
        await scene.seedOverdueLoanFor(alice.memberId, 5);
        await scene.seedOverdueLoanFor(alice.memberId, 8);
        scene.bus.clear();

        // when the first run has happened, snapshot the FineAssessed count
        await scene.fines.processOverdueLoans(FIXED_NOW);
        const assessedAfterFirstRun = assessedEvents(scene.bus).length;
        expect(assessedAfterFirstRun).toBe(2);

        // and the second run executes over the same overdue set
        await scene.fines.processOverdueLoans(FIXED_NOW);

        // then no additional FineAssessed events were emitted
        expect(assessedEvents(scene.bus).length).toBe(assessedAfterFirstRun);
      });
    });
  });

  describe('listFinesFor', () => {
    it('returns [] for a member with no fines (AC-4.1)', async () => {
      // given a registered member with no fines
      const alice = await scene.seedMember('Alice');

      // when listing fines for that member
      const fines = await scene.fines.listFinesFor(alice.memberId);

      // then the result is an empty array
      expect(fines).toEqual([]);
    });

    it('returns fines in insertion order for a member (AC-4.1)', async () => {
      // given a member with three overdue loans assessed in a known order
      const alice = await scene.seedMember('Alice');
      const loanA = await scene.seedOverdueLoanFor(alice.memberId, 3);
      const loanB = await scene.seedOverdueLoanFor(alice.memberId, 7);
      const loanC = await scene.seedOverdueLoanFor(alice.memberId, 11);

      // when fines are assessed (assessFinesFor iterates loans in listLoansFor order) and then listed
      const assessed = await scene.fines.assessFinesFor(alice.memberId, FIXED_NOW);
      const listed = await scene.fines.listFinesFor(alice.memberId);

      // then listFinesFor returns the fines in the same order they were persisted
      expect(listed).toHaveLength(3);
      expect(listed.map((fine) => fine.fineId)).toEqual(assessed.map((fine) => fine.fineId));

      // and every seeded loan is represented exactly once
      expect(listed.map((fine) => fine.loanId).sort()).toEqual(
        [loanA.loanId, loanB.loanId, loanC.loanId].sort(),
      );
    });

    it('returns only the fines belonging to the requested member (AC-4.1)', async () => {
      // given two members each with an overdue loan
      const alice = await scene.seedMember('Alice');
      const bob = await scene.seedMember('Bob');
      await scene.seedOverdueLoanFor(alice.memberId, 5);
      await scene.seedOverdueLoanFor(bob.memberId, 6);
      await scene.fines.processOverdueLoans(FIXED_NOW);

      // when listing fines for each member
      const aliceFines = await scene.fines.listFinesFor(alice.memberId);
      const bobFines = await scene.fines.listFinesFor(bob.memberId);

      // then each list contains only its owner's fine
      expect(aliceFines).toHaveLength(1);
      expect(aliceFines[0]?.memberId).toBe(alice.memberId);
      expect(bobFines).toHaveLength(1);
      expect(bobFines[0]?.memberId).toBe(bob.memberId);
    });
  });

  describe('findFine', () => {
    it('returns the stored DTO for a known fine id (AC-4.2)', async () => {
      // given a member with one assessed fine
      const alice = await scene.seedMember('Alice');
      await scene.seedOverdueLoanFor(alice.memberId, 6);
      const [assessed] = await scene.fines.assessFinesFor(alice.memberId, FIXED_NOW);
      expect(assessed).toBeDefined();

      // when findFine is called with that fine id
      const found = await scene.fines.findFine(assessed!.fineId);

      // then the returned DTO matches the stored fine
      expect(found).toEqual(assessed);
    });

    it('throws FineNotFoundError when the fine id is unknown (AC-4.2)', async () => {
      // given a scene with no fines at all

      // when findFine is called with an unknown id, then it rejects with FineNotFoundError
      await expect(scene.fines.findFine('fine-does-not-exist')).rejects.toBeInstanceOf(
        FineNotFoundError,
      );
    });
  });

  describe('payFine', () => {
    it('stamps paidAt = clock() and returns the updated DTO (AC-4.3)', async () => {
      // given a member with one unpaid fine assessed against FIXED_NOW
      const alice = await scene.seedMember('Alice');
      await scene.seedOverdueLoanFor(alice.memberId, 4);
      const [assessed] = await scene.fines.assessFinesFor(alice.memberId, FIXED_NOW);
      expect(assessed?.paidAt).toBeNull();

      // when the fine is paid (scene's Fines clock is frozen at FIXED_NOW)
      const paid = await scene.fines.payFine(assessed!.fineId);

      // then paidAt is stamped to FIXED_NOW and the rest of the DTO is preserved
      expect(paid.paidAt).toEqual(FIXED_NOW);
      expect(paid.fineId).toBe(assessed!.fineId);
      expect(paid.memberId).toBe(assessed!.memberId);
      expect(paid.loanId).toBe(assessed!.loanId);
      expect(paid.amountCents).toBe(assessed!.amountCents);
      expect(paid.assessedAt).toEqual(assessed!.assessedAt);

      // and the repository reflects the updated paidAt on subsequent reads
      const reRead = await scene.fines.findFine(assessed!.fineId);
      expect(reRead.paidAt).toEqual(FIXED_NOW);
    });

    it('throws FineNotFoundError when the fine id is unknown (AC-4.3)', async () => {
      // given a scene with no fines

      // when payFine is called with an unknown id, then it rejects with FineNotFoundError
      await expect(scene.fines.payFine('fine-does-not-exist')).rejects.toBeInstanceOf(
        FineNotFoundError,
      );
    });

    it('rejects a second payFine with FineAlreadyPaidError and does not mutate paidAt (AC-4.4)', async () => {
      // given a fine that has been paid once
      const alice = await scene.seedMember('Alice');
      await scene.seedOverdueLoanFor(alice.memberId, 4);
      const [assessed] = await scene.fines.assessFinesFor(alice.memberId, FIXED_NOW);
      const firstPaid = await scene.fines.payFine(assessed!.fineId);
      const paidAtAfterFirstPayment = firstPaid.paidAt;

      // when payFine is called a second time on the same fine
      const secondAttempt = scene.fines.payFine(assessed!.fineId);

      // then it rejects with FineAlreadyPaidError
      await expect(secondAttempt).rejects.toBeInstanceOf(FineAlreadyPaidError);

      // and re-reading the fine shows paidAt is unchanged
      const reRead = await scene.fines.findFine(assessed!.fineId);
      expect(reRead.paidAt).toEqual(paidAtAfterFirstPayment);
    });
  });
});
