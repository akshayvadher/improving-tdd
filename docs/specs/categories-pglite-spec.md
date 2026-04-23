# Spec: Categories Module (PGlite substrate)

A standalone Categories module whose repository tests run on PGlite, showing an alternative testing substrate (no Docker) for Nabrdalik's Principle 5.

## Overview

Categories is a purely didactic module. Its reason for existing is not to deliver a Library-domain capability but to demonstrate a **third testing substrate** on top of the same repository contract the rest of the codebase already honors: the in-memory repo used in unit specs (first contract check), the Drizzle-over-Postgres repo exercised in `*.integration.spec.ts` under testcontainers (second contract check), and now a Drizzle-over-PGlite repo exercised in a new `pglite` Vitest project (third contract check, Docker-free).

**Why standalone?** Categories is deliberately isolated — no foreign keys, no facade-to-facade dependencies, no event-bus wiring, no cross-module reads. The module is a tight demo of the substrate; nothing else. Giving it even one cross-module collaborator would muddy the teaching point, because the reader would spend attention on coordination mechanics instead of on "same contract, new substrate."

**What "alternative substrate" means.** The repository port `CategoryRepository` is a single interface with two implementations: `InMemoryCategoryRepository` (used by facade unit spec) and `DrizzleCategoryRepository` (used by both production wiring and the PGlite spec). The PGlite spec runs the real Drizzle repo against a real Postgres query engine — the only thing that changes relative to a testcontainers spec is how the Postgres engine is instantiated: `new PGlite()` in-process via WASM instead of a `postgres:16-alpine` container. This is the whole point: "same repository, same SQL, different substrate — no Docker."

**Explicit non-goals.**
- No testcontainers integration test for this module. The Drizzle repo is exercised only via PGlite. This is a deliberate departure from the Fines / Catalog / Membership convention.
- No HTTP-through-Postgres crucial-path test. The HTTP surface is proven by facade-level + controller-level unit tests against the in-memory repo; the PGlite spec hits the Drizzle repo directly (bypassing Nest).
- No change to how any other module tests itself. Catalog, Membership, Lending, Fines, and Chat keep their in-memory + one-testcontainers-crucial-path pattern untouched.
- No event-bus wiring, no facade-to-facade collaborators, no hierarchy/nesting, no pagination cursor, no front-end.

## Principles honored

- **Principle 3 — one facade per module.** `CategoriesFacade` is the only public surface; `index.ts` re-exports `CategoriesFacade`, `CategoriesModule`, `Category`, and the typed errors. The repository port, implementations, schema, and sample builder are module-private.
- **Principle 5 — in-memory double + same contract.** Categories honors this with a twist: the same `CategoryRepository` contract is proven against **two** substrates in automated tests — in-memory in the facade unit spec, PGlite-backed Drizzle in the new `pglite` spec. Slice 3 adds a teaching note under Principle 5 framing PGlite as a third contract check, not a replacement for the in-memory double.
- **Principle 6 — facade factory in `<mod>.configuration.ts`.** `categories.configuration.ts` exposes `createCategoriesFacade({ repository = new InMemoryCategoryRepository() } = {})` for zero-I/O test wiring.
- **Principles 8 & 9 — sample-data builders.** `sample-categories-data.ts` exports `sampleCategory(overrides?)` with every field defaulted and `overrides` last.
- **Principle 12 — no cross-module JOINs.** Trivially honored: Categories has no foreign keys to any other module and makes no cross-module reads. Reinforces the auto-memory rule.
- **Note:** `GUIDE.md` is silent on PGlite today. Slice 3 adds a short "Substrate alternative: PGlite" subsection under Principle 5 — framed as a *third* contract check, not as a rewrite of the existing in-memory teaching.

## HTTP surface

| Method | Path                             | Success                                      | Failure                                                                 |
| ------ | -------------------------------- | -------------------------------------------- | ----------------------------------------------------------------------- |
| POST   | `/categories`                    | `201` + `{ id, name, createdAt }`            | `400 InvalidCategoryError` (zod-mapped), `409 DuplicateCategoryError`   |
| GET    | `/categories/:id`                | `200` + `{ id, name, createdAt }`            | `404 CategoryNotFoundError`                                             |
| GET    | `/categories?startsWith=<prefix>`| `200` + `Category[]` (bare array, matches membership/fines listing style) | `400 InvalidCategoriesQueryError` |

