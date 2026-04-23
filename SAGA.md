# The saga pattern — a style guide

*Break one distributed transaction into N local transactions, coordinated by events, with explicit compensation when a step fails.*

**Why it matters:** Distributed transactions (2PC / XA) are slow, fragile, and couple your services at the deployment level. A saga delivers the same business outcome using services that can be deployed, scaled, and tested on their own — at the cost of writing the compensation path yourself.

---

## The four invariants

A saga is **four properties holding at once**. Drop any one and it's something else.

- **Many local transactions, one business outcome.** Each step commits independently. None blocks another.
- **Events coordinate — not RPC.** Step N publishes; step N+1 subscribes. Steps never call each other directly.
- **Compensations for failure.** A failed step triggers a *new* transaction that undoes the previous one. You never "rollback" a committed step — you write the opposite.
- **The trigger's caller gets success once step 1 commits.** Downstream failures surface as events, not as HTTP 500s.

---

## Pick one flavor

Two styles. Mixing them is where sagas get hard to reason about.

| | Choreography | Orchestration |
| --- | --- | --- |
| **Coordinator** | None — each service listens | A dedicated service tells others what to do |
| **Coupling** | Low — everyone knows the events | Higher — participants coupled to the orchestrator |
| **Debugging** | "Which event fired which?" archaeology | One place shows the whole flow |
| **Best for** | Small sagas (2–4 steps) | Complex sagas (5+ steps, conditional branches) |

**This repo uses choreography.** The consumer subscribes to `LoanReturned`, acts, publishes `AutoLoanOpened` or `AutoLoanFailed`. No orchestrator.

---

## The worked example — `AutoLoanOnReturnConsumer`

**Business goal:** Alice returns a book → Bob (next in queue) gets it automatically.

Four local transactions, two terminal events:

```
Tx 1 (Lending.returnLoan)
  save loan.returnedAt
  commit → publish LoanReturned
                │
                ▼
Tx 2 (consumer: claim)
  save reservation.fulfilledAt = now
  stage ReservationFulfilled
  commit → event publishes
                │
                ▼
Tx 3 (Lending.borrow)
  save new loan for Bob
  stage LoanOpened
  commit → event publishes
                │
      success   │   failure
       ▼              ▼
  publish       Tx 4 (compensation)
  AutoLoanOpened  reservation → pending
                  stage ReservationUnfulfilled
                  commit
                        │
                        ▼
                  publish AutoLoanFailed
```

**Map to code** in [`auto-loan-on-return.consumer.ts`](./apps/library/src/lending/auto-loan-on-return.consumer.ts):

- `claimReservation` — Tx 2, forward step. Own tx for the write + staged event.
- `attemptAutoLoan` — wraps Tx 3 in try/catch. On failure, calls `tryUnfulfillClaim` (Tx 4) and publishes `AutoLoanFailed`.
- The consumer never re-throws. `returnLoan`'s HTTP caller sees 200 regardless.

---

## Saga vs distributed transaction

| | Saga | 2PC / XA |
| --- | --- | --- |
| **Consistency** | Eventual | Strong |
| **Failure handling** | You write compensations | Coordinator rolls back |
| **Latency** | One local commit per step | Prepare + commit rounds |
| **Availability** | One participant down ≠ blocked | Any participant down = blocked |
| **Testability** | Local unit tests per step | Requires the full distributed setup |
| **Operational cost** | You own the compensation code | You own a coordinator |

**Sagas win** for extractable modules and services. **2PC wins** for "must be strongly consistent to the microsecond" — a requirement that's almost never actually true in business systems.

---

## How to design one

Five questions, in order. If any answer is "we'll figure it out later," you have a distributed bug waiting.

1. **What's the trigger event?** Named after a past-tense business fact. `LoanReturned`, not `ReturnLoan`.
2. **What's the forward path?** List the steps. Each one must fit inside a single local transaction.
3. **What's each step's compensation?** If step N+1 can fail, step N needs an inverse — written as a *new* transaction, not a flag flip.
4. **What are the terminal events?** Success and failure both announce themselves. `AutoLoanOpened` on the good path, `AutoLoanFailed` on the bad. Downstream subscribers key off these.
5. **What's idempotent?** Events may deliver twice. Every step must be safe to replay — use claim-first writes (commit a uniqueness signal before acting) so a second run observes the claim and skips.

---

## Four mistakes that kill sagas

- **Compensation as a boolean flag.** `reservation.cancelled = true` will eventually be wrong or be missed by a reader. Write a real transaction that flips state, with its own staged event.
- **No idempotency.** Consumer runs twice, opens two loans for Bob. Claim-first fixes the single-node case; a DB unique constraint on the claim key fixes the distributed case.
- **Silently swallowing compensation failures.** If the un-fulfill tx *also* fails, you have drift. Emit a loud failure event so an operator can reconcile — don't hide it in a log.
- **No terminal event.** Without explicit success/failure events, downstream systems can't observe what happened. Every saga needs both.

---

## When NOT to use a saga

- **Single-module, single-table writes** — use one transaction.
- **Read-only cross-module operations** — compose facades, don't fire events.
- **Real-time strong consistency** (e.g. a shared ledger balance) — merge the services or accept 2PC.
- **Fewer than three coordinated steps and no cross-module writes** — a try/catch with one compensation is simpler than a full saga.

**The test:** if your use case has fewer than 3 coordinated steps and no cross-module writes, you don't need a saga — you need a function.

---

## Smell checklist

- Step N directly calling step N+1 instead of publishing an event — not a saga, just sequential code with extra words.
- A `cancelled` or `rolled_back` boolean column on the forward-step row — write a compensation instead.
- Terminal event missing on the failure path — operators will be guessing what went wrong.
- Forward step swallows its own errors — failure must surface as either a compensation trigger or a terminal event.
- Consumer re-throws into the trigger's caller — HTTP 500 on a downstream failure is not the saga contract.

---

## Go deeper

- [`ARCHITECTURE.md`](./ARCHITECTURE.md) — how sagas fit the modular-monolith discipline this repo enforces.
- [`GUIDE.md` → Principle 7](./GUIDE.md) — module boundaries and why cross-module transactions are banned.
- [`auto-loan-on-return.consumer.ts`](./apps/library/src/lending/auto-loan-on-return.consumer.ts) — the saga, ~200 lines end-to-end.
- [`auto-loan-on-return.consumer.spec.ts`](./apps/library/src/lending/auto-loan-on-return.consumer.spec.ts) — `describe('transactional atomicity of the claim (tx showcase)')` proves the compensation path rolls back cleanly, in milliseconds.
