# Discovery: Book Thumbnail Upload

## Why

Books in the catalog today are bibliographic-only: `bookId`, `title`, `authors`, `isbn`. There is no visual representation. The developer wants staff to attach a single cover thumbnail to a book *after* the book exists, optionally, with byte-level safety (real mime sniff, size cap, idempotent reuploads).

Today the catalog response can't show a cover anywhere — UIs that consume `BookDto` have nothing to render. Adding a thumbnail unblocks that without changing how books are created.

The developer explicitly asked: *"can we create another API or a totally separate module to upload book thumbnails?"* — so the **shape of the module** is the headline call, and several decisions sit on top of it.

## Who

- **Staff users uploading thumbnails.** They are the only writers. They already exist as people, but **not as a role** — `Role` is `'MEMBER' | 'ACCOUNT'` today; no `'STAFF'`.
- **Anyone reading book data.** Members, account holders, future UI clients — they consume thumbnails as a read-only attribute of a book.
- **Future image features (speculative).** Member avatars, receipt scans, multiple book images. The developer has *not* confirmed any of these are planned — they are the YAGNI question for decision 1.

## Success Criteria

- A staff user can attach a thumbnail to an existing book and the same image is served back byte-identical on the next read.
- A second upload of the same bytes is a no-op (idempotent by content hash) — no duplicate storage, no error.
- Wrong mime type (e.g. PDF renamed `.jpg`) is rejected at the facade boundary using magic-byte sniffing, not just the `Content-Type` header.
- Oversize uploads are rejected with a clear domain error before any bytes hit storage.
- Books without a thumbnail keep working exactly as today — thumbnail is genuinely optional.
- The module-level test (`*.facade.spec.ts`) covers the full lifecycle against in-memory collaborators, mirroring `catalog.facade.spec.ts`.

## Problem Statement

The catalog has no representation for a book cover. Staff need a safe, idempotent way to attach a single image per book *after* the book is created, and readers need to see that image when they fetch the book. The decision is whether thumbnails are a *catalog attribute* (extend the existing module) or a *separate concern* (new module). All other decisions — transport, persistence, storage, role, cache — fan out from that one.

## Hypotheses

- **H1 (recommended, YAGNI-honest): Thumbnails are a catalog attribute, not a separate domain.** One thumbnail per book, scoped to books in this app, with no confirmed roadmap for member avatars / receipts / multi-image. Extending `CatalogFacade` with `attachThumbnail` / `readThumbnail` / `removeThumbnail` is the honest shape. A separate module is speculation tax until a second consumer materialises.
   - *Confirmable if:* developer confirms no other image-handling feature is planned in the next 3–6 months.
   - *Rejectable if:* developer confirms ≥1 additional image consumer (member avatars, receipt scans, multi-image-per-book) — then H2 wins.
- **H2: A dedicated `book-images` (or `media`) module wins if multiple image consumers are imminent.** The cost (new facade, new module boundary, cross-module read from catalog) only pays back when shared.
- **H3: Multipart transport is worth one direct dependency.** `multer` is already transitively present via `@nestjs/platform-express`. Adding it as a direct dep + `FileInterceptor` is one line of `package.json` and zero ergonomic friction vs base64's 33% inflation and JSON-escape pain.
- **H4: Inline columns on `books` are correct iff H1 wins.** `thumbnail_content_hash`, `thumbnail_mime_type`, `thumbnail_byte_length` (all nullable). No join, matches "thumbnail is a book attribute," reads piggyback on the existing book cache. If H1 is rejected, a `book_thumbnails` table (PK = `book_id`) is the natural fit.
- **H5: `STAFF` role is in scope.** Skipping it would leave the upload endpoint unguarded with a TODO — measurably worse than introducing one new role variant in four files. The role gap is precursor work, not a refactor.
- **H6: Storage gateway = in-memory only for v1.** Follow the `isbn-gateway` / `book-cache-gateway` / `chat-gateway` recipe: ship the port + in-memory adapter, defer the prod adapter (S3 vs local disk) to a follow-up. Demo / module tests don't need real object storage. The architect can decide the prod adapter when there's a real deploy target.
- **H7: `BookDto` gains a small `thumbnail` subobject when present, omitted when absent.** Lets `GET /books/:isbn` render in one round-trip and avoids a chatty UI. The subobject is metadata only (`contentHash`, `mimeType`, `byteLength`) — the bytes still come from `GET /books/:bookId/thumbnail`. Write-through cache update on `attachThumbnail`; eviction on `removeThumbnail`, mirroring `updateBook` / `deleteBook`.

## The Shape Decision and Why

**Recommendation: extend `catalog` (H1).**

Honest reading of the inputs:

