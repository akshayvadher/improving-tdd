# Spec: ISBN Lookup Gateway

## Overview

Introduce `IsbnLookupGateway` — an outbound port that Catalog's `addBook` calls to fetch canonical `{ title, authors }` metadata for an ISBN before persisting the book. The gateway lives in `src/shared/` alongside `events/` and `http/`, ships with an in-memory default, and is wired into `createCatalogFacade` via an optional override.

**Primary teaching point.** This feature demonstrates that the "in-memory implementation, not mocks" rule from Principle 5 applies equally to **outbound collaborators** (external APIs), not just to the module's own data (repositories). A spec-local `ThrowingOnceIsbnLookupGateway` (mirroring `ThrowingOnceReservationRepository` in Lending, `lending.facade.spec.ts:347-377`) proves a gateway failure surfaces to the caller and leaves no partial state behind — without mocking libraries, without HTTP stubs, without test doubles that drift from the real contract.

## Teaching anchor

**Slice 3 is the canonical teaching moment of this feature** — the same way Fines' Slice 5 is the canonical hand-rolled-fake teaching moment. Everything before Slice 3 is scaffolding for it; everything after is dressing. A reader who only reads Slice 3 should walk away understanding why we extended the in-memory pattern to outbound gateways instead of reaching for a mocking library.

## Out of scope

Explicitly NOT part of this feature:

- Real HTTP adapter (e.g. `fetch`-based or SDK-based gateway against a live ISBN API)
- Retries, exponential backoff, timeouts
- Circuit breakers, bulkheads, any resilience pattern beyond "surface the error"
- Multi-provider fallback (e.g. try Google Books, then Open Library)
- Caching (in-memory or persistent) of lookup results
- Integration test for the gateway — `catalog.crucial-path.integration.spec.ts` continues to prove Drizzle only; the in-memory gateway is used in integration too
- CLI command to trigger a lookup
- UI surface (this is backend-only)
- Overwriting client-provided `title` / `authors` when the gateway has different values — client always wins
- Observability, metrics, logging beyond what already exists

## Module surface

### Port

```ts
// apps/library/src/shared/isbn-gateway/book-metadata.ts
export type BookMetadata = {
  title: string;
  authors: string[];
};

// apps/library/src/shared/isbn-gateway/isbn-lookup-gateway.ts
export interface IsbnLookupGateway {
  findByIsbn(isbn: string): Promise<BookMetadata | null>;
}
```

### In-memory default

```ts
// apps/library/src/shared/isbn-gateway/in-memory-isbn-lookup-gateway.ts
export class InMemoryIsbnLookupGateway implements IsbnLookupGateway {
  seed(isbn: string, metadata: BookMetadata): void { /* ... */ }
  findByIsbn(isbn: string): Promise<BookMetadata | null> { /* ... */ }
}
```

### Catalog integration

```ts
// catalog.configuration.ts
export type CatalogOverrides = {
  repository?: BookRepository;
  newId?: () => string;
  isbnLookupGateway?: IsbnLookupGateway; // new
};

export const createCatalogFacade = (overrides: CatalogOverrides = {}): CatalogFacade =>
  new CatalogFacade(
    overrides.repository ?? new InMemoryBookRepository(),
    overrides.newId ?? randomUUID,
    overrides.isbnLookupGateway ?? new InMemoryIsbnLookupGateway(), // new
  );
```

`CatalogFacade.addBook` gains an enrich step **after `parseNewBook` and before the duplicate check**:

1. `parseNewBook(dto)` — existing validation still runs on raw DTO shape
2. **new:** `const enrichment = await gateway.findByIsbn(dto.isbn)`
3. **new:** merge — client values win; gateway fills only missing fields
4. **new:** re-validate merged DTO through `parseNewBook` (so enriched result must still satisfy invariants; if neither gateway nor client supplied a title/author, fail with `InvalidBookError` as today)
5. `findBookByIsbn` (duplicate check) — unchanged
6. `newId()` + `saveBook` on the **merged** DTO — persisted book has enriched fields
7. return merged DTO

### Nest wiring

`catalog.module.ts` registers `InMemoryIsbnLookupGateway` as a provider and passes it into the `CatalogFacade` `useFactory`, so the app compiles and runs with the in-memory default. No separate `shared/isbn-gateway/isbn-gateway.module.ts` is required for this slice — a single provider inside `CatalogModule` is sufficient until a second consumer appears.

---

## Slice 1 — IsbnLookupGateway port + InMemoryIsbnLookupGateway

