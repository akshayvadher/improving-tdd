# Features — what this application does

A minimal library-lending system. It tracks books and their physical copies, registered members, the loans and reservations that connect the two, and the fines that accrue when a loan runs past its due date.

Four modules, four concerns:

| Module         | Question it answers                                     |
|----------------|---------------------------------------------------------|
| **Catalog**    | What books exist, and which physical copies?            |
| **Membership** | Who is registered, and can they borrow today?           |
| **Lending**    | Who borrowed what, and who is waiting?                  |
| **Fines**      | Who owes money for overdue loans, and who got suspended?|

The rest of this doc walks what each module lets you do, in the user's voice.

---

## Catalog — "what books exist"

A book is a *title*: ISBN, title, authors. A copy is a *physical artefact* on a shelf: one book can have many copies, each with its own condition and availability.

### As a librarian I can…

- **Add a new book to the catalog** by ISBN, title, and authors.
  Title must be non-empty, at least one author is required, and the ISBN must be well-formed (ISBN-10 or ISBN-13, with or without hyphens). Surrounding whitespace on title, authors, and ISBN is trimmed. A second book with the same ISBN is rejected.
  At add time, the Catalog enriches missing `title` / `authors` via an external **ISBN lookup gateway** — any field you omit is filled from the gateway's metadata before the book is persisted. Values you supply always win; the gateway fills gaps only. The shipped default is an in-memory gateway that stands in for the real provider in every test and in development; a future HTTP-backed adapter will swap in behind the same `IsbnLookupGateway` port (a narrow interface — not a network port) without touching any caller.
- **Look up a book by ISBN** to confirm it is registered.
- **List every book** in the order they were added.
- **Register a new physical copy** of a book with a condition (`NEW`, `GOOD`, `FAIR`, or `POOR`).
  A condition outside that set is rejected. A copy starts life *available*.
- **Look up a specific copy** by its id.
- **Mark a copy unavailable** (damaged, lost, in repair) and **mark it available again** when it returns to circulation.

### What makes the Catalog interesting

- It distinguishes the abstract *book* from the concrete *copy*. You cannot borrow a book; you borrow a specific copy of it.
- Availability is a property of the *copy*, not the book. A popular book with three copies has three independent availability states.

---

## Membership — "who can borrow"

A member has a name, an email, a tier, and a status.

### As a librarian I can…

- **Register a new member** with name and email.
  Name must be non-empty. Email must be syntactically valid (`local@domain.tld`). Surrounding whitespace on name and email is trimmed. A second registration with the same email is rejected. New members start out `ACTIVE` and on the `STANDARD` tier.
- **Look up a member** by id.
- **Suspend a member** (for example, unpaid fines) and **reactivate** them later.
- **Upgrade a member's tier** between `STANDARD` and `PREMIUM`.
- **Check whether a member is eligible to borrow right now** — the result is a yes/no plus a `reason` when no (for example `SUSPENDED`).

### What makes Membership interesting

- The `checkEligibility` call is the only way Lending is allowed to ask about a member. Lending never reads `member.status` directly. That keeps the rule for eligibility inside the Membership module, where it can grow (expired card, unpaid fines, overdue-book limit) without leaking into the rest of the system.

---

## Lending — "who borrowed what, and who's waiting"

The operational heart. Lending stands on top of Catalog and Membership and is the only module that writes loans and reservations.

### As a member I can…

- **Borrow a copy.** The system verifies I am eligible (via Membership) and that the copy is available (via Catalog). It opens a loan with a **14-day due date**, marks the copy unavailable, and records the loan against me.
- **Return a loan.** The system timestamps the return, marks the copy available again, and — if anyone has reserved this book — promotes the earliest reservation in the queue into a fulfillment.
- **Reserve a book I cannot borrow right now.** I reserve by *book*, not by copy. Reservations are queued FIFO by the moment I placed them. When someone returns a copy of that book, the earliest pending reservation is fulfilled.

### As a librarian I can…

- **List a member's loans** — every loan they have ever opened, including returned ones.
- **List overdue loans at a given moment** — every loan whose due date is before *now* and which has not been returned.

### Rules enforced by the code

