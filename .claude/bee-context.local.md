# Context: Improving TDD Demo (NestJS + Drizzle)

## Source Material

- **Video:** "Improving your Test Driven Development in 45 minutes" by Jakub Nabrdalik
- **URL:** https://www.youtube.com/watch?v=2vEoL3Irgiw
- **Slides:** https://jakubn.gitlab.io/improvingtdd/ (fetched locally at `.claude/tdd-slides.md`)
- **Screenshots:** `.claude/screenshots/` (road, rower, classDiagram2, sloth, carsharing, single_module, films1, ArticleModuleDependencies, etc.)
- **Reference repo:** https://github.com/jakubnabrdalik/hentai (Hexagonal architecture with high cohesion modularization, CQRS, fast BDD tests — in Java/Spock; we port principles to NestJS)

## Video's Core Thesis

Most TDD failures come from **testing at the wrong level**. Testing classes/methods → brittle; testing the whole system → slow. The right level is **the module** (bounded context).

## The Eleven Principles (to demonstrate + teach)

1. **Don't test too low.** Class/method tests break on every refactor; 100% coverage ≠ working system.
2. **Don't test too high.** Full-system tests are slow (whole suite = 45 min). Keep them only for crucial paths.
3. **Test your modules.** A module = encapsulates its data (access only via API), clear collaborators, almost all layers (vertical slice), likely a bounded context, microservice candidate.
4. **Module as black box.** All flows + corner cases run in milliseconds with **no I/O**. Add crucial paths with I/O only for integration tests.
5. **In-memory implementations, not mocks.** Provide real `InMemory<Thing>Repository` so unit tests exercise real logic. Avoid mocks for own collaborators.
6. **Do not let I/O escape the module.** Don't expose a method that accepts a repository — developers will inject mocks and test internal state. Expose only the facade factory that wires its own in-memory deps.
7. **Module boundaries.** Mock **other modules' facades** (not own internals). This forces behavior-testing across modules.
8. **Keep information to minimum.** Explicit = crucial to understand the requirement. Implicit = can be taken for granted. Every line: "is this crucial?"
9. **Sample data builders per module.** `sampleNewX({override: 'value'})` pattern. Prevents setup explosion; makes exploratory tests trivial.
10. **Common interactions for integration.** Hide HTTP mechanics behind meaningful helpers (`postNewArticle`, `publish(id)`). Don't make developers re-think endpoint/method/payload/serialization each time.
11. **Show, don't tell (DSL).** Whiteboard approach. If you'd draw a tree, make the test declare a tree. Build a small DSL. Operator overloading, factory methods, whatever keeps the test at the requirement-level of abstraction.

### Summary quote (slide 61)
> Focus on testing modules. Test the behaviour, not implementation. Prepare sample test data. Hide API for integration under meaningful methods. Build a small DSL. Extract code that slows integration tests into self-tested jars. Tests == specifications == requirements.

## Decisions (confirmed with developer)

| Decision | Choice |
|---|---|
| Deliverables | (1) NestJS+Drizzle n-tier demo, (2) learning guide, (3) Claude skill for generating Nabrdalik-style tests |
| Domain | **Library Lending Platform** |
| Modules | **3 bounded contexts**: Catalog, Membership, Lending |
| ORM / DB | **Drizzle + PostgreSQL** |
| Integration infra | **testcontainers** (real Postgres in Docker for crucial-path integration tests) |
| Unit-test infra | **In-memory repository implementations** (no mocks, no DB) |
| Test runner | **Vitest** |
| Language | TypeScript |
| Greenfield | Yes — empty directory, we start from scratch |

## Domain: Library Lending Platform — shape

**Catalog module** (bounded context: "what books exist")
- Entities: `Book` (title, authors, isbn), `Author`, `Copy` (physical inventory: copyId, bookId, condition, status)
- Join: Book ↔ Author many-to-many
- Facade: `CatalogFacade` — add book, register copy, find book, mark copy available/unavailable
- Internal concept of "user" not present here; copies are owned by the catalog

**Membership module** (bounded context: "who can borrow")
- Entities: `Member` (memberId, name, email, tier), `Membership` (status: ACTIVE/SUSPENDED, tier: STANDARD/PREMIUM)
- Facade: `MembershipFacade` — register member, suspend, upgrade tier, check eligibility

**Lending module** (bounded context: "who borrowed what, when")
- Entities: `Loan` (loanId, memberId, copyId, borrowedAt, dueDate, returnedAt), `Reservation` (queued holds on a book)
- Depends on Catalog + Membership **via their facades** (not their internals) — this is a "mock other module's facade" teaching moment
- Async event emission: `LoanOpened`, `LoanReturned`, `LoanOverdue`, `ReservationFulfilled`
- Join: Loan joins Copy (from Catalog) + Member (from Membership) + dates
- Facade: `LendingFacade` — borrow copy, return copy, reserve book, list overdue loans

### Why this domain works for teaching

- **Joins**: Loan meaningfully joins across 3 modules (member + copy + book)
- **Async**: Overdue detection + reservation fulfillment are natural async/event flows
- **Module boundaries**: Lending legitimately needs to *check* membership eligibility and *check* copy availability — it cannot reach into them; it calls their facades
- **Bounded context words**: "Member" in Membership is full profile; in Lending it's just `memberId` + eligibility flag — demonstrates bounded-context vocabulary
- **In-memory fit**: All three modules are naturally CRUD-with-state; `Map<id, entity>` implementations are trivial

## Tidy opportunities

None — greenfield.

## UI-involved

**No.** Backend-only NestJS. No browser verification needed. REST controllers are the interaction surface; integration tests cover them.

## Constraints / non-goals

- **Not production-grade** — teaching artifact. No auth, no rate limiting, no real event bus.
- **Not a full library system** — enough modules/flows to demonstrate the eleven principles, no more.
- **Keep each module small** — the code should fit on a reviewer's mental whiteboard.
- **Don't invent patterns Jakub didn't mention.** Stick to what's in the talk.

## What "done" looks like

- `apps/library/` — NestJS app with three modules (catalog, membership, lending) in the Nabrdalik style
- Each module has: facade, config/module, in-memory repo, domain types, DTO, sample-data builder
- Unit tests per module — no I/O, test via facade, use in-memory repo, mock only other modules' facades
- Integration tests — real HTTP + real Postgres via testcontainers, "common interactions" helpers, cover 1-2 crucial paths per module
- `GUIDE.md` at repo root — walks each principle with pointers into the demo code
- `.claude/skills/nabrdalik-module-tests/SKILL.md` — Claude skill that teaches the model to write tests in this style
- Screenshots of key slides in `.claude/screenshots/` referenced from GUIDE.md
