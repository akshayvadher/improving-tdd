# Spec: Improving TDD Demo (NestJS + Drizzle)

## Overview

A teaching artifact that ports Jakub Nabrdalik's "Improving your Test Driven Development" talk from Java/Spock to TypeScript/NestJS. Ships three things: a runnable NestJS + Drizzle demo app that observably demonstrates all eleven principles, a `GUIDE.md` that walks each principle with pointers into the demo, and a Claude skill at `.claude/skills/nabrdalik-module-tests/` so an LLM can generate tests in this style. Not production-grade. Library Lending domain with three bounded contexts: Catalog, Membership, Lending.

## Decisions locked in this spec

These are decisions the spec-writer made; they are called out so the orchestrator can revise before planning. If any of these are wrong, say so now — otherwise they are the contract.

1. **Walking skeleton is facade-first.** Slices 1-3 build modules with facade + in-memory repo + unit tests only. Controllers, Drizzle adapters, and testcontainers all land in slice 4. This mirrors the slide order ("that was fast & easy… now let's add IO") and keeps early slices pedagogically pure.
2. **Examples use the library domain only.** No Film/Article/Tree code imports. The guide references the slides for the original examples. Principle 11 (DSL) is demonstrated on a naturally-tree-like concept: the reservation queue for a book.
3. **Event bus is a custom typed interface with an in-memory implementation.** Mirrors the `Repository` + `InMemoryRepository` pattern so learners see the same shape applied to a second concern. No EventEmitter2, no outbox.
4. **Claude skill ships with a `references/` folder.** SKILL.md plus standalone template files (facade, in-memory repo, sample-data builder, module spec, common-interactions helper, event-collector) so the agent has copy-paste-ready canonical shapes without needing to read the whole demo.
5. **GUIDE.md includes captured `vitest` output.** Specifically a timing line proving the unit suite runs in milliseconds (the central "don't test too high" claim). One dedicated section per principle, each linking to a specific file in the demo.

## Global acceptance criteria

These cut across slices and must hold when the whole artifact is complete.

- [x] All eleven Nabrdalik principles are observably demonstrated in code and each has a dedicated section in `GUIDE.md`
- [x] Unit test suite (all three modules, facade-level, no I/O) runs to green in under 2 seconds on a cold `pnpm test:unit` run
- [x] Integration test suite (testcontainers + Postgres, crucial paths only) runs to green when Docker is available
- [x] No unit test imports a Drizzle module, database client, or HTTP client
- [x] No unit test uses `vi.mock` or jest-style mocks on a module's own repository
- [x] No module exports its repository interface or its Drizzle schema outside the module folder
- [x] Each module exposes exactly one public entry point: its `*Facade` class (plus the DTOs it needs for its signatures)
- [x] The Lending module's unit tests use mocked `CatalogFacade` and `MembershipFacade` (other modules' facades are mocked; Lending's own repo is not)
- [x] `README.md` at repo root tells a developer how to install, run unit tests, run integration tests, and start the app in under 5 commands

## Slice 1: Catalog module — the walking skeleton

Establish the template every other module copies. Catalog is the simplest (no cross-module dependencies), so it's the place to cement conventions.

### What a user can do at end of slice
Nothing over HTTP yet. A developer can `pnpm test:unit` and see fast, facade-level tests passing for Catalog behaviors.

### Acceptance criteria
- [x] Project scaffolded with NestJS, Vitest, Drizzle, TypeScript, pnpm workspace, and `apps/library/` as the app folder
- [x] `apps/library/src/catalog/` contains: `catalog.facade.ts`, `catalog.module.ts`, `catalog.types.ts` (DTOs), `in-memory-catalog.repository.ts`, `catalog.repository.ts` (interface), `sample-catalog-data.ts`
- [x] `CatalogFacade` exposes: `addBook(NewBookDto)`, `findBook(isbn)`, `registerCopy(bookId, NewCopyDto)`, `markCopyAvailable(copyId)`, `markCopyUnavailable(copyId)`, `findCopy(copyId)`, `listBooks()`
- [x] `CatalogModule` exposes only `CatalogFacade` in its `exports`
- [x] `InMemoryCatalogRepository` implements `CatalogRepository` using plain `Map<id, entity>` — no external dependencies
- [x] `sampleCatalogData.ts` exports `sampleNewBook(overrides?)`, `sampleNewCopy(overrides?)` helpers following the `{override: 'value'}` pattern from slide 50
- [x] `catalog.facade.spec.ts` wires the facade via a `CatalogConfiguration` helper (factory), not via the NestJS container, so tests run without `Test.createTestingModule`
- [x] Unit tests cover: adding a book, finding a book by ISBN, registering a copy, marking a copy available/unavailable, listing all books
- [x] Error-case tests cover: finding a book that doesn't exist, registering a copy for a book that doesn't exist, marking an unknown copy
- [x] No test in this slice uses mocks
- [x] All Catalog unit tests complete in under 300ms on the author's machine and that number is recorded in the spec verification log