| Rule                                                          | Where it lives                                    |
|---------------------------------------------------------------|---------------------------------------------------|
| An ineligible member cannot borrow or reserve.                | `borrow` and `reserve` ask Membership first.      |
| An unavailable copy cannot be borrowed.                       | `borrow` checks `copy.status`.                    |
| Loan duration is 14 days from borrow time.                    | `LOAN_DURATION_DAYS = 14` in `lending.facade.ts`. |
| Returning a book fulfills the oldest pending reservation.     | `fulfillNextReservation` inside `returnLoan`.     |
| A reservation queue is per-book, ordered by reservation time. | `listPendingReservationsForBook`.                 |
| Overdue = `dueDate < now AND returnedAt IS NULL`.             | `listOverdueLoans`.                               |

### Domain events emitted

Lending announces what happened on an in-process event bus. Nothing in the demo subscribes to these — they exist as the contract for anyone who later needs to react (audit log, notifications, analytics).

- `LoanOpened` — member borrowed a copy.
- `LoanReturned` — member returned a copy.
- `ReservationQueued` — member joined the reservation queue for a book.
- `ReservationFulfilled` — the earliest reservation in the queue was resolved because someone returned a copy.

### Atomicity — the piece worth understanding

`returnLoan` does three things that must succeed or fail together:

1. Mark the loan returned (write to the loans store).
2. If there is a pending reservation for this book, mark it fulfilled (write to the reservations store).
3. Publish `LoanReturned` and, if applicable, `ReservationFulfilled`.

If step 2 fails, step 1 must not persist and no events may be published. The module provides that guarantee via a `TransactionalContext` that stages writes and events, commits them together on success, and throws them away on failure. The in-memory implementation uses a scratch buffer; the Drizzle implementation uses a real Postgres transaction. Same contract, same tests.

The cross-module call — telling Catalog to mark the copy available — lives *outside* the transaction. Cross-module consistency runs on events and happens-before ordering, not shared DB transactions.

---

## Fines — "who owes money, and who got suspended"

A fine is a monetary penalty tied to a single overdue loan. The fine accrues at a configurable daily rate for every day the loan is past its due date, up to the moment the batch is run. When a member's total unpaid fines cross a configurable threshold, Membership is asked to suspend the member automatically.

Fines stands alongside Lending. It reads loans through `LendingFacade.listOverdueLoans` and drives suspensions through `MembershipFacade.suspend`. Lending has **no** dependency on Fines — a suspended member is blocked at Membership, not at Fines.

### As a librarian I can…

- **Assess fines for a single member** at a chosen moment. The system enumerates the member's overdue loans, writes one fine per loan, and returns the full list.
- **Run the nightly batch** across the whole library. Every member with overdue loans gets fines assessed, and anyone whose unpaid total crosses the threshold is auto-suspended in the same pass.
- **List a member's fines** in insertion order — paid and unpaid together.
- **Look up a single fine** by id.
- **Mark a fine paid.** A fine can only be paid once; a second attempt is rejected.

### Facade API

| Method                             | Purpose                                              |
|------------------------------------|------------------------------------------------------|
| `assessFinesFor(memberId, now)`    | Assess fines for one member's overdue loans.         |
| `processOverdueLoans(now)`         | Batch — assess + auto-suspend across all members.    |
| `listFinesFor(memberId)`           | Return all fines for a member, insertion order.      |
| `findFine(fineId)`                 | Return the fine or `FineNotFoundError`.              |
| `payFine(fineId)`                  | Stamp `paidAt`; `FineAlreadyPaidError` on re-pay.    |

### Rules enforced by the code

| Rule                                                                   | Where it lives                                      |
|------------------------------------------------------------------------|-----------------------------------------------------|
| Fine amount = days-overdue × `dailyRateCents`.                         | `assessFinesFor` inside `fines.facade.ts`.          |
| Running the batch twice does not create duplicate fines per loan.      | Idempotency via `findByLoanId` before each save.    |
| Threshold crossing triggers `Membership.suspend` exactly once.         | Per-member loop inside `processOverdueLoans`.       |
| A member already suspended is not re-suspended.                        | Status check before calling `suspend`.              |
| `payFine` on an already-paid fine throws `FineAlreadyPaidError`.       | `payFine` inside `fines.facade.ts`.                 |

### Domain events emitted

- `FineAssessed` — one per fine recorded (`fineId`, `memberId`, `loanId`, `amountCents`, `assessedAt`).
- `MemberAutoSuspended` — one per threshold-crossing suspension (`memberId`, `totalUnpaidCents`, `thresholdCents`, `suspendedAt`).

### Errors

