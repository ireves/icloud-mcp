import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  clearExceptionsCache,
  getExceptions,
  isExceptionsConfigured,
  matchException,
  type SortingException,
} from '../../lib/exceptions.js';

const DATA_SOURCE_ID = 'f2ebf247-9368-498f-86a9-3341260874e1';
const QUERY_URL = `https://api.notion.com/v1/data_sources/${DATA_SOURCE_ID}/query`;

/** Builds a Notion page in the shape the data-source query returns. */
function notionRow(fields: {
  id?: string;
  sender?: string;
  action?: string;
  destination?: string;
  notes?: string;
  timing?: string;
}) {
  const richText = (value?: string) =>
    value === undefined ? { rich_text: [] } : { rich_text: [{ plain_text: value }] };

  return {
    id: fields.id ?? 'page-1',
    properties: {
      Sender: fields.sender === undefined ? { title: [] } : { title: [{ plain_text: fields.sender }] },
      Action: { select: fields.action === undefined ? null : { name: fields.action } },
      'Destination Folder': richText(fields.destination),
      Notes: richText(fields.notes),
      Timing: richText(fields.timing),
    },
  };
}

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

/** Serves one query response per call, in order. */
function stubNotion(...pages: unknown[]) {
  let call = 0;
  const fetchMock = vi.fn(async () => {
    const page = pages[Math.min(call, pages.length - 1)];
    call += 1;
    return jsonResponse(page);
  });
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

beforeEach(() => {
  clearExceptionsCache();
  vi.useRealTimers();
  process.env.NOTION_EXCEPTIONS_TOKEN = 'secret_test_token';
  delete process.env.NOTION_EXCEPTIONS_DATA_SOURCE_ID;
  vi.spyOn(console, 'warn').mockImplementation(() => {});
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
  vi.restoreAllMocks();
  delete process.env.NOTION_EXCEPTIONS_TOKEN;
  delete process.env.NOTION_EXCEPTIONS_DATA_SOURCE_ID;
  clearExceptionsCache();
});

describe('isExceptionsConfigured', () => {
  it('is false when no token is set, so the feature stays off', () => {
    delete process.env.NOTION_EXCEPTIONS_TOKEN;
    expect(isExceptionsConfigured()).toBe(false);
  });

  it('is true once a token is set', () => {
    expect(isExceptionsConfigured()).toBe(true);
  });
});

describe('getExceptions — the request', () => {
  it('queries the default data source with the pinned Notion version and the token', async () => {
    const fetchMock = stubNotion({ results: [], has_more: false });
    await getExceptions();

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe(QUERY_URL);
    expect(init.method).toBe('POST');
    const headers = init.headers as Record<string, string>;
    expect(headers['notion-version']).toBe('2025-09-03');
    expect(headers.authorization).toBe('Bearer secret_test_token');
  });

  it('uses NOTION_EXCEPTIONS_DATA_SOURCE_ID when the operator overrides it', async () => {
    process.env.NOTION_EXCEPTIONS_DATA_SOURCE_ID = 'another-data-source';
    const fetchMock = stubNotion({ results: [], has_more: false });
    await getExceptions();
    expect(fetchMock.mock.calls[0][0]).toBe('https://api.notion.com/v1/data_sources/another-data-source/query');
  });

  it('rejects with a readable error when the token is not set', async () => {
    delete process.env.NOTION_EXCEPTIONS_TOKEN;
    await expect(getExceptions()).rejects.toThrow(/NOTION_EXCEPTIONS_TOKEN is not set/);
  });

  it('rejects with the status when Notion refuses the request', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse({ message: 'unauthorized' }, 401)));
    await expect(getExceptions()).rejects.toThrow(/HTTP 401/);
  });
});

describe('getExceptions — pagination', () => {
  it('follows next_cursor until has_more is false and returns every row', async () => {
    const fetchMock = stubNotion(
      {
        results: [notionRow({ id: 'a', sender: 'one@example.com', action: 'Keep in Inbox' })],
        has_more: true,
        next_cursor: 'cursor-2',
      },
      {
        results: [notionRow({ id: 'b', sender: 'two@example.com', action: 'Keep in Inbox' })],
        has_more: false,
        next_cursor: null,
      },
    );

    const exceptions = await getExceptions();

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(JSON.parse(String((fetchMock.mock.calls[1] as unknown as [string, RequestInit])[1].body))).toMatchObject({
      start_cursor: 'cursor-2',
    });
    expect(exceptions.map((e) => e.sender)).toEqual(['one@example.com', 'two@example.com']);
  });

  it('sends no cursor on the first page', async () => {
    const fetchMock = stubNotion({ results: [], has_more: false });
    await getExceptions();
    expect(JSON.parse(String((fetchMock.mock.calls[0] as unknown as [string, RequestInit])[1].body))).not.toHaveProperty(
      'start_cursor',
    );
  });
});

