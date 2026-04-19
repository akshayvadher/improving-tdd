---
name: nabrdalik-module-tests
description: Write Nabrdalik-style module tests for TypeScript/NestJS projects — facade-only entry, in-memory repositories instead of mocks, sample-data builders with overrides, and a small DSL for clarity. Use when the user asks for "module tests", "facade tests", "Nabrdalik-style tests", "in-memory repository", or shows a TypeScript/Node project with a repository interface and wants unit tests that don't mock their own collaborators.
---

Based on Jakub Nabrdalik's talk "Improving your Test Driven Development in 45 minutes" (https://www.youtube.com/watch?v=2vEoL3Irgiw). This is the only mention of Java/Spring/Groovy/Spock in this skill.

## When to use this skill

Load this skill when any of these apply:

- The user asks for **"module tests"**, **"facade tests"**, **"in-memory repository"**, or **"Nabrdalik-style"** tests.
- The user shows a **TypeScript/Node** project (NestJS, Fastify, or Express) that has a repository interface and wants unit tests that exercise real logic without mocking their own collaborators.
- The user shows a project where unit tests are brittle because every test mocks the module's own repository, or where the unit suite is slow because tests drive the HTTP layer or a real database.
- The user wants a testing pattern that survives refactoring — tests assert on behaviour visible through the facade, not on internal fields.

Do NOT use this skill for: frontend/UI tests, non-TypeScript projects, or end-to-end integration tests that must touch a real database or HTTP.

## The eleven principles

Each principle has: a one-line summary, a link to the guide, and a demo file you can copy from.

