# Durable Move Undo (Phase C) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give `move_message` a durable, undoable operation log backed by Upstash Redis, plus an `undo_move` tool and read-only inspection tools, per Phase C of the second security review.

**Architecture:** A new `lib/moveLog.ts` module owns all Redis I/O (via `@upstash/redis`) for a per-operation hash + a time-sorted index. `lib/imap.ts`'s `moveMessage` is rewritten to write a `pending` record before calling IMAP, then update it to `confirmed`/`failed`/`uncertain` after. A new `undoMove` in `lib/imap.ts` reconciles uncertain records, verifies UIDVALIDITY and message identity, and re-runs the same move path in reverse. Three new MCP tools in `tools/mail.ts` expose `undo_move`, `list_move_operations`, `get_move_operation`.

**Tech Stack:** TypeScript, `@upstash/redis` (REST-based Redis client), `imapflow`, Vitest for testing (mocking `Redis` the same way `ImapFlow` is mocked — a regular-function constructor mock).

## Global Constraints

- No live iCloud account access, no live mailbox mutations, no real Upstash calls during testing — all tests use mocked `ImapFlow`/`Redis` clients and synthetic fixtures.
- British English in all documentation and user-facing/tool-description text (e.g. "organised", "colour" if it comes up — no American spellings in new prose).
- No agent-facing bypass parameter for the Trash/Junk policy — `undo_move` must call the existing `assertMoveAllowed` unmodified, just with source/target swapped.
- Every new async IMAP/Redis path must still close the IMAP connection (`client.logout()`) in a `finally`, matching the existing pattern in `lib/imap.ts`.
- Never store raw credentials or unsanitized error objects in Redis — only `.message` strings.
- TTL on every operation record and its index entry: 7 days.
- `npm run typecheck` and `npm test` must stay green after every task.

---

### Task 1: Add `@upstash/redis` dependency and env scaffolding

**Files:**
- Modify: `package.json`
- Modify: `.env.example`
- Modify: `README.md` (env var table only, in this task)

**Interfaces:**
- Produces: `@upstash/redis` available as an importable dependency (`import { Redis } from '@upstash/redis'`).

- [ ] **Step 1: Install the dependency**

Run: `npm install @upstash/redis`

Expected: `package.json` `dependencies` gains `"@upstash/redis": "^<installed version>"`, `package-lock.json` updates, no new `npm audit` findings (run `npm audit` afterward and confirm no new critical/high entries versus the current baseline of 0).

- [ ] **Step 2: Document the new environment variables**

In `.env.example`, add (after the existing `ALLOW_TRASH_JUNK_MOVES` block):

```
# Upstash Redis (used for durable move-undo tracking). Provided automatically
# when you connect the Upstash integration to this project in Vercel; for
# local development, create a free database at https://console.upstash.com
# and copy its REST URL and token here.
UPSTASH_REDIS_REST_URL=
UPSTASH_REDIS_REST_TOKEN=
```

- [ ] **Step 3: Add the variables to the README's environment table**

Find the existing environment variable table in `README.md` (it documents `ICLOUD_EMAIL`, `ICLOUD_APP_PASSWORD`, `MCP_AUTH_TOKEN`, `ALLOW_TRASH_JUNK_MOVES`). Add two rows for `UPSTASH_REDIS_REST_URL` and `UPSTASH_REDIS_REST_TOKEN`, describing them as required for move-undo tracking, auto-populated by Vercel's Upstash integration.

- [ ] **Step 4: Commit**

```bash
git add package.json package-lock.json .env.example README.md
git commit -m "Add @upstash/redis dependency and env documentation for move-undo tracking

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>"
```

---

### Task 2: `lib/moveLog.ts` — Redis schema and CRUD

**Files:**
- Create: `lib/moveLog.ts`
- Create: `test/lib/moveLog-mock-client.ts`
- Test: `test/lib/moveLog.test.ts`