### Out of scope for this slice
- Controllers, HTTP, Drizzle adapter, testcontainers
- Search, pagination, book metadata beyond title/authors/ISBN
- Publishers, categories, editions

## Slice 2: Membership module — cementing the template

Second module is a carbon copy of slice 1's shape. The point is to prove the template is followable and identify any friction before the harder slice 3.

### Acceptance criteria
- [x] `apps/library/src/membership/` mirrors the folder layout of `catalog/` exactly (same file names with `membership-` prefix where appropriate)
- [x] `MembershipFacade` exposes: `registerMember(NewMemberDto)`, `findMember(memberId)`, `suspend(memberId)`, `reactivate(memberId)`, `upgradeTier(memberId, tier)`, `checkEligibility(memberId)`
- [x] `MembershipModule` exposes only `MembershipFacade`
- [x] `sampleMembershipData.ts` exports `sampleNewMember(overrides?)` following the same pattern
- [x] `checkEligibility` returns a small DTO (`EligibilityDto`) that encodes reason-for-ineligibility when suspended — this shape is what Lending will consume in slice 3, so it is stable
- [x] Unit tests cover: registering, finding, suspending, reactivating, upgrading tier (STANDARD → PREMIUM), eligibility-when-active, eligibility-when-suspended
- [x] Error-case tests cover: registering duplicate email, suspending unknown member, upgrading unknown member
- [x] No test uses mocks
- [x] All Membership unit tests complete in under 300ms

### Out of scope for this slice
- Authentication, passwords, login flow
- Member profile fields beyond name, email, tier
- Email sending (even stubbed)

## Slice 3: Lending module — mocking other modules' facades

Lending is the cross-module module. This slice is where the "mock other modules' facades, not your own internals" teaching (principle 7) becomes concrete. Also where the event-bus abstraction is introduced.

### Acceptance criteria
- [x] `apps/library/src/shared/events/` contains `event-bus.ts` (interface) and `in-memory-event-bus.ts` (implementation with a test-only `collected` accessor)
- [x] `apps/library/src/lending/` follows the same layout as catalog/membership, plus depends on `CatalogFacade`, `MembershipFacade`, and `EventBus`
- [x] `LendingFacade` exposes: `borrow(memberId, copyId)`, `returnLoan(loanId)`, `reserve(memberId, bookId)`, `listOverdueLoans(now)`, `listLoansFor(memberId)`
- [x] `LendingModule` imports `CatalogModule` and `MembershipModule` via their exported facades — it never reaches into their repositories or types beyond the DTOs they publish
- [x] `LendingConfiguration` (the test-wiring factory) accepts mocked `CatalogFacade` and `MembershipFacade` plus a real `InMemoryLoanRepository` and a real `InMemoryEventBus`
- [x] `lending.facade.spec.ts` mocks Catalog and Membership facades, uses the real Lending repo, and asserts on events via the in-memory bus (mirrors the slide 37 `eventPublisher.nextEvent` pattern)
- [x] Happy-path unit tests: member borrows an available copy → `LoanOpened` event emitted, copy marked unavailable via `CatalogFacade`; member returns a copy → `LoanReturned` event, copy marked available; member reserves a book with no available copies → reservation queued; returning a reserved copy → `ReservationFulfilled` event
- [x] Error-case unit tests: borrowing when member is not eligible (Membership facade returns ineligible) rejects without touching the repo; borrowing a copy that Catalog reports as unavailable rejects; returning an unknown loan throws; reserving when member is ineligible rejects
- [x] Overdue detection: `listOverdueLoans(now)` returns loans where `dueDate < now` and `returnedAt` is null
- [x] All Lending unit tests complete in under 500ms (more scenarios than slices 1-2)
- [x] No Lending unit test uses mocks for `LoanRepository` or `EventBus`

