# Spec: Chat module with SSE streaming

## Overview

Introduce a new `chat` module — a stateless passthrough over an OpenAI-style chat-completions contract. `POST /chat` accepts `{ messages: [{ role, content }] }` and returns an HTTP Server-Sent Events stream: zero or more `event: delta` frames (`data: {"text": "..."}`) followed by a terminal `event: done` (`data: {}`). Upstream LLM calls live behind a pluggable `ChatGateway` outbound port (mirroring `IsbnLookupGateway` placement and conventions). The shipped in-memory default is the test double; a real OpenAI-backed adapter is wired in behind an env-flag-based factory so default `pnpm test` runs never hit the network.

**Primary teaching point.** Chat extends Principle 5 ("in-memory doubles, not mocks") from request/response outbound gateways (`IsbnLookupGateway`) to **streaming** outbound gateways. The spec-local `ThrowingOnceChatGateway` proves a fault mid-stream surfaces to the caller as an explicit terminal `event: error` frame — without mocking libraries, without HTTP stubs, without ad-hoc stream fakes that drift from the real contract.

## Teaching anchor

**Slice 5 is the canonical teaching moment of this feature** — the streaming-port cousin of the `ThrowingOnceIsbnLookupGateway` lesson in the ISBN Gateway spec's Slice 3. Everything before Slice 5 is scaffolding for it (filter tidy, port + in-memory, HTTP binding, real adapter); Slice 5 is where a reader should walk away understanding that a streaming port is still just an interface, the in-memory default is still just a class, and fault injection is still just a tiny wrapper. GUIDE.md Principle 13 names this explicitly.

## Out of scope

Explicitly NOT part of this feature:

- Any persistence — no Drizzle repository, no conversation history beyond a single request
- Authentication, authorization, per-user session state, multi-tenant isolation
- Rate limiting, quota tracking, cost accounting, usage dashboards
- Caching of prompts or completions
- Retries, exponential backoff, timeouts, circuit breakers, bulkheads, fallback to a second provider
- Streaming backpressure tuning beyond what RxJS gives us out of the box
- Model selection UX (the real adapter picks a single hard-coded default model; no per-request override)
- Tool calls / function calling / vision / audio — plain text `{role, content}` only
- UI — backend only; no web or CLI surface beyond the HTTP endpoint
- TLS / certificate pinning concerns for the upstream provider
- Integration test that hits real OpenAI (Slice 4 ships the adapter; it is NOT exercised by a live-network test)
- Prompt templating, system-prompt injection, guardrails, content moderation

## Module surface

### Public barrel (`apps/library/src/chat/index.ts`)

Re-exports only:

- `ChatFacade`
- `ChatModule`
- `ChatMessage` — `{ role: 'user' | 'assistant' | 'system'; content: string }`
- `ChatDelta` — `{ text: string }`
- `ChatRequest` — `{ messages: ChatMessage[] }`
- `InvalidChatRequestError`
- `ChatStreamError` — terminal-error signal carried inside the stream; distinct from a pre-flight validation error

NOT exported from the barrel:

- `ChatGateway` port (lives under `src/shared/chat-gateway/`, same placement rule as `IsbnLookupGateway`)
- `InMemoryChatGateway`, `OpenAiChatGateway` (adapters)
- Zod schemas (`chat.schema.ts` is module-internal)
- `ChatController` (HTTP adapter — module-internal, Nest instantiates it)

### Port

```ts
// apps/library/src/shared/chat-gateway/chat-delta.ts
export type ChatDelta = { text: string };

// apps/library/src/shared/chat-gateway/chat-gateway.ts
import type { ChatMessage } from '../../chat/chat.types.js';
import type { ChatDelta } from './chat-delta.js';

export interface ChatGateway {
  stream(messages: ChatMessage[]): AsyncIterable<ChatDelta>;
}
```

> **Streaming type decision.** Port and in-memory adapter expose `AsyncIterable<ChatDelta>`. The controller converts to `Observable<MessageEvent>` at the `@Sse()` boundary via `from(asyncIterable).pipe(map(...))`. Rationale: `AsyncIterable` keeps the port free of rxjs, makes the in-memory default a plain `async *stream()` generator (trivial to read), and aligns with how the OpenAI SDK exposes its streams. The rxjs conversion is a single-line adapter, local to the controller.

