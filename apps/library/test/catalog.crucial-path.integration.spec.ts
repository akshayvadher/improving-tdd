import type { INestApplication } from '@nestjs/common';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { sampleNewBook, sampleNewCopy } from '../src/catalog/sample-catalog-data.js';
import { CopyStatus } from '../src/catalog/catalog.types.js';
import { createTestApp } from './support/app-factory.js';
import {
  listBooks,
  postNewBook,
  registerCopy,
} from './support/interactions/catalog-interactions.js';
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

suite('Catalog crucial path (HTTP + Postgres)', () => {
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

  it('adds a book, registers two copies, and lists both via HTTP', async () => {
    // given a new book arrives at the library
    const bookDto = sampleNewBook({ isbn: '978-0321125217' });

    // when the book is added through the API
    const addResponse = await postNewBook(app, bookDto);

    // then the book is persisted and carries a generated id
    expect(addResponse.status).toBe(201);
    const book = addResponse.body;
    expect(book.isbn).toBe(bookDto.isbn);
    expect(book.title).toBe(bookDto.title);
    expect(book.authors).toEqual(bookDto.authors);
    expect(book.bookId).toBeTruthy();

    // when two copies are registered for the book
    const firstCopyResponse = await registerCopy(
      app,
      book.bookId,
      sampleNewCopy({ bookId: book.bookId, condition: 'GOOD' }),
    );
    const secondCopyResponse = await registerCopy(
      app,
      book.bookId,
      sampleNewCopy({ bookId: book.bookId, condition: 'NEW' }),
    );

    // then both copies are available and belong to that book
    expect(firstCopyResponse.status).toBe(201);
    expect(secondCopyResponse.status).toBe(201);
    expect(firstCopyResponse.body.status).toBe(CopyStatus.AVAILABLE);
    expect(secondCopyResponse.body.status).toBe(CopyStatus.AVAILABLE);
    expect(firstCopyResponse.body.bookId).toBe(book.bookId);
    expect(secondCopyResponse.body.bookId).toBe(book.bookId);

    // and the listing endpoint returns every book added
    const listResponse = await listBooks(app);
    expect(listResponse.status).toBe(200);
    const isbns = (listResponse.body as Array<{ isbn: string }>).map((b) => b.isbn);
    expect(isbns).toContain(bookDto.isbn);
  });
});
