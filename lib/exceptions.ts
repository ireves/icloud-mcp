/**
 * The operator's "Email Sorting Exceptions" list, read straight from Notion.
 *
 * These are standing rules about where mail from a given sender belongs —
 * written by the person who owns the mailbox, not by an agent and not by
 * anyone sending them mail. The server reads them itself, with its own
 * read-only Notion integration, so that enforcing them does not depend on an
 * agent choosing to consult a connector first.
 */

const NOTION_VERSION = '2025-09-03';
const DEFAULT_DATA_SOURCE_ID = 'f2ebf247-9368-498f-86a9-3341260874e1';
const CACHE_TTL_MS = 5 * 60 * 1000;
const PAGE_SIZE = 100;
// A serverless instance handling one sorting run should never need this many
// pages. The cap stops a paging bug turning into an unbounded loop.
const MAX_PAGES = 50;

export type ExceptionAction = 'keep_in_inbox' | 'move_to_folder';

export interface SortingException {
  /** An address, a domain, or a display name. Trimmed and lower-cased. */
  sender: string;
  action: ExceptionAction;
  destinationFolder?: string;
  /** Free text for the human. Untrusted as far as an agent is concerned. */
  notes?: string;
  /** Free text, e.g. "only during tax season". Also untrusted. */
  timing?: string;
}

function optionalEnv(name: string): string | undefined {
  const value = process.env[name];
  return value && value.trim() ? value.trim() : undefined;
}

/** False when no token is set, in which case the whole feature stays off. */
export function isExceptionsConfigured(): boolean {
  return Boolean(optionalEnv('NOTION_EXCEPTIONS_TOKEN'));
}

function dataSourceId(): string {
  return optionalEnv('NOTION_EXCEPTIONS_DATA_SOURCE_ID') ?? DEFAULT_DATA_SOURCE_ID;
}

interface NotionPage {
  id?: string;
  properties?: Record<string, unknown>;
}

interface NotionQueryResponse {
  results?: NotionPage[];
  has_more?: boolean;
  next_cursor?: string | null;
}

/**
 * Notion returns text as an array of rich-text runs, whatever the column type.
 * Joining their plain_text values gives back what the human typed.
 */
function plainText(property: unknown): string {
  if (!property || typeof property !== 'object') return '';
  const prop = property as Record<string, unknown>;
  const runs = prop.title ?? prop.rich_text;
  if (!Array.isArray(runs)) return '';
  return runs
    .map((run) => (run && typeof run === 'object' ? String((run as { plain_text?: unknown }).plain_text ?? '') : ''))
    .join('')
    .trim();
}

function selectName(property: unknown): string {
  if (!property || typeof property !== 'object') return '';
  const select = (property as { select?: unknown }).select;
  if (!select || typeof select !== 'object') return '';
  return String((select as { name?: unknown }).name ?? '').trim();
}

function parseAction(raw: string): ExceptionAction | null {
  const normalised = raw.toLowerCase().replace(/\s+/g, ' ').trim();
  if (normalised === 'keep in inbox') return 'keep_in_inbox';
  if (normalised === 'move to folder') return 'move_to_folder';
  return null;
}

function toException(page: NotionPage, index: number): SortingException | null {
  const properties = page.properties ?? {};
  const sender = plainText(properties.Sender).toLowerCase();
  const rowLabel = page.id ? `row ${page.id}` : `row ${index}`;

  if (!sender) {
    console.warn(`Sorting exceptions: skipping ${rowLabel} — its Sender column is empty.`);
    return null;
  }

  const actionRaw = selectName(properties.Action);
  const action = parseAction(actionRaw);
  if (!action) {
    console.warn(
      `Sorting exceptions: skipping ${rowLabel} (sender "${sender}") — Action is "${actionRaw || '(empty)'}", ` +
        'which is neither "Keep in Inbox" nor "Move to Folder".',
    );
    return null;
  }

  const destinationFolder = plainText(properties['Destination Folder']);
  if (action === 'move_to_folder' && !destinationFolder) {
    console.warn(
      `Sorting exceptions: row for "${sender}" says Move to Folder but names no Destination Folder, ` +
        'so no destination will be enforced for it.',
    );
  }

  const notes = plainText(properties.Notes);
  const timing = plainText(properties.Timing);

  return {
    sender,
    action,
    destinationFolder: destinationFolder || undefined,
    notes: notes || undefined,
    timing: timing || undefined,
  };
}

