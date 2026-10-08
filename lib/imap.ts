import { ImapFlow } from 'imapflow';
import { simpleParser } from 'mailparser';
import { convert } from 'html-to-text';
import MailComposer from 'nodemailer/lib/mail-composer/index.js';
import type { MailboxInfo, MessageDetail, MessageSummary } from './types.js';
import {
  acquireUndoLock,
  createPendingOperation,
  getOperation,
  listOperations,
  markConfirmed,
  markFailed,
  markUncertain,
  markUndone,
  releaseUndoLock,
  type MoveIdentity,
  type MoveOperationRecord,
} from './moveLog.js';
import {
  advanceLastSeenUid,
  getLastSeenUid,
  getMaxListedUid,
  getPendingFlaggedUids,
  recordMaxListedUid,
  setPendingFlaggedUids,
  type UidValidity,
} from './scanProgress.js';
import { stripInvisible, tagUntrustedInline, wrapUntrusted } from './untrusted.js';
import { getExceptions, isExceptionsConfigured, matchException, type SortingException } from './exceptions.js';

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

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`${name} is not set`);
  }
  return value;
}

interface FetchedEnvelope {
  subject?: string;
  from?: { address?: string }[];
  date?: Date;
}

export interface MailboxListEntry {
  path: string;
  name: string;
  specialUse?: string;
}

function resolveMailbox(mailboxes: MailboxListEntry[], path: string): MailboxListEntry | null {
  return mailboxes.find((m) => m.path === path) ?? null;
}

// A short, iCloud-specific safety net for the case where the server doesn't
// report SPECIAL-USE for some account. Exact match only — a substring rule
// would wrongly catch an ordinary folder like "Junk Research".
const TRASH_JUNK_NAME_FALLBACK = new Set([
  'Trash',
  'Deleted Messages',
  'Papierkorb',
  'Corbeille',
  'Junk',
  'Junk E-mail',
  'Indésirables',
]);

function isProhibitedDestination(mailbox: MailboxListEntry): boolean {
  if (mailbox.specialUse === '\\Trash' || mailbox.specialUse === '\\Junk') return true;
  if (mailbox.specialUse) return false; // has a different, known special-use — trust it
  return TRASH_JUNK_NAME_FALLBACK.has(mailbox.name);
}

/** Folder paths are compared forgivingly: the Notion column is typed by hand. */
function foldersEqual(a: string, b: string): boolean {
  return a.trim().toLowerCase() === b.trim().toLowerCase();
}

function isInbox(path: string): boolean {
  return path.trim().toUpperCase() === 'INBOX';
}

/**
 * The operator's allowlist of destination folders, or null when they have not
 * set one. Entries are trimmed, since a comma-separated variable is typed by
 * hand and "Archive, Receipts" is the obvious way to write it.
 */
function allowedDestinations(): string[] | null {
  const raw = process.env.ALLOWED_MOVE_DESTINATIONS;
  if (!raw) return null;
  const entries = raw
    .split(',')
    .map((entry) => entry.trim())
    .filter(Boolean);
  return entries.length > 0 ? entries : null;
}

/**
 * Refuses a destination the operator has not listed. The Inbox is always
 * permitted, whatever the list says, so that moving a message back and undoing
 * a move keep working.
 */
function assertDestinationAllowed(targetPath: string): void {
  const allowed = allowedDestinations();
  if (!allowed) return;
  if (isInbox(targetPath)) return;
  if (allowed.some((entry) => foldersEqual(entry, targetPath))) return;
  throw new Error(
    `Moving messages into "${targetPath}" is refused: it is not on the operator's allowlist of destinations. ` +
      `Allowed destinations are: ${allowed.join(', ')} (and INBOX). ` +
      'This check is enforced by the server, not the agent, and has no per-call override.',
  );
}

/**
 * The Trash/Junk rule, which takes precedence over the allowlist below. It
 * applies in both directions: nothing is moved into Trash or Junk, and nothing
 * is taken back out of them, so mail the operator binned or iCloud filed as
 * spam stays where it is unless they move it themselves.
 */
function assertNotTrashOrJunk(
  mailbox: MailboxListEntry | null,
  path: string,
  direction: 'into' | 'out of',
): void {
  if (!mailbox || !isProhibitedDestination(mailbox)) return;
  if (process.env.ALLOW_TRASH_JUNK_MOVES === 'true') return; // explicit operator override
  throw new Error(
    `Moving messages ${direction} "${path}" is blocked by default because it is a Trash or Junk folder. ` +
      `This restriction is enforced by the server, not the agent, and has no per-call override. ` +
      `An operator can lift it by setting ALLOW_TRASH_JUNK_MOVES=true in the deployment's environment.`,
  );
}

// The same kind of fallback as above, for Sent and Drafts.
const SENT_DRAFTS_NAME_FALLBACK = new Set(['Sent', 'Sent Messages', 'Sent Items', 'Drafts']);

function isSentOrDrafts(mailbox: MailboxListEntry): boolean {
  if (mailbox.specialUse === '\\Sent' || mailbox.specialUse === '\\Drafts') return true;
  if (mailbox.specialUse) return false;
  return SENT_DRAFTS_NAME_FALLBACK.has(mailbox.name);
}

/**
 * Sent and Drafts can be read but never moved into or out of. Unlike the
 * Trash/Junk rule there is no override: nothing in sorting mail needs either.
 */
function assertNotSentOrDrafts(mailbox: MailboxListEntry | null, path: string, direction: 'into' | 'out of'): void {
  if (!mailbox || !isSentOrDrafts(mailbox)) return;
  throw new Error(
    `Moving messages ${direction} "${path}" is refused: Sent and Drafts can be read but not moved into or out of. ` +
      'This check is enforced by the server, not the agent, and has no override.',
  );
}

/** The operator's list of extra folders never to move into, or an empty list. */
function blockedDestinations(): string[] {
  return (process.env.BLOCKED_MOVE_DESTINATIONS ?? '')
    .split(',')
    .map((entry) => entry.trim())
    .filter(Boolean);
}

/**
 * Refuses a destination on the operator's block list. An entry that names no
 * real folder refuses every move instead: it is most likely a typo, and a typo
 * in a block list would otherwise leave the folder it meant unprotected with
 * nothing to say so.
 */