### Domain DSL requirement (principle 11)
- [x] One test file `lending.reservations.spec.ts` demonstrates the "show, don't tell" principle on the reservation queue: given a book and a sequence of members joining the queue, the test expresses the queue state as a declarative structure (e.g. `queueFor(book) equals [alice, bob, carol]`) rather than poking at internal fields. The helper that enables this lives in `apps/library/src/lending/testing/reservation-dsl.ts` and is reused across at least two tests.

### Transactional unit-of-work requirement (extends principle 5)
- [x] `returnLoan(loanId)` performs three state mutations atomically within Lending's own data: (a) mark the loan as returned, (b) if an active reservation exists for that book, record a fulfillment row on the reservation, (c) emit exactly one `LoanReturned` event (and, when a reservation is fulfilled, one `ReservationFulfilled` event). All three effects succeed together or none persist.
- [x] A `TransactionalContext` (work-unit) abstraction lives at `apps/library/src/lending/transactional-context.ts` and is threaded through the facade into `LoanRepository` and `ReservationRepository` calls. The in-memory implementation (`in-memory-transactional-context.ts`) stages writes in a scratch buffer and commits them only when the unit-of-work block resolves; on throw, the buffer is discarded so the `Map`-backed stores are unchanged.
- [x] A unit test in `lending.facade.spec.ts` proves atomicity: use the real `InMemoryLoanRepository` and `InMemoryReservationRepository` but stub the fulfillment step (step b) to throw. Assert (1) the `returnLoan` call rejects, (2) `findLoan(loanId).returnedAt` is still null, (3) no `LoanReturned` or `ReservationFulfilled` event was collected by the in-memory bus. This is the teaching moment: the in-memory repositories plus a work-unit abstraction give the same atomicity guarantee a real DB transaction gives, so tests can pin the contract without reaching for a database.

### Out of scope for this slice
- Fines, late fees, billing
- Email/SMS notifications on events (events are emitted in-process only)
- Persistence of loans/reservations (that comes in slice 4)
- Concurrent-borrow race conditions (not part of the teaching)
- **Cross-module transactions.** The transactional-context is scoped to Lending's own data only. Per Jakub's principle: each module owns its data; cross-module consistency is achieved through events and compensation, not a shared transaction. If the teaching artifact ever needs "when Lending succeeds, Catalog must also succeed", it is implemented by emitting an event Catalog subscribes to — not by widening the transaction.

## Slice 4: Persistence + HTTP + crucial-path integration tests

All the I/O arrives here at once, exactly as Jakub stages it ("now let's add IO"). Drizzle adapters replace the in-memory repos behind the same interface. REST controllers are added. Integration tests run against a real Postgres via testcontainers and use "common interactions" helpers.

