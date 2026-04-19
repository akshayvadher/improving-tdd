import type { INestApplication } from '@nestjs/common';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { sampleNewBook, sampleNewCopy } from '../src/catalog/sample-catalog-data.js';
import type { AppDatabase } from '../src/db/client.js';
import { DATABASE } from '../src/db/database.module.js';
import { fines, loans, members } from '../src/db/schema/index.js';
import { FinesFacade } from '../src/fines/fines.facade.js';
import type {
  FineAssessed,
  MemberAutoSuspended,
} from '../src/fines/fines.types.js';
import { MembershipStatus } from '../src/membership/index.js';
import { sampleNewMember } from '../src/membership/sample-membership-data.js';
import type { DomainEvent } from '../src/shared/events/event-bus.js';
import { InMemoryEventBus } from '../src/shared/events/in-memory-event-bus.js';
import { createTestApp } from './support/app-factory.js';
import { postNewBook, registerCopy } from './support/interactions/catalog-interactions.js';
import { borrowCopy } from './support/interactions/lending-interactions.js';
import { processOverdueLoans } from './support/interactions/fines-interactions.js';
import { postNewMember } from './support/interactions/membership-interactions.js';
import {
  DOCKER_UNAVAILABLE_MESSAGE,
  dockerIsAvailable,
} from './support/require-docker.js';
import { startPostgres, type PostgresFixture } from './support/testcontainers.js';

const suite = dockerIsAvailable() ? describe : describe.skip;
if (!dockerIsAvailable()) {
  // eslint-disable-next-line no-console
  console.warn(`[integration] ${DOCKER_UNAVAILABLE_MESSAGE}`);
}

const DAYS_OVERDUE = 10;
const MS_PER_DAY = 24 * 60 * 60 * 1000;
const MS_PER_HOUR = 60 * 60 * 1000;
// The facade's daysBetween uses Math.ceil on (now - dueDate). The controller
// reads `new Date()` some milliseconds after the test seeds dueDate, so a
// dueDate set exactly at `now - N*day` ends up as N+epsilon days ago and
// ceils up to N+1. A one-hour cushion keeps the ceil stable at exactly N.
const CEIL_CUSHION_MS = MS_PER_HOUR;
const DEFAULT_DAILY_RATE_CENTS = 25;
const DEFAULT_SUSPENSION_THRESHOLD_CENTS = 500;

// AC-8.5 event capture.
// The Fines facade owns a private InMemoryEventBus injected by FinesModule;
// the bus token (`FINES_EVENT_BUS`) is module-local by design (barrel
// discipline — only FinesFacade / FinesModule / types are public). Reaching
// the same bus instance via the facade's private field is the least invasive
// way to prove AC-8.5 without breaking the module boundary: the facade stays
// the only public surface, and we read events through the bus's own public
// `collected()` API rather than inspecting repository state.
interface FinesFacadeInternals {
  bus: InMemoryEventBus;
}

function capturedEvents(facade: FinesFacade): readonly DomainEvent[] {
  const internals = facade as unknown as FinesFacadeInternals;
  return internals.bus.collected();
}

async function forceLoanOverdue(
  db: AppDatabase,
  loanId: string,
  daysOverdue: number,
): Promise<void> {
  const now = Date.now();
  const borrowedAt = new Date(now - (daysOverdue + 14) * MS_PER_DAY);
  const dueDate = new Date(now - daysOverdue * MS_PER_DAY + CEIL_CUSHION_MS);
  await db
    .update(loans)
    .set({ borrowedAt, dueDate })
    .where(eq(loans.loanId, loanId));
}

suite('Fines crucial path (HTTP + Postgres)', () => {
  let fixture: PostgresFixture;
  let app: INestApplication;
  let db: AppDatabase;
  let finesFacade: FinesFacade;

  beforeAll(async () => {
    fixture = await startPostgres();
    app = await createTestApp({ databaseUrl: fixture.connectionUrl });
    db = app.get<AppDatabase>(DATABASE);
    finesFacade = app.get(FinesFacade);
  }, 120_000);

  afterAll(async () => {
    if (app) {
      await app.close();
    }
    if (fixture) {
      await fixture.stop();
    }
  });

  it('assesses fines for every overdue loan and auto-suspends the member once the threshold is crossed', async () => {
    // given a member with two overdue loans whose combined fines will hit the suspension threshold
    const member = (
      await postNewMember(app, sampleNewMember({ email: 'grace.hopper@example.com' }))
    ).body;

    const firstBook = (
      await postNewBook(app, sampleNewBook({ isbn: '978-0131103627' }))
    ).body;
    const firstCopy = (
      await registerCopy(app, firstBook.bookId, sampleNewCopy({ bookId: firstBook.bookId }))
    ).body;
    const firstLoan = (await borrowCopy(app, member.memberId, firstCopy.copyId)).body;

    const secondBook = (
      await postNewBook(app, sampleNewBook({ isbn: '978-0132350884' }))
    ).body;
    const secondCopy = (
      await registerCopy(app, secondBook.bookId, sampleNewCopy({ bookId: secondBook.bookId }))
    ).body;
    const secondLoan = (await borrowCopy(app, member.memberId, secondCopy.copyId)).body;

    await forceLoanOverdue(db, firstLoan.loanId, DAYS_OVERDUE);
    await forceLoanOverdue(db, secondLoan.loanId, DAYS_OVERDUE);

    // when the batch endpoint runs
    const response = await processOverdueLoans(app);

    // then the request succeeds with no body
    expect(response.status).toBe(204);

    // and the fines table carries exactly two unpaid rows with the expected amount
    const fineRows = await db
      .select()
      .from(fines)
      .where(eq(fines.memberId, member.memberId));
    expect(fineRows).toHaveLength(2);
    const expectedAmountCents = DAYS_OVERDUE * DEFAULT_DAILY_RATE_CENTS;
    for (const row of fineRows) {
      expect(row.amountCents).toBe(expectedAmountCents);
      expect(row.paidAt).toBeNull();
    }
    const finedLoanIds = fineRows.map((row) => row.loanId).sort();
    expect(finedLoanIds).toEqual([firstLoan.loanId, secondLoan.loanId].sort());

    // and the member is now suspended in the membership table
    const [memberRow] = await db
      .select()
      .from(members)
      .where(eq(members.memberId, member.memberId));
    expect(memberRow?.status).toBe(MembershipStatus.SUSPENDED);

    // and one FineAssessed event was captured per fine plus one MemberAutoSuspended event
    const events = capturedEvents(finesFacade);
    const fineAssessedEvents = events.filter(
      (event): event is FineAssessed => event.type === 'FineAssessed',
    );
    const memberAutoSuspendedEvents = events.filter(
      (event): event is MemberAutoSuspended => event.type === 'MemberAutoSuspended',
    );
    expect(fineAssessedEvents).toHaveLength(2);
    expect(memberAutoSuspendedEvents).toHaveLength(1);
    const suspendEvent = memberAutoSuspendedEvents[0];
    if (!suspendEvent) {
      throw new Error('expected one MemberAutoSuspended event');
    }
    expect(suspendEvent.memberId).toBe(member.memberId);
    expect(suspendEvent.totalUnpaidCents).toBe(expectedAmountCents * 2);
    expect(suspendEvent.thresholdCents).toBe(DEFAULT_SUSPENSION_THRESHOLD_CENTS);
  });
});
