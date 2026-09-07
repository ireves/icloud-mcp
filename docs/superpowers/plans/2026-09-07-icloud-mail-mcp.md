# iCloud Mail, Calendar & Reminders MCP Server Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build and deploy a remote MCP server on Vercel that exposes 16 tools over iCloud IMAP and CalDAV (mail, calendar, reminders) for Claude to call from scheduled tasks.

**Architecture:** A single Vercel Node.js serverless function (`api/mcp.ts`) checks a bearer token, then hands the request to an `@modelcontextprotocol/sdk` `McpServer` running in stateless HTTP mode. The server has 16 tools registered, grouped into three files (`tools/mail.ts`, `tools/calendar.ts`, `tools/reminders.ts`) that each call a protocol wrapper (`lib/imap.ts` using `imapflow`, `lib/caldav.ts` using `tsdav` + `ical.js`). Every tool call opens its own connection and closes it before returning — no connection pooling, no persisted state, no database.

**Tech Stack:** TypeScript, Node.js (Vercel serverless runtime), `imapflow`, `mailparser`, `html-to-text`, `tsdav`, `ical.js`, `@modelcontextprotocol/sdk`, `zod`, `tsx` (for local scripts).

## Global Constraints

- Host: Vercel, Node.js runtime explicitly configured — never Edge (spec: Architecture).
- IMAP: `imap.mail.me.com:993` over TLS (spec: Architecture).
- CalDAV: `caldav.icloud.com`, discovered via `createDAVClient`'s built-in principal lookup — never a hardcoded account-specific path (spec: `lib/caldav.ts`).
- Single credential pair `ICLOUD_EMAIL` / `ICLOUD_APP_PASSWORD` authenticates both IMAP and CalDAV (spec: Architecture).
- `MCP_AUTH_TOKEN` bearer check happens before any IMAP/CalDAV call; compare with `crypto.timingSafeEqual`, not `===` (spec: `lib/auth.ts`).
- Never log or return `ICLOUD_APP_PASSWORD` or `MCP_AUTH_TOKEN` in any response or console output (spec: Error handling).
- Out of scope, do not build: sending mail, permanent delete/empty trash, calendar invitations/attendees, deleting events or reminders (spec: Tools).
- No database, no automated unit/integration test suite for v1 — verification is the two local smoke scripts plus manual post-deploy tool calls (spec: Testing). This plan therefore does **not** follow strict red/green TDD for the protocol wrappers; each wrapper task's "test" step is running the matching smoke script against real iCloud credentials and eyeballing the output, per the spec's own testing section.
- Tool input schemas are `zod` shapes with `.describe()` on every field — Claude reads these to decide when to call each tool (spec: Tools).
- IMAP/CalDAV quirks or incomplete reminder data encountered during implementation get reported to the user, not silently patched around (spec: Open items).

---

## File Structure

```
package.json
tsconfig.json
vercel.json
.env.example
lib/
  types.ts       # shared TS interfaces for tool inputs/outputs
  auth.ts        # bearer token check
  imap.ts        # imapflow wrapper — 6 mail functions
  caldav.ts       # tsdav + ical.js wrapper — 5 calendar + 5 reminder functions
tools/
  mail.ts         # registers 6 mail MCP tools
  calendar.ts     # registers 5 calendar MCP tools
  reminders.ts    # registers 5 reminder MCP tools
api/
  mcp.ts          # Vercel function: auth + MCP HTTP handler
scripts/
  test-imap.ts    # local IMAP smoke test
  test-caldav.ts  # local CalDAV smoke test
README.md
```

---

### Task 1: Project scaffolding

**Files:**
- Create: `package.json`
- Create: `tsconfig.json`
- Create: `vercel.json`
- Create: `.env.example`
- Modify: `.gitignore` (already exists with `.DS_Store`, `node_modules/`, `.env`, `.vercel/`, `dist/`)

**Interfaces:**
- Produces: an installable, TypeScript-compiling project skeleton every later task builds on.

- [ ] **Step 1: Write `package.json`**

```json
{
  "name": "icloud-mcp",
  "version": "1.0.0",
  "private": true,
  "type": "module",
  "scripts": {
    "build": "tsc -p tsconfig.json",
    "test:imap": "tsx scripts/test-imap.ts",
    "test:caldav": "tsx scripts/test-caldav.ts"
  },
  "dependencies": {
    "@modelcontextprotocol/sdk": "^1.12.0",
    "@vercel/node": "^3.2.0",
    "html-to-text": "^9.0.5",
    "ical.js": "^2.1.0",
    "imapflow": "^1.0.171",
    "mailparser": "^3.7.1",
    "tsdav": "^2.0.6",
    "zod": "^3.23.8"
  },
  "devDependencies": {
    "@types/html-to-text": "^9.0.4",
    "@types/mailparser": "^3.4.4",
    "@types/node": "^20.14.2",
    "dotenv": "^16.4.5",
    "tsx": "^4.15.6",
    "typescript": "^5.4.5"
  }
}
```

- [ ] **Step 2: Write `tsconfig.json`**

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "NodeNext",
    "moduleResolution": "NodeNext",
    "lib": ["ES2022"],
    "strict": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "forceConsistentCasingInFileNames": true,
    "resolveJsonModule": true,
    "outDir": "dist",
    "declaration": false
  },
  "include": ["lib/**/*.ts", "tools/**/*.ts", "api/**/*.ts", "scripts/**/*.ts"]
}
```

- [ ] **Step 3: Write `vercel.json`**

```json
{
  "functions": {
    "api/mcp.ts": {
      "runtime": "@vercel/node@3.2.0"
    }
  }
}
```

- [ ] **Step 4: Write `.env.example`**

```bash
# iCloud account email used for both IMAP and CalDAV
ICLOUD_EMAIL=you@icloud.com

# App-specific password generated at appleid.apple.com — NOT your main Apple ID password
ICLOUD_APP_PASSWORD=xxxx-xxxx-xxxx-xxxx