function assertDestinationNotBlocked(mailboxes: MailboxListEntry[], targetPath: string): void {
  const blocked = blockedDestinations();
  if (blocked.length === 0) return;
  const unknown = blocked.filter(
    (entry) => !mailboxes.some((m) => foldersEqual(entry, m.path) || foldersEqual(entry, m.name)),
  );
  if (unknown.length > 0) {
    throw new Error(
      `All moves are refused because BLOCKED_MOVE_DESTINATIONS names ${unknown.map((e) => `"${e}"`).join(', ')}, ` +
        'which matches no folder in this account (possibly a typo, or a folder that was renamed or deleted). ' +
        `The folders that exist are: ${mailboxes.map((m) => m.path).join(', ')}. ` +
        'The operator needs to correct the setting in the deployment\'s environment.',
    );
  }
  if (isInbox(targetPath)) return;
  const target = resolveMailbox(mailboxes, targetPath);
  if (blocked.some((entry) => foldersEqual(entry, targetPath) || (target && foldersEqual(entry, target.name)))) {
    throw new Error(
      `Moving messages into "${targetPath}" is refused: it is on the operator's list of blocked destinations. ` +
        'This check is enforced by the server, not the agent, and has no per-call override.',
    );
  }
}

export function assertMoveAllowed(
  mailboxes: MailboxListEntry[],
  sourcePath: string,
  targetPath: string,
): void {
  if (sourcePath === targetPath) return; // no-op, nothing to validate
  const target = resolveMailbox(mailboxes, targetPath);
  if (!target) {
    throw new Error(`Target folder "${targetPath}" does not exist.`);
  }
  assertNotSentOrDrafts(resolveMailbox(mailboxes, sourcePath), sourcePath, 'out of');
  assertNotSentOrDrafts(target, targetPath, 'into');
  assertNotTrashOrJunk(resolveMailbox(mailboxes, sourcePath), sourcePath, 'out of');
  assertNotTrashOrJunk(target, targetPath, 'into');
  assertDestinationNotBlocked(mailboxes, targetPath);
  assertDestinationAllowed(targetPath);
}

/**
 * The operator's standing sorting rules, or null when the feature is switched
 * off. A read that fails refuses the move rather than waving it through: a
 * rule that silently stops applying when Notion is unreachable would not be
 * much of a rule.
 */
async function loadExceptions(): Promise<SortingException[] | null> {
  if (!isExceptionsConfigured()) return null;
  try {
    return await getExceptions();
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(
      `Move refused: the operator's exceptions list could not be read, so this move cannot be checked against it. ${detail}`,
    );
  }
}

/** The From address and display name of one message, for rule matching. */
async function fetchSender(
  client: ImapFlow,
  folder: string,
  uid: number,
): Promise<{ address: string | null; name: string | null }> {
  const lock = await client.getMailboxLock(folder);
  try {
    const meta = await client.fetchOne(String(uid), { envelope: true }, { uid: true });
    const from = meta && meta.envelope ? meta.envelope.from?.[0] : undefined;
    return { address: from?.address ?? null, name: from?.name ?? null };
  } finally {
    lock.release();
  }
}

function assertExceptionAllowsMove(
  match: SortingException | null,
  sourcePath: string,
  targetPath: string,
): void {
  if (!match) return;

  if (match.action === 'keep_in_inbox' && isInbox(sourcePath)) {
    throw new Error(
      `Move refused: the operator's exceptions list says mail from "${match.sender}" stays in the Inbox. ` +
        'This is enforced by the server and cannot be overridden by the caller.',
    );
  }

  if (
    match.action === 'move_to_folder' &&
    match.destinationFolder &&
    !foldersEqual(match.destinationFolder, targetPath)
  ) {
    throw new Error(
      `Move refused: the operator's exceptions list says mail from "${match.sender}" belongs in ` +
        `"${match.destinationFolder}", not "${targetPath}". ` +
        'This is enforced by the server and cannot be overridden by the caller.',
    );
  }
}

/**
 * Checks a pending move against the operator's exceptions list, reading the
 * message's sender first. Does nothing when the feature is switched off.
 */
async function assertExceptionsAllowMove(
  client: ImapFlow,
  args: { sourcePath: string; uid: number; targetPath: string },
): Promise<void> {
  const exceptions = await loadExceptions();
  if (!exceptions) return;
  const sender = await fetchSender(client, args.sourcePath, args.uid);
  assertExceptionAllowsMove(
    matchException(exceptions, sender.address, sender.name),
    args.sourcePath,
    args.targetPath,
  );
}

function getClient(): ImapFlow {
  const email = requireEnv('ICLOUD_EMAIL');
  const password = requireEnv('ICLOUD_APP_PASSWORD');
  return new ImapFlow({
    host: 'imap.mail.me.com',
    port: 993,
    secure: true,
    auth: { user: email, pass: password },
    logger: false,
  });
}

const MAX_MESSAGE_BYTES = 10 * 1024 * 1024;
const MAX_BODY_CHARS = 100_000;

/**
 * Matches an inline style declaration by its whole value, rather than by a
 * prefix of it. A plain `[style*="font-size:0"]` would also catch
 * `font-size:0.9em`, which is ordinary visible text, and `[style*="color:
 * transparent"]` would catch a value that merely begins that way. So each way
 * a value can legitimately end is spelled out: the end of the attribute, a
 * semicolon, a space, `!` (as in `!important`), or, for a length, its unit.
 *
 * Skipping an element takes its text with it, so a rule that over-matches
 * loses part of the message. These stay narrow on purpose.
 */
function styleValueSelectors(property: string, value: string, units: string[] = []): string[] {
  const selectors: string[] = [];
  for (const declaration of [`${property}:${value}`, `${property}: ${value}`]) {
    selectors.push(
      `[style$="${declaration}"]`,
      `[style*="${declaration};"]`,
      `[style*="${declaration} "]`,
      `[style*="${declaration}!"]`,
      ...units.map((unit) => `[style*="${declaration}${unit}"]`),
    );
  }
  return selectors;
}

const CSS_LENGTH_UNITS = ['px', 'pt', 'em', 'rem', '%', 'ex', 'ch', 'pc', 'in', 'cm', 'mm', 'vw', 'vh'];

/**
 * Parts of an HTML message that a person never sees, and that are therefore
 * a natural place to hide text meant only for whatever reads the message
 * automatically: markup that is not content at all, elements marked hidden,
 * inline styles that shrink or blank the text, and the "preheader" block that
 * mail designers use to control the preview line.
 *
 * `format: 'skip'` drops the element and everything inside it.
 */
const HIDDEN_ELEMENT_SELECTORS = [
  'script',
  'style',
  'head',
  'noscript',
  'template',
  '[hidden]',
  '[aria-hidden="true"]',
  ...styleValueSelectors('display', 'none'),
  ...styleValueSelectors('visibility', 'hidden'),
  ...styleValueSelectors('font-size', '0', CSS_LENGTH_UNITS),
  // Opacity is a bare number, so it takes no units at all.
  ...styleValueSelectors('opacity', '0'),
  ...styleValueSelectors('color', 'transparent'),
  '.preheader',
  '.preview-text',
].map((selector) => ({ selector, format: 'skip' as const }));

