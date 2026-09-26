import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { assertMoveAllowed, type MailboxListEntry } from '../../lib/imap.js';
import { createMockImapClient, type MockImapClient } from './imap-mock-client.js';

// One mock client instance, shared across module resets so assertions can
// still reach it after a fresh import of lib/imap.js.
const holder = vi.hoisted(() => ({ client: undefined as unknown }));

vi.mock('imapflow', async () => {
  const { createMockImapClient: create } = await import('./imap-mock-client.js');
  if (!holder.client) holder.client = create();
  return {
    ImapFlow: vi.fn().mockImplementation(function ImapFlowMock() {
      return holder.client;
    }),
  };
});

const mockMoveLog = vi.hoisted(() => ({
  createPendingOperation: vi.fn(async () => 'op-1'),
  markConfirmed: vi.fn(),
  markFailed: vi.fn(),
  markUncertain: vi.fn(),
}));

vi.mock('../../lib/moveLog.js', () => mockMoveLog);

function client(): MockImapClient {
  if (!holder.client) holder.client = createMockImapClient();
  return holder.client as MockImapClient;
}

const INBOX: MailboxListEntry = { path: 'INBOX', name: 'INBOX' };
const TRASH_BY_FLAG: MailboxListEntry = { path: 'INBOX.Trash', name: 'Trash', specialUse: '\\Trash' };
const JUNK_BY_FLAG: MailboxListEntry = { path: 'INBOX.Junk', name: 'Junk', specialUse: '\\Junk' };
const JUNK_EMAIL_NO_FLAG: MailboxListEntry = { path: 'INBOX.Junk E-mail', name: 'Junk E-mail' };
const JUNK_RESEARCH_NO_FLAG: MailboxListEntry = { path: 'INBOX.Junk Research', name: 'Junk Research' };
const ARCHIVE: MailboxListEntry = { path: 'INBOX.Archive', name: 'Archive', specialUse: '\\Archive' };

describe('assertMoveAllowed', () => {
  const mailboxes = [INBOX, TRASH_BY_FLAG, JUNK_BY_FLAG, JUNK_EMAIL_NO_FLAG, JUNK_RESEARCH_NO_FLAG, ARCHIVE];

  afterEach(() => {
    delete process.env.ALLOW_TRASH_JUNK_MOVES;
  });

  it('allows a move to an ordinary folder', () => {
    expect(() => assertMoveAllowed(mailboxes, 'INBOX', 'INBOX.Archive')).not.toThrow();
  });

  it('blocks a move to a folder with special-use \\Trash', () => {
    expect(() => assertMoveAllowed(mailboxes, 'INBOX', 'INBOX.Trash')).toThrow(/blocked by default/);
  });

  it('blocks a move to a folder with special-use \\Junk', () => {
    expect(() => assertMoveAllowed(mailboxes, 'INBOX', 'INBOX.Junk')).toThrow(/blocked by default/);
  });

  it('blocks a move to a folder with no special-use flag but an exact fallback name match', () => {
    expect(() => assertMoveAllowed(mailboxes, 'INBOX', 'INBOX.Junk E-mail')).toThrow(/blocked by default/);
  });

  it('does not block a folder named "Junk Research" with no special-use flag (no substring matching)', () => {
    expect(() => assertMoveAllowed(mailboxes, 'INBOX', 'INBOX.Junk Research')).not.toThrow();
  });

  it('rejects an unresolvable target folder', () => {
    expect(() => assertMoveAllowed(mailboxes, 'INBOX', 'INBOX.DoesNotExist')).toThrow(/does not exist/);
  });

  it('allows a recovery move out of Trash into an ordinary folder', () => {
    expect(() => assertMoveAllowed(mailboxes, 'INBOX.Trash', 'INBOX')).not.toThrow();
  });

  it('allows a recovery move out of Junk into an ordinary folder', () => {
    expect(() => assertMoveAllowed(mailboxes, 'INBOX.Junk', 'INBOX')).not.toThrow();
  });

  it('treats a move from one prohibited folder to another as still blocked (not a recovery)', () => {
    expect(() => assertMoveAllowed(mailboxes, 'INBOX.Trash', 'INBOX.Junk')).toThrow(/blocked by default/);
  });

  it('treats source equal to target as a no-op, even if that folder is Trash', () => {
    expect(() => assertMoveAllowed(mailboxes, 'INBOX.Trash', 'INBOX.Trash')).not.toThrow();
  });

  it('permits an otherwise-blocked move when ALLOW_TRASH_JUNK_MOVES=true', () => {
    process.env.ALLOW_TRASH_JUNK_MOVES = 'true';
    expect(() => assertMoveAllowed(mailboxes, 'INBOX', 'INBOX.Trash')).not.toThrow();
  });

  it('still blocks when ALLOW_TRASH_JUNK_MOVES is set to anything other than the string "true"', () => {
    process.env.ALLOW_TRASH_JUNK_MOVES = '1';
    expect(() => assertMoveAllowed(mailboxes, 'INBOX', 'INBOX.Trash')).toThrow(/blocked by default/);
  });
});

