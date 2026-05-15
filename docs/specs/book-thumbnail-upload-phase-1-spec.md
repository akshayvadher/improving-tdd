# Spec: Book Thumbnail Upload — Phase 1 (in-memory walking skeleton)

## Overview

Staff users can attach, read, and remove a single cover thumbnail on an existing book through `CatalogFacade`, with byte-level safety (magic-byte mime sniff, 2 MB size cap, content-hash idempotency) and write-through cache coherence. Phase 1 is in-memory only: no HTTP controller, no DB migration, no multipart. The full lifecycle is verifiable through `catalog.facade.spec.ts` against in-memory collaborators.

## Phase Boundary

This spec covers **Phase 1** from `docs/specs/book-thumbnail-upload-discovery.md` (Milestone Map, slices 1–6 of the proposed ordering). Phase 2 (HTTP wiring, Drizzle mapper changes, `0004_*.sql` migration, multipart, crucial-path integration spec) is **out of scope** and has its own spec.

## Decisions (defaults taken without re-asking)

1. **Action naming — two separate policy actions: `uploadThumbnail` and `removeThumbnail`.** Removing a thumbnail may diverge from uploading later (e.g., admin-only removal, audit hooks), and the data-driven `POLICY` map costs nothing per action. A combined `manageThumbnail` would have to be split the first time the two diverge.
2. **Idempotent removal — no-op when no thumbnail is attached.** Mirrors HTTP DELETE semantics (DELETE on a missing resource is a no-op, not an error) and means a Phase 2 controller doesn't have to translate a domain error into 204. The book must still exist; `removeThumbnail` on an unknown book throws `BookNotFoundError`.
3. **`BookDto` gains the optional `thumbnail` subobject in Phase 1; Drizzle mapper + migration deferred to Phase 2.** Slice 5's cache integration only makes sense if *something observable* changes when `attachThumbnail` mutates the book — and `cache.set(isbn, book)` only matters if the cached value is different. Keeping the thumbnail metadata invisible at the `BookDto` level would make the write-through assertion vacuous. The `BookDto.thumbnail` field is optional and absent when no thumbnail is attached, preserving backward compatibility for existing consumers. The Drizzle `toBookRow` / `toBookDto` mappers and the `0004_*.sql` migration are still Phase 2 — in Phase 1, only the in-memory repo round-trips the field.
4. **`FileStorageGateway` port keyed by content hash.** Idempotency lives in the gateway, not the facade: `put(contentHash, bytes, mimeType)` is a no-op if the hash is already stored. The facade asks the gateway to store; the gateway reports whether the bytes were new or already present. This keeps the facade thin and lets a future S3 adapter compute and check the hash before uploading.
5. **`ThumbnailNotFoundError` only on `readThumbnail`.** `readThumbnail` against a book without a thumbnail is a genuine "not found" — the caller asked for bytes that don't exist. `removeThumbnail` against the same state is the no-op above. Different verbs, different semantics.

## Slice 1: `STAFF` role precursor

Introduce the `STAFF` role variant and a `catalog` policy block, with no catalog facade changes yet. Pure cross-cutting plumbing.

### Acceptance Criteria

- [x] `Role` in `access-control.types.ts` includes `'STAFF'` as a third variant alongside `'MEMBER'` and `'ACCOUNT'`.
- [x] `POLICY` in `access-control/policy.ts` has a new `catalog` block with `uploadThumbnail: ['STAFF']` and `removeThumbnail: ['STAFF']`.
- [x] `sample-access-control-data.ts` exposes a `STAFF`-roled `AuthUser` sample (e.g., `sampleStaffAuthUser(overrides = {})`) following the existing override-spread builder convention.
- [x] `auth-context.ts`'s `setRoleForDemo` (and any role-aware seed) accepts `'STAFF'` without runtime narrowing failures.
- [x] `AccessControlFacade.authorize(staffUser, 'catalog', 'uploadThumbnail')` returns without throwing.
- [x] `AccessControlFacade.authorize(memberUser, 'catalog', 'uploadThumbnail')` throws `UnauthorizedRoleError`.
- [x] `AccessControlFacade.authorize(staffUser, 'catalog', 'uploadThumbnail')` and the equivalent for `removeThumbnail` are both covered in `access-control.facade.spec.ts`.
- [x] No `catalog/` source file changes in this slice.