### Facade

```ts
// apps/library/src/chat/chat.facade.ts
export class ChatFacade {
  constructor(gateway: ChatGateway = new InMemoryChatGateway()) {}

  // Consumed by the controller; validates, then delegates to the gateway.
  // Emits a terminal { type: 'error', message } frame when the gateway throws
  // mid-stream, instead of re-throwing — keeping the stream's wire contract honest.
  streamChat(request: unknown): AsyncIterable<ChatFrame>;
}

type ChatFrame =
  | { type: 'delta'; text: string }
  | { type: 'done' }
  | { type: 'error'; message: string };
```

### Nest wiring

`chat.module.ts` registers a `ChatGateway` provider keyed by `Symbol('ChatGateway')`, with a `useFactory` that inspects `process.env.OPENAI_API_KEY`: present → `new OpenAiChatGateway(...)`; absent → `new InMemoryChatGateway()`. `ChatFacade` is provided via factory that injects the gateway. `ChatController` declares `@Controller('chat')` and one SSE handler. `AppModule` imports `ChatModule`; no `DatabaseModule` dependency.

---

## Slice 1 — `DomainErrorFilter` tidy: `Invalid*Error` → 400

`Invalid*Error` classes today fall through to 500 via the filter's default branch — a latent bug. Add a fourth error-class array (`INVALID_REQUEST_ERRORS`) that maps to `HttpStatus.BAD_REQUEST`. Ship as its own slice/commit because it changes observable HTTP behaviour for the existing Catalog and Membership modules.

**Touched files:**
- `apps/library/src/shared/http/domain-error.filter.ts` — add `INVALID_REQUEST_ERRORS` array containing `InvalidBookError`, `InvalidCopyError`, `InvalidMemberError`; branch in `statusFor` returning 400
- `apps/library/src/shared/http/domain-error.filter.spec.ts` — add unit tests asserting 400 mapping for each `Invalid*Error`
- Any existing Catalog / Membership test that currently asserts ≥500 (or exactly 500) when an `Invalid*Error` surfaces through HTTP — flip the expectation to 400

**Acceptance criteria:**

- [x] AC-1.1: `DomainErrorFilter` maps `InvalidBookError` to HTTP 400 with body `{ statusCode: 400, error: 'InvalidBookError', message: <original> }`.
- [x] AC-1.2: `DomainErrorFilter` maps `InvalidCopyError` to HTTP 400 with body `{ statusCode: 400, error: 'InvalidCopyError', message: <original> }`.
- [x] AC-1.3: `DomainErrorFilter` maps `InvalidMemberError` to HTTP 400 with body `{ statusCode: 400, error: 'InvalidMemberError', message: <original> }`.
- [x] AC-1.4: Existing 404 / 409 / 500 mappings still pass — no regression in `domain-error.filter.spec.ts` for Fines / Catalog / Membership / Lending error classes.
- [x] AC-1.5: Before merging this slice, grep `apps/library/` for any test asserting `.status).toBe(500)`, `.toBeGreaterThanOrEqual(500)`, or `INTERNAL_SERVER_ERROR` against an `Invalid*Error` scenario and update the expectation to 400. (The one `>= 500` assertion in `lending.return-loan.integration.spec.ts:78` is for a transaction-rollback repository failure — NOT an `Invalid*Error` — and MUST remain unchanged.)
- [x] AC-1.6: The filter's `INVALID_REQUEST_ERRORS` array is declared at module scope, alongside `NOT_FOUND_ERRORS` and `CONFLICT_ERRORS`, with the same shape (`ReadonlyArray<new (...args: never[]) => Error>`). Consistent structure — no special-casing.
- [x] AC-1.7: Unit tests live in `domain-error.filter.spec.ts` in a new `describe('DomainErrorFilter — Invalid* mappings', …)` block; existing `describe('DomainErrorFilter — Fines mappings', …)` is unchanged.

**Teaching anchor:** A filter is a lookup table. Extending the table (not branching on message strings, not introspecting `cause`) is what keeps it boring. The chat module benefits from this tidy, but the tidy stands on its own merit regardless of chat.

