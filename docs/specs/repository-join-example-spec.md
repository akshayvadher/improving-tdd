# Spec: Repository JOIN example — within-module and cross-module

## Overview

Two contrasted teaching examples that answer the question **"how do we test a repository JOIN in memory?"** and establish the **banned-pattern rule against cross-module DB JOINs**. Slice 1 adds a within-module JOIN inside Lending (`LoanRepository.listActiveLoansWithQueuedReservations`) with a LEFT JOIN + GROUP BY in Drizzle and a collaborating in-memory implementation. Slice 2 shows the opposite shape — cross-module reads go through a batch facade call plus a local merge (`CatalogFacade.getBooks` + `LendingFacade.listOverdueLoansWithTitles`), with **no** cross-module SQL JOIN. Slice 3 documents both patterns in GUIDE.md as a new Principle 12.

## Teaching anchor

This feature exists to pin down two complementary rules. First: **a repository JOIN is testable in-memory** — the in-memory implementation makes the same collaboration that SQL does, just through a narrow in-process read view, and the contract is verified by running the same acceptance tests against both backends. Second: **JOINs stop at the module boundary** — Catalog owns books, Lending owns loans, and any query spanning both must compose through the other module's facade (with a batch method when N+1 bites), never through a SQL JOIN across module-owned tables. Slice 1 teaches the first rule by demonstrating it. Slice 2 teaches the second rule by demonstrating its shape. Slice 3 writes both rules down.

## Out of scope

Explicitly NOT part of this feature:

- Caching of reservation counts or book-metadata lookups
- Pagination of either result set
- Batching-size caps on `CatalogFacade.getBooks` (no N-at-a-time chunking)
- Auth, rate limiting, or quota on the new HTTP endpoints
- Any UI / frontend surface
- Any change to the existing `LendingFacade.listOverdueLoans` — Fines depends on it; this spec is additive only
- A real (non-in-memory) replacement for either repo — the Drizzle and in-memory pair both exist and both must pass the same contract
- Observability, metrics, logging beyond what already exists
- A shared `LendingMemoryStore` refactor (the architecture advisor may choose a narrow read-only view instead; this spec does not force the mechanism)

## Module surface

### New public types

```ts
// lending.types.ts — re-exported from lending/index.ts
export type ActiveLoanWithQueuedCount = {
  loan: LoanDto;
  queuedCount: number;
};

export type OverdueLoanReport = {
  loan: LoanDto;
  title: string;
  authors: string[];
};
```

### New facade methods

```ts
// CatalogFacade
getBooks(bookIds: BookId[]): Promise<BookDto[]>;

// LendingFacade
listActiveLoansWithQueuedReservations(): Promise<ActiveLoanWithQueuedCount[]>;
listOverdueLoansWithTitles(now: Date): Promise<OverdueLoanReport[]>;
```

### New repo methods (module-private; not exported from barrels)

```ts
// LoanRepository
listActiveLoansWithQueuedReservations(): Promise<ActiveLoanWithQueuedCount[]>;

// CatalogRepository
listBooksByIds(bookIds: BookId[]): Promise<BookDto[]>;
```

### New HTTP endpoints

| Method | Path | Facade call | Notes |
| ------ | ---- | ----------- | ----- |
| GET | `/loans/active-with-reservation-counts` | `listActiveLoansWithQueuedReservations` | Returns `ActiveLoanWithQueuedCount[]` |
| GET | `/loans/overdue/with-titles?now=<ISO8601>` | `listOverdueLoansWithTitles(now)` | Returns `OverdueLoanReport[]`. `now` query param parsed to Date; missing/invalid → 400 via existing filter pattern |

### Preserved

`LendingFacade.listOverdueLoans` keeps its current signature and behavior — Fines (`fines.facade.ts:56`) continues to call it.

---

## Slices

### Slice 1 — Within-module JOIN in Lending

Add `LoanRepository.listActiveLoansWithQueuedReservations` in both backends and expose it from `LendingFacade`. Drizzle uses a LEFT JOIN + GROUP BY; the in-memory implementation computes the same result through a narrow read-only collaboration with the reservation store (architecture advisor picks the exact mechanism). Both implementations must satisfy the same acceptance tests.

