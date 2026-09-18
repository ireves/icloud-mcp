import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createMockSupabaseClient, type RecordedQuery } from './supabase-mock-client.js';

const supabase = vi.hoisted(async () => {
  const { createMockSupabaseClient: create } = await import('./supabase-mock-client.js');
  return { client: create() };
});

vi.mock('../../lib/supabase.js', async () => {
  const actual = await import('../../lib/supabase.js');
  const holder = await supabase;
  return {
    ...actual,
    getSupabase: vi.fn(() => holder.client),
  };
});

const OPERATIONS = 'move_operations';
const LOCKS = 'undo_locks';

let client: ReturnType<typeof createMockSupabaseClient>;

function filterValue(query: RecordedQuery | undefined, kind: string, column: string): unknown {
  return query?.filters.find(([k, c]) => k === kind && c === column)?.[2];
}

async function freshMoveLog() {
  vi.resetModules();
  return import('../../lib/moveLog.js');
}

const storedRow = (overrides: Record<string, unknown> = {}) => ({
  id: 'aaaaaaaa-0000-4000-8000-000000000001',
  status: 'pending',
  source_path: 'INBOX',
  source_uid: 1,
  source_uid_validity: '1000',
  dest_path: 'INBOX.Archive',
  dest_uid: null,
  dest_uid_validity: null,
  identity: { messageId: null, date: null, subject: null },
  created_at: '2026-09-01T00:00:00.000Z',
  confirmed_at: null,
  error: null,
  undo_of: null,
  undone_by: null,
  ...overrides,
});

beforeEach(async () => {
  client = (await supabase).client;
  client.reset();
});

describe('createPendingOperation / getOperation', () => {
  it('inserts a pending row carrying its own expiry', async () => {
    const moveLog = await freshMoveLog();
    const before = Date.now();
    const id = await moveLog.createPendingOperation({
      sourcePath: 'INBOX',
      sourceUid: 42,
      sourceUidValidity: 1000n,
      destPath: 'INBOX.Archive',
      identity: { messageId: '<abc@example.com>', date: '2026-09-01T00:00:00.000Z', subject: 'Hello' },
    });

    expect(typeof id).toBe('string');
    const inserted = client.lastCall(OPERATIONS, 'insert')?.args as Record<string, unknown>;
    expect(inserted).toMatchObject({
      id,
      status: 'pending',
      source_path: 'INBOX',
      source_uid: 42,
      source_uid_validity: '1000',
      dest_path: 'INBOX.Archive',
      dest_uid: null,
      undo_of: null,
    });
    const ttlMs = moveLog.OPERATION_TTL_SECONDS * 1000;
    const expiresAt = Date.parse(inserted.expires_at as string);
    expect(expiresAt).toBeGreaterThanOrEqual(before + ttlMs);
    expect(expiresAt).toBeLessThanOrEqual(Date.now() + ttlMs);
  });

  it('records the operation an undo reverses', async () => {
    const moveLog = await freshMoveLog();
    await moveLog.createPendingOperation({
      sourcePath: 'INBOX.Archive',
      sourceUid: 99,
      sourceUidValidity: 2000n,
      destPath: 'INBOX',
      identity: { messageId: null, date: null, subject: null },
      undoOf: 'aaaaaaaa-0000-4000-8000-000000000001',
    });

    const inserted = client.lastCall(OPERATIONS, 'insert')?.args as Record<string, unknown>;
    expect(inserted.undo_of).toBe('aaaaaaaa-0000-4000-8000-000000000001');
  });

  it('maps a stored row back to a record', async () => {
    const moveLog = await freshMoveLog();
    client.queueData(
      OPERATIONS,
      'select',
      storedRow({ status: 'confirmed', dest_uid: 99, dest_uid_validity: '2000', confirmed_at: '2026-09-01T00:01:00.000Z' }),
    );

    const result = await moveLog.getOperation('aaaaaaaa-0000-4000-8000-000000000001');

    expect(result).toEqual({
      id: 'aaaaaaaa-0000-4000-8000-000000000001',
      status: 'confirmed',
      sourcePath: 'INBOX',
      sourceUid: 1,
      sourceUidValidity: '1000',
      destPath: 'INBOX.Archive',
      destUid: 99,
      destUidValidity: '2000',
      identity: { messageId: null, date: null, subject: null },
      createdAt: Date.parse('2026-09-01T00:00:00.000Z'),
      confirmedAt: Date.parse('2026-09-01T00:01:00.000Z'),
      error: null,
      undoOf: null,
      undoneBy: null,
    });
  });

  it('hides an operation past its retention window', async () => {
    const moveLog = await freshMoveLog();
    const before = Date.now();

    await moveLog.getOperation('aaaaaaaa-0000-4000-8000-000000000001');

    const query = client.lastCall(OPERATIONS, 'select');
    expect(filterValue(query, 'eq', 'id')).toBe('aaaaaaaa-0000-4000-8000-000000000001');
    const cutoff = Date.parse(filterValue(query, 'gt', 'expires_at') as string);
    expect(cutoff).toBeGreaterThanOrEqual(before);
    expect(cutoff).toBeLessThanOrEqual(Date.now());
  });

  it('returns null for a missing or expired operation', async () => {
    const moveLog = await freshMoveLog();
    client.queueData(OPERATIONS, 'select', null);
    expect(await moveLog.getOperation('does-not-exist')).toBeNull();
  });

  it('throws when the insert is rejected', async () => {
    const moveLog = await freshMoveLog();
    client.queueError(OPERATIONS, 'insert', { message: 'permission denied' });
    await expect(
      moveLog.createPendingOperation({
        sourcePath: 'INBOX',
        sourceUid: 1,
        sourceUidValidity: 1n,
        destPath: 'INBOX.Archive',
        identity: { messageId: null, date: null, subject: null },
      }),
    ).rejects.toThrow(/Recording the move operation failed: permission denied/);
  });
});