---

## Slice 2 — Chat core: port, in-memory gateway, facade, Nest module

Build the module's logical shell without any HTTP. Ships a standalone, tested streaming collaborator and a facade that drives it. No `ChatController`, no SSE wiring, no supertest — just unit tests through `ChatFacade` plus adapter-level tests for `InMemoryChatGateway`.

**New files:**
- `apps/library/src/shared/chat-gateway/chat-delta.ts`
- `apps/library/src/shared/chat-gateway/chat-gateway.ts`
- `apps/library/src/shared/chat-gateway/in-memory-chat-gateway.ts`
- `apps/library/src/shared/chat-gateway/in-memory-chat-gateway.spec.ts`
- `apps/library/src/chat/chat.types.ts` — `ChatMessage`, `ChatRequest`, `InvalidChatRequestError`, `ChatStreamError`, internal `ChatFrame` union
- `apps/library/src/chat/chat.schema.ts` — zod schemas + `parseChatRequest(input: unknown): ChatRequest`
- `apps/library/src/chat/chat.facade.ts`
- `apps/library/src/chat/chat.facade.spec.ts` (happy-path + validation tests; gateway-failure tests arrive in Slice 5)
- `apps/library/src/chat/chat.configuration.ts` — `createChatFacade(overrides?: { gateway?: ChatGateway }): ChatFacade`
- `apps/library/src/chat/chat.module.ts`
- `apps/library/src/chat/sample-chat-data.ts` — `sampleUserMessage(content = 'hello')`, `sampleChatRequest(overrides = {})`
- `apps/library/src/chat/index.ts` — barrel (see Module surface above)

**Touched files:**
- `apps/library/src/app.module.ts` — add `ChatModule` to `imports`

**In-memory seeding API:** `reply(lastUserMessage: string, deltas: ChatDelta[])`. The adapter inspects the last message in the incoming `messages[]`; if its `role === 'user'` and `content` matches a seeded key, it streams the seeded deltas in order. Unseeded prompts yield a single pre-configured default sequence (one delta `{ text: '…' }` then done) so happy-path tests that don't care about prompt correlation stay terse. Rationale: mirrors real LLM behaviour (response depends on input); one adapter instance can script distinct responses per prompt; no interference between tests in the same `describe`.

**Acceptance criteria:**

- [x] AC-2.1: `InMemoryChatGateway.stream(messages)` is an `async *` generator returning `AsyncIterable<ChatDelta>`. Called with seeded deltas for `'hello'`, it yields each delta in order and then completes.
- [x] AC-2.2: `InMemoryChatGateway.reply(userContent, deltas)` scopes deltas to the given last-user-message content. Two distinct seeded prompts route to their own delta sequences when each is streamed in turn.
- [x] AC-2.3: When `stream()` is called with messages whose last user message is unseeded, the adapter yields a default single-delta sequence (documented in the spec file header); the generator completes normally.
- [x] AC-2.4: `ChatFacade.streamChat(dto)` validates via `parseChatRequest`, delegates to the gateway, and yields frames in this order: zero or more `{ type: 'delta', text }`, then exactly one terminal `{ type: 'done' }`, then completes.
- [x] AC-2.5: `parseChatRequest` rejects a request with `messages.length === 0` by throwing `InvalidChatRequestError` whose message names the failing constraint (e.g. "messages must contain at least one entry"). `ZodError` never leaks past the facade.
- [x] AC-2.6: `parseChatRequest` rejects a message whose `role` is not one of `'user' | 'assistant' | 'system'` with `InvalidChatRequestError`.
- [x] AC-2.7: `parseChatRequest` rejects a message whose `content` is empty or whitespace-only with `InvalidChatRequestError`. Surrounding whitespace on non-empty content is trimmed.
- [x] AC-2.8: `parseChatRequest` rejects a body missing `messages` entirely (e.g. `{}`) with `InvalidChatRequestError`.
- [x] AC-2.9: `createChatFacade({ gateway })` uses the supplied gateway; omitting `gateway` falls back to a fresh `InMemoryChatGateway()`.
- [x] AC-2.10: `ChatModule` registers a `ChatGateway` provider keyed on `Symbol('ChatGateway')` and injects it into `ChatFacade` via `useFactory`. The factory reads `process.env.OPENAI_API_KEY`; when unset it instantiates `InMemoryChatGateway`. (Real adapter instantiation arrives in Slice 4 — Slice 2 ships with the factory already branching but with the "present" branch throwing `new Error('OpenAI adapter not wired yet')` or returning in-memory; exact placeholder verified during planning.)
- [x] AC-2.11: `AppModule` imports `ChatModule` and the application boots (`pnpm --filter library build` plus a Nest `Test.createTestingModule` compile step in a spec passes) with no unresolved provider errors.
- [x] AC-2.12: The barrel `apps/library/src/chat/index.ts` exports exactly `ChatFacade`, `ChatModule`, `ChatMessage`, `ChatDelta`, `ChatRequest`, `InvalidChatRequestError`, `ChatStreamError` — and does NOT export `ChatGateway`, `InMemoryChatGateway`, any zod schema, or `ChatController`.
- [x] AC-2.13: `sample-chat-data.ts` exposes `sampleUserMessage(content = 'hello')` and `sampleChatRequest(overrides: Partial<ChatRequest> = {})` following the established sample-data-builder convention.

