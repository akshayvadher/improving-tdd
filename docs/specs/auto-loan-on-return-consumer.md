# Spec: Auto-loan-on-return consumer

## Overview

When a book is returned and there is a queue of pending reservations for that book, the earliest eligible reserver should automatically receive a new loan on the same copy — no second HTTP call, no polling, no manual intervention. Today this "fulfillment" is a synchronous write stapled onto `LendingFacade.returnLoan` that only marks the reservation as fulfilled; it does not open a loan. This feature promotes the fulfillment logic into a post-commit **event-driven consumer** that subscribes to `LoanReturned`, walks the reservation queue for the returned book, and opens a new loan for the first eligible reserver — or cleanly reports failure.

Structurally this adds:
- A **subscribe** capability on `EventBus` (the port currently only publishes).
- Async awaited fan-out on `InMemoryEventBus.publish`.
- A new `createAutoLoanOnReturnConsumer(...)` factory living in `apps/library/src/lending/` alongside `createLendingFacade`.
- Two new domain events: `AutoLoanOpened` (success) and `AutoLoanFailed` (swallowed failure).
- Removal of the in-facade `fulfillNextReservation` path from `returnLoan`.

The consumer is **post-commit** and **in-process**. It runs after `returnLoan`'s transaction has committed and after `catalog.markCopyAvailable` has fired. It is not part of any `TransactionalContext.run` block — cross-module consistency follows GUIDE Principle 7 (events + happens-before, never a shared transaction). Its own DB writes (claim-first reservation fulfillment, new loan insert) run through the same `createLendingFacade`-wired facade path plus one direct `ReservationRepository.saveReservation` call for the claim.

## Teaching anchor

This feature is a **live demonstration of GUIDE Principles 5 and 7 on the event side of the seam**:

- Principle 5 ("in-memory doubles, not mocks") — the test's `EventBus` is `InMemoryEventBus`, not a mock. Its `publish` is awaited; handlers run real code against real in-memory repos. A `ThrowingOnceLoanRepository` (same shape as the existing `ThrowingOnceReservationRepository`) injects the one kind of failure the well-behaved double cannot produce.
- Principle 7 ("other modules' facades, never their internals") — the consumer depends on `MembershipFacade.checkEligibility` and on `LendingFacade.borrow`, both through their public API. It never imports `MembershipStatus` or pokes at `loans.entity`. Its own reservation-claim is the one direct repository call, and it lives inside Lending — its own module, its own data.

If a reader walks away from this slice with *"async fan-out + real in-memory collaborators + spec-local fault wrappers = the way to test event-driven code"* the spec did its job.

## Context and constraints

**Current state:** `LendingFacade.returnLoan` opens a tx, marks the loan returned, and — via the private `fulfillNextReservation` helper — sets `fulfilledAt` on the earliest pending reservation. Both writes commit together. The caller sees `LoanReturned` and `ReservationFulfilled` on the bus. No new loan is opened for the reserver; fulfillment is a bookkeeping half-step.

**Target state:** `returnLoan` stages only its own loan update and the `LoanReturned` event. The consumer subscribes to `LoanReturned`, claim-firsts the next eligible reservation via a single `saveReservation` write, and calls `lending.borrow(memberId, copyId)` to open the new loan. Success emits `AutoLoanOpened`; failure emits `AutoLoanFailed` and un-fulfills the claim.

**Concurrency model:** single-node, in-process. `InMemoryEventBus` fan-out runs in the same JavaScript tick — but because `publish` becomes `async` and handlers are `await`ed, any `await` inside a handler yields the event loop. Two concurrent `returnLoan` calls on different copies of the *same* book can both trigger consumer runs that race for the same reservation. Claim-first (write `reservation.fulfilledAt = now` BEFORE `borrow`) resolves the race: the loser sees the reservation already fulfilled and moves on to the next pending one.

**Deferred hardening — the claim-first race:** on a real Postgres deployment, the JavaScript event-loop ordering is not enough; a DB-level unique constraint on `(bookId, memberId)` where `fulfilledAt IS NULL` is the proper guard. That migration is **out of scope** for this feature; the consumer ships with the claim-first pattern, and the unique constraint is called out as follow-up hardening.

