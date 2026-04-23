# Architecture learnings

*A modular monolith where every module is extractable — and the rules that keep it that way.*

**Why it matters:** The day you pull a module into its own service, any shortcut you took on module boundaries becomes a migration headache. These rules are chosen to make extraction cheap, forever.

---

## The big picture

- **One module per bounded context.** `catalog`, `membership`, `lending`, `fines`, `chat`, `categories`. Each owns its tables, its repository, its facade.
- **One facade per module.** The only public surface. Controllers, consumers, and other modules call the facade; nothing reaches past it.
- **One transaction per module.** Transactions never span modules. Ever.
- **No cross-module JOINs.** If you need two modules' data, compose their facades — with a batch method when N+1 would bite.

---

## Cross-module transactions: don't

**The rule:** a transaction belongs to exactly one module.

**Why:**
- **A tx holds a connection.** Cross-module tx = shared pool = shared DB = coupled deployment.
- **A tx implies schema coupling.** If you can atomically write across two modules' tables, someone will eventually JOIN them.
- **Extractable modules stay cheap.** The alternative is distributed transactions (2PC) or a rewrite — pick the rewrite, but do it from day one so you never owe it.

**What you do instead.** Three patterns. Compose them.

1. **Commit-first, publish-later.** Your own-module writes + staged events inside one tx. Events publish only after commit. If the tx rolls back, the event never fires.
2. **Side effects after commit.** Call other modules' facades *after* your own tx returns. Compensate if that call fails.
3. **Consumers with their own tx.** Downstream modules subscribe to events and act in their own transactional scope — with a compensating tx for the failure path.

---

## Worked example — `returnLoan`

```
Lending tx:
  save loan (returnedAt = now)
  stage LoanReturned event
commit.

Catalog.markCopyAvailable(copyId)      ← outside the tx
publish LoanReturned                   ← after the catalog call

AutoLoanOnReturnConsumer picks up LoanReturned:
  Its own tx:
    claim next pending reservation
    stage ReservationFulfilled
  commit.

  Lending.borrow(nextMember, copy)     ← forward step
  If borrow fails:
    Its own tx:
      un-fulfill reservation
      stage ReservationUnfulfilled
    commit.                            ← compensation
```

**That's a saga.** Forward steps in their own txs. Compensation steps in their own txs. Events as the coordination medium. No shared transaction, no 2PC.

---

## When you think you need a cross-module tx

Three options, in order of preference:

- **Your module boundary is probably wrong.** If two concepts must be consistent to the microsecond, they're one bounded context. Merge them.
- **Saga + compensation.** Forward and compensation steps as independent txs, coordinated by events.
- **Outbox pattern.** Write your data + an outbox row in one tx; a publisher drains the outbox. Stronger delivery guarantees than "publish after commit," heavier to operate.

---

## Testing the rules

| Invariant | Where it's proven |
| --- | --- |
| `returnLoan` tx rolls back the loan write + suppresses the staged event | `lending.facade.spec.ts` → `describe('atomicity')` |
| Consumer's claim tx rolls back the staged `ReservationFulfilled` | `auto-loan-on-return.consumer.spec.ts` → `describe('transactional atomicity of the claim')` |
| Consumer's un-fulfill tx rolls back the staged `ReservationUnfulfilled` | same file, next `it(...)` |
| Same repository contract on in-memory and real Postgres | `categories.facade.spec.ts` + `categories.pglite.spec.ts` |

**All four atomicity tests run in memory**, in milliseconds. The `TransactionalContext` interface has the same shape in memory and in production (`drizzle-transactional-context.ts` wraps `db.transaction`), so the contract is honored by both substrates.

---

## The smell checklist

- `await otherModule.somethingOn(tx)` — nope, that shape doesn't exist.
- A JOIN across tables owned by different modules — no.
- "I'll just share the Drizzle client" — coupling masquerading as convenience.
- `vi.fn` or `vi.mock` anywhere in this repo — not allowed; use in-memory doubles.
- Expanding a module's barrel to expose a repository or internal helper — stop; add a facade method instead.

---

## Test substrates — pick the right one

| Substrate | When | Cost |
| --- | --- | --- |
| **In-memory repository** | Default. Facade-level tests, fast feedback, contract checks. | Milliseconds. No infra. |
| **PGlite** | When you need real Postgres semantics (`ILIKE`, `UNIQUE`, collation) without Docker. | ~2s per spec file. No Docker. |
| **Testcontainers (`postgres:16`)** | Crucial-path HTTP-through-Postgres per module. Real network endpoint, real version. | ~30s. Requires Docker. |

The same repository class runs against all three — it's the substrate, not the code, that changes.

---

## Go deeper

- [`GUIDE.md`](./GUIDE.md) — long-form walkthrough of all 13 principles.
- [`GUIDE.md` → Principle 7](./GUIDE.md) — module boundaries, facade discipline.
- [`GUIDE.md` → Principle 12](./GUIDE.md) — no cross-module JOINs.
- [`GUIDE.md` → Substrate alternative: PGlite](./GUIDE.md) — Docker-free real-Postgres tests.
- [`apps/library/src/lending/lending.facade.ts`](./apps/library/src/lending/lending.facade.ts) — the tx-scoped-to-one-module example.
- [`apps/library/src/lending/auto-loan-on-return.consumer.ts`](./apps/library/src/lending/auto-loan-on-return.consumer.ts) — the saga example.
