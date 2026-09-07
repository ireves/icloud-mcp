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
  // A regular function, not an arrow function: the code under test invokes
  // this with `new ImapFlow(...)`, and arrow functions cannot be constructors.
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
  mockClient.messageMove.mockResolvedValue({
    path: 'INBOX',
    destination: 'INBOX.Archive',
    uidValidity: 2000n,
    uidMap: new Map([[1, 99]]),
  });
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
    await expect(
      imap.moveMessage({ folder: 'INBOX', uid: 1, targetFolder: 'INBOX.Archive' }),
    ).rejects.toThrow('NO command rejected');
    expect(mockMoveLog.markFailed).toHaveBeenCalledWith('op-1', 'NO command rejected');
    expect(mockMoveLog.markUncertain).not.toHaveBeenCalled();
  });

  it('marks the operation uncertain and rethrows when messageMove rejects with a timeout-shaped error', async () => {
    const imap = await freshImap();
    const err = Object.assign(new Error('socket timeout'), { code: 'ETIMEDOUT' });
    mockClient.messageMove.mockRejectedValue(err);
    await expect(
      imap.moveMessage({ folder: 'INBOX', uid: 1, targetFolder: 'INBOX.Archive' }),
    ).rejects.toThrow('socket timeout');
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
    await expect(
      imap.moveMessage({ folder: 'INBOX', uid: 1, targetFolder: 'INBOX.Trash' }),
    ).rejects.toThrow(/blocked by default/);
    expect(mockClient.messageMove).not.toHaveBeenCalled();
    expect(mockMoveLog.createPendingOperation).not.toHaveBeenCalled();
  });

  it('rejects a move to Junk and never calls messageMove', async () => {
    const imap = await freshImap();
    await expect(
      imap.moveMessage({ folder: 'INBOX', uid: 1, targetFolder: 'INBOX.Junk' }),
    ).rejects.toThrow(/blocked by default/);
    expect(mockClient.messageMove).not.toHaveBeenCalled();
  });

  it('allows a recovery move out of Trash', async () => {
    const imap = await freshImap();
    await imap.moveMessage({ folder: 'INBOX.Trash', uid: 1, targetFolder: 'INBOX' });
    expect(mockClient.messageMove).toHaveBeenCalledWith('1', 'INBOX', { uid: true });
  });

  it('rejects a move to an unresolvable folder', async () => {
    const imap = await freshImap();
    await expect(
      imap.moveMessage({ folder: 'INBOX', uid: 1, targetFolder: 'INBOX.DoesNotExist' }),
    ).rejects.toThrow(/does not exist/);
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
    await expect(
      imap.moveMessage({ folder: 'INBOX', uid: 1, targetFolder: 'INBOX.Archive' }),
    ).rejects.toThrow('boom');
    expect(mockClient.logout).toHaveBeenCalledTimes(1);
  });
});