**Dependencies:**
- `CatalogFacade` — the consumer does NOT depend on Catalog directly. `lending.borrow` already handles `catalog.markCopyUnavailable`.
- `MembershipFacade` — `checkEligibility(memberId)` returns `{ eligible, reason? }`. The consumer uses it to skip ineligible reservers.
- `LendingFacade` — `borrow(memberId, copyId)` is the happy path. Its existing invariants (member eligibility, copy availability) stay authoritative.
- `ReservationRepository` — direct, for the claim-first write. The consumer holds this as an injected collaborator, same as the facades.
- `EventBus` — subscribe + publish.

## Out of scope

- DB-level unique constraint on `(bookId, pending, memberId)` — follow-up hardening, separate commit, separate migration.
- Retry policy beyond swallow-and-emit. If `borrow` throws, the consumer publishes `AutoLoanFailed` and stops. No exponential backoff, no dead-letter queue.
- Cross-node coordination / distributed locking. Single-node in-process stays the assumption.
- Ops alerting, metrics, or dashboards on `AutoLoanFailed`. The event exists; downstream consumers of it are future work.
- Notifying the reserver (email / SMS / in-app) when their hold becomes a loan. Separate capability, separate module.
- Changing `borrow`'s public contract. `borrow` still fires `LoanOpened`; the consumer layers `AutoLoanOpened` on top.
- A Drizzle migration. No new tables, no new columns, no schema changes.
- `ReservationFulfilled` event — deleted from `returnLoan`'s output. `AutoLoanOpened` carries the reservationId; a downstream consumer that wanted "reservation became a loan" subscribes to the new event.

## Module surface changes

### EventBus port — new shape

```ts
// apps/library/src/shared/events/event-bus.ts
export interface DomainEvent { readonly type: string; }
export type Unsubscribe = () => void;

export interface EventBus {
  publish<T extends DomainEvent>(event: T): Promise<void>;
  subscribe<T extends DomainEvent>(
    type: T['type'],
    handler: (event: T) => Promise<void>,
  ): Unsubscribe;
}
```

### InMemoryEventBus — async fan-out, re-entrancy-safe

```ts
// apps/library/src/shared/events/in-memory-event-bus.ts (post-change, illustrative)
export class InMemoryEventBus implements EventBus {
  private handlersByType = new Map<string, Array<(event: DomainEvent) => Promise<void>>>();
  private collectedEvents: DomainEvent[] = [];

  async publish<T extends DomainEvent>(event: T): Promise<void> {
    this.collectedEvents.push(event);
    const subs = this.handlersByType.get(event.type);
    if (!subs) return;
    // Snapshot before iteration so a handler that re-publishes doesn't mutate
    // the iteration target. Re-entrant publish is allowed; it just runs against
    // the array as it was at the start of this fan-out.
    const snapshot = subs.slice();
    for (const handler of snapshot) {
      await handler(event);
    }
  }

  subscribe<T extends DomainEvent>(type, handler): Unsubscribe { /* … */ }

  collected(): readonly DomainEvent[] { return this.collectedEvents; }
  clear(): void { this.collectedEvents = []; }
}
```

### New events

```ts
// apps/library/src/lending/lending.types.ts additions
export interface AutoLoanOpened extends DomainEvent {
  type: 'AutoLoanOpened';
  bookId: BookId;
  loanId: LoanId;
  memberId: MemberId;
  reservationId: ReservationId;
}

export interface AutoLoanFailed extends DomainEvent {
  type: 'AutoLoanFailed';
  bookId: BookId;
  reservationId: ReservationId;
  reason: string;
}
```

Both are re-exported from the Lending barrel.

### Consumer factory

```ts
// apps/library/src/lending/auto-loan-on-return.consumer.ts
export interface AutoLoanOnReturnConsumerDeps {
  bus: EventBus;
  membership: MembershipFacade;
  reservations: ReservationRepository;
  lending: LendingFacade;
  clock?: () => Date;
}

export interface AutoLoanOnReturnConsumer {
  start(): void;
  stop(): void;
}

export function createAutoLoanOnReturnConsumer(
  deps: AutoLoanOnReturnConsumerDeps,
): AutoLoanOnReturnConsumer;
```

The factory wires subscription laziness — `start()` calls `bus.subscribe('LoanReturned', handler)` and stashes the returned `Unsubscribe`; `stop()` calls it. Tests call `start()` before acting and rely on test isolation to tear down.