async function queryAllRows(): Promise<SortingException[]> {
  const token = optionalEnv('NOTION_EXCEPTIONS_TOKEN');
  if (!token) {
    throw new Error(
      'The sorting exceptions list is not configured: NOTION_EXCEPTIONS_TOKEN is not set on this deployment.',
    );
  }

  const url = `https://api.notion.com/v1/data_sources/${dataSourceId()}/query`;
  const exceptions: SortingException[] = [];
  let cursor: string | undefined;
  let rowIndex = 0;

  for (let page = 0; page < MAX_PAGES; page += 1) {
    const response = await fetch(url, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${token}`,
        'notion-version': NOTION_VERSION,
        'content-type': 'application/json',
      },
      body: JSON.stringify(cursor ? { page_size: PAGE_SIZE, start_cursor: cursor } : { page_size: PAGE_SIZE }),
    });

    if (!response.ok) {
      const detail = await response.text().catch(() => '');
      throw new Error(
        `Could not read the sorting exceptions list from Notion (HTTP ${response.status}). ` +
          'Check that NOTION_EXCEPTIONS_TOKEN is valid and that the exceptions database is shared with that ' +
          `integration. ${detail.slice(0, 200)}`.trim(),
      );
    }

    const body = (await response.json()) as NotionQueryResponse;
    for (const row of body.results ?? []) {
      const mapped = toException(row, rowIndex);
      rowIndex += 1;
      if (mapped) exceptions.push(mapped);
    }

    if (!body.has_more || !body.next_cursor) return exceptions;
    cursor = body.next_cursor;
  }

  console.warn(`Sorting exceptions: stopped after ${MAX_PAGES} pages; the list may be incomplete.`);
  return exceptions;
}

let cache: { fetchedAt: number; rows: Promise<SortingException[]> } | null = null;

/**
 * The rows, cached per serverless instance for five minutes. A sorting run
 * that touches fifty messages checks the list fifty times, and without this
 * that would be fifty calls to Notion.
 */
export async function getExceptions(): Promise<SortingException[]> {
  if (cache && Date.now() - cache.fetchedAt < CACHE_TTL_MS) {
    return cache.rows;
  }
  const entry = { fetchedAt: Date.now(), rows: queryAllRows() };
  cache = entry;
  // A failed read must not be cached, or one Notion outage would stick for
  // five minutes after it ended.
  entry.rows.catch(() => {
    if (cache === entry) cache = null;
  });
  return entry.rows;
}

/** Test seam, and a way to force a re-read after the list is edited. */
export function clearExceptionsCache(): void {
  cache = null;
}

/**
 * Finds the rule covering a sender, most specific first: the exact address,
 * then the address's domain, then the display name.
 */
export function matchException(
  exceptions: SortingException[],
  fromAddress: string | null | undefined,
  fromName?: string | null,
): SortingException | null {
  const address = (fromAddress ?? '').trim().toLowerCase();
  const name = (fromName ?? '').trim().toLowerCase();
  const atIndex = address.lastIndexOf('@');
  const domain = atIndex === -1 ? '' : address.slice(atIndex + 1);

  if (address) {
    const exact = exceptions.find((row) => row.sender === address);
    if (exact) return exact;
  }

  if (domain) {
    const byDomain = exceptions.find((row) => row.sender === domain);
    if (byDomain) return byDomain;
  }

  if (name) {
    const byName = exceptions.find((row) => row.sender === name);
    if (byName) return byName;
  }

  return null;
}
