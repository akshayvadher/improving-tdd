# Spec: Catalog Book Cache (Redis + in-memory gateway)

## Overview

Introduce `BookCacheGateway` — an outbound port that `CatalogFacade.findBook(isbn)` consults before hitting the repository. The gateway lives in `src/shared/book-cache-gateway/`, ships with a `Map`-backed in-memory default for unit tests, and gets a real Redis adapter for production. The same slice adds `updateBook(bookId, dto)` and `deleteBook(bookId)` to the facade so cache invalidation has a real surface to hook into — write-through on update, evict on delete. `addBook` does not touch the cache (the key did not exist yet, so there is nothing to invalidate).

**Primary teaching point.** Same point as `isbn-gateway-spec.md` Slice 3, restated for read-side caching: the "in-memory implementation, not mocks" rule (Principle 5) applies to outbound caches just as it applies to outbound HTTP gateways. A spec-local `ThrowingOnceBookCacheGateway` (mirroring `ThrowingOnceIsbnLookupGateway` at `catalog.facade.spec.ts:551-573`) proves that a cache failure leaves no partial state behind, without `vi.mock`, without Redis stubs.

**Secondary teaching point.** The test pyramid gets a worked example. Most of the cache contract is pinned by unit tests at the facade level in milliseconds (Principles 1, 4, 5). Exactly one `*.integration.spec.ts` boots a real Redis testcontainer and proves the production adapter satisfies the same contract end-to-end (Principle 2).

## Teaching anchor

**Slice 5 is the canonical teaching moment of this feature** — fault injection on a cache port that has just become a real production seam. Slices 1–4 are the in-memory scaffolding that makes Slice 5 readable; Slice 6 is the one crucial-path integration that proves the production adapter satisfies the same contract. A reader who only reads Slice 5 should walk away understanding why we did not reach for `vi.mock` even though Redis is now in the loop.

## Test pyramid (called out explicitly)

| Layer | Where | When it runs | Slices that contribute |
|---|---|---|---|
| Co-located gateway unit | `src/shared/book-cache-gateway/in-memory-book-cache-gateway.spec.ts` | `pnpm test:unit` (ms) | 1 |
| Facade unit | `src/catalog/catalog.facade.spec.ts` | `pnpm test:unit` (ms) | 2, 3, 4, 5 |
| Crucial-path integration | `apps/library/test/catalog-book-cache.crucial-path.integration.spec.ts` | `pnpm test:integration` (testcontainer; ~seconds) | 6 |

Every AC below is tagged `[unit]`, `[unit/facade]`, or `[integration]` so the TDD planner knows which test type satisfies it.

## Out of scope

Explicitly NOT part of this feature:

- TTL / cache expiry. Write-through + evict-on-delete is the chosen invalidation strategy; entries live until they are updated or evicted.
- Distributed cache invalidation across multiple Nest instances. Single-process for now; Redis pub/sub or similar is a future story.
- Cache stampede protection (single-flight). Concurrent misses may both hit the repo; whichever lands last wins. Acceptable for this slice.
- Cache metrics, hit/miss counters, structured logging beyond what already exists. Could be a follow-up.
- Caching `listBooks`, `getBooks`, `findCopy`, or any path other than `findBook(isbn)`.
- Negative caching. `BookNotFoundError` is NOT cached. A cache miss followed by a repo miss throws on every call.
- Caching across `addBook` (the key did not exist, so there is nothing to invalidate; AC-3 in slice 2 pins this behaviour).
- Re-validating cache content against the repo on read (no read-then-validate). The cache is the source of truth on a hit until invalidated.
- New CLI surface; this is backend + HTTP only.
- UI surface.

## Module surface

### Port

```ts
// apps/library/src/shared/book-cache-gateway/book-cache-gateway.ts
import type { BookDto, Isbn } from '../../catalog/catalog.types.js';

export interface BookCacheGateway {
  get(isbn: Isbn): Promise<BookDto | null>;
  set(isbn: Isbn, book: BookDto): Promise<void>;
  evict(isbn: Isbn): Promise<void>;
}
```

> **Open question (developer to confirm):** verbs are `get / set / evict`. Alternatives are `get / put / delete`. If no preference, the architecture advisor may finalize. Spec uses `get / set / evict` everywhere below.

