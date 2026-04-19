# Spec: Fines Module

## Overview

The Fines module adds monetary penalties for overdue library loans. When a loan goes past its due date, the module accrues a fine at a configurable daily rate. When a member's total unpaid fines cross a configurable threshold, Membership is asked to suspend the member automatically.

**Teaching anchor:** This module exists primarily to showcase the canonical **justified hand-rolled fake facade** pattern for `GUIDE.md` Principle 7. Slice 5 contains the single hand-rolled-fake test in the Fines unit spec; every other unit test uses the real facades via their factories. The spec, the test file's comment block, and the documentation updates in Slice 10 must all converge on the same message: **real-facade-via-factory is the default, hand-rolled fakes are a justified exception with a specific shape of problem they solve.**

## Out of Scope

- Multi-currency support (single implicit currency, integer cents)
- Cross-module borrow block (Lending does NOT import Fines; a suspended member is blocked at Membership, not at Fines)
- Any UI / frontend
- Automatic reinstatement of a suspended member on payment (operator does that via Membership directly)
- Fine waivers / partial payments / refunds
- Historical back-dating of fines (always accrue against `now` passed in)

## Module Surface

### Facade API

```ts
export interface FinesFacade {
  assessFinesFor(memberId: MemberId, now: Date): Promise<ReadonlyArray<FineDto>>;
  processOverdueLoans(now: Date): Promise<void>;
  listFinesFor(memberId: MemberId): Promise<ReadonlyArray<FineDto>>;
  payFine(fineId: FineId): Promise<FineDto>;
  findFine(fineId: FineId): Promise<FineDto>;
}
```

### DTOs

```ts
export interface FineDto {
  fineId: FineId;
  memberId: MemberId;
  loanId: LoanId;
  amountCents: number;        // integer cents, single implicit currency
  assessedAt: Date;
  paidAt: Date | null;
}
```

### Events (published on the in-process event bus)

- `FineAssessed { fineId, memberId, loanId, amountCents, assessedAt }`
- `MemberAutoSuspended { memberId, totalUnpaidCents, thresholdCents, suspendedAt }`

### Errors

- `FineNotFoundError` (new, owned by Fines) → HTTP 404
- `FineAlreadyPaidError` (new, owned by Fines) → HTTP 409
- `MemberNotFoundError` (reused from Membership, re-thrown by Fines facade) → HTTP 404

### HTTP Endpoints

| Method | Path                                       | Facade call            | Notes                          |
| ------ | ------------------------------------------ | ---------------------- | ------------------------------ |
| POST   | `/members/:memberId/fines/assessments`     | `assessFinesFor`       | Returns `FineDto[]` assessed   |
| POST   | `/fines/batch/process`                     | `processOverdueLoans`  | 204, no body                   |
| GET    | `/members/:memberId/fines`                 | `listFinesFor`         | Returns `FineDto[]`            |
| GET    | `/fines/:fineId`                           | `findFine`             | Returns `FineDto`, 404 if miss |
| PATCH  | `/fines/:fineId/paid`                      | `payFine`              | Returns updated `FineDto`, 409 if already paid |

### Config (injected at wiring time)

```ts
export interface FinesConfig {
  dailyRateCents: number;        // default 25
  suspensionThresholdCents: number; // default 500
}
```

Defaults live in the module; tests override per scenario by constructing a different `FinesConfig` when calling `createFinesFacade`.

### Dependencies

- **LendingFacade** — to enumerate overdue, unreturned loans and read their due dates
- **MembershipFacade** — to call `suspend(memberId)` when the threshold is crossed
- **EventBus** — to publish `FineAssessed` and `MemberAutoSuspended`
- **FineRepository** — module-owned, in-memory in tests, Drizzle/Postgres in prod

Lending has **no** dependency on Fines.

---

## Slices

### Slice 1: Types, errors, repository, sample data — foundation only

No facade yet. Sets up the vocabulary.

