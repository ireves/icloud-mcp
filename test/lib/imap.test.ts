import { beforeEach, describe, expect, it, vi } from 'vitest';

const mockClient = vi.hoisted(() => ({
  connect: vi.fn(),
  logout: vi.fn(),
  list: vi.fn(),
  getMailboxLock: vi.fn(async () => ({ release: vi.fn() })),
  messageMove: vi.fn(),
}));

vi.mock('imapflow', () => ({
  // A regular function, not an arrow function: the code under test invokes
  // this with `new ImapFlow(...)`, and arrow functions cannot be constructors.
  ImapFlow: vi.fn().mockImplementation(function ImapFlowMock() {
    return mockClient;
  }),
}));

async function freshImap() {
  vi.resetModules();
  for (const fn of Object.values(mockClient)) {
    if (typeof fn === 'function' && 'mockReset' in fn) (fn as ReturnType<typeof vi.fn>).mockReset();
  }
  mockClient.getMailboxLock.mockImplementation(async () => ({ release: vi.fn() }));
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

  it('moves a message to an ordinary folder', async () => {
    const imap = await freshImap();
    await imap.moveMessage({ folder: 'INBOX', uid: 1, targetFolder: 'INBOX.Archive' });
    expect(mockClient.messageMove).toHaveBeenCalledWith('1', 'INBOX.Archive', { uid: true });
  });

  it('rejects a move to Trash and never calls messageMove', async () => {
    const imap = await freshImap();
    await expect(imap.moveMessage({ folder: 'INBOX', uid: 1, targetFolder: 'INBOX.Trash' })).rejects.toThrow(
      /blocked by default/,
    );
    expect(mockClient.messageMove).not.toHaveBeenCalled();
  });

  it('rejects a move to Junk and never calls messageMove', async () => {
    const imap = await freshImap();
    await expect(imap.moveMessage({ folder: 'INBOX', uid: 1, targetFolder: 'INBOX.Junk' })).rejects.toThrow(
      /blocked by default/,
    );
    expect(mockClient.messageMove).not.toHaveBeenCalled();
  });

  it('allows a recovery move out of Trash', async () => {
    const imap = await freshImap();
    await imap.moveMessage({ folder: 'INBOX.Trash', uid: 1, targetFolder: 'INBOX' });
    expect(mockClient.messageMove).toHaveBeenCalledWith('1', 'INBOX', { uid: true });
  });

  it('treats a move to the same folder as a no-op and never calls messageMove or locks the mailbox', async () => {
    const imap = await freshImap();
    await imap.moveMessage({ folder: 'INBOX', uid: 1, targetFolder: 'INBOX' });
    expect(mockClient.messageMove).not.toHaveBeenCalled();
    expect(mockClient.getMailboxLock).not.toHaveBeenCalled();
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
});