1. **Don't test too low.** Class/method tests snap on every refactor; 100% coverage does not prove the system works. Test the module, not its internals.
   - Guide: [GUIDE.md#principle-1](../../../GUIDE.md#principle-1--dont-test-too-low)
   - Demo: [apps/library/src/catalog/catalog.facade.spec.ts](../../../apps/library/src/catalog/catalog.facade.spec.ts)

2. **Don't test too high.** Full-system tests are slow. Keep them for crucial paths only; run everything else as fast module tests with no I/O.
   - Guide: [GUIDE.md#principle-2](../../../GUIDE.md#principle-2--dont-test-too-high)
   - Demo: [apps/library/src/catalog/catalog.facade.spec.ts](../../../apps/library/src/catalog/catalog.facade.spec.ts) (sub-second suite)

3. **Test your modules.** A module encapsulates its data (access only via its facade), has clear collaborators, and is almost a vertical slice — usually a bounded context.
   - Guide: [GUIDE.md#principle-3](../../../GUIDE.md#principle-3--test-your-modules)
   - Demo: [apps/library/src/catalog/](../../../apps/library/src/catalog/) — the shape every module copies.

4. **Module as black box.** All flows and corner cases run in milliseconds with no I/O. I/O shows up only in crucial-path integration tests.
   - Guide: [GUIDE.md#principle-4](../../../GUIDE.md#principle-4--module-as-black-box-in-milliseconds)
   - Demo: [apps/library/src/membership/membership.facade.spec.ts](../../../apps/library/src/membership/membership.facade.spec.ts)

5. **In-memory implementations, not mocks.** Provide a real `InMemory<Thing>Repository` (a `Map<id, entity>`) so unit tests exercise real logic. Avoid mocks for your own collaborators. For atomicity across multiple writes, route them through a `TransactionalContext` that stages and commits (or discards on throw).
   - Guide: [GUIDE.md#principle-5](../../../GUIDE.md#principle-5--in-memory-implementations-not-mocks)
   - Demo: [apps/library/src/catalog/in-memory-catalog.repository.ts](../../../apps/library/src/catalog/in-memory-catalog.repository.ts), [apps/library/src/lending/in-memory-transactional-context.ts](../../../apps/library/src/lending/in-memory-transactional-context.ts)

6. **Do not let I/O escape the module.** Do not export a method that accepts a repository — developers will inject mocks and test internal state. Export only the facade factory that wires its own in-memory deps.
   - Guide: [GUIDE.md#principle-6](../../../GUIDE.md#principle-6--dont-let-io-escape-the-module)
   - Demo: [apps/library/src/catalog/catalog.configuration.ts](../../../apps/library/src/catalog/catalog.configuration.ts)

7. **Module boundaries.** Touch other modules only through their **public facades** — never their internals, and never your own repository. In TypeScript this is cleanest when you let the other module hand you its facade via its own factory (`createXFacade()`) — the factory wires zero-I/O in-memory defaults and *is* the test double. Hand-roll a fake facade only when you need to force an exotic failure the real in-memory version cannot reach.
   - Guide: [GUIDE.md#principle-7](../../../GUIDE.md#principle-7--module-boundaries-use-other-modules-facades-never-their-internals)
   - Demo: [apps/library/src/lending/lending.facade.spec.ts](../../../apps/library/src/lending/lending.facade.spec.ts) (uses real `createCatalogFacade` + `createMembershipFacade`)

8. **Keep information to minimum.** Explicit = crucial to understanding the requirement. Implicit = can be taken for granted. Ask "is this crucial?" on every line.
   - Guide: [GUIDE.md#principle-8](../../../GUIDE.md#principle-8--keep-information-to-minimum)
   - Demo: [apps/library/src/catalog/catalog.facade.spec.ts](../../../apps/library/src/catalog/catalog.facade.spec.ts) (terse given/when/then)

9. **Sample data builders per module.** `sampleNewThing({override: 'value'})` prevents setup explosion and makes exploratory tests trivial — override only what matters for the test.
   - Guide: [GUIDE.md#principle-9](../../../GUIDE.md#principle-9--sample-data-builders-per-module)
   - Demo: [apps/library/src/catalog/sample-catalog-data.ts](../../../apps/library/src/catalog/sample-catalog-data.ts)

10. **Common interactions for integration.** Hide HTTP mechanics behind meaningful helpers (`postNewBook(app, dto)`, `getBook(app, isbn)`). Developers should not re-think endpoint, method, payload, or serialization on every test.
    - Guide: [GUIDE.md#principle-10](../../../GUIDE.md#principle-10--common-interactions-for-integration)
    - Demo: [apps/library/test/support/interactions/catalog-interactions.ts](../../../apps/library/test/support/interactions/catalog-interactions.ts)

11. **Show, don't tell (DSL).** If a requirement would be drawn on a whiteboard as a tree or a queue, let the test declare that structure. Build a small DSL so the test sits at the requirement level of abstraction.
    - Guide: [GUIDE.md#principle-11](../../../GUIDE.md#principle-11--show-dont-tell-dsl)
    - Demo: [apps/library/src/lending/lending.reservations.spec.ts](../../../apps/library/src/lending/lending.reservations.spec.ts)

## Checklist before writing a test

Run through this every time. If any item is "no", fix the design before writing the test.

- [ ] Reach into another module **only through its public facade**. Prefer the other module's real factory-wired facade (`createXFacade()`) — it's already in-memory. Hand-roll a fake only to force failures the real one cannot produce.
- [ ] Enter your own module **only through its facade**. Tests never touch the repository interface directly.
- [ ] Use the module's **sample-data builder** and override only the minimum the test needs.
- [ ] **No I/O** in unit tests — no DB, no HTTP client, no filesystem.
- [ ] Assert on **observable outcome** — returned DTOs, emitted events, or state visible through the facade. Never on private fields or internal maps.
- [ ] For multi-write atomicity, route writes through the module's `TransactionalContext` so a unit test can prove rollback by forcing the last step to throw.

## Do NOT do

These are failure modes — if the test looks like this, the design is wrong.

- Do **not** mock your own repository (`vi.mock('./thing.repository.js')`).
- Do **not** accept a repository in a method signature purely to satisfy a test (`facade.addThing(dto, repo)`).
- Do **not** test private or class-internal state. If you need to assert it, expose a facade query.
- Do **not** use `vi.mock` for collaborators that live inside the same module.
- Do **not** reach into another module's internals — go through its `index.ts` barrel only.

## Examples (canonical reads in the demo)

Read these in order — each one adds one teaching point:

- **[apps/library/src/catalog/catalog.facade.spec.ts](../../../apps/library/src/catalog/catalog.facade.spec.ts)** — the simplest template. Facade + in-memory repo + sample builder. No mocks. No events.
- **[apps/library/src/membership/membership.facade.spec.ts](../../../apps/library/src/membership/membership.facade.spec.ts)** — the carbon copy. Shows the template repeats cleanly for a second module.
- **[apps/library/src/lending/lending.facade.spec.ts](../../../apps/library/src/lending/lending.facade.spec.ts)** — the cross-module example. **Real** `CatalogFacade` and `MembershipFacade` wired via their own factories (no hand-rolled fakes); **real** Lending repo and event bus; atomicity test using `TransactionalContext` with a narrow `ThrowingOnceReservationRepository` for failure injection.
- **[apps/library/src/lending/lending.reservations.spec.ts](../../../apps/library/src/lending/lending.reservations.spec.ts)** — DSL example for principle 11. The test reads like the requirement, not like the implementation.

## Writing a new module (workflow)

1. Create the module folder at `src/<name>/`. Add:
   - `<name>.types.ts` — DTOs and domain errors.
   - `<name>.repository.ts` — repository interface.
   - `in-memory-<name>.repository.ts` — `Map<id, entity>` implementation.
   - `<name>.facade.ts` — the facade class.
   - `<name>.configuration.ts` — test-wiring factory (`create<Name>Facade(overrides)`).
   - `<name>.module.ts` — NestJS module that exposes only the facade.
   - `sample-<name>-data.ts` — `sampleNewThing(overrides?)` builders.
   - `index.ts` — barrel that exports the facade class and published DTOs only.
2. **Write the facade's public API first.** Let the tests drive the shape of arguments and return types.
3. **Write the facade spec** using `create<Name>Facade({ /* overrides */ })` — never `Test.createTestingModule`. Tests run without the Nest container.
4. **Use the sample-data builder** with overrides inside tests. Default values carry the "boring" fields; overrides carry the fields that matter for this test.
5. **For cross-module dependencies**, pass the *real* facade of the other module, wired via its own `createXFacade()` factory — that is already a zero-I/O test double. Write hand-rolled fakes only when you need to force a specific failure the real in-memory facade cannot reach (e.g., simulate the other module throwing mid-operation). Never use auto-mocks (`vi.mock`) for sibling facades.
6. **For atomicity across multiple writes**, thread a `TransactionalContext` through your repository calls. The in-memory implementation stages writes and commits on success, discards on throw. Write one test that stubs the last step to throw and asserts nothing persisted.

## Reference templates

Copy-paste starters in `./references/`. Each file is a placeholder using the domain `Thing`/`NewThingDto` — rename and compile.

- **[facade.template.ts](./references/facade.template.ts)** — canonical facade class with constructor-injected repo, id generator, and named error classes.
- **[in-memory-repository.template.ts](./references/in-memory-repository.template.ts)** — `Map<id, Thing>` implementation of a `ThingRepository` interface.
- **[sample-data-builder.template.ts](./references/sample-data-builder.template.ts)** — `sampleNewThing(overrides?)` with defaults and spread-override.
- **[module-spec.template.ts](./references/module-spec.template.ts)** — facade spec template with deterministic ids, sample builders, and three example tests (happy path, error case, state query).
- **[common-interactions.template.ts](./references/common-interactions.template.ts)** — integration-test helper that hides HTTP mechanics (`postNewThing`, `getThing`).
- **[event-bus-and-collector.template.ts](./references/event-bus-and-collector.template.ts)** — typed `EventBus` with `InMemoryEventBus` whose `collected()` method is the test accessor.
- **[transactional-unit-of-work.template.ts](./references/transactional-unit-of-work.template.ts)** — small sketch of the `TransactionalContext` interface plus an in-memory stage-and-commit implementation. Flagged "only for atomicity **within** a module".

## Domain invariants live in the facade, not in a pipe

Validation belongs wherever the rule is enforceable by every caller — that is the facade, not the HTTP layer.

- **Transport-level checks** (malformed JSON, wrong types): decorate the DTO with `class-validator` and wire a NestJS `ValidationPipe`. These catch bad requests before the facade runs.
- **Domain invariants** (non-empty name, well-formed ISBN, duplicate email): put them **inside the facade**, next to the state they guard. If a CLI, another module, or a test calls the facade directly, the rule still applies.

Keep the facade readable by extracting schemas into a `<module>.schema.ts` that lives inside the module:

```ts
// <module>/<module>.schema.ts
import { z } from 'zod';
import { InvalidThingError } from './thing.types.js';

export const NewThingSchema = z.object({
  name: z.string({ required_error: 'name is required' }).trim().min(1, 'name is required'),
  // …other fields with trim/format rules
});

export function parseNewThing(input: unknown): z.infer<typeof NewThingSchema> {
  const result = NewThingSchema.safeParse(input);
  if (!result.success) {
    throw new InvalidThingError(result.error.issues[0]?.message ?? 'invalid input');
  }
  return result.data;
}
```

Then the facade stays focused on orchestration:

```ts
async addThing(dto: NewThingDto): Promise<ThingDto> {
  const { name } = parseNewThing(dto);
  // …existing uniqueness check, then save
}
```

Three rules of thumb:

- **Zod (or whatever validator you chose) is an implementation detail.** The parse helper catches `ZodError` and re-throws the module's own `Invalid<Thing>Error`. Callers, tests, and other modules never see `ZodError`.
- **Schemas live inside the module.** They are not re-exported from `index.ts`, not shared with other modules. If two modules need the same schema, that is a signal to extract a shared module — not a shared schema utility.
- **Tests assert on the module's own error type.** `await expect(...).rejects.toThrow(InvalidThingError)` — nothing about zod. This keeps the test suite immune to validator swaps.

Demo: [apps/library/src/catalog/catalog.schema.ts](../../../apps/library/src/catalog/catalog.schema.ts), [apps/library/src/membership/membership.schema.ts](../../../apps/library/src/membership/membership.schema.ts).

## Naming: Facade, not Service

Name the public entry point `<Module>Facade`, not `<Module>Service`. "Service" in a NestJS codebase is a habit — teams grow many services per feature and import any of them from anywhere. "Facade" (in the GoF sense) names a specific role: *the single simplified entry point to a subsystem*. The name carries a contract: outsiders touch this and only this, and `index.ts` exports only this.

Rename it to `Service` and the contract disappears into convention. Tomorrow someone adds `CatalogQueryService`, imports a repository directly, and the boundary leaks.

## Scope — what this skill does NOT cover

- **Not a replacement for integration tests.** Integration tests still hit a real DB or HTTP and live in `test/` or `*.integration.spec.ts`. Module tests and integration tests are complementary.
- **Not for frontend/UI tests.** This skill is backend-only.
- **Assumes TypeScript.** No variant for other languages is provided in this skill.
- **Not a cross-module transaction pattern.** The `TransactionalContext` is scoped to one module's data. Cross-module consistency is achieved via events and compensation — see principle 7.