Create the shared port, the DTO, and the in-memory default. No Catalog wiring yet — this slice ships a standalone, tested collaborator.

**New files:**
- `apps/library/src/shared/isbn-gateway/book-metadata.ts`
- `apps/library/src/shared/isbn-gateway/isbn-lookup-gateway.ts`
- `apps/library/src/shared/isbn-gateway/in-memory-isbn-lookup-gateway.ts`
- `apps/library/src/shared/isbn-gateway/in-memory-isbn-lookup-gateway.spec.ts`

**Acceptance criteria:**

- [x] AC-1.1: `InMemoryIsbnLookupGateway.findByIsbn` returns the metadata previously passed to `seed` for the matching ISBN.
- [x] AC-1.2: `InMemoryIsbnLookupGateway.findByIsbn` returns `null` for an ISBN that was never seeded.
- [x] AC-1.3: Seeding two distinct ISBNs stores them independently — each `findByIsbn` call returns its own metadata.
- [x] AC-1.4: `findByIsbn` returns a `Promise<BookMetadata | null>` (async signature matches the port interface).
- [x] AC-1.5: Re-seeding the same ISBN replaces the previous metadata (last write wins).

**Teaching anchor:** A gateway is an ordinary interface; the in-memory default is an ordinary class. No framework, no DI ceremony — a port and a plain implementation.

---

## Slice 2 — Catalog.addBook enriches missing fields from the gateway

Wire the gateway into `CatalogFacade.addBook` so missing client fields are filled from gateway metadata, with client values always winning. Extend `createCatalogFacade` to accept an `isbnLookupGateway` override.

**Touched files:**
- `apps/library/src/catalog/catalog.configuration.ts` — add `isbnLookupGateway?` to overrides
- `apps/library/src/catalog/catalog.facade.ts` — accept gateway in constructor, call it in `addBook`
- `apps/library/src/catalog/catalog.facade.spec.ts` — add a new `describe('addBook — ISBN enrichment', ...)` block; do NOT modify existing tests

**Existing tests MUST still pass unchanged** — the `buildFacade()` helper continues to use the in-memory default, and unseeded ISBNs return `null`, so existing flows that pass full `{ title, authors, isbn }` DTOs are untouched.

**Acceptance criteria:**

- [x] AC-2.1: When the DTO omits `title` and the gateway returns metadata for that ISBN, the saved book has the gateway's title.
- [x] AC-2.2: When the DTO omits `authors` (or passes `[]`) and the gateway returns metadata for that ISBN, the saved book has the gateway's authors.
- [x] AC-2.3: When the DTO supplies a `title` AND the gateway returns a DIFFERENT title for that ISBN, the saved book keeps the client's title (client wins).
- [x] AC-2.4: When the DTO supplies non-empty `authors` AND the gateway returns different authors, the saved book keeps the client's authors (client wins).
- [x] AC-2.5: When the DTO already supplies `title` and `authors` AND the gateway returns `null`, `addBook` succeeds with the client's data.
- [x] AC-2.6: When the DTO omits `title` (or `authors`) AND the gateway returns `null`, `addBook` fails with `InvalidBookError` (same error the existing validation path produces).
- [x] AC-2.7: The enrichment call happens BEFORE the duplicate-ISBN check — a duplicate ISBN still fails with `DuplicateIsbnError` and the merged DTO is what's compared.
- [x] AC-2.8: `createCatalogFacade({ isbnLookupGateway })` uses the supplied override; omitting it falls back to a fresh `InMemoryIsbnLookupGateway`.
- [x] AC-2.9: Returned `BookDto` reflects the merged (persisted) shape, not the raw input DTO.

**Teaching anchor:** An outbound call is just a method call on an injected port. The merge is domain logic and lives in the facade — the gateway has no opinion on precedence.

---

## Slice 3 — ThrowingOnceIsbnLookupGateway demonstrates fault injection

**This is the teaching moment.** Add a spec-local `ThrowingOnceIsbnLookupGateway` wrapper that mirrors `ThrowingOnceReservationRepository` (`lending.facade.spec.ts:347-377`): it decorates the real in-memory gateway, exposes `armFailureOnNextLookup(error)`, throws the armed error on the next `findByIsbn` call, and then clears the slot so subsequent calls pass through.

**Touched files:**
- `apps/library/src/catalog/catalog.facade.spec.ts` — add the wrapper class at the bottom of the file (spec-local, not exported) and a new `describe('addBook — gateway failures', ...)` block with the two tests below.