### Request / response shapes

```ts
// POST /categories
// Request body (zod-validated via categories.schema.ts)
{ name: string } // non-empty, trimmed

// Response (201)
{ id: string; name: string; createdAt: string /* ISO */ }

// GET /categories/:id
// Response (200)
{ id: string; name: string; createdAt: string /* ISO */ }

// GET /categories?startsWith=<prefix>
// Response (200) — bare array, same style as GET /members and GET /fines listing
[{ id, name, createdAt }, ...]  // sorted ASC by name, max 100 entries
```

### Query contract for `GET /categories?startsWith=<prefix>`

- Case-insensitive prefix match — `ILIKE '<prefix>%'` in the Drizzle repo.
- Sorted by `name ASC`.
- Hard-capped at **100 rows** at the repository layer. No query-string `limit` or `cursor` parameters (by design, to keep the demo small).
- Missing or blank `startsWith` → `400` via typed `InvalidCategoriesQueryError`.
- Empty match set → `200` with `[]` (not `404`).

### Errors (typed, module-owned)

- `CategoryNotFoundError` → HTTP 404
- `DuplicateCategoryError` → HTTP 409 (thrown on `name` UNIQUE violation)
- `InvalidCategoryError` → HTTP 400 (zod-mapped POST body failure)
- `InvalidCategoriesQueryError` → HTTP 400 (missing/blank `startsWith`)

All four are registered in `src/shared/http/domain-error.filter.ts`.

## Data shape

### DB schema + migration

```sql
-- apps/library/src/db/migrations/0003_categories.sql
CREATE TABLE categories (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name       text NOT NULL UNIQUE,
  created_at timestamptz NOT NULL DEFAULT now()
);
```

Drizzle schema lives at `apps/library/src/db/schema/categories.ts` and is re-exported from `src/db/schema/index.ts` alongside the existing module tables.

### DTO

```ts
export type Category = {
  id: string;       // uuid
  name: string;
  createdAt: Date;
};
```

The HTTP layer serializes `createdAt` as an ISO string on the wire; the in-process DTO keeps it as a `Date`.

## Test strategy

**Two substrates exercise the same `CategoryRepository` contract.**

1. **Unit spec — `apps/library/src/categories/categories.facade.spec.ts`.**
   Uses `InMemoryCategoryRepository` via `createCategoriesFacade()`. Pure Nabrdalik style — no `vi.fn` / `vi.mock`, sample-data builder, facade entry only. Covers happy paths, error cases, and the `findByNamePrefix` contract (ASC ordering, case-insensitivity, cap-at-100, blank-prefix rejection). Runs under the existing `unit` project (`pnpm test:unit`).

2. **PGlite spec — `apps/library/test/categories.pglite.spec.ts`.**
   Lives under a **new** `pglite` Vitest workspace project (`include: ['test/**/*.pglite.spec.ts']`). Uses a small `test/support/pglite.ts` helper exposing `startPglite()` which:
   - Constructs a `new PGlite()` instance in-process.
   - Walks `apps/library/src/db/migrations/*.sql` in sorted order (`0001_initial.sql`, `0002_fines.sql`, `0003_categories.sql`) and `exec`s each under PGlite. This mirrors production — the harness does not cherry-pick migrations for the module under test.
   - Returns `{ db, close }` where `db` is a Drizzle instance built via `drizzle-orm/pglite` and `close()` terminates the PGlite instance.

   Each test hits `new DrizzleCategoryRepository(db)` **directly** — no Nest bootstrap, no HTTP round-trip, no `app-factory`. `beforeEach` truncates `categories`; `afterAll` calls `close()`. Runs under the new `pglite` project via `pnpm --filter library test:pglite` (repo-root alias: `pnpm test:pglite`).