function htmlToText(html: string): string {
  return convert(html, { wordwrap: 100, selectors: HIDDEN_ELEMENT_SELECTORS });
}

// A text part this short next to a much longer HTML part is usually a stub
// ("View this email in your browser"), not what the sender expects a person
// to read — or a decoy hiding what the HTML actually says.
const SHORT_TEXT_PART_CHARS = 200;
const MUCH_LONGER_FACTOR = 3;

/** Three or more blank lines in a row become two. */
function collapseBlankLines(text: string): string {
  return text.replace(/\n{4,}/g, '\n\n\n');
}

async function extractBody(source: Buffer | undefined): Promise<string> {
  if (!source) return '';
  // skipHtmlToText stops mailparser inventing a text version of an HTML-only
  // message with its own converter, which keeps hidden elements. Without it,
  // `text` would be set for almost every message and the conversion below —
  // the one that drops hidden content — would rarely run. With it, `text` is
  // a genuine text/plain part or nothing.
  const parsed = await simpleParser(source, { skipHtmlToText: true });
  const text = parsed.text ?? '';
  const html = typeof parsed.html === 'string' ? parsed.html : '';

  let body: string;
  if (text && html && text.length < SHORT_TEXT_PART_CHARS) {
    const converted = htmlToText(html);
    const muchLonger =
      converted.length > Math.max(SHORT_TEXT_PART_CHARS, text.length * MUCH_LONGER_FACTOR);
    body = muchLonger ? converted : text;
  } else if (text) {
    body = text;
  } else if (html) {
    body = htmlToText(html);
  } else {
    return '';
  }

  body = collapseBlankLines(stripInvisible(body));

  if (body.length > MAX_BODY_CHARS) {
    return `${body.slice(0, MAX_BODY_CHARS)}\n\n[... truncated, message body exceeds ${MAX_BODY_CHARS} characters]`;
  }
  return body;
}

/**
 * An envelope date as an ISO string, or null when there is none worth using.
 * A message with a malformed Date header can come back with a date that is
 * not a Date at all, or an Invalid Date, and calling toISOString on either
 * throws — which would fail a whole listing because of one bad message.
 */
function isoDate(value: unknown): string | null {
  const date = value instanceof Date ? value : typeof value === 'string' ? new Date(value) : null;
  return date && !Number.isNaN(date.getTime()) ? date.toISOString() : null;
}

/**
 * Builds a list entry from a fetched message. The subject is written by
 * whoever sent the message, so it carries an inline untrusted tag — a subject
 * line is a perfectly good place to hide an instruction, and these entries
 * are what an agent reads when deciding what to do with a message.
 */
function toSummary(message: { uid: number; envelope?: FetchedEnvelope; flags?: Set<string> }): MessageSummary {
  const subject = message.envelope?.subject;
  return {
    uid: message.uid,
    subject: subject ? tagUntrustedInline('EMAIL SUBJECT', subject) : '(no subject)',
    from: message.envelope?.from?.[0]?.address ?? 'unknown',
    date: isoDate(message.envelope?.date) ?? '',
    unread: !message.flags?.has('\\Seen'),
    flagged: message.flags?.has('\\Flagged') ?? false,
  };
}

/**
 * Remembers the highest UID handed out for a folder, so mark_scanned can later
 * check that a caller is only marking what it was actually shown.
 */
async function recordListed(
  folder: string,
  results: MessageSummary[],
  uidValidity: UidValidity,
): Promise<void> {
  if (results.length === 0) return;
  await recordMaxListedUid(folder, Math.max(...results.map((message) => message.uid)), uidValidity);
}

/**
 * The open folder's UIDVALIDITY as a string, or null if the server did not
 * report one. Stored alongside every UID so a mark from an older numbering is
 * recognised rather than trusted.
 */
function openUidValidity(client: ImapFlow): UidValidity {
  return client.mailbox !== false ? client.mailbox.uidValidity.toString() : null;
}

export async function listFolders(): Promise<MailboxInfo[]> {
  const client = getClient();
  await client.connect();
  try {
    const list = await client.list();
    return list.map((box) => ({
      path: box.path,
      name: box.name,
      flags: Array.from(box.flags ?? []),
      specialUse: box.specialUse,
    }));
  } finally {
    await client.logout();
  }
}

export interface ListMessagesParams {
  folder: string;
  limit?: number;
  unreadOnly?: boolean;
  sinceDate?: string;
  beforeDate?: string;
  fromAddress?: string;
  toAddress?: string;
  subject?: string;
  text?: string;
  beforeUid?: number;
  afterUid?: number;
  sinceLastRun?: boolean;
}

export interface ListMessagesResult {
  messages: MessageSummary[];
  nextCursor?: number;
  /** How many messages in the folder match the filters, across all pages. */
  total: number;
}

interface SearchFilters {
  unreadOnly?: boolean;
  sinceDate?: string;
  beforeDate?: string;
  fromAddress?: string;
  toAddress?: string;
  subject?: string;
  text?: string;
}

type Criteria = Record<string, unknown>;

/**
 * A search split into one IMAP query per term. The server matches TEXT as one
 * exact phrase, so "Amazon refund" would miss an email that has both words
 * apart. Each word is searched on its own instead, and a message must match
 * every one (see searchEveryTerm).
 */
interface SearchPlan {
  base: Criteria;
  terms: Criteria[];
}

function parseFilterDate(name: string, value: string): Date {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) throw new Error(`${name} is not a valid date: "${value}"`);
  return date;
}

/**
 * Words to match separately. Text inside double quotes stays together as one
 * exact phrase, so "order 1234" can still be searched as written.
 */
export function splitSearchTerms(text: string): string[] {
  const terms: string[] = [];
  for (const match of text.matchAll(/"([^"]*)"|(\S+)/g)) {
    const term = (match[1] ?? match[2] ?? '').trim();
    if (term && !terms.includes(term)) terms.push(term);
  }
  return terms;
}

/**
 * The IMAP search shared by list_messages and search_mail. Dates are compared
 * with the date the email was sent (its Date header, the one Mail shows),
 * rather than when it reached this server, which for imported or moved mail
 * can be years later.
 */
function buildSearchPlan(filters: SearchFilters): SearchPlan {
  const base: Criteria = {};
  if (filters.unreadOnly) base.seen = false;
  if (filters.sinceDate) base.sentSince = parseFilterDate('since_date', filters.sinceDate);
  if (filters.beforeDate) base.sentBefore = parseFilterDate('before_date', filters.beforeDate);
  if (filters.fromAddress) base.from = filters.fromAddress;
  if (filters.toAddress) base.to = filters.toAddress;
  if (filters.subject) base.subject = filters.subject;
  const terms = filters.text ? splitSearchTerms(filters.text).map((term) => ({ text: term })) : [];
  return { base, terms };
}