### In-memory default

```ts
// apps/library/src/shared/book-cache-gateway/in-memory-book-cache-gateway.ts
export class InMemoryBookCacheGateway implements BookCacheGateway {
  private readonly entries = new Map<Isbn, BookDto>();
  async get(isbn: Isbn): Promise<BookDto | null> { /* ... */ }
  async set(isbn: Isbn, book: BookDto): Promise<void> { /* ... */ }
  async evict(isbn: Isbn): Promise<void> { /* ... */ }
}
```

No `seed` helper is required — the public `set` already covers test seeding (a cache that cannot be seeded by its public API would be the wrong shape).

### Catalog integration

```ts
// catalog.configuration.ts
export interface CatalogOverrides {
  repository?: CatalogRepository;
  newId?: () => string;
  isbnLookupGateway?: IsbnLookupGateway;
  bookCacheGateway?: BookCacheGateway; // new
}
```

`CatalogFacade.findBook(isbn)` becomes:

1. `const cached = await cache.get(isbn)` — return `cached` if present (HIT).
2. `const book = await repository.findBookByIsbn(isbn)`.
3. If `book == null` → throw `BookNotFoundError(isbn)`. **Do not call `cache.set`** — no negative caching.
4. `await cache.set(isbn, book)` — populate on miss-then-found.
5. return `book`.

`CatalogFacade.updateBook(bookId, dto)`:

1. `parseUpdateBook(dto)` — zod-validate the patch (title and authors only — ISBN is immutable post-create).
2. `const existing = await repository.findBookById(bookId)`; throw `BookNotFoundError(bookId)` if missing.
3. `const updated: BookDto = { ...existing, title: parsed.title, authors: parsed.authors }`.
4. `await repository.saveBook(updated)` (Drizzle `onConflictDoUpdate` already upserts).
5. `await cache.set(existing.isbn, updated)` — write-through on the same key (ISBN is immutable, so no key migration).
6. return `updated`.

`CatalogFacade.deleteBook(bookId)`:

1. `const existing = await repository.findBookById(bookId)`; throw `BookNotFoundError(bookId)` if missing.
2. `await repository.deleteBook(bookId)`.
3. `await cache.evict(existing.isbn)`.
4. return `void`.

### HTTP routes

- `PATCH /books/:bookId` — body `{ title?, authors? }` (at least one must be present and valid). Returns the updated `BookDto`.
- `DELETE /books/:bookId` — empty body. Returns `204 No Content`.

### Nest wiring

`catalog.module.ts` adds `Symbol('BookCacheGateway')` provider. Production wiring uses the Redis adapter (slice 6); until then, `useClass: InMemoryBookCacheGateway`. `useFactory` for `CatalogFacade` adds the cache to its inject list.

### Open questions flagged in the spec

- **Cache port verbs** — `get/set/evict` is the recommended default; architecture advisor may revise. (Q3 in the brief; no developer preference captured.)
- **`updateBook` payload shape** — title + authors only. ISBN is immutable. If the developer later wants ISBN-mutable updates, that adds: re-parse the new ISBN, evict old-ISBN cache key, set new-ISBN cache key, re-check duplicate-ISBN. Not in scope here. (Q1 in the brief; recommendation accepted in this draft pending developer confirmation.)

---

## Slice 1 — `BookCacheGateway` port + `InMemoryBookCacheGateway`

Create the shared port, the in-memory default, and the co-located unit spec. No Catalog wiring yet — this slice ships a standalone, tested collaborator.

**New files:**
- `apps/library/src/shared/book-cache-gateway/book-cache-gateway.ts`
- `apps/library/src/shared/book-cache-gateway/in-memory-book-cache-gateway.ts`
- `apps/library/src/shared/book-cache-gateway/in-memory-book-cache-gateway.spec.ts`

**Demonstrates:** Principle 5 (in-memory implementation, not mocks), Principle 6 (I/O behind a port).

**Acceptance criteria:**