describe('status transitions', () => {
  it('markConfirmed sets destUid, destUidValidity, confirmedAt, and status', async () => {
    const moveLog = await freshMoveLog();
    client.queueData(OPERATIONS, 'select', storedRow());

    await moveLog.markConfirmed('aaaaaaaa-0000-4000-8000-000000000001', {
      destUid: 99,
      destUidValidity: 2000n,
    });

    const update = client.lastCall(OPERATIONS, 'update');
    expect(update?.args).toMatchObject({
      status: 'confirmed',
      dest_uid: 99,
      dest_uid_validity: '2000',
    });
    expect((update?.args as Record<string, unknown>).confirmed_at).toEqual(expect.any(String));
    expect(filterValue(update, 'eq', 'id')).toBe('aaaaaaaa-0000-4000-8000-000000000001');
  });

  it('markFailed sets status and error, and touches nothing else', async () => {
    const moveLog = await freshMoveLog();
    client.queueData(OPERATIONS, 'select', storedRow());

    await moveLog.markFailed('aaaaaaaa-0000-4000-8000-000000000001', 'connection refused');

    expect(client.lastCall(OPERATIONS, 'update')?.args).toEqual({
      status: 'failed',
      error: 'connection refused',
    });
  });

  it('markUncertain sets status and error', async () => {
    const moveLog = await freshMoveLog();
    client.queueData(OPERATIONS, 'select', storedRow());

    await moveLog.markUncertain('aaaaaaaa-0000-4000-8000-000000000001', 'timeout');

    expect(client.lastCall(OPERATIONS, 'update')?.args).toEqual({
      status: 'uncertain',
      error: 'timeout',
    });
  });

  it('markUndone sets status to undone and records undoneBy', async () => {
    const moveLog = await freshMoveLog();
    client.queueData(OPERATIONS, 'select', storedRow({ status: 'confirmed', dest_uid: 99 }));

    await moveLog.markUndone(
      'aaaaaaaa-0000-4000-8000-000000000001',
      'aaaaaaaa-0000-4000-8000-000000000002',
    );

    expect(client.lastCall(OPERATIONS, 'update')?.args).toEqual({
      status: 'undone',
      undone_by: 'aaaaaaaa-0000-4000-8000-000000000002',
    });
  });

  it('throws when updating an operation that has expired', async () => {
    const moveLog = await freshMoveLog();
    client.queueData(OPERATIONS, 'select', null);

    await expect(
      moveLog.markConfirmed('gone', { destUid: 1, destUidValidity: 1n }),
    ).rejects.toThrow(/not found or has expired/);
    expect(client.callsFor(OPERATIONS, 'update')).toHaveLength(0);
  });
});

