import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * A small pretend iCloud account. Each connection is its own object, as with
 * the real server, so folders searched side by side don't trip over each
 * other. search() understands the criteria the code under test sends.
 */
interface FakeMessage {
  uid: number;
  date: string;
  subject: string;
  from: string;
  to?: string;
  body?: string;
}

interface FakeFolder {
  path: string;
  name?: string;
  specialUse?: string;
  flags?: string[];
  messages?: FakeMessage[];
  failSearch?: string;
}

const account = vi.hoisted(() => ({
  folders: [] as FakeFolder[],
  connections: [] as { searches: { folder: string; query: Record<string, unknown> }[] }[],
  refuseExtraConnections: false,
}));

function contains(haystack: string | undefined, needle: unknown): boolean {
  return (haystack ?? '').toLowerCase().includes(String(needle).toLowerCase());
}

function matches(message: FakeMessage, query: Record<string, unknown>): boolean {
  const sent = new Date(message.date).getTime();
  for (const [key, value] of Object.entries(query)) {
    if (key === 'all') continue;
    if (key === 'text' && !contains(`${message.subject} ${message.from} ${message.to} ${message.body}`, value)) return false;
    if (key === 'subject' && !contains(message.subject, value)) return false;
    if (key === 'from' && !contains(message.from, value)) return false;
    if (key === 'to' && !contains(message.to, value)) return false;
    if (key === 'sentSince' && sent < (value as Date).getTime()) return false;
    if (key === 'sentBefore' && sent >= (value as Date).getTime()) return false;
    if (key === 'or' && !(value as Record<string, unknown>[]).some((option) => matches(message, option))) return false;
  }
  return true;
}

function fakeConnection() {
  let open: FakeFolder | undefined;
  const connection = {
    searches: [] as { folder: string; query: Record<string, unknown> }[],
    usable: true,
    mailbox: { uidValidity: 1000n },
    connect: vi.fn(async () => {
      if (account.refuseExtraConnections && account.connections.length > 1) throw new Error('too many connections');
    }),
    logout: vi.fn(async () => undefined),
    list: vi.fn(async () =>
      account.folders.map((f) => ({ path: f.path, name: f.name ?? f.path, specialUse: f.specialUse, flags: new Set(f.flags ?? []) })),
    ),
    getMailboxLock: vi.fn(async (path: string) => {
      open = account.folders.find((f) => f.path === path);
      if (!open) throw new Error(`no folder ${path}`);
      return { release: vi.fn() };
    }),
    search: vi.fn(async (query: Record<string, unknown>) => {
      connection.searches.push({ folder: open!.path, query });
      if (open!.failSearch) throw new Error(open!.failSearch);
      return (open!.messages ?? []).filter((m) => matches(m, query)).map((m) => m.uid);
    }),
    fetch: vi.fn(async function* (uids: number[], query: { source?: unknown }) {
      for (const m of open!.messages ?? []) {
        if (!uids.includes(m.uid)) continue;
        if (query.source) {
          yield { uid: m.uid, source: Buffer.from(`Subject: ${m.subject}\r\nContent-Type: text/plain\r\n\r\n${m.body ?? ''}`) };
        } else {
          yield { uid: m.uid, envelope: { subject: m.subject, from: [{ address: m.from }], date: new Date(m.date) }, flags: new Set<string>() };
        }
      }
    }),
  };
  account.connections.push(connection);
  return connection;
}

vi.mock('imapflow', () => ({
  ImapFlow: vi.fn().mockImplementation(function ImapFlowMock() {
    return fakeConnection();
  }),
}));
vi.mock('../../lib/moveLog.js', () => ({}));
vi.mock('../../lib/scanProgress.js', () => ({
  getLastSeenUid: vi.fn(async () => null),
  recordMaxListedUid: vi.fn(),
}));

async function freshImap() {
  vi.resetModules();
  process.env.ICLOUD_EMAIL = 'me@icloud.com';
  process.env.ICLOUD_APP_PASSWORD = 'secret';
  return import('../../lib/imap.js');
}

function msg(uid: number, date: string, subject: string, extra: Partial<FakeMessage> = {}): FakeMessage {
  return { uid, date, subject, from: 'shop@example.com', to: 'me@icloud.com', body: '', ...extra };
}

beforeEach(async () => {
  // Some cases swap in a misbehaving server; put the ordinary one back.
  const { ImapFlow } = await import('imapflow');
  vi.mocked(ImapFlow).mockImplementation(function ImapFlowMock() {
    return fakeConnection() as never;
  });
  account.folders = [];
  account.connections = [];
  account.refuseExtraConnections = false;
});

describe('search terms', () => {
  it('splits words apart but keeps "quoted phrases" together', async () => {
    const imap = await freshImap();
    expect(imap.splitSearchTerms('Amazon refund "order 1234"  amazon')).toEqual(['Amazon', 'refund', 'order 1234', 'amazon']);
  });
});