**Interfaces:**
- Consumes: `requireEnv` pattern from `lib/imap.ts:6-12` (duplicate a local copy in this file — it's a 6-line pure function, not worth sharing across modules with no other coupling).
- Produces (used by Task 3 and Task 4):
  ```typescript
  export type MoveOperationStatus = 'pending' | 'confirmed' | 'failed' | 'uncertain' | 'undone';

  export interface MoveIdentity {
    messageId: string | null;
    date: string | null;
    subject: string | null;
  }

  export interface MoveOperationRecord {
    id: string;
    status: MoveOperationStatus;
    sourcePath: string;
    sourceUid: number;
    sourceUidValidity: string; // bigint serialized as decimal string
    destPath: string;
    destUid: number | null;
    destUidValidity: string | null;
    identity: MoveIdentity;
    createdAt: number; // epoch ms
    confirmedAt: number | null;
    error: string | null;
    undoOf: string | null;
    undoneBy: string | null;
  }

  export interface CreatePendingOperationParams {
    sourcePath: string;
    sourceUid: number;
    sourceUidValidity: bigint;
    destPath: string;
    identity: MoveIdentity;
    undoOf?: string;
  }

  export function getRedis(): Redis; // Redis from '@upstash/redis'
  export async function createPendingOperation(params: CreatePendingOperationParams): Promise<string>; // returns operationId
  export async function markConfirmed(operationId: string, params: { destUid: number; destUidValidity: bigint }): Promise<void>;
  export async function markFailed(operationId: string, error: string): Promise<void>;
  export async function markUncertain(operationId: string, error: string): Promise<void>;
  export async function markUndone(operationId: string, undoneByOperationId: string): Promise<void>;
  export async function getOperation(operationId: string): Promise<MoveOperationRecord | null>;
  export interface ListOperationsResult { operations: MoveOperationRecord[]; nextCursor: number | null; }
  export async function listOperations(params: { limit?: number; cursor?: number }): Promise<ListOperationsResult>;
  export async function acquireUndoLock(operationId: string): Promise<boolean>;
  export async function releaseUndoLock(operationId: string): Promise<void>;

  export const OPERATION_TTL_SECONDS = 7 * 24 * 60 * 60;
  export const DEFAULT_LIST_LIMIT = 20;
  export const MAX_LIST_LIMIT = 100;
  ```

Redis key layout: `move:op:<id>` (JSON string value via `redis.set`/`redis.get`, not a hash — storing one JSON blob per key is simpler with `@upstash/redis` than mapping every field to `HSET`, and the whole record is always read/written together). `move:by-time` (sorted set, `ZADD`/`ZRANGE`/`ZREM`). `move:lock:<id>` (string, `SET ... NX EX 30`).

- [ ] **Step 1: Write the mock Redis client helper**

Create `test/lib/moveLog-mock-client.ts`:

```typescript
import { vi } from 'vitest';

export function createMockRedisClient() {
  return {
    set: vi.fn(),
    get: vi.fn(),
    del: vi.fn(),
    expire: vi.fn(),
    zadd: vi.fn(),
    zrange: vi.fn(),
    zrem: vi.fn(),
  };
}

export type MockRedisClient = ReturnType<typeof createMockRedisClient>;
```

- [ ] **Step 2: Write failing tests for `createPendingOperation` and `getOperation`**

Create `test/lib/moveLog.test.ts`:

```typescript
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createMockRedisClient } from './moveLog-mock-client.js';

const mockRedis = vi.hoisted(() => ({
  set: vi.fn(),
  get: vi.fn(),
  del: vi.fn(),
  expire: vi.fn(),
  zadd: vi.fn(),
  zrange: vi.fn(),
  zrem: vi.fn(),
}));

vi.mock('@upstash/redis', () => ({
  // Regular function, not an arrow function: the code under test calls
  // `new Redis(...)`, and arrow functions cannot be constructors.
  Redis: vi.fn().mockImplementation(function RedisMock() {
    return mockRedis;
  }),
}));

async function freshMoveLog() {
  vi.resetModules();
  for (const fn of Object.values(mockRedis)) {
    if (typeof fn === 'function' && 'mockReset' in fn) (fn as ReturnType<typeof vi.fn>).mockReset();
  }
  process.env.UPSTASH_REDIS_REST_URL = 'https://example.upstash.io';
  process.env.UPSTASH_REDIS_REST_TOKEN = 'test-token';
  return import('../../lib/moveLog.js');
}

describe('createPendingOperation / getOperation', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('writes a pending record, indexes it by time, and sets a TTL', async () => {
    const moveLog = await freshMoveLog();
    const id = await moveLog.createPendingOperation({
      sourcePath: 'INBOX',
      sourceUid: 42,
      sourceUidValidity: 1000n,
      destPath: 'INBOX.Archive',
      identity: { messageId: '<abc@example.com>', date: '2026-09-01T00:00:00.000Z', subject: 'Hello' },
    });
    expect(typeof id).toBe('string');
    expect(mockRedis.set).toHaveBeenCalledWith(
      `move:op:${id}`,
      expect.stringContaining('"status":"pending"'),
    );
    expect(mockRedis.expire).toHaveBeenCalledWith(`move:op:${id}`, moveLog.OPERATION_TTL_SECONDS);
    expect(mockRedis.zadd).toHaveBeenCalledWith('move:by-time', {
      score: expect.any(Number),
      member: id,
    });
  });

  it('round-trips a record through getOperation', async () => {
    const moveLog = await freshMoveLog();
    const record: import('../../lib/moveLog.js').MoveOperationRecord = {
      id: 'op-1',
      status: 'pending',
      sourcePath: 'INBOX',
      sourceUid: 1,
      sourceUidValidity: '1000',
      destPath: 'INBOX.Archive',
      destUid: null,
      destUidValidity: null,
      identity: { messageId: null, date: null, subject: null },
      createdAt: Date.now(),
      confirmedAt: null,
      error: null,
      undoOf: null,
      undoneBy: null,
    };
    mockRedis.get.mockResolvedValue(JSON.stringify(record));
    const result = await moveLog.getOperation('op-1');
    expect(result).toEqual(record);
    expect(mockRedis.get).toHaveBeenCalledWith('move:op:op-1');
  });

  it('returns null for a missing or expired operation', async () => {
    const moveLog = await freshMoveLog();
    mockRedis.get.mockResolvedValue(null);
    expect(await moveLog.getOperation('does-not-exist')).toBeNull();
  });
});
```

- [ ] **Step 3: Run the tests to verify they fail**

Run: `npx vitest run test/lib/moveLog.test.ts`
Expected: FAIL — `lib/moveLog.js` does not exist yet.

- [ ] **Step 4: Implement `lib/moveLog.ts`**

```typescript
import { Redis } from '@upstash/redis';
import { randomUUID } from 'node:crypto';

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`${name} is not set`);
  }
  return value;
}

export type MoveOperationStatus = 'pending' | 'confirmed' | 'failed' | 'uncertain' | 'undone';

export interface MoveIdentity {
  messageId: string | null;
  date: string | null;
  subject: string | null;
}

export interface MoveOperationRecord {
  id: string;
  status: MoveOperationStatus;
  sourcePath: string;
  sourceUid: number;
  sourceUidValidity: string;
  destPath: string;
  destUid: number | null;
  destUidValidity: string | null;
  identity: MoveIdentity;
  createdAt: number;
  confirmedAt: number | null;
  error: string | null;
  undoOf: string | null;
  undoneBy: string | null;
}

export interface CreatePendingOperationParams {
  sourcePath: string;
  sourceUid: number;
  sourceUidValidity: bigint;
  destPath: string;
  identity: MoveIdentity;
  undoOf?: string;
}

export interface ListOperationsResult {
  operations: MoveOperationRecord[];
  nextCursor: number | null;
}

export const OPERATION_TTL_SECONDS = 7 * 24 * 60 * 60;
export const DEFAULT_LIST_LIMIT = 20;
export const MAX_LIST_LIMIT = 100;

const OP_KEY_PREFIX = 'move:op:';
const INDEX_KEY = 'move:by-time';
const LOCK_KEY_PREFIX = 'move:lock:';

let cachedClient: Redis | null = null;

export function getRedis(): Redis {
  if (cachedClient) return cachedClient;
  cachedClient = new Redis({
    url: requireEnv('UPSTASH_REDIS_REST_URL'),
    token: requireEnv('UPSTASH_REDIS_REST_TOKEN'),
  });
  return cachedClient;
}

function opKey(operationId: string): string {
  return `${OP_KEY_PREFIX}${operationId}`;
}

async function writeRecord(record: MoveOperationRecord): Promise<void> {
  const redis = getRedis();
  await redis.set(opKey(record.id), JSON.stringify(record));
  await redis.expire(opKey(record.id), OPERATION_TTL_SECONDS);
}

export async function createPendingOperation(params: CreatePendingOperationParams): Promise<string> {
  const id = randomUUID();
  const createdAt = Date.now();
  const record: MoveOperationRecord = {
    id,
    status: 'pending',
    sourcePath: params.sourcePath,
    sourceUid: params.sourceUid,
    sourceUidValidity: params.sourceUidValidity.toString(),
    destPath: params.destPath,
    destUid: null,
    destUidValidity: null,
    identity: params.identity,
    createdAt,
    confirmedAt: null,
    error: null,
    undoOf: params.undoOf ?? null,
    undoneBy: null,
  };
  await writeRecord(record);
  const redis = getRedis();
  await redis.zadd(INDEX_KEY, { score: createdAt, member: id });
  return id;
}

export async function getOperation(operationId: string): Promise<MoveOperationRecord | null> {
  const redis = getRedis();
  const raw = await redis.get(opKey(operationId));
  if (!raw) return null;
  return (typeof raw === 'string' ? JSON.parse(raw) : raw) as MoveOperationRecord;
}

async function updateRecord(
  operationId: string,
  patch: Partial<MoveOperationRecord>,
): Promise<void> {
  const existing = await getOperation(operationId);
  if (!existing) {
    throw new Error(`Move operation ${operationId} not found or has expired.`);
  }
  await writeRecord({ ...existing, ...patch });
}

export async function markConfirmed(
  operationId: string,
  params: { destUid: number; destUidValidity: bigint },
): Promise<void> {
  await updateRecord(operationId, {
    status: 'confirmed',
    destUid: params.destUid,
    destUidValidity: params.destUidValidity.toString(),
    confirmedAt: Date.now(),
  });
}

export async function markFailed(operationId: string, error: string): Promise<void> {
  await updateRecord(operationId, { status: 'failed', error });
}

export async function markUncertain(operationId: string, error: string): Promise<void> {
  await updateRecord(operationId, { status: 'uncertain', error });
}

export async function markUndone(operationId: string, undoneByOperationId: string): Promise<void> {
  await updateRecord(operationId, { status: 'undone', undoneBy: undoneByOperationId });
}

export async function listOperations(params: {
  limit?: number;
  cursor?: number;
} = {}): Promise<ListOperationsResult> {
  const redis = getRedis();
  const limit = Math.min(params.limit ?? DEFAULT_LIST_LIMIT, MAX_LIST_LIMIT);
  const start = params.cursor ?? 0;
  // Reverse-chronological: highest score (most recent) first.
  const ids = (await redis.zrange(INDEX_KEY, start, start + limit - 1, { rev: true })) as string[];
  const operations: MoveOperationRecord[] = [];
  for (const id of ids) {
    const record = await getOperation(id);
    if (record) {
      operations.push(record);
    } else {
      await redis.zrem(INDEX_KEY, id);
    }
  }
  const nextCursor = ids.length === limit ? start + limit : null;
  return { operations, nextCursor };
}

export async function acquireUndoLock(operationId: string): Promise<boolean> {
  const redis = getRedis();
  const result = await redis.set(`${LOCK_KEY_PREFIX}${operationId}`, '1', { nx: true, ex: 30 });
  return result === 'OK' || result === true;
}

export async function releaseUndoLock(operationId: string): Promise<void> {
  const redis = getRedis();
  await redis.del(`${LOCK_KEY_PREFIX}${operationId}`);
}
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `npx vitest run test/lib/moveLog.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 6: Add tests for the remaining status transitions, listing, and locking**

Append to `test/lib/moveLog.test.ts`:

```typescript
describe('status transitions', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  const baseRecord = (overrides: Partial<import('../../lib/moveLog.js').MoveOperationRecord> = {}) => ({
    id: 'op-1',
    status: 'pending' as const,
    sourcePath: 'INBOX',
    sourceUid: 1,
    sourceUidValidity: '1000',
    destPath: 'INBOX.Archive',
    destUid: null,
    destUidValidity: null,
    identity: { messageId: null, date: null, subject: null },
    createdAt: 1000,
    confirmedAt: null,
    error: null,
    undoOf: null,
    undoneBy: null,
    ...overrides,
  });

  it('markConfirmed sets destUid, destUidValidity, confirmedAt, and status', async () => {
    const moveLog = await freshMoveLog();
    mockRedis.get.mockResolvedValue(JSON.stringify(baseRecord()));
    await moveLog.markConfirmed('op-1', { destUid: 99, destUidValidity: 2000n });
    const [, written] = mockRedis.set.mock.calls[0] as [string, string];
    const parsed = JSON.parse(written);
    expect(parsed.status).toBe('confirmed');
    expect(parsed.destUid).toBe(99);
    expect(parsed.destUidValidity).toBe('2000');
    expect(parsed.confirmedAt).toEqual(expect.any(Number));
  });

  it('markFailed sets status and error, leaves destUid null', async () => {
    const moveLog = await freshMoveLog();
    mockRedis.get.mockResolvedValue(JSON.stringify(baseRecord()));
    await moveLog.markFailed('op-1', 'connection refused');
    const parsed = JSON.parse((mockRedis.set.mock.calls[0] as [string, string])[1]);
    expect(parsed.status).toBe('failed');
    expect(parsed.error).toBe('connection refused');
    expect(parsed.destUid).toBeNull();
  });

  it('markUncertain sets status and error', async () => {
    const moveLog = await freshMoveLog();
    mockRedis.get.mockResolvedValue(JSON.stringify(baseRecord()));
    await moveLog.markUncertain('op-1', 'timeout');
    const parsed = JSON.parse((mockRedis.set.mock.calls[0] as [string, string])[1]);
    expect(parsed.status).toBe('uncertain');
    expect(parsed.error).toBe('timeout');
  });

  it('markUndone sets status to undone and records undoneBy', async () => {
    const moveLog = await freshMoveLog();
    mockRedis.get.mockResolvedValue(JSON.stringify(baseRecord({ status: 'confirmed', destUid: 99, destUidValidity: '2000' })));
    await moveLog.markUndone('op-1', 'op-2');
    const parsed = JSON.parse((mockRedis.set.mock.calls[0] as [string, string])[1]);
    expect(parsed.status).toBe('undone');
    expect(parsed.undoneBy).toBe('op-2');
  });

  it('throws when updating an operation that has expired', async () => {
    const moveLog = await freshMoveLog();
    mockRedis.get.mockResolvedValue(null);
    await expect(moveLog.markConfirmed('gone', { destUid: 1, destUidValidity: 1n })).rejects.toThrow(/not found or has expired/);
  });
});

describe('listOperations', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns records in the order zrange provides and a nextCursor when a full page comes back', async () => {
    const moveLog = await freshMoveLog();
    mockRedis.zrange.mockResolvedValue(['op-2', 'op-1']);
    mockRedis.get.mockImplementation(async (key: string) => {
      const id = key.replace('move:op:', '');
      return JSON.stringify({
        id,
        status: 'confirmed',
        sourcePath: 'INBOX',
        sourceUid: 1,
        sourceUidValidity: '1',
        destPath: 'INBOX.Archive',
        destUid: 2,
        destUidValidity: '1',
        identity: { messageId: null, date: null, subject: null },
        createdAt: 1000,
        confirmedAt: 1001,
        error: null,
        undoOf: null,
        undoneBy: null,
      });
    });
    const result = await moveLog.listOperations({ limit: 2 });
    expect(result.operations.map((o) => o.id)).toEqual(['op-2', 'op-1']);
    expect(result.nextCursor).toBe(2);
  });

  it('skips and prunes stale index entries whose record has expired', async () => {
    const moveLog = await freshMoveLog();
    mockRedis.zrange.mockResolvedValue(['op-expired']);
    mockRedis.get.mockResolvedValue(null);
    const result = await moveLog.listOperations({ limit: 20 });
    expect(result.operations).toEqual([]);
    expect(mockRedis.zrem).toHaveBeenCalledWith('move:by-time', 'op-expired');
  });

  it('caps the limit at MAX_LIST_LIMIT', async () => {
    const moveLog = await freshMoveLog();
    mockRedis.zrange.mockResolvedValue([]);
    await moveLog.listOperations({ limit: 10000 });
    expect(mockRedis.zrange).toHaveBeenCalledWith('move:by-time', 0, moveLog.MAX_LIST_LIMIT - 1, { rev: true });
  });
});

describe('undo lock', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('acquireUndoLock returns true when the SET NX succeeds', async () => {
    const moveLog = await freshMoveLog();
    mockRedis.set.mockResolvedValue('OK');
    expect(await moveLog.acquireUndoLock('op-1')).toBe(true);
    expect(mockRedis.set).toHaveBeenCalledWith('move:lock:op-1', '1', { nx: true, ex: 30 });
  });

  it('acquireUndoLock returns false when the lock is already held', async () => {
    const moveLog = await freshMoveLog();
    mockRedis.set.mockResolvedValue(null);
    expect(await moveLog.acquireUndoLock('op-1')).toBe(false);
  });

  it('releaseUndoLock deletes the lock key', async () => {
    const moveLog = await freshMoveLog();
    await moveLog.releaseUndoLock('op-1');
    expect(mockRedis.del).toHaveBeenCalledWith('move:lock:op-1');
  });
});
```

- [ ] **Step 7: Run the full moveLog test file**

Run: `npx vitest run test/lib/moveLog.test.ts`
Expected: PASS (all tests).

- [ ] **Step 8: Typecheck**

Run: `npm run typecheck`
Expected: no errors.

- [ ] **Step 9: Commit**

```bash
git add lib/moveLog.ts test/lib/moveLog.test.ts test/lib/moveLog-mock-client.ts
git commit -m "Add lib/moveLog.ts: Redis-backed move operation log

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>"
```

---

### Task 3: Wire `moveMessage` to persist-before-mutate

**Files:**
- Modify: `lib/imap.ts` (the `moveMessage` function, `lib/imap.ts:232-256`)
- Test: `test/lib/imap.test.ts`
- Modify: `test/lib/imap-mock-client.ts` (extend the mock to support `fetchOne` and `mailbox` used by the new code path)

**Interfaces:**
- Consumes: `createPendingOperation`, `markConfirmed`, `markFailed`, `markUncertain` from `lib/moveLog.ts` (Task 2); `MoveIdentity` type.
- Produces: `moveMessage(params: MoveMessageParams): Promise<{ operationId: string | null }>` — `operationId` is `null` only for the same-folder no-op case (nothing was logged, matching the design's "no record for no-op" rule).

- [ ] **Step 1: Extend the mock IMAP client with `fetchOne` and a `mailbox` property**

Modify `test/lib/imap-mock-client.ts`:

```typescript
import { vi } from 'vitest';

export function createMockImapClient() {
  return {
    connect: vi.fn(),
    logout: vi.fn(),
    list: vi.fn(),
    getMailboxLock: vi.fn(async () => ({ release: vi.fn() })),
    messageMove: vi.fn(),
    fetchOne: vi.fn(),
    mailbox: { uidValidity: 1000n } as { uidValidity: bigint } | false,
  };
}

export type MockImapClient = ReturnType<typeof createMockImapClient>;
```

- [ ] **Step 2: Write failing tests for the persist-before-mutate flow**

In `test/lib/imap.test.ts`, update the hoisted mock and `freshImap()` helper to match the extended shape, and mock `lib/moveLog.js`:

```typescript
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mockClient = vi.hoisted(() => ({
  connect: vi.fn(),
  logout: vi.fn(),
  list: vi.fn(),
  getMailboxLock: vi.fn(async () => ({ release: vi.fn() })),
  messageMove: vi.fn(),
  fetchOne: vi.fn(),
  mailbox: { uidValidity: 1000n } as { uidValidity: bigint } | false,
}));

const mockMoveLog = vi.hoisted(() => ({
  createPendingOperation: vi.fn(async () => 'op-1'),
  markConfirmed: vi.fn(),
  markFailed: vi.fn(),
  markUncertain: vi.fn(),
}));

vi.mock('imapflow', () => ({
  ImapFlow: vi.fn().mockImplementation(function ImapFlowMock() {
    return mockClient;
  }),
}));

vi.mock('../../lib/moveLog.js', () => mockMoveLog);

async function freshImap() {
  vi.resetModules();
  for (const fn of Object.values(mockClient)) {
    if (typeof fn === 'function' && 'mockReset' in fn) (fn as ReturnType<typeof vi.fn>).mockReset();
  }
  for (const fn of Object.values(mockMoveLog)) {
    (fn as ReturnType<typeof vi.fn>).mockReset();
  }
  mockMoveLog.createPendingOperation.mockResolvedValue('op-1');
  mockClient.getMailboxLock.mockImplementation(async () => ({ release: vi.fn() }));
  mockClient.mailbox = { uidValidity: 1000n };
  mockClient.fetchOne.mockResolvedValue({
    envelope: { messageId: '<abc@example.com>', date: new Date('2026-09-01T00:00:00.000Z'), subject: 'Hello' },
  });
  mockClient.messageMove.mockResolvedValue({ path: 'INBOX', destination: 'INBOX.Archive', uidValidity: 2000n, uidMap: new Map([[1, 99]]) });
  mockClient.list.mockResolvedValue([
    { path: 'INBOX', name: 'INBOX' },
    { path: 'INBOX.Trash', name: 'Trash', specialUse: '\\Trash' },
    { path: 'INBOX.Junk', name: 'Junk', specialUse: '\\Junk' },
    { path: 'INBOX.Archive', name: 'Archive', specialUse: '\\Archive' },
  ]);
  process.env.ICLOUD_EMAIL = 'test@icloud.com';
  process.env.ICLOUD_APP_PASSWORD = 'app-specific-password';
  delete process.env.ALLOW_TRASH_JUNK_MOVES;
  return import('../../lib/imap.js');
}

describe('moveMessage', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('creates a pending operation record before calling messageMove', async () => {
    const imap = await freshImap();
    await imap.moveMessage({ folder: 'INBOX', uid: 1, targetFolder: 'INBOX.Archive' });
    expect(mockMoveLog.createPendingOperation).toHaveBeenCalledWith({
      sourcePath: 'INBOX',
      sourceUid: 1,
      sourceUidValidity: 1000n,
      destPath: 'INBOX.Archive',
      identity: { messageId: '<abc@example.com>', date: '2026-09-01T00:00:00.000Z', subject: 'Hello' },
    });
    const pendingCallOrder = mockMoveLog.createPendingOperation.mock.invocationCallOrder[0];
    const moveCallOrder = mockClient.messageMove.mock.invocationCallOrder[0];
    expect(pendingCallOrder).toBeLessThan(moveCallOrder);
  });

  it('marks the operation confirmed with the destination UID and UIDVALIDITY on success', async () => {
    const imap = await freshImap();
    const result = await imap.moveMessage({ folder: 'INBOX', uid: 1, targetFolder: 'INBOX.Archive' });
    expect(result).toEqual({ operationId: 'op-1' });
    expect(mockMoveLog.markConfirmed).toHaveBeenCalledWith('op-1', { destUid: 99, destUidValidity: 2000n });
  });

  it('marks the operation failed and rethrows when messageMove rejects with a clear protocol error', async () => {
    const imap = await freshImap();
    const err = Object.assign(new Error('NO command rejected'), { code: 'NO' });
    mockClient.messageMove.mockRejectedValue(err);
    await expect(imap.moveMessage({ folder: 'INBOX', uid: 1, targetFolder: 'INBOX.Archive' })).rejects.toThrow('NO command rejected');
    expect(mockMoveLog.markFailed).toHaveBeenCalledWith('op-1', 'NO command rejected');
    expect(mockMoveLog.markUncertain).not.toHaveBeenCalled();
  });

  it('marks the operation uncertain and rethrows when messageMove rejects with a timeout-shaped error', async () => {
    const imap = await freshImap();
    const err = Object.assign(new Error('socket timeout'), { code: 'ETIMEDOUT' });
    mockClient.messageMove.mockRejectedValue(err);
    await expect(imap.moveMessage({ folder: 'INBOX', uid: 1, targetFolder: 'INBOX.Archive' })).rejects.toThrow('socket timeout');
    expect(mockMoveLog.markUncertain).toHaveBeenCalledWith('op-1', 'socket timeout');
    expect(mockMoveLog.markFailed).not.toHaveBeenCalled();
  });

  it('does not create an operation record for a same-folder no-op', async () => {
    const imap = await freshImap();
    const result = await imap.moveMessage({ folder: 'INBOX', uid: 1, targetFolder: 'INBOX' });
    expect(result).toEqual({ operationId: null });
    expect(mockMoveLog.createPendingOperation).not.toHaveBeenCalled();
    expect(mockClient.messageMove).not.toHaveBeenCalled();
  });

  it('rejects a move to Trash and never calls messageMove or createPendingOperation', async () => {
    const imap = await freshImap();
    await expect(imap.moveMessage({ folder: 'INBOX', uid: 1, targetFolder: 'INBOX.Trash' })).rejects.toThrow(/blocked by default/);
    expect(mockClient.messageMove).not.toHaveBeenCalled();
    expect(mockMoveLog.createPendingOperation).not.toHaveBeenCalled();
  });

  it('allows a recovery move out of Trash', async () => {
    const imap = await freshImap();
    await imap.moveMessage({ folder: 'INBOX.Trash', uid: 1, targetFolder: 'INBOX' });
    expect(mockClient.messageMove).toHaveBeenCalledWith('1', 'INBOX', { uid: true });
  });

  it('rejects a move to an unresolvable folder', async () => {
    const imap = await freshImap();
    await expect(imap.moveMessage({ folder: 'INBOX', uid: 1, targetFolder: 'INBOX.DoesNotExist' })).rejects.toThrow(/does not exist/);
    expect(mockClient.messageMove).not.toHaveBeenCalled();
  });

  it('permits a move to Trash when ALLOW_TRASH_JUNK_MOVES=true', async () => {
    const imap = await freshImap();
    process.env.ALLOW_TRASH_JUNK_MOVES = 'true';
    await imap.moveMessage({ folder: 'INBOX', uid: 1, targetFolder: 'INBOX.Trash' });
    expect(mockClient.messageMove).toHaveBeenCalledWith('1', 'INBOX.Trash', { uid: true });
  });

  it('always logs out even when the policy check throws', async () => {
    const imap = await freshImap();
    await expect(imap.moveMessage({ folder: 'INBOX', uid: 1, targetFolder: 'INBOX.Trash' })).rejects.toThrow();
    expect(mockClient.logout).toHaveBeenCalledTimes(1);
  });

  it('always logs out even when messageMove rejects after the pending record is created', async () => {
    const imap = await freshImap();
    mockClient.messageMove.mockRejectedValue(new Error('boom'));
    await expect(imap.moveMessage({ folder: 'INBOX', uid: 1, targetFolder: 'INBOX.Archive' })).rejects.toThrow('boom');
    expect(mockClient.logout).toHaveBeenCalledTimes(1);
  });
});
```

- [ ] **Step 3: Run the tests to verify they fail**

Run: `npx vitest run test/lib/imap.test.ts`
Expected: FAIL — `moveMessage` doesn't yet call `moveLog` functions or return `{ operationId }`.

- [ ] **Step 4: Implement the persist-before-mutate flow in `lib/imap.ts`**

Replace the existing `moveMessage` function (`lib/imap.ts:238-256`) with:

```typescript
import {
  createPendingOperation,
  markConfirmed,
  markFailed,
  markUncertain,
  type MoveIdentity,
} from './moveLog.js';

// Network/protocol conditions where the server's actual state is unknown —
// the command may or may not have taken effect. Everything else (auth
// failures, explicit NO/BAD responses, folder-not-found, etc.) is treated as
// a clean failure: the server was reached and clearly rejected the command.
const UNCERTAIN_ERROR_CODES = new Set(['ETIMEDOUT', 'ECONNRESET', 'EPIPE', 'ECONNABORTED']);

function isUncertainMoveError(error: unknown): boolean {
  if (error && typeof error === 'object' && 'code' in error) {
    const code = (error as { code?: unknown }).code;
    if (typeof code === 'string' && UNCERTAIN_ERROR_CODES.has(code)) return true;
  }
  return false;
}

export interface MoveMessageParams {
  folder: string;
  uid: number;
  targetFolder: string;
}

export interface MoveMessageResult {
  operationId: string | null;
}

export async function moveMessage(params: MoveMessageParams): Promise<MoveMessageResult> {
  const client = getClient();
  await client.connect();
  try {
    const mailboxes = await client.list();
    assertMoveAllowed(mailboxes, params.folder, params.targetFolder);
    if (params.folder === params.targetFolder) {
      return { operationId: null }; // explicit no-op, nothing to log or undo
    }
    const lock = await client.getMailboxLock(params.folder);
    let operationId: string;
    try {
      const meta = await client.fetchOne(String(params.uid), { envelope: true }, { uid: true });
      const identity: MoveIdentity = {
        messageId: meta?.envelope?.messageId ?? null,
        date: meta?.envelope?.date ? meta.envelope.date.toISOString() : null,
        subject: meta?.envelope?.subject ?? null,
      };
      const sourceUidValidity = client.mailbox && client.mailbox !== false ? client.mailbox.uidValidity : 0n;
      operationId = await createPendingOperation({
        sourcePath: params.folder,
        sourceUid: params.uid,
        sourceUidValidity,
        destPath: params.targetFolder,
        identity,
      });
    } finally {
      lock.release();
    }

    const lock2 = await client.getMailboxLock(params.folder);
    try {
      let moveResult;
      try {
        moveResult = await client.messageMove(String(params.uid), params.targetFolder, { uid: true });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        if (isUncertainMoveError(error)) {
          await markUncertain(operationId, message);
        } else {
          await markFailed(operationId, message);
        }
        throw error;
      }
      if (!moveResult || moveResult.uidMap === undefined || moveResult.uidValidity === undefined) {
        await markUncertain(
          operationId,
          'Server did not confirm the move with a destination UID (no UIDPLUS support detected).',
        );
        throw new Error(
          `Move of message uid ${params.uid} to "${params.targetFolder}" could not be confirmed: the server did not report UIDPLUS details. The operation is recorded as uncertain.`,
        );
      }
      const destUid = moveResult.uidMap.get(params.uid);
      if (destUid === undefined) {
        await markUncertain(operationId, 'Server did not report a destination UID for this message.');
        throw new Error(
          `Move of message uid ${params.uid} to "${params.targetFolder}" could not be confirmed: no destination UID was returned. The operation is recorded as uncertain.`,
        );
      }
      await markConfirmed(operationId, { destUid, destUidValidity: moveResult.uidValidity });
      return { operationId };
    } finally {
      lock2.release();
    }
  } finally {
    await client.logout();
  }
}
```

Note: this replaces the single `getMailboxLock` call with two sequential locks (one to read envelope/uidValidity, one to perform the move) because the mock and the real client both re-acquire the lock per logical step in this codebase's existing style (see `getMessage`'s two-`fetchOne` pattern at `lib/imap.ts:163-205`, which re-locks conceptually per phase). Adjust the test mocks' `getMailboxLock` call-count expectations only if a test explicitly asserts a call count (none of the tests above do).

- [ ] **Step 5: Run the tests to verify they pass**

Run: `npx vitest run test/lib/imap.test.ts`
Expected: PASS (all tests, including the pre-existing policy tests which still exercise the same `assertMoveAllowed` call).

- [ ] **Step 6: Update the `move_message` tool registration to use the new return shape**

In `tools/mail.ts`, update the `move_message` handler (`tools/mail.ts:121-128`):

```typescript
async (args) => {
  try {
    const { operationId } = await moveMessage({ folder: args.folder, uid: args.uid, targetFolder: args.target_folder });
    return toResult(
      operationId
        ? { ok: true, operation_id: operationId, undoable_for_days: 7 }
        : { ok: true, note: 'Source and destination were the same folder; no move was performed.' },
    );
  } catch (error) {
    return toErrorResult(error);
  }
},
```

Update the tool's `description` (`tools/mail.ts:113-114`) to:

```typescript
description:
  'Moves a message from one folder to another. Moving into Trash or Junk is blocked by default and enforced by the server (not by this description) — there is no parameter to override it. Moving a message out of Trash or Junk is always allowed. On success, returns an operation_id that can be passed to undo_move within 7 days to reverse the move.',
```

- [ ] **Step 7: Typecheck**

Run: `npm run typecheck`
Expected: no errors.

- [ ] **Step 8: Run the full test suite**

Run: `npm test`
Expected: PASS.

- [ ] **Step 9: Commit**

```bash
git add lib/imap.ts tools/mail.ts test/lib/imap.test.ts test/lib/imap-mock-client.ts
git commit -m "Persist a durable operation record before every mailbox move

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>"
```

---

### Task 4: `undoMove` — reconciliation, verification, and reverse move

**Files:**
- Modify: `lib/imap.ts` (add `undoMove`, `listMoveOperations`, `getMoveOperation`)
- Test: `test/lib/imap-undo.test.ts`

**Interfaces:**
- Consumes: `getOperation`, `markUndone`, `acquireUndoLock`, `releaseUndoLock`, `listOperations` from `lib/moveLog.ts`; the internal move-execution logic factored out of Task 3's `moveMessage`.
- Produces:
  ```typescript
  export async function undoMove(operationId: string): Promise<{ newOperationId: string }>;
  export async function listMoveOperations(params: { limit?: number; cursor?: number }): Promise<import('./moveLog.js').ListOperationsResult>;
  export async function getMoveOperation(operationId: string): Promise<import('./moveLog.js').MoveOperationRecord | null>;
  ```

First, factor the lock-acquire + envelope-fetch + `messageMove` + status-update block out of `moveMessage` (Task 3) into a private helper so `undoMove` can call it for the reverse move without duplicating logic:

```typescript
async function executeLoggedMove(
  client: ImapFlow,
  args: { sourcePath: string; uid: number; destPath: string; undoOf?: string },
): Promise<MoveMessageResult> {
  const lock = await client.getMailboxLock(args.sourcePath);
  let operationId: string;
  try {
    const meta = await client.fetchOne(String(args.uid), { envelope: true }, { uid: true });
    const identity: MoveIdentity = {
      messageId: meta?.envelope?.messageId ?? null,
      date: meta?.envelope?.date ? meta.envelope.date.toISOString() : null,
      subject: meta?.envelope?.subject ?? null,
    };
    const sourceUidValidity = client.mailbox && client.mailbox !== false ? client.mailbox.uidValidity : 0n;
    operationId = await createPendingOperation({
      sourcePath: args.sourcePath,
      sourceUid: args.uid,
      sourceUidValidity,
      destPath: args.destPath,
      identity,
      undoOf: args.undoOf,
    });
  } finally {
    lock.release();
  }

  const lock2 = await client.getMailboxLock(args.sourcePath);
  try {
    let moveResult;
    try {
      moveResult = await client.messageMove(String(args.uid), args.destPath, { uid: true });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (isUncertainMoveError(error)) {
        await markUncertain(operationId, message);
      } else {
        await markFailed(operationId, message);
      }
      throw error;
    }
    if (!moveResult || moveResult.uidMap === undefined || moveResult.uidValidity === undefined) {
      await markUncertain(operationId, 'Server did not confirm the move with a destination UID (no UIDPLUS support detected).');
      throw new Error(
        `Move of message uid ${args.uid} to "${args.destPath}" could not be confirmed: the server did not report UIDPLUS details. The operation is recorded as uncertain.`,
      );
    }
    const destUid = moveResult.uidMap.get(args.uid);
    if (destUid === undefined) {
      await markUncertain(operationId, 'Server did not report a destination UID for this message.');
      throw new Error(
        `Move of message uid ${args.uid} to "${args.destPath}" could not be confirmed: no destination UID was returned. The operation is recorded as uncertain.`,
      );
    }
    await markConfirmed(operationId, { destUid, destUidValidity: moveResult.uidValidity });
    return { operationId };
  } finally {
    lock2.release();
  }
}
```

`moveMessage` (Task 3) then becomes a thin wrapper: connect, list, `assertMoveAllowed`, same-folder no-op check, `executeLoggedMove(client, { sourcePath: params.folder, uid: params.uid, destPath: params.targetFolder })`, logout.

- [ ] **Step 1: Write failing tests for `undoMove`**

Create `test/lib/imap-undo.test.ts`:

```typescript
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mockClient = vi.hoisted(() => ({
  connect: vi.fn(),
  logout: vi.fn(),
  list: vi.fn(),
  getMailboxLock: vi.fn(async () => ({ release: vi.fn() })),
  messageMove: vi.fn(),
  fetchOne: vi.fn(),
  search: vi.fn(),
  mailbox: { uidValidity: 1000n } as { uidValidity: bigint } | false,
}));

const mockMoveLog = vi.hoisted(() => ({
  createPendingOperation: vi.fn(async () => 'op-undo'),
  markConfirmed: vi.fn(),
  markFailed: vi.fn(),
  markUncertain: vi.fn(),
  markUndone: vi.fn(),
  getOperation: vi.fn(),
  acquireUndoLock: vi.fn(async () => true),
  releaseUndoLock: vi.fn(),
  listOperations: vi.fn(),
}));

vi.mock('imapflow', () => ({
  ImapFlow: vi.fn().mockImplementation(function ImapFlowMock() {
    return mockClient;
  }),
}));

vi.mock('../../lib/moveLog.js', () => mockMoveLog);

function confirmedRecord(overrides: Record<string, unknown> = {}) {
  return {
    id: 'op-1',
    status: 'confirmed',
    sourcePath: 'INBOX',
    sourceUid: 1,
    sourceUidValidity: '1000',
    destPath: 'INBOX.Archive',
    destUid: 99,
    destUidValidity: '2000',
    identity: { messageId: '<abc@example.com>', date: '2026-09-01T00:00:00.000Z', subject: 'Hello' },
    createdAt: 1000,
    confirmedAt: 1001,
    error: null,
    undoOf: null,
    undoneBy: null,
    ...overrides,
  };
}

async function freshImap() {
  vi.resetModules();
  for (const fn of Object.values(mockClient)) {
    if (typeof fn === 'function' && 'mockReset' in fn) (fn as ReturnType<typeof vi.fn>).mockReset();
  }
  for (const fn of Object.values(mockMoveLog)) {
    (fn as ReturnType<typeof vi.fn>).mockReset();
  }
  mockMoveLog.createPendingOperation.mockResolvedValue('op-undo');
  mockMoveLog.acquireUndoLock.mockResolvedValue(true);
  mockClient.getMailboxLock.mockImplementation(async () => ({ release: vi.fn() }));
  mockClient.mailbox = { uidValidity: 2000n };
  mockClient.list.mockResolvedValue([
    { path: 'INBOX', name: 'INBOX' },
    { path: 'INBOX.Trash', name: 'Trash', specialUse: '\\Trash' },
    { path: 'INBOX.Junk', name: 'Junk', specialUse: '\\Junk' },
    { path: 'INBOX.Archive', name: 'Archive', specialUse: '\\Archive' },
  ]);
  process.env.ICLOUD_EMAIL = 'test@icloud.com';
  process.env.ICLOUD_APP_PASSWORD = 'app-specific-password';
  delete process.env.ALLOW_TRASH_JUNK_MOVES;
  return import('../../lib/imap.js');
}

describe('undoMove', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('rejects when the operation is missing or expired', async () => {
    const imap = await freshImap();
    mockMoveLog.getOperation.mockResolvedValue(null);
    await expect(imap.undoMove('does-not-exist')).rejects.toThrow(/not found or has expired/);
  });

  it('rejects an already-undone operation idempotently by returning the prior undo', async () => {
    const imap = await freshImap();
    mockMoveLog.getOperation.mockResolvedValue(confirmedRecord({ status: 'undone', undoneBy: 'op-prev-undo' }));
    const result = await imap.undoMove('op-1');
    expect(result).toEqual({ newOperationId: 'op-prev-undo' });
    expect(mockClient.messageMove).not.toHaveBeenCalled();
  });

  it('rejects a failed operation', async () => {
    const imap = await freshImap();
    mockMoveLog.getOperation.mockResolvedValue(confirmedRecord({ status: 'failed', destUid: null, destUidValidity: null }));
    await expect(imap.undoMove('op-1')).rejects.toThrow(/nothing to undo/i);
  });

  it('rejects when the destination UIDVALIDITY no longer matches', async () => {
    const imap = await freshImap();
    mockMoveLog.getOperation.mockResolvedValue(confirmedRecord());
    mockClient.mailbox = { uidValidity: 9999n }; // stale compared to stored '2000'
    mockClient.fetchOne.mockResolvedValue({ envelope: { messageId: '<abc@example.com>', date: new Date('2026-09-01T00:00:00.000Z'), subject: 'Hello' } });
    await expect(imap.undoMove('op-1')).rejects.toThrow(/UIDVALIDITY/);
  });

  it('rejects when the message at destUid no longer matches the stored identity', async () => {
    const imap = await freshImap();
    mockMoveLog.getOperation.mockResolvedValue(confirmedRecord());
    mockClient.mailbox = { uidValidity: 2000n };
    mockClient.fetchOne.mockResolvedValue({ envelope: { messageId: '<different@example.com>', date: new Date('2026-09-01T00:00:00.000Z'), subject: 'Hello' } });
    await expect(imap.undoMove('op-1')).rejects.toThrow(/no longer match/);
  });

  it('performs the reverse move and marks the original operation undone', async () => {
    const imap = await freshImap();
    mockMoveLog.getOperation.mockResolvedValue(confirmedRecord());
    mockClient.mailbox = { uidValidity: 2000n };
    mockClient.fetchOne.mockResolvedValue({ envelope: { messageId: '<abc@example.com>', date: new Date('2026-09-01T00:00:00.000Z'), subject: 'Hello' } });
    mockClient.messageMove.mockResolvedValue({ path: 'INBOX.Archive', destination: 'INBOX', uidValidity: 1000n, uidMap: new Map([[99, 1]]) });
    const result = await imap.undoMove('op-1');
    expect(mockClient.messageMove).toHaveBeenCalledWith('99', 'INBOX', { uid: true });
    expect(mockMoveLog.createPendingOperation).toHaveBeenCalledWith(
      expect.objectContaining({ sourcePath: 'INBOX.Archive', sourceUid: 99, destPath: 'INBOX', undoOf: 'op-1' }),
    );
    expect(mockMoveLog.markUndone).toHaveBeenCalledWith('op-1', 'op-undo');
    expect(result).toEqual({ newOperationId: 'op-undo' });
  });

  it('applies the Trash/Junk policy to the reverse direction', async () => {
    const imap = await freshImap();
    mockMoveLog.getOperation.mockResolvedValue(confirmedRecord({ sourcePath: 'INBOX.Junk', destPath: 'INBOX' }));
    // Reverse move goes INBOX -> INBOX.Junk, which is prohibited by default.
    mockClient.mailbox = { uidValidity: 2000n };
    mockClient.fetchOne.mockResolvedValue({ envelope: { messageId: '<abc@example.com>', date: new Date('2026-09-01T00:00:00.000Z'), subject: 'Hello' } });
    await expect(imap.undoMove('op-1')).rejects.toThrow(/blocked by default/);
    expect(mockClient.messageMove).not.toHaveBeenCalled();
  });

  it('reconciles an uncertain operation to confirmed when the message is found at the destination', async () => {
    const imap = await freshImap();
    mockMoveLog.getOperation.mockResolvedValue(confirmedRecord({ status: 'uncertain' }));
    mockClient.mailbox = { uidValidity: 2000n };
    // First search call is against the source folder (no match), second against destination (match).
    mockClient.search.mockResolvedValueOnce([]).mockResolvedValueOnce([99]);
    mockClient.fetchOne.mockResolvedValue({ envelope: { messageId: '<abc@example.com>', date: new Date('2026-09-01T00:00:00.000Z'), subject: 'Hello' } });
    mockClient.messageMove.mockResolvedValue({ path: 'INBOX.Archive', destination: 'INBOX', uidValidity: 1000n, uidMap: new Map([[99, 1]]) });
    const result = await imap.undoMove('op-1');
    expect(mockMoveLog.markConfirmed).toHaveBeenCalledWith('op-1', { destUid: 99, destUidValidity: expect.anything() });
    expect(result).toEqual({ newOperationId: 'op-undo' });
  });

  it('resolves an uncertain operation to failed when the message is still at the source, and does not undo', async () => {
    const imap = await freshImap();
    mockMoveLog.getOperation.mockResolvedValue(confirmedRecord({ status: 'uncertain' }));
    mockClient.search.mockResolvedValueOnce([1]).mockResolvedValueOnce([]);
    await expect(imap.undoMove('op-1')).rejects.toThrow(/nothing to undo/i);
    expect(mockMoveLog.markFailed).toHaveBeenCalledWith('op-1', expect.stringContaining('did not occur'));
    expect(mockClient.messageMove).not.toHaveBeenCalled();
  });

  it('refuses to reconcile an uncertain operation when both or neither folder has a match', async () => {
    const imap = await freshImap();
    mockMoveLog.getOperation.mockResolvedValue(confirmedRecord({ status: 'uncertain' }));
    mockClient.search.mockResolvedValueOnce([]).mockResolvedValueOnce([]);
    await expect(imap.undoMove('op-1')).rejects.toThrow(/cannot automatically reconcile/i);
    expect(mockClient.messageMove).not.toHaveBeenCalled();
  });

  it('refuses to undo while another undo of the same operation is in progress', async () => {
    const imap = await freshImap();
    mockMoveLog.acquireUndoLock.mockResolvedValue(false);
    await expect(imap.undoMove('op-1')).rejects.toThrow(/already in progress/);
    expect(mockMoveLog.getOperation).not.toHaveBeenCalled();
  });

  it('always releases the undo lock, even when a later check throws', async () => {
    const imap = await freshImap();
    mockMoveLog.getOperation.mockResolvedValue(null);
    await expect(imap.undoMove('op-1')).rejects.toThrow();
    expect(mockMoveLog.releaseUndoLock).toHaveBeenCalledWith('op-1');
  });
});

describe('listMoveOperations / getMoveOperation', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('delegates to moveLog.listOperations', async () => {
    const imap = await freshImap();
    mockMoveLog.listOperations.mockResolvedValue({ operations: [], nextCursor: null });
    const result = await imap.listMoveOperations({ limit: 5 });
    expect(mockMoveLog.listOperations).toHaveBeenCalledWith({ limit: 5, cursor: undefined });
    expect(result).toEqual({ operations: [], nextCursor: null });
  });

  it('delegates to moveLog.getOperation', async () => {
    const imap = await freshImap();
    mockMoveLog.getOperation.mockResolvedValue(confirmedRecord());
    const result = await imap.getMoveOperation('op-1');
    expect(result).toEqual(confirmedRecord());
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run test/lib/imap-undo.test.ts`
Expected: FAIL — `undoMove`, `listMoveOperations`, `getMoveOperation` don't exist yet.

- [ ] **Step 3: Implement `undoMove`, `listMoveOperations`, `getMoveOperation` in `lib/imap.ts`**

Add after `executeLoggedMove` (and the refactored `moveMessage` from Task 4's setup):

```typescript
import {
  acquireUndoLock,
  getOperation,
  listOperations,
  markUndone,
  releaseUndoLock,
  type MoveOperationRecord,
} from './moveLog.js';

function identityMatches(
  a: { messageId: string | null; date: string | null; subject: string | null },
  b: { messageId: string | null; date: string | null; subject: string | null },
): boolean {
  if (a.messageId && b.messageId) return a.messageId === b.messageId;
  return a.date === b.date && a.subject === b.subject;
}

async function findByIdentity(
  client: ImapFlow,
  folder: string,
  identity: MoveOperationRecord['identity'],
): Promise<number | null> {
  const lock = await client.getMailboxLock(folder);
  try {
    const uids = await client.search({ header: { 'message-id': identity.messageId ?? '' } }, { uid: true });
    return uids && uids.length > 0 ? uids[0] : null;
  } finally {
    lock.release();
  }
}

export async function undoMove(operationId: string): Promise<{ newOperationId: string }> {
  const locked = await acquireUndoLock(operationId);
  if (!locked) {
    throw new Error(`An undo for operation ${operationId} is already in progress. Try again shortly.`);
  }
  try {
    const record = await getOperation(operationId);
    if (!record) {
      throw new Error(`Move operation ${operationId} not found or has expired.`);
    }
    if (record.status === 'undone') {
      return { newOperationId: record.undoneBy as string };
    }
    if (record.status === 'failed' || record.destUid === null) {
      throw new Error(`Move operation ${operationId} has nothing to undo (the original move did not complete).`);
    }

    const client = getClient();
    await client.connect();
    try {
      let effectiveRecord = record;
      if (record.status === 'uncertain') {
        const sourceMatch = await findByIdentity(client, record.sourcePath, record.identity);
        const destMatch = await findByIdentity(client, record.destPath, record.identity);
        if (sourceMatch !== null && destMatch === null) {
          const { markFailed } = await import('./moveLog.js');
          await markFailed(operationId, 'Reconciliation found the message still at the source folder; the move did not occur.');
          throw new Error(`Move operation ${operationId} has nothing to undo (the original move did not occur).`);
        }
        if (destMatch !== null && sourceMatch === null) {
          const destMailboxes = await client.list();
          const destInfo = destMailboxes.find((m) => m.path === record.destPath);
          const { markConfirmed } = await import('./moveLog.js');
          await markConfirmed(operationId, {
            destUid: destMatch,
            destUidValidity: destInfo ? (destInfo as unknown as { uidValidity?: bigint }).uidValidity ?? 0n : 0n,
          });
          effectiveRecord = { ...record, status: 'confirmed', destUid: destMatch };
        } else {
          throw new Error(
            `Cannot automatically reconcile move operation ${operationId}: manual verification is required.`,
          );
        }
      }

      const destUid = effectiveRecord.destUid as number;
      const mailboxes = await client.list();
      assertMoveAllowed(mailboxes, effectiveRecord.destPath, effectiveRecord.sourcePath);

      const currentUidValidity = client.mailbox && client.mailbox !== false ? client.mailbox.uidValidity : null;
      // Open the destination folder to read its current UIDVALIDITY and re-verify identity.
      const destLock = await client.getMailboxLock(effectiveRecord.destPath);
      let destMeta;
      try {
        destMeta = await client.fetchOne(String(destUid), { envelope: true }, { uid: true });
      } finally {
        destLock.release();
      }
      const liveUidValidity = client.mailbox && client.mailbox !== false ? client.mailbox.uidValidity : currentUidValidity;
      if (liveUidValidity === null || liveUidValidity.toString() !== effectiveRecord.destUidValidity) {
        throw new Error(
          `Cannot undo move operation ${operationId}: the destination folder's UIDVALIDITY has changed since the move, so UIDs are no longer trustworthy.`,
        );
      }
      if (!destMeta) {
        throw new Error(`Cannot undo move operation ${operationId}: the message is no longer at the recorded destination.`);
      }
      const liveIdentity = {
        messageId: destMeta.envelope?.messageId ?? null,
        date: destMeta.envelope?.date ? destMeta.envelope.date.toISOString() : null,
        subject: destMeta.envelope?.subject ?? null,
      };
      if (!identityMatches(liveIdentity, effectiveRecord.identity)) {
        throw new Error(
          `Cannot undo move operation ${operationId}: the message at the recorded destination UID no longer matches what was originally moved.`,
        );
      }

      const { operationId: newOperationId } = await executeLoggedMove(client, {
        sourcePath: effectiveRecord.destPath,
        uid: destUid,
        destPath: effectiveRecord.sourcePath,
        undoOf: operationId,
      });
      await markUndone(operationId, newOperationId as string);
      return { newOperationId: newOperationId as string };
    } finally {
      await client.logout();
    }
  } finally {
    await releaseUndoLock(operationId);
  }
}