**Teaching anchor:** A streaming port is an ordinary interface that returns `AsyncIterable`. The in-memory default is an `async *` generator. No frameworks, no DI gymnastics, no stream libraries. `ChatFacade` is a plain orchestrator; validation happens once at the boundary; the gateway stays narrow.

---

## Slice 3 — HTTP SSE endpoint + integration test

Expose the facade over `POST /chat` as an SSE stream. This slice wires the Nest controller, bridges `AsyncIterable<ChatFrame>` to `Observable<MessageEvent>`, and ships a crucial-path integration test via supertest (no Docker, no Postgres).

**New files:**
- `apps/library/src/chat/chat.controller.ts`
- `apps/library/test/support/interactions/chat-interactions.ts` — `streamChat(app, body): Promise<ParsedSseResponse>`, where `ParsedSseResponse` is `{ status: number; frames: Array<{ event: string; data: unknown }> }` parsed from the raw buffered body
- `apps/library/test/chat.crucial-path.integration.spec.ts` — real Nest app via `app-factory.ts`, no `dockerIsAvailable()` guard

**Per GUIDE.md "Controller unit specs — when they earn their keep", the chat controller is skipped at unit level** (single endpoint, adapter-only logic: DTO-in / Observable-out). The crucial-path integration test covers the wire contract end to end.

**Acceptance criteria:**

- [x] AC-3.1: `ChatController` declares `@Controller('chat')` and exposes one handler that (a) accepts the request body, (b) returns `Observable<MessageEvent>` where each `MessageEvent` carries `type: 'delta' | 'done' | 'error'` and a `data` object matching the wire contract. The exact decorator composition for POST-body + SSE-response (e.g. `@Post() @Sse()` vs `@Sse()` on a POST path vs a manual `@Res()` + `response.write` fallback) is determined during TDD planning once the decorator's runtime behaviour is confirmed; the spec pins BEHAVIOUR, not decorator choice.
- [x] AC-3.2: `POST /chat` with `{ messages: [{ role: 'user', content: 'hello' }] }` against an app whose `InMemoryChatGateway` is seeded for `'hello'` with deltas `[{text: 'hi'}, {text: ' there'}]` returns HTTP 200, `Content-Type: text/event-stream`, and a body containing `event: delta\ndata: {"text":"hi"}\n\n`, then `event: delta\ndata: {"text":" there"}\n\n`, then `event: done\ndata: {}\n\n`, in that order.
- [x] AC-3.3: `POST /chat` with an invalid body (`{}` — missing `messages`) returns HTTP 400 with the `DomainErrorFilter` JSON body `{ statusCode: 400, error: 'InvalidChatRequestError', message: <msg> }`. No SSE framing — plain JSON 400 (validation runs before the stream opens).
- [x] AC-3.4: `POST /chat` with `{ messages: [{ role: 'user', content: '   ' }] }` returns HTTP 400 `InvalidChatRequestError` — whitespace-only content fails validation.
- [x] AC-3.5: `POST /chat` with `{ messages: [{ role: 'bot', content: 'hi' }] }` returns HTTP 400 `InvalidChatRequestError` — invalid role.
- [x] AC-3.6: `chat-interactions.ts` exposes `streamChat(app, body)` that issues the POST with `Accept: text/event-stream`, buffers the full body (supertest `.buffer(true).parse(...)` style), parses it into an ordered `frames[]` of `{ event, data }` where `data` is `JSON.parse`'d, and returns alongside the HTTP status. The parser tolerates CRLF vs LF line endings and handles `data:` lines preceded by a matching `event:` line.
- [x] AC-3.7: The integration test file is `chat.crucial-path.integration.spec.ts` and uses a plain `describe(...)` block — NOT `describe.skip(...)` and NOT gated on `dockerIsAvailable()` (chat has no DB).
- [x] AC-3.8: The integration test boots a real Nest app via `apps/library/test/support/app-factory.ts`, overrides the `ChatGateway` provider with a pre-seeded `InMemoryChatGateway` for test determinism (no network), and runs in the default `pnpm test` sweep without extra infra.
- [x] AC-3.9: After the `done` frame, the HTTP response is closed — no trailing frames, no hanging connection beyond the stream completion.
- [x] AC-3.10: The integration spec covers at minimum: (a) happy path with multiple deltas then done, (b) single-delta happy path, (c) 400 on missing `messages`, (d) 400 on invalid role — validation edge. (The gateway-failure → terminal-error-frame integration case ships in Slice 5, which depends on `ThrowingOnceChatGateway`.)