describe('list_messages — finding older mail', () => {
  it('filters on the date the email was sent, and on subject, recipient and each word', async () => {
    const imap = await freshImap();
    account.folders = [{ path: 'INBOX', messages: [] }];

    await imap.listMessages({
      folder: 'INBOX',
      sinceDate: '2018-01-01',
      beforeDate: '2019-01-01',
      subject: 'invoice',
      toAddress: 'me@icloud.com',
      text: 'Amazon refund',
    });

    const queries = account.connections[0].searches.map((s) => s.query);
    const base = {
      sentSince: new Date('2018-01-01'),
      sentBefore: new Date('2019-01-01'),
      subject: 'invoice',
      to: 'me@icloud.com',
    };
    expect(queries[0]).toEqual({ ...base, text: 'Amazon' });
    // No match for the first word, so the second is never asked about.
    expect(queries).toHaveLength(1);
  });

  it('finds an email with every word, even when they are not next to each other', async () => {
    const imap = await freshImap();
    account.folders = [
      {
        path: 'INBOX',
        messages: [
          msg(1, '2018-05-01', 'Your Amazon order', { body: 'A refund has been issued.' }),
          msg(2, '2018-05-02', 'Amazon deals'),
        ],
      },
    ];

    const result = await imap.listMessages({ folder: 'INBOX', text: 'Amazon refund' });

    expect(result.messages.map((m) => m.uid)).toEqual([1]);
    expect(result.total).toBe(1);
  });

  it('refuses a date it cannot read instead of searching with an invalid date', async () => {
    const imap = await freshImap();
    account.folders = [{ path: 'INBOX', messages: [] }];

    await expect(imap.listMessages({ folder: 'INBOX', beforeDate: 'last year' })).rejects.toThrow(
      /before_date is not a valid date/,
    );
  });

  it('reports how many messages match across all pages', async () => {
    const imap = await freshImap();
    account.folders = [{ path: 'INBOX', messages: [1, 2, 3, 4, 5].map((uid) => msg(uid, `2020-01-0${uid}`, 's')) }];

    const result = await imap.listMessages({ folder: 'INBOX', limit: 2 });

    expect(result.total).toBe(5);
    expect(result.messages.map((m) => m.uid)).toEqual([5, 4]);
    expect(result.nextCursor).toBe(4);
  });
});