export async function listMoveOperations(params: { limit?: number; cursor?: number }) {
  return listOperations({ limit: params.limit, cursor: params.cursor });
}

export async function getMoveOperation(operationId: string): Promise<MoveOperationRecord | null> {
  return getOperation(operationId);
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run test/lib/imap-undo.test.ts`
Expected: PASS (all tests). Debug any mismatch between the mock's `search`/`fetchOne` call sequencing and `findByIdentity`'s two sequential calls (source then destination) — the test relies on `mockResolvedValueOnce` ordering matching call order exactly.

- [ ] **Step 5: Run the full existing imap test file to check nothing regressed from the `moveMessage` refactor**

Run: `npx vitest run test/lib/imap.test.ts`
Expected: PASS.

- [ ] **Step 6: Typecheck**

Run: `npm run typecheck`
Expected: no errors. Fix any type issues from the `client.mailbox` narrowing (`MailboxObject | false`) or the dynamic `import('./moveLog.js')` calls — prefer hoisting those two dynamic imports to static top-level imports of `markFailed`/`markConfirmed` (already imported in Task 3's block) instead of using `await import(...)` inline; remove the inline dynamic imports and reuse the top-level ones.

- [ ] **Step 7: Run the full test suite**

Run: `npm test`
Expected: PASS.

- [ ] **Step 8: Commit**

```bash
git add lib/imap.ts test/lib/imap-undo.test.ts
git commit -m "Add undoMove with UIDVALIDITY/identity verification and reconciliation

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>"
```

---

### Task 5: Register `undo_move`, `list_move_operations`, `get_move_operation` MCP tools

**Files:**
- Modify: `tools/mail.ts`
- Modify: `lib/types.ts` (no new types needed here — tools return `MoveOperationRecord` directly from `lib/moveLog.ts`, imported in `tools/mail.ts`)

**Interfaces:**
- Consumes: `undoMove`, `listMoveOperations`, `getMoveOperation` from `lib/imap.ts` (Task 4).

- [ ] **Step 1: Add the three tool registrations**

In `tools/mail.ts`, update the import block:

```typescript
import {
  flagMessage,
  getMessage,
  getMoveOperation,
  listFolders,
  listMessages,
  listMoveOperations,
  markMessage,
  moveMessage,
  undoMove,
} from '../lib/imap.js';
```

Append these registrations after `flag_message` (before the closing `}` of `registerMailTools`):

```typescript
  server.registerTool(
    'undo_move',
    {
      title: 'Undo Message Move',
      description:
        'Reverses a previous move_message operation, using its operation_id. Verifies the destination folder\'s UIDVALIDITY and the message\'s identity before moving anything back, and applies the same Trash/Junk destination policy as move_message in reverse. Operations remain undoable for 7 days. An uncertain operation (the original move could not be confirmed) is automatically reconciled where possible before undoing.',
      inputSchema: {
        operation_id: z.string().describe('The operation_id returned by move_message or a previous undo_move'),
      },
    },
    async (args) => {
      try {
        const { newOperationId } = await undoMove(args.operation_id);
        return toResult({ ok: true, operation_id: newOperationId });
      } catch (error) {
        return toErrorResult(error);
      }
    },
  );

  server.registerTool(
    'list_move_operations',
    {
      title: 'List Move Operations',
      description:
        'Lists recent move_message operations, most recent first, including their status (pending, confirmed, failed, uncertain, or undone). Use with undo_move to reverse a move, or get_move_operation to inspect one in detail.',
      inputSchema: {
        limit: z.number().int().positive().max(100).optional().describe('Max operations to return, default 20'),
        cursor: z.number().int().nonnegative().optional().describe('Pagination cursor from a previous call\'s next_cursor'),
      },
    },
    async (args) => {
      try {
        const result = await listMoveOperations({ limit: args.limit, cursor: args.cursor });
        return toResult({ operations: result.operations, next_cursor: result.nextCursor });
      } catch (error) {
        return toErrorResult(error);
      }
    },
  );

  server.registerTool(
    'get_move_operation',
    {
      title: 'Get Move Operation',
      description: 'Returns the full record for one move_message operation by its operation_id.',
      inputSchema: {
        operation_id: z.string().describe('The operation_id to look up'),
      },
    },
    async (args) => {
      try {
        const record = await getMoveOperation(args.operation_id);
        if (!record) {
          return toErrorResult(new Error(`Move operation ${args.operation_id} not found or has expired.`));
        }
        return toResult(record);
      } catch (error) {
        return toErrorResult(error);
      }
    },
  );
