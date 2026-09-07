# Phase C: Durable Undo for Email Moves — Design

## Context

The second external security review (item 6 of 9) requires reliable, durable undo for `move_message`, backed by storage that survives across serverless invocations (not process memory). This is Phase C of the four-phase response to that review; Phase A (calendar correctness) and Phase B (Trash/Junk destination policy) are complete and merged. Phase D (read-only mode, rate limiting) follows this one.

The user has chosen Upstash (Redis, accessed via the `@upstash/redis` REST-based SDK) as the durable storage backend, provisioned through Vercel's storage marketplace.

## Goals

- Every `move_message` call is recorded durably *before* the IMAP mutation happens ("persist before mutate"), so a record exists even if the process crashes mid-move.
- Move outcomes are tracked as `pending` → `confirmed` / `failed` / `uncertain`, never silently assumed.
- An `undo_move` tool reverses a confirmed move safely: verifying UIDVALIDITY and message identity before touching anything, applying the same Trash/Junk destination policy in reverse, and being safe to retry (idempotent).
- Authenticated, paginated tools exist to list recent move operations and inspect one by ID.
- No cross-system atomicity is claimed anywhere (Redis and IMAP are separate systems); the design only ever makes true claims about what was confirmed.

## Non-goals

- Read-only mode and rate limiting (Phase D).
- Undo for any operation other than `move_message` (flags, marks, etc. are out of scope).
- Automatic/scheduled cleanup jobs — TTL expiry in Redis handles retention.

## Data model

Stored in Upstash Redis via `@upstash/redis`.

**`move:op:<operationId>`** — a single JSON string value per move operation (via `SET`/`GET`), not a Redis hash: the whole record is always read and written together, so a JSON blob is simpler with `@upstash/redis` than mapping every field to `HSET`. Fields:

| field | meaning |
|---|---|
| `id` | operation UUID |
| `status` | `pending` \| `confirmed` \| `failed` \| `uncertain` \| `undone` |
| `sourcePath`, `sourceUid`, `sourceUidValidity` | where the message was moved from |
| `destPath`, `destUid`, `destUidValidity` | where it was moved to (`destUid`/`destUidValidity` null until confirmed) |
| `identity` | JSON: `{ messageId, date, subject }` captured from the source message before the move |
| `createdAt`, `confirmedAt` | epoch ms |
| `error` | sanitized error message, set on `failed`/`uncertain` |
| `undoOf` | operation id this record undoes, if applicable |
| `undoneBy` | operation id that undid this record, once undone |

TTL: 7 days from `createdAt`, applied via `EXPIRE` right after the initial write.

**`move:by-time`** — a sorted set; `ZADD` with score = `createdAt`, member = `operationId`. Used for reverse-chronological listing. A listing read that finds a member whose record has expired removes that stale member (`ZREM`) and skips it.

**`move:lock:<operationId>`** — a short-TTL (30s) lock key, `SET ... NX EX 30`, used to serialize concurrent `undo_move` calls on the same operation.

## Module structure

**`lib/moveLog.ts`** (new) — owns the Redis client and schema:
- `getRedis()` — constructs `@upstash/redis`'s `Redis` client from `UPSTASH_REDIS_REST_URL` / `UPSTASH_REDIS_REST_TOKEN`.
- `createPendingOperation(params)` → writes the initial record + sorted-set entry + TTL, returns `operationId`.
- `markConfirmed(operationId, { destUid, destUidValidity })`.
- `markFailed(operationId, error)` / `markUncertain(operationId, error)`.
- `markUndone(operationId, undoneByOperationId)`.
- `getOperation(operationId)`.
- `listOperations({ limit, cursor })` — paginated, reverse-chronological.
- `acquireUndoLock(operationId)` / `releaseUndoLock(operationId)`.

**`lib/imap.ts`** (modified):
- `moveMessage` rewritten to persist-before-mutate through `lib/moveLog.ts` (see Flow below). Returns `{ operationId }`.
- New `undoMove(operationId)` — implements the undo flow (see below), calling back into a shared internal move-execution helper so the reverse move is itself logged as a new, independently-undoable operation.
- New pass-through reads: `listMoveOperations`, `getMoveOperation`.

**`tools/mail.ts`** (modified): registers `undo_move`, `list_move_operations`, `get_move_operation`; updates `move_message`'s description to mention the returned `operationId` and that moves are undoable for 7 days.

## Flow: `moveMessage` (persist-before-mutate)