- [x] AC-1.1: `FineId`, `FineDto`, `FinesConfig`, `FineAssessed`, `MemberAutoSuspended` are exported from the Fines module barrel `index.ts`.
- [x] AC-1.2: `FineNotFoundError` and `FineAlreadyPaidError` each carry the offending `fineId` and extend the project's existing `DomainError` base.
- [x] AC-1.3: `FineRepository` interface defines `save`, `findById`, `listByMemberId`, `findByLoanId` (used for idempotency) — all async, all returning domain types.
- [x] AC-1.4: `InMemoryFineRepository` implements `FineRepository` and is the repository used by every unit test in slices 2-5.
- [x] AC-1.5: `sampleFine(overrides?)` builder produces a valid `FineDto` with sensible defaults and a `paidAt: null`.
- [x] AC-1.6: Barrel `index.ts` does NOT export the repository class, the in-memory repo, or the sample builder — only the facade factory, DTOs, errors, events, and config type.

### Slice 2: `assessFinesFor(memberId, now)` — single-member assessment

- [x] AC-2.1: For a member with zero overdue loans, `assessFinesFor` returns `[]` and persists nothing.
- [x] AC-2.2: For a member with one loan overdue by N days, a single `FineDto` is persisted with `amountCents === N * dailyRateCents`, `paidAt: null`, `assessedAt === now`.
- [x] AC-2.3: For a member with multiple overdue loans, one `FineDto` per loan is persisted; the returned array matches what was saved.
- [x] AC-2.4: Each assessed fine emits one `FineAssessed` event with matching fields.
- [x] AC-2.5: If the member does not exist in Membership, `MemberNotFoundError` propagates out and no fines are persisted.
- [x] AC-2.6: The unit spec uses `createLendingFacade()` and `createMembershipFacade()` directly — no hand-rolled fakes.

### Slice 3: `processOverdueLoans(now)` — batch + auto-suspend

- [x] AC-3.1: With no overdue loans in the system, `processOverdueLoans` is a no-op: nothing persisted, no events emitted.
- [x] AC-3.2: With overdue loans spread across N distinct members, a fine is assessed for each overdue loan and grouped per member.
- [x] AC-3.3: For a member whose resulting total unpaid fines remain below `suspensionThresholdCents`, Membership.suspend is NOT called and no `MemberAutoSuspended` event fires.
- [x] AC-3.4: For a member whose resulting total unpaid fines cross `suspensionThresholdCents`, `MembershipFacade.suspend(memberId)` is called exactly once and one `MemberAutoSuspended` event is published with the computed totals.
- [x] AC-3.5: A member already suspended before processing is still assessed fines but `suspend` is not called a second time and `MemberAutoSuspended` is not re-published.
- [x] AC-3.6: The unit spec uses `createLendingFacade()` and `createMembershipFacade()` directly — no hand-rolled fakes.

### Slice 4: `listFinesFor`, `findFine`, `payFine` + idempotency

- [x] AC-4.1: `listFinesFor(memberId)` returns all fines for that member in insertion order; returns `[]` for a member with none.
- [x] AC-4.2: `findFine(fineId)` returns the stored `FineDto`; unknown id throws `FineNotFoundError`.
- [x] AC-4.3: `payFine(fineId)` sets `paidAt` to the current time and returns the updated DTO.
- [x] AC-4.4: Calling `payFine` a second time on the same fine throws `FineAlreadyPaidError` and does not mutate `paidAt`.
- [x] AC-4.5: Running `processOverdueLoans(now)` twice with the same set of overdue loans persists exactly one fine per loan — the second run is a no-op for already-fined loans (idempotency via `findByLoanId`).
- [x] AC-4.6: The second run in AC-4.5 does NOT re-emit `FineAssessed` for loans that already have a fine.

### Slice 5: Canonical hand-rolled-fake test — the teaching moment

