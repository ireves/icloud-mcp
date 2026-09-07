# Trash/Junk Mailbox Destination Policy Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a server-enforced destination check to `move_message` that blocks moves into Trash/Junk by default, allows recovery moves out of them, resolves destinations against the real mailbox list, and exposes no agent-facing bypass.

**Architecture:** A pure, exported `assertMoveAllowed` function in `lib/imap.ts` takes the real mailbox list (from `client.list()`) plus source/target paths and throws on a disallowed move; `moveMessage` calls it before any IMAP mutation. The only override is an operator-controlled environment variable, never a tool parameter.

**Tech Stack:** TypeScript, `imapflow` (mocked in tests), Vitest (already added in Phase A).

## Global Constraints

- No live iCloud access in tests — mocked `imapflow` client and synthetic mailbox-list fixtures only (spec: Testing).
- Special-use IMAP metadata (`\Trash`, `\Junk`) is the primary detection signal; exact-name fallback only when special-use is absent (spec: Fallback for missing special-use metadata).
- Fallback name matching is exact, never substring — "Junk Research" must never be blocked (spec: Fallback for missing special-use metadata).
- An unresolvable target folder is a hard error before any IMAP mutation (spec: Resolving mailboxes).
- No tool-level parameter can bypass the block; the only override is the `ALLOW_TRASH_JUNK_MOVES` environment variable, unset (blocking) by default (spec: Policy).
- Recovery moves (source is Trash/Junk, target isn't) are always allowed (spec: Policy).
- A move where source equals target is an explicit no-op — no IMAP mutation (spec: Policy).
- `assertMoveAllowed` is exported for reuse by Phase C's `undo_move` (spec: Policy).
- Preserve all fixes already on `main` from the previous rounds (message size limits, scheduling-object rejection, reminder VTODO filter, all Phase A calendar fixes) — this plan only touches `moveMessage` and its new policy helper.
- British English in documentation and user-facing tool description text.

---

## File Structure

```
lib/imap.ts                  # modified — MailboxListEntry, resolveMailbox,
                              # isProhibitedDestination, assertMoveAllowed,
                              # rewritten moveMessage
tools/mail.ts                 # modified — move_message description only
.env.example                  # modified — document ALLOW_TRASH_JUNK_MOVES
README.md                     # modified — document the restriction
test/
  lib/
    imap-policy.test.ts        # new — pure unit tests for assertMoveAllowed
    imap-mock-client.ts        # new — mocked ImapFlow factory
    imap.test.ts                # new — moveMessage integration tests
```

---

### Task 1: `assertMoveAllowed` and its pure unit tests

**Files:**
- Modify: `lib/imap.ts` (add types and functions; no change to `moveMessage` yet)
- Create: `test/lib/imap-policy.test.ts`

**Interfaces:**
- Produces: `export interface MailboxListEntry { path: string; name: string; specialUse?: string }`; `export function assertMoveAllowed(mailboxes: MailboxListEntry[], sourcePath: string, targetPath: string): void`. Consumed by `moveMessage` in Task 2, and (in Phase C, not this plan) by `undo_move`.

- [ ] **Step 1: Write the failing tests**

```typescript
// test/lib/imap-policy.test.ts
import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { assertMoveAllowed, type MailboxListEntry } from '../../lib/imap.js';

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
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run test/lib/imap-policy.test.ts`
Expected: FAIL — `assertMoveAllowed` is not exported yet.

- [ ] **Step 3: Add the types and functions to `lib/imap.ts`**

Add near the top of `lib/imap.ts`, after `requireEnv`:

```typescript
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
  if (!isProhibitedDestination(target)) return;
  const source = resolveMailbox(mailboxes, sourcePath);
  if (source && isProhibitedDestination(source)) return; // recovery move: allowed
  if (process.env.ALLOW_TRASH_JUNK_MOVES === 'true') return; // explicit operator override
  throw new Error(
    `Moving messages into "${targetPath}" is blocked by default because it is a Trash or Junk folder. ` +
      `This restriction is enforced by the server, not the agent, and has no per-call override. ` +
      `An operator can lift it by setting ALLOW_TRASH_JUNK_MOVES=true in the deployment's environment.`,
  );
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `npx vitest run test/lib/imap-policy.test.ts`
Expected: PASS, all 12 cases.

- [ ] **Step 5: Typecheck**

Run: `npx tsc -p tsconfig.json --noEmit`
Expected: no errors.

- [ ] **Step 6: Commit**

```bash
git add lib/imap.ts test/lib/imap-policy.test.ts
git commit -m "Add assertMoveAllowed: block Trash/Junk destinations by default

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>"
```

---

### Task 2: Wire `assertMoveAllowed` into `moveMessage`, with integration tests

**Files:**
- Modify: `lib/imap.ts` (rewrite `moveMessage`)
- Create: `test/lib/imap-mock-client.ts`
- Create: `test/lib/imap.test.ts`

