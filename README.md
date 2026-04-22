# Improving TDD Demo — NestJS + Drizzle + Vitest

A teaching artifact that ports Jakub Nabrdalik's [*Improving your Test Driven Development in 45 minutes*](https://www.youtube.com/watch?v=2vEoL3Irgiw) talk from Java/Spock to TypeScript/NestJS.

## Attribution

All ideas, principles, and example domain in this repo originate with **Jakub Nabrdalik** — the author of the original talk. This project is a port, not original work.

- Talk (video): <https://www.youtube.com/watch?v=2vEoL3Irgiw>
- Slides: <https://jakubn.gitlab.io/improvingtdd/>

If you are here for the content, watch Jakub's talk first — this repo is useful as a TypeScript translation of what he teaches.

Three deliverables:
1. A runnable NestJS + Drizzle app demonstrating the eleven principles (under `apps/library/`)
2. A [`GUIDE.md`](./GUIDE.md) walking each principle with pointers into the demo
3. A Claude skill at `.claude/skills/nabrdalik-module-tests/` so an LLM can generate tests in this style

## Major learnings

**The big idea:** tests that run in milliseconds, read like specs, and break only when behaviour changes.

- **Don't mock your own code.** Write in-memory implementations of your own repositories and run the same contract against both them and the real Drizzle pair. `vi.fn` and `vi.mock` never appear in the suite.
- **Enter through the facade.** Tests drive the module's public API, not its internals. Hand-rolled wrappers (`ThrowingOnceReservationRepository`, `RecordingCatalogFacade`) inject faults or record calls — they decorate real collaborators, they don't replace them.
- **A module owns its tables.** In-module SQL JOINs are fine. Cross-module JOINs are banned — reach for the other module's facade with a batch method instead. See [GUIDE.md Principle 12](./GUIDE.md).
- **Own-module transactions only.** Lending's `TransactionalContext` wraps its own writes; Catalog side-effects run after commit. Cross-module consistency is events and happens-before, never a shared transaction.
- **Integration tests guard the crucial path.** One HTTP-through-Postgres test per module proves the contract; the rest is unit tests against in-memory doubles. 121 unit tests in ~2.5s, 15 integration tests in ~30s.
- **Sample data builders beat literals.** `sampleNewBook({ isbn: '...' })` with overrides keeps tests free of noise and survives schema change without rewrites.

**Why it matters:** fast feedback is what makes TDD worth doing. These rules are how you keep the suite fast *and* honest as the codebase grows.

## Requirements

- Node.js 20+
- pnpm 9+
- A container runtime for integration tests only — **Docker** or **Podman** (rootful). On Windows, `podman machine start` must be running.

## Install

```bash
pnpm install
```

## Run unit tests

```bash
pnpm test:unit
```

40 tests across all three modules. The whole suite finishes in under a second — no Docker, no database, no network.

## Run integration tests

```bash
pnpm test:integration
```

Requires Docker or Podman. Uses `testcontainers` to boot a pinned `postgres:16` image, runs Drizzle migrations, and exercises one crucial-path per module plus the return-loan atomicity test. Exits with a clear message if no runtime is reachable.

**Podman note.** When Podman is detected, the test support wires `DOCKER_HOST` and `TESTCONTAINERS_RYUK_DISABLED=true` automatically — no manual env setup needed. On Windows, ensure `podman machine start` has been run at least once; the machine must be rootful (`podman machine init --rootful`) for testcontainers to mount volumes.

## Start the app

```bash
pnpm --filter library start:dev
```

Boots NestJS on the port configured in `apps/library/.env` (default `3000`) against a Postgres database from the same env file.

## Learning walkthrough

Read [`GUIDE.md`](./GUIDE.md) for a principle-by-principle walk through the demo, with code pointers and slide screenshots. The guide is designed to be readable standalone — you do not need to watch the talk first.

## Project layout

```
apps/library/src/
  catalog/       # slice 1 — "what books exist"
  membership/    # slice 2 — "who can borrow"
  lending/       # slice 3 — "who borrowed what, when"
  db/            # slice 4 — Drizzle schema + client
apps/library/test/
  support/       # testcontainers, app factory, common-interactions helpers
  *.integration.spec.ts
```

See `docs/specs/improving-tdd-demo-spec.md` for the full spec and slice-by-slice acceptance criteria.