| Error                     | HTTP status | Meaning                                     |
|---------------------------|-------------|---------------------------------------------|
| `FineNotFoundError`       | 404         | No fine exists with the given id.           |
| `FineAlreadyPaidError`    | 409         | The fine has already been paid once.        |
| `MemberNotFoundError`     | 404         | Re-thrown from Membership during assess.    |

### Mid-batch failure — the deliberately not-atomic bit

`processOverdueLoans` is **not** wrapped in a transaction. Each member's `save fine → publish FineAssessed → (if threshold crossed) suspend → publish MemberAutoSuspended` triple runs independently. If `suspend` throws on member 1, member 1's fine and `FineAssessed` event remain persisted, and the error propagates before member 2 is reached. This is the intended teaching shape: the fine is a recorded fact about a loan; a failure to suspend does not unrecord it.

This is the behaviour the canonical `ThrowingOnceMembershipFacade` test in `fines.facade.spec.ts` pins down — and is the reason that test is the canonical justified hand-rolled-fake example referenced in `GUIDE.md` Principle 7.

---

## Chat — "ask a question, stream a completion"

An auxiliary capability, not a fifth domain module — so it does not appear in the four-module overview table above. Chat is a stateless passthrough: `POST /chat` with an OpenAI-style `{ messages: [{ role, content }] }` body returns a Server-Sent Events stream. Zero or more `event: delta` frames (`data: {"text": "..."}`) carry the completion chunk by chunk, followed by a terminal `event: done`; if the upstream provider fails mid-stream the facade shapes a terminal `event: error` frame so the client always sees an explicit wire-level end. No persistence, no conversation history, no authentication — each request is independent. The upstream LLM sits behind a pluggable `ChatGateway` port; the shipped in-memory default services every test and every dev-machine run, and a real OpenAI-backed adapter wires in automatically when `OPENAI_API_KEY` is set in the environment.

---

## What the application does *not* do

Deliberately out of scope, to keep the teaching focus on testing rather than modelling:

- No authentication or authorization. Anyone hitting the HTTP API can act as any member or librarian.
- No payment processing or billing. Fines are recorded and paid as a boolean flag (`paidAt`); there is no gateway, no refunds, no partial payments, no waivers.
- No automatic reinstatement of a suspended member on payment — an operator does that via Membership directly.
- No notifications or emails. Events are emitted but no subscriber consumes them.
- No search beyond ISBN lookup and list-all.
- No branch / multi-location concept — one shelf, one system.
- No concurrency limits per member (a member could borrow every copy in the library).

These are the obvious next features if you wanted to turn the demo into a real library system. They are left out on purpose.

---

## HTTP surface, at a glance

For when you want to curl the thing:

| Method & path                              | What it does                            |
|--------------------------------------------|-----------------------------------------|
| `POST   /books`                            | Add a book.                             |
| `GET    /books`                            | List all books.                         |
| `GET    /books/:isbn`                      | Look up a book by ISBN.                 |
| `POST   /books/:bookId/copies`             | Register a copy of a book.              |
| `PATCH  /copies/:copyId/available`         | Mark a copy available.                  |
| `PATCH  /copies/:copyId/unavailable`       | Mark a copy unavailable.                |
| `POST   /members`                          | Register a new member.                  |
| `GET    /members/:id`                      | Look up a member.                       |
| `PATCH  /members/:id/suspend`              | Suspend a member.                       |
| `PATCH  /members/:id/reactivate`           | Reactivate a suspended member.          |
| `PATCH  /members/:id/tier`                 | Change a member's tier.                 |
| `GET    /members/:id/eligibility`          | Ask whether a member can borrow.        |
| `POST   /loans`                            | Borrow a copy.                          |
| `PATCH  /loans/:loanId/return`             | Return a loan.                          |
| `GET    /loans/overdue?now=ISO`            | List overdue loans at a moment in time. |
| `GET    /members/:memberId/loans`          | List a member's loans.                  |
| `POST   /reservations`                     | Reserve a book.                         |
| `POST   /members/:memberId/fines/assessments` | Assess fines for one member's overdue loans. |
| `POST   /fines/batch/process`              | Run the overdue-fines batch across all members. |
| `GET    /members/:memberId/fines`          | List a member's fines.                  |
| `GET    /fines/:fineId`                    | Look up a single fine.                  |
| `PATCH  /fines/:fineId/paid`               | Mark a fine paid.                       |
| `POST   /chat`                             | Stream a chat completion as Server-Sent Events. |

Run `pnpm --filter library start:dev` to hit them.