describe('getExceptions — row mapping', () => {
  it('maps a keep-in-inbox row, lower-casing and trimming the sender', async () => {
    stubNotion({
      results: [
        notionRow({
          sender: '  Accounts@Example.COM ',
          action: 'Keep in Inbox',
          notes: 'Bills live here',
          timing: 'only during tax season',
        }),
      ],
      has_more: false,
    });

    const [exception] = await getExceptions();

    expect(exception).toEqual({
      sender: 'accounts@example.com',
      action: 'keep_in_inbox',
      destinationFolder: undefined,
      notes: 'Bills live here',
      timing: 'only during tax season',
    });
  });

  it('maps a move-to-folder row with its destination', async () => {
    stubNotion({
      results: [notionRow({ sender: 'news@example.com', action: 'Move to Folder', destination: 'Newsletters' })],
      has_more: false,
    });

    const [exception] = await getExceptions();

    expect(exception).toMatchObject({ action: 'move_to_folder', destinationFolder: 'Newsletters' });
  });

  it('joins multi-run rich text back into one value', async () => {
    stubNotion({
      results: [
        {
          id: 'split',
          properties: {
            Sender: { title: [{ plain_text: 'accounts@' }, { plain_text: 'example.com' }] },
            Action: { select: { name: 'Keep in Inbox' } },
          },
        },
      ],
      has_more: false,
    });

    const [exception] = await getExceptions();
    expect(exception.sender).toBe('accounts@example.com');
  });
});

describe('getExceptions — skipped rows', () => {
  it('skips a row with an empty Sender and warns', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    stubNotion({
      results: [
        notionRow({ id: 'blank', action: 'Keep in Inbox' }),
        notionRow({ id: 'good', sender: 'ok@example.com', action: 'Keep in Inbox' }),
      ],
      has_more: false,
    });

    const exceptions = await getExceptions();

    expect(exceptions).toHaveLength(1);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('Sender column is empty'));
  });

  it('skips a row whose Action is not one of the two known values, and warns', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    stubNotion({
      results: [notionRow({ id: 'odd', sender: 'x@example.com', action: 'Delete Immediately' })],
      has_more: false,
    });

    expect(await getExceptions()).toEqual([]);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('Delete Immediately'));
  });

  it('skips a row with no Action at all', async () => {
    stubNotion({ results: [notionRow({ sender: 'x@example.com' })], has_more: false });
    expect(await getExceptions()).toEqual([]);
  });

  it('keeps a move-to-folder row with no destination, but warns that nothing will be enforced', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    stubNotion({
      results: [notionRow({ sender: 'x@example.com', action: 'Move to Folder' })],
      has_more: false,
    });

    const [exception] = await getExceptions();

    expect(exception).toMatchObject({ action: 'move_to_folder', destinationFolder: undefined });
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('names no Destination Folder'));
  });
});

describe('getExceptions — caching', () => {
  it('serves a second call from memory rather than calling Notion again', async () => {
    const fetchMock = stubNotion({ results: [], has_more: false });
    await getExceptions();
    await getExceptions();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('re-reads once the five-minute cache has expired', async () => {
    vi.useFakeTimers();
    const fetchMock = stubNotion({ results: [], has_more: false });

    await getExceptions();
    vi.advanceTimersByTime(4 * 60 * 1000);
    await getExceptions();
    expect(fetchMock).toHaveBeenCalledTimes(1);

    vi.advanceTimersByTime(2 * 60 * 1000);
    await getExceptions();
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('does not cache a failed read, so one outage does not stick for five minutes', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse({ message: 'nope' }, 500))
      .mockResolvedValue(jsonResponse({ results: [], has_more: false }));
    vi.stubGlobal('fetch', fetchMock);

    await expect(getExceptions()).rejects.toThrow(/HTTP 500/);
    await expect(getExceptions()).resolves.toEqual([]);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('forgets everything when the cache is cleared', async () => {
    const fetchMock = stubNotion({ results: [], has_more: false });
    await getExceptions();
    clearExceptionsCache();
    await getExceptions();
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});

describe('matchException', () => {
  const byAddress: SortingException = { sender: 'accounts@example.com', action: 'keep_in_inbox' };
  const byDomain: SortingException = {
    sender: 'example.com',
    action: 'move_to_folder',
    destinationFolder: 'Work',
  };
  const byName: SortingException = { sender: 'the bank', action: 'keep_in_inbox' };
  const all = [byDomain, byName, byAddress];

  it('matches an exact address', () => {
    expect(matchException(all, 'accounts@example.com')).toBe(byAddress);
  });

  it('matches an address whatever its case or surrounding spaces', () => {
    expect(matchException(all, '  Accounts@EXAMPLE.com ')).toBe(byAddress);
  });

  it('prefers an exact address over the domain rule that would also match', () => {
    expect(matchException(all, 'accounts@example.com')).toBe(byAddress);
    expect(matchException(all, 'someone-else@example.com')).toBe(byDomain);
  });

  it('matches on the domain when no address rule applies', () => {
    expect(matchException(all, 'hello@example.com')).toBe(byDomain);
  });

  it('matches the display name when neither address nor domain does', () => {
    expect(matchException(all, 'noreply@other.example', 'The Bank')).toBe(byName);
  });

  it('prefers a domain rule over a display-name rule', () => {
    expect(matchException(all, 'hello@example.com', 'The Bank')).toBe(byDomain);
  });

  it('returns null when nothing matches', () => {
    expect(matchException(all, 'stranger@nowhere.example', 'Nobody')).toBeNull();
  });

  it('returns null for a missing address and no name', () => {
    expect(matchException(all, null)).toBeNull();
    expect(matchException(all, undefined, null)).toBeNull();
  });

  it('returns null against an empty list', () => {
    expect(matchException([], 'accounts@example.com')).toBeNull();
  });
});
