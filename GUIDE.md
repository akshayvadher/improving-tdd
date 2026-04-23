# Improving TDD — a Walkthrough

A port of Jakub Nabrdalik's *Improving your Test Driven Development in 45 minutes* from Java/Spock to TypeScript/NestJS. The talk's thesis is simple and uncomfortable: most TDD failures are failures of level. Class-level tests break on every refactor and rarely prove behaviour. Whole-system tests are slow, flaky, and expensive. The right unit of test is **the module** — the bounded context. Test its public facade against real in-memory collaborators, mock only the facades of *other* modules, and keep I/O tests for crucial paths only. This guide walks the eleven principles from the talk and points at the running demo under `apps/library/`.

- Talk (video): <https://www.youtube.com/watch?v=2vEoL3Irgiw>
- Slides: <https://jakubn.gitlab.io/improvingtdd/>
- Attribution: Jakub Nabrdalik

## How to run this

```bash
pnpm install
pnpm test:unit
pnpm test:integration    # requires Docker (testcontainers spins up postgres:16)
pnpm --filter library start:dev
```

---

## Principle 1 — Don't test too low

![Too low — class and method tests](./.claude/screenshots/classDiagram2.jpg)

When you write a test per class and per method, every refactor turns red even when behaviour is unchanged. Coverage climbs to 100% but the tests pin implementation, not requirements. You stop refactoring because the tests punish you for it.

The demo never has a `catalog.repository.spec.ts` or a `loan.entity.spec.ts`. There are no tests on private helpers inside a facade. When the repository changes shape — in-memory `Map` today, Drizzle tomorrow — no facade test moves.

One spec file for the whole Catalog module. Every test drives through the public facade — no `catalog.repository.spec.ts`, no test for the private `updateCopyStatus` helper.

```ts
// apps/library/src/catalog/catalog.facade.spec.ts
describe('CatalogFacade', () => {
  it('adds a book and finds it by isbn', async () => {
    const catalog = buildFacade();
    const added = await catalog.addBook(sampleNewBook({ isbn: '978-0134685991' }));
    expect(await catalog.findBook('978-0134685991')).toEqual(added);
  });

  it('marks an available copy unavailable', async () => {
    const catalog = buildFacade();
    const book = await catalog.addBook(sampleNewBook());
    const copy = await catalog.registerCopy(book.bookId, sampleNewCopy({ bookId: book.bookId }));
    const updated = await catalog.markCopyUnavailable(copy.copyId);
    expect(updated.status).toBe(CopyStatus.UNAVAILABLE);
  });
});
```

The private helper it rides through:

```ts
// apps/library/src/catalog/catalog.facade.ts — no dedicated test, covered transitively
private async updateCopyStatus(copyId: CopyId, status: CopyStatus): Promise<CopyDto> {
  const copy = await this.repository.findCopyById(copyId);
  if (!copy) throw new CopyNotFoundError(copyId);
  const updated: CopyDto = { ...copy, status };
  await this.repository.saveCopy(updated);
  return updated;
}
```

---

## Principle 2 — Don't test too high

![End-to-end tests are slow](./.claude/screenshots/sloth.jpg)

Full-stack tests against real HTTP and a real database catch integration bugs but they cost you seconds per case. A thousand of those and you wait 45 minutes for the suite. Developers stop running it locally, CI becomes the only signal, and feedback collapses.

The demo reserves full-stack testing for *crucial paths only* — one integration test per module. Every other scenario — corner cases, error paths, atomicity, the reservation DSL — runs in memory at facade level.

Captured vitest output from `pnpm test:unit`:

```
✓ |unit| src/catalog/catalog.facade.spec.ts  (11 tests) 4ms
✓ |unit| src/membership/membership.facade.spec.ts  (12 tests) 4ms
✓ |unit| src/lending/lending.reservations.spec.ts  (2 tests) 3ms
✓ |unit| src/lending/lending.facade.spec.ts  (15 tests) 8ms

 Test Files  4 passed (4)
      Tests  40 passed (40)
   Duration  959ms (transform 203ms, setup 0ms, collect 1.99s, tests 19ms)
```

Forty tests, nineteen milliseconds of actual assertions. The rest is cold-start overhead that disappears in watch mode.

Lending's only Postgres testcontainer is the crucial-path happy-path (`test/lending.crucial-path.integration.spec.ts`). Atomicity — the contract that `returnLoan`'s tx rolls back the loan write and suppresses `LoanReturned` when a staged callback throws, and that the consumer's claim/un-fulfill tx rolls back its staged event when the save throws — runs in memory against a `ThrowingOnceLoanRepository` wrapper in `apps/library/src/lending/lending.facade.spec.ts` (see `describe('atomicity')`) and `apps/library/src/lending/auto-loan-on-return.consumer.spec.ts` (see `describe('transactional atomicity of the claim (tx showcase)')`). The tx interface is the same in memory and in production — the in-memory substrate proves the contract in milliseconds without booting Postgres.

---

## Principle 3 — Test your modules

![One module, all its own data](./.claude/screenshots/single_module.png)

A module is a bounded context: it owns its data, exposes one public API, and has a clear set of collaborators. That is the natural unit of test. Not a class, not the whole system — the module. A module is also the thing you might one day extract into a microservice; test it like you'd test that microservice.

The demo has exactly three modules — `catalog`, `membership`, `lending`. Each one owns its repositories, its types, its facade. Each one has a single entry point via its barrel file, and that barrel exports only the facade class and the DTOs its signatures mention.

### Domain invariants live in the facade, not in a pipe

A knock-on question when you see how small the facade stays: *where does validation go?* Two honest options:

1. **Transport-level shape checks** (malformed JSON, wrong types) belong on the controller — `class-validator` decorators and a NestJS `ValidationPipe`. They catch bad HTTP requests before the facade runs.
2. **Domain invariants** (non-empty name, well-formed email, eligibility rules, duplicate-email) belong **inside the facade**, next to the state they guard.

The demo uses option 2 for anything the business cares about. Every facade guards its own invariants:

- `CatalogFacade.addBook` rejects blank title, zero authors, and malformed ISBNs (accepts ISBN-10 or ISBN-13, with or without hyphens).
- `CatalogFacade.registerCopy` rejects any `condition` outside `NEW | GOOD | FAIR | POOR`.
- `MembershipFacade.registerMember` rejects blank name, malformed email, and duplicate emails.

All are covered by fast facade tests (no `ValidationPipe`, no app boot). If the only enforcement were a controller-side pipe, another caller — a different controller, a CLI, another module — could skip the rule entirely. Putting it in the facade makes the rule true regardless of who calls in.