describe('search_mail', () => {
  it('searches every folder, including sub-folders, but skips Trash, Junk and non-mail containers', async () => {
    const imap = await freshImap();
    account.folders = [
      { path: 'INBOX' },
      { path: 'Receipts', flags: ['\\HasChildren'] },
      { path: 'Receipts/2018' },
      { path: 'Deleted Messages', specialUse: '\\Trash' },
      { path: 'Junk' },
      { path: 'Parent', flags: ['\\Noselect'] },
    ];

    const result = await imap.searchMail({ text: 'invoice' });

    expect(result.searchedFolders).toEqual(['INBOX', 'Receipts', 'Receipts/2018']);
    const searched = new Set(account.connections.flatMap((c) => c.searches.map((s) => s.folder)));
    expect([...searched].sort()).toEqual(['INBOX', 'Receipts', 'Receipts/2018']);
  });

  it('orders by the date sent, so an old email filed recently does not count as new', async () => {
    const imap = await freshImap();
    account.folders = [
      {
        path: 'Receipts',
        // UID 9 was filed most recently, but was sent in 2018.
        messages: [msg(1, '2024-01-01', 'invoice A'), msg(2, '2025-01-01', 'invoice B'), msg(9, '2018-01-01', 'invoice C')],
      },
      { path: 'INBOX', messages: [msg(7, '2026-01-01', 'invoice D')] },
    ];

    const result = await imap.searchMail({ subject: 'invoice', limit: 3 });

    expect(result.total).toBe(4);
    expect(result.messages.map((m) => [m.folder, m.uid])).toEqual([
      ['INBOX', 7],
      ['Receipts', 2],
      ['Receipts', 1],
    ]);
  });

  it('pages through every match with next_cursor, without repeats or gaps', async () => {
    const imap = await freshImap();
    account.folders = [
      { path: 'INBOX', messages: [1, 2, 3].map((uid) => msg(uid, `2020-0${uid}-01`, 'invoice')) },
      // Same dates in a second folder, to check ties are ordered consistently.
      { path: 'Receipts', messages: [1, 2].map((uid) => msg(uid, `2020-0${uid}-01`, 'invoice')) },
    ];

    const seen: string[] = [];
    let cursor: string | undefined;
    do {
      const page = await imap.searchMail({ subject: 'invoice', limit: 2, cursor });
      seen.push(...page.messages.map((m) => `${m.folder}#${m.uid}`));
      cursor = page.nextCursor;
    } while (cursor);

    expect(seen).toEqual(['INBOX#3', 'INBOX#2', 'Receipts#2', 'INBOX#1', 'Receipts#1']);
  });

  it('refuses a cursor it did not issue', async () => {
    const imap = await freshImap();
    account.folders = [{ path: 'INBOX' }];

    await expect(imap.searchMail({ subject: 'x', cursor: 'nonsense' })).rejects.toThrow(/not a next_cursor/);
  });

  it('carries on when one folder fails, and says which one was skipped', async () => {
    const imap = await freshImap();
    account.folders = [
      { path: 'INBOX', messages: [msg(1, '2020-01-01', 'invoice')] },
      { path: 'Broken', failSearch: 'server said NO' },
    ];

    const result = await imap.searchMail({ subject: 'invoice' });

    expect(result.messages.map((m) => m.uid)).toEqual([1]);
    expect(result.searchedFolders).toEqual(['INBOX']);
    expect(result.skippedFolders).toEqual([{ folder: 'Broken', reason: 'server said NO' }]);
  });

  it('fails clearly when no folder at all could be searched', async () => {
    const imap = await freshImap();
    account.folders = [{ path: 'Broken', failSearch: 'server said NO' }];
    // A dropped connection is what stops every worker.
    const { ImapFlow } = await import('imapflow');
    vi.mocked(ImapFlow).mockImplementation(function ImapFlowMock() {
      const connection = fakeConnection();
      connection.search.mockImplementation(async () => {
        connection.usable = false;
        throw new Error('connection closed');
      });
      return connection as never;
    });

    await expect(imap.searchMail({ subject: 'x' })).rejects.toThrow(/could not search any folder: connection closed/);
  });

  it('searches several folders at once, over separate connections', async () => {
    const imap = await freshImap();
    account.folders = ['A', 'B', 'C', 'D', 'E'].map((path) => ({ path }));

    await imap.searchMail({ subject: 'x' });

    const busy = account.connections.filter((c) => c.searches.length > 0);
    expect(busy.length).toBe(3);
    expect(account.connections.every((c) => (c as unknown as { logout: ReturnType<typeof vi.fn> }).logout.mock.calls.length === 1)).toBe(true);
  });

  it('still searches everything when iCloud refuses the extra connections', async () => {
    const imap = await freshImap();
    account.refuseExtraConnections = true;
    account.folders = ['A', 'B', 'C'].map((path) => ({ path, messages: [msg(1, '2020-01-01', 'x')] }));

    const result = await imap.searchMail({ subject: 'x' });

    expect(result.total).toBe(3);
    expect(result.skippedFolders).toEqual([]);
  });

  it('tries subjects, senders and recipients when the words are not found in the text', async () => {
    const imap = await freshImap();
    account.folders = [{ path: 'INBOX', messages: [msg(1, '2020-01-01', 'Café receipt')] }];
    const { ImapFlow } = await import('imapflow');
    // Stands in for iCloud's patchy text search: TEXT never matches.
    vi.mocked(ImapFlow).mockImplementation(function ImapFlowMock() {
      const connection = fakeConnection();
      const search = connection.search.getMockImplementation()!;
      connection.search.mockImplementation(async (query: Record<string, unknown>) =>
        'text' in query ? (connection.searches.push({ folder: 'INBOX', query }), []) : search(query),
      );
      return connection as never;
    });

    const result = await imap.searchMail({ text: 'café' });

    expect(result.matchedBy).toBe('subject_or_sender');
    expect(result.messages.map((m) => m.uid)).toEqual([1]);
  });

  it('says the text matched when it did', async () => {
    const imap = await freshImap();
    account.folders = [{ path: 'INBOX', messages: [msg(1, '2020-01-01', 'Hello', { body: 'your refund' })] }];

    const result = await imap.searchMail({ text: 'refund' });

    expect(result.matchedBy).toBe('text');
  });

  it('includes a short preview of each body, marked untrusted', async () => {
    const imap = await freshImap();
    account.folders = [
      { path: 'INBOX', messages: [msg(1, '2020-01-01', 'Receipt', { body: `Thanks for your order.\n\n${'x'.repeat(500)}` })] },
    ];

    const result = await imap.searchMail({ subject: 'Receipt' });

    const preview = result.messages[0].preview!;
    expect(preview.startsWith('[untrusted email preview] Thanks for your order.')).toBe(true);
    expect(preview.length).toBeLessThan(300);
  });

  it('needs at least one filter', async () => {
    const imap = await freshImap();

    await expect(imap.searchMail({})).rejects.toThrow(/at least one filter/);
    expect(account.connections).toHaveLength(0);
  });
});