- [x] AC-1.1 `[unit]` `InMemoryBookCacheGateway.get` returns `null` for an ISBN that was never set.
- [x] AC-1.2 `[unit]` After `set(isbn, book)`, `get(isbn)` returns that exact `BookDto`.
- [x] AC-1.3 `[unit]` `set` on an existing key replaces the previous value (last write wins) — `get` returns the new value.
- [x] AC-1.4 `[unit]` `evict(isbn)` on an existing key causes the next `get(isbn)` to return `null`.
- [x] AC-1.5 `[unit]` `evict(isbn)` on an absent key resolves without throwing (idempotent).
- [x] AC-1.6 `[unit]` Two distinct ISBNs are stored independently — setting one does not affect `get` of the other; evicting one does not evict the other.
- [x] AC-1.7 `[unit]` `get`, `set`, and `evict` all return `Promise<...>` (signatures match the port).

**Teaching anchor:** A cache port is an ordinary three-method interface. The in-memory default is a `Map`. No framework, no DI ceremony — Principle 5 applied to a cache.

---

## Slice 2 — Wire cache into `findBook` (read-through)

Wire the cache into `CatalogFacade.findBook(isbn)`. Cache HIT returns from the cache without touching the repo. Cache MISS reads the repo, populates the cache on success, throws `BookNotFoundError` on miss WITHOUT caching the negative answer. Extend `createCatalogFacade` to accept a `bookCacheGateway` override.

**Touched files:**
- `apps/library/src/catalog/catalog.configuration.ts` — add `bookCacheGateway?` to `CatalogOverrides`; default to `new InMemoryBookCacheGateway()`.
- `apps/library/src/catalog/catalog.facade.ts` — accept gateway in constructor; consult cache in `findBook`.
- `apps/library/src/catalog/catalog.facade.spec.ts` — new `describe('findBook — cache read-through', ...)` block.

**Existing tests MUST still pass unchanged.** `buildFacade()` continues to use the in-memory default — the cache starts empty, so the first `findBook` for any ISBN is a miss and behaviour matches today's contract.

**Demonstrates:** Principle 5 (in-memory cache as a real collaborator), Principle 6 (factory grows by one override slot), Principle 8 (only the differing ISBN appears in each test; everything else defaults).

**Acceptance criteria:**

- [x] AC-2.1 `[unit/facade]` Cache HIT — when the cache has an entry for the requested ISBN, `findBook(isbn)` returns the cached `BookDto` without calling `repository.findBookByIsbn`. (Verified by seeding the cache directly via `cache.set` and asserting the returned DTO matches the seeded value, even when the repo is empty.)
- [x] AC-2.2 `[unit/facade]` Cache MISS, repo HIT — when the cache has no entry but the repo does, `findBook(isbn)` returns the repo's `BookDto` AND the cache subsequently has that entry (a follow-up `cache.get(isbn)` returns it).
- [x] AC-2.3 `[unit/facade]` Cache MISS, repo MISS — `findBook(isbn)` throws `BookNotFoundError`. The cache still returns `null` for that ISBN afterwards (negative answer NOT cached).
- [x] AC-2.4 `[unit/facade]` After a successful `addBook`, the cache has NO entry for the new ISBN. (`addBook` does not populate the cache; the first `findBook` afterwards reads from the repo and populates the cache then.)
- [x] AC-2.5 `[unit/facade]` Two consecutive `findBook(isbn)` calls after a fresh add result in: first call repo-then-cache-populate, second call cache HIT. Verifiable via the cache state at each step.
- [x] AC-2.6 `[unit/facade]` `createCatalogFacade({ bookCacheGateway })` uses the supplied override; omitting it falls back to a fresh `InMemoryBookCacheGateway`.
- [x] AC-2.7 `[unit/facade]` `BookNotFoundError` thrown by `findBook` is the same error class as today (no behavioural change for callers when the book is absent).
- [x] AC-2.8 `[unit/facade]` Existing Catalog facade tests pass unchanged (no mutations to current describe blocks beyond imports).

**Teaching anchor:** A read-through cache is just an early return on the happy path. The miss path is the original `findBook` plus one `cache.set` after the repo result. Domain logic stays in the facade; the cache has no opinion about what is or is not cacheable.

---

## Slice 3 — `updateBook(bookId, dto)` + write-through cache

