import type { INestApplication } from '@nestjs/common';
import { Redis } from 'ioredis';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import type { BookDto } from '../src/catalog/catalog.types.js';
import { sampleNewBook, sampleUpdateBook } from '../src/catalog/sample-catalog-data.js';
import { createTestApp } from './support/app-factory.js';
import {
  deleteBook,
  getBook,
  patchBook,
  postNewBook,
} from './support/interactions/catalog-interactions.js';
import { DOCKER_UNAVAILABLE_MESSAGE, dockerIsAvailable } from './support/require-docker.js';
import { startRedis, type RedisFixture } from './support/testcontainers-redis.js';
import { startPostgres, type PostgresFixture } from './support/testcontainers.js';

const suite = dockerIsAvailable() ? describe : describe.skip;
if (!dockerIsAvailable()) {
  // eslint-disable-next-line no-console
  console.warn(`[integration] ${DOCKER_UNAVAILABLE_MESSAGE}`);
}

function cacheKey(isbn: string): string {
  return `catalog:book:isbn:${isbn}`;
}

suite('Catalog book cache crucial path (HTTP + Postgres + Redis)', () => {
  let pgFixture: PostgresFixture;
  let redisFixture: RedisFixture;
  let app: INestApplication;
  let peeker: Redis;

  beforeAll(async () => {
    pgFixture = await startPostgres();
    redisFixture = await startRedis();
    process.env.REDIS_URL = redisFixture.url;
    app = await createTestApp({ databaseUrl: pgFixture.connectionUrl });
    peeker = new Redis(redisFixture.url);
  }, 180_000);

  afterAll(async () => {
    if (peeker) {
      await peeker.quit();
    }
    if (app) {
      await app.close();
    }
    if (redisFixture) {
      await redisFixture.stop();
    }
    if (pgFixture) {
      await pgFixture.stop();
    }
    delete process.env.REDIS_URL;
  });

  it('connects to Redis and Postgres', async () => {
    // given the suite has booted both fixtures
    // when the harness pings Redis directly
    const pong = await peeker.ping();

    // then Redis is reachable and the Nest app exists with Redis wired in
    expect(pong).toBe('PONG');
    expect(app).toBeDefined();
    expect(process.env.REDIS_URL).toBe(redisFixture.url);
  });

  it('populates Redis on cache miss and serves the second GET from cache', async () => {
    // given a fresh book is added through the API
    const isbn = '978-1111111111';
    const newBook = sampleNewBook({ isbn, title: 'Cache Miss Then Hit' });
    const addResponse = await postNewBook(app, newBook);
    expect(addResponse.status).toBe(201);

    // when the book is fetched for the first time (cache miss → repo → populate)
    const firstGet = await getBook(app, isbn);

    // then the response carries the persisted book
    expect(firstGet.status).toBe(200);
    expect(firstGet.body.isbn).toBe(isbn);
    expect(firstGet.body.title).toBe(newBook.title);

    // and Redis now holds the JSON-serialized BookDto under the prefixed key
    const cached = await peeker.get(cacheKey(isbn));
    expect(cached).not.toBeNull();
    const parsed = JSON.parse(cached as string) as BookDto;
    expect(parsed).toEqual(firstGet.body);

    // when the book is fetched a second time (cache HIT)
    const secondGet = await getBook(app, isbn);

    // then the same payload comes back (served from Redis)
    expect(secondGet.status).toBe(200);
    expect(secondGet.body).toEqual(firstGet.body);
  });

  it('writes through to Redis on PATCH so subsequent GET returns the new title', async () => {
    // given a book is added and (optionally) cached by a prior GET
    const isbn = '978-2222222222';
    const newBook = sampleNewBook({ isbn, title: 'Original Title' });
    const addResponse = await postNewBook(app, newBook);
    expect(addResponse.status).toBe(201);
    const bookId = addResponse.body.bookId as string;

    // when the title is updated via PATCH
    const patchResponse = await patchBook(
      app,
      bookId,
      sampleUpdateBook({ title: 'New Title', authors: addResponse.body.authors }),
    );

    // then PATCH returns the updated DTO
    expect(patchResponse.status).toBe(200);
    expect(patchResponse.body.title).toBe('New Title');

    // and a subsequent GET returns the new title (write-through verified end-to-end)
    const getResponse = await getBook(app, isbn);
    expect(getResponse.status).toBe(200);
    expect(getResponse.body.title).toBe('New Title');

    // and Redis directly reflects the new title (write-through populated the cache)
    const cached = await peeker.get(cacheKey(isbn));
    expect(cached).not.toBeNull();
    const parsed = JSON.parse(cached as string) as BookDto;
    expect(parsed.title).toBe('New Title');
    expect(parsed.bookId).toBe(bookId);
  });

  it('evicts the Redis entry on DELETE so subsequent GET returns 404', async () => {
    // given a book is added and a GET populates the cache
    const isbn = '978-3333333333';
    const newBook = sampleNewBook({ isbn, title: 'Doomed Book' });
    const addResponse = await postNewBook(app, newBook);
    const bookId = addResponse.body.bookId as string;
    const populateGet = await getBook(app, isbn);
    expect(populateGet.status).toBe(200);
    expect(await peeker.get(cacheKey(isbn))).not.toBeNull();

    // when the book is deleted via DELETE
    const deleteResponse = await deleteBook(app, bookId);

    // then the response is 204 No Content
    expect(deleteResponse.status).toBe(204);

    // and a subsequent GET returns 404
    const getResponse = await getBook(app, isbn);
    expect(getResponse.status).toBe(404);

    // and Redis no longer holds the key
    const cached = await peeker.get(cacheKey(isbn));
    expect(cached).toBeNull();
  });

  it('returns 404 for an unknown ISBN and does not negative-cache in Redis', async () => {
    // given an ISBN that was never added
    const unknownIsbn = '978-9999999999';

    // when GET is called for that ISBN
    const getResponse = await getBook(app, unknownIsbn);

    // then the response is 404
    expect(getResponse.status).toBe(404);

    // and Redis has no entry for that ISBN (no negative caching)
    const cached = await peeker.get(cacheKey(unknownIsbn));
    expect(cached).toBeNull();
  });
});
