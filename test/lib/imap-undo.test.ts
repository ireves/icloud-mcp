import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

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
    mockMoveLog.getOperation.mockResolvedValue(
      confirmedRecord({ status: 'failed', destUid: null, destUidValidity: null }),
    );
    await expect(imap.undoMove('op-1')).rejects.toThrow(/nothing to undo/i);
  });

  it('rejects when the destination UIDVALIDITY no longer matches', async () => {
    const imap = await freshImap();
    mockMoveLog.getOperation.mockResolvedValue(confirmedRecord());
    mockClient.mailbox = { uidValidity: 9999n }; // stale compared to stored '2000'
    mockClient.fetchOne.mockResolvedValue({
      envelope: { messageId: '<abc@example.com>', date: new Date('2026-09-01T00:00:00.000Z'), subject: 'Hello' },
    });
    await expect(imap.undoMove('op-1')).rejects.toThrow(/UIDVALIDITY/);
  });

  it('rejects when the message at destUid no longer matches the stored identity', async () => {
    const imap = await freshImap();
    mockMoveLog.getOperation.mockResolvedValue(confirmedRecord());
    mockClient.mailbox = { uidValidity: 2000n };
    mockClient.fetchOne.mockResolvedValue({
      envelope: { messageId: '<different@example.com>', date: new Date('2026-09-01T00:00:00.000Z'), subject: 'Hello' },
    });
    await expect(imap.undoMove('op-1')).rejects.toThrow(/no longer match/);
  });

  it('performs the reverse move and marks the original operation undone', async () => {
    const imap = await freshImap();
    mockMoveLog.getOperation.mockResolvedValue(confirmedRecord());
    mockClient.mailbox = { uidValidity: 2000n };
    mockClient.fetchOne.mockResolvedValue({
      envelope: { messageId: '<abc@example.com>', date: new Date('2026-09-01T00:00:00.000Z'), subject: 'Hello' },
    });
    mockClient.messageMove.mockResolvedValue({
      path: 'INBOX.Archive',
      destination: 'INBOX',
      uidValidity: 1000n,
      uidMap: new Map([[99, 1]]),
    });
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
    mockClient.fetchOne.mockResolvedValue({
      envelope: { messageId: '<abc@example.com>', date: new Date('2026-09-01T00:00:00.000Z'), subject: 'Hello' },
    });
    await expect(imap.undoMove('op-1')).rejects.toThrow(/blocked by default/);
    expect(mockClient.messageMove).not.toHaveBeenCalled();
  });

  it('reconciles an uncertain operation to confirmed when the message is found at the destination', async () => {
    const imap = await freshImap();
    mockMoveLog.getOperation.mockResolvedValue(confirmedRecord({ status: 'uncertain' }));
    mockClient.mailbox = { uidValidity: 2000n };
    // First search call is against the source folder (no match), second against destination (match).
    mockClient.search.mockResolvedValueOnce([]).mockResolvedValueOnce([99]);
    mockClient.fetchOne.mockResolvedValue({
      envelope: { messageId: '<abc@example.com>', date: new Date('2026-09-01T00:00:00.000Z'), subject: 'Hello' },
    });
    mockClient.messageMove.mockResolvedValue({
      path: 'INBOX.Archive',
      destination: 'INBOX',
      uidValidity: 1000n,
      uidMap: new Map([[99, 1]]),
    });
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

describe('undoMove — the operator exceptions list', () => {
  function stubKeepInInbox(sender: string) {
    const fetchMock = vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            results: [
              {
                id: 'row-0',
                properties: {
                  Sender: { title: [{ plain_text: sender }] },
                  Action: { select: { name: 'Keep in Inbox' } },
                  'Destination Folder': { rich_text: [] },
                  Notes: { rich_text: [] },
                  Timing: { rich_text: [] },
                },
              },
            ],
            has_more: false,
            next_cursor: null,
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        ),
    );
    vi.stubGlobal('fetch', fetchMock);
    return fetchMock;
  }

  /** A message sitting in the Inbox after a Receipts -> INBOX move. */
  function envelopeInInbox() {
    return {
      envelope: {
        messageId: '<abc@example.com>',
        date: new Date('2026-09-01T00:00:00.000Z'),
        subject: 'Hello',
        from: [{ address: 'accounts@example.com', name: 'The Bank' }],
      },
    };
  }

  beforeEach(() => {
    vi.clearAllMocks();
    process.env.NOTION_EXCEPTIONS_TOKEN = 'secret_test_token';
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    delete process.env.NOTION_EXCEPTIONS_TOKEN;
  });

  it('refuses an undo that would take a keep-in-inbox message back out of the Inbox', async () => {
    const imap = await freshImap();
    // The original move was Receipts -> INBOX, so undoing it means INBOX -> Receipts.
    mockMoveLog.getOperation.mockResolvedValue(confirmedRecord({ sourcePath: 'Receipts', destPath: 'INBOX' }));
    mockClient.mailbox = { uidValidity: 2000n };
    mockClient.fetchOne.mockResolvedValue(envelopeInInbox());
    mockClient.list.mockResolvedValue([
      { path: 'INBOX', name: 'INBOX' },
      { path: 'Receipts', name: 'Receipts' },
    ]);
    stubKeepInInbox('accounts@example.com');

    await expect(imap.undoMove('op-1')).rejects.toThrow(/stays in the Inbox/);
    expect(mockClient.messageMove).not.toHaveBeenCalled();
  });

  it('allows an undo that puts a keep-in-inbox message back into the Inbox', async () => {
    const imap = await freshImap();
    // The original move was INBOX -> Archive, so undoing it returns it to the Inbox.
    mockMoveLog.getOperation.mockResolvedValue(confirmedRecord());
    mockClient.mailbox = { uidValidity: 2000n };
    mockClient.fetchOne.mockResolvedValue(envelopeInInbox());
    mockClient.messageMove.mockResolvedValue({
      path: 'INBOX.Archive',
      destination: 'INBOX',
      uidValidity: 1000n,
      uidMap: new Map([[99, 1]]),
    });
    const fetchMock = stubKeepInInbox('accounts@example.com');

    await expect(imap.undoMove('op-1')).resolves.toEqual({ newOperationId: 'op-undo' });
    // Undoing into the Inbox needs no check at all, so Notion is never called.
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('allows an undo out of the Inbox for a sender with no rule', async () => {
    const imap = await freshImap();
    mockMoveLog.getOperation.mockResolvedValue(confirmedRecord({ sourcePath: 'Receipts', destPath: 'INBOX' }));
    mockClient.mailbox = { uidValidity: 2000n };
    mockClient.fetchOne.mockResolvedValue(envelopeInInbox());
    mockClient.list.mockResolvedValue([
      { path: 'INBOX', name: 'INBOX' },
      { path: 'Receipts', name: 'Receipts' },
    ]);
    mockClient.messageMove.mockResolvedValue({
      path: 'INBOX',
      destination: 'Receipts',
      uidValidity: 3000n,
      uidMap: new Map([[99, 5]]),
    });
    stubKeepInInbox('somebody-else@example.org');

    await expect(imap.undoMove('op-1')).resolves.toEqual({ newOperationId: 'op-undo' });
    expect(mockClient.messageMove).toHaveBeenCalledWith('99', 'Receipts', { uid: true });
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
