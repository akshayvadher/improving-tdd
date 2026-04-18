# Architecture Recommendation

## Pattern
**Modular Monolith with flat feature folders per module.** Facade-as-port. In-memory + Drizzle repositories are the two adapters. No hexagonal-labeled layers (the facade IS the port). No CQRS. No separate `domain/` layer.

## Monorepo shape
**pnpm workspace with one `apps/library/` package.** Root holds `GUIDE.md`, `README.md`, `.claude/` (including the skill). App lives under `apps/library/`.

## Test file location
**Co-located next to source.** `catalog.facade.spec.ts` sits next to `catalog.facade.ts`. Integration tests live in `apps/library/test/` (they cross modules and boot the app).

## DI strategy
- **Unit tests**: plain TS factory `createCatalogFacade(overrides?)` in `catalog.configuration.ts`. No `@Injectable`, no `Test.createTestingModule`, no IoC.
- **Production**: `CatalogModule` uses Nest providers; `@Injectable()` decorator on the facade. The facade class works in both worlds.

## TransactionalContext placement
**Owned by Lending** (`apps/library/src/lending/transactional-context.ts`). Do NOT put in `shared/`. Interface:

```ts
export interface TransactionalContext {
  run<T>(work: () => Promise<T>): Promise<T>;
}
export type TransactionalContextFactory = () => TransactionalContext;
```

In-memory: stage-and-commit via scratch buffers; discard on throw.
Drizzle: wraps `db.transaction(tx => work())`; threads `tx` to repo calls.

## Event bus placement
`apps/library/src/shared/events/event-bus.ts` (interface) + `in-memory-event-bus.ts` (with test-only `collected` accessor). This is the ONLY allowed shared folder.

## File structure

```
improving-test/
├─ pnpm-workspace.yaml
├─ package.json              # root devDeps: vitest, typescript, eslint
├─ GUIDE.md                  # slice 5
├─ README.md
├─ .claude/
│  ├─ screenshots/
│  └─ skills/nabrdalik-module-tests/  # slice 6
│     ├─ SKILL.md
│     └─ references/
│        ├─ facade.template.ts
│        ├─ in-memory-repository.template.ts
│        ├─ sample-data-builder.template.ts
│        ├─ module-spec.template.ts
│        ├─ common-interactions.template.ts
│        ├─ event-bus-and-collector.template.ts
│        └─ transactional-unit-of-work.template.ts
└─ apps/library/
   ├─ package.json
   ├─ tsconfig.json
   ├─ vitest.config.ts       # two projects: unit + integration
   ├─ drizzle.config.ts
   ├─ .eslintrc.cjs          # boundary rule
   ├─ src/
   │  ├─ main.ts             # slice 4
   │  ├─ app.module.ts       # slice 4
   │  ├─ catalog/            # slice 1
   │  │  ├─ index.ts         # barrel: facade + public DTOs only
   │  │  ├─ catalog.facade.ts
   │  │  ├─ catalog.facade.spec.ts
   │  │  ├─ catalog.module.ts
   │  │  ├─ catalog.controller.ts       # slice 4
   │  │  ├─ catalog.configuration.ts    # createCatalogFacade()
   │  │  ├─ catalog.repository.ts       # interface
   │  │  ├─ in-memory-catalog.repository.ts
   │  │  ├─ drizzle-catalog.repository.ts  # slice 4
   │  │  ├─ catalog.types.ts
   │  │  └─ sample-catalog-data.ts
   │  ├─ membership/         # slice 2 — mirrors catalog/
   │  │  └─ …
   │  ├─ lending/            # slice 3
   │  │  ├─ index.ts
   │  │  ├─ lending.facade.ts
   │  │  ├─ lending.facade.spec.ts
   │  │  ├─ lending.reservations.spec.ts  # DSL demo
   │  │  ├─ lending.module.ts
   │  │  ├─ lending.controller.ts         # slice 4
   │  │  ├─ lending.configuration.ts
   │  │  ├─ loan.repository.ts
   │  │  ├─ reservation.repository.ts
   │  │  ├─ in-memory-loan.repository.ts
   │  │  ├─ in-memory-reservation.repository.ts
   │  │  ├─ drizzle-loan.repository.ts            # slice 4
   │  │  ├─ drizzle-reservation.repository.ts     # slice 4
   │  │  ├─ transactional-context.ts
   │  │  ├─ in-memory-transactional-context.ts
   │  │  ├─ drizzle-transactional-context.ts      # slice 4
   │  │  ├─ lending.types.ts
   │  │  ├─ sample-lending-data.ts
   │  │  └─ testing/reservation-dsl.ts
   │  ├─ shared/events/
   │  │  ├─ event-bus.ts
   │  │  └─ in-memory-event-bus.ts
   │  └─ db/                # slice 4
   │     ├─ client.ts
   │     └─ schema/…
   └─ test/                 # slice 4 integration only
      ├─ support/
      │  ├─ testcontainers.ts
      │  ├─ app-factory.ts
      │  └─ interactions/
      │     ├─ catalog-interactions.ts
      │     ├─ membership-interactions.ts
      │     └─ lending-interactions.ts
      ├─ catalog.crucial-path.integration.spec.ts
      ├─ membership.crucial-path.integration.spec.ts
      ├─ lending.crucial-path.integration.spec.ts
      └─ lending.return-loan.integration.spec.ts  # atomicity
```

## Boundary rules

- Each module's `index.ts` exports ONLY the facade class + public DTOs.
- `shared/events/` is the only shared folder. No `shared/utils/`, `shared/types/`.
- `db/schema/` imported only by `drizzle-*.repository.ts` and `main.ts`.
- Catalog and Membership import from no other module.
- Lending imports only Catalog's and Membership's `index.ts`.
- `test/support/interactions/` imports module barrels — nothing else.
- Enforce via `eslint-plugin-boundaries` (or `no-restricted-paths`); if too fiddly in slice 1, document the convention and continue.

## Slice order
**No change.** 1→2→3→4→5→6 is correct. Slice 5 and 6 could run in parallel; spec's sequential order is fine.

## Evolution triggers (for later, NOT today)

- 4th module needs transactions → hoist `TransactionalContext` to `shared/transactions/`
- Real event broker needed → swap bus impl behind same interface
- Facade > ~10 methods → split into command/query facades (still in the module)
- Controller grows branches → push to facade
- Unit test imports Drizzle → boundary leak, fix immediately
- `shared/` grows beyond events → audit; push back into modules unless used by 3+