```

- [ ] **Step 2: Typecheck**

Run: `npm run typecheck`
Expected: no errors.

- [ ] **Step 3: Verify tool registration doesn't throw**

The MCP SDK's `McpServer` has no direct-call API for a registered tool's handler short of a full client/transport round-trip, and standing one up here would duplicate transport-layer testing without adding coverage — the handlers are thin wrappers already covered by `lib/imap.ts`'s unit tests from Task 4, and `registerTool` throws synchronously on a malformed schema or a duplicate name. So this step is a smoke check, not a new test file:

Run: `npx tsx -e "import('./tools/mail.js').then(async m => { const { McpServer } = await import('@modelcontextprotocol/sdk/server/mcp.js'); const server = new McpServer({ name: 't', version: '0.0.0' }); m.registerMailTools(server); console.log('registered ok'); })"`

Expected: prints `registered ok` with no thrown error, confirming all eight mail tools (five existing plus the three new ones) register cleanly.

- [ ] **Step 4: Confirm no existing test file asserts the old `moveMessage` void return type**

Run: `grep -rn "moveMessage(" test/ tools/ lib/` and confirm every call site either destructures `{ operationId }` / `{ newOperationId }` or ignores the return value with `await moveMessage(...)` (both are valid since the function no longer returns `void` but the old call sites that don't use the return value still compile).

Expected: no call site still asserts `expect(await imap.moveMessage(...)).toBeUndefined()` or similar from before Task 3 — the earlier `test/lib/imap.test.ts` tests were already rewritten in Task 3, Step 2.

- [ ] **Step 5: Run the full test suite and typecheck one more time**

Run: `npm run typecheck && npm test`
Expected: both pass.

- [ ] **Step 6: Commit**

```bash
git add tools/mail.ts
git commit -m "Register undo_move, list_move_operations, and get_move_operation tools

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>"
```

---

### Task 6: Documentation and final validation

**Files:**
- Modify: `README.md` (tool table, new "Undoing a move" section)
- Modify: `docs/superpowers/specs/2026-09-07-durable-move-undo-design.md` (only if implementation diverged — see Step 1)

- [ ] **Step 1: Reconcile the spec with what was actually built**

Re-read `docs/superpowers/specs/2026-09-07-durable-move-undo-design.md` against the code just written. If anything diverged (e.g. the final key layout uses plain JSON strings under `move:op:<id>` rather than a Redis hash — this plan chose JSON strings for simplicity, see Task 2), update the spec's "Data model" section to match reality, so the spec stays an accurate record. Commit that fix separately if made:

```bash
git add docs/superpowers/specs/2026-09-07-durable-move-undo-design.md
git commit -m "Update Phase C spec to match the JSON-string Redis key layout used in implementation

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>"
```

- [ ] **Step 2: Update the README's tool table**

Add three rows to the existing tool table for `undo_move`, `list_move_operations`, `get_move_operation`, matching the style of the existing rows (tool name, one-line description). Update the `move_message` row's description to mention it returns an `operation_id`.

- [ ] **Step 3: Add a "Recovering from a move" section to the README**

Add a short section (after the existing "Mailbox safety" section) explaining: every `move_message` call is durably logged for 7 days; `undo_move` reverses it, re-verifying the message is still where it was left before doing anything; `list_move_operations` and `get_move_operation` let you inspect the log; an operation marked "uncertain" means the original move's outcome couldn't be confirmed, and `undo_move` will attempt to reconcile it automatically before acting. Use British English throughout.

- [ ] **Step 4: Run `npm audit` and record the result**

Run: `npm audit`
Expected: report whatever it finds (this plan does not gate on zero findings, but any new critical/high finding introduced by `@upstash/redis` or its dependencies should be investigated the same way the original `@vercel/node`/`vitest` audit findings were — via `npm ls <package>` to trace the source — before proceeding).

- [ ] **Step 5: Full validation pass**

Run: `npm run typecheck && npm test && npm audit`
Expected: typecheck and tests pass; audit result recorded (see Step 4).

- [ ] **Step 6: Commit the documentation changes**

```bash
git add README.md
git commit -m "Document move-undo tools and recovery workflow

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>"
```

---

## Summary of what this plan does NOT cover (explicitly out of scope, per the design doc)

- Read-only mode and rate limiting on moves (Phase D — separate plan).
- Any live iCloud or live Upstash verification — all testing here is against mocks and synthetic fixtures, per the review's explicit constraint.
- Deployment to Vercel and live smoke-testing of the new tools — that happens after this plan's branch is finished and merged, following the same push-and-verify pattern used for Phases A and B (verifying the tool count via `tools/list`, and manually confirming the new tools appear — not exercising them against a real mailbox).