This is the **only** hand-rolled-fake test in the Fines unit spec. Every AC in this slice hangs off the single scenario: Membership.suspend throws mid-batch, after fines have already been recorded.

- [x] AC-5.1: `fines.facade.spec.ts` contains a comment block (at the top of the file, or immediately above the `describe('when Membership.suspend throws', …)` block) explaining why this test uses a hand-rolled fake instead of `createMembershipFacade()`. The comment names Principle 7 and states the criterion: **the real facade cannot be induced to throw at the exact mid-batch moment without corrupting its internal state**.
- [x] AC-5.2: A `ThrowingOnceMembershipFacade` class is defined in the spec file itself (not exported). It wraps a real `MembershipFacade` produced by `createMembershipFacade()`, delegates every method to the wrapped instance, and throws a deterministic error on the **first** call to `suspend` only. Second and subsequent `suspend` calls delegate normally.
- [x] AC-5.3: Scenario: two members, each with overdue loans; the first member's fines cross the threshold. The first `suspend` call throws. The second member is never reached because `processOverdueLoans` propagates the error.
- [x] AC-5.4: After the throw propagates to the caller, the fine that was recorded for the first member (before the `suspend` call) is still in the repository. Not rolled back.
- [x] AC-5.5: The `FineAssessed` event(s) published before the throw remain on the bus — the test asserts on the captured event list.
- [x] AC-5.6: `MemberAutoSuspended` is NOT published for the member whose `suspend` call threw.

### Slice 6: HTTP controller + interaction helpers

Controller-level unit tests, no Postgres. Wires a NestJS controller onto the facade and adds a typed helper so future integration tests read cleanly.

- [x] AC-6.1: `POST /members/:memberId/fines/assessments` calls `assessFinesFor` with the path param and a server-side `now`, returns `200` and the `FineDto[]`.
- [x] AC-6.2: `POST /fines/batch/process` calls `processOverdueLoans(now)` and returns `204` with no body.
- [x] AC-6.3: `GET /members/:memberId/fines` returns `200` with `FineDto[]` from `listFinesFor`.
- [x] AC-6.4: `GET /fines/:fineId` returns `200` with the `FineDto`; unknown id surfaces as `404` via the existing domain-error filter.
- [x] AC-6.5: `PATCH /fines/:fineId/paid` returns `200` with the updated `FineDto`; a second call returns `409` via the domain-error filter.
- [x] AC-6.6: `test/support/interactions/fines-interactions.ts` exposes `assessFinesFor`, `processOverdueLoans`, `listFinesFor`, `payFine`, `findFine` helpers that target the HTTP surface and return typed DTOs.
- [x] AC-6.7: `domain-error.filter.ts` maps `FineNotFoundError → 404` and `FineAlreadyPaidError → 409`, with a filter-level unit test covering both. The existing `MemberNotFoundError → 404` path already covers the re-thrown membership error. (Moved from Slice 9 per the architecture advisor so AC-6.4 and AC-6.5 are independently releasable.)

### Slice 7: Drizzle persistence

- [x] AC-7.1: `fines` Drizzle table schema defines `fine_id` (uuid, pk), `member_id` (uuid, fk-shape, not enforced cross-module), `loan_id` (uuid), `amount_cents` (integer, not null), `assessed_at` (timestamptz), `paid_at` (timestamptz, nullable).
- [x] AC-7.2: Migration `0002_fines.sql` creates the `fines` table and is idempotent against an already-migrated database.
- [x] AC-7.3: `DrizzleFineRepository` implements `FineRepository` over the Drizzle table; `save` upserts by `fine_id`, `findByLoanId` returns the single matching row or `null`.
- [x] AC-7.4: The `db/schema/index.ts` barrel re-exports the `fines` table alongside the existing Catalog / Membership / Lending tables.
- [x] AC-7.5: A focused Drizzle-repository integration test (testcontainers Postgres) round-trips one fine through `save` then `findById` and verifies every field.