## Slice 2: `FileStorageGateway` port + `InMemoryFileStorageGateway`

Add the shared gateway under `apps/library/src/shared/file-storage-gateway/`, following the proven `isbn-gateway` / `book-cache-gateway` / `chat-gateway` recipe. Co-located spec. Not wired into catalog yet.

### Acceptance Criteria

- [x] `shared/file-storage-gateway/file-storage-gateway.ts` exports a pure `FileStorageGateway` interface with no Nest decorators.
- [x] The interface includes `put(contentHash, bytes, mimeType): Promise<{ contentHash: string; alreadyExisted: boolean }>`, `get(contentHash): Promise<{ bytes: Uint8Array; mimeType: string } | null>`, and `remove(contentHash): Promise<void>`.
- [x] `shared/file-storage-gateway/in-memory-file-storage-gateway.ts` exports `InMemoryFileStorageGateway` backed by a `Map<string, { bytes: Uint8Array; mimeType: string }>`.
- [x] `put` with a hash not yet stored writes the bytes and returns `{ contentHash, alreadyExisted: false }`.
- [x] `put` with a hash already stored does not overwrite (no second write, no error) and returns `{ contentHash, alreadyExisted: true }`.
- [x] `get` with a stored hash returns the exact bytes (byte-identical `Uint8Array`) and the original `mimeType`.
- [x] `get` with an unknown hash returns `null`.
- [x] `remove` with a stored hash deletes the entry and a subsequent `get` returns `null`.
- [x] `remove` with an unknown hash is a no-op (no throw).
- [x] `shared/file-storage-gateway/in-memory-file-storage-gateway.spec.ts` covers all of the above against the in-memory implementation directly.
- [x] The gateway is **not** re-exported from any module barrel (`catalog/index.ts`, `shared/*/index.ts` if present).
- [x] No catalog wiring in this slice — the facade does not yet take `fileStorage` as a constructor dependency.

## Slice 3: `CatalogFacade.attachThumbnail` (in-memory)

Add the write side of the lifecycle. Dedicated `parseThumbnailUpload` schema (not `UpdateBookSchema`), magic-byte mime sniff, 2 MB size cap, content-hash idempotency. Authorize via injected `AccessControlFacade` on the first line.

### Acceptance Criteria — wiring

- [x] `CatalogFacade` constructor gains a `fileStorage: FileStorageGateway = new InMemoryFileStorageGateway()` parameter and an `accessControl: AccessControlFacade` parameter (no default — must be injected).
- [x] `catalog.configuration.ts` overrides interface gains `fileStorageGateway?: FileStorageGateway` and `accessControl?: AccessControlFacade`, both with sensible defaults (`new InMemoryFileStorageGateway()` and a fresh `AccessControlFacade` from `createAccessControlFacade()`).
- [x] `catalog.module.ts` declares a file-scoped `const FILE_STORAGE_GATEWAY = Symbol('FileStorageGateway')` token and provides the in-memory adapter via `useFactory`.
- [x] `catalog.module.ts` adds `imports: [AccessControlModule]` and injects `AccessControlFacade`.
- [x] `index.ts` (catalog barrel) is unchanged regarding the gateway — only the new error class and the `thumbnail` types are added.

### Acceptance Criteria — `parseThumbnailUpload` schema