**Wrapper shape (illustrative):**

```ts
class ThrowingOnceIsbnLookupGateway implements IsbnLookupGateway {
  private armedError: Error | null = null;
  constructor(private readonly delegate: IsbnLookupGateway) {}

  armFailureOnNextLookup(error: Error): void {
    this.armedError = error;
  }

  async findByIsbn(isbn: string): Promise<BookMetadata | null> {
    if (this.armedError) {
      const error = this.armedError;
      this.armedError = null;
      throw error;
    }
    return this.delegate.findByIsbn(isbn);
  }
}
```

**Acceptance criteria:**

- [x] AC-3.1: When the gateway throws mid-`addBook`, the error surfaces to the caller (test awaits and asserts the exact error instance/message).
- [x] AC-3.2: After a gateway failure during `addBook`, the book repository has no record for that ISBN (nothing persisted).
- [x] AC-3.3: Negative control — after an armed failure fires once, the NEXT `addBook` call on the same facade succeeds (the arming state is single-shot and self-clearing).
- [x] AC-3.4: The `ThrowingOnceIsbnLookupGateway` is declared inside `catalog.facade.spec.ts` and is NOT exported from any barrel.

**Teaching anchor:** This is why we use in-memory doubles instead of mocking libraries — a tiny wrapper class gives us deterministic fault injection, is trivial to read, and guarantees the "real" interface is exercised. The same pattern applies to repositories (own data) and gateways (external APIs) alike.

---

## Slice 4 — Production wiring + docs

Wire the in-memory gateway into Nest so the app boots, and update the teaching docs so the new pattern is discoverable.

**Touched files:**
- `apps/library/src/catalog/catalog.module.ts` — register `InMemoryIsbnLookupGateway` as a provider and inject it into the `CatalogFacade` `useFactory`.
- `GUIDE.md` — Principle 5: add a subsection "In-memory doubles for outbound gateways" that names `IsbnLookupGateway`, points at the Slice 3 spec, and contrasts with Principle 7's hand-rolled-fake-of-a-module-facade pattern.
- `GUIDE.md` — Principle 6: add a line noting `createCatalogFacade` now accepts `isbnLookupGateway`.
- `.claude/skills/nabrdalik-module-tests/SKILL.md` — checklist item: "inject an in-memory outbound gateway when the facade calls an external service"; workflow note: "shared gateways live in `src/shared/<gateway-name>/`".
- `docs/FEATURES.md` — Catalog paragraph: mention that ISBN metadata is enriched via an external lookup at add time, with the in-memory default standing in for the real provider.

**Acceptance criteria:**

- [x] AC-4.1: `pnpm start` (or the equivalent Nest boot) succeeds with the new provider registered — no unresolved dependencies.
- [x] AC-4.2: `GUIDE.md` Principle 5 has a subsection whose heading names outbound gateways and whose body references `ThrowingOnceIsbnLookupGateway` by name.
- [x] AC-4.3: `GUIDE.md` Principle 6 mentions the new `isbnLookupGateway` override slot on `createCatalogFacade`.
- [x] AC-4.4: `SKILL.md` checklist has a new item for in-memory outbound gateways and the workflow section mentions the `src/shared/<gateway-name>/` placement convention.
- [x] AC-4.5: `docs/FEATURES.md` Catalog section mentions ISBN enrichment at add time.
- [x] AC-4.6: All existing Catalog tests (unit + integration) still pass unchanged.

**Teaching anchor:** Docs make the pattern discoverable. A reader landing on GUIDE.md Principle 5 should now find both inbound repositories and outbound gateways treated as peers under the same "in-memory, not mocks" rule.

---

## Technical Context

- **Patterns to follow:** `src/shared/events/` (port + in-memory default) for the shared-folder shape; `ThrowingOnceReservationRepository` (`lending.facade.spec.ts:347-377`) for the fault-injection wrapper.
- **Key dependencies:** `CatalogFacade`, `createCatalogFacade`, `CatalogModule`, the existing `parseNewBook` validation path (reused — not duplicated).
- **Risk level:** LOW. No new infra, no new external dependencies, no retries/circuit-breakers. The in-memory default is the production default for now.
- **Independently shippable:** Slices 1, 2, 3, 4 each pass their own tests on their own. Slice 1 ships a tested-but-unused collaborator. Slice 2 ships the enrichment behavior. Slice 3 ships the fault-injection teaching test. Slice 4 ships production wiring + docs.

---

[x] Reviewed