describe('assertMoveAllowed — the destination allowlist', () => {
  const INBOX: MailboxListEntry = { path: 'INBOX', name: 'INBOX' };
  const ARCHIVE: MailboxListEntry = { path: 'Archive', name: 'Archive', specialUse: '\\Archive' };
  const RECEIPTS: MailboxListEntry = { path: 'Receipts', name: 'Receipts' };
  const CLIENTS: MailboxListEntry = { path: 'Work/Clients', name: 'Clients' };
  const PERSONAL: MailboxListEntry = { path: 'Personal', name: 'Personal' };
  const TRASH: MailboxListEntry = { path: 'Trash', name: 'Trash', specialUse: '\\Trash' };
  const boxes = [INBOX, ARCHIVE, RECEIPTS, CLIENTS, PERSONAL, TRASH];

  afterEach(() => {
    delete process.env.ALLOWED_MOVE_DESTINATIONS;
    delete process.env.ALLOW_TRASH_JUNK_MOVES;
  });

  it('allows a folder that is on the list', () => {
    process.env.ALLOWED_MOVE_DESTINATIONS = 'Archive,Receipts,Newsletters,Work/Clients';
    expect(() => assertMoveAllowed(boxes, 'INBOX', 'Archive')).not.toThrow();
    expect(() => assertMoveAllowed(boxes, 'INBOX', 'Work/Clients')).not.toThrow();
  });

  it('refuses a folder that is not on the list, and names the ones that are', () => {
    process.env.ALLOWED_MOVE_DESTINATIONS = 'Archive,Receipts';
    expect(() => assertMoveAllowed(boxes, 'INBOX', 'Personal')).toThrow(/not on the operator's allowlist/);
    expect(() => assertMoveAllowed(boxes, 'INBOX', 'Personal')).toThrow(/Archive, Receipts/);
  });

  it('says the refusal is server-enforced with no per-call override', () => {
    process.env.ALLOWED_MOVE_DESTINATIONS = 'Archive';
    expect(() => assertMoveAllowed(boxes, 'INBOX', 'Personal')).toThrow(
      /enforced by the server, not the agent, and has no per-call override/,
    );
  });

  it('always permits the Inbox as a destination, so recovery and undo keep working', () => {
    process.env.ALLOWED_MOVE_DESTINATIONS = 'Archive';
    expect(() => assertMoveAllowed(boxes, 'Archive', 'INBOX')).not.toThrow();
  });

  it('ignores whitespace around the entries', () => {
    process.env.ALLOWED_MOVE_DESTINATIONS = ' Archive ,  Receipts ';
    expect(() => assertMoveAllowed(boxes, 'INBOX', 'Receipts')).not.toThrow();
  });

  it('allows any ordinary folder when the variable is unset', () => {
    expect(() => assertMoveAllowed(boxes, 'INBOX', 'Personal')).not.toThrow();
  });

  it('treats an empty or comma-only value as no list at all', () => {
    process.env.ALLOWED_MOVE_DESTINATIONS = '  , ,';
    expect(() => assertMoveAllowed(boxes, 'INBOX', 'Personal')).not.toThrow();
  });

  it('still blocks Trash when the variable is unset', () => {
    expect(() => assertMoveAllowed(boxes, 'INBOX', 'Trash')).toThrow(/blocked by default/);
  });

  it('reports the Trash rule rather than the allowlist when both would refuse', () => {
    process.env.ALLOWED_MOVE_DESTINATIONS = 'Archive';
    expect(() => assertMoveAllowed(boxes, 'INBOX', 'Trash')).toThrow(/blocked by default/);
  });

  it('still applies the allowlist to Trash once the Trash rule itself is lifted', () => {
    process.env.ALLOWED_MOVE_DESTINATIONS = 'Archive';
    process.env.ALLOW_TRASH_JUNK_MOVES = 'true';
    expect(() => assertMoveAllowed(boxes, 'INBOX', 'Trash')).toThrow(/not on the operator's allowlist/);
  });

  it('applies to a reverse move too, which is how undo_move is checked', () => {
    process.env.ALLOWED_MOVE_DESTINATIONS = 'Archive';
    // undoMove calls this with the destination and source swapped.
    expect(() => assertMoveAllowed(boxes, 'Receipts', 'Personal')).toThrow(/not on the operator's allowlist/);
    expect(() => assertMoveAllowed(boxes, 'Receipts', 'INBOX')).not.toThrow();
  });
});

// --- The operator's sorting exceptions, enforced on moves ---

/** A Notion data-source query response carrying the given rules. */
function notionRows(rows: { sender: string; action: string; destination?: string }[]) {
  return {
    results: rows.map((row, index) => ({
      id: `row-${index}`,
      properties: {
        Sender: { title: [{ plain_text: row.sender }] },
        Action: { select: { name: row.action } },
        'Destination Folder': { rich_text: row.destination ? [{ plain_text: row.destination }] : [] },
        Notes: { rich_text: [] },
        Timing: { rich_text: [] },
      },
    })),
    has_more: false,
    next_cursor: null,
  };
}

function stubNotionRows(rows: { sender: string; action: string; destination?: string }[]) {
  const fetchMock = vi.fn(async () =>
    new Response(JSON.stringify(notionRows(rows)), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    }),
  );
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

/** Reloads lib/imap.js with a clean mock client, so each test starts fresh. */
async function freshImap(from = { address: 'accounts@example.com', name: 'The Bank' }) {
  vi.resetModules();
  const c = client();
  for (const value of Object.values(c)) {
    if (typeof value === 'function' && 'mockReset' in value) (value as ReturnType<typeof vi.fn>).mockReset();
  }
  for (const fn of Object.values(mockMoveLog)) (fn as ReturnType<typeof vi.fn>).mockReset();
  mockMoveLog.createPendingOperation.mockResolvedValue('op-1');

  c.getMailboxLock.mockImplementation(async () => ({ release: vi.fn() }));
  c.mailbox = { uidValidity: 1000n };
  c.fetchOne.mockResolvedValue({
    envelope: {
      messageId: '<abc@example.com>',
      date: new Date('2026-09-01T00:00:00.000Z'),
      subject: 'Hello',
      from: [from],
    },
  });
  c.messageMove.mockResolvedValue({
    path: 'INBOX',
    destination: 'Archive',
    uidValidity: 2000n,
    uidMap: new Map([[1, 99]]),
  });
  c.list.mockResolvedValue([
    { path: 'INBOX', name: 'INBOX' },
    { path: 'Archive', name: 'Archive', specialUse: '\\Archive' },
    { path: 'Receipts', name: 'Receipts' },
  ]);

  process.env.ICLOUD_EMAIL = 'test@icloud.com';
  process.env.ICLOUD_APP_PASSWORD = 'app-specific-password';
  process.env.NOTION_EXCEPTIONS_TOKEN = 'secret_test_token';
  delete process.env.ALLOW_TRASH_JUNK_MOVES;
  return import('../../lib/imap.js');
}

describe('moveMessage — the operator exceptions list', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    delete process.env.NOTION_EXCEPTIONS_TOKEN;
  });

  it('refuses to move a keep-in-inbox sender out of the Inbox', async () => {
    const imap = await freshImap();
    stubNotionRows([{ sender: 'accounts@example.com', action: 'Keep in Inbox' }]);

    await expect(imap.moveMessage({ folder: 'INBOX', uid: 1, targetFolder: 'Archive' })).rejects.toThrow(
      /stays in the Inbox/,
    );
    expect(client().messageMove).not.toHaveBeenCalled();
  });

  it('says plainly that the refusal is the server\'s and cannot be overridden', async () => {
    const imap = await freshImap();
    stubNotionRows([{ sender: 'accounts@example.com', action: 'Keep in Inbox' }]);

    await expect(imap.moveMessage({ folder: 'INBOX', uid: 1, targetFolder: 'Archive' })).rejects.toThrow(
      /enforced by the server and cannot be overridden by the caller/,
    );
  });

  it('applies a keep-in-inbox rule matched by domain', async () => {
    const imap = await freshImap();
    stubNotionRows([{ sender: 'example.com', action: 'Keep in Inbox' }]);

    await expect(imap.moveMessage({ folder: 'INBOX', uid: 1, targetFolder: 'Archive' })).rejects.toThrow(
      /stays in the Inbox/,
    );
  });

  it('applies a keep-in-inbox rule matched by display name', async () => {
    const imap = await freshImap({ address: 'noreply@unknown.example', name: 'The Bank' });
    stubNotionRows([{ sender: 'the bank', action: 'Keep in Inbox' }]);

    await expect(imap.moveMessage({ folder: 'INBOX', uid: 1, targetFolder: 'Archive' })).rejects.toThrow(
      /stays in the Inbox/,
    );
  });

  it('allows moving a keep-in-inbox sender between other folders, since the rule is about the Inbox', async () => {
    const imap = await freshImap();
    stubNotionRows([{ sender: 'accounts@example.com', action: 'Keep in Inbox' }]);

    await imap.moveMessage({ folder: 'Archive', uid: 1, targetFolder: 'Receipts' });
    expect(client().messageMove).toHaveBeenCalledWith('1', 'Receipts', { uid: true });
  });

  it('refuses a move to any folder other than the one the rule names', async () => {
    const imap = await freshImap();
    stubNotionRows([{ sender: 'accounts@example.com', action: 'Move to Folder', destination: 'Receipts' }]);

    await expect(imap.moveMessage({ folder: 'INBOX', uid: 1, targetFolder: 'Archive' })).rejects.toThrow(
      /belongs in "Receipts", not "Archive"/,
    );
    expect(client().messageMove).not.toHaveBeenCalled();
  });

  it('enforces a rule stored with the live column types (email sender, select destination)', async () => {
    const imap = await freshImap();
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        new Response(
          JSON.stringify({
            results: [
              {
                id: 'row-live',
                properties: {
                  Title: { title: [{ plain_text: 'The bank' }] },
                  Sender: { email: 'Accounts@Example.com' },
                  Action: { select: { name: 'Move to Folder' } },
                  'Destination Folder': { select: { name: 'Receipts' } },
                  Timing: { select: { name: 'Immediately' } },
                  'Read Rule': { checkbox: true },
                },
              },
              {
                id: 'row-themed',
                properties: {
                  Title: { title: [{ plain_text: 'Anything else' }] },
                  Sender: { email: null },
                  Action: { select: { name: 'Keep in Inbox' } },
                },
              },
            ],
            has_more: false,
            next_cursor: null,
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        ),
      ),
    );

    await expect(imap.moveMessage({ folder: 'INBOX', uid: 1, targetFolder: 'Archive' })).rejects.toThrow(
      /belongs in "Receipts", not "Archive"/,
    );
    await imap.moveMessage({ folder: 'INBOX', uid: 1, targetFolder: 'Receipts' });
    expect(client().messageMove).toHaveBeenCalledWith('1', 'Receipts', { uid: true });
  });

  it('allows the move the rule names', async () => {
    const imap = await freshImap();
    stubNotionRows([{ sender: 'accounts@example.com', action: 'Move to Folder', destination: 'Receipts' }]);

    await imap.moveMessage({ folder: 'INBOX', uid: 1, targetFolder: 'Receipts' });
    expect(client().messageMove).toHaveBeenCalledWith('1', 'Receipts', { uid: true });
  });

  it('matches the rule\'s folder regardless of case or stray spaces', async () => {
    const imap = await freshImap();
    stubNotionRows([{ sender: 'accounts@example.com', action: 'Move to Folder', destination: ' receipts ' }]);

    await imap.moveMessage({ folder: 'INBOX', uid: 1, targetFolder: 'Receipts' });
    expect(client().messageMove).toHaveBeenCalled();
  });

  it('leaves a sender with no rule alone', async () => {
    const imap = await freshImap({ address: 'stranger@nowhere.example', name: 'Nobody' });
    stubNotionRows([{ sender: 'accounts@example.com', action: 'Keep in Inbox' }]);

    await imap.moveMessage({ folder: 'INBOX', uid: 1, targetFolder: 'Archive' });
    expect(client().messageMove).toHaveBeenCalledWith('1', 'Archive', { uid: true });
  });

  it('skips the check entirely, and never calls Notion, when no token is configured', async () => {
    const imap = await freshImap();
    delete process.env.NOTION_EXCEPTIONS_TOKEN;
    const fetchMock = stubNotionRows([{ sender: 'accounts@example.com', action: 'Keep in Inbox' }]);

    await imap.moveMessage({ folder: 'INBOX', uid: 1, targetFolder: 'Archive' });
    expect(client().messageMove).toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('refuses the move when the exceptions list cannot be read, rather than waving it through', async () => {
    const imap = await freshImap();
    vi.stubGlobal('fetch', vi.fn(async () => new Response('{}', { status: 503 })));

    await expect(imap.moveMessage({ folder: 'INBOX', uid: 1, targetFolder: 'Archive' })).rejects.toThrow(
      /could not be read/,
    );
    expect(client().messageMove).not.toHaveBeenCalled();
  });

  it('still refuses a Trash move before it ever looks at the exceptions list', async () => {
    const imap = await freshImap();
    client().list.mockResolvedValue([
      { path: 'INBOX', name: 'INBOX' },
      { path: 'Trash', name: 'Trash', specialUse: '\\Trash' },
    ]);
    const fetchMock = stubNotionRows([]);

    await expect(imap.moveMessage({ folder: 'INBOX', uid: 1, targetFolder: 'Trash' })).rejects.toThrow(
      /blocked by default/,
    );
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