**Explicit departures from the project's convention, called out so the reader notices the choice:**
- **No testcontainers integration test for Categories.** By design — the PGlite spec replaces it.
- **No HTTP-through-Postgres crucial-path test.** The controller / HTTP surface is covered at the facade/unit level. The Drizzle repo is covered at the PGlite level. Neither layer is combined.
- **Other modules are not touched.** This spec is additive only.

## Dependency changes

- Add `@electric-sql/pglite` as a `devDependency` on `apps/library` (`pnpm --filter library add -D @electric-sql/pglite`).
- Extend `apps/library/vitest.workspace.ts` with a **third** project:
  - name: `pglite`
  - `include: ['test/**/*.pglite.spec.ts']`
  - env: `node`
  - timeouts raised for WASM cold start: `testTimeout: 60_000`, `hookTimeout: 180_000` (mirrors the existing `integration` project)
- Add script to `apps/library/package.json`:
  - `"test:pglite": "vitest run --project pglite"`
- Add a repo-root pass-through to the root `package.json` for consistency with `test:unit` / `test:integration`:
  - `"test:pglite": "pnpm --filter library test:pglite"`

## Slices

### Slice 1 — PGlite harness + Categories scaffold + create/read [x]

**Intent:** Spin up PGlite as a test substrate and give Categories a working `POST /categories` + `GET /categories/:id` on top of it.

**Files to create:**
- `apps/library/src/categories/categories.facade.ts`
- `apps/library/src/categories/categories.module.ts`
- `apps/library/src/categories/categories.controller.ts`
- `apps/library/src/categories/categories.configuration.ts`
- `apps/library/src/categories/categories.types.ts`
- `apps/library/src/categories/categories.schema.ts`
- `apps/library/src/categories/category.repository.ts` (port)
- `apps/library/src/categories/drizzle-category.repository.ts`
- `apps/library/src/categories/in-memory-category.repository.ts`
- `apps/library/src/categories/sample-categories-data.ts`
- `apps/library/src/categories/categories.facade.spec.ts`
- `apps/library/src/categories/index.ts` (barrel)
- `apps/library/src/db/schema/categories.ts`
- `apps/library/src/db/migrations/0003_categories.sql`
- `apps/library/test/support/pglite.ts` (new — `startPglite()`)
- `apps/library/test/categories.pglite.spec.ts`

**Files to modify:**
- `apps/library/src/db/schema/index.ts` — export `categories` table
- `apps/library/src/app.module.ts` — import `CategoriesModule`
- `apps/library/src/shared/http/domain-error.filter.ts` — register `CategoryNotFoundError`, `DuplicateCategoryError`, `InvalidCategoryError`
- `apps/library/vitest.workspace.ts` — add the `pglite` project
- `apps/library/package.json` — add `@electric-sql/pglite` devDep and `test:pglite` script
- root `package.json` — add `test:pglite` pass-through script

**Acceptance criteria:**
- [x] `@electric-sql/pglite` is in `apps/library/package.json` devDependencies and `pnpm install` succeeds from the repo root
- [x] `apps/library/src/db/schema/categories.ts` declares the `categories` Drizzle table matching the data shape (`id uuid PK`, `name text NOT NULL UNIQUE`, `created_at timestamptz NOT NULL DEFAULT now()`)
- [x] `apps/library/src/db/migrations/0003_categories.sql` creates the table with a UNIQUE constraint on `name` and is idempotent against an already-migrated database
- [x] `CategoriesModule` scaffold exists with every file listed above: facade, repo port, drizzle repo, in-memory repo, controller, sample-data builder, configuration, types, schema, index barrel
- [x] `index.ts` barrel re-exports only `CategoriesFacade`, `CategoriesModule`, `Category`, and the typed errors — not the repository, not the Drizzle repo, not the sample builder
- [x] `CategoriesModule` is imported by `AppModule`
- [x] `POST /categories` with `{ name: "Fiction" }` returns `201` with `{ id, name: "Fiction", createdAt }`
- [x] `GET /categories/:id` returns `200` with the created category
- [x] `GET /categories/:id` for an unknown id returns `404` via `CategoryNotFoundError`
- [x] `POST /categories` with `{ name: "Fiction" }` twice returns `409` via `DuplicateCategoryError` on the second call
- [x] `POST /categories` with `{}` or `{ name: "" }` returns `400` via `InvalidCategoryError`
- [x] `categories.facade.spec.ts` passes against `InMemoryCategoryRepository` in Nabrdalik style — facade entry only, no `vi.fn`/`vi.mock`, sample-data builder used
- [x] A new `pglite` Vitest workspace project is declared in `apps/library/vitest.workspace.ts` with `include: ['test/**/*.pglite.spec.ts']`, node env, `testTimeout: 60_000`, `hookTimeout: 180_000`
- [x] `pnpm --filter library test:pglite` (and the repo-root `pnpm test:pglite` alias) runs without Docker and passes
- [x] `test/support/pglite.ts` exposes `startPglite()` that applies all migrations in `src/db/migrations/*.sql` in sorted order and yields `{ db, close }`
- [x] `test/categories.pglite.spec.ts` round-trips `create → findById` against the real Drizzle/PGlite repo (not through Nest)
- [x] Full suite passes: `pnpm test:unit`, `pnpm test:pglite`, and `pnpm test:integration` (the last one only when Docker is available; otherwise it skips gracefully per the existing `require-docker` convention)