### `returnLoan` narrowing (post-change)

```ts
// apps/library/src/lending/lending.facade.ts (post-change returnLoan)
async returnLoan(loanId: LoanId): Promise<LoanDto> {
  const loan = await this.loans.findLoanById(loanId);
  if (!loan) throw new LoanNotFoundError(loanId);

  const returnedAt = this.clock();
  const returned: LoanDto = { ...loan, returnedAt };

  const tx = this.txFactory();
  await tx.run(async () => {
    this.loans.saveLoan(returned, tx);
    tx.stageEvent(this.loanReturnedEvent(returned));
  });
  await this.catalog.markCopyAvailable(returned.copyId);
  return returned;
}
```

The private `fulfillNextReservation` and `reservationFulfilledEvent` helpers are deleted. `ReservationFulfilled` is no longer emitted from `returnLoan`.

---

## Slice 1 — Walking skeleton: async `EventBus`, narrowed `returnLoan`, happy-path consumer

Ship the new port shape, rewire every existing `publish` caller, trim `returnLoan`, introduce the consumer factory, and prove one end-to-end happy-path scenario: a pending reservation becomes a loan when the prior loan is returned.

**Touched files (existing):**
- `apps/library/src/shared/events/event-bus.ts` — `publish` returns `Promise<void>`; add `subscribe`, `Unsubscribe`.
- `apps/library/src/shared/events/in-memory-event-bus.ts` — internal handler map, snapshot-before-iterate fan-out, preserve `collected()` / `clear()`.
- `apps/library/src/fines/fines.facade.ts` — `this.bus.publish(...)` becomes `await this.bus.publish(...)` (two call sites: `fineAssessedEvent`, `memberAutoSuspendedEvent`).
- `apps/library/src/lending/in-memory-transactional-context.ts` — `commit()` awaits each `bus.publish(event)` in the `forEach` (replace with `for … of` loop, `await` each).
- `apps/library/src/lending/drizzle-transactional-context.ts` — `publishEvents()` awaits each `bus.publish(event)` similarly.
- `apps/library/src/lending/lending.facade.ts` — remove `fulfillNextReservation` private + `reservationFulfilledEvent` private; narrow `returnLoan` per "Module surface changes" above.
- `apps/library/src/lending/lending.facade.spec.ts` — remove or migrate the "fulfills a pending reservation and emits both LoanReturned and ReservationFulfilled" test (lines 202-216); narrow the atomicity tests (743-789) so they provoke rollback via a loan-repository failure (not a reservation failure), since the reservation write is gone from the tx.

**New files:**
- `apps/library/src/lending/auto-loan-on-return.consumer.ts` — factory + interface.
- `apps/library/src/lending/auto-loan-on-return.consumer.spec.ts` — unit spec, happy path only in this slice.

**Acceptance criteria:**

