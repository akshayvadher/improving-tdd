# Features — what this application does

A minimal library-lending system. It tracks books and their physical copies, registered members, and the loans and reservations that connect the two.

Three modules, three concerns:

| Module         | Question it answers                          |
|----------------|-----------------------------------------------|
| **Catalog**    | What books exist, and which physical copies?  |
| **Membership** | Who is registered, and can they borrow today? |
| **Lending**    | Who borrowed what, and who is waiting?        |

The rest of this doc walks what each module lets you do, in the user's voice.

---

## Catalog — "what books exist"

A book is a *title*: ISBN, title, authors. A copy is a *physical artefact* on a shelf: one book can have many copies, each with its own condition and availability.

### As a librarian I can…

- **Add a new book to the catalog** by ISBN, title, and authors.
  The system rejects a second book with an ISBN that already exists.
- **Look up a book by ISBN** to confirm it is registered.
- **List every book** in the order they were added.
- **Register a new physical copy** of a book with a condition (`NEW`, `GOOD`, `FAIR`, or `POOR`).
  A copy starts life *available*.
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

## What the application does *not* do

Deliberately out of scope, to keep the teaching focus on testing rather than modelling:

- No authentication or authorization. Anyone hitting the HTTP API can act as any member or librarian.
- No payments, fines, or billing.
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

Run `pnpm --filter library start:dev` to hit them.