**Touched files (indicative):**
- `apps/library/src/lending/lending.types.ts` — add `ActiveLoanWithQueuedCount`
- `apps/library/src/lending/index.ts` — export the new type
- `apps/library/src/lending/loan.repository.ts` — add method to the interface
- `apps/library/src/lending/drizzle-loan.repository.ts` — LEFT JOIN + GROUP BY impl
- `apps/library/src/lending/in-memory-loan.repository.ts` — collaborative impl (mechanism TBD by architecture advisor)
- `apps/library/src/lending/lending.configuration.ts` — thread the collaboration wire
- `apps/library/src/lending/lending.facade.ts` — new facade method (one-liner delegation)
- `apps/library/src/lending/lending.controller.ts` — new `GET /loans/active-with-reservation-counts` endpoint
- `apps/library/src/lending/lending.facade.spec.ts` — new `describe` block using `buildScene()`
- `apps/library/test/support/interactions/lending-interactions.ts` — helper for the new endpoint
- `apps/library/test/lending.crucial-path.integration.spec.ts` — add a case exercising the Drizzle path

**Acceptance criteria:**

- [x] AC-1.1: When there are no loans, `listActiveLoansWithQueuedReservations()` returns `[]` against both in-memory and Drizzle backends.
- [x] AC-1.2: When one active loan exists for a book with zero pending reservations, the result contains a single `ActiveLoanWithQueuedCount` whose `loan` equals that loan's `LoanDto` and whose `queuedCount` is `0`.
- [x] AC-1.3: When one active loan exists for a book with exactly one pending reservation (`fulfilledAt == null`), the single result row has `queuedCount === 1`.
- [x] AC-1.4: When one active loan exists for a book with three pending reservations (all unfulfilled), the single result row has `queuedCount === 3`.
- [x] AC-1.5: Fulfilled reservations (those with a non-null `fulfilledAt`) do NOT contribute to `queuedCount` — a book with two fulfilled and one pending reservation reports `queuedCount === 1`.
- [x] AC-1.6: A loan that has been returned (non-null `returnedAt`) is excluded from the result entirely, even if its book has pending reservations.
- [x] AC-1.7: When multiple active loans exist across different books, each loan appears exactly once in the result with the `queuedCount` for its own `bookId`, independent of other books' reservations.
- [x] AC-1.8: Two active loans on the same `bookId` both appear in the result, and each row reports the same `queuedCount` for that book (the count is per-book, not per-loan).
- [x] AC-1.9: The unit spec for this slice lives in `lending.facade.spec.ts`, uses the existing `buildScene()` helper, exercises the facade method (not the repo in isolation), and does not introduce any new fakes or mocks.
- [x] AC-1.10: An integration test against Postgres (testcontainers, in `lending.crucial-path.integration.spec.ts` or a sibling spec) seeds loans + reservations via the real repos, calls the facade, and asserts the same shape and counts that the in-memory unit tests assert — proving both implementations honour the same contract on identical data.
- [x] AC-1.11: `GET /loans/active-with-reservation-counts` returns `200` with the `ActiveLoanWithQueuedCount[]` JSON body and is exercised by a `lending-interactions.ts` helper used in at least one integration test case.
- [x] AC-1.12: The new type `ActiveLoanWithQueuedCount` is exported from `lending/index.ts`; the repository method remains module-private (not exported from any barrel).

**Teaching anchor:** A JOIN is just data collaboration. SQL expresses it with `LEFT JOIN … GROUP BY`; the in-memory implementation expresses the same collaboration through a narrow read view, and a single contract test proves they agree.

---

### Slice 2 — Cross-module composition (no JOIN)

Add `CatalogFacade.getBooks(bookIds)` as a batch read, and `LendingFacade.listOverdueLoansWithTitles(now)` which composes `listOverdueLoans` with `catalog.getBooks` and merges locally. Catalog's table and Lending's table are **never** joined in SQL. The existing `listOverdueLoans` stays untouched.