- [x] AC-1.1: `EventBus.publish` returns `Promise<void>`. `EventBus` declares `subscribe<T extends DomainEvent>(type: T['type'], handler: (event: T) => Promise<void>): Unsubscribe`.
- [x] AC-1.2: `InMemoryEventBus.publish(event)` awaits every subscribed handler registered for `event.type`, in subscription order, before resolving.
- [x] AC-1.3: `InMemoryEventBus.publish` snapshots its subscriber array BEFORE iterating so a handler that calls `publish(...)` re-entrantly does not mutate the iteration target of the outer fan-out. Handlers subscribed during fan-out are NOT invoked as part of the same publish; they receive subsequent publishes only. (Re-entrancy-safety test in Slice 3 pins the no-corruption guarantee; the behavioural rule lives here.)
- [x] AC-1.4: `InMemoryEventBus.collected()` and `clear()` are preserved, unchanged, for test ergonomics.
- [x] AC-1.5: `subscribe(type, handler)` returns an `Unsubscribe` function; calling it detaches that specific handler without affecting other subscribers to the same type.
- [x] AC-1.6: All existing `bus.publish(event)` callers `await` the call: `fines.facade.ts` (both sites), `in-memory-transactional-context.ts` (`commit`), `drizzle-transactional-context.ts` (`publishEvents`). None of these callers are new; the change is `this.bus.publish(...)` → `await this.bus.publish(...)`.
- [x] AC-1.7: `LendingFacade.returnLoan` no longer calls `fulfillNextReservation`. Its tx stages exactly two things: the loan save and the `LoanReturned` event. Upon commit, only `LoanReturned` appears on the bus — NOT `ReservationFulfilled`.
- [x] AC-1.8: The private `fulfillNextReservation` method and the private `reservationFulfilledEvent` helper on `LendingFacade` are deleted. The `ReservationFulfilled` event type definition remains in `lending.types.ts` (no public breaking change there; consumer spec will not emit it either).
- [x] AC-1.9: `lending.facade.spec.ts` no longer contains the "fulfills a pending reservation and emits both events" test at lines 202-216 — it is migrated to `auto-loan-on-return.consumer.spec.ts` with richer scenarios (Slice 2 + 3 expand it further).
- [x] AC-1.10: The atomicity tests at `lending.facade.spec.ts:743-789` are narrowed to provoke rollback via a **loan**-save failure rather than a reservation failure. Concretely: introduce (or reuse, if one exists) a spec-local `ThrowingOnceLoanRepository` that throws from `saveLoan`. Assert the loan update is NOT visible after the throw and NO `LoanReturned` event is on the bus. The existing `ThrowingOnceReservationRepository` is no longer wired into these two tests because the reservation write has moved out of the tx. Keep the wrapper class itself in the file for Slice 3's consumer-failure tests.
- [x] AC-1.11: `createAutoLoanOnReturnConsumer({ bus, membership, reservations, lending })` returns an object with `start(): void` and `stop(): void`. `start()` subscribes to `'LoanReturned'` on the bus; `stop()` unsubscribes. Calling `start()` twice without an intervening `stop()` is either a no-op (preferred) or throws — pin the chosen behaviour in the TDD plan. The factory itself does NOT call `start()` — the caller owns the lifecycle.
- [x] AC-1.12: `auto-loan-on-return.consumer.spec.ts` happy-path test: given (a) an available copy of book B, (b) a pending reservation for book B by member Bob (eligible), and (c) a current loan on that copy to Alice — when Alice returns the loan, then a NEW loan is opened for Bob on the same `copyId`, the reservation for Bob is marked fulfilled (`fulfilledAt` set), and the bus shows (in order): `LoanReturned`, `LoanOpened` (fired by `borrow`), `AutoLoanOpened`. No `AutoLoanFailed`.
- [x] AC-1.13: The happy-path test wires real `createLendingFacade`, `createMembershipFacade`, `createCatalogFacade` (Principle 7 default). The consumer is wired via `createAutoLoanOnReturnConsumer(...)`, passed the same `bus`, `membership`, and `lending` instances, plus a direct `reservations` handle sourced from the Lending override surface. (See "Testing strategy" for the exact wiring sketch.)
- [x] AC-1.14: The copy's `status` after the consumer runs is `UNAVAILABLE` (because `lending.borrow` called `catalog.markCopyUnavailable`). The cross-module side-effect flows through the real Catalog facade; the test asserts it via `catalog.findCopy(copyId)`.
- [x] AC-1.15: When `LoanReturned` fires for a book with NO pending reservations, the consumer is a no-op: no new loan is persisted, no events other than the already-emitted `LoanReturned` appear on the bus, the copy remains AVAILABLE after `returnLoan` runs.

---

## Slice 2 — Cascade over ineligible reservers

The consumer walks the pending-reservation queue in order and opens a loan for the first **eligible** member, skipping anyone `MembershipFacade.checkEligibility` reports as ineligible (suspended, over-fined, etc). Skipping does NOT fulfill the skipped reservation — the skipped member stays in the queue for the next return.

**Touched files:**
- `apps/library/src/lending/auto-loan-on-return.consumer.ts` — flesh out the handler loop: `for` over `listPendingReservationsForBook(bookId)`, `checkEligibility`, `continue` on ineligible, claim + borrow on first eligible.
- `apps/library/src/lending/auto-loan-on-return.consumer.spec.ts` — add the three scenarios below.

**Acceptance criteria:**