#### Keeping the facade readable — schemas per module

Inlining `if (!isValid) throw …` in the facade gets noisy fast. The demo separates *parsing the input* from *applying the business rule*, using a small **zod schema per module**:

```ts
// apps/library/src/catalog/catalog.schema.ts
export const NewBookSchema = z.object({
  title: z.string({ required_error: 'title is required' }).trim().min(1, 'title is required'),
  authors: z
    .array(z.string().trim())
    .transform((authors) => authors.filter((a) => a.length > 0))
    .refine((authors) => authors.length > 0, 'at least one author is required'),
  isbn: z
    .string({ required_error: 'isbn is required' })
    .trim()
    .min(1, 'isbn is required')
    .refine(isValidIsbn, (raw) => ({ message: `isbn format is invalid: ${raw}` })),
});

export function parseNewBook(input: unknown): z.infer<typeof NewBookSchema> {
  const result = NewBookSchema.safeParse(input);
  if (!result.success) {
    throw new InvalidBookError(result.error.issues[0]?.message ?? 'invalid input');
  }
  return result.data;
}
```

The facade becomes a single line of parsing plus the domain orchestration — nothing else:

```ts
// apps/library/src/catalog/catalog.facade.ts
async addBook(dto: NewBookDto): Promise<BookDto> {
  const { title, authors, isbn } = parseNewBook(dto);

  const existing = await this.repository.findBookByIsbn(isbn);
  if (existing) throw new DuplicateIsbnError(isbn);

  const book: BookDto = { bookId: this.newId(), title, authors, isbn };
  await this.repository.saveBook(book);
  return book;
}
```

Three things to notice about this split:

1. **Zod is an implementation detail, not a public contract.** The helper (`parseNewBook`) catches zod's error and re-throws `InvalidBookError` — the module's own domain error. Callers, tests, and other modules never see `ZodError`. If you later swap zod for Valibot, class-validator, or hand-written checks, nothing outside `catalog.schema.ts` changes.

2. **The schema lives *inside* the module.** It is not re-exported from `catalog/index.ts`, not shared across modules. Membership has its own. If two modules ever need the same schema, that is a signal the concept is a shared module — not a shared schema utility.

3. **Tests stay identical.** They assert on `InvalidBookError`, not on zod messages:

```ts
// apps/library/src/catalog/catalog.facade.spec.ts — unchanged by the refactor
it('rejects adding a book with a malformed isbn', async () => {
  const catalog = buildFacade();
  await expect(catalog.addBook(sampleNewBook({ isbn: 'not-an-isbn' }))).rejects.toThrow(
    InvalidBookError,
  );
});
```

### Why "Facade" and not "Service"?

The name is load-bearing. "Service" is ambiguous — a typical NestJS codebase grows many services per feature (`UserService`, `UserValidationService`, `UserQueryService`) and any of them can be injected anywhere. The name tells you nothing about what is an entry point and what is an internal helper.