### Slice 8: Cross-module integration test

The only full-stack test in this module. Proves the HTTP + Postgres + cross-module path end-to-end.

- [x] AC-8.1: Boot the full Nest app against a testcontainers Postgres; seed one member with two overdue loans whose combined fines will cross `suspensionThresholdCents` (override config if needed to keep the test small).
- [x] AC-8.2: `POST /fines/batch/process` returns `204`.
- [x] AC-8.3: After the call, `SELECT * FROM fines WHERE member_id = $1` returns exactly two rows, both unpaid, with `amount_cents` matching the day-count-based formula.
- [x] AC-8.4: After the call, the member's status column in the Membership table is `SUSPENDED`.
- [x] AC-8.5: A `FineAssessed` event was captured for each fine and one `MemberAutoSuspended` event for the member.

### Slice 9: App wiring

- [x] AC-9.1: `app.module.ts` imports `FinesModule` and provides a `FinesConfig` with the defaults (`dailyRateCents: 25`, `suspensionThresholdCents: 500`).
- [x] AC-9.2: `FinesModule` wires `DrizzleFineRepository` in the production provider and exports only the facade. (Satisfied in Slice 7 — verifier confirmed the `DATABASE`-token `useFactory` pattern matching catalog/lending, and barrel discipline was already covered by AC-1.6.)
- [x] AC-9.3: (Moved to Slice 6 as AC-6.7 — error-filter registration is now bundled with the controller slice.)

### Slice 10: Documentation updates

Three files updated in lock-step so the message lands.

- [x] AC-10.1: `GUIDE.md` **Principle 7** is rewritten to present real-facade-via-factory and hand-rolled-fake as a **genuine tradeoff**. The rewrite lists: (a) when to prefer real-via-factory — the default, (b) when a hand-rolled fake is justified — inducing specific failure timing, forcing mid-operation exceptions, or simulating a collaborator not yet built, (c) when a hand-rolled fake is NOT justified — convenience, avoiding repository setup, or dodging sample-data builders.
- [x] AC-10.2: `GUIDE.md` Principle 7 cites the Slice-5 test in `fines.facade.spec.ts` as the canonical justified example, and updates (or removes) any prior claim that hand-rolled fakes are "never used" — `lending.reservations.spec.ts` and `fines.facade.spec.ts` both use them.
- [x] AC-10.3: `.claude/skills/nabrdalik-module-tests/SKILL.md` applies the same rebalancing: real-via-factory is the default, hand-rolled fakes are a justified exception; cite Fines' Slice-5 as the example.
- [x] AC-10.4: `docs/FEATURES.md` gains a Fines section parallel to Catalog / Membership / Lending: one-paragraph summary, facade API table, events list, errors list.
- [x] AC-10.5: `docs/FEATURES.md` HTTP surface table gains rows for all five Fines endpoints with method, path, and short description.
- [x] AC-10.6: None of the three updated docs contradict each other on when to hand-roll a fake — the decision criteria are worded consistently.

---

## Technical Context

- **Patterns to follow:** existing Catalog / Membership / Lending module layout — facade factory, in-memory repo in tests, Drizzle repo in prod, event bus injected, domain errors mapped by the global filter.
- **Key dependencies (Fines → X):** Lending (read overdue loans), Membership (suspend), EventBus, FineRepository.
- **Dependencies ON Fines:** none. Lending does not import Fines.
- **Risk level:** MODERATE. Correctness risks are concentrated in (a) idempotency of `processOverdueLoans`, (b) the partial-failure behaviour when `Membership.suspend` throws mid-batch, and (c) the threshold-crossing arithmetic. The teaching-anchor role makes Slice 5 load-bearing: if that test is muddy, the whole module fails its purpose.
- **Teaching invariant:** exactly one hand-rolled-fake test in the Fines unit spec. If a reviewer adds a second, they must either delete it or justify it in a comment block using the same criteria as Slice 5.