1. Connect; `client.list()`; run existing `assertMoveAllowed(mailboxes, folder, targetFolder)` policy (unchanged).
2. If `folder === targetFolder`: no-op as today — no operation record is created (nothing moved, nothing to undo).
3. Fetch the source message's envelope (Message-ID, date, subject) and the source mailbox's current `uidValidity`.
4. `createPendingOperation` — writes the `pending` record to Redis. **If this write throws, the function throws immediately and no IMAP call is made.**
5. Call `client.messageMove(uid, targetFolder, { uid: true })`. iCloud supports UIDPLUS; the result includes a `uidMap` giving the destination UID directly, and the destination mailbox's `uidValidity` is read via a follow-up `client.list()`/status lookup for the target path.
6. On success: `markConfirmed` with `destUid`/`destUidValidity`.
7. On thrown error: classify it —
   - Errors that clearly mean the command never reached/was rejected by the server (e.g. connection refused, auth failure, an IMAP `NO`/`BAD` response before any state change) → `markFailed`.
   - Errors from timeouts, dropped connections mid-command, or anything where the server's actual state is unknown → `markUncertain`.
   - Rethrow the original error to the caller either way, so the agent sees the failure immediately; the record is what makes it durable and inspectable afterward.

## Flow: `undo_move(operationId)`

1. `acquireUndoLock(operationId)`; if not acquired, throw "undo already in progress for this operation."  Always release in a `finally`.
2. `getOperation(operationId)`. Throw if missing/expired, if `status` is `undone` or `failed`, or if `destUid` is null (nothing was confirmed moved).
3. If `status === 'uncertain'`: reconcile first.
   - Fetch source folder: search for a message matching the stored identity (Message-ID primary; corroborate with date+subject).
   - Fetch destination folder: same search.
   - Exactly one side has a match → resolve: if destination matches, `markConfirmed` with the found UID/UIDVALIDITY and continue; if source matches, `markFailed("move did not occur")` and stop (nothing to undo).
   - Both or neither match → throw an explicit "cannot automatically reconcile this operation; manual verification required" error, no state change.
4. Re-verify destination `uidValidity` matches the stored `destUidValidity`; mismatch → throw (folder was recreated/resynced since the move).
5. Re-fetch the message at `destUid` in the destination folder; confirm its Message-ID/date/subject still match the stored identity; mismatch → throw (UID was reused after an expunge, or message was altered).
6. Apply `assertMoveAllowed(mailboxes, destPath, sourcePath)` — the same policy function, now checking the reverse direction. (A prior move into Trash/Junk was only possible via the operator override; undoing it back out is always a "recovery" move and passes.)
7. Execute the reverse move through the same persist-before-mutate path used by `moveMessage`, producing a new operation record with `undoOf: operationId`.
8. `markUndone(operationId, newOperationId)` on the original record.
9. Idempotency: if step 2 finds `status === 'undone'` already, return the existing `undoneBy` operation id rather than erroring or repeating the move.

Undo is a plain move through the same path, so an undo can itself be undone via the same tool, with the same policy and reconciliation rules applying every time.

## Tools

- **`move_message`** (existing, updated): now returns `{ operationId }`. Description updated to mention the 7-day undo window and the `undo_move` tool.
- **`undo_move(operationId)`** (new): reverses a move. Description documents the UIDVALIDITY/identity checks, that it can fail with an explicit reconciliation-required error, and that Trash/Junk destination policy still applies.
- **`list_move_operations(limit?, cursor?)`** (new): paginated, most-recent-first list of operation summaries (id, status, source/dest paths, timestamps).
- **`get_move_operation(operationId)`** (new): full record for one operation.

## Error handling principles

- Every thrown error is a plain, explicit `Error` with a human-readable message — no silent fallbacks, no guessed outcomes.
- The design never claims atomicity across Redis and IMAP; it only ever reports a state Redis and IMAP were both actually observed to be in.
- Sanitized errors only: raw IMAP/network error objects are not stored verbatim if they could contain connection strings or credentials — messages are reduced to their `.message` text (which `imapflow`/Node's own error objects do not populate with credentials).

## Testing

New `test/lib/moveLog.test.ts` and `test/lib/imap-undo.test.ts`, mocking `@upstash/redis`'s `Redis` class (regular-function constructor mock, per the existing `imapflow`/`tsdav` mocking pattern) and the existing IMAP mock client. Coverage:
- `moveMessage`: pending record written before `messageMove` is called; confirmed/failed/uncertain transitions from different IMAP outcomes; same-folder no-op creates no record.
- `undo_move`: successful undo of a confirmed move; rejection of missing/expired/already-undone/failed/no-destUid records; UIDVALIDITY-mismatch rejection; identity-mismatch rejection; reconciliation resolving an uncertain record to confirmed and to failed; ambiguous reconciliation (both/neither match) rejection; Trash/Junk policy enforced on the reverse direction; concurrent-undo lock contention (second caller gets the "in progress" error); double-undo of the same operation returns the existing result instead of moving twice; undo-of-an-undo succeeds and produces its own further-undoable record.
- `list_move_operations` / `get_move_operation`: pagination, and stale (expired-but-still-indexed) entries are skipped and cleaned up.

## Environment

New required variables (provided automatically by the Vercel Upstash integration): `UPSTASH_REDIS_REST_URL`, `UPSTASH_REDIS_REST_TOKEN`. Documented in `.env.example` and README. No new operator toggles in this phase.