- [x] `catalog.schema.ts` exports a `parseThumbnailUpload` helper, separate from `parseUpdateBook`, that takes `{ bytes: Uint8Array; declaredMimeType: string }` and returns `{ bytes: Uint8Array; mimeType: 'image/jpeg' | 'image/png' | 'image/webp'; contentHash: string; byteLength: number }`.
- [x] `parseThumbnailUpload` throws `InvalidThumbnailError` (new domain error in `catalog.types.ts`) when `bytes.byteLength` exceeds 2 MB (2 * 1024 * 1024).
- [x] `parseThumbnailUpload` throws `InvalidThumbnailError` when `bytes.byteLength` is 0.
- [x] `parseThumbnailUpload` sniffs the real mime type from magic bytes: JPEG starts with `FF D8 FF`; PNG starts with `89 50 4E 47 0D 0A 1A 0A`; WebP has `52 49 46 46 ?? ?? ?? ?? 57 45 42 50` at offsets 0–11.
- [x] `parseThumbnailUpload` throws `InvalidThumbnailError` with reason `'mime mismatch'` when the declared mime type does not match the sniffed mime type (e.g., declared `image/jpeg`, bytes are PNG).
- [x] `parseThumbnailUpload` throws `InvalidThumbnailError` with reason `'unsupported mime'` when the sniffed type is not one of jpeg/png/webp (e.g., PDF magic `25 50 44 46`).
- [x] `parseThumbnailUpload` computes `contentHash` as the lowercase hex SHA-256 of the bytes.
- [x] `InvalidThumbnailError` exposes a `reason: string` field (mirroring `InvalidBookError`) so callers can distinguish `'oversize'`, `'empty'`, `'mime mismatch'`, `'unsupported mime'`.

### Acceptance Criteria — `CatalogFacade.attachThumbnail`

- [x] `CatalogFacade.attachThumbnail(authUser, bookId, { bytes, declaredMimeType })` exists with this signature and returns `Promise<BookDto>`.
- [x] The method's first line is `await this.accessControl.authorize(authUser, 'catalog', 'uploadThumbnail')` (mirroring `LendingFacade.borrow`).
- [x] A `MEMBER` or `ACCOUNT` caller causes the method to throw `UnauthorizedRoleError` before any repository or gateway call.
- [x] `attachThumbnail` calls `parseThumbnailUpload` before any repository or gateway call, so an oversize / wrong-mime upload throws `InvalidThumbnailError` before storage is touched.
- [x] `attachThumbnail` against an unknown `bookId` throws `BookNotFoundError` and writes nothing to the file-storage gateway.
- [x] On the happy path, `attachThumbnail` calls `fileStorage.put(contentHash, bytes, mimeType)` exactly once and saves the book with the new `thumbnail` metadata via `repository.saveBook`.
- [x] The returned `BookDto` includes a `thumbnail` subobject: `{ contentHash, mimeType, byteLength }`.
- [x] Re-uploading the **same bytes** for the same `bookId` returns a `BookDto` whose `thumbnail.contentHash` equals the previous one, does not write to the gateway a second time (asserted by `alreadyExisted: true` from the gateway, or by the byte map having exactly one entry), and does not throw.
- [x] Uploading **different bytes** for a book that already has a thumbnail replaces the metadata on the book (new `contentHash`); the old hash's bytes remain in the gateway in Phase 1 (orphan cleanup is a Phase 2 / Phase 3 concern and is called out in "Out of Scope" below).

### Acceptance Criteria — facade spec

