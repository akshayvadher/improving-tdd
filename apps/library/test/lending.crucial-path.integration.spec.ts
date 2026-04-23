import type { INestApplication } from '@nestjs/common';
import { eq, sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { sampleNewBook, sampleNewCopy } from '../src/catalog/sample-catalog-data.js';
import type { AppDatabase } from '../src/db/client.js';
import { DATABASE } from '../src/db/database.module.js';
import { books, loans } from '../src/db/schema/index.js';
import { sampleNewMember } from '../src/membership/sample-membership-data.js';
import { createTestApp } from './support/app-factory.js';
import { postNewBook, registerCopy } from './support/interactions/catalog-interactions.js';
import {
  borrowCopy,
  listActiveLoansWithQueuedReservations,
  listLoansFor,
  listOverdueLoansWithTitles,
  reserveBook,
  returnLoan,
} from './support/interactions/lending-interactions.js';
import { postNewMember } from './support/interactions/membership-interactions.js';
import { DOCKER_UNAVAILABLE_MESSAGE, dockerIsAvailable } from './support/require-docker.js';
import { startPostgres, type PostgresFixture } from './support/testcontainers.js';

const suite = dockerIsAvailable() ? describe : describe.skip;
if (!dockerIsAvailable()) {
  // eslint-disable-next-line no-console
  console.warn(`[integration] ${DOCKER_UNAVAILABLE_MESSAGE}`);
}

const MS_PER_DAY = 24 * 60 * 60 * 1000;

async function forceLoanOverdue(
  db: AppDatabase,
  loanId: string,
  daysOverdue: number,
): Promise<void> {
  const now = Date.now();
  const borrowedAt = new Date(now - (daysOverdue + 14) * MS_PER_DAY);
  const dueDate = new Date(now - daysOverdue * MS_PER_DAY);
  await db.update(loans).set({ borrowedAt, dueDate }).where(eq(loans.loanId, loanId));
}

suite('Lending crucial path (HTTP + Postgres)', () => {
  let fixture: PostgresFixture;
  let app: INestApplication;
  let db: AppDatabase;

  beforeAll(async () => {
    fixture = await startPostgres();
    app = await createTestApp({ databaseUrl: fixture.connectionUrl });
    db = app.get<AppDatabase>(DATABASE);
  }, 120_000);

  afterAll(async () => {
    if (app) {
      await app.close();
    }
    if (fixture) {
      await fixture.stop();
    }
  });

  it('completes a full borrow then return cycle across all three modules', async () => {
    // given a book, a copy of that book, and a registered member
    const bookResponse = await postNewBook(app, sampleNewBook({ isbn: '978-0201633610' }));
    const book = bookResponse.body;

    const copyResponse = await registerCopy(
      app,
      book.bookId,
      sampleNewCopy({ bookId: book.bookId }),
    );
    const copy = copyResponse.body;

    const memberResponse = await postNewMember(
      app,
      sampleNewMember({ email: 'edgar.dijkstra@example.com' }),
    );
    const member = memberResponse.body;

    // when the member borrows the copy
    const borrowResponse = await borrowCopy(app, member.memberId, copy.copyId);

    // then a loan is opened with the right owner and copy
    expect(borrowResponse.status).toBe(201);
    const loan = borrowResponse.body;
    expect(loan.memberId).toBe(member.memberId);
    expect(loan.copyId).toBe(copy.copyId);
    expect(loan.bookId).toBe(book.bookId);
    expect(loan.returnedAt).toBeFalsy();

    // and the member's loan listing reflects the open loan
    const openList = await listLoansFor(app, member.memberId);
    expect(openList.status).toBe(200);
    expect(openList.body).toHaveLength(1);
    expect(openList.body[0].loanId).toBe(loan.loanId);

    // when the loan is returned
    const returnResponse = await returnLoan(app, loan.loanId);

    // then the loan is closed and the returnedAt timestamp is recorded
    expect(returnResponse.status).toBe(200);
    expect(returnResponse.body.loanId).toBe(loan.loanId);
    expect(returnResponse.body.returnedAt).toBeTruthy();

    // and the listing now reports the loan as returned
    const closedList = await listLoansFor(app, member.memberId);
    expect(closedList.body[0].returnedAt).toBeTruthy();
  });

  it('serves /loans/active-with-reservation-counts with the LEFT JOIN + GROUP BY shape (AC-1.10, AC-1.11)', async () => {
    // given two books, each with one copy, and two members
    const bookOneResponse = await postNewBook(app, sampleNewBook({ isbn: '978-0132350884' }));
    const bookOne = bookOneResponse.body;
    const copyOneResponse = await registerCopy(
      app,
      bookOne.bookId,
      sampleNewCopy({ bookId: bookOne.bookId }),
    );
    const copyOne = copyOneResponse.body;

    const bookTwoResponse = await postNewBook(app, sampleNewBook({ isbn: '978-0134685991' }));
    const bookTwo = bookTwoResponse.body;
    const copyTwoResponse = await registerCopy(
      app,
      bookTwo.bookId,
      sampleNewCopy({ bookId: bookTwo.bookId }),
    );
    const copyTwo = copyTwoResponse.body;

    const borrowerResponse = await postNewMember(
      app,
      sampleNewMember({ email: 'alan.kay@example.com' }),
    );
    const borrower = borrowerResponse.body;
    const reserverResponse = await postNewMember(
      app,
      sampleNewMember({ email: 'grace.hopper@example.com' }),
    );
    const reserver = reserverResponse.body;

    // and the borrower has an active loan on each book
    const loanOneResponse = await borrowCopy(app, borrower.memberId, copyOne.copyId);
    const loanOne = loanOneResponse.body;
    const loanTwoResponse = await borrowCopy(app, borrower.memberId, copyTwo.copyId);
    const loanTwo = loanTwoResponse.body;

    // and one pending reservation on book one (none on book two)
    await reserveBook(app, reserver.memberId, bookOne.bookId);

    // when the endpoint is called
    const response = await listActiveLoansWithQueuedReservations(app);

    // then 200 + the shape matches ActiveLoanWithQueuedCount[] with per-book counts
    expect(response.status).toBe(200);
    expect(Array.isArray(response.body)).toBe(true);
    expect(response.body).toHaveLength(2);

    const byLoanId = new Map<string, { loan: { loanId: string }; queuedCount: number }>(
      response.body.map((row: { loan: { loanId: string }; queuedCount: number }) => [
        row.loan.loanId,
        row,
      ]),
    );

    expect(byLoanId.get(loanOne.loanId)).toEqual(
      expect.objectContaining({
        loan: expect.objectContaining({
          loanId: loanOne.loanId,
          memberId: borrower.memberId,
          copyId: copyOne.copyId,
          bookId: bookOne.bookId,
        }),
        queuedCount: 1,
      }),
    );

    expect(byLoanId.get(loanTwo.loanId)).toEqual(
      expect.objectContaining({
        loan: expect.objectContaining({
          loanId: loanTwo.loanId,
          memberId: borrower.memberId,
          copyId: copyTwo.copyId,
          bookId: bookTwo.bookId,
        }),
        queuedCount: 0,
      }),
    );
  });

  it('serves /loans/overdue/with-titles 200 with enriched reports and 404 on catalog drift (AC-2.10, AC-2.12)', async () => {
    // given a book with known title + authors and a member with an overdue loan
    const bookPayload = sampleNewBook({
      title: 'Domain-Driven Design',
      authors: ['Eric Evans'],
      isbn: '978-0321125217',
    });
    const book = (await postNewBook(app, bookPayload)).body;
    const copy = (await registerCopy(app, book.bookId, sampleNewCopy({ bookId: book.bookId })))
      .body;
    const member = (await postNewMember(app, sampleNewMember({ email: 'ken.iverson@example.com' })))
      .body;
    const loan = (await borrowCopy(app, member.memberId, copy.copyId)).body;
    await forceLoanOverdue(db, loan.loanId, 5);

    // when the endpoint is queried with a `now` well past the due date
    const happyResponse = await listOverdueLoansWithTitles(app, new Date());

    // then 200 + the single enriched report reflects the catalog metadata
    expect(happyResponse.status).toBe(200);
    expect(Array.isArray(happyResponse.body)).toBe(true);
    expect(happyResponse.body).toHaveLength(1);
    const report = happyResponse.body[0];
    expect(report.loan.loanId).toBe(loan.loanId);
    expect(report.loan.memberId).toBe(member.memberId);
    expect(report.loan.bookId).toBe(book.bookId);
    expect(report.title).toBe('Domain-Driven Design');
    expect(report.authors).toEqual(['Eric Evans']);

    // --- drift half (AC-2.10 404 path) ---------------------------------
    // The loans.book_id / copies.book_id foreign keys prevent a straight
    // `DELETE FROM books WHERE ...`. To simulate catalog drift we disable
    // replication triggers on THIS connection (Postgres runs FK checks as
    // triggers), delete the book, then restore the flag. The SET is
    // session-scoped, so we run it inside a single `db.transaction` block
    // which pins all statements to the same connection in the postgres-js
    // pool. The testcontainer's owner role (`library`) has the rights
    // required for `session_replication_role`.
    await db.transaction(async (tx) => {
      await tx.execute(sql`SET LOCAL session_replication_role = replica`);
      await tx.delete(books).where(eq(books.bookId, book.bookId));
    });

    // and the endpoint is queried again — now the overdue loan points at a
    // bookId that no longer exists in the catalog
    const driftResponse = await listOverdueLoansWithTitles(app, new Date());

    // then the DomainErrorFilter maps BookNotFoundError → 404, and the body
    // carries the offending bookId for debuggability
    expect(driftResponse.status).toBe(404);
    expect(driftResponse.body.error).toBe('BookNotFoundError');
    expect(driftResponse.body.message).toContain(book.bookId);
  });
});