Add `updateBook` to facade, repository (no new method needed — `saveBook` already upserts), schema (`UpdateBookSchema`/`parseUpdateBook`), controller (`PATCH /books/:bookId`). On success, write through to the cache so the next `findBook(isbn)` returns the new title/authors without touching the repo.

**Touched files:**
- `apps/library/src/catalog/catalog.types.ts` — `UpdateBookDto` (`{ title?: string; authors?: string[] }`).
- `apps/library/src/catalog/catalog.schema.ts` — `UpdateBookSchema` + `parseUpdateBook`. At least one of `title` / `authors` required; same trim/min-length/non-empty-array rules as `NewBookSchema`. `isbn` is rejected if present.
- `apps/library/src/catalog/catalog.facade.ts` — `updateBook(bookId, dto)`.
- `apps/library/src/catalog/catalog.facade.spec.ts` — new `describe('updateBook', ...)` block.
- `apps/library/src/catalog/catalog.controller.ts` — `@Patch('books/:bookId')` route.
- `apps/library/src/catalog/index.ts` — export `UpdateBookDto`.

**Demonstrates:** Principle 3 (domain invariants in the facade, not the controller), Principle 5 (cache write-through is just another method call on the in-memory gateway), Principle 9 (sample-data builder grows a `sampleUpdateBook` helper).

**Acceptance criteria:**

- [x] AC-3.1 `[unit/facade]` `updateBook(bookId, { title })` returns a `BookDto` with the new title and the original `authors`, `bookId`, `isbn`.
- [x] AC-3.2 `[unit/facade]` `updateBook(bookId, { authors })` returns a `BookDto` with the new authors and the original `title`, `bookId`, `isbn`.
- [x] AC-3.3 `[unit/facade]` `updateBook(bookId, { title, authors })` updates both fields atomically.
- [x] AC-3.4 `[unit/facade]` After `updateBook`, the next `findBook(isbn)` returns the new title/authors. (Cache write-through verified end-to-end at the facade level.)
- [x] AC-3.5 `[unit/facade]` After `updateBook`, the cache `get(isbn)` directly returns the updated `BookDto` (write-through populates the cache regardless of whether `findBook` was ever called for this ISBN before).
- [x] AC-3.6 `[unit/facade]` `updateBook` for an unknown `bookId` throws `BookNotFoundError(bookId)`. The cache is NOT modified.
- [x] AC-3.7 `[unit/facade]` `updateBook(bookId, {})` (no fields) throws `InvalidBookError` — at least one of `title` / `authors` must be present.
- [x] AC-3.8 `[unit/facade]` `updateBook(bookId, { title: '   ' })` throws `InvalidBookError` (trimmed-empty title rejected, matching `parseNewBook` behaviour).
- [x] AC-3.9 `[unit/facade]` `updateBook(bookId, { authors: [] })` and `{ authors: ['', '   '] }` both throw `InvalidBookError` (at least one non-empty author required).
- [x] AC-3.10 `[unit/facade]` `updateBook(bookId, { isbn: '978-...' as any })` (ISBN supplied) throws `InvalidBookError` — ISBN is immutable.

**Teaching anchor:** Write-through is a one-line addition to a normal update. The fact that the cache is in-memory in tests and Redis in production is irrelevant to this slice's tests — the contract is the same.

---

## Slice 4 — `deleteBook(bookId)` + cache evict

Add `deleteBook` to facade, repository (new port method `deleteBook`), in-memory and Drizzle implementations, controller (`DELETE /books/:bookId`). On success, evict the cache entry.

**Touched files:**
- `apps/library/src/catalog/catalog.repository.ts` — add `deleteBook(bookId: BookId): Promise<void>` to the port.
- `apps/library/src/catalog/in-memory-catalog.repository.ts` — implement.
- `apps/library/src/catalog/drizzle-catalog.repository.ts` — implement (`db.delete(books).where(eq(books.bookId, bookId))`).
- `apps/library/src/catalog/catalog.facade.ts` — `deleteBook(bookId)`.
- `apps/library/src/catalog/catalog.facade.spec.ts` — new `describe('deleteBook', ...)` block.
- `apps/library/src/catalog/catalog.controller.ts` — `@Delete('books/:bookId')` route, returns `204 No Content`.