- [x] `catalog.facade.spec.ts` adds a `describe('attachThumbnail')` block covering: happy path (returns `BookDto` with thumbnail metadata); rejects oversize (2 MB + 1 byte); rejects wrong-mime (PDF bytes declared as `image/jpeg`); rejects mime mismatch (PNG bytes declared as `image/jpeg`); idempotent re-upload (same bytes, one gateway write); `BookNotFoundError` for unknown book; `UnauthorizedRoleError` for non-staff caller.
- [x] The spec uses the `catalog.configuration.ts` factory (`createCatalogFacade({ ... })`) — no `vi.mock`, no controller, no DB.
- [x] A new `sampleThumbnailBytes(overrides = {})` builder in `sample-catalog-data.ts` (or co-located in the spec if it doesn't belong in the public sample data) returns valid PNG bytes (`89 50 4E 47 0D 0A 1A 0A` + minimal IHDR + IEND chunks) so tests don't ship base64 blobs.
- [x] A spec-local `ThrowingOnceFileStorageGateway` wrapper exists (mirroring `ThrowingOnceBookCacheGateway` shape at `catalog.facade.spec.ts:1066-1111`) but is not exported from any barrel. It is used in slice 5; declared in slice 3 so the shape is locked in.

## Slice 4: `CatalogFacade.readThumbnail` and `removeThumbnail`

Round out the lifecycle. Both go through the facade, both authorize where the policy says they should (`readThumbnail` is unauthenticated in Phase 1 — anyone reading a book can see its cover; `removeThumbnail` is staff-only).

### Acceptance Criteria — `readThumbnail`

- [x] `CatalogFacade.readThumbnail(bookId): Promise<{ bytes: Uint8Array; mimeType: string; contentHash: string; byteLength: number }>` exists.
- [x] `readThumbnail` does **not** call `accessControl.authorize` — reads are open. (Documented here so reviewers don't add a guard by reflex.)
- [x] `readThumbnail` against an unknown `bookId` throws `BookNotFoundError`.
- [x] `readThumbnail` against a known book that has no thumbnail throws `ThumbnailNotFoundError` (new domain error in `catalog.types.ts`, exposing `bookId`).
- [x] `readThumbnail` against a known book with a thumbnail returns the bytes byte-identical to what was put via `attachThumbnail`, plus the stored `mimeType`, `contentHash`, and `byteLength`.

### Acceptance Criteria — `removeThumbnail`

- [x] `CatalogFacade.removeThumbnail(authUser, bookId): Promise<BookDto>` exists.
- [x] The method's first line is `await this.accessControl.authorize(authUser, 'catalog', 'removeThumbnail')`.
- [x] A `MEMBER` or `ACCOUNT` caller causes `UnauthorizedRoleError` before any repository or gateway call.
- [x] `removeThumbnail` against an unknown `bookId` throws `BookNotFoundError`.
- [x] `removeThumbnail` against a known book **without** a thumbnail is a no-op: returns the book unchanged, does not call `fileStorage.remove`, does not call `repository.saveBook`, does not throw.
- [x] `removeThumbnail` against a known book **with** a thumbnail clears the `thumbnail` field on the saved book, calls `fileStorage.remove(contentHash)`, and returns a `BookDto` with no `thumbnail` field.
- [x] After `removeThumbnail`, a subsequent `readThumbnail` for the same `bookId` throws `ThumbnailNotFoundError`.

### Acceptance Criteria — `deleteBook` cleanup

- [x] `deleteBook` against a book that has a thumbnail also calls `fileStorage.remove(contentHash)` before deleting the book.
- [x] `deleteBook` against a book without a thumbnail behaves exactly as today (no gateway call beyond the existing cache `evict`).
- [x] The facade spec adds an `deleteBook removes attached thumbnail bytes` case.

### Acceptance Criteria — facade spec

- [x] `catalog.facade.spec.ts` adds `describe('readThumbnail')` and `describe('removeThumbnail')` blocks covering all the cases above.
- [x] The facade spec asserts the full attach → read → remove → read-throws lifecycle in a single test as the canonical happy-path scenario.

## Slice 5: Cache integration

Write-through on `attachThumbnail`; eviction on `removeThumbnail` and the thumbnail-aware path of `deleteBook`. Mirrors the existing `updateBook` / `deleteBook` cache patterns.

### Acceptance Criteria

- [x] `attachThumbnail` calls `cache.set(existing.isbn, updated)` after `repository.saveBook`, mirroring `updateBook` (catalog.facade.ts:75).
- [x] `removeThumbnail` calls `cache.set(existing.isbn, updated)` after saving the book without its thumbnail (the book itself still exists, so we keep it cached — same shape as `updateBook`, not `deleteBook`).
- [x] `deleteBook` continues to call `cache.evict(existing.isbn)` as today; the only new behavior is the `fileStorage.remove` call from slice 4.
- [x] When `cache.set` throws during `attachThumbnail`, the bytes already in `fileStorage` are **not** rolled back in Phase 1 — the cache failure is logged-and-thrown, the book metadata write has already landed, and the gateway state stays. Document this as accepted Phase 1 behavior; revisit in Phase 2 if the crucial-path integration spec surfaces it as a problem.
- [x] After `attachThumbnail`, `findBook(isbn)` returns the cached value including the new `thumbnail` subobject (the cache assertion is what makes Decision 3 worth its weight).
- [x] After `removeThumbnail`, `findBook(isbn)` returns the cached value with no `thumbnail` subobject.
- [x] Facade spec uses `ThrowingOnceBookCacheGateway` to assert that a cache-`set` failure during `attachThumbnail` propagates as the original error and that the gateway state is what it is (test pins the documented behavior, doesn't pretend we have transactions).
- [x] Facade spec uses `ThrowingOnceFileStorageGateway` (declared in slice 3) to assert that a `fileStorage.put` failure during `attachThumbnail` causes the method to throw and **does not** write to the book repository.

## API Shape (indicative)

```ts
// catalog/catalog.types.ts (additions)
export interface BookThumbnailDto {
  contentHash: string; // lowercase hex SHA-256
  mimeType: 'image/jpeg' | 'image/png' | 'image/webp';
  byteLength: number;
}

export interface BookDto {
  bookId: BookId;
  title: string;
  authors: string[];
  isbn: Isbn;
  thumbnail?: BookThumbnailDto; // Phase 1 in-memory only; Phase 2 promotes to DB
}

export class InvalidThumbnailError extends Error {
  readonly reason: string;
  constructor(reason: string) { /* ... */ }
}

export class ThumbnailNotFoundError extends Error {
  constructor(public readonly bookId: BookId) { /* ... */ }
}

// catalog/catalog.facade.ts (additions)
class CatalogFacade {
  attachThumbnail(
    authUser: AuthUser,
    bookId: BookId,
    upload: { bytes: Uint8Array; declaredMimeType: string },
  ): Promise<BookDto>;

  readThumbnail(
    bookId: BookId,
  ): Promise<{ bytes: Uint8Array; mimeType: string; contentHash: string; byteLength: number }>;

  removeThumbnail(authUser: AuthUser, bookId: BookId): Promise<BookDto>;
}

// shared/file-storage-gateway/file-storage-gateway.ts
export interface FileStorageGateway {
  put(
    contentHash: string,
    bytes: Uint8Array,
    mimeType: string,
  ): Promise<{ contentHash: string; alreadyExisted: boolean }>;
  get(contentHash: string): Promise<{ bytes: Uint8Array; mimeType: string } | null>;
  remove(contentHash: string): Promise<void>;
}
```

## Out of Scope for Phase 1

- HTTP endpoints (`POST` / `GET` / `DELETE /books/:bookId/thumbnail`), `multer`, `@types/multer`, `FileInterceptor`, `@UploadedFile()`.
- `multer` declaration in `apps/library/package.json` (Phase 2).
- DB migration `0004_*.sql` adding `thumbnail_content_hash`, `thumbnail_mime_type`, `thumbnail_byte_length` columns to `books`.
- Drizzle `toBookRow` / `toBookDto` mapper updates in `drizzle-catalog.repository.ts` (Phase 2 — the Phase 1 `thumbnail` field lives only in `InMemoryCatalogRepository`).
- Crucial-path integration spec (`test/*.crucial-path.integration.spec.ts`) for the multipart upload path.
- Orphan-byte cleanup: when `attachThumbnail` replaces an existing thumbnail with different bytes, the old bytes remain in `fileStorage`. This is a Phase 3 concern (real prod adapter will have a GC story) and is **not** a Phase 1 leak — in-memory state vanishes with the process.
- Server-side resizing / variants / image manipulation / EXIF stripping / virus scanning.
- Production storage adapter (S3 / local disk).
- Frontend rendering.
- `BookDto` field-level access control (e.g., hiding thumbnails from some roles) — all readers see all thumbnails.

## Technical Context

- **Patterns to follow** (all from `.claude/bee-context.local.md`):
  - Nabrdalik facade-only entry: every Phase 1 AC is reachable through `CatalogFacade` (writes) or directly through the gateway port (slice 2 spec only). No HTTP, no DB, no `vi.mock`.
  - Outbound gateway recipe: port + in-memory adapter + co-located spec under `shared/file-storage-gateway/`; not re-exported from any barrel.
  - Spec-local `ThrowingOnce*` wrappers for fault injection, mirroring `ThrowingOnceIsbnLookupGateway` (`catalog.facade.spec.ts:1041-1058`) and `ThrowingOnceBookCacheGateway` (`catalog.facade.spec.ts:1066-1111`).
  - Configuration factory override pattern: `createCatalogFacade({ fileStorageGateway, accessControl, ... })`.
  - File-scoped `Symbol()` DI tokens at the top of `catalog.module.ts`.
  - `parseX` helper convention: `parseThumbnailUpload` uses `safeParse` (or equivalent direct validation) and throws the domain `InvalidThumbnailError` on failure.
  - Sample builders use override-spread: `sampleThumbnailBytes(overrides = {}) { return { ...defaults, ...overrides }; }`.
- **Key dependencies (existing)**:
  - `AccessControlFacade` (slice 1 prerequisite — `STAFF` role and `catalog` policy block must land first).
  - `BookCacheGateway` (slice 5 — write-through on attach, mirror existing `updateBook` pattern).
  - `node:crypto` for SHA-256 (already used in `catalog.facade.ts:2` for `randomUUID`).
- **Cross-cutting touches**:
  - `access-control.types.ts`, `access-control/policy.ts`, `access-control/sample-access-control-data.ts`, `auth-context.ts` — slice 1.
  - `shared/file-storage-gateway/` (new directory) — slice 2.
  - `catalog/catalog.types.ts`, `catalog/catalog.schema.ts`, `catalog/catalog.facade.ts`, `catalog/catalog.module.ts`, `catalog/catalog.configuration.ts`, `catalog/catalog.facade.spec.ts`, `catalog/in-memory-catalog.repository.ts`, `catalog/sample-catalog-data.ts` — slices 3, 4, 5.
- **Risk level**: MODERATE (per discovery and triage). Magic-byte sniffing is a real correctness risk if the byte-offset checks are wrong; idempotency-by-hash needs the SHA-256 path verified; the role introduction touches four files. Each is bounded; all are testable at the facade boundary.

## Phase 1 → Phase 2 Handoff

When Phase 2 starts, the spec-builder for that phase should:

1. Add `thumbnail_content_hash`, `thumbnail_mime_type`, `thumbnail_byte_length` columns to `books` via `0004_*.sql`.
2. Update `toBookRow` / `toBookDto` in `drizzle-catalog.repository.ts` to round-trip the `BookDto.thumbnail` subobject.
3. Add `multer` + `@types/multer` as direct deps.
4. Add `POST` / `GET` / `DELETE /books/:bookId/thumbnail` to `CatalogController` with `FileInterceptor` and `@UploadedFile()`.
5. Wire `AuthUser` from request into `attachThumbnail` / `removeThumbnail` calls.
6. Add the crucial-path integration spec covering multipart upload, byte-identical roundtrip, mime/size rejection, idempotent reupload, and 403-for-non-staff.

No Phase 1 AC needs to change to enable Phase 2 — the facade signatures and gateway port are stable across the boundary.

[x] Reviewed