**Out of scope for this slice:**
- The `startsWith` query endpoint and its contract.
- Any `GUIDE.md` update.

---

### Slice 2 — Complex query: list by prefix (`ILIKE`, ASC, cap 100, 400 on blank) [x]

**Intent:** Add `GET /categories?startsWith=<prefix>` and exercise the PGlite substrate with a real Postgres `ILIKE` query, reinforcing the "same contract, two substrates" teaching point.

**Files to modify:**
- `apps/library/src/categories/category.repository.ts` — extend port with `findByNamePrefix(prefix: string): Promise<Category[]>`
- `apps/library/src/categories/in-memory-category.repository.ts` — implement the new contract
- `apps/library/src/categories/drizzle-category.repository.ts` — implement using `ILIKE` + `ORDER BY name ASC` + `LIMIT 100`
- `apps/library/src/categories/categories.facade.ts` — add `listByPrefix` method wrapping the repo
- `apps/library/src/categories/categories.controller.ts` — add the query handler, reject missing/blank `startsWith` with `InvalidCategoriesQueryError`
- `apps/library/src/shared/http/domain-error.filter.ts` — register `InvalidCategoriesQueryError` (HTTP 400)
- `apps/library/src/categories/categories.facade.spec.ts` — add coverage for the new behavior
- `apps/library/test/categories.pglite.spec.ts` — add the PGlite contract check

**Acceptance criteria:**
- [x] Repository port declares `findByNamePrefix(prefix: string): Promise<Category[]>` with an explicit documented contract: case-insensitive, sorted `name ASC`, cap 100
- [x] `InMemoryCategoryRepository` honors the contract — case-insensitive match, ASC sort, cap-at-100
- [x] `DrizzleCategoryRepository` uses `ILIKE '<prefix>%'` + `ORDER BY name ASC` + `LIMIT 100`
- [x] `GET /categories?startsWith=A` returns all categories whose names start with `A` or `a`, sorted ascending, up to 100 results
- [x] `GET /categories?startsWith=zzz` (no matches) returns `200` with `[]` — not `404`
- [x] `GET /categories` (missing `startsWith`) returns `400` via `InvalidCategoriesQueryError`
- [x] `GET /categories?startsWith=` (blank `startsWith`) returns `400` via `InvalidCategoriesQueryError`
- [x] `categories.facade.spec.ts` covers: empty-result case, cap-at-100 (seed 101 rows, assert length === 100), case-insensitivity (`startsWith: 'a'` matches `Apple` and `art`), blank-prefix rejection
- [x] `categories.pglite.spec.ts` covers: insert `'Apple'`, `'art'`, `'Banana'`; `startsWith: 'a'` returns both `Apple` and `art` in alphabetical order; `startsWith: 'b'` returns `Banana`; `startsWith: 'c'` returns `[]`
- [x] The same assertions pass against the in-memory repo (unit spec) and the Drizzle/PGlite repo (pglite spec) — reinforces the "same contract, two substrates" teaching point and makes the equivalence observable to a reader