/**
 * Runs the plan against the open folder: one search per term, keeping only
 * the UIDs that match all of them. Returns ascending UIDs.
 */
async function searchEveryTerm(client: ImapFlow, plan: SearchPlan): Promise<number[]> {
  if (plan.terms.length === 0) {
    const query = Object.keys(plan.base).length > 0 ? plan.base : { all: true };
    return ((await client.search(query, { uid: true })) || []).sort((a, b) => a - b);
  }
  let matched: number[] | null = null;
  for (const term of plan.terms) {
    const uids: number[] = (await client.search({ ...plan.base, ...term }, { uid: true })) || [];
    const keep: Set<number> | null = matched === null ? null : new Set<number>(matched);
    matched = keep === null ? uids : uids.filter((uid) => keep.has(uid));
    if (matched.length === 0) break;
  }
  return [...(matched ?? [])].sort((a, b) => a - b);
}

export async function listMessages(params: ListMessagesParams): Promise<ListMessagesResult> {
  const client = getClient();
  await client.connect();
  try {
    const lock = await client.getMailboxLock(params.folder);
    try {
      const uidValidity = openUidValidity(client);
      let afterUid = params.afterUid;
      if (params.sinceLastRun) {
        const lastSeen = await getLastSeenUid(params.folder, uidValidity);
        if (lastSeen !== null) afterUid = afterUid !== undefined ? Math.max(afterUid, lastSeen) : lastSeen;
      }

      const plan = buildSearchPlan(params);
      // Flagged messages are excluded from the since-last-run scan entirely
      // so they never block the high-water mark; reconcileFlagged() is how
      // an unflagged message gets picked back up for sorting later.
      if (params.sinceLastRun) plan.base.flagged = false;

      let uids = await searchEveryTerm(client, plan);
      if (uids.length === 0) return { messages: [], total: 0 };
      const total = uids.length;

      const limit = params.limit ?? 25;

      if (afterUid !== undefined) {
        // Forward pagination: oldest-unprocessed-first, so a run that stops
        // partway through still advances the high-water mark sequentially.
        uids = uids.filter((uid) => uid > afterUid!).sort((a, b) => a - b);
        if (uids.length === 0) return { messages: [], total };

        const hasMore = uids.length > limit;
        const limited = uids.slice(0, limit);
        const results: MessageSummary[] = [];
        for await (const message of client.fetch(limited, { envelope: true, flags: true, uid: true }, { uid: true })) {
          results.push(toSummary(message));
        }
        results.sort((a, b) => a.uid - b.uid);
        await recordListed(params.folder, results, uidValidity);
        const nextCursor = hasMore ? results[results.length - 1]?.uid : undefined;
        return { messages: results, nextCursor, total };
      }

      if (params.beforeUid !== undefined) {
        uids = uids.filter((uid) => uid < params.beforeUid!);
      }
      if (uids.length === 0) return { messages: [], total };

      const hasMore = uids.length > limit;
      const limited = uids.slice(-limit).reverse();
      const results: MessageSummary[] = [];
      for await (const message of client.fetch(limited, { envelope: true, flags: true, uid: true }, { uid: true })) {
        results.push(toSummary(message));
      }
      results.sort((a, b) => b.uid - a.uid);
      await recordListed(params.folder, results, uidValidity);
      const nextCursor = hasMore ? results[results.length - 1]?.uid : undefined;
      return { messages: results, nextCursor, total };
    } finally {
      lock.release();
    }
  } finally {
    await client.logout();
  }
}

export interface SearchMailParams extends SearchFilters {
  limit?: number;
  /** next_cursor from a previous search_mail call with the same filters. */
  cursor?: string;
}

export interface SearchMailHit extends MessageSummary {
  folder: string;
  /** The start of the message body, marked untrusted. Absent if it could not be read. */
  preview?: string;
}

export interface SkippedFolder {
  folder: string;
  reason: string;
}

export interface SearchMailResult {
  messages: SearchMailHit[];
  /** How many messages matched across every searched folder. */
  total: number;
  searchedFolders: string[];
  /** Folders that could not be searched; their matches are missing from total and messages. */
  skippedFolders: SkippedFolder[];
  /** Pass back as cursor for the next, older page. Absent on the last page. */
  nextCursor?: string;
  /**
   * 'subject_or_sender' when the text search found nothing and the words were
   * looked for in subjects, senders and recipients instead.
   */
  matchedBy?: 'text' | 'subject_or_sender';
}

/** How many folders are searched at once. iCloud limits connections per account, so this stays small. */
const SEARCH_CONCURRENCY = 3;
/** How much of each result's source is read to build its preview. */
const PREVIEW_SOURCE_BYTES = 24 * 1024;
const PREVIEW_CHARS = 240;

/** Folders search_mail skips: Trash and Junk, plus containers that hold no mail. */
function isSkippedForSearch(mailbox: MailboxListEntry & { flags?: Set<string> }): boolean {
  if (mailbox.flags?.has('\\Noselect') || mailbox.flags?.has('\\NonExistent')) return true;
  return isProhibitedDestination(mailbox);
}

function dateValue(message: MessageSummary): number {
  const time = Date.parse(message.date);
  return Number.isNaN(time) ? 0 : time;
}

interface CursorPosition {
  date: number;
  folder: string;
  uid: number;
}

/** Newest first; ties broken by folder, then by UID, so the order is total and stable between calls. */
function compareHits(a: CursorPosition, b: CursorPosition): number {
  if (a.date !== b.date) return b.date - a.date;
  if (a.folder !== b.folder) return a.folder < b.folder ? -1 : 1;
  return b.uid - a.uid;
}

function positionOf(hit: SearchMailHit): CursorPosition {
  return { date: dateValue(hit), folder: hit.folder, uid: hit.uid };
}

function encodeCursor(position: CursorPosition): string {
  return Buffer.from(JSON.stringify([position.date, position.folder, position.uid])).toString('base64url');
}

function decodeCursor(cursor: string): CursorPosition {
  try {
    const [date, folder, uid] = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8'));
    if (typeof date === 'number' && typeof folder === 'string' && typeof uid === 'number') {
      return { date, folder, uid };
    }
  } catch {
    // Falls through to the error below.
  }
  throw new Error('cursor is not a next_cursor returned by search_mail.');
}