**Demonstrates:** Principle 5 (in-memory repo gains a method; same shape on both sides), Principle 6 (I/O remains behind the facade), Principle 12 (the repo grows but the boundary is the same).

**Acceptance criteria:**

- [x] AC-4.1 `[unit/facade]` `deleteBook(bookId)` resolves without throwing for an existing book.
- [x] AC-4.2 `[unit/facade]` After `deleteBook`, `findBook(isbn)` for that book throws `BookNotFoundError`.
- [x] AC-4.3 `[unit/facade]` After `deleteBook`, the cache `get(isbn)` returns `null` (entry was evicted, or was never present and is still absent).
- [x] AC-4.4 `[unit/facade]` Cache eviction happens even when the cache held an entry for that ISBN immediately before the delete. (Seed cache, delete, assert `cache.get` returns `null`.)
- [x] AC-4.5 `[unit/facade]` `deleteBook` for an unknown `bookId` throws `BookNotFoundError(bookId)`. The cache is NOT modified.
- [x] AC-4.6 `[unit/facade]` `deleteBook` of book A does NOT evict the cache entry for book B. (Per-key eviction, not flush.)
- [x] AC-4.7 `[unit/facade]` Calling `deleteBook` twice for the same `bookId` throws `BookNotFoundError` on the second call (delete is not idempotent at the facade — the repo is empty so the existence check fails first).
- [x] AC-4.8 `[unit/facade]` `addBook` after a `deleteBook` of the same ISBN succeeds (no leftover cache entry blocks re-creation; the facade treats the ISBN as fresh).

**Teaching anchor:** Cache invalidation maps to a single `evict` call. The cache port has no opinion about what is being evicted or why — that is a facade concern.

---

## Slice 5 — `ThrowingOnceBookCacheGateway` (fault injection)

**This is the teaching moment.** Add a spec-local `ThrowingOnceBookCacheGateway` wrapper that mirrors `ThrowingOnceIsbnLookupGateway` (`catalog.facade.spec.ts:551-573`). It decorates the in-memory cache, exposes `armFailureOnNextSet(error)` and `armFailureOnNextGet(error)` (and optionally `armFailureOnNextEvict`), throws once on the next matching call, then clears its slot.

The teaching scenario: the DB write succeeds, then `cache.set` throws. The next `findBook(isbn)` should still return the correct book by reading from the repo and re-populating the cache. No corruption, no swallowed errors at the wrong layer.

**Touched files:**
- `apps/library/src/catalog/catalog.facade.spec.ts` — wrapper class at the bottom (NOT exported). New `describe('cache gateway failures', ...)` block.

**Wrapper shape (illustrative — keep aligned with `ThrowingOnceIsbnLookupGateway`):**

```ts
class ThrowingOnceBookCacheGateway implements BookCacheGateway {
  private armedSetError: Error | null = null;
  private armedGetError: Error | null = null;
  private armedEvictError: Error | null = null;
  constructor(private readonly delegate: BookCacheGateway) {}

  armFailureOnNextSet(error: Error): void { this.armedSetError = error; }
  armFailureOnNextGet(error: Error): void { this.armedGetError = error; }
  armFailureOnNextEvict(error: Error): void { this.armedEvictError = error; }

  async get(isbn: Isbn) { if (this.armedGetError) { const e = this.armedGetError; this.armedGetError = null; throw e; } return this.delegate.get(isbn); }
  async set(isbn: Isbn, book: BookDto) { if (this.armedSetError) { const e = this.armedSetError; this.armedSetError = null; throw e; } return this.delegate.set(isbn, book); }
  async evict(isbn: Isbn) { if (this.armedEvictError) { const e = this.armedEvictError; this.armedEvictError = null; throw e; } return this.delegate.evict(isbn); }
}
```

**Demonstrates:** Principle 7 (fault-injection wrapper, not a mocking library), Principle 5 (the wrapper `implements BookCacheGateway` — the compiler breaks if the port drifts).

**Acceptance criteria:**

> Question for the developer (flagged in the spec): the brief proposes one canonical scenario — "if `cache.set` throws after the DB write succeeds, the read still returns the right book." That is AC-5.1 below. AC-5.2 through AC-5.5 add small companion scenarios for the other two methods. If the developer wants only the single scenario, drop AC-5.2 to AC-5.5.