**Out of scope for this slice:**
- Pagination params (`limit`, `cursor`).
- Any `GUIDE.md` update.

---

### Slice 3 — `GUIDE.md` teaching note [x]

**Intent:** Document the PGlite substrate as an alternative to testcontainers under Principle 5 so a reader of the guide discovers the teaching moment this module was built for.

**Files to modify:**
- `GUIDE.md`
- `README.md` (root)

**Acceptance criteria:**
- [x] A new subsection titled "Substrate alternative: PGlite" (or closely equivalent) is added under or adjacent to Principle 5 in `GUIDE.md`
- [x] The subsection explains: (a) what PGlite is (WASM Postgres in-process), (b) why it matters for testing speed and Docker-freeness, (c) where to find the example (`apps/library/test/categories.pglite.spec.ts`), (d) when to prefer PGlite vs. testcontainers
- [x] The subsection includes a one-line pointer to `pnpm test:pglite`
- [x] The existing Principle 5 content (in-memory doubles) is NOT rewritten — PGlite is framed as a **third** contract check alongside the in-memory double and the testcontainers-backed Drizzle repo, not as a replacement for either
- [x] Root `README.md` "Run" / "How to run this" section mentions `pnpm test:pglite` alongside `pnpm test:unit` and `pnpm test:integration` as a one-line mention (no long explainer — the detail lives in `GUIDE.md`)

**Out of scope for this slice:**
- Any rework of Principles 1–4 or 6–13.

## Open questions / explicit non-goals

- **No HTTP-through-Postgres crucial-path test for Categories.** Deliberate: the HTTP surface is covered by controller-level unit tests against the in-memory repo; the Drizzle repo is covered by the PGlite spec; the two layers are not combined. Called out here so a future reviewer does not read the absence as an oversight.
- **No pagination cursor / `limit` / `offset` query params.** The hard cap of 100 rows is a fixed repository-layer constant. Adding pagination would expand the teaching surface without adding substrate-level teaching value.
- **No category hierarchy / nesting / parent-child relations.** Flat shape only.
- **No event-bus integration.** Categories emits no events.
- **No facade-to-facade collaborators.** Categories imports nothing from Catalog, Lending, Membership, Fines, or Chat and is imported by none of them.
- **No front-end.** The HTTP surface is the only surface.
- **No testcontainers integration test for Categories.** Intentional absence — see Test Strategy.

## Technical Context

- **Patterns to follow:** Fines and Membership module layout — facade factory in `<mod>.configuration.ts`, in-memory repo in unit tests, Drizzle repo in prod, zod schema per module, typed domain errors mapped by `DomainErrorFilter`, sample-data builder with `overrides` last, `index.ts` barrel exporting only the facade + module + DTOs + errors. Closest structural sibling is Fines (simple, single-domain, clean facade); closest behavioral analogue for the standalone-module shape is Membership (no cross-module deps).
- **Key dependencies:** `@electric-sql/pglite` (new, devDep on `apps/library`); `drizzle-orm/pglite` (already shipped with Drizzle); existing `drizzle-orm`, `zod`, `@nestjs/common`.
- **Existing code this integrates with:** `DomainErrorFilter` (register 4 new typed errors); `AppModule` (import `CategoriesModule`); `src/db/schema/index.ts` (export new table); `src/db/migrations/` (new `0003_categories.sql`); `vitest.workspace.ts` (new `pglite` project); `apps/library/package.json` + root `package.json` (new `test:pglite` scripts).
- **Risk level:** MODERATE. The domain is trivially simple (three endpoints, one table, no cross-module coordination). The risk is concentrated in substrate mechanics: (a) PGlite migration-application (does `pglite.exec()` accept multi-statement migrations as written? — verify early in Slice 1), (b) WASM cold-start timing under Vitest (hence the raised `testTimeout`/`hookTimeout`), (c) the new `pglite` workspace project integrating cleanly with the existing `unit` and `integration` projects. The teaching-anchor role makes the Slice 2 "same assertions, both substrates" requirement load-bearing — if the unit and PGlite specs don't observably share the same contract, the module fails its purpose.

[x] Reviewed