**Teaching anchor:** The HTTP adapter is thin — it validates, calls the facade, maps frames onto Nest's `MessageEvent` shape, and lets rxjs handle transport. The integration test proves the wire contract the docs claim, without Docker, without Postgres, without mocks.

---

## Slice 4 — Real OpenAI adapter behind an env flag

Ship a real `OpenAiChatGateway` that adapts the OpenAI Node SDK's streaming chat-completions response to `AsyncIterable<ChatDelta>`. Selection is env-driven: `OPENAI_API_KEY` present → real adapter; absent → in-memory. No live-network tests are added; default `pnpm test` remains network-free.

**Touched files:**
- `apps/library/package.json` — add `openai` npm dependency (latest major compatible with Node ≥20 and TS strict; version pinned during implementation)
- `apps/library/src/shared/chat-gateway/openai-chat-gateway.ts` — new file, `implements ChatGateway`
- `apps/library/src/chat/chat.module.ts` — factory branches on `process.env.OPENAI_API_KEY`
- `apps/library/src/chat/chat.configuration.ts` — factory helper reused in the module (optional, keeps Nest wiring symmetric with Catalog's pattern)

**Acceptance criteria:**

- [x] AC-4.1: `openai` appears in `apps/library/package.json` `dependencies`, and `pnpm --filter library install` + `pnpm --filter library build` succeed.
- [x] AC-4.2: `OpenAiChatGateway` implements `ChatGateway`. Its `stream(messages)` returns an `AsyncIterable<ChatDelta>` that translates each OpenAI streaming chunk's `choices[0].delta.content` into `{ text: content }`, skipping chunks whose `delta.content` is undefined/empty.
- [x] AC-4.3: `OpenAiChatGateway` maps the input `ChatMessage[]` onto the OpenAI SDK's request shape (`{ role, content }` per message, plus a single hard-coded default model name documented in the file) before invoking `client.chat.completions.create({..., stream: true})`.
- [x] AC-4.4: `ChatModule`'s `ChatGateway` factory returns `new OpenAiChatGateway(...)` when `process.env.OPENAI_API_KEY` is a non-empty string, and `new InMemoryChatGateway()` otherwise. The factory reads the env var once at provider instantiation time.
- [x] AC-4.5: Existing `InMemoryChatGateway` behaviour is unchanged. `pnpm test` run with `OPENAI_API_KEY` unset continues to pass exactly as it did after Slice 3 — no test hits the network.
- [x] AC-4.6: NO new unit test or integration test exercises the real OpenAI API. A thin unit-level smoke test MAY verify the factory selection (env set → returns OpenAI adapter instance; env unset → returns in-memory instance) without invoking `.stream()`.
- [x] AC-4.7: `OpenAiChatGateway` errors (network, auth, rate-limit, malformed upstream chunk) are not caught inside the adapter — they propagate out of the async iterator and are handled by the facade's error-framing logic (which Slice 5 pins down with its terminal-error test).
- [x] AC-4.8: `apps/library/.env.example` (if present; create if not) documents `OPENAI_API_KEY` with a comment noting it is optional and that absence yields the in-memory default. If an `.env` convention doesn't exist in the repo, document the variable in the chat module header comment instead.

**Teaching anchor:** The real adapter is a 30-line translation layer — the port stays stable, the facade stays ignorant of OpenAI, and the default (in-memory) keeps the test suite fast and network-free. This is the payoff of the port + in-memory pattern: adding the real adapter is a boring mechanical step.

---

## Slice 5 — `ThrowingOnceChatGateway` error path + docs

The streaming-port twin of `ThrowingOnceIsbnLookupGateway`. Spec-local fault-injection wrapper, one HTTP-level integration test that proves the terminal `event: error` frame, GUIDE.md Principle 13 gets written, and the rest of the teaching docs are updated so the pattern is discoverable.

**Touched files:**
- `apps/library/src/chat/chat.facade.spec.ts` — add `ThrowingOnceChatGateway` at the bottom of the file (spec-local, not exported) and a new `describe('chat — gateway failures', …)` block
- `apps/library/test/chat.crucial-path.integration.spec.ts` — add one test covering the terminal-error-frame wire contract
- `GUIDE.md` — new Principle 13 ("Streaming gateways — how do we test a streaming port in-memory?"). Extend Principle 5's outbound-gateways subsection with a streaming cross-reference.
- `docs/FEATURES.md` — new Chat section (one paragraph) + one row in the HTTP-surface table (`POST /chat` — "Stream a chat completion as SSE.")
- `.claude/skills/nabrdalik-module-tests/SKILL.md` — checklist item for streaming outbound gateways

**Wrapper shape (illustrative, mirroring `ThrowingOnceIsbnLookupGateway`):**

```ts
class ThrowingOnceChatGateway implements ChatGateway {
  private armedError: Error | null = null;
  private armedPhase: 'before-stream' | 'mid-stream' = 'before-stream';
  constructor(private readonly delegate: ChatGateway) {}

  armFailureBeforeStream(error: Error): void { /* set armedError, phase=before-stream */ }
  armFailureMidStream(error: Error): void    { /* set armedError, phase=mid-stream    */ }

  async *stream(messages: ChatMessage[]): AsyncIterable<ChatDelta> {
    if (this.armedError && this.armedPhase === 'before-stream') {
      const err = this.armedError; this.armedError = null; throw err;
    }
    for await (const delta of this.delegate.stream(messages)) {
      if (this.armedError && this.armedPhase === 'mid-stream') {
        const err = this.armedError; this.armedError = null; throw err;
      }
      yield delta;
    }
  }
}
```

**Acceptance criteria:**

- [x] AC-5.1: `ThrowingOnceChatGateway` is declared inside `chat.facade.spec.ts`, implements `ChatGateway`, is single-shot (arms clear themselves after firing), and is NOT exported from any barrel.
- [x] AC-5.2: When `armFailureBeforeStream(err)` is armed and the facade streams, the facade-level frame sequence is exactly `[{ type: 'error', message: <err.message> }]` (no `done` frame follows an error frame). The facade emits the error frame and completes normally — it does NOT re-throw.
- [x] AC-5.3: When `armFailureMidStream(err)` is armed AFTER the first delta has yielded, the facade-level frame sequence is `[{ type: 'delta', … }, { type: 'error', message: <err.message> }]` — prior deltas are delivered, then a terminal error frame, then completion. No `done` frame follows the error frame.
- [x] AC-5.4: Negative control — after an armed failure fires once, the NEXT `streamChat` call on the same facade succeeds end to end (single-shot arming; no stale state).
- [x] AC-5.5: The `chat.crucial-path.integration.spec.ts` file gains one test: with a `ThrowingOnceChatGateway` armed mid-stream, `POST /chat` returns HTTP 200 (SSE already committed) with a buffered body containing `event: delta` frames followed by `event: error\ndata: {"message":"..."}\n\n` and no trailing `event: done`.
- [x] AC-5.6: `GUIDE.md` gains a new Principle 13 titled "Streaming gateways — how do we test a streaming port in-memory?". The body references `ChatGateway`, `InMemoryChatGateway` (seeding API), `ThrowingOnceChatGateway`, and the terminal-`event: error` wire contract. It cross-links Principle 5.
- [x] AC-5.7: `GUIDE.md` Principle 5's outbound-gateways subsection gains a line that references Principle 13 as the streaming extension ("Request/response gateways: `IsbnLookupGateway`. Streaming gateways: `ChatGateway` — see Principle 13.").
- [x] AC-5.8: `docs/FEATURES.md` gains a new "Chat — 'ask a question, stream a completion'" section (one paragraph explaining stateless passthrough, the `messages[]` contract, and the in-memory-as-default note) and one new row in the HTTP-surface table: `POST /chat` — "Stream a chat completion as Server-Sent Events." Chat is NOT added to the 4-module overview table at the top; the paragraph acknowledges it as an auxiliary capability, not a fifth domain module.
- [x] AC-5.9: `.claude/skills/nabrdalik-module-tests/SKILL.md` gains a checklist item: "when the facade calls a streaming outbound gateway, inject an in-memory scripted adapter and add a spec-local `ThrowingOnce*` wrapper for the error path." The workflow section mentions that streaming ports follow the same `src/shared/<gateway-name>/` placement rule.
- [x] AC-5.10: All existing tests still pass unchanged after this slice. The only test file newly modified is `chat.facade.spec.ts` (wrapper + failure `describe`) and `chat.crucial-path.integration.spec.ts` (one added test).

**Teaching anchor:** Streaming doesn't break the pattern. A gateway is still an interface; an in-memory adapter is still a class; fault injection is still a tiny wrapper declared next to the tests that use it. The only new wrinkle is that "the error" has a wire-format representation (`event: error` frame) because SSE commits a 200 before any content is sent — that constraint is pinned down in one test and documented in Principle 13.

---

## Technical Context

- **Patterns to follow:**
  - `apps/library/src/shared/isbn-gateway/` — port + in-memory + DTO file placement; this feature mirrors it structurally.
  - `ThrowingOnceIsbnLookupGateway` in `catalog.facade.spec.ts` (lines ~551-573) — the wrapper shape, the `armFailureOnNext*` API, the single-shot self-clearing semantics.
  - `catalog.configuration.ts` — factory helper pattern for `createChatFacade({ gateway })`.
  - `catalog.schema.ts` — zod-at-facade-boundary, `parseXxx` helper, `InvalidXxxError` translation.
  - `catalog.module.ts` — `Symbol`-keyed provider + `useFactory` wiring.
  - `docs/specs/isbn-gateway-spec.md` — closest structural template for this spec itself.

- **Key dependencies:**
  - No new runtime dependencies in Slices 1-3 (rxjs is already a Nest peer).
  - Slice 4 adds the `openai` npm package.
  - No new test infrastructure — Vitest, supertest, existing `app-factory.ts` cover it all. The SSE integration test uses supertest's `.buffer(true).parse(...)` to capture the raw stream body (no `.sse()` helper exists).

- **Risk level:** MODERATE. Streaming over HTTP introduces wire-contract surface the other modules don't have; `@Sse()` interaction with `@Post()` is the one decorator detail to verify during TDD planning, and the terminal-error-frame semantics must be implemented deliberately (Nest does NOT emit an explicit error event when an Observable errors — the facade shapes the error frame BEFORE Nest sees it).

- **Independently shippable:** Slice 1 ships a 400-mapping tidy that stands on its own and improves the existing modules. Slice 2 ships a tested-but-unused core (no HTTP). Slice 3 ships the wire contract + happy-path integration test. Slice 4 ships the real adapter behind an env flag — default path unchanged. Slice 5 ships the teaching moment + docs. Each slice's tests pass in isolation at its own commit boundary.

- **Teaching anchor (repeat for emphasis):** Chat exists to answer "how do we test a **streaming** outbound gateway in-memory?" Slice 5 is the canonical answer; everything else scaffolds it.

---

[x] Reviewed