describe('listOperations', () => {
  it('reads a page newest-first and reports a nextCursor when the page is full', async () => {
    const moveLog = await freshMoveLog();
    client.queueData(OPERATIONS, 'select', [
      storedRow({ id: 'aaaaaaaa-0000-4000-8000-000000000002', created_at: '2026-09-02T00:00:00.000Z' }),
      storedRow({ id: 'aaaaaaaa-0000-4000-8000-000000000001' }),
    ]);

    const result = await moveLog.listOperations({ limit: 2 });

    expect(result.operations.map((o) => o.id)).toEqual([
      'aaaaaaaa-0000-4000-8000-000000000002',
      'aaaaaaaa-0000-4000-8000-000000000001',
    ]);
    expect(result.nextCursor).toBe(2);
    const query = client.lastCall(OPERATIONS, 'select');
    expect(query?.order).toEqual(['created_at', { ascending: false }]);
    expect(query?.range).toEqual([0, 1]);
  });

  it('reports no nextCursor when the page comes back short', async () => {
    const moveLog = await freshMoveLog();
    client.queueData(OPERATIONS, 'select', [storedRow()]);

    const result = await moveLog.listOperations({ limit: 20 });

    expect(result.nextCursor).toBeNull();
  });

  it('starts from the cursor it is given', async () => {
    const moveLog = await freshMoveLog();
    client.queueData(OPERATIONS, 'select', []);

    await moveLog.listOperations({ limit: 5, cursor: 10 });

    expect(client.lastCall(OPERATIONS, 'select')?.range).toEqual([10, 14]);
  });

  it('leaves out operations past their retention window', async () => {
    const moveLog = await freshMoveLog();
    client.queueData(OPERATIONS, 'select', []);

    const result = await moveLog.listOperations({});

    expect(result.operations).toEqual([]);
    expect(filterValue(client.lastCall(OPERATIONS, 'select'), 'gt', 'expires_at')).toEqual(
      expect.any(String),
    );
  });

  it('caps the limit at MAX_LIST_LIMIT', async () => {
    const moveLog = await freshMoveLog();
    client.queueData(OPERATIONS, 'select', []);

    await moveLog.listOperations({ limit: 10000 });

    expect(client.lastCall(OPERATIONS, 'select')?.range).toEqual([0, moveLog.MAX_LIST_LIMIT - 1]);
  });
});

describe('undo lock', () => {
  it('claims the lock when the insert succeeds', async () => {
    const moveLog = await freshMoveLog();
    const before = Date.now();

    expect(await moveLog.acquireUndoLock('aaaaaaaa-0000-4000-8000-000000000001')).toBe(true);

    const inserted = client.lastCall(LOCKS, 'insert')?.args as Record<string, unknown>;
    expect(inserted.operation_id).toBe('aaaaaaaa-0000-4000-8000-000000000001');
    const ttlMs = moveLog.UNDO_LOCK_TTL_SECONDS * 1000;
    expect(Date.parse(inserted.expires_at as string)).toBeGreaterThanOrEqual(before + ttlMs);
  });

  it('clears only an expired lock for the same operation before claiming', async () => {
    const moveLog = await freshMoveLog();

    await moveLog.acquireUndoLock('aaaaaaaa-0000-4000-8000-000000000001');

    const clear = client.lastCall(LOCKS, 'delete');
    expect(filterValue(clear, 'eq', 'operation_id')).toBe('aaaaaaaa-0000-4000-8000-000000000001');
    expect(filterValue(clear, 'lte', 'expires_at')).toEqual(expect.any(String));
  });

  it('reports the lock as held when the primary key rejects the insert', async () => {
    const moveLog = await freshMoveLog();
    client.queueError(LOCKS, 'insert', { message: 'duplicate key value', code: '23505' });

    expect(await moveLog.acquireUndoLock('aaaaaaaa-0000-4000-8000-000000000001')).toBe(false);
  });

  it('throws on a database error that is not a conflict', async () => {
    const moveLog = await freshMoveLog();
    client.queueError(LOCKS, 'insert', { message: 'permission denied', code: '42501' });

    await expect(moveLog.acquireUndoLock('aaaaaaaa-0000-4000-8000-000000000001')).rejects.toThrow(
      /Acquiring the undo lock failed: permission denied/,
    );
  });

  it('releaseUndoLock deletes the row for that operation', async () => {
    const moveLog = await freshMoveLog();

    await moveLog.releaseUndoLock('aaaaaaaa-0000-4000-8000-000000000001');

    const query = client.lastCall(LOCKS, 'delete');
    expect(filterValue(query, 'eq', 'operation_id')).toBe('aaaaaaaa-0000-4000-8000-000000000001');
    expect(query?.filters.some(([kind]) => kind === 'lte')).toBe(false);
  });
});