- [x] AC-5.1 `[unit/facade]` Given `addBook` succeeded earlier, when `cache.set` is armed to throw on the next call AND `findBook(isbn)` is invoked (cache miss → repo hit → cache.set throws), then the error surfaces to the caller (the test asserts the exact armed error). The repo state is unchanged. Negative control: a follow-up `findBook(isbn)` succeeds and returns the book (cache.set arming is single-shot and self-clearing; the second attempt populates the cache).
- [x] AC-5.2 `[unit/facade]` `cache.get` armed to throw on the next call surfaces the error from `findBook(isbn)`. The repo is NOT consulted (we fail fast on the cache read; the caller sees the cache error). Subsequent `findBook` succeeds.
- [x] AC-5.3 `[unit/facade]` `cache.set` armed to throw during `updateBook`'s write-through surfaces the error to the caller AFTER the repo write has already committed. The cached entry is therefore stale OR absent — the test pins the observable contract: the next `findBook(isbn)` reads from the repo (cache miss) and returns the new title/authors. (Documents that we accept "best-effort write-through" — repo is the source of truth.)
- [x] AC-5.4 `[unit/facade]` `cache.evict` armed to throw during `deleteBook` surfaces the error to the caller AFTER the repo delete has committed. The next `findBook(isbn)` throws `BookNotFoundError` (repo is empty; the stale cache entry, if any, is the next concern but the contract here is that the caller sees the error so they can decide).
- [x] AC-5.5 `[unit/facade]` `ThrowingOnceBookCacheGateway` is declared inside `catalog.facade.spec.ts` and is NOT exported from any barrel.

**Teaching anchor:** A 25-line wrapper class gives us deterministic fault injection at exactly the moment the test cares about, exercises the real `BookCacheGateway` contract (because it `implements` it), and stays scoped to the one spec that uses it. This is why `vi.mock` is unnecessary even when the production gateway talks to Redis.

---

## Slice 6 — Production Redis adapter + crucial-path integration test

Wire a real Redis-backed `BookCacheGateway` into Nest, and pin the production contract with one `*.integration.spec.ts` that boots a Redis testcontainer alongside the existing Postgres testcontainer. This is the only place a Redis client is touched.

**New files:**
- `apps/library/src/shared/book-cache-gateway/<redis-adapter>.ts` — name and client TBD by architecture advisor (no Redis client is currently in `package.json`; see context). The adapter `implements BookCacheGateway`.
- `apps/library/test/support/testcontainers-redis.ts` — `startRedis()` returns `{ url, stop() }`. Uses `GenericContainer('redis:7-alpine')` with `Wait.forLogMessage(/Ready to accept connections/)`. No new `testcontainers` dependency (already used for Postgres).
- `apps/library/test/catalog-book-cache.crucial-path.integration.spec.ts` — boots Postgres + Redis + Nest app + real Redis adapter. Skips gracefully via `dockerIsAvailable()` like the existing integration suite.

**Touched files:**
- `apps/library/src/catalog/catalog.module.ts` — register the Redis adapter under `Symbol('BookCacheGateway')` for production. The in-memory gateway remains the default for unit tests via `createCatalogFacade`.
- `apps/library/src/app.module.ts` (or wherever `CatalogModule` is wired) — pass Redis URL config in. (Architecture advisor decides whether config goes through `@nestjs/config` or env directly.)
- `package.json` — add the chosen Redis client (architecture advisor picks `redis` or `ioredis`).

**Demonstrates:** Principle 2 (one crucial-path integration per module — fast paths stay in unit tests), Principle 5 (the in-memory gateway is the contract; Redis must satisfy the same shape), Principle 10 (HTTP interactions hidden behind helpers — extend `catalog-interactions.ts` if needed).

**Acceptance criteria:**