"Facade" (in the [GoF sense](https://en.wikipedia.org/wiki/Facade_pattern)) names the role precisely: *the single simplified interface to a subsystem*. In this codebase that maps to a hard rule:

- **One facade per module.** `CatalogFacade` is **the** public API of Catalog — not *a* public API.
- **It is the only class re-exported from the barrel.** Repositories, in-memory implementations, Drizzle implementations, private helpers like `updateCopyStatus` — none of them leave the module.
- **Other modules depend on the facade type, never on internals.** `LendingFacade` holds a `CatalogFacade`, not a `CatalogRepository`.
- **Outsiders cannot reach internals** — the barrel file plus ESLint's `no-restricted-paths` enforce it structurally.

Rename it to `CatalogService` and that contract disappears into convention. Tomorrow someone adds a `CatalogQueryService`, imports a repository directly, and the module boundary starts to leak. It is the same reason Principle 7 is phrased "mock other modules' *facades*" rather than "mock other modules' services" — the name *is* the seam.

The public surface of the Catalog module is this file. Everything else is internal.

```ts
// apps/library/src/catalog/index.ts
export { CatalogFacade } from './catalog.facade.js';
export { CatalogModule } from './catalog.module.js';
export {
  BookNotFoundError,
  CopyNotFoundError,
  CopyStatus,
  DuplicateIsbnError,
  type BookDto,
  type BookId,
  type CopyCondition,
  type CopyDto,
  type CopyId,
  type Isbn,
  type NewBookDto,
  type NewCopyDto,
} from './catalog.types.js';
```

---

## Principle 4 — Module as black box, in milliseconds

![Road stretching into the distance](./.claude/screenshots/road.jpg)

Inside a module, test the facade. Every flow, every corner case, every error path — as fast as the JS engine can run. No I/O, no Docker, no containers booting. You save the I/O tests for the crucial happy path and a small set of scenarios that prove the real adapter works.

The Catalog facade has eleven tests covering happy paths, error cases, and idempotency — all through the public API, none touching a database. Adding a new scenario is three lines in a describe block; you do not think about test infrastructure.

Error-case tests run as fast as the happy paths because there is nothing slow to reach for:

```ts
// apps/library/src/catalog/catalog.facade.spec.ts
it('throws BookNotFoundError when finding an unknown isbn', async () => {
  const catalog = buildFacade();
  await expect(catalog.findBook('978-0000000000')).rejects.toThrow(BookNotFoundError);
});

it('throws CopyNotFoundError when marking an unknown copy available', async () => {
  const catalog = buildFacade();
  await expect(catalog.markCopyAvailable('unknown-copy-id')).rejects.toThrow(CopyNotFoundError);
});

it('rejects adding a book with an isbn that already exists', async () => {
  const catalog = buildFacade();
  await catalog.addBook(sampleNewBookWithIsbn('978-0134685991'));
  await expect(catalog.addBook(sampleNewBookWithIsbn('978-0134685991'))).rejects.toThrow(
    DuplicateIsbnError,
  );
});
```

---

## Principle 5 — In-memory implementations, not mocks

![Films — data that stays in memory](./.claude/screenshots/films1.png)

Give each module a real in-memory implementation of its repository interface. Unit tests use *that*, not a mock. Real logic runs against real state — just not persisted state. You keep mocks for boundaries outside the module's control.

**The in-memory repo** (real code from `apps/library/src/catalog/in-memory-catalog.repository.ts:4-36`):

```ts
export class InMemoryCatalogRepository implements CatalogRepository {
  private readonly booksById = new Map<BookId, BookDto>();
  private readonly copiesById = new Map<CopyId, CopyDto>();

  async saveBook(book: BookDto): Promise<void> {
    this.booksById.set(book.bookId, book);
  }

  async findBookByIsbn(isbn: Isbn): Promise<BookDto | undefined> {
    for (const book of this.booksById.values()) {
      if (book.isbn === isbn) return book;
    }
    return undefined;
  }
  // …saveCopy, findCopyById, listBooks
}
```

**What `vi.mock` would have looked like** (do not do this):

```ts
vi.mock('./catalog.repository.js', () => ({
  CatalogRepository: vi.fn().mockImplementation(() => ({
    saveBook: vi.fn().mockResolvedValue(undefined),
    findBookByIsbn: vi.fn().mockResolvedValue(undefined),
    findBookById: vi.fn().mockResolvedValue({ bookId: 'b1', isbn: '...' }),
    saveCopy: vi.fn().mockResolvedValue(undefined),
    findCopyById: vi.fn().mockResolvedValue(undefined),
    listBooks: vi.fn().mockResolvedValue([]),
  })),
}));
```

**Why the first is preferred:** the in-memory repo runs real logic against real state, so a test like "add a book then list it" actually proves the facade wires `saveBook` and `listBooks` correctly. The mocked version only proves that `vi.fn` was called — you have to script every return value, and the moment the facade changes shape the mocks silently disagree with reality. In-memory doubles turn state into a first-class test input; mocks turn it into a puppet show.

### Bonus — transactions across functions

Some operations mutate state across multiple repository calls inside a single module and must succeed or fail as a unit. In the demo, `returnLoan` does two things atomically within Lending: marks the loan returned, and — if a pending reservation exists — records its fulfillment. The `LoanReturned` and `ReservationFulfilled` events are staged with those writes so they only fire once the transaction commits. See `apps/library/src/lending/lending.facade.ts:58-75`.

The way we keep that unit-of-work testable without a database is a `TransactionalContext` abstraction. Repos accept it as a parameter and route writes through it. The in-memory implementation (`apps/library/src/lending/in-memory-transactional-context.ts:8-48`) stages writes into a scratch buffer and applies them only when `run()` resolves; on throw, the buffer is discarded and the `Map`-backed stores and event bus are untouched. The Drizzle implementation (`apps/library/src/lending/drizzle-transactional-context.ts:11-55`) threads a `tx` handle through a `db.transaction` block; Postgres handles commit and rollback. Same interface, same atomicity contract — the unit test survives the substrate swap.

This is scoped to **one module's own data**. The cross-module call `catalog.markCopyAvailable(...)` lives *outside* `tx.run(...)` — cross-module consistency is via happens-before ordering and events, never a shared transaction (see principle 7). That separation also avoids concurrent-connection deadlocks against the same pool; the tx reserves one connection for Lending's writes, and Catalog's write runs independently.

### In-memory doubles for outbound gateways

The "in-memory, not mocks" rule applies just as much to **outbound collaborators** — external APIs the module calls — as it does to the module's own repositories. An inbound port (a repository) and an outbound port (a gateway) are symmetric: both are interfaces, both get a real in-memory default, and neither gets mocked.

Request/response gateways: `IsbnLookupGateway`. Streaming gateways: `ChatGateway` — see Principle 13.

The canonical example is `IsbnLookupGateway` in `apps/library/src/shared/isbn-gateway/`. `CatalogFacade.addBook` calls it to enrich missing `title` / `authors` from an ISBN. The port (`isbn-lookup-gateway.ts`) is a one-method interface; `InMemoryIsbnLookupGateway` (`in-memory-isbn-lookup-gateway.ts`) is a `Map`-backed default with a `seed(isbn, metadata)` helper for tests. The Nest wiring registers the in-memory gateway as the production default — there is no real HTTP adapter yet, and when one arrives the port does not change.

Fault injection for an outbound gateway uses the same wrapper pattern as for own repositories. `ThrowingOnceIsbnLookupGateway` (spec-local inside `apps/library/src/catalog/catalog.facade.spec.ts` — not exported from any barrel) decorates the in-memory default, exposes `armFailureOnNextLookup(error)`, throws once on the next `findByIsbn`, then clears its slot. It mirrors `ThrowingOnceReservationRepository` (`apps/library/src/lending/lending.facade.spec.ts`) line-for-line; the only difference is that one fails an own-data write and the other fails an outbound read.

This is **different from Principle 7's hand-rolled fake of another module's facade**. A module facade is someone else's bounded context, already built and already tested — the hand-rolled fake is the narrow escape hatch when that facade's real factory cannot produce the moment you need to observe. A gateway is infrastructure: a thin port to an external API, owned by no module, always collaborated with through its in-memory default.

Why this beats mocks: deterministic fault injection (the error is exactly the instance you armed), the real interface contract is exercised (the wrapper `implements IsbnLookupGateway`, so the compiler breaks if the port drifts), and there is no test double that silently diverges from reality — the "real" shape of the gateway IS the in-memory one.

### Substrate alternative: PGlite

The in-memory double is the first contract check on a repository. The Drizzle-over-Postgres pair under testcontainers is the second. **PGlite is a third** — not a replacement for either.

PGlite is WASM Postgres — the real Postgres query engine compiled to WebAssembly, running in-process inside Node. No Docker, no container, no network. You `new PGlite()`, walk your real migrations, hand the instance to Drizzle, and the repository class that ships to production runs against it.

Why it earns a slot the in-memory double cannot fill: it exercises the real SQL. A `Map`-backed `InMemoryCategoryRepository` cannot observe that `ILIKE 'a%'` is case-insensitive, that a `UNIQUE` constraint on `name` raises on duplicate insert, or that `ORDER BY name ASC` uses Postgres collation. PGlite makes all three real — at unit-test speed, on any machine.

The canonical example is the Categories module:

- Module under test: `apps/library/src/categories/`
- PGlite spec: `apps/library/test/categories.pglite.spec.ts` — hits `new DrizzleCategoryRepository(db)` directly, no Nest bootstrap.
- Harness: `apps/library/test/support/pglite.ts` — `startPglite()` walks `src/db/migrations/*.sql` in sorted order and returns `{ db, close }`.

Run it: `pnpm test:pglite` from the repo root (alias for `pnpm --filter library test:pglite`).

**Prefer PGlite when:** fast feedback without Docker, portable CI where a container runtime isn't reliably available, exercising vanilla-Postgres DDL/DML and contract details (`ILIKE`, `UNIQUE`, collation) at unit-test speed.

**Testcontainers still wins when:** you need a specific Postgres version or extensions, you need a real network endpoint (connection pooling, multiple clients), you need replication or logical decoding, or you're exercising `postgres-js`-specific surface PGlite doesn't emulate. Every other module in this repo keeps its crucial-path testcontainers spec untouched — PGlite is additive, not subtractive.

One honest caveat worth pinning: the contract holds across substrates (case-insensitive match, ASC sort, 100-row cap), but the *exact row order* for case-mixed strings is substrate-specific — that's collation, not a bug. Write assertions against the contract, not against ordering that only one backend produces.

---

## Principle 6 — Don't let I/O escape the module

![A car-sharing diagram — modules with clear seams](./.claude/screenshots/carsharing.png)

If your facade accepts a repository as a method parameter, every consumer will inject a mock and start asserting on repository calls. The test suite drifts back to implementation-level. The fix: expose a factory that wires the facade with its own in-memory defaults and accepts overrides only for injected *collaborators from other modules*.

In the demo, `createCatalogFacade()` is the factory. Its only overrides are a seed for deterministic ids and (in Lending) other modules' facades and the event bus. The repository is never in the signature — callers cannot reach it.

The factory function:

```ts
// apps/library/src/catalog/catalog.configuration.ts
export interface CatalogOverrides {
  repository?: CatalogRepository;
  newId?: () => string;
  isbnLookupGateway?: IsbnLookupGateway;
}

export function createCatalogFacade(overrides: CatalogOverrides = {}): CatalogFacade {
  const repository = overrides.repository ?? new InMemoryCatalogRepository();
  const newId = overrides.newId ?? randomUUID;
  const isbnLookupGateway = overrides.isbnLookupGateway ?? new InMemoryIsbnLookupGateway();
  return new CatalogFacade(repository, newId, isbnLookupGateway);
}
```

The override shape grows by one slot whenever a new collaborator arrives — `repository` for own data, `newId` for determinism, `isbnLookupGateway` for the outbound ISBN port added in the ISBN-enrichment slice. Each override keeps the same rule: callers override only what they need; everything else gets the in-memory default.

The test takes no repository argument; it could not reach for one even if it wanted to:

```ts
// apps/library/src/catalog/catalog.facade.spec.ts
function buildFacade() {
  return createCatalogFacade({ newId: sequentialIds() });
}
```

---

## Principle 7 — Module boundaries: use other modules' facades, never their internals

![One module, its dependencies explicit](./.claude/screenshots/ArticleModuleDependencies.png)

When module A depends on module B, A's unit tests interact with B *only through B's facade* — never B's internals, never A's own repository. That rule is what the principle protects. Mocking your own repo just lets you assert on implementation details; reaching into B's internals couples A's tests to B's structure.

The talk's original phrasing is "mock other modules' facades." In the TypeScript port, the idea lands as a tradeoff between two tools — both are in the toolbox, and the choice is about what the test needs to observe:

- **Default: use the other module's real facade via its `createXFacade()` factory. Zero I/O, less code.**
- **Escape hatch: hand-roll a fake facade when the real factory-wired implementation cannot produce the behavior you need to observe — most commonly, a specific failure at a specific moment.**

The rest of this principle walks both paths with concrete examples. Neither is "more correct"; the question is which one fits the behaviour the test is pinning down.

### (a) The default — real facade via factory

Lending depends on `CatalogFacade` and `MembershipFacade`. Its tests wire the *real* facades, produced by the same factories that Principle 6 introduced:

```ts
// apps/library/src/lending/lending.facade.spec.ts
import { createCatalogFacade } from '../catalog/catalog.configuration.js';
import { createMembershipFacade } from '../membership/membership.configuration.js';

function buildSceneWith(extra: Partial<LendingOverrides>): Scene {
  const catalog = createCatalogFacade({ newId: sequentialIds('cat') });
  const membership = createMembershipFacade({ newId: sequentialIds('mem') });
  const bus = new InMemoryEventBus();
  const facade = createLendingFacade({
    catalogFacade: catalog,        // real CatalogFacade, in-memory repo behind it
    membershipFacade: membership,  // real MembershipFacade, ditto
    eventBus: bus,
    newId: sequentialIds('loan'),
    clock: fixedClock,
    ...extra,
  });
  // …seedAvailableCopy() calls the real catalog.addBook + catalog.registerCopy
  // …seedMember() calls the real membership.registerMember
}
```

The ineligibility test reads like production: register a member, suspend them, try to borrow:

```ts
// apps/library/src/lending/lending.facade.spec.ts
it('rejects with MemberIneligibleError when the member is suspended, touching nothing', async () => {
  // given a suspended member and an available copy
  const copy = await scene.seedAvailableCopy();
  const alice = await scene.seedMember('Alice');
  await scene.membership.suspend(alice.memberId);

  // when the member tries to borrow
  await expect(scene.facade.borrow(alice.memberId, copy.copyId)).rejects.toBeInstanceOf(
    MemberIneligibleError,
  );

  // then no loan was recorded, no event emitted, and the copy is still available
  expect(await scene.facade.listLoansFor(alice.memberId)).toEqual([]);
  expect(scene.bus.collected()).toEqual([]);
  expect((await scene.catalog.findCopy(copy.copyId)).status).toBe(CopyStatus.AVAILABLE);
});
```

**When to prefer real-via-factory (the default):**

- The other module already ships a zero-I/O `createXFacade()` factory. Using it is strictly less code than hand-rolling a fake.
- You want the cross-module behaviour to *actually run* — a scripted fake proves only what you scripted; the real facade proves the contract.
- The scenario can be reached by ordinary seeding — register a member, suspend them, list books, borrow. If the state you care about is something the real facade produces naturally, use the real facade.

**Why this is Principle 7 in spirit, not a deviation:**

- Lending still only touches Catalog and Membership *through their public facades*. It never imports a `CatalogRepository`, never pokes at `member.status`.
- `LoanRepository` and `ReservationRepository` — Lending's OWN data — stay behind Lending's facade. The principle still forbids Lending's tests from reaching into them.
- The test still proves the behavioural contract across the seam ("ineligible member → no loan, no event") — it just uses real Membership behaviour rather than a scripted fake.

### (b) When a hand-rolled fake is justified — the escape hatch

Hand-roll a fake facade when the real factory-wired implementation cannot produce the behavior you need to observe. Concretely:

1. **Inducing specific failure timing** — you need the other module to throw on the *first* call of a batch, or to succeed N times and fail on the Nth+1. A well-behaved in-memory implementation will not throw spontaneously.
2. **Forcing mid-operation exceptions** — "what if `Membership.suspend` throws mid-batch after some fines were already recorded?" The real in-memory facade is too well-behaved to reproduce that.
3. **Simulating a collaborator that doesn't exist yet** — when you're working in parallel with another team and the dependency is stubbed on the other side, a hand-rolled fake pins down the shape of the contract you depend on.
4. **Forcing a behavior the real implementation refuses to produce** — e.g., a repository returning malformed data, to exercise defensive code.

The canonical justified example lives in the Fines module's unit spec. Fines' `processOverdueLoans(now)` walks overdue loans, writes fines, and calls `MembershipFacade.suspend` for any member over the threshold. The teaching scenario is *"what happens if `suspend` throws mid-batch?"* — a contract the real factory-wired Membership cannot produce without corrupting the rest of the scene.

```ts
// apps/library/src/fines/fines.facade.spec.ts — the single hand-rolled-fake test
class ThrowingOnceMembershipFacade extends MembershipFacade {
  suspendCallCount = 0;
  // …wraps a real MembershipFacade (built via createMembershipFacade),
  // delegates every method, and throws a deterministic error on the first
  // call to `suspend` only.
}

describe('when Membership.suspend throws mid-batch (hand-rolled fake)', () => {
  it('persists the first member fine, emits FineAssessed, does NOT emit MemberAutoSuspended, and halts before the second member', async () => {
    // …see the spec file for the full scenario
  });
});
```

Every other test in `fines.facade.spec.ts` uses real `createCatalogFacade()` + `createMembershipFacade()` + `createLendingFacade()`. The hand-rolled fake is the **one exception** — scoped tightly to the one behaviour the real facade cannot produce, with a prose comment block at the point of use explaining why.

A second justified hand-roll exists in `apps/library/src/lending/lending.reservations.spec.ts`, where the reservation-queue DSL wants a monotonically advancing clock producing stable queue ordering without registering real books and members. The cost of real-via-factory would bury the requirement under scene setup. The hand-rolled `fakeCatalogFacade()` / `alwaysEligibleMembership()` keep the DSL itself readable — the point the test is trying to make.

### (c) When a hand-rolled fake is NOT justified

These are the failure modes — if you find yourself reaching for a hand-rolled fake for one of these reasons, switch to the real factory:

1. **Convenience** — "it's easier to write a small fake than to read how Catalog's factory works." Read the factory once. It will be shorter than your fake.
2. **Avoiding repository setup** — Catalog's in-memory repo is a `Map`. Membership's is a `Map`. There is no setup cost to avoid.
3. **Dodging sample-data builders** — `sampleNewBook({ isbn: '…' })` is one line. A hand-rolled Catalog fake with a fake `findBook` method is many more.
4. **Mocking call counts** — if the assertion is "`findBook` was called 3 times," the test has drifted from behaviour to implementation. Assert on observable outcome — the DTO that came back, the event that was emitted, the state visible through the facade.

### Lending's own repos stay in-memory, hand-armable

Separate from the cross-module question: one hand-rolled double *does* stay on Lending's own side — `ThrowingOnceReservationRepository`. But that is Lending's OWN reservation repo, not a cross-module fake — it exists only to force a mid-transaction failure and prove the atomicity contract. Principle 5 (in-memory doubles for your own data) with a tiny bit of failure injection. Same escape-hatch shape as the cross-module hand-roll, applied to your own data.

---

## Principle 8 — Keep information to minimum

![Antoine de Saint-Exupéry on perfection](./.claude/screenshots/snow.jpg)

Every line in a test should earn its place. If you can delete a field and the test still proves the same requirement, delete it. What is explicit is crucial; what is implicit is defaulted. Readers learn what matters by what you bothered to write.

The sample-data helpers default everything a requirement does not care about. A borrow test that only cares about member id and copy id says exactly that — the builder fills in title, authors, condition, dueDate calculation.

Three small helpers, each following `sample…({overrides})`:

```ts
// apps/library/src/catalog/sample-catalog-data.ts
export function sampleNewBook(overrides: Partial<NewBookDto> = {}): NewBookDto {
  return {
    title: 'The Pragmatic Programmer',
    authors: ['Andrew Hunt', 'David Thomas'],
    isbn: '978-0135957059',
    ...overrides,
  };
}

export function sampleNewCopy(overrides: Partial<NewCopyDto> = {}): NewCopyDto {
  return {
    bookId: 'book-placeholder-id',
    condition: 'GOOD' satisfies CopyCondition,
    ...overrides,
  };
}
```

The add-and-find test mentions only the one field it cares about:

```ts
// apps/library/src/catalog/catalog.facade.spec.ts
it('adds a book and finds it by isbn', async () => {
  const catalog = buildFacade();
  const added = await catalog.addBook(sampleNewBook({ isbn: '978-0134685991' }));
  expect(await catalog.findBook('978-0134685991')).toEqual(added);
});
```

---

## Principle 9 — Sample data builders per module

![Films — sample data composed from defaults](./.claude/screenshots/films1.png)

Each module ships its own sample-data helpers — `sampleNewBook`, `sampleNewCopy`, `sampleNewMember`, `sampleBorrowRequest` — with sensible defaults and an `overrides` parameter. Exploratory tests become one line. Setup explosion does not happen, because you never write setup.

Builders live next to the module, not in a shared test folder. The moment two modules need the same builder, you have a shared domain concept you should extract into a module — not a shared test helper.

The canonical shape lives next to the Catalog module (see Principle 8). Lending follows the same pattern for its own requests:

```ts
// apps/library/src/lending/sample-lending-data.ts
export function sampleBorrowRequest(overrides: Partial<BorrowRequest> = {}): BorrowRequest {
  return {
    memberId: 'member-placeholder-id',
    copyId: 'copy-placeholder-id',
    ...overrides,
  };
}

export function sampleReserveRequest(overrides: Partial<ReserveRequest> = {}): ReserveRequest {
  return {
    memberId: 'member-placeholder-id',
    bookId: 'book-placeholder-id',
    ...overrides,
  };
}
```

---

## Principle 10 — Common interactions for integration

![Cables — hide the wiring](./.claude/screenshots/cables.jpeg)

Integration tests deal with HTTP. Left raw, every test has to re-decide method, path, encoding, and serialization — and when a route changes, every test changes with it. Hide that behind small helpers named in the domain's voice.

The integration suite never writes `request(app).post('/books').send(dto)` inline. It calls `postNewBook(app, dto)`. The helper owns the HTTP mechanics; the test owns the domain statement.

Six helpers cover every HTTP call the Catalog integration test makes. Lending and Membership ship parallel files.

```ts
// apps/library/test/support/interactions/catalog-interactions.ts
export function postNewBook(app: INestApplication, dto: NewBookDto): HttpCall {
  return server(app).post('/books').send(dto);
}

export function getBook(app: INestApplication, isbn: string): HttpCall {
  return server(app).get(`/books/${encodeURIComponent(isbn)}`);
}

export function registerCopy(
  app: INestApplication,
  bookId: string,
  dto: NewCopyDto,
): HttpCall {
  return server(app).post(`/books/${bookId}/copies`).send(dto);
}

export function markCopyAvailable(app: INestApplication, copyId: string): HttpCall {
  return server(app).patch(`/copies/${copyId}/available`);
}

export function markCopyUnavailable(app: INestApplication, copyId: string): HttpCall {
  return server(app).patch(`/copies/${copyId}/unavailable`);
}
```

---

## Controller unit specs — when they earn their keep

Three of the four modules (Catalog, Membership, Lending) have no dedicated controller spec. Fines has one (`apps/library/src/fines/fines.controller.spec.ts`). The asymmetry is deliberate and worth naming — the rule is about **setup cost** and **what is being specified**, not "always write one" or "never write one."

**Default: skip it.** Routing, status codes, and serialization are covered by the crucial-path integration test (`apps/library/test/<module>.crucial-path.integration.spec.ts`). When the module's integration setup is cheap — a book, a member, a copy — a separate controller spec just duplicates coverage.

**Write one when the following three conditions hold together:**

1. **Setup for the integration test is disproportionate.** Fines' integration test needs the whole borrow graph (Catalog + Membership + Lending overdue loan) to produce even one fine. Spinning that up to assert "POST `/fines/batch/process` returns 204" is wasteful.
2. **The slice has multiple HTTP-shape acceptance criteria.** Fines' Slice 6 lists AC-6.1 through AC-6.7 — status codes, error-filter mapping (`FineNotFoundError → 404`, `FineAlreadyPaidError → 409`), server-side `Date` construction, `Date → ISO` serialization. Each is a crisp one-liner when asserted in isolation and a smear of setup when rolled into an integration test.
3. **You need precise control over what the facade returns or throws.** Proving "a second `payFine` call surfaces `FineAlreadyPaidError` as 409" (`fines.controller.spec.ts:249-279`) requires the facade to throw on cue. Real factory-wired facades cannot produce that on a specific call without state choreography.

**What the controller spec specifies — and what it does NOT.**

The controller is an adapter; the facade is the domain port. They have different contracts and different collaborators. The controller spec asserts on:

- URL + method + path params + status code
- JSON shape of the response body (including `Date → ISO` serialization)
- Which facade method received which arguments, and that any `now` is server-constructed
- `DomainErrorFilter` mapping (typed error → HTTP status)

It says nothing about domain math, event emission, or repository state — those live in `fines.facade.spec.ts`.

**The one Principle-7 exception this pattern licenses — and the harness that makes it ergonomic.**

The controller spec uses a **recording fake of its own facade** (`FakeFacade` at `fines.controller.spec.ts:29-75`) and asserts on call args. Elsewhere in the codebase this would be a violation — you do not mock your own collaborators. Here it is the right tool because the test is *literally about the adapter seam*. The facade's own behavior is exhaustively covered by `fines.facade.spec.ts` against real factory-wired Catalog + Membership + Lending; repeating any of that here would be duplication.

The recording fake only pays off because it is paired with a **harness** — `buildHarness(responders)` at `fines.controller.spec.ts:77-91` wires the Nest testing module, installs `DomainErrorFilter`, initializes the app, and returns `{ app, calls, facade }`. Each `it()` block then declares only the facade responses that matter for that test — for example `buildHarness({ payFine: async () => { throw new FineAlreadyPaidError('fine-9'); } })` — and the harness swallows the rest of the wiring. Without the harness, every test would repeat the Nest bootstrap and manual call-recording plumbing; with it, each test reads as "given this facade behaviour, when I hit this endpoint, then this status + body."

Keep the recording-fake surface *minimal* — only the methods the controller calls. The test asserts on call args that matter (the `Date` argument, the path param) rather than on call counts as a correctness proxy. And keep the harness spec-local — it is not exported — because the adapter's wiring (filters, pipes, guards) varies per module.

**Rule of thumb:**

| Module shape | What to write |
|---|---|
| Cheap integration setup (one book + one member) | Crucial-path integration test only |
| Expensive integration setup (whole graph) **and** adapter-level ACs (error-filter, serialization, `now` construction) | Crucial-path integration test **plus** controller unit spec |
| Adapter has no branching logic (one method, one status, no error filter) | Integration test only — a controller spec buys nothing |

`GUIDE.md` does not need a seventh line-format for controllers; apply the same discipline as every other test — one file per contract, assertions at the right level of abstraction.

---

## Principle 11 — Show, don't tell (DSL)

![A row of similar things — a queue](./.claude/screenshots/rower.jpeg)

If you would draw the domain state on a whiteboard, let the test look like the drawing. Build a tiny DSL per test file or per domain concept. The test stops poking at internal fields and starts stating the requirement.

The reservation queue in Lending is naturally list-shaped: `alice, bob, carol` wait for a book, the earliest-queued is fulfilled when someone returns. The test reads like that:

```ts
// apps/library/src/lending/lending.reservations.spec.ts:137-149
await dsl.after('alice').reserves(book);
await dsl.after('bob').reserves(book);
await dsl.after('carol').reserves(book);

expect(await dsl.queueFor(book)).toEqual(['alice', 'bob', 'carol']);
```

`after`, `reserves`, `queueFor`, and `whenReturned` are a four-verb DSL defined in `apps/library/src/lending/testing/reservation-dsl.ts:16-33`. Two tests use it (`apps/library/src/lending/lending.reservations.spec.ts:137-168`); the rule of three says wait before extracting more helpers.

---

## Test scaffolding — builder, scene, DSL, harness — and when to use which

Principle 9 names sample-data builders; Principle 11 names DSLs. The demo leans on two more named patterns — **scene** and **harness** — that were not called out until now. Together they cover the four shapes of test setup this codebase uses.

**Sample-data builder** — per-DTO defaults. `sampleNewBook({ isbn })` fills every field the test does not care about. Lives in `<module>/sample-<name>-data.ts`. See Principle 9.

**Scene** — a function that wires a whole domain test world: real facade(s) via their factories, an in-memory event bus, a repository handle, a shared clock, and named seed helpers. Returns a **domain-shaped** object the test reaches into directly. Canonical example: `apps/library/src/fines/testing/scene.ts` — `buildScene()` returns `{ fines, catalog, membership, lending, bus, seedMember, seedOverdueLoanFor, … }`. A more modest inline variant lives as `buildScene()` / `buildSceneWith()` at the top of `apps/library/src/lending/lending.facade.spec.ts`.

**DSL** — a fluent wrapper over one or more facades whose verbs read like the requirement. `after(alice).reserves(book)`, `queueFor(book)`. Lives in `<module>/testing/<concept>-dsl.ts`. See Principle 11.

**Harness** — a function that wires an adapter test world: a Nest testing module, a recording fake of the facade, a domain-error filter, and an initialized `INestApplication`. Returns an **infrastructure-shaped** object — typically `{ app, calls, facade }`. Canonical example: `buildHarness(responders)` at `apps/library/src/fines/fines.controller.spec.ts:77-91`. Scenes are for facade specs; harnesses are for controller specs.

The scene / harness split is the key distinction — same underlying idea (one function that builds your test world), but one holds domain collaborators and the other holds HTTP infrastructure. They never mix.

Decision rule — pick by test shape, not by taste:

| Test shape | Pattern |
|---|---|
| Need a DTO with most fields defaulted | **Sample-data builder** |
| One actor, one facade call, inspect DTOs + events + repo | **Scene + named seed helpers** |
| Multiple actors, ordered steps, queue- or tree-shaped assertions | **DSL** (usually layered on top of a scene) |
| Provoke a specific failure at a specific moment | **Narrow fault-injection wrapper** on top of a scene (Principle 7 escape hatch) |
| HTTP routing, status codes, serialization, error-filter mapping | **Harness + recording fake facade** (see "Controller unit specs" above) |

These patterns *compose*. The reservation DSL takes a scene (`ReservationScene` at `reservation-dsl.ts:11-14`) and wraps it. The atomicity tests take the Lending scene and drop in a `ThrowingOnceReservationRepository` (`lending.facade.spec.ts:356-384`). The Fines controller harness layers a recording fake inside `Test.createTestingModule` so each `it()` block declares only the facade responses that matter (`fines.controller.spec.ts:119`, `164`, `186`, `205-209`, `231`, `251-263`). Start with a sample-data builder; promote to a scene when the same domain wiring repeats across tests; promote to a DSL only when the *sequence of actions* is what the test is about and direct facade calls obscure it; reach for a harness only when you are testing the HTTP adapter.

Four nudges:

- **Do not introduce a DSL for CRUD-shaped tests.** Catalog and Membership are flat create/update/query — a DSL buys nothing.
- **Scenes stay module-local.** `fines/testing/scene.ts` lives inside Fines. If a second module needs the same scene, that is a signal to extract a shared module — not a shared test folder.
- **Harnesses stay spec-local.** The `buildHarness` in `fines.controller.spec.ts` is not exported. Each controller spec owns its harness because the adapter's wiring (filters, pipes, guards) varies per module.
- **Name the wrapper after what it holds, not how it is built.** `ReservationScene`, not `TestContext`. `Harness`, not `SetupResult`.

---

## Principle 12 — Repository queries across tables — how do we test in memory?

A query that spans two tables is still a query — and the in-memory answer has to agree with the SQL answer on the same data. Two shapes cover every case the demo runs into. The module boundary is what decides which one applies.

### Within-module JOIN

Lending owns `loans` and `reservations`. Counting the pending reservation queue for each active loan is a single JOIN over two tables Lending owns. The Drizzle implementation reads exactly as the SQL does — `LEFT JOIN` on `bookId` with the pending predicate in the `ON` clause, `GROUP BY loans.loanId`, `count(reservations.reservationId)` to count only the non-null matches (see `apps/library/src/lending/drizzle-loan.repository.ts:45-56`):

```ts
const rows = await this.db
  .select({ loan: loans, queuedCount: count(reservations.reservationId) })
  .from(loans)
  .leftJoin(
    reservations,
    and(eq(reservations.bookId, loans.bookId), isNull(reservations.fulfilledAt)),
  )
  .where(isNull(loans.returnedAt))
  .groupBy(loans.loanId);
```

The in-memory pair expresses the same collaboration, just narrower. A tiny file-private port — `ReservationView` with a single `pendingReservationCountForBook(bookId)` method — lets `InMemoryLoanRepository` ask the reservation side for what it needs without importing its repo type (`apps/library/src/lending/in-memory-loan.repository.ts:7-54`):

```ts
interface ReservationView {
  pendingReservationCountForBook(bookId: BookId): Promise<number>;
}

async listActiveLoansWithQueuedReservations(): Promise<ActiveLoanWithQueuedCount[]> {
  const active = this.listLoansSync().filter((loan) => loan.returnedAt == null);
  return Promise.all(
    active.map(async (loan) => ({
      loan,
      queuedCount: await this.reservationView.pendingReservationCountForBook(loan.bookId),
    })),
  );
}
```

`lending.configuration.ts` adapts the in-memory reservation repo into that view and threads it in. The default is a no-op returning `0`, so overrides that pass only a loan repo still work. This is Principle 5 applied at the seam between two repositories: the in-memory double runs real logic against real state — just in-process — and the same facade acceptance tests pin down both backends.

### Across module boundaries — no JOIN

Overdue loans with titles and authors spans two modules — Lending owns loans, Catalog owns books. A JOIN is not on the table. The rule is explicit: **no cross-module JOINs.** A repository query MUST NOT JOIN tables owned by a different module; cross-module reads go through the other module's facade, with a batch method when N+1 would bite.

Catalog exposes a batch read — one line in the facade that guards the empty case and delegates (`apps/library/src/catalog/catalog.facade.ts:71-74`):

```ts
async getBooks(bookIds: BookId[]): Promise<BookDto[]> {
  if (bookIds.length === 0) return [];
  return this.repository.listBooksByIds(bookIds);
}
```

Lending composes. It calls its own overdue query, deduplicates the `bookId`s inline (mirroring `distinctMemberIds` in `fines.facade.ts:159-161`), asks Catalog once for all of them, builds a local `Map`, and merges (`apps/library/src/lending/lending.facade.ts:114-125`):

```ts
async listOverdueLoansWithTitles(now: Date): Promise<OverdueLoanReport[]> {
  const overdue = await this.listOverdueLoans(now);
  if (overdue.length === 0) return [];
  const bookIds = Array.from(new Set(overdue.map((loan) => loan.bookId)));
  const books = await this.catalog.getBooks(bookIds);
  const byId = new Map(books.map((book) => [book.bookId, book]));
  return overdue.map((loan) => {
    const book = byId.get(loan.bookId);
    if (!book) throw new BookNotFoundError(loan.bookId);
    return { loan, title: book.title, authors: book.authors };
  });
}
```

Two tables, two modules, zero SQL JOIN. This is Principle 7 with the JOIN-specific rule attached: the facade is the seam, cross-module consistency is composition, never a shared schema. Each side stays testable with its own in-memory fake — Catalog's `Map<BookId, BookDto>` answers `getBooks` the same way Postgres does, and Lending's test wires a real `CatalogFacade` via `buildScene()` rather than a JOIN-aware fake.

A JOIN is fine inside a module; across modules, compose through the facade.

---

## Principle 13 — Streaming gateways: how do we test a streaming port in-memory?

A streaming outbound gateway is still a port. The in-memory default is still a class. Fault injection is still a tiny wrapper declared next to the tests that use it. The only new wrinkle is that "the error" has a wire-format representation, because SSE commits a `200 OK` before any content is sent — so an upstream failure cannot be an HTTP status, it has to be a terminal frame inside the stream.

### The port

The chat module's outbound seam is `ChatGateway` in `apps/library/src/shared/chat-gateway/chat-gateway.ts:9-11`:

```ts
export interface ChatGateway {
  stream(messages: ChatMessage[]): AsyncIterable<ChatDelta>;
}
```

`AsyncIterable<ChatDelta>` is the streaming analog of a plain return value. Where `IsbnLookupGateway.findByIsbn` returns a `Promise<BookMetadata | null>` — one request, one response — `ChatGateway.stream` returns a sequence of deltas over time. No rxjs in the port; rxjs appears only at the `@Sse()` controller boundary. The shape `async *stream(messages) { yield …; }` is a plain generator — no stream library required.

### The in-memory default

`InMemoryChatGateway` at `apps/library/src/shared/chat-gateway/in-memory-chat-gateway.ts:19-38` is the shipped default. Seeding is `reply(userContent, deltas)` — script a response for a given last-user-message `content`. Keys are normalized by trimming only (no lowercasing); tests needing case-insensitive match seed multiple keys. Unseeded prompts yield a single innocuous `{ text: '…' }` default delta then complete — the adapter never throws on unseeded input, so low-seeding happy-path tests stay terse while content-sensitive tests still fail on delta comparisons.

The `Map<string, ChatDelta[]>` backing store answers `stream()` the same way a real OpenAI response would: one `ChatDelta` per iteration, then the iterator completes. Same interface as the real adapter — the "real" shape of the gateway IS the in-memory one.

### Fault injection — `ThrowingOnceChatGateway`

`ThrowingOnceChatGateway` lives spec-local inside `apps/library/src/chat/chat.facade.spec.ts:241-272`, not exported from any barrel. It decorates any `ChatGateway`, exposes `armFailureBeforeStream(error)` and `armFailureMidStream(error)`, throws once when armed, and clears its slot after firing. Mirrors `ThrowingOnceIsbnLookupGateway` (`catalog.facade.spec.ts:556-573`) line-for-line — the only difference is that one fails a request/response lookup and the other fails a streaming pull.

Why spec-local: the wrapper exists to prove one behavior that the real in-memory gateway cannot produce — a deterministic fault at a specific moment in the stream. It is test infrastructure, not a module surface. If a second test file ever needs it, extract it then. Until then, it sits at the bottom of the one spec that uses it, under a comment block that names the teaching moment.

### The wire contract

SSE commits `200 OK` to the wire before the first delta flushes. By the time an upstream `ChatGateway.stream()` throws, the HTTP status is already sent — it cannot become a 500. The error has to surface as a terminal frame inside the stream.

`ChatFacade.streamFrames` shapes that frame before Nest sees it (`apps/library/src/chat/chat.facade.ts:16-27`):

```ts
private async *streamFrames(messages: ChatMessage[]): AsyncIterable<ChatFrame> {
  try {
    for await (const delta of this.gateway.stream(messages)) {
      yield { type: 'delta', text: delta.text };
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    yield { type: 'error', message };
    return;
  }
  yield { type: 'done' };
}
```

Two things to notice:

1. **`yield { type: 'done' }` is OUTSIDE the `try`.** A `return` after the error frame ensures no `done` frame follows. An error and a done are mutually exclusive terminal states — never both.
2. **The facade never re-throws.** When the gateway throws, the Observable that Nest sees still completes normally. Nest ends the response cleanly, and the client sees the terminal `event: error` frame it needs to react to.

The crucial-path integration test at `apps/library/test/chat.crucial-path.integration.spec.ts` pins the wire contract: `event: delta` frames, then `event: error\ndata: {"message":"…"}\n\n`, no trailing `event: done`, HTTP status still 200.

### The rule

A streaming port is still an interface. An in-memory adapter is still a class. Fault injection is still a tiny wrapper. The only new wrinkle is that "the error" has a wire-format representation — because SSE commits a 200 before content, the terminal frame IS the error signal. Pin that contract in one test, shape the frame in the facade, and the rest of the pattern reads exactly like Principle 5.

---

## Ports & gaps — where the TypeScript port diverges from Groovy/Spring

The talk is Java and Spock. Some of Jakub's examples rely on language features that do not exist in TypeScript; the port uses the closest honest equivalent and calls out the gap.

- **No operator overloading.** Jakub uses `B >> F` to express "move B under F" in a tree-DSL. TypeScript cannot overload operators. The demo uses method chains (`dsl.after(alice).reserves(book)`) and fluent builders instead.
- **No Spock `given:/when:/then:` labels.** Spock makes three-phase tests a language feature. The demo uses plain comments (`// given…`, `// when…`, `// then…`) inside each `it()` block. Readable, not structural.
- **No `@Autowired` test wiring.** Spring's test runner assembles collaborators out of the container. The demo uses plain factory functions (`createCatalogFacade({ overrides })`) — no `Test.createTestingModule`, no decorators in the test file. The facade class is `@Injectable()` so production wiring still works; tests sidestep the container entirely.
- **No Java package-private visibility.** In Java, module-internal classes are naturally invisible to callers outside the package. TypeScript has no equivalent. The demo enforces the boundary with a barrel file (`index.ts`) that re-exports only the facade and DTOs, plus an ESLint `no-restricted-paths` rule that rejects imports reaching into a module's internals.

---

## Summary

Jakub's own summary from slide 61:

> Focus on testing modules. Test the behaviour, not implementation. Prepare sample test data. Hide API for integration under meaningful methods. Build a small DSL. Extract code that slows integration tests into self-tested jars. Tests == specifications == requirements.