- **One thumbnail per book.** Same cardinality as `title`. That's an attribute, not a separate aggregate.
- **No confirmed second consumer.** The "future media module" argument is genuine speculation — there's no member avatar feature, no receipt-upload feature, no multi-image-per-book feature on the table.
- **Coupling is already honest.** The thumbnail belongs to the book and dies with the book (`deleteBook` would need to evict the thumbnail anyway). A separate module would have to call back into catalog to learn about deletes — that's a cross-module event flow we don't need.
- **One schema change vs two modules.** `books` gains three nullable columns + a `0004_*.sql` migration. A separate module costs a new facade, a new module class, a new repository pair, new DI wiring, and a new cross-module call from the controller (or a saga for delete cleanup).
- **The Nabrdalik style rewards this.** Facade-only entry, in-memory repo, sample builders, configuration factory — all the existing patterns work unchanged. Extracting later is a mechanical refactor when a second consumer arrives, and the refactor is *cheaper* than predicting wrong now.

If the developer confirms a second image consumer is genuinely imminent, **flip to H2** and the recommendation becomes a new `book-images` module — but that's a deliberate, evidence-backed call, not a default.

## Per-Decision Rationale

1. **Module shape — extend `catalog`** (one-line: YAGNI; one thumbnail per book is catalog data; no confirmed second consumer).
2. **Transport — multipart with direct `multer` + `@types/multer` dependency** (one-line: it's already transitively present; base64's 33% inflation and JSON-escape friction outweigh one explicit dep).
3. **Persistence — inline nullable columns on `books`** (one-line: matches "thumbnail is a book attribute"; no join; one mapper change in `drizzle-catalog.repository.ts`).
4. **Storage backend — port + in-memory adapter only for v1** (one-line: gateway recipe is already proven thrice; prod adapter choice can wait until there's a real deploy target).
5. **Role — introduce `STAFF`** (one-line: four-file precursor work is cheaper than shipping unguarded with a TODO; access-control is data-driven so this is a one-policy-row add too).
6. **`BookDto` coupling — add optional `thumbnail` metadata subobject** (one-line: one round-trip for UIs; bytes still come from a separate endpoint; cache stays coherent because writes flow through `attachThumbnail` / `removeThumbnail`).
7. **Cache invalidation — write-through on attach, evict on remove** (one-line: mirrors existing `updateBook` / `deleteBook` patterns; same `cache.set(existing.isbn, updated)` shape).

## Out of Scope

- **Server-side resizing / variants.** One image in, same image out. No thumbnails-of-thumbnails.
- **Multiple images per book.** Single cover only. If a second image is needed later, that's the trigger to revisit H1.
- **Member avatars, receipt scans, fine-evidence photos, copy-condition photos.** Not planned. Their absence is *why* the catalog-API shape wins now.
- **Public CDN / signed URLs / pre-signed upload.** Bytes flow through the API. No direct-to-S3 upload protocol.
- **Image manipulation, EXIF stripping, virus scanning.** Magic-byte mime check only.
- **Multi-tenant / per-library scoping.** This app is single-library.
- **Frontend rendering.** No frontend in this repo. Verification is byte-level.

## Milestone Map

### Phase 1 — Walking skeleton: attach + read + remove, in-memory only

A staff user can attach, read, and remove a single thumbnail on an existing book. End-to-end through the facade with in-memory storage. Wins:

- Domain shape locked in (`attachThumbnail` / `readThumbnail` / `removeThumbnail` on `CatalogFacade`).
- `FileStorageGateway` port + `InMemoryFileStorageGateway` exist and are reused everywhere.
- `parseThumbnailUpload` (dedicated Zod-or-equivalent schema + magic-byte sniff).
- Idempotency by content hash proven against in-memory storage.
- `STAFF` role exists in `Role`, `POLICY`, sample data, and `auth-context`.
- Module-level facade spec (`catalog.facade.spec.ts`) covers the lifecycle including reject-oversize, reject-wrong-mime, idempotent-reupload, attach-when-book-missing, remove-when-no-thumbnail.

### Phase 2 — Wire HTTP + persistence + cache

The endpoints exist and the data survives a restart. Wins:

- `POST /books/:bookId/thumbnail` (multipart, `FileInterceptor`) and `GET /books/:bookId/thumbnail` (binary response) and `DELETE /books/:bookId/thumbnail`.
- `multer` + `@types/multer` declared as direct deps.
- Migration `0004_book_thumbnails.sql` adds the three nullable columns.
- `drizzle-catalog.repository.ts` mappers (`toBookRow` / `toBookDto`) round-trip the new fields.
- `BookDto` optionally includes the `thumbnail` metadata subobject.
- Write-through cache update on attach; eviction on remove (mirroring `updateBook` / `deleteBook`).
- `catalog.module.ts` imports `AccessControlModule`; controller passes `authUser` through; facade authorizes on the first line.
- Crucial-path integration spec exercises the multipart endpoint against a real Postgres (testcontainers or pglite).

### Phase 3 (deferred, not in this delivery)

- Production storage adapter (S3 / local disk) — picked when a real deploy target exists.
- Any additional image consumers — would trigger the H1 -> H2 refactor (mechanical, not speculative).

## Module Structure

Not a greenfield project. Existing `catalog/` module is extended. New shared infrastructure added under `apps/library/src/shared/file-storage-gateway/` following the gateway recipe — used only by `catalog/` for now and **not** re-exported from any module barrel.

## Open Questions

These are the items the spec-builder must confirm with the developer before slicing — they are *real* decisions, not defaults:

1. **YAGNI check on module shape.** Is there any image-handling feature confirmed for the next 3–6 months (member avatars, receipt scans, multi-image-per-book)? If yes, flip from H1 to H2 (`book-images` module). The whole rest of the doc holds either way except decisions 1, 3, and 6.
2. **`STAFF` role naming.** `'STAFF'` is the obvious name; confirm that's preferred over `'LIBRARIAN'` / `'ADMIN'`. The existing names (`'MEMBER'`, `'ACCOUNT'`) suggest single-word capitals — `'STAFF'` fits.
3. **Max upload size.** Pick a concrete number. 2 MB is a reasonable default for book covers; 5 MB is permissive; 10 MB+ is generous. The number lands in `parseThumbnailUpload` and in the multipart limits.
4. **Read endpoint response shape.** Confirm `GET /books/:bookId/thumbnail` returns raw bytes with the stored `Content-Type` (not base64, not a JSON wrapper). This is the only sane shape but worth saying out loud.
5. **Cache key when thumbnail metadata lands in `BookDto`.** The book cache today is keyed by ISBN. Confirm we keep that key — attaching a thumbnail does not change the ISBN, so it's just a `cache.set` of the same key with the new value. No new cache surface.
6. **What happens to the thumbnail when a book is deleted?** Current `deleteBook` evicts the book-cache entry. Should it also remove the thumbnail from storage? Recommended: yes, evict and remove — but flag it because today's facade doesn't do that work.
7. **Prod storage adapter.** Not needed for Phase 1 / Phase 2, but worth a sentence in the spec: which adapter is most likely to land in Phase 3 (S3 vs local disk vs filesystem-mounted volume)? Influences the port shape only if the answer is exotic.

## Proposed Slice Ordering for Spec-Builder

1. **`STAFF` role precursor.** Introduce the role variant; add `catalog: { uploadThumbnail: ['STAFF'], removeThumbnail: ['STAFF'] }` to `POLICY`; update `sample-access-control-data.ts` and `auth-context.ts`. No catalog change yet.
2. **`FileStorageGateway` shared infrastructure.** Port file, `InMemoryFileStorageGateway`, its spec, the `ThrowingOnceFileStorageGateway` shape (spec-local, not exported). No catalog wiring yet.
3. **`CatalogFacade.attachThumbnail` (in-memory).** Schema + magic-byte sniff + size cap + content-hash idempotency. Module-level spec covers the lifecycle. No HTTP, no DB.
4. **`CatalogFacade.readThumbnail` and `removeThumbnail` (in-memory).** Same shape; round out the lifecycle in the facade spec.
5. **Cache integration.** Write-through on attach, eviction on remove. Verified in the facade spec via `ThrowingOnceBookCacheGateway`-style assertions.
6. **`BookDto` thumbnail metadata subobject.** Add the optional `thumbnail` field; update `findBook` / `listBooks` / `getBooks` to populate it; update `catalog.facade.spec.ts` assertions.
7. **DB migration `0004_*.sql` + Drizzle mappers.** Three nullable columns on `books`; mapper updates in `drizzle-catalog.repository.ts`. Verified via pglite spec.
8. **HTTP wiring.** Add `multer` + `@types/multer` direct deps; `CatalogController` gains `POST` / `GET` / `DELETE /books/:bookId/thumbnail` with `FileInterceptor` and `@UploadedFile()`; `CatalogModule` imports `AccessControlModule` and injects `AccessControlFacade`. Authorize on the facade's first line.
9. **Crucial-path integration spec.** Multipart upload through the real `AppModule` against a real Postgres (testcontainers or pglite); byte-identical roundtrip; mime-rejection; size-rejection; idempotent reupload; 403 for non-staff.

## Revised Assessment

- **Size:** FEATURE (confirmed; not an EPIC — the slice count is 9 but each slice is small and the surface area is one module + one shared gateway + one role).
- **Greenfield:** no — extending `catalog/` and `shared/`.
- **Risk:** MODERATE (confirmed; magic-byte sniffing, idempotency by content hash, multipart wiring, and a cross-cutting role introduction are each modest but real).

[x] Reviewed