- [x] AC-6.1 `[integration]` The Redis testcontainer starts, the Nest app boots with the real Redis adapter wired, and `app.close()` + `container.stop()` clean up in `afterAll`. Suite skips gracefully (no failure) when Docker is unavailable, mirroring `catalog.crucial-path.integration.spec.ts:15-19`.
- [x] AC-6.2 `[integration]` `POST /books` followed by `GET /books/:isbn` returns the book — the second call is served from Redis. Verified by inspecting the Redis client directly (the integration test may peek at the adapter's underlying client, OR by an indirect probe: stop the Postgres container after the first GET and assert the second GET still succeeds — pick whichever the architecture advisor finds cleaner). Recommended: direct peek, since the harness already owns the Redis client.
- [x] AC-6.3 `[integration]` `PATCH /books/:bookId` updates title; subsequent `GET /books/:isbn` returns the new title (write-through to Redis verified end-to-end).
- [x] AC-6.4 `[integration]` `DELETE /books/:bookId` returns `204`; subsequent `GET /books/:isbn` returns `404` (BookNotFoundError → `DomainErrorFilter` → 404). The Redis key for that ISBN is absent.
- [x] AC-6.5 `[integration]` `GET /books/:isbn` for an unknown ISBN returns `404` and Redis has no entry for that ISBN afterwards (no negative caching at the Redis level).
- [x] AC-6.6 `[integration]` Existing `catalog.crucial-path.integration.spec.ts` continues to pass unchanged. The new spec is additive; the old one still proves Postgres-only happy path.
- [x] AC-6.7 `[integration]` `testcontainers-redis.ts` exposes `startRedis()` returning `{ url, stop }` with the same shape as `startPostgres()` in `testcontainers.ts`. Single startup timeout (120s); single log-based wait. (Pure infrastructure AC — verified by the spec compiling and running.)

**Teaching anchor:** The production adapter lives under exactly one integration test. Every other behaviour about `BookCacheGateway` is already pinned by the in-memory gateway's unit spec (Slice 1) and the facade's unit spec (Slices 2–5), running in milliseconds. The pyramid is real — wide unit base, narrow integration tip.

---

## Technical Context

- **Patterns to follow:** `apps/library/src/shared/isbn-gateway/` (port + in-memory default + co-located spec) for the gateway folder shape; `ThrowingOnceIsbnLookupGateway` (`catalog.facade.spec.ts:551-573`) for the fault-injection wrapper; `apps/library/test/support/testcontainers.ts` for the new `testcontainers-redis.ts` helper; `apps/library/test/catalog.crucial-path.integration.spec.ts` for the integration-test layout (Docker skip, `beforeAll` startup, `afterAll` cleanup).
- **Key dependencies:** `CatalogFacade`, `createCatalogFacade`, `CatalogModule`, `parseNewBook` (reused — `parseUpdateBook` follows the same shape), `DrizzleCatalogRepository.saveBook` (already upserts via `onConflictDoUpdate`), `DomainErrorFilter` (maps `BookNotFoundError → 404`).
- **New module-boundary considerations:** `BookCacheGateway` lives under `src/shared/`, depends on `BookDto` / `Isbn` types from `catalog.types.ts`. This is a one-way dependency from `shared/` into the type module; it does not create a cross-module JOIN risk (no DB ports, no facades). Per `MEMORY.md` cross-module-joins note: still compliant, the cache sits next to the catalog module and reads only its own port.
- **Risk level:** MODERATE. The unit-test scope is low risk (in-memory cache + facade glue). The MODERATE bump comes from: (1) introducing a new production dependency (Redis client), (2) booting a second testcontainer in CI, (3) mutating data on a path the suite has not covered before (`updateBook`/`deleteBook`).
- **Independently shippable:** Slices 1, 2 each ship alone (1 ships an unused but tested gateway; 2 ships read-through caching). Slices 3, 4 each add one mutation route plus its cache effect — independently mergeable. Slice 5 is teaching-only and can ride with any earlier slice. Slice 6 is the only slice that adds production infra; it can ship after Slices 1–4 are merged.

---

## Resolved decisions (developer-confirmed)

1. **`updateBook` payload** — title + authors only. ISBN is immutable post-create.
2. **Cache port verbs** — `get / set / evict`.
3. **Slice 5 scope** — all 5 ACs (every cache method gets a fault-injection scenario).
4. **Slice 6 hit-verification technique** (AC-6.2) — direct Redis peek; the harness owns the Redis client.

---

## Confirmation gate

- [x] Reviewed