# Shared secret this MCP server requires in the Authorization: Bearer header.
# Generate one with: node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
MCP_AUTH_TOKEN=replace-with-a-long-random-string
```

- [ ] **Step 5: Install dependencies**

Run: `npm install`
Expected: `node_modules/` created, `package-lock.json` created, no errors.

- [ ] **Step 6: Verify TypeScript config is valid**

Run: `npx tsc -p tsconfig.json --noEmit`
Expected: succeeds with no errors (no `.ts` source files exist yet, so this only validates the config itself — if it errors on "no inputs", that's expected and fine at this stage).

- [ ] **Step 7: Commit**

```bash
git add package.json package-lock.json tsconfig.json vercel.json .env.example
git commit -m "Scaffold project: package.json, tsconfig, vercel config, env template

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>"
```

---

### Task 2: Shared types

**Files:**
- Create: `lib/types.ts`

**Interfaces:**
- Produces: `MailboxInfo`, `MessageSummary`, `MessageDetail`, `CalendarInfo`, `EventSummary`, `EventDetail`, `ReminderListInfo`, `ReminderSummary`, `ReminderDetail` — used by `lib/imap.ts`, `lib/caldav.ts`, and both `tools/*.ts` files in later tasks.

- [ ] **Step 1: Write `lib/types.ts`**

```typescript
export interface MailboxInfo {
  path: string;
  name: string;
  flags: string[];
  specialUse?: string;
}

export interface MessageSummary {
  uid: number;
  subject: string;
  from: string;
  date: string;
  unread: boolean;
}

export interface MessageDetail extends MessageSummary {
  to: string;
  body: string;
}

export interface CalendarInfo {
  id: string;
  name: string;
  color?: string;
}

export interface EventSummary {
  id: string;
  title: string;
  start: string;
  end: string;
  location?: string;
  hasAttendees: boolean;
}

export interface EventDetail extends EventSummary {
  notes?: string;
}

export interface ReminderListInfo {
  id: string;
  name: string;
}

export interface ReminderSummary {
  id: string;
  title: string;
  dueDate?: string;
  completed: boolean;
}

export interface ReminderDetail extends ReminderSummary {
  notes?: string;
}
```

- [ ] **Step 2: Verify it compiles**

Run: `npx tsc -p tsconfig.json --noEmit`
Expected: no errors.

- [ ] **Step 3: Commit**

```bash
git add lib/types.ts
git commit -m "Add shared TypeScript types for mail/calendar/reminder data

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>"
```

---

### Task 3: Bearer token auth check

**Files:**
- Create: `lib/auth.ts`

**Interfaces:**
- Consumes: `process.env.MCP_AUTH_TOKEN`
- Produces: `isAuthorized(authHeader: string | string[] | undefined): boolean` — used by `api/mcp.ts` in Task 11.

- [ ] **Step 1: Write `lib/auth.ts`**

```typescript
import { timingSafeEqual } from 'node:crypto';

export function isAuthorized(authHeader: string | string[] | undefined): boolean {
  const expected = process.env.MCP_AUTH_TOKEN;
  if (!expected) {
    throw new Error('MCP_AUTH_TOKEN is not set');
  }

  const header = Array.isArray(authHeader) ? authHeader[0] : authHeader;
  if (!header || !header.startsWith('Bearer ')) {
    return false;
  }

  const provided = header.slice('Bearer '.length);
  const expectedBuf = Buffer.from(expected);
  const providedBuf = Buffer.from(provided);

  if (expectedBuf.length !== providedBuf.length) {
    return false;
  }

  return timingSafeEqual(expectedBuf, providedBuf);
}
```

- [ ] **Step 2: Verify it compiles**

Run: `npx tsc -p tsconfig.json --noEmit`
Expected: no errors.

- [ ] **Step 3: Manually verify the logic**

Run: `MCP_AUTH_TOKEN=secret123 node --experimental-strip-types -e "import('./lib/auth.ts').then(m => { console.log(m.isAuthorized('Bearer secret123')); console.log(m.isAuthorized('Bearer wrong')); console.log(m.isAuthorized(undefined)); })"`
Expected output: `true`, `false`, `false` (three lines). If your Node version doesn't support `--experimental-strip-types`, run the equivalent check with `npx tsx -e "..."` using the same import and calls instead.

- [ ] **Step 4: Commit**

```bash
git add lib/auth.ts
git commit -m "Add constant-time bearer token auth check

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>"
```

---

### Task 4: IMAP wrapper (`lib/imap.ts`)

**Files:**
- Create: `lib/imap.ts`

**Interfaces:**
- Consumes: `MailboxInfo`, `MessageSummary`, `MessageDetail` from `lib/types.ts` (Task 2). `process.env.ICLOUD_EMAIL`, `process.env.ICLOUD_APP_PASSWORD`.
- Produces:
  - `listFolders(): Promise<MailboxInfo[]>`
  - `listMessages(params: { folder: string; limit?: number; unreadOnly?: boolean; sinceDate?: string; fromAddress?: string }): Promise<MessageSummary[]>`
  - `getMessage(params: { folder: string; uid: number }): Promise<MessageDetail>`
  - `markMessage(params: { folder: string; uid: number; read: boolean }): Promise<void>`
  - `moveMessage(params: { folder: string; uid: number; targetFolder: string }): Promise<void>`
  - `flagMessage(params: { folder: string; uid: number; flagged: boolean }): Promise<void>`

  These six are consumed by `tools/mail.ts` in Task 8.

- [ ] **Step 1: Write `lib/imap.ts`**

```typescript
import { ImapFlow } from 'imapflow';
import { simpleParser } from 'mailparser';
import { convert } from 'html-to-text';
import type { MailboxInfo, MessageDetail, MessageSummary } from './types.js';

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`${name} is not set`);
  }
  return value;
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

async function extractBody(source: Buffer | undefined): Promise<string> {
  if (!source) return '';
  const parsed = await simpleParser(source);
  if (parsed.text) return parsed.text;
  if (parsed.html) return convert(parsed.html, { wordwrap: 100 });
  return '';
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
  fromAddress?: string;
}

export async function listMessages(params: ListMessagesParams): Promise<MessageSummary[]> {
  const client = getClient();
  await client.connect();
  try {
    const lock = await client.getMailboxLock(params.folder);
    try {
      const searchCriteria: Record<string, unknown> = {};
      if (params.unreadOnly) searchCriteria.seen = false;
      if (params.sinceDate) searchCriteria.since = new Date(params.sinceDate);
      if (params.fromAddress) searchCriteria.from = params.fromAddress;
      const query = Object.keys(searchCriteria).length > 0 ? searchCriteria : { all: true };

      const uids = await client.search(query, { uid: true });
      if (!uids || uids.length === 0) return [];

      const limited = uids.slice(-(params.limit ?? 25)).reverse();
      const results: MessageSummary[] = [];
      for await (const message of client.fetch(limited, { envelope: true, flags: true, uid: true }, { uid: true })) {
        results.push({
          uid: message.uid,
          subject: message.envelope?.subject ?? '(no subject)',
          from: message.envelope?.from?.[0]?.address ?? 'unknown',
          date: message.envelope?.date ? message.envelope.date.toISOString() : '',
          unread: !message.flags?.has('\\Seen'),
        });
      }
      return results;
    } finally {
      lock.release();
    }
  } finally {
    await client.logout();
  }
}

export interface GetMessageParams {
  folder: string;
  uid: number;
}

export async function getMessage(params: GetMessageParams): Promise<MessageDetail> {
  const client = getClient();
  await client.connect();
  try {
    const lock = await client.getMailboxLock(params.folder);
    try {
      const message = await client.fetchOne(
        String(params.uid),
        { envelope: true, flags: true, source: true },
        { uid: true },
      );
      if (!message) {
        throw new Error(`Message uid ${params.uid} not found in folder ${params.folder}`);
      }
      const body = await extractBody(message.source as Buffer | undefined);
      return {
        uid: message.uid,
        subject: message.envelope?.subject ?? '(no subject)',
        from: message.envelope?.from?.[0]?.address ?? 'unknown',
        to: message.envelope?.to?.map((a) => a.address).filter(Boolean).join(', ') ?? '',
        date: message.envelope?.date ? message.envelope.date.toISOString() : '',
        unread: !message.flags?.has('\\Seen'),
        body,
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

export async function moveMessage(params: MoveMessageParams): Promise<void> {
  const client = getClient();
  await client.connect();
  try {
    const lock = await client.getMailboxLock(params.folder);
    try {
      await client.messageMove(String(params.uid), params.targetFolder, { uid: true });
    } finally {
      lock.release();
    }
  } finally {
    await client.logout();
  }
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
```

- [ ] **Step 2: Verify it compiles**

Run: `npx tsc -p tsconfig.json --noEmit`
Expected: no errors.

- [ ] **Step 3: Commit**

```bash
git add lib/imap.ts
git commit -m "Add IMAP wrapper for the 6 mail tools

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>"
```

(Functional verification of this file happens in Task 5, against real credentials.)

---

### Task 5: IMAP local smoke test

**Files:**
- Create: `scripts/test-imap.ts`

**Interfaces:**
- Consumes: every export from `lib/imap.ts` (Task 4).
- Produces: a runnable script (`npm run test:imap`) — the spec's required way to isolate IMAP connection problems from tool-logic problems before wiring up `api/mcp.ts`.

- [ ] **Step 1: Write `scripts/test-imap.ts`**

```typescript
import 'dotenv/config';
import { listFolders, listMessages, getMessage } from '../lib/imap.js';

async function main() {
  console.log('--- list_folders ---');
  const folders = await listFolders();
  console.log(`Found ${folders.length} folders:`);
  for (const folder of folders) {
    console.log(`  ${folder.path} (${folder.flags.join(', ') || 'no flags'})`);
  }

  const inbox = folders.find((f) => f.specialUse === '\\Inbox') ?? folders.find((f) => f.path === 'INBOX');
  if (!inbox) {
    console.log('No INBOX-like folder found — stopping here.');
    return;
  }

  console.log(`\n--- list_messages (folder: ${inbox.path}, limit: 5) ---`);
  const messages = await listMessages({ folder: inbox.path, limit: 5 });
  console.log(`Found ${messages.length} messages:`);
  for (const message of messages) {
    console.log(`  uid=${message.uid} unread=${message.unread} "${message.subject}" from ${message.from}`);
  }

  if (messages.length > 0) {
    console.log(`\n--- get_message (uid: ${messages[0].uid}) ---`);
    const detail = await getMessage({ folder: inbox.path, uid: messages[0].uid });
    console.log(`Subject: ${detail.subject}`);
    console.log(`From: ${detail.from}`);
    console.log(`Body (first 200 chars): ${detail.body.slice(0, 200)}`);
  }

  console.log('\nIMAP smoke test complete.');
}

main().catch((error) => {
  console.error('IMAP smoke test failed:', error);
  process.exitCode = 1;
});
```

- [ ] **Step 2: Verify it compiles**

Run: `npx tsc -p tsconfig.json --noEmit`
Expected: no errors.

- [ ] **Step 3: Run against real credentials**

Create a local `.env` (not committed — already gitignored) with real `ICLOUD_EMAIL` and `ICLOUD_APP_PASSWORD` values, then:

Run: `npm run test:imap`
Expected: prints the folder list, up to 5 recent inbox message headers, and one message body excerpt, with no errors. If this fails, stop and report the exact IMAP error to the user per the spec's "tell me, don't silently fix" guidance — do not change folder-name or UID handling to work around it without flagging first.

- [ ] **Step 4: Commit**

```bash
git add scripts/test-imap.ts
git commit -m "Add local IMAP smoke test script

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>"
```

---

### Task 6: CalDAV wrapper (`lib/caldav.ts`)

**Files:**
- Create: `lib/caldav.ts`

**Interfaces:**
- Consumes: `CalendarInfo`, `EventSummary`, `EventDetail`, `ReminderListInfo`, `ReminderSummary`, `ReminderDetail` from `lib/types.ts` (Task 2). `process.env.ICLOUD_EMAIL`, `process.env.ICLOUD_APP_PASSWORD`.
- Produces:
  - `listCalendars(): Promise<CalendarInfo[]>`
  - `listEvents(params: { calendarId: string; startDate: string; endDate: string }): Promise<EventSummary[]>`
  - `getEvent(params: { calendarId: string; eventId: string }): Promise<EventDetail>`
  - `createEvent(params: { calendarId: string; title: string; startTime: string; endTime: string; location?: string; notes?: string }): Promise<{ id: string }>`
  - `updateEvent(params: { calendarId: string; eventId: string; title?: string; startTime?: string; endTime?: string; location?: string; notes?: string }): Promise<void>`
  - `listReminderLists(): Promise<ReminderListInfo[]>`
  - `listReminders(params: { listId: string; includeCompleted?: boolean }): Promise<ReminderSummary[]>`
  - `getReminder(params: { listId: string; reminderId: string }): Promise<ReminderDetail>`
  - `createReminder(params: { listId: string; title: string; dueDate?: string; notes?: string }): Promise<{ id: string }>`
  - `completeReminder(params: { listId: string; reminderId: string; completed: boolean }): Promise<void>`

  These ten are consumed by `tools/calendar.ts` (Task 9) and `tools/reminders.ts` (Task 10).

- [ ] **Step 1: Write `lib/caldav.ts`**

```typescript
import { createDAVClient, type DAVCalendar, type DAVClient } from 'tsdav';
import ICAL from 'ical.js';
import type {
  CalendarInfo,
  EventDetail,
  EventSummary,
  ReminderDetail,
  ReminderListInfo,
  ReminderSummary,
} from './types.js';

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`${name} is not set`);
  }
  return value;
}

let cachedClient: DAVClient | null = null;

async function getClient(): Promise<DAVClient> {
  if (cachedClient) return cachedClient;
  const username = requireEnv('ICLOUD_EMAIL');
  const password = requireEnv('ICLOUD_APP_PASSWORD');
  cachedClient = await createDAVClient({
    serverUrl: 'https://caldav.icloud.com',
    credentials: { username, password },
    authMethod: 'Basic',
    defaultAccountType: 'caldav',
  });
  return cachedClient;
}

async function fetchAllCalendars(): Promise<DAVCalendar[]> {
  const client = await getClient();
  return client.fetchCalendars();
}

function isEventCalendar(cal: DAVCalendar): boolean {
  return Boolean(cal.components?.includes('VEVENT'));
}

function isTodoCalendar(cal: DAVCalendar): boolean {
  return Boolean(cal.components?.includes('VTODO'));
}

function toCalendarInfo(cal: DAVCalendar): CalendarInfo {
  return {
    id: cal.url,
    name: String(cal.displayName ?? cal.url),
    color: cal.calendarColor,
  };
}

async function findCalendar(calendarId: string): Promise<DAVCalendar> {
  const calendars = await fetchAllCalendars();
  const calendar = calendars.find((c) => c.url === calendarId);
  if (!calendar) {
    throw new Error(`Calendar or list ${calendarId} not found`);
  }
  return calendar;
}

export async function listCalendars(): Promise<CalendarInfo[]> {
  const calendars = await fetchAllCalendars();
  return calendars.filter(isEventCalendar).map(toCalendarInfo);
}

export async function listReminderLists(): Promise<ReminderListInfo[]> {
  const calendars = await fetchAllCalendars();
  return calendars.filter(isTodoCalendar).map((c) => ({ id: c.url, name: String(c.displayName ?? c.url) }));
}

// --- Events ---

function parseEventObject(obj: { url: string; data: string }): EventSummary | null {
  const jcal = ICAL.parse(obj.data);
  const comp = new ICAL.Component(jcal);
  const vevent = comp.getFirstSubcomponent('vevent');
  if (!vevent) return null;
  const event = new ICAL.Event(vevent);
  return {
    id: obj.url,
    title: event.summary ?? '(untitled)',
    start: event.startDate ? event.startDate.toJSDate().toISOString() : '',
    end: event.endDate ? event.endDate.toJSDate().toISOString() : '',
    location: (vevent.getFirstPropertyValue('location') as string | null) ?? undefined,
    hasAttendees: vevent.getAllProperties('attendee').length > 0,
  };
}

export interface ListEventsParams {
  calendarId: string;
  startDate: string;
  endDate: string;
}

export async function listEvents(params: ListEventsParams): Promise<EventSummary[]> {
  const client = await getClient();
  const calendar = await findCalendar(params.calendarId);
  const objects = await client.fetchCalendarObjects({
    calendar,
    timeRange: {
      start: new Date(params.startDate).toISOString(),
      end: new Date(params.endDate).toISOString(),
    },
  });
  return objects
    .map((obj) => parseEventObject({ url: obj.url, data: obj.data ?? '' }))
    .filter((e): e is EventSummary => e !== null);
}

export interface GetEventParams {
  calendarId: string;
  eventId: string;
}

export async function getEvent(params: GetEventParams): Promise<EventDetail> {
  const client = await getClient();
  const calendar = await findCalendar(params.calendarId);
  const objects = await client.fetchCalendarObjects({ calendar, objectUrls: [params.eventId] });
  const obj = objects[0];
  if (!obj || !obj.data) {
    throw new Error(`Event ${params.eventId} not found in calendar ${params.calendarId}`);
  }
  const summary = parseEventObject({ url: obj.url, data: obj.data });
  if (!summary) {
    throw new Error(`Event ${params.eventId} could not be parsed as a VEVENT`);
  }
  const jcal = ICAL.parse(obj.data);
  const comp = new ICAL.Component(jcal);
  const vevent = comp.getFirstSubcomponent('vevent');
  const notes = (vevent?.getFirstPropertyValue('description') as string | null) ?? undefined;
  return { ...summary, notes };
}

function newUid(): string {
  return `${Date.now()}-${Math.random().toString(36).slice(2)}@icloud-mcp`;
}

export interface CreateEventParams {
  calendarId: string;
  title: string;
  startTime: string;
  endTime: string;
  location?: string;
  notes?: string;
}

export async function createEvent(params: CreateEventParams): Promise<{ id: string }> {
  const client = await getClient();
  const calendar = await findCalendar(params.calendarId);
  const uid = newUid();
  const filename = `${uid}.ics`;

  const vcalendar = new ICAL.Component(['vcalendar', [], []]);
  vcalendar.updatePropertyWithValue('version', '2.0');
  vcalendar.updatePropertyWithValue('prodid', '-//icloud-mcp//EN');
  const vevent = new ICAL.Component('vevent');
  vevent.updatePropertyWithValue('uid', uid);
  vevent.updatePropertyWithValue('summary', params.title);
  vevent.updatePropertyWithValue('dtstart', ICAL.Time.fromJSDate(new Date(params.startTime), true));
  vevent.updatePropertyWithValue('dtend', ICAL.Time.fromJSDate(new Date(params.endTime), true));
  vevent.updatePropertyWithValue('dtstamp', ICAL.Time.now());
  if (params.location) vevent.updatePropertyWithValue('location', params.location);
  if (params.notes) vevent.updatePropertyWithValue('description', params.notes);
  vcalendar.addSubcomponent(vevent);

  const response = await client.createCalendarObject({
    calendar,
    filename,
    iCalString: vcalendar.toString(),
  });
  if (!response.ok) {
    throw new Error(`Failed to create event: ${response.status} ${response.statusText}`);
  }
  return { id: new URL(filename, calendar.url).toString() };
}

export interface UpdateEventParams {
  calendarId: string;
  eventId: string;
  title?: string;
  startTime?: string;
  endTime?: string;
  location?: string;
  notes?: string;
}

export async function updateEvent(params: UpdateEventParams): Promise<void> {
  const client = await getClient();
  const calendar = await findCalendar(params.calendarId);
  const objects = await client.fetchCalendarObjects({ calendar, objectUrls: [params.eventId] });
  const obj = objects[0];
  if (!obj || !obj.data) {
    throw new Error(`Event ${params.eventId} not found in calendar ${params.calendarId}`);
  }
  const jcal = ICAL.parse(obj.data);
  const comp = new ICAL.Component(jcal);
  const vevent = comp.getFirstSubcomponent('vevent');
  if (!vevent) {
    throw new Error(`Event ${params.eventId} has no VEVENT body`);
  }
  if (params.title !== undefined) vevent.updatePropertyWithValue('summary', params.title);
  if (params.startTime !== undefined) {
    vevent.updatePropertyWithValue('dtstart', ICAL.Time.fromJSDate(new Date(params.startTime), true));
  }
  if (params.endTime !== undefined) {
    vevent.updatePropertyWithValue('dtend', ICAL.Time.fromJSDate(new Date(params.endTime), true));
  }
  if (params.location !== undefined) vevent.updatePropertyWithValue('location', params.location);
  if (params.notes !== undefined) vevent.updatePropertyWithValue('description', params.notes);

  const response = await client.updateCalendarObject({
    calendarObject: { url: obj.url, data: comp.toString(), etag: obj.etag },
  });
  if (!response.ok) {
    throw new Error(`Failed to update event: ${response.status} ${response.statusText}`);
  }
}

// --- Reminders (VTODO) ---

function parseTodoObject(obj: { url: string; data: string }): ReminderSummary | null {
  const jcal = ICAL.parse(obj.data);
  const comp = new ICAL.Component(jcal);
  const vtodo = comp.getFirstSubcomponent('vtodo');
  if (!vtodo) return null;
  const due = vtodo.getFirstPropertyValue('due') as ICAL.Time | null;
  const status = vtodo.getFirstPropertyValue('status') as string | null;
  return {
    id: obj.url,
    title: (vtodo.getFirstPropertyValue('summary') as string | null) ?? '(untitled)',
    dueDate: due ? due.toJSDate().toISOString() : undefined,
    completed: status === 'COMPLETED',
  };
}

export interface ListRemindersParams {
  listId: string;
  includeCompleted?: boolean;
}

export async function listReminders(params: ListRemindersParams): Promise<ReminderSummary[]> {
  const client = await getClient();
  const calendar = await findCalendar(params.listId);
  const objects = await client.fetchCalendarObjects({ calendar });
  const reminders = objects
    .map((obj) => parseTodoObject({ url: obj.url, data: obj.data ?? '' }))
    .filter((r): r is ReminderSummary => r !== null);
  return params.includeCompleted ? reminders : reminders.filter((r) => !r.completed);
}

export interface GetReminderParams {
  listId: string;
  reminderId: string;
}

export async function getReminder(params: GetReminderParams): Promise<ReminderDetail> {
  const client = await getClient();
  const calendar = await findCalendar(params.listId);
  const objects = await client.fetchCalendarObjects({ calendar, objectUrls: [params.reminderId] });
  const obj = objects[0];
  if (!obj || !obj.data) {
    throw new Error(`Reminder ${params.reminderId} not found in list ${params.listId}`);
  }
  const summary = parseTodoObject({ url: obj.url, data: obj.data });
  if (!summary) {
    throw new Error(`Reminder ${params.reminderId} could not be parsed as a VTODO`);
  }
  const jcal = ICAL.parse(obj.data);
  const comp = new ICAL.Component(jcal);
  const vtodo = comp.getFirstSubcomponent('vtodo');
  const notes = (vtodo?.getFirstPropertyValue('description') as string | null) ?? undefined;
  return { ...summary, notes };
}

export interface CreateReminderParams {
  listId: string;
  title: string;
  dueDate?: string;
  notes?: string;
}

export async function createReminder(params: CreateReminderParams): Promise<{ id: string }> {
  const client = await getClient();
  const calendar = await findCalendar(params.listId);
  const uid = newUid();
  const filename = `${uid}.ics`;

  const vcalendar = new ICAL.Component(['vcalendar', [], []]);
  vcalendar.updatePropertyWithValue('version', '2.0');
  vcalendar.updatePropertyWithValue('prodid', '-//icloud-mcp//EN');
  const vtodo = new ICAL.Component('vtodo');
  vtodo.updatePropertyWithValue('uid', uid);
  vtodo.updatePropertyWithValue('summary', params.title);
  vtodo.updatePropertyWithValue('dtstamp', ICAL.Time.now());
  vtodo.updatePropertyWithValue('status', 'NEEDS-ACTION');
  if (params.dueDate) vtodo.updatePropertyWithValue('due', ICAL.Time.fromJSDate(new Date(params.dueDate), true));
  if (params.notes) vtodo.updatePropertyWithValue('description', params.notes);
  vcalendar.addSubcomponent(vtodo);

  const response = await client.createCalendarObject({
    calendar,
    filename,
    iCalString: vcalendar.toString(),
  });
  if (!response.ok) {
    throw new Error(`Failed to create reminder: ${response.status} ${response.statusText}`);
  }
  return { id: new URL(filename, calendar.url).toString() };
}

export interface CompleteReminderParams {
  listId: string;
  reminderId: string;
  completed: boolean;
}

export async function completeReminder(params: CompleteReminderParams): Promise<void> {
  const client = await getClient();
  const calendar = await findCalendar(params.listId);
  const objects = await client.fetchCalendarObjects({ calendar, objectUrls: [params.reminderId] });
  const obj = objects[0];
  if (!obj || !obj.data) {
    throw new Error(`Reminder ${params.reminderId} not found in list ${params.listId}`);
  }
  const jcal = ICAL.parse(obj.data);
  const comp = new ICAL.Component(jcal);
  const vtodo = comp.getFirstSubcomponent('vtodo');
  if (!vtodo) {
    throw new Error(`Reminder ${params.reminderId} has no VTODO body`);
  }
  vtodo.updatePropertyWithValue('status', params.completed ? 'COMPLETED' : 'NEEDS-ACTION');
  if (params.completed) {
    vtodo.updatePropertyWithValue('completed', ICAL.Time.now());
  } else {
    vtodo.removeProperty('completed');
  }

  const response = await client.updateCalendarObject({
    calendarObject: { url: obj.url, data: comp.toString(), etag: obj.etag },
  });
  if (!response.ok) {
    throw new Error(`Failed to update reminder: ${response.status} ${response.statusText}`);
  }
}
```

- [ ] **Step 2: Verify it compiles**

Run: `npx tsc -p tsconfig.json --noEmit`
Expected: no errors. If `tsdav`'s bundled types don't export `DAVCalendar`/`DAVClient` the way this file expects, that's exactly the kind of CalDAV-library quirk the spec asks to be reported rather than silently patched — flag it before changing the approach.

- [ ] **Step 3: Commit**

```bash
git add lib/caldav.ts
git commit -m "Add CalDAV wrapper for the 10 calendar and reminder tools

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>"
```

(Functional verification of this file happens in Task 7, against real credentials.)

---

### Task 7: CalDAV local smoke test

**Files:**
- Create: `scripts/test-caldav.ts`

**Interfaces:**
- Consumes: every export from `lib/caldav.ts` (Task 6).
- Produces: a runnable script (`npm run test:caldav`) — isolates CalDAV discovery/connection problems from tool-logic problems, independent of the IMAP smoke test.

- [ ] **Step 1: Write `scripts/test-caldav.ts`**

```typescript
import 'dotenv/config';
import { listCalendars, listEvents, listReminderLists, listReminders } from '../lib/caldav.js';

async function main() {
  console.log('--- list_calendars ---');
  const calendars = await listCalendars();
  console.log(`Found ${calendars.length} calendars:`);
  for (const cal of calendars) {
    console.log(`  ${cal.id} — ${cal.name}`);
  }

  if (calendars.length > 0) {
    const now = new Date();
    const in30Days = new Date(now.getTime() + 30 * 24 * 60 * 60 * 1000);
    console.log(`\n--- list_events (calendar: ${calendars[0].name}, next 30 days) ---`);
    const events = await listEvents({
      calendarId: calendars[0].id,
      startDate: now.toISOString(),
      endDate: in30Days.toISOString(),
    });
    console.log(`Found ${events.length} events:`);
    for (const event of events) {
      console.log(`  "${event.title}" ${event.start} - ${event.end}`);
    }
  }

  console.log('\n--- list_reminder_lists ---');
  const lists = await listReminderLists();
  console.log(`Found ${lists.length} reminder lists:`);
  for (const list of lists) {
    console.log(`  ${list.id} — ${list.name}`);
  }

  if (lists.length > 0) {
    console.log(`\n--- list_reminders (list: ${lists[0].name}) ---`);
    const reminders = await listReminders({ listId: lists[0].id });
    console.log(`Found ${reminders.length} open reminders:`);
    for (const reminder of reminders) {
      console.log(`  "${reminder.title}" due=${reminder.dueDate ?? 'none'}`);
    }
  }

  console.log('\nCalDAV smoke test complete.');
}

main().catch((error) => {
  console.error('CalDAV smoke test failed:', error);
  process.exitCode = 1;
});
```

- [ ] **Step 2: Verify it compiles**

Run: `npx tsc -p tsconfig.json --noEmit`
Expected: no errors.

- [ ] **Step 3: Run against real credentials**

Using the same local `.env` from Task 5:

Run: `npm run test:caldav`
Expected: prints calendars, upcoming events in the first calendar, reminder lists, and open reminders in the first list, with no errors. If CalDAV discovery behaves unexpectedly (e.g. wrong principal URL, empty calendar list) or reminder data looks incomplete, stop and report exactly what you saw to the user — per the spec, this is a known area of Apple/CalDAV quirks to flag, not silently work around.

- [ ] **Step 4: Commit**

```bash
git add scripts/test-caldav.ts
git commit -m "Add local CalDAV smoke test script

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>"
```

---

### Task 8: Register mail MCP tools

**Files:**
- Create: `tools/mail.ts`

**Interfaces:**
- Consumes: `listFolders`, `listMessages`, `getMessage`, `markMessage`, `moveMessage`, `flagMessage` from `lib/imap.ts` (Task 4).
- Produces: `registerMailTools(server: McpServer): void` — consumed by `api/mcp.ts` in Task 11.

- [ ] **Step 1: Write `tools/mail.ts`**

```typescript
import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import {
  flagMessage,
  getMessage,
  listFolders,
  listMessages,
  markMessage,
  moveMessage,
} from '../lib/imap.js';

function toResult(data: unknown) {
  return { content: [{ type: 'text' as const, text: JSON.stringify(data, null, 2) }] };
}

function toErrorResult(error: unknown) {
  const message = error instanceof Error ? error.message : String(error);
  return { content: [{ type: 'text' as const, text: message }], isError: true };
}

export function registerMailTools(server: McpServer): void {
  server.registerTool(
    'list_folders',
    {
      title: 'List Mail Folders',
      description: 'Lists all folders/mailboxes in the iCloud mail account.',
      inputSchema: {},
    },
    async () => {
      try {
        return toResult(await listFolders());
      } catch (error) {
        return toErrorResult(error);
      }
    },
  );

  server.registerTool(
    'list_messages',
    {
      title: 'List Mail Messages',
      description:
        'Lists message headers (subject, sender, date, unread status, UID) in a folder — not full bodies. Use get_message for a full body.',
      inputSchema: {
        folder: z.string().describe('Folder path, e.g. "INBOX"'),
        limit: z.number().int().positive().max(200).optional().describe('Max messages to return, default 25'),
        unread_only: z.boolean().optional().describe('Only return unread messages'),
        since_date: z.string().optional().describe('ISO 8601 date; only messages on or after this date'),
        from_address: z.string().optional().describe('Only messages from this sender address'),
      },
    },
    async (args) => {
      try {
        const messages = await listMessages({
          folder: args.folder,
          limit: args.limit,
          unreadOnly: args.unread_only,
          sinceDate: args.since_date,
          fromAddress: args.from_address,
        });
        return toResult(messages);
      } catch (error) {
        return toErrorResult(error);
      }
    },
  );

  server.registerTool(
    'get_message',
    {
      title: 'Get Mail Message',
      description:
        'Returns full headers and body for one message. HTML-only messages are converted to readable plain text.',
      inputSchema: {
        folder: z.string().describe('Folder path, e.g. "INBOX"'),
        uid: z.number().int().describe('Message UID, from list_messages'),
      },
    },
    async (args) => {
      try {
        return toResult(await getMessage({ folder: args.folder, uid: args.uid }));
      } catch (error) {
        return toErrorResult(error);
      }
    },
  );

  server.registerTool(
    'mark_message',
    {
      title: 'Mark Message Read/Unread',
      description: 'Sets the read/unread status of a message.',
      inputSchema: {
        folder: z.string().describe('Folder path'),
        uid: z.number().int().describe('Message UID'),
        read: z.boolean().describe('true = mark as read, false = mark as unread'),
      },
    },
    async (args) => {
      try {
        await markMessage({ folder: args.folder, uid: args.uid, read: args.read });
        return toResult({ ok: true });
      } catch (error) {
        return toErrorResult(error);
      }
    },
  );

  server.registerTool(
    'move_message',
    {
      title: 'Move Message',
      description: 'Moves a message from one folder to another.',
      inputSchema: {
        folder: z.string().describe('Current folder path'),
        uid: z.number().int().describe('Message UID'),
        target_folder: z.string().describe('Destination folder path'),
      },
    },
    async (args) => {
      try {
        await moveMessage({ folder: args.folder, uid: args.uid, targetFolder: args.target_folder });
        return toResult({ ok: true });
      } catch (error) {
        return toErrorResult(error);
      }
    },
  );

  server.registerTool(
    'flag_message',
    {
      title: 'Flag Message',
      description: 'Sets or clears the flagged/starred status of a message.',
      inputSchema: {
        folder: z.string().describe('Folder path'),
        uid: z.number().int().describe('Message UID'),
        flagged: z.boolean().describe('true = flag/star, false = unflag'),
      },
    },
    async (args) => {
      try {
        await flagMessage({ folder: args.folder, uid: args.uid, flagged: args.flagged });
        return toResult({ ok: true });
      } catch (error) {
        return toErrorResult(error);
      }
    },
  );
}
```

- [ ] **Step 2: Verify it compiles**

Run: `npx tsc -p tsconfig.json --noEmit`
Expected: no errors.

- [ ] **Step 3: Commit**

```bash
git add tools/mail.ts
git commit -m "Register the 6 mail tools with the MCP server

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>"
```

---

### Task 9: Register calendar MCP tools

**Files:**
- Create: `tools/calendar.ts`

**Interfaces:**
- Consumes: `listCalendars`, `listEvents`, `getEvent`, `createEvent`, `updateEvent` from `lib/caldav.ts` (Task 6).
- Produces: `registerCalendarTools(server: McpServer): void` — consumed by `api/mcp.ts` in Task 11.

- [ ] **Step 1: Write `tools/calendar.ts`**

```typescript
import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { createEvent, getEvent, listCalendars, listEvents, updateEvent } from '../lib/caldav.js';

function toResult(data: unknown) {
  return { content: [{ type: 'text' as const, text: JSON.stringify(data, null, 2) }] };
}

function toErrorResult(error: unknown) {
  const message = error instanceof Error ? error.message : String(error);
  return { content: [{ type: 'text' as const, text: message }], isError: true };
}

export function registerCalendarTools(server: McpServer): void {
  server.registerTool(
    'list_calendars',
    {
      title: 'List Calendars',
      description: 'Lists the account\'s event calendars (name, identifier, colour if available).',
      inputSchema: {},
    },
    async () => {
      try {
        return toResult(await listCalendars());
      } catch (error) {
        return toErrorResult(error);
      }
    },
  );

  server.registerTool(
    'list_events',
    {
      title: 'List Events',
      description:
        'Lists event summaries (title, start/end, location, whether it has attendees) in a calendar within a date range.',
      inputSchema: {
        calendar_id: z.string().describe('Calendar identifier, from list_calendars'),
        start_date: z.string().describe('ISO 8601 start of the date range'),
        end_date: z.string().describe('ISO 8601 end of the date range'),
      },
    },
    async (args) => {
      try {
        const events = await listEvents({
          calendarId: args.calendar_id,
          startDate: args.start_date,
          endDate: args.end_date,
        });
        return toResult(events);
      } catch (error) {
        return toErrorResult(error);
      }
    },
  );

  server.registerTool(
    'get_event',
    {
      title: 'Get Event',
      description: 'Returns full details for one event.',
      inputSchema: {
        calendar_id: z.string().describe('Calendar identifier'),
        event_id: z.string().describe('Event identifier, from list_events'),
      },
    },
    async (args) => {
      try {
        return toResult(await getEvent({ calendarId: args.calendar_id, eventId: args.event_id }));
      } catch (error) {
        return toErrorResult(error);
      }
    },
  );

  server.registerTool(
    'create_event',
    {
      title: 'Create Event',
      description:
        'Creates a personal calendar event. Never adds attendees or sends invitations — this is for personal scheduling only.',
      inputSchema: {
        calendar_id: z.string().describe('Calendar identifier to create the event in'),
        title: z.string().describe('Event title'),
        start_time: z.string().describe('ISO 8601 start time'),
        end_time: z.string().describe('ISO 8601 end time'),
        location: z.string().optional().describe('Event location'),
        notes: z.string().optional().describe('Event notes/description'),
      },
    },
    async (args) => {
      try {
        const result = await createEvent({
          calendarId: args.calendar_id,
          title: args.title,
          startTime: args.start_time,
          endTime: args.end_time,
          location: args.location,
          notes: args.notes,
        });
        return toResult(result);
      } catch (error) {
        return toErrorResult(error);
      }
    },
  );

  server.registerTool(
    'update_event',
    {
      title: 'Update Event',
      description:
        'Updates fields on an existing event. Only include the fields that are changing. Never adds attendees or sends invitations.',
      inputSchema: {
        calendar_id: z.string().describe('Calendar identifier'),
        event_id: z.string().describe('Event identifier, from list_events'),
        title: z.string().optional().describe('New title'),
        start_time: z.string().optional().describe('New ISO 8601 start time'),
        end_time: z.string().optional().describe('New ISO 8601 end time'),
        location: z.string().optional().describe('New location'),
        notes: z.string().optional().describe('New notes/description'),
      },
    },
    async (args) => {
      try {
        await updateEvent({
          calendarId: args.calendar_id,
          eventId: args.event_id,
          title: args.title,
          startTime: args.start_time,
          endTime: args.end_time,
          location: args.location,
          notes: args.notes,
        });
        return toResult({ ok: true });
      } catch (error) {
        return toErrorResult(error);
      }
    },
  );
}
```

- [ ] **Step 2: Verify it compiles**

Run: `npx tsc -p tsconfig.json --noEmit`
Expected: no errors.

- [ ] **Step 3: Commit**

```bash
git add tools/calendar.ts
git commit -m "Register the 5 calendar tools with the MCP server

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>"
```

---

### Task 10: Register reminder MCP tools

**Files:**
- Create: `tools/reminders.ts`

**Interfaces:**
- Consumes: `listReminderLists`, `listReminders`, `getReminder`, `createReminder`, `completeReminder` from `lib/caldav.ts` (Task 6).
- Produces: `registerReminderTools(server: McpServer): void` — consumed by `api/mcp.ts` in Task 11.

- [ ] **Step 1: Write `tools/reminders.ts`**

```typescript
import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import {
  completeReminder,
  createReminder,
  getReminder,
  listReminderLists,
  listReminders,
} from '../lib/caldav.js';

function toResult(data: unknown) {
  return { content: [{ type: 'text' as const, text: JSON.stringify(data, null, 2) }] };
}

function toErrorResult(error: unknown) {
  const message = error instanceof Error ? error.message : String(error);
  return { content: [{ type: 'text' as const, text: message }], isError: true };
}

export function registerReminderTools(server: McpServer): void {
  server.registerTool(
    'list_reminder_lists',
    {
      title: 'List Reminder Lists',
      description: 'Lists the account\'s reminder lists.',
      inputSchema: {},
    },
    async () => {
      try {
        return toResult(await listReminderLists());
      } catch (error) {
        return toErrorResult(error);
      }
    },
  );

  server.registerTool(
    'list_reminders',
    {
      title: 'List Reminders',
      description: 'Lists reminder summaries (title, due date, completed status) in a reminder list.',
      inputSchema: {
        list_id: z.string().describe('Reminder list identifier, from list_reminder_lists'),
        include_completed: z.boolean().optional().describe('Include completed reminders, default false'),
      },
    },
    async (args) => {
      try {
        const reminders = await listReminders({
          listId: args.list_id,
          includeCompleted: args.include_completed,
        });
        return toResult(reminders);
      } catch (error) {
        return toErrorResult(error);
      }
    },
  );

  server.registerTool(
    'get_reminder',
    {
      title: 'Get Reminder',
      description: 'Returns full details for one reminder.',
      inputSchema: {
        list_id: z.string().describe('Reminder list identifier'),
        reminder_id: z.string().describe('Reminder identifier, from list_reminders'),
      },
    },
    async (args) => {
      try {
        return toResult(await getReminder({ listId: args.list_id, reminderId: args.reminder_id }));
      } catch (error) {
        return toErrorResult(error);
      }
    },
  );

  server.registerTool(
    'create_reminder',
    {
      title: 'Create Reminder',
      description: 'Creates a new reminder in a reminder list.',
      inputSchema: {
        list_id: z.string().describe('Reminder list identifier to create the reminder in'),
        title: z.string().describe('Reminder title'),
        due_date: z.string().optional().describe('ISO 8601 due date'),
        notes: z.string().optional().describe('Reminder notes'),
      },
    },
    async (args) => {
      try {
        const result = await createReminder({
          listId: args.list_id,
          title: args.title,
          dueDate: args.due_date,
          notes: args.notes,
        });
        return toResult(result);
      } catch (error) {
        return toErrorResult(error);
      }
    },
  );

  server.registerTool(
    'complete_reminder',
    {
      title: 'Complete/Reopen Reminder',
      description: 'Sets the completed status of a reminder.',
      inputSchema: {
        list_id: z.string().describe('Reminder list identifier'),
        reminder_id: z.string().describe('Reminder identifier, from list_reminders'),
        completed: z.boolean().describe('true = mark completed, false = reopen'),
      },
    },
    async (args) => {
      try {
        await completeReminder({
          listId: args.list_id,
          reminderId: args.reminder_id,
          completed: args.completed,
        });
        return toResult({ ok: true });
      } catch (error) {
        return toErrorResult(error);
      }
    },
  );
}
```

- [ ] **Step 2: Verify it compiles**

Run: `npx tsc -p tsconfig.json --noEmit`
Expected: no errors.

- [ ] **Step 3: Commit**

```bash
git add tools/reminders.ts
git commit -m "Register the 5 reminder tools with the MCP server

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>"
```

---

### Task 11: MCP HTTP handler (`api/mcp.ts`)

**Files:**
- Create: `api/mcp.ts`

**Interfaces:**
- Consumes: `isAuthorized` from `lib/auth.ts` (Task 3); `registerMailTools` from `tools/mail.ts` (Task 8); `registerCalendarTools` from `tools/calendar.ts` (Task 9); `registerReminderTools` from `tools/reminders.ts` (Task 10).
- Produces: the deployed HTTP endpoint at `/api/mcp` — the URL added as a Claude custom connector.

- [ ] **Step 1: Write `api/mcp.ts`**

```typescript
import type { VercelRequest, VercelResponse } from '@vercel/node';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { isAuthorized } from '../lib/auth.js';
import { registerMailTools } from '../tools/mail.js';
import { registerCalendarTools } from '../tools/calendar.js';
import { registerReminderTools } from '../tools/reminders.js';

export const config = { runtime: 'nodejs' };

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (!isAuthorized(req.headers.authorization)) {
    res.status(401).json({ error: 'Unauthorized' });
    return;
  }

  const server = new McpServer({ name: 'icloud-mcp', version: '1.0.0' });
  registerMailTools(server);
  registerCalendarTools(server);
  registerReminderTools(server);

  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });

  res.on('close', () => {
    void transport.close();
    void server.close();
  });

  await server.connect(transport);
  await transport.handleRequest(req, res, req.body);
}
```

- [ ] **Step 2: Verify it compiles**

Run: `npx tsc -p tsconfig.json --noEmit`
Expected: no errors. If `StreamableHTTPServerTransport`'s constructor or `handleRequest` signature differs from this in the pinned SDK version, that's an SDK API surface to report rather than guess around — check the installed version's type declarations in `node_modules/@modelcontextprotocol/sdk` and flag any mismatch before changing the approach.

- [ ] **Step 3: Local end-to-end check with `vercel dev`**

Run: `npx vercel dev` (first run will prompt to link/create a Vercel project — accept the defaults, scoped to the user's account)

In a separate terminal, with the local `.env` values loaded and a real `MCP_AUTH_TOKEN` set:

Run:
```bash
curl -s -X POST http://localhost:3000/api/mcp \
  -H "Authorization: Bearer $MCP_AUTH_TOKEN" \
  -H "Content-Type: application/json" \
  -H "Accept: application/json, text/event-stream" \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/list"}'
```
Expected: a JSON-RPC response listing all 16 registered tools by name.

Run the same request with an intentionally wrong bearer token.
Expected: HTTP 401.

- [ ] **Step 4: Commit**

```bash
git add api/mcp.ts
git commit -m "Wire up the MCP HTTP handler with auth and all 16 tools

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>"
```

---

### Task 12: README

**Files:**
- Create: `README.md`

**Interfaces:**
- Consumes: nothing (documentation only).
- Produces: the deliverable README covering setup, credential generation, connector setup, and tool descriptions.

- [ ] **Step 1: Write `README.md`**

```markdown
# icloud-mcp

A remote MCP server exposing iCloud Mail, Calendar, and Reminders as tools for Claude — built for use with Claude Cowork scheduled tasks. Self-hosted on Vercel, using your own iCloud account and Claude subscription. No LLM calls happen inside this server; it only provides read/write tools.

## Setup

### 1. Generate an iCloud app-specific password

1. Sign in at [appleid.apple.com](https://appleid.apple.com).
2. Under **Sign-In and Security**, choose **App-Specific Passwords**.
3. Generate a new one and label it (e.g. "icloud-mcp"). Copy it — you won't see it again.

This password is used for both mail (IMAP) and calendar/reminders (CalDAV). Do not use your main Apple ID password.

### 2. Set environment variables

In the Vercel dashboard, under Project Settings → Environment Variables, set:

| Variable | Description |
|---|---|
| `ICLOUD_EMAIL` | Your iCloud email address |
| `ICLOUD_APP_PASSWORD` | The app-specific password from step 1 |
| `MCP_AUTH_TOKEN` | A shared secret this server requires in the `Authorization: Bearer` header. Generate one with `node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"` |

See `.env.example` for local development — copy it to `.env` and fill in real values (never commit `.env`).

### 3. Deploy

```bash
npm install
npx vercel deploy --prod
```

Note the deployed URL, e.g. `https://icloud-mcp-yourname.vercel.app`. The MCP endpoint is at `/api/mcp`.

### 4. Add as a Claude custom connector

In Claude's connector settings, add a custom connector pointing at `https://<your-deployment>/api/mcp`, with the `MCP_AUTH_TOKEN` value as the bearer token. Test each tool manually before wiring up a scheduled task.

## Local testing

Before deploying, verify each protocol independently:

```bash
npm run test:imap    # exercises lib/imap.ts against real IMAP
npm run test:caldav  # exercises lib/caldav.ts against real CalDAV
```

Both read from a local `.env` file and print what they find. Run them separately so a connection problem in one protocol doesn't get confused with the other.

## Tools

### Mail (IMAP)

| Tool | Description |
|---|---|
| `list_folders` | List all mail folders |
| `list_messages` | List message headers in a folder (subject, sender, date, unread, UID) |
| `get_message` | Get full headers and body for one message (HTML converted to plain text) |
| `mark_message` | Mark a message read/unread |
| `move_message` | Move a message to another folder |
| `flag_message` | Flag/unflag a message |

### Calendar (CalDAV)

| Tool | Description |
|---|---|
| `list_calendars` | List event calendars |
| `list_events` | List events in a calendar within a date range |
| `get_event` | Get full details for one event |
| `create_event` | Create a personal event (no attendees, no invitations) |
| `update_event` | Update fields on an existing event (no attendees, no invitations) |

### Reminders (CalDAV/VTODO)

| Tool | Description |
|---|---|
| `list_reminder_lists` | List reminder lists |
| `list_reminders` | List reminders in a list (title, due date, completed) |
| `get_reminder` | Get full details for one reminder |
| `create_reminder` | Create a reminder |
| `complete_reminder` | Mark a reminder completed or reopen it |

## v1 scope

Deliberately out of scope: sending mail, permanently deleting mail/emptying trash, calendar invitations or attendees, deleting events or reminders. Reminders reflect iCloud's legacy CalDAV/VTODO data model, not everything the current Reminders app supports — this is an Apple platform limitation.
```

- [ ] **Step 2: Commit**

```bash
git add README.md
git commit -m "Add README covering setup, credentials, and tool reference

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>"
```

---

### Task 13: Deploy and verify

**Files:** none (deployment/verification only).

**Interfaces:**
- Consumes: the full deployed project from Tasks 1–12.
- Produces: a live, stable HTTPS URL — the final deliverable.

- [ ] **Step 1: Push to GitHub**

Run: `git push -u origin main`
Expected: pushes all commits from Tasks 1–12 to `github.com/ireves/icloud-mcp`.

- [ ] **Step 2: Deploy to Vercel**

Run: `npx vercel link` (link to a new or existing Vercel project connected to the GitHub repo), then set the three environment variables in the Vercel dashboard as described in the README, then:

Run: `npx vercel deploy --prod`
Expected: a stable production URL is printed, e.g. `https://icloud-mcp-yourname.vercel.app`.

- [ ] **Step 3: Verify the deployed endpoint**

Run:
```bash
curl -s -X POST https://<your-deployment>/api/mcp \
  -H "Authorization: Bearer $MCP_AUTH_TOKEN" \
  -H "Content-Type: application/json" \
  -H "Accept: application/json, text/event-stream" \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/list"}'
```
Expected: JSON-RPC response listing all 16 tools, same as the local `vercel dev` check in Task 11.

- [ ] **Step 4: Hand off for manual connector testing**

Report the deployed URL to the user. Per the spec, the user adds it as a Claude custom connector and manually tests each of the 16 tools before setting up any scheduled task — this step is theirs, not part of this plan's automated work.
```