**Touched files (indicative):**
- `apps/library/src/lending/lending.types.ts` — add `OverdueLoanReport`
- `apps/library/src/lending/index.ts` — export the new type
- `apps/library/src/catalog/catalog.repository.ts` — add `listBooksByIds`
- `apps/library/src/catalog/drizzle-catalog.repository.ts` — `inArray` impl with empty-array guard
- `apps/library/src/catalog/in-memory-catalog.repository.ts` — filter impl, missing ids silently dropped
- `apps/library/src/catalog/catalog.facade.ts` — new `getBooks` one-liner with empty-array guard
- `apps/library/src/catalog/catalog.facade.spec.ts` — new `describe('getBooks', …)` block
- `apps/library/src/lending/lending.facade.ts` — new `listOverdueLoansWithTitles` method; composes `listOverdueLoans` + `catalog.getBooks`
- `apps/library/src/lending/lending.controller.ts` — new `GET /loans/overdue/with-titles?now=...` endpoint
- `apps/library/src/lending/lending.facade.spec.ts` — new `describe` block using `buildScene()` with real `CatalogFacade`
- `apps/library/test/support/interactions/lending-interactions.ts` — `listOverdueLoansWithTitles(app, now?)` helper
- `apps/library/test/lending.crucial-path.integration.spec.ts` — end-to-end case through HTTP with seeded books + loans

**Acceptance criteria:**