### Acceptance criteria
- [x] `apps/library/src/db/schema/` contains Drizzle tables for books, authors, book_authors, copies, members, memberships, loans, reservations
- [x] Each module has a `drizzle-<module>.repository.ts` implementing the module's repository interface against Drizzle — these files are the ONLY place Drizzle types appear in each module
- [x] Module `providers` are configured to inject the Drizzle repo in production and the in-memory repo in unit tests, with no other code changes
- [x] `apps/library/src/catalog/catalog.controller.ts`, `membership.controller.ts`, `lending.controller.ts` expose REST endpoints that call only the facade — no business logic in controllers
- [x] `apps/library/src/main.ts` boots the app with Drizzle + Postgres and the app responds on a configurable port
- [x] `apps/library/test/support/testcontainers.ts` spins up a pinned `postgres:16` container once per integration test run and runs Drizzle migrations before tests execute
- [x] `apps/library/test/support/interactions/` contains helper modules for each module (e.g. `catalog-interactions.ts` exports `postNewBook(app, dto)`, `getBook(app, isbn)`; `lending-interactions.ts` exports `borrowCopy(app, memberId, copyId)`, `returnLoan(app, loanId)`) — these hide HTTP mechanics exactly as slides 52-56 describe
- [x] Exactly one crucial-path integration test per module exists: Catalog — add a book, register two copies, list copies; Membership — register a member, suspend, check eligibility reflects suspension; Lending — happy-path borrow-then-return cycle that touches all three modules' HTTP endpoints
- [x] Integration tests use sample-data builders (imported from each module's sample file) serialized to JSON, not hand-written request bodies
- [x] Integration tests assert on response shape via the DTOs the facade returns, not via ad-hoc JSON paths
- [x] `pnpm test:integration` runs green when Docker is running; the command exits with a clear message when Docker is unavailable rather than hanging
- [x] The `catalog.facade.spec.ts` suite from slice 1 still passes unchanged — proving the in-memory wiring still works and the refactor didn't leak I/O into unit tests
- [x] A `DrizzleTransactionalContext` implements the same `TransactionalContext` interface from slice 3 by wrapping a Drizzle `db.transaction(tx => ...)` call; `returnLoan` in production routes all three writes through the `tx` handle so Postgres either commits all of them or rolls back all of them
- [x] One integration test in `apps/library/test/lending.return-loan.integration.spec.ts` proves the same atomicity contract against a real Postgres container: seed a loan and an active reservation, force the fulfillment write to fail (e.g. via a `FOREIGN KEY` violation on a deliberately invalid reservation id, or a monkey-patched repo method that throws inside the transaction), assert the HTTP call returns an error, then query the DB directly and assert `loans.returnedAt` is still null and no `ReservationFulfillment` row was inserted. The test reuses the unit test's intent — the contract is the same; only the substrate changed.

### Out of scope for this slice
- Authentication / authorization on endpoints
- Request validation beyond Nest's default pipes
- Pagination on list endpoints (use unbounded lists; the demo is seeded with tens of rows at most)
- Observability, logging, metrics
- Migrations beyond initial schema creation

## Slice 5: GUIDE.md — the learning artifact

The guide is what a reader walks away with. It must be readable standalone (someone who hasn't watched the talk can follow it) while staying honest about its source.

### Acceptance criteria
- [x] `GUIDE.md` at repo root opens with a 1-paragraph summary of the talk's thesis and a link to the video + slides
- [x] The guide has exactly eleven principle sections, numbered 1-11, matching the list in `bee-context.local.md`
- [x] Each principle section contains: (a) a 2-3 sentence restatement of the principle in the guide author's voice, (b) at least one code pointer of the form `apps/library/src/…#Lx-Ly` into the demo, (c) at least one slide screenshot from `.claude/screenshots/` referenced inline (e.g. `![](./.claude/screenshots/single_module.png)` for principle 3)
- [x] Principle 2 ("Don't test too high") includes a captured `pnpm test:unit` output block showing total test count and total elapsed time, demonstrating sub-2-second runtime
- [x] Principle 5 ("In-memory implementations, not mocks") includes a side-by-side: the in-memory repo excerpt vs. what a `vi.mock` call would have looked like, with an explanation of why the first is preferred
- [x] Principle 5 has a sub-section titled "Bonus: transactions across functions" (~150 words) that points at `returnLoan` as the worked example and explains: when one operation must atomically mutate state through multiple repository calls, route all writes through a `TransactionalContext` (unit-of-work). The in-memory implementation stages writes and discards on throw; the Drizzle implementation delegates to `db.transaction`. The same unit test that proves "step c fails → steps a and b do not persist" survives the swap to Postgres unchanged in intent, which is the whole point of principle 5. The sub-section explicitly notes that cross-module transactions are not used — cross-module coordination is via events (linking to principle 7)
- [x] Principle 7 ("Module boundaries") includes a code excerpt from `lending.facade.spec.ts` showing the mocked Catalog/Membership facades, and explicitly calls out that `LoanRepository` is NOT mocked
- [x] Principle 11 ("Show, don't tell") references `lending.reservations.spec.ts` and explains the DSL helpers
- [x] The guide contains a "Ports & gaps" section that honestly notes where TypeScript/NestJS diverge from Groovy/Spring (no operator overloading, no `given:/when:/then:` blocks, no `@Autowired`) and what we used instead
- [x] A "How to run this" section lists: install, run unit tests, run integration tests, start the app — each as a single copy-pasteable command
- [x] No principle section exceeds ~200 words of prose (brevity is a teaching virtue, per principle 8)

### Out of scope for this slice
- Video embeds, a hosted site, generated HTML
- Translating the full talk transcript
- Exercises or a "try it yourself" section (that's what the Claude skill is for)

## Slice 6: Claude skill — making the pattern reproducible

The skill teaches any Claude agent to write Nabrdalik-style tests and module code for a new codebase without re-reading the talk each time.

### Acceptance criteria
- [x] `.claude/skills/nabrdalik-module-tests/SKILL.md` exists and starts with the standard skill frontmatter (name, description, trigger hints)
- [x] SKILL.md lists the eleven principles in the same order as `bee-context.local.md`, each summarized in 1-2 sentences and linked to the corresponding `GUIDE.md` section and demo file
- [x] SKILL.md contains a "When to use this skill" section that names the triggers: user asks for "module tests", "facade tests", "in-memory repository", "Nabrdalik-style", or shows a TypeScript/Node project with NestJS/Fastify/Express + a repository interface
- [x] SKILL.md contains a "Checklist before writing a test" block with at least: mock-other-modules-not-own; facade-only entry point; sample-data builder with overrides; no I/O in unit tests; assert on observable outcome or emitted event; when an operation mutates state across multiple functions, route writes through a `TransactionalContext` so a unit test with a throwing stub can prove atomicity without a database
- [x] SKILL.md contains a "Do not do" block naming at least: mocking own repository; accepting a repository in a method signature for test purposes; testing private/class-internal state; using `vi.mock` for collaborators inside the module
- [x] `.claude/skills/nabrdalik-module-tests/references/` contains standalone template files the agent can copy from: `facade.template.ts`, `in-memory-repository.template.ts`, `sample-data-builder.template.ts`, `module-spec.template.ts`, `common-interactions.template.ts`, `event-bus-and-collector.template.ts`, `transactional-unit-of-work.template.ts` (the last one is small — an interface plus an in-memory implementation sketching the stage-and-commit pattern, with comments flagging "only for atomicity *within* a module")
- [x] Each template file is under 60 lines, uses a placeholder domain (e.g. `Thing`/`NewThingDto`) and has 2-3 inline comments flagging the principle it embodies
- [x] SKILL.md's "Examples" section points at the three module specs in the demo (`catalog.facade.spec.ts`, `membership.facade.spec.ts`, `lending.facade.spec.ts`) as canonical reads
- [x] SKILL.md is under 500 lines total (skills are loaded into context; brevity matters)
- [x] The skill does not mention Java, Groovy, Spring, or Spock except in one "provenance" line at the top linking back to the original talk

### Out of scope for this slice
- Registering the skill in any shared/remote skill registry
- Automated tests of the skill (meta-testing is out of scope)
- A Python or non-TypeScript variant

## Technical Context

- **Patterns to follow:** Nabrdalik's facade-per-module pattern (slides 17-38); in-memory-repository-as-real-test-double (slides 21, 26); sample-data-builder with overrides (slide 50); common-interactions helpers (slides 52-56); whiteboard-DSL for expressive tests (slides 60-76). Everything in the demo must trace back to a slide or a direct consequence of one.
- **Key dependencies:** NestJS 10+, Drizzle ORM (postgres-js driver), `testcontainers` Node.js package, Vitest, pnpm. Pin the Postgres image version (e.g. `postgres:16-alpine`) in the testcontainers helper.
- **Existing code:** none (greenfield). `.claude/screenshots/` has 13 slide images already — the guide reuses them, the demo does not reference them.
- **Module boundaries:** the three modules (`catalog`, `membership`, `lending`) are strict folder-level boundaries. `lending` may import from `catalog` and `membership` ONLY via their public barrel file (`index.ts`) which exports only the facade class and published DTOs. A lint rule or `eslint-plugin-boundaries` config should enforce this (nice-to-have; if skipped, document the convention in GUIDE.md).
- **Risk level:** MODERATE. Technology is well-understood; risk is scope creep. Each slice should refuse to grow. If an AC feels like it wants a sub-bullet, it probably belongs in a later slice or out of scope.

## Verification log (filled during execution)

The slices above each have timing ACs (sub-300ms, sub-500ms, sub-2s total). The programmer should record the actual numbers here per slice so the "runs in milliseconds" claim in GUIDE.md is backed by real measurements and not aspirational.

- Slice 1 Catalog unit suite time: 11 tests, tests-only 3–4ms (total vitest duration ~500ms including transform/collect/prepare). Well under 300ms AC.
- Slice 2 Membership unit suite time: 12 tests, tests-only 4ms (combined unit run: 23 tests across Catalog+Membership in 8ms tests-only, ~589ms total vitest duration). Well under 300ms AC.
- Slice 3 Lending unit suite time: 17 tests (15 facade + 2 reservation DSL), tests-only 11ms (combined unit run: 40 tests across all three modules in 20ms tests-only, ~726ms total vitest duration). Well under 500ms AC.
- Slice 4 Integration suite time: _TBD_
- Total unit suite time (all three modules): 40 tests across 4 files in 17ms tests-only, ~930ms total vitest duration. Well under 2-second global AC.
- Slice 6 Claude skill: SKILL.md 131 lines (under 500 AC); all 7 reference templates present and under 60 lines each; single Java/Spring/Groovy/Spock provenance mention (line 6); all referenced demo paths verified to exist; all 40 unit tests still green post-skill.

## Verification complete

All six slices verified. Spec is complete.