**Interfaces:**
- Consumes: `assertMoveAllowed` (Task 1).
- Produces: `moveMessage(params: MoveMessageParams): Promise<void>` — same exported signature, now validates before mutating. No change to `MoveMessageParams`.

- [ ] **Step 1: Write `test/lib/imap-mock-client.ts`**

```typescript
import { vi } from 'vitest';

export function createMockImapClient() {
  return {
    connect: vi.fn(),
    logout: vi.fn(),
    list: vi.fn(),
    getMailboxLock: vi.fn(async () => ({ release: vi.fn() })),
    messageMove: vi.fn(),
  };
}

export type MockImapClient = ReturnType<typeof createMockImapClient>;
```

- [ ] **Step 2: Write the failing tests**

```typescript
// test/lib/imap.test.ts
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mockClient = vi.hoisted(() => ({
  connect: vi.fn(),
  logout: vi.fn(),
  list: vi.fn(),
  getMailboxLock: vi.fn(async () => ({ release: vi.fn() })),
  messageMove: vi.fn(),
}));

vi.mock('imapflow', () => ({
  ImapFlow: vi.fn().mockImplementation(() => mockClient),
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
```

- [ ] **Step 3: Run to verify it fails**

Run: `npx vitest run test/lib/imap.test.ts`
Expected: FAIL — current `moveMessage` never calls `client.list()` and has no policy check, so the block/no-op/unresolvable-folder cases don't behave as expected (some may pass accidentally, e.g. the ordinary-folder move, but the blocking and no-op cases fail).

- [ ] **Step 4: Rewrite `moveMessage` in `lib/imap.ts`**

Find the existing `moveMessage` function and replace its body:

```typescript
export async function moveMessage(params: MoveMessageParams): Promise<void> {
  const client = getClient();
  await client.connect();
  try {
    const mailboxes = await client.list();
    assertMoveAllowed(mailboxes, params.folder, params.targetFolder);
    if (params.folder === params.targetFolder) {
      return; // explicit no-op
    }
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
```

- [ ] **Step 5: Run to verify it passes**

Run: `npx vitest run test/lib/imap.test.ts`
Expected: PASS, all 8 cases.

- [ ] **Step 6: Typecheck and run the full suite**

Run: `npx tsc -p tsconfig.json --noEmit && npx vitest run`
Expected: no type errors; every test file (Phase A's two plus this task's two) passes.

- [ ] **Step 7: Commit**

```bash
git add lib/imap.ts test/lib/imap-mock-client.ts test/lib/imap.test.ts
git commit -m "Wire Trash/Junk destination policy into move_message

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>"
```

---

### Task 3: Documentation — tool description, README, `.env.example`

**Files:**
- Modify: `tools/mail.ts`
- Modify: `README.md`
- Modify: `.env.example`

**Interfaces:**
- Consumes: nothing new (text-only changes).
- Produces: nothing consumed by later tasks — last task in this plan.

- [ ] **Step 1: Update `move_message`'s description in `tools/mail.ts`**

Find the `move_message` tool registration and update its `description`:

```typescript
description:
  'Moves a message from one folder to another. Moving into Trash or Junk is blocked by default and enforced by the server (not by this description) — there is no parameter to override it. Moving a message out of Trash or Junk is always allowed.',
```

- [ ] **Step 2: Typecheck**

Run: `npx tsc -p tsconfig.json --noEmit`
Expected: no errors.

- [ ] **Step 3: Update `.env.example`**

Add, after the existing `MCP_AUTH_TOKEN` entry:

```bash
# Optional. When unset (the default), moving a message into a Trash or Junk
# folder is blocked by the server regardless of what the agent requests.
# Set to the exact string "true" to lift this restriction. There is no
# per-call override — this is an operator-only setting.
ALLOW_TRASH_JUNK_MOVES=
```

- [ ] **Step 4: Update README**

In `README.md`, find the `move_message` row in the Mail (IMAP) tools table and update its description cell to: `Move a message to another folder (moves into Trash/Junk are blocked by default, server-enforced)`.

Add a new subsection after the "Tools" section, before "v1 scope":

```markdown
## Mailbox safety

`move_message` blocks moves into any folder whose IMAP special-use metadata (or, as a fallback, exact folder name) identifies it as Trash or Junk. This is enforced in the server itself — there is no tool parameter that can override it, and no combination of agent instructions changes it. Moving a message *out of* Trash or Junk (recovery) is always allowed.

To lift the restriction, an operator (not the agent) sets `ALLOW_TRASH_JUNK_MOVES=true` in the deployment's environment variables. Leave it unset for the default, safer behaviour.
```

- [ ] **Step 5: Run the full test suite one more time**

Run: `npx vitest run`
Expected: PASS, all tests across every test file.

- [ ] **Step 6: Commit**

```bash
git add tools/mail.ts .env.example README.md
git commit -m "Document Trash/Junk move policy and ALLOW_TRASH_JUNK_MOVES

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>"
```