- [x] AC-2.1: When no loans are overdue at `now`, `listOverdueLoansWithTitles(now)` returns `[]` and makes NO call into `CatalogFacade.getBooks` (observable via: the catalog repo is never queried; verified by asserting the empty-result shape and the short-circuit behaviour in a test that pre-seeds catalog state and checks it is untouched).
- [x] AC-2.2: When exactly one loan is overdue and its `bookId` resolves to a catalog book, the single returned `OverdueLoanReport` has `loan` equal to the overdue `LoanDto`, `title` equal to that book's title, and `authors` equal to that book's authors array (same array contents, new array acceptable).
- [x] AC-2.3: When three loans are overdue across three distinct books, the result has three entries, each with its own book's `title` and `authors`, in the same order as `listOverdueLoans` returns them.
- [x] AC-2.4: When three loans are overdue but they reference only two distinct books (two loans share a `bookId`), both overdue loans appear in the result with their shared book's `title`/`authors`, and the underlying `CatalogFacade.getBooks` is called with a de-duplicated `bookIds` array (asserted via a spec-local wrapper that records the `bookIds` argument passed to `getBooks` on each call — mirrors the `ThrowingOnce…` wrapper shape used elsewhere in the codebase).
- [x] AC-2.5: When an overdue loan's `bookId` has no matching book in the catalog (catalog deleted or id drift), `listOverdueLoansWithTitles` throws `BookNotFoundError` carrying the offending `bookId`. No partial result is returned. This is the documented integrity-violation behaviour — the teaching code must not hide missing-book drift.
- [x] AC-2.6: `CatalogFacade.getBooks([])` returns `[]` without executing a SQL `IN ()` statement against Postgres (empty-array guard is required in both Drizzle and in-memory impls) — covered by a unit test in `catalog.facade.spec.ts`.
- [x] AC-2.7: `CatalogFacade.getBooks(bookIds)` returns one `BookDto` per matching id; bookIds with no matching book are silently omitted from the returned array (missing-in-catalog is surfaced as a domain error in Lending, not in Catalog's read method).
- [x] AC-2.8: Neither the Drizzle nor the in-memory implementation of any repository issues a SQL JOIN that mixes tables owned by different modules. Verified by code review against the banned-pattern rule in GUIDE.md Principle 12; no reservation/loan table is ever referenced from a catalog repo query and no books table is ever referenced from a lending repo query.
- [x] AC-2.9: `LendingFacade.listOverdueLoans(now)` still exists with its current signature `(now: Date) => Promise<LoanDto[]>` and its current behaviour; all existing Fines tests that exercise it continue to pass unchanged.
- [x] AC-2.10: `GET /loans/overdue/with-titles?now=<ISO8601>` returns `200` with `OverdueLoanReport[]` for the happy path and `404` (via the existing `DomainErrorFilter`) when a referenced book is missing from the catalog. A missing or unparseable `now` query parameter follows the same handling pattern the existing `listOverdueLoans` HTTP helper uses.
- [x] AC-2.11: The new type `OverdueLoanReport` is exported from `lending/index.ts`; `BookDto` continues to be exported from `catalog/index.ts` (already true) and `getBooks` is part of the public `CatalogFacade` surface.
- [x] AC-2.12: An integration test boots the full app against testcontainers Postgres, seeds books + overdue loans, calls `GET /loans/overdue/with-titles?now=…` via the HTTP helper, and asserts the enriched DTOs come back correctly — proving the HTTP + Drizzle + cross-module composition path end-to-end.

**Teaching anchor:** Crossing a module boundary in a read is not a JOIN — it's a call. A batch facade method plus a local merge gives the same answer without coupling the two modules' schemas, keeps the query testable with each module's own in-memory fakes, and is what the banned-pattern rule protects.

---

### Slice 3 — GUIDE.md Principle 12

Add a new principle to `GUIDE.md` titled **"Repository queries across tables — how do we test in memory?"** that names both patterns, contrasts them with code pointers into the real committed code, states the banned-pattern rule explicitly, and ends with a one-sentence summary.

**Touched files:**
- `GUIDE.md` — append new Principle 12 at the bottom of the principles list
- (optional) `docs/FEATURES.md` or the table of contents at the top of `GUIDE.md` — add a row for Principle 12 if that file/section enumerates principles

**Acceptance criteria:**

- [x] AC-3.1: `GUIDE.md` contains a section titled `## Principle 12 — Repository queries across tables — how do we test in memory?` (or the closest heading style the existing file uses), inserted after the current final principle.
- [x] AC-3.2: Principle 12 has two sub-headings or clearly labelled paragraphs: one for **"Within-module JOIN"** and one for **"Across module boundaries — no JOIN"** (wording may vary; both concepts must be named and contrasted).
- [x] AC-3.3: The within-module sub-section contains a code pointer to `apps/library/src/lending/drizzle-loan.repository.ts` naming the `listActiveLoansWithQueuedReservations` method, and a code pointer to `apps/library/src/lending/in-memory-loan.repository.ts` naming the same method — both with file paths that resolve to real lines in the committed code of Slice 1.
- [x] AC-3.4: The cross-module sub-section contains a code pointer to `apps/library/src/lending/lending.facade.ts` naming `listOverdueLoansWithTitles`, and a code pointer to `apps/library/src/catalog/catalog.facade.ts` naming `getBooks` — both with file paths that resolve to real lines in the committed code of Slice 2.
- [x] AC-3.5: Principle 12 contains an explicit inline rule, worded as "no cross-module JOINs" (or a recognizable paraphrase), stating that a repository query MUST NOT JOIN tables owned by a different module and that cross-module reads go through the other module's facade.
- [x] AC-3.6: Principle 12 ends with a one-sentence summary capturing the rule ("A JOIN is fine inside a module; across modules, compose through the facade.") or an equivalent sentence.
- [x] AC-3.7: The principle body does not introduce any new code — it only references code that already exists in the repository after Slices 1 and 2 have landed.
- [x] AC-3.8: No existing GUIDE.md principle is removed or renumbered as part of this slice; Principle 12 is additive.

**Teaching anchor:** Writing the rule down is what makes the pattern re-usable. Without GUIDE.md Principle 12, Slices 1 and 2 are two isolated features; with it, they become a reference a reader can find and cite.

---

## Technical Context

- **Patterns to follow:**
  - Repository port + Drizzle/in-memory pair mirrored by a single contract (GUIDE.md Principle 5).
  - Cross-module reads go through the other module's facade (GUIDE.md Principle 7); the new Principle 12 extends this with the JOIN-specific rule.
  - Controller + interactions helper + crucial-path integration test — mirrors the shape used by every existing module.
  - `buildScene()` in `lending.facade.spec.ts:42-83` is the reusable harness for Slice 1 and Slice 2 unit tests.
  - `distinctMemberIds` in `fines.facade.ts:159-161` is the precedent for the dedup helper in Slice 2 (inline; do not extract).
- **Key dependencies:** `LendingFacade`, `CatalogFacade`, existing `listOverdueLoans`, existing `buildScene()`. Fines depends on `listOverdueLoans` — additive only.
- **Risk level:** LOW. Teaching artifact. No production impact; no schema migrations; additive methods only; the existing `listOverdueLoans` path is preserved verbatim.
- **Independently shippable:** Slices 1, 2, 3 each pass their own tests on their own. Slice 1 ships the within-module JOIN and its endpoint. Slice 2 ships the cross-module composition and its endpoint. Slice 3 ships the written rule that ties the two together.

---

[x] Reviewed
