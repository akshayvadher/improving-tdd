import type { INestApplication } from '@nestjs/common';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { sampleNewBook, sampleNewCopy } from '../src/catalog/sample-catalog-data.js';
import type { AppDatabase } from '../src/db/client.js';
import { DATABASE } from '../src/db/database.module.js';
import { loans, reservations } from '../src/db/schema/index.js';
import { LendingFacade } from '../src/lending/lending.facade.js';
import { sampleNewMember } from '../src/membership/sample-membership-data.js';
import { createTestApp } from './support/app-factory.js';
import {
  FailingOnceReservationRepository,
  installFailingReservationRepo,
} from './support/failing-reservation-repository.js';
import { postNewBook, registerCopy } from './support/interactions/catalog-interactions.js';
import {
  borrowCopy,
  reserveBook,
  returnLoan,
} from './support/interactions/lending-interactions.js';
import { postNewMember } from './support/interactions/membership-interactions.js';
import { DOCKER_UNAVAILABLE_MESSAGE, dockerIsAvailable } from './support/require-docker.js';
import { startPostgres, type PostgresFixture } from './support/testcontainers.js';

// Teaching moment: this is the integration counterpart to the in-memory atomicity
// unit test in `lending.facade.spec.ts`. The contract is identical — "if step b
// fails, steps a and c must not persist" — only the substrate changes from an
// in-memory `Map` to a real Postgres container. Same test intent, swapped
// implementation. That symmetry is principle 5 in action.

const suite = dockerIsAvailable() ? describe : describe.skip;
if (!dockerIsAvailable()) {
  // eslint-disable-next-line no-console
  console.warn(`[integration] ${DOCKER_UNAVAILABLE_MESSAGE}`);
}

suite('Lending returnLoan atomicity (real Postgres)', () => {
  let fixture: PostgresFixture;
  let app: INestApplication;
  let failingRepo: FailingOnceReservationRepository;
  let db: AppDatabase;

  beforeAll(async () => {
    fixture = await startPostgres();
    app = await createTestApp({ databaseUrl: fixture.connectionUrl });
    db = app.get<AppDatabase>(DATABASE);
    failingRepo = installFailingReservationRepo(app.get(LendingFacade));
  }, 120_000);

  afterAll(async () => {
    if (app) {
      await app.close();
    }
    if (fixture) {
      await fixture.stop();
    }
  });

  it('rolls back the loan update when the fulfillment write fails inside the tx', async () => {
    // given alice borrowed a book and bob has a pending reservation for it
    const book = (await postNewBook(app, sampleNewBook({ isbn: '978-0201485677' }))).body;
    const copy = (await registerCopy(app, book.bookId, sampleNewCopy({ bookId: book.bookId })))
      .body;
    const alice = (await postNewMember(app, sampleNewMember({ email: 'alice@atomic.test' }))).body;
    const bob = (await postNewMember(app, sampleNewMember({ email: 'bob@atomic.test' }))).body;

    const loan = (await borrowCopy(app, alice.memberId, copy.copyId)).body;
    await reserveBook(app, bob.memberId, book.bookId);

    // and the next fulfillment save is armed to throw inside the tx
    failingRepo.armFailure();

    // when alice tries to return the book
    const response = await returnLoan(app, loan.loanId);

    // then the HTTP call reports an error
    expect(response.status).toBeGreaterThanOrEqual(500);

    // and the loan row in Postgres is still open — the tx rolled back
    const [loanRow] = await db.select().from(loans).where(eq(loans.loanId, loan.loanId));
    expect(loanRow?.returnedAt).toBeNull();

    // and bob's reservation is still pending (no fulfillment row was committed)
    const bobsReservations = await db
      .select()
      .from(reservations)
      .where(eq(reservations.memberId, bob.memberId));
    expect(bobsReservations.every((r) => r.fulfilledAt === null)).toBe(true);
  });
});
