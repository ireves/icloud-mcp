import { beforeEach, describe, expect, it, vi } from 'vitest';

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
  // A regular function, not an arrow function: the code under test invokes
  // this with `new Redis(...)`, and arrow functions cannot be constructors.
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
    mockRedis.get.mockResolvedValue(
      JSON.stringify(baseRecord({ status: 'confirmed', destUid: 99, destUidValidity: '2000' })),
    );
    await moveLog.markUndone('op-1', 'op-2');
    const parsed = JSON.parse((mockRedis.set.mock.calls[0] as [string, string])[1]);
    expect(parsed.status).toBe('undone');
    expect(parsed.undoneBy).toBe('op-2');
  });

  it('throws when updating an operation that has expired', async () => {
    const moveLog = await freshMoveLog();
    mockRedis.get.mockResolvedValue(null);
    await expect(moveLog.markConfirmed('gone', { destUid: 1, destUidValidity: 1n })).rejects.toThrow(
      /not found or has expired/,
    );
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