- [x] AC-2.1: On `LoanReturned`, the consumer fetches `listPendingReservationsForBook(bookId)` in the repository's natural order (earliest-reserved first — same order the deleted `fulfillNextReservation` used) and iterates.
- [x] AC-2.2: For each reservation, the consumer calls `membership.checkEligibility(reservation.memberId)`. If `eligible` is `false`, the consumer moves to the next reservation. The skipped reservation's `fulfilledAt` stays null — the skipped member remains in the pending queue for subsequent returns.
- [x] AC-2.3: The consumer opens a loan for the first eligible reserver only. It does NOT attempt to open loans for the rest of the queue in the same pass.
- [x] AC-2.4: When every reservation in the queue is ineligible, the consumer is a no-op: no new loan, no `AutoLoanOpened`, no `AutoLoanFailed`. The copy remains AVAILABLE. All skipped reservations stay pending.
- [x] AC-2.5: Spec scenario "second-in-queue is eligible": two pending reservations for book B — first by a suspended member (M1), second by an eligible member (M2). Return the current loan on a copy of B. Then: a loan is opened for M2 on that copy; M2's reservation has `fulfilledAt` set; M1's reservation is still pending (`fulfilledAt === undefined`); bus shows `LoanReturned`, `LoanOpened` (for M2), `AutoLoanOpened` (for M2's reservation).
- [x] AC-2.6: Spec scenario "only reservation is ineligible": one pending reservation for book B by a suspended member M1. Return the loan. Then: no new loan exists, no `AutoLoanOpened`, no `AutoLoanFailed`, the reservation is still pending, the copy is AVAILABLE.
- [x] AC-2.7: Spec scenario "empty queue": no pending reservations for book B. Return the loan. Then: no new loan, no `AutoLoanOpened`, no `AutoLoanFailed`, copy is AVAILABLE. (Duplicate of AC-1.15 but kept here as an explicit cascade edge.)
- [x] AC-2.8: The cascade tests use a **real** `createMembershipFacade()` seeded with a suspended member (call `membership.suspend(memberId)` after registration) rather than extending `lending.reservations.spec.ts`'s `alwaysEligibleMembership` helper. The test DSL for cascade tests stays narrow — no new shared helper introduced in this slice.

---

## Slice 3 — Claim-first, failure policy, `AutoLoanOpened` event, re-entrancy, NestJS lifecycle

The operational slice: claim-first concurrency, the swallow-and-emit failure policy with un-fulfill-on-failure, the `AutoLoanOpened` event wired after `borrow` returns, a re-entrancy regression test on `InMemoryEventBus`, and the Nest `OnModuleInit` / `OnModuleDestroy` lifecycle.

**Touched files:**
- `apps/library/src/lending/auto-loan-on-return.consumer.ts` — claim-first write + `borrow` call inside a `try`; on `catch`, un-fulfill the claim and publish `AutoLoanFailed`; on success, publish `AutoLoanOpened` after `borrow` returns.
- `apps/library/src/lending/lending.types.ts` — add `AutoLoanOpened` and `AutoLoanFailed` to the union and export from the barrel.
- `apps/library/src/lending/index.ts` — re-export `AutoLoanOpened`, `AutoLoanFailed`, and `createAutoLoanOnReturnConsumer` (the factory; NOT the class shape beyond its `AutoLoanOnReturnConsumer` interface type).
- `apps/library/src/lending/lending.module.ts` — provide `createAutoLoanOnReturnConsumer(...)` via a `useFactory` that injects `EVENT_BUS`, `MembershipFacade`, `RESERVATION_REPOSITORY`, `LendingFacade`. Wire `OnModuleInit` → `consumer.start()` and `OnModuleDestroy` → `consumer.stop()` on the module class (or on a small lifecycle provider the module owns).
- `apps/library/src/lending/auto-loan-on-return.consumer.spec.ts` — add claim-first race, failure path, re-entrancy, and `AutoLoanOpened` ordering scenarios.

**Acceptance criteria — claim-first concurrency:**

- [x] AC-3.1: Before calling `lending.borrow(memberId, copyId)`, the consumer writes `{ ...reservation, fulfilledAt: this.clock() }` through `reservations.saveReservation(...)` (no tx context needed — the consumer runs post-commit, outside every facade's transaction). This write is the "claim."
- [x] AC-3.2: The claim write uses the in-memory reservation repository's existing `saveReservation` signature. (Note for the TDD plan: `saveReservation(reservation, ctx: TransactionalContext)` currently requires a ctx. The consumer either passes a no-op ctx or the port gains an overload `saveReservation(reservation)` for the no-tx path. Decide during planning; document the chosen shape in the consumer's file header.)
- [x] AC-3.3: Spec scenario "two concurrent returns, two reservations, no double-loan": seed two pending reservations for book B — reservation R1 by M1, R2 by M2. Seed two copies of B, both currently loaned out (C1 to Alice, C2 to Carol). Trigger `returnLoan(loan1)` and `returnLoan(loan2)` in parallel (`Promise.all([...])`). Then: both loans open — one to M1 on C1 (or C2), one to M2 on C2 (or C1) — R1 and R2 are both fulfilled, the bus contains exactly two `AutoLoanOpened` events (one per reservation), and NO reservation is fulfilled twice (each `fulfilledAt` is set to exactly one timestamp from exactly one consumer run).
- [x] AC-3.4: In the concurrent scenario above, if the two consumer runs happen to pick the same reservation first, claim-first ensures the loser sees `fulfilledAt !== undefined` in its subsequent iteration and moves to R2. The test asserts the post-state, not the internal ordering — it must pass regardless of which consumer "won" the race for R1.

**Acceptance criteria — `AutoLoanOpened`:**

- [x] AC-3.5: On successful `borrow(...)`, the consumer publishes `{ type: 'AutoLoanOpened', bookId, loanId: <new loan id>, memberId, reservationId }` AFTER `borrow` has resolved. Because `borrow` itself publishes `LoanOpened`, the bus order for one consumer run is `LoanReturned` → `LoanOpened` → `AutoLoanOpened`.
- [x] AC-3.6: Happy-path test asserts this exact order across a single consumer fan-out (via `bus.collected()`).

**Acceptance criteria — failure policy and un-fulfill:**

- [x] AC-3.7: If `borrow(...)` throws, the consumer catches the error. It does NOT re-throw. `returnLoan`'s HTTP caller sees success regardless of consumer outcome.
- [x] AC-3.8: On caught failure, the consumer publishes `{ type: 'AutoLoanFailed', bookId, reservationId, reason: <error.message> }`.
- [x] AC-3.9: On caught failure, the consumer **un-fulfills the claim** — it writes the reservation back with `fulfilledAt: undefined` via `saveReservation`. The reserver stays in the pending queue for the next return. Rationale: the reserver still wants the book; losing the hold on an operational failure is a worse outcome than re-trying on next return.
- [x] AC-3.10: Spec scenario "borrow fails mid-consumer": use a spec-local `ThrowingOnceLoanRepository` (declared at the bottom of `auto-loan-on-return.consumer.spec.ts` — mirrors `ThrowingOnceReservationRepository`) that throws on `saveLoan`. Trigger a return with one pending reservation. Then: no new loan exists (`listLoansFor(memberId)` returns `[]` for the reserver), the reservation's `fulfilledAt` is `undefined` (un-fulfilled), the bus contains `LoanReturned` and `AutoLoanFailed` (no `LoanOpened`, no `AutoLoanOpened`), and the original `returnLoan(...)` resolved normally (did not throw).

**Acceptance criteria — re-entrancy safety:**

- [x] AC-3.11: Spec scenario "handler that re-publishes does not corrupt fan-out": subscribe two handlers H1 and H2 to a test event type T. H1 calls `bus.publish(T)` (re-entrant) from inside its handler. Publish T once from outside. Then: H1 and H2 each see the original event once (the outer fan-out), H1 and H2 each see the re-entrant event once (the inner fan-out), and the iteration of the outer fan-out is not corrupted — both H1 and H2 fire exactly once per outer publish. (This test lives alongside the consumer spec or in a dedicated `in-memory-event-bus.spec.ts`; pin location during planning.)

**Acceptance criteria — NestJS lifecycle:**

- [x] AC-3.12: `LendingModule` provides `AutoLoanOnReturnConsumer` via a factory that injects the `EVENT_BUS` provider, `MembershipFacade`, the `RESERVATION_REPOSITORY` provider, and `LendingFacade`.
- [x] AC-3.13: `LendingModule` (or a module-scoped lifecycle provider) implements `OnModuleInit` and calls `consumer.start()` during `onModuleInit`. It implements `OnModuleDestroy` and calls `consumer.stop()` during `onModuleDestroy`.
- [ ] AC-3.14: A smoke-level integration-style spec (lightweight, no Docker, in-memory) boots a Nest `Test.createTestingModule({ imports: [LendingModule, CatalogModule, MembershipModule, ...] })`, overrides the DB-backed repos with in-memory versions, calls `app.init()`, returns a loan after seeding a pending reservation, and asserts the consumer wired by `OnModuleInit` actually fired (new loan present, `AutoLoanOpened` on the bus). This is OPTIONAL per the developer's direction — "facade spec coverage of the consumer is sufficient" — but if included, keep it in one `it()` with the minimum scaffolding.

---

## Technical context

- **Patterns to follow:**
  - `createLendingFacade` in `lending.configuration.ts` — factory + overrides shape; the consumer factory mirrors it.
  - `ThrowingOnceReservationRepository` in `lending.facade.spec.ts` (currently lines ~793 onward) — the fault-wrapper shape; `ThrowingOnceLoanRepository` follows it line-for-line.
  - `FinesFacade.processOverdueLoans` in `fines.facade.ts` — an async loop through per-member work with event emission, good model for the consumer's per-reservation loop.
  - GUIDE Principle 5 — in-memory doubles for the consumer's collaborators, spec-local fault wrappers for failure injection.
  - GUIDE Principle 7 — real `createLendingFacade` + `createMembershipFacade` + `createCatalogFacade` in every consumer test (default). No hand-rolled facades needed for this feature.

- **Module boundaries:**
  - The consumer lives inside `apps/library/src/lending/`. It is Lending's own internal wiring — not a new module, not a sibling to the facade. The barrel re-exports `createAutoLoanOnReturnConsumer`, `AutoLoanOnReturnConsumer` (interface), `AutoLoanOpened`, `AutoLoanFailed`. Nothing else new leaves the module.
  - The consumer depends on `MembershipFacade` (other module, via its public facade — Principle 7 compliant). It does NOT depend on `CatalogFacade` directly; `lending.borrow` owns the Catalog side-effect.

- **Risk level:** MODERATE.
  - *Correctness:* claim-first ordering, un-fulfill-on-failure, and cascade-over-ineligibility each have their own AC and their own test. The race scenario (AC-3.3, AC-3.4) is the one to watch in TDD planning — `Promise.all([...])` on two handlers can resolve in either order, so the test assertion must be ordering-agnostic.
  - *Migration:* removing `fulfillNextReservation` is a public-behaviour change for `returnLoan`. Every consumer of the old `ReservationFulfilled`-from-returnLoan event is broken unless migrated. The Lending spec is the only in-tree consumer; pin that nothing else subscribes to `ReservationFulfilled` during TDD planning (grep for `'ReservationFulfilled'` before merging Slice 1).
  - *Teaching-anchor role:* if the consumer test reads muddy, the slice fails its purpose. Keep the DSL narrow — no new helper unless the same shape appears three times.

- **Independently shippable:** Slice 1 is a standalone refactor plus a walking-skeleton consumer. Slice 2 adds cascade; it requires Slice 1. Slice 3 adds claim-first, failure handling, the new event, re-entrancy, and Nest lifecycle; it requires Slice 2. Each slice has its own commit boundary; at Slice 1's commit the consumer is already wired via `OnModuleInit` with happy-path-only behaviour (no cascade, no claim-first, no failure event), and that's fine — production traffic sees the same outcome as before (reservation fulfilled, copy unavailable) plus the new loan for the reserver.

## Testing strategy

Every consumer test follows the same scene shape — the walking skeleton lives inline inside the spec rather than in a shared `testing/` folder, matching how `lending.facade.spec.ts`'s `buildScene()` already lives inline.

```ts
// illustrative — exact shape finalised during TDD planning
function buildConsumerScene(overrides: Partial<...> = {}) {
  const clock = () => FIXED_NOW;
  const bus = new InMemoryEventBus();
  const catalog = createCatalogFacade({ newId: sequentialIds('cat') });
  const membership = createMembershipFacade({ newId: sequentialIds('mem') });
  const reservations = new InMemoryReservationRepository();   // so the consumer can claim-first
  const lending = createLendingFacade({
    catalogFacade: catalog,
    membershipFacade: membership,
    reservationRepository: reservations,
    eventBus: bus,
    newId: sequentialIds('loan'),
    clock,
    ...overrides,
  });
  const consumer = createAutoLoanOnReturnConsumer({
    bus, membership, reservations, lending, clock,
  });
  consumer.start();
  return { bus, catalog, membership, reservations, lending, consumer, clock };
}
```

Key rules (from the developer's direction):

- **All facades wired via their real factories** — `createCatalogFacade`, `createMembershipFacade`, `createLendingFacade`, `createAutoLoanOnReturnConsumer`. No hand-rolled facades for this feature.
- **In-memory repositories** — `InMemoryReservationRepository` is the one the consumer holds directly; `InMemoryLoanRepository` is the one `ThrowingOnceLoanRepository` wraps for Slice 3's failure test.
- **Failure injection** — spec-local `ThrowingOnceLoanRepository` declared at the bottom of `auto-loan-on-return.consumer.spec.ts`. Pattern mirrors `ThrowingOnceReservationRepository` (already in `lending.facade.spec.ts`): wraps a real in-memory repo, exposes `armFailureOnNextSave(error)`, single-shot, clears itself after firing. Not exported.
- **`FIXED_NOW` clock + sequential id generator** — standard convention already used throughout the Lending spec.
- **`bus.collected()` is the assertion primitive for event ordering.** Call `bus.clear()` after setup and before the action under test so assertions see only the events we care about.
- **Cascade tests use real suspension** — register a member via `membership.registerMember(...)` then call `membership.suspend(member.memberId)` to produce a real ineligible member. Do NOT extend the `alwaysEligibleMembership` helper from `lending.reservations.spec.ts`; that helper stays scoped to its existing DSL.
- **Concurrency test (AC-3.3)** uses `await Promise.all([...])` on two `returnLoan` calls. Both resolve; then the test inspects post-state on repositories + bus. Because fan-out is awaited per publish but not serialised across publishes, the two consumer runs can interleave at `await` boundaries — exactly the race claim-first is defending against.

**What we do NOT add:**
- No new `scene` in `lending/testing/`. The inline builder is enough; if a third spec file needs the same scene, promote then.
- No Docker-backed integration test for the consumer. The existing `lending.return-loan.integration.spec.ts` already proves the tx-level atomicity against real Postgres; the consumer's post-commit behaviour is well-tested with in-memory doubles plus the optional smoke spec in AC-3.14.

## Forward references to GUIDE

- **Principle 5** — "In-memory implementations, not mocks." This feature's failure tests rely on `ThrowingOnceLoanRepository` (spec-local, not exported), the same shape as `ThrowingOnceReservationRepository` (`apps/library/src/lending/lending.facade.spec.ts`) and `ThrowingOnceIsbnLookupGateway` (`apps/library/src/catalog/catalog.facade.spec.ts`). The bus is `InMemoryEventBus`, the reservation repo is `InMemoryReservationRepository`, the loan repo is `InMemoryLoanRepository`. No `vi.mock`. No hand-rolled fakes of our own collaborators.
- **Principle 7** — "Module boundaries: use other modules' facades, never their internals." The consumer holds `MembershipFacade` (other module, public facade). It holds `LendingFacade` (its own module's public facade — the consumer is internal wiring inside Lending, so this is a self-reference, not a cross-boundary hop). It holds `ReservationRepository` — Lending's OWN data, Principle 5 applies there. No hand-rolled facades for this feature; every collaborator is real via its factory.

## Open questions

None. All six questions from the prior spec-builder run were answered and incorporated. Two planning-level details (flagged above, NOT open questions for the developer) are:

1. **`saveReservation` signature.** Today it requires a `TransactionalContext`. The consumer runs without a tx. During TDD planning either (a) pass a no-op ctx, or (b) add an overload / alternate method on the port for the no-tx path. AC-3.2 calls this out. Either choice works; pick during planning based on which reads cleaner in the consumer's implementation file.
2. **`start()` called twice semantics.** AC-1.11 calls this out. Pick no-op-on-second-call during planning (matches common `OnModuleInit` idempotency expectations) unless a test surfaces a reason to throw.

---

## Save location

This file is `docs/specs/auto-loan-on-return-consumer.md`.