function errorReason(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** The fallback for a text search that found nothing: each word in the subject, sender or recipient. */
function subjectOrSenderPlan(plan: SearchPlan, text: string): SearchPlan {
  return {
    base: plan.base,
    terms: splitSearchTerms(text).map((word) => ({ or: [{ subject: word }, { from: word }, { to: word }] })),
  };
}

interface FolderScan {
  hits: SearchMailHit[];
  skipped: SkippedFolder[];
}

/**
 * Searches the folders over a few connections at once. A folder that fails is
 * reported as skipped rather than failing the whole search, and a connection
 * that drops hands its remaining folders to the others.
 */
async function scanFolders(clients: ImapFlow[], folders: string[], plan: SearchPlan): Promise<FolderScan> {
  const queue = [...folders];
  const hits: SearchMailHit[] = [];
  const skipped: SkippedFolder[] = [];

  const worker = async (client: ImapFlow) => {
    for (let folder = queue.shift(); folder !== undefined; folder = queue.shift()) {
      try {
        const lock = await client.getMailboxLock(folder);
        try {
          const uids = await searchEveryTerm(client, plan);
          if (uids.length === 0) continue;
          // Every match is read, not just the highest UIDs: UIDs follow the
          // order mail was added to the folder, so an old email filed last
          // month would otherwise count as new. Envelopes are small.
          for await (const message of client.fetch(uids, { envelope: true, flags: true, uid: true }, { uid: true })) {
            hits.push({ ...toSummary(message), folder });
          }
        } finally {
          lock.release();
        }
      } catch (error) {
        skipped.push({ folder, reason: errorReason(error) });
        if (client.usable === false) return;
      }
    }
  };

  await Promise.all(clients.map(worker));
  for (const folder of queue) skipped.push({ folder, reason: 'Not searched: the connection to iCloud was lost.' });
  return { hits, skipped };
}

/** Adds a short, untrusted preview of each message's body. A preview that cannot be read is left out. */
async function addPreviews(client: ImapFlow, hits: SearchMailHit[]): Promise<void> {
  const byFolder = new Map<string, SearchMailHit[]>();
  for (const hit of hits) byFolder.set(hit.folder, [...(byFolder.get(hit.folder) ?? []), hit]);

  for (const [folder, folderHits] of byFolder) {
    try {
      const lock = await client.getMailboxLock(folder);
      try {
        const sources = new Map<number, Buffer>();
        const uids = folderHits.map((hit) => hit.uid);
        const query = { uid: true, source: { start: 0, maxLength: PREVIEW_SOURCE_BYTES } };
        for await (const message of client.fetch(uids, query, { uid: true })) {
          if (message.source) sources.set(message.uid, message.source);
        }
        for (const hit of folderHits) {
          const body = (await extractBody(sources.get(hit.uid)).catch(() => '')).replace(/\s+/g, ' ').trim();
          if (!body) continue;
          const preview = body.length > PREVIEW_CHARS ? `${body.slice(0, PREVIEW_CHARS)}…` : body;
          hit.preview = tagUntrustedInline('EMAIL PREVIEW', preview);
        }
      } finally {
        lock.release();
      }
    } catch {
      // Previews are a convenience; the results stand without them.
    }
  }
}

/**
 * Searches every folder except Trash and Junk and returns one page of
 * matches across all of them, newest first by sent date.
 */
export async function searchMail(params: SearchMailParams): Promise<SearchMailResult> {
  const plan = buildSearchPlan(params);
  if (Object.keys(plan.base).length === 0 && plan.terms.length === 0) {
    throw new Error(
      'search_mail needs at least one filter, such as text, subject, from_address, to_address or a date range.',
    );
  }
  const after = params.cursor ? decodeCursor(params.cursor) : null;
  const limit = params.limit ?? 25;

  const clients: ImapFlow[] = [];
  try {
    const first = getClient();
    clients.push(first);
    await first.connect();
    const folders = (await first.list()).filter((box) => !isSkippedForSearch(box)).map((box) => box.path);

    // Extra connections are a speed-up only: if iCloud refuses one, the
    // search carries on with the connections it has.
    for (let i = 1; i < Math.min(SEARCH_CONCURRENCY, folders.length); i++) {
      const extra = getClient();
      try {
        await extra.connect();
        clients.push(extra);
      } catch {
        break;
      }
    }

    let matchedBy: SearchMailResult['matchedBy'];
    let scan = await scanFolders(clients, folders, plan);
    if (plan.terms.length > 0) matchedBy = 'text';
    if (params.text && scan.hits.length === 0 && scan.skipped.length < folders.length) {
      const fallback = await scanFolders(clients, folders, subjectOrSenderPlan(plan, params.text));
      if (fallback.hits.length > 0) {
        scan = fallback;
        matchedBy = 'subject_or_sender';
      }
    }
    const liveClient = clients.find((client) => client.usable !== false);
    if (!liveClient && scan.skipped.length === folders.length && folders.length > 0) {
      throw new Error(`search_mail could not search any folder: ${scan.skipped[0].reason}`);
    }

    const ordered = scan.hits.sort((a, b) => compareHits(positionOf(a), positionOf(b)));
    const remaining = after ? ordered.filter((hit) => compareHits(positionOf(hit), after) > 0) : ordered;
    const page = remaining.slice(0, limit);
    if (liveClient) await addPreviews(liveClient, page);

    const skippedPaths = new Set(scan.skipped.map((entry) => entry.folder));
    return {
      messages: page,
      total: ordered.length,
      searchedFolders: folders.filter((folder) => !skippedPaths.has(folder)),
      skippedFolders: scan.skipped,
      nextCursor: remaining.length > limit ? encodeCursor(positionOf(page[page.length - 1])) : undefined,
      matchedBy,
    };
  } finally {
    await Promise.all(clients.map((client) => client.logout().catch(() => undefined)));
  }
}

export interface GetMessageParams {
  folder: string;
  uid: number;
  /** Cuts the body short at this many characters, for a quick look at a message. */
  maxChars?: number;
}

export async function getMessage(params: GetMessageParams): Promise<MessageDetail> {
  const client = getClient();
  await client.connect();
  try {
    const lock = await client.getMailboxLock(params.folder);
    try {
      // Check size before downloading the full source, so an oversized
      // message never gets pulled into memory just to be rejected.
      const meta = await client.fetchOne(String(params.uid), { size: true }, { uid: true });
      if (!meta) {
        throw new Error(`Message uid ${params.uid} not found in folder ${params.folder}`);
      }
      if (meta.size !== undefined && meta.size > MAX_MESSAGE_BYTES) {
        throw new Error(
          `Message uid ${params.uid} is ${Math.round(meta.size / 1024 / 1024)}MB, exceeding the ${MAX_MESSAGE_BYTES / 1024 / 1024}MB limit for get_message. Open it in a mail client instead.`,
        );
      }

      const message = await client.fetchOne(
        String(params.uid),
        { envelope: true, flags: true, source: true },
        { uid: true },
      );
      if (!message) {
        throw new Error(`Message uid ${params.uid} not found in folder ${params.folder}`);
      }
      let body = await extractBody(message.source as Buffer | undefined);
      if (params.maxChars !== undefined && body.length > params.maxChars) {
        body = `${body.slice(0, params.maxChars)}\n\n[... cut short at ${params.maxChars} characters as asked]`;
      }
      return {
        ...toSummary(message),
        to: message.envelope?.to?.map((a) => a.address).filter(Boolean).join(', ') ?? '',
        // An empty (or whitespace-only) body is left exactly as it was: a
        // wrapper around nothing would be noise rather than a warning.
        body: body.trim() ? wrapUntrusted('EMAIL BODY', body) : body,
      };
    } finally {
      lock.release();
    }
  } finally {
    await client.logout();
  }
}

export interface MarkMessageParams {
  folder: string;
  uid: number;
  read: boolean;
}

export async function markMessage(params: MarkMessageParams): Promise<void> {
  const client = getClient();
  await client.connect();
  try {
    const lock = await client.getMailboxLock(params.folder);
    try {
      if (params.read) {
        await client.messageFlagsAdd(String(params.uid), ['\\Seen'], { uid: true });
      } else {
        await client.messageFlagsRemove(String(params.uid), ['\\Seen'], { uid: true });
      }
    } finally {
      lock.release();
    }
  } finally {
    await client.logout();
  }
}

export interface MoveMessageParams {
  folder: string;
  uid: number;
  targetFolder: string;
}

export interface MoveMessageResult {
  operationId: string | null;
}

async function executeLoggedMove(
  client: ImapFlow,
  args: { sourcePath: string; uid: number; destPath: string; undoOf?: string },
): Promise<{ operationId: string }> {
  const lock = await client.getMailboxLock(args.sourcePath);
  let operationId: string;
  try {
    const meta = await client.fetchOne(String(args.uid), { envelope: true }, { uid: true });
    const envelope = meta ? meta.envelope : undefined;
    const identity: MoveIdentity = {
      messageId: envelope?.messageId ?? null,
      date: isoDate(envelope?.date),
      subject: envelope?.subject ?? null,
    };
    const sourceUidValidity = client.mailbox !== false ? client.mailbox.uidValidity : 0n;
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
      await markUncertain(
        operationId,
        'Server did not confirm the move with a destination UID (no UIDPLUS support detected).',
      );
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

export async function moveMessage(params: MoveMessageParams): Promise<MoveMessageResult> {
  const client = getClient();
  await client.connect();
  try {
    const mailboxes = await client.list();
    assertMoveAllowed(mailboxes, params.folder, params.targetFolder);
    if (params.folder === params.targetFolder) {
      return { operationId: null }; // explicit no-op, nothing to log or undo
    }
    await assertExceptionsAllowMove(client, {
      sourcePath: params.folder,
      uid: params.uid,
      targetPath: params.targetFolder,
    });
    const { operationId } = await executeLoggedMove(client, {
      sourcePath: params.folder,
      uid: params.uid,
      destPath: params.targetFolder,
    });
    return { operationId };
  } finally {
    await client.logout();
  }
}

/** The most messages move_messages takes in one call. */
export const MAX_BATCH_MOVE = 100;

export interface MoveMessagesParams {
  folder: string;
  uids: number[];
  targetFolder: string;
}

export interface BatchMoveOutcome {
  uid: number;
  /** Present when the message was moved; pass it to undo_move to reverse this one message. */
  operationId?: string;
  /** Present when this message was not moved, with the reason. */
  error?: string;
}

/**
 * Moves several messages from one folder to another over one connection.
 * The folder policy is checked once for the pair of folders; each message
 * then gets the same sender-rule check, logging and undo record as a single
 * move_message. One message being refused does not stop the others.
 */
export async function moveMessages(params: MoveMessagesParams): Promise<BatchMoveOutcome[]> {
  const uids = [...new Set(params.uids)];
  if (uids.length === 0) throw new Error('move_messages needs at least one UID.');
  if (uids.length > MAX_BATCH_MOVE) {
    throw new Error(`move_messages takes at most ${MAX_BATCH_MOVE} UIDs per call; ${uids.length} were given.`);
  }

  const client = getClient();
  await client.connect();
  try {
    const mailboxes = await client.list();
    assertMoveAllowed(mailboxes, params.folder, params.targetFolder);
    if (params.folder === params.targetFolder) {
      return uids.map((uid) => ({ uid, error: 'Source and destination are the same folder; nothing was moved.' }));
    }

    const outcomes: BatchMoveOutcome[] = [];
    for (const [index, uid] of uids.entries()) {
      if (client.usable === false) {
        // The connection is gone, so nothing further can be moved or checked.
        for (const rest of uids.slice(index)) {
          outcomes.push({ uid: rest, error: 'Not attempted: the connection to iCloud was lost.' });
        }
        break;
      }
      try {
        await assertExceptionsAllowMove(client, { sourcePath: params.folder, uid, targetPath: params.targetFolder });
        const { operationId } = await executeLoggedMove(client, {
          sourcePath: params.folder,
          uid,
          destPath: params.targetFolder,
        });
        outcomes.push({ uid, operationId });
      } catch (error) {
        outcomes.push({ uid, error: error instanceof Error ? error.message : String(error) });
      }
    }
    return outcomes;
  } finally {
    await client.logout();
  }
}

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
          await markFailed(
            operationId,
            'Reconciliation found the message still at the source folder; the move did not occur.',
          );
          throw new Error(`Move operation ${operationId} has nothing to undo (the original move did not occur).`);
        }
        if (destMatch !== null && sourceMatch === null) {
          const destInfoLock = await client.getMailboxLock(record.destPath);
          let destUidValidity: bigint;
          try {
            destUidValidity = client.mailbox !== false ? client.mailbox.uidValidity : 0n;
          } finally {
            destInfoLock.release();
          }
          await markConfirmed(operationId, { destUid: destMatch, destUidValidity });
          effectiveRecord = {
            ...record,
            status: 'confirmed',
            destUid: destMatch,
            destUidValidity: destUidValidity.toString(),
          };
        } else {
          throw new Error(
            `Cannot automatically reconcile move operation ${operationId}: manual verification is required.`,
          );
        }
      }

      const destUid = effectiveRecord.destUid as number;
      const mailboxes = await client.list();
      assertMoveAllowed(mailboxes, effectiveRecord.destPath, effectiveRecord.sourcePath);

      const destLock = await client.getMailboxLock(effectiveRecord.destPath);
      let destMeta;
      try {
        destMeta = await client.fetchOne(String(destUid), { envelope: true }, { uid: true });
      } finally {
        destLock.release();
      }
      const liveUidValidity = client.mailbox !== false ? client.mailbox.uidValidity : null;
      if (liveUidValidity === null || liveUidValidity.toString() !== effectiveRecord.destUidValidity) {
        throw new Error(
          `Cannot undo move operation ${operationId}: the destination folder's UIDVALIDITY has changed since the move, so UIDs are no longer trustworthy.`,
        );
      }
      if (!destMeta) {
        throw new Error(
          `Cannot undo move operation ${operationId}: the message is no longer at the recorded destination.`,
        );
      }
      const liveIdentity = {
        messageId: destMeta.envelope?.messageId ?? null,
        date: isoDate(destMeta.envelope?.date),
        subject: destMeta.envelope?.subject ?? null,
      };
      if (!identityMatches(liveIdentity, effectiveRecord.identity)) {
        throw new Error(
          `Cannot undo move operation ${operationId}: the message at the recorded destination UID no longer matches what was originally moved.`,
        );
      }

      // An undo only needs checking against the exceptions list when it would
      // take a message back out of the Inbox. Undoing *into* the Inbox is
      // always fine — that is where a keep_in_inbox rule wants it anyway.
      if (isInbox(effectiveRecord.destPath)) {
        const exceptions = await loadExceptions();
        if (exceptions) {
          const from = destMeta.envelope?.from?.[0];
          const match = matchException(exceptions, from?.address ?? null, from?.name ?? null);
          if (match && match.action === 'keep_in_inbox') {
            throw new Error(
              `Undo refused: the operator's exceptions list says mail from "${match.sender}" stays in the Inbox, ` +
                `and undoing operation ${operationId} would move it out. ` +
                'This is enforced by the server and cannot be overridden by the caller.',
            );
          }
        }
      }

      const { operationId: newOperationId } = await executeLoggedMove(client, {
        sourcePath: effectiveRecord.destPath,
        uid: destUid,
        destPath: effectiveRecord.sourcePath,
        undoOf: operationId,
      });
      await markUndone(operationId, newOperationId);
      return { newOperationId };
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

export interface MarkScannedParams {
  folder: string;
  throughUid: number;
}

/**
 * Asks the mail server how far the folder's UIDs currently go. UIDNEXT is the
 * UID the next arriving message will get, so the highest one that can exist
 * today is one below it.
 */
async function currentFolderState(
  folder: string,
): Promise<{ highestPossibleUid: number | null; uidValidity: UidValidity }> {
  const client = getClient();
  await client.connect();
  try {
    const lock = await client.getMailboxLock(folder);
    try {
      const uidValidity = openUidValidity(client);
      if (client.mailbox === false || client.mailbox.uidNext === undefined) {
        return { highestPossibleUid: null, uidValidity };
      }
      const uidNext = Number(client.mailbox.uidNext);
      return {
        highestPossibleUid: Number.isFinite(uidNext) ? uidNext - 1 : null,
        uidValidity,
      };
    } finally {
      lock.release();
    }
  } finally {
    await client.logout();
  }
}

/**
 * Advances the folder's high-water mark so a future `since_last_run` call
 * won't re-return messages up to and including throughUid. Never moves the
 * mark backwards, so calling this with a stale uid is a no-op.
 *
 * The mark is only moved to a UID this server has actually handed out. A
 * caller that asks for an enormous number would otherwise make every message
 * in the folder count as processed without any of it being read, and the next
 * scan would quietly skip the lot.
 */
export async function markScanned(params: MarkScannedParams): Promise<{ lastSeenUid: number }> {
  // The folder is asked about first so that every stored value below is read
  // against the numbering in force right now. A record from an older
  // numbering then reads as absent rather than being trusted.
  const { highestPossibleUid, uidValidity } = await currentFolderState(params.folder);

  const maxListed = await getMaxListedUid(params.folder, uidValidity);
  if (maxListed === null || params.throughUid > maxListed) {
    throw new Error(
      `mark_scanned refused: through_uid ${params.throughUid} is higher than any UID this server has returned ` +
        `from list_messages for "${params.folder}" in the last 24 hours (${maxListed ?? 'none'}). ` +
        'Only mark what you have been shown.',
    );
  }

  // A second line of defence, in case the recorded value is ever wrong: the
  // mark can never go past what the mail server says exists.
  if (highestPossibleUid !== null && params.throughUid > highestPossibleUid) {
    throw new Error(
      `mark_scanned refused: through_uid ${params.throughUid} is higher than the highest UID that exists in ` +
        `"${params.folder}" (${highestPossibleUid}). Only mark what you have been shown.`,
    );
  }

  await advanceLastSeenUid(params.folder, params.throughUid, uidValidity);
  const lastSeenUid = await getLastSeenUid(params.folder, uidValidity);
  return { lastSeenUid: lastSeenUid ?? params.throughUid };
}

/**
 * Compares the folder's currently-flagged messages against the set recorded
 * on the previous call. Anything that was flagged before but isn't anymore
 * gets returned so it can be sorted, since since_last_run permanently
 * excludes flagged messages and would otherwise never surface it again.
 * Always call this before a since_last_run scan.
 */
export async function reconcileFlagged(folder: string): Promise<{ newlyUnflagged: MessageSummary[] }> {
  const client = getClient();
  await client.connect();
  try {
    const lock = await client.getMailboxLock(folder);
    try {
      const flaggedSearchResult = await client.search({ flagged: true }, { uid: true });
      const currentFlaggedUids = flaggedSearchResult ? flaggedSearchResult : [];
      const previousPending = await getPendingFlaggedUids(folder);
      const currentSet = new Set(currentFlaggedUids);
      const newlyUnflaggedUids = previousPending.filter((uid) => !currentSet.has(uid));

      const newlyUnflagged: MessageSummary[] = [];
      if (newlyUnflaggedUids.length > 0) {
        for await (const message of client.fetch(newlyUnflaggedUids, { envelope: true, flags: true, uid: true }, { uid: true })) {
          newlyUnflagged.push(toSummary(message));
        }
      }

      await setPendingFlaggedUids(folder, currentFlaggedUids);
      return { newlyUnflagged };
    } finally {
      lock.release();
    }
  } finally {
    await client.logout();
  }
}

export async function getMoveOperation(operationId: string): Promise<MoveOperationRecord | null> {
  return getOperation(operationId);
}

export interface FlagMessageParams {
  folder: string;
  uid: number;
  flagged: boolean;
}

export async function flagMessage(params: FlagMessageParams): Promise<void> {
  const client = getClient();
  await client.connect();
  try {
    const lock = await client.getMailboxLock(params.folder);
    try {
      if (params.flagged) {
        await client.messageFlagsAdd(String(params.uid), ['\\Flagged'], { uid: true });
      } else {
        await client.messageFlagsRemove(String(params.uid), ['\\Flagged'], { uid: true });
      }
    } finally {
      lock.release();
    }
  } finally {
    await client.logout();
  }
}

/** Most addresses allowed in each of To, Cc and Bcc. */
export const MAX_DRAFT_RECIPIENTS = 4;
/** Most attachments on one draft. */
export const MAX_DRAFT_ATTACHMENTS = 10;
/**
 * Total size of a draft's attachments. Vercel refuses a request over 4.5MB,
 * and attachments arrive base64-encoded, which adds a third to their size.
 */
export const MAX_DRAFT_ATTACHMENT_BYTES = 3 * 1024 * 1024;

export interface DraftAttachment {
  filename: string;
  /** The file's contents, base64-encoded. */
  contentBase64: string;
  contentType?: string;
}

export interface SaveDraftParams {
  to: string[];
  cc?: string[];
  bcc?: string[];
  subject: string;
  /** Plain-text body. Required unless html is given. */
  body?: string;
  /** Formatted body. A plain-text copy is made from it when body is absent. */
  html?: string;
  attachments?: DraftAttachment[];
  /** The message this draft replies to, so Mail threads it with the original. */
  replyTo?: { folder: string; uid: number };
}

export interface SaveDraftResult {
  folder: string;
  uid?: number;
}

/**
 * The Drafts folder, found by its SPECIAL-USE marker, or by name when the
 * server does not report one. Drafts are only ever written here, so this is
 * also what keeps the tool from filing mail anywhere else.
 */
export function findDraftsFolder(mailboxes: MailboxListEntry[]): MailboxListEntry | null {
  return (
    mailboxes.find((m) => m.specialUse === '\\Drafts') ??
    mailboxes.find((m) => m.specialUse === undefined && m.name === 'Drafts') ??
    null
  );
}

/** The Message-ID and References of the message being replied to. */
async function fetchReplyHeaders(
  client: ImapFlow,
  folder: string,
  uid: number,
): Promise<{ inReplyTo?: string; references?: string[] }> {
  const lock = await client.getMailboxLock(folder);
  try {
    const meta = await client.fetchOne(String(uid), { envelope: true, headers: ['references'] }, { uid: true });
    if (!meta) {
      throw new Error(`Message uid ${uid} not found in folder ${folder}`);
    }
    const messageId = meta.envelope?.messageId;
    if (!messageId) return {};
    const referencesHeader = meta.headers ? meta.headers.toString('utf8').replace(/^references:/i, '') : '';
    const references = referencesHeader.match(/<[^<>\s]+>/g) ?? [];
    return { inReplyTo: messageId, references: [...references, messageId] };
  } finally {
    lock.release();
  }
}

function assertRecipientCount(field: string, addresses: string[] | undefined): void {
  if (addresses && addresses.length > MAX_DRAFT_RECIPIENTS) {
    throw new Error(`A draft can have at most ${MAX_DRAFT_RECIPIENTS} addresses in ${field}.`);
  }
}

/**
 * Decodes each attachment and checks the limits. Only the name, type and
 * decoded bytes are handed on: the mail builder can also read a file from
 * disk or fetch a web address for an attachment, and passing nothing else
 * keeps either from ever happening.
 */
function decodeAttachments(
  attachments: DraftAttachment[] | undefined,
): { filename: string; content: Buffer; contentType?: string }[] {
  if (!attachments) return [];
  if (attachments.length > MAX_DRAFT_ATTACHMENTS) {
    throw new Error(`A draft can have at most ${MAX_DRAFT_ATTACHMENTS} attachments.`);
  }
  let total = 0;
  return attachments.map((attachment) => {
    const encoded = attachment.contentBase64.replace(/\s/g, '');
    if (!/^[A-Za-z0-9+/]*={0,2}$/.test(encoded) || encoded.length % 4 !== 0) {
      throw new Error(`Attachment "${attachment.filename}" is not valid base64.`);
    }
    const content = Buffer.from(encoded, 'base64');
    total += content.length;
    if (total > MAX_DRAFT_ATTACHMENT_BYTES) {
      throw new Error(
        `Attachments add up to more than the ${MAX_DRAFT_ATTACHMENT_BYTES / 1024 / 1024}MB limit for one draft.`,
      );
    }
    return { filename: attachment.filename, content, contentType: attachment.contentType };
  });
}

/**
 * Builds the complete message. This only produces bytes: MailComposer has no
 * way to deliver anything, and nothing in this project creates a transport
 * that could (test/lib/no-sending.test.ts checks that stays true).
 */
export async function composeDraft(from: string, params: SaveDraftParams, reply: {
  inReplyTo?: string;
  references?: string[];
}): Promise<Buffer> {
  assertRecipientCount('To', params.to);
  assertRecipientCount('Cc', params.cc);
  assertRecipientCount('Bcc', params.bcc);
  if (params.to.length === 0) {
    throw new Error('A draft needs at least one address in To.');
  }
  if (params.body === undefined && params.html === undefined) {
    throw new Error('A draft needs a body, an html body, or both.');
  }
  const text = params.body ?? htmlToText(params.html as string);

  const mail = new MailComposer({
    from,
    to: params.to,
    cc: params.cc,
    bcc: params.bcc,
    subject: params.subject,
    text,
    html: params.html,
    attachments: decodeAttachments(params.attachments),
    inReplyTo: reply.inReplyTo,
    references: reply.references,
  }).compile();
  // A draft keeps its Bcc line so it is still there when the operator opens it.
  mail.keepBcc = true;
  return mail.build();
}

/**
 * Saves a new message in the Drafts folder, marked as a draft. Nothing is
 * sent: this server only speaks IMAP, which stores mail and has no command
 * for sending it. The draft waits in Mail until the operator sends it.
 */
export async function saveDraft(params: SaveDraftParams): Promise<SaveDraftResult> {
  const from = requireEnv('ICLOUD_EMAIL');
  // Build once before connecting, so a draft that breaks a limit is refused
  // without touching the account.
  await composeDraft(from, params, {});

  const client = getClient();
  await client.connect();
  try {
    const drafts = findDraftsFolder(await client.list());
    if (!drafts) {
      throw new Error('No Drafts folder was found in this mail account, so the draft could not be saved.');
    }

    const reply = params.replyTo ? await fetchReplyHeaders(client, params.replyTo.folder, params.replyTo.uid) : {};
    const source = await composeDraft(from, params, reply);

    const result = await client.append(drafts.path, source, ['\\Draft', '\\Seen']);
    return { folder: drafts.path, uid: result ? result.uid : undefined };
  } finally {
    await client.logout();
  }
}
