import type { INestApplication } from '@nestjs/common';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { sampleNewBook, sampleNewCopy } from '../src/catalog/sample-catalog-data.js';
import { sampleNewMember } from '../src/membership/sample-membership-data.js';
import { createTestApp } from './support/app-factory.js';
import { postNewBook, registerCopy } from './support/interactions/catalog-interactions.js';
import {
  borrowCopy,
  listLoansFor,
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

suite('Lending crucial path (HTTP + Postgres)', () => {
  let fixture: PostgresFixture;
  let app: INestApplication;

  beforeAll(async () => {
    fixture = await startPostgres();
    app = await createTestApp({ databaseUrl: fixture.connectionUrl });
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
});
