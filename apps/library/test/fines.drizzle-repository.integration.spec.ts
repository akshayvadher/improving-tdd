import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { createDatabase, type DatabaseHandle } from '../src/db/client.js';
import { fines } from '../src/db/schema/index.js';
import { DrizzleFineRepository } from '../src/fines/drizzle-fine.repository.js';
import { sampleFine } from '../src/fines/sample-fines-data.js';
import { DOCKER_UNAVAILABLE_MESSAGE, dockerIsAvailable } from './support/require-docker.js';
import { startPostgres, type PostgresFixture } from './support/testcontainers.js';

// The unit spec exercises FinesFacade + InMemoryFineRepository end-to-end on an
// in-memory Map. This integration counterpart pins the Drizzle boundary: the
// row↔DTO mapping, the upsert semantics, and the timestamp/integer/nullable
// column behaviour that only a real Postgres can reveal. Same repository
// contract, different substrate — Principle 5.

const suite = dockerIsAvailable() ? describe : describe.skip;
if (!dockerIsAvailable()) {
  // eslint-disable-next-line no-console
  console.warn(`[integration] ${DOCKER_UNAVAILABLE_MESSAGE}`);
}

suite('DrizzleFineRepository (real Postgres)', () => {
  let fixture: PostgresFixture;
  let handle: DatabaseHandle;
  let repository: DrizzleFineRepository;

  beforeAll(async () => {
    fixture = await startPostgres();
    handle = createDatabase(fixture.connectionUrl);
    repository = new DrizzleFineRepository(handle.db);
  }, 120_000);

  afterAll(async () => {
    if (handle) {
      await handle.close();
    }
    if (fixture) {
      await fixture.stop();
    }
  });

  beforeEach(async () => {
    // Each test gets an empty fines table so rows from earlier cases don't
    // leak into listFinesForMember assertions. Catalog/Membership/Lending
    // rows aren't touched — this repo only reads/writes `fines`.
    await handle.db.delete(fines);
  });

  it('round-trips a paid fine through saveFine and findFineById with every field preserved', async () => {
    // given a fully-populated fine DTO with a real paidAt timestamp
    const fine = sampleFine({
      fineId: '11111111-1111-1111-1111-111111111111',
      memberId: '22222222-2222-2222-2222-222222222222',
      loanId: '33333333-3333-3333-3333-333333333333',
      amountCents: 175,
      assessedAt: new Date('2030-01-15T12:00:00.000Z'),
      paidAt: new Date('2030-01-20T09:30:00.000Z'),
    });

    // when it is saved and then fetched by id
    await repository.saveFine(fine);
    const found = await repository.findFineById(fine.fineId);

    // then every field round-trips identically
    expect(found).toBeDefined();
    expect(found?.fineId).toBe(fine.fineId);
    expect(found?.memberId).toBe(fine.memberId);
    expect(found?.loanId).toBe(fine.loanId);
    expect(found?.amountCents).toBe(fine.amountCents);
    expect(found?.assessedAt.getTime()).toBe(fine.assessedAt.getTime());
    expect(found?.paidAt?.getTime()).toBe(fine.paidAt?.getTime());
  });

  it('persists paidAt as null for an unpaid fine and returns it as null', async () => {
    // given an unpaid fine (the default state after assessment)
    const fine = sampleFine({
      fineId: '44444444-4444-4444-4444-444444444444',
      memberId: '55555555-5555-5555-5555-555555555555',
      loanId: '66666666-6666-6666-6666-666666666666',
      amountCents: 50,
      assessedAt: new Date('2030-02-01T00:00:00.000Z'),
      paidAt: null,
    });

    // when it is saved and fetched back
    await repository.saveFine(fine);
    const found = await repository.findFineById(fine.fineId);

    // then paidAt survives the round-trip as null (not undefined, not a zero-date)
    expect(found).toBeDefined();
    expect(found?.paidAt).toBeNull();
  });

  it('returns undefined from findFineById for an unknown id', async () => {
    // given no fine with this id has been saved

    // when findFineById is called with an unknown id
    const found = await repository.findFineById('99999999-9999-9999-9999-999999999999');

    // then the repository reports miss as undefined, matching the interface contract
    expect(found).toBeUndefined();
  });

  it('upserts on saveFine so a second save of the same fineId updates the row in place', async () => {
    // given a fine that has been saved once
    const fineId = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
    const memberId = 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb';
    const original = sampleFine({
      fineId,
      memberId,
      loanId: 'cccccccc-cccc-cccc-cccc-cccccccccccc',
      amountCents: 100,
      assessedAt: new Date('2030-03-01T00:00:00.000Z'),
      paidAt: null,
    });
    await repository.saveFine(original);

    // when the same fine is saved again with paidAt now set (simulating payFine)
    const paid = { ...original, paidAt: new Date('2030-03-05T10:00:00.000Z') };
    await repository.saveFine(paid);

    // then the row was updated, not duplicated
    const found = await repository.findFineById(fineId);
    expect(found?.paidAt?.getTime()).toBe(paid.paidAt!.getTime());

    const allForMember = await repository.listFinesForMember(memberId);
    expect(allForMember).toHaveLength(1);
  });

  it('looks up a fine by its originating loanId via findFineByLoanId', async () => {
    // given one fine attached to loan L1 and another to loan L2
    const loanIdA = 'dddddddd-dddd-dddd-dddd-dddddddddddd';
    const loanIdB = 'eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee';
    const fineA = sampleFine({
      fineId: '10000000-0000-0000-0000-000000000001',
      memberId: '20000000-0000-0000-0000-000000000001',
      loanId: loanIdA,
      amountCents: 25,
    });
    const fineB = sampleFine({
      fineId: '10000000-0000-0000-0000-000000000002',
      memberId: '20000000-0000-0000-0000-000000000002',
      loanId: loanIdB,
      amountCents: 75,
    });
    await repository.saveFine(fineA);
    await repository.saveFine(fineB);

    // when looking up by loanIdA
    const foundA = await repository.findFineByLoanId(loanIdA);

    // then the fine attached to that loan is returned, not the other one
    expect(foundA?.fineId).toBe(fineA.fineId);
    expect(foundA?.amountCents).toBe(25);
  });

  it('returns undefined from findFineByLoanId when no fine exists for that loan', async () => {
    // given no fine has been saved for this loan

    // when findFineByLoanId is called
    const found = await repository.findFineByLoanId('ffffffff-ffff-ffff-ffff-ffffffffffff');

    // then the repository reports miss as undefined (used by the facade's idempotency check)
    expect(found).toBeUndefined();
  });

  it('lists every fine for a given member and only that member', async () => {
    // given two fines for member M1 and one fine for a different member
    const memberId = '30000000-0000-0000-0000-000000000001';
    const otherMemberId = '30000000-0000-0000-0000-000000000002';
    await repository.saveFine(
      sampleFine({
        fineId: '40000000-0000-0000-0000-000000000001',
        memberId,
        loanId: '50000000-0000-0000-0000-000000000001',
        amountCents: 50,
      }),
    );
    await repository.saveFine(
      sampleFine({
        fineId: '40000000-0000-0000-0000-000000000002',
        memberId,
        loanId: '50000000-0000-0000-0000-000000000002',
        amountCents: 125,
      }),
    );
    await repository.saveFine(
      sampleFine({
        fineId: '40000000-0000-0000-0000-000000000003',
        memberId: otherMemberId,
        loanId: '50000000-0000-0000-0000-000000000003',
        amountCents: 999,
      }),
    );

    // when listing fines for M1
    const mineSorted = (await repository.listFinesForMember(memberId))
      .slice()
      .sort((a, b) => a.fineId.localeCompare(b.fineId));

    // then exactly the two M1 fines come back, and the other member's fine is excluded
    expect(mineSorted).toHaveLength(2);
    expect(mineSorted.map((f) => f.amountCents)).toEqual([50, 125]);
  });

  it('returns an empty array from listFinesForMember for a member with no fines', async () => {
    // given no fines saved for this member

    // when listFinesForMember is called
    const fines = await repository.listFinesForMember('60000000-0000-0000-0000-000000000000');

    // then an empty array comes back (not undefined, not null)
    expect(fines).toEqual([]);
  });
});
