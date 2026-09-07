# Trash/Junk mailbox destination policy — Design (Phase B)

## Purpose

The second security/code review of `icloud-mcp` found that `move_message` performs no destination validation at all — an agent (or a bug) could move any message into Trash or Junk with no server-side guard, relying only on tool descriptions and prompt-level agent instructions, which are not a real safety boundary. This is Phase B of the four-phase response (A: calendar correctness, done; B: this spec; C: durable undo; D: read-only mode/rate limiting).

Scope: `lib/imap.ts` (`moveMessage` and a new shared policy function), `tools/mail.ts` (description update), tests. No new infrastructure — this uses IMAP metadata already available via `client.list()`.

## Resolving mailboxes and detecting prohibited destinations

`moveMessage` currently calls `client.messageMove(uid, targetFolder, { uid: true })` directly, with `targetFolder` taken as a raw string from the tool caller — no check that it exists, no check what kind of folder it is.

The fix fetches the real mailbox list first and resolves both `folder` (source) and `targetFolder` against it. `assertMoveAllowed` only needs a folder's path and special-use flag, so it takes a minimal local shape rather than `imapflow`'s full `ListResponse` — easier to construct in tests, and `client.list()`'s results already satisfy it structurally:

```typescript
export interface MailboxListEntry {
  path: string;
  specialUse?: string;
}

function resolveMailbox(mailboxes: MailboxListEntry[], path: string): MailboxListEntry | null {
  return mailboxes.find((m) => m.path === path) ?? null;
}
```

An unresolvable target (no mailbox with that exact path) is a hard error before any IMAP mutation — not a best-effort attempt that might fail cryptically or (on some servers) auto-create the folder.

A resolved mailbox is **prohibited** if its `specialUse` (from IMAP's `SPECIAL-USE` extension, RFC 6154 — `imapflow`'s `list()` already surfaces this as `specialUse`, and `listFolders()` already exposes it) is `\Trash` or `\Junk`. This is the primary signal and is locale-proof: iCloud reports the correct special-use flag regardless of the folder's display name or the account's language.

**Fallback for missing special-use metadata:** only when `specialUse` is absent on a candidate folder, fall back to an **exact-name** match (never substring) against a small allowlist of iCloud's known default folder names:

```typescript
const TRASH_JUNK_NAME_FALLBACK = new Set([
  'Trash', 'Deleted Messages', 'Papierkorb', 'Corbeille',
  'Junk', 'Junk E-mail', 'Indésirables',
]);
```

Exact-match-only is deliberate: a substring rule (`name.includes('Junk')`) would wrongly block an ordinary folder like "Junk Research". This list is intentionally short and iCloud-specific — it exists only as a safety net for the case where iCloud's server doesn't report special-use for some account (uncommon but not guaranteed), not as a general multi-provider folder-name database.

## Policy

```typescript
export interface MoveMessageParams {
  folder: string;
  uid: number;
  targetFolder: string;
}

export async function moveMessage(params: MoveMessageParams): Promise<void> {
  const client = getClient();
  await client.connect();
  try {
    const mailboxes = await client.list();
    assertMoveAllowed(mailboxes, params.folder, params.targetFolder);
    if (params.folder === params.targetFolder) {
      return; // explicit no-op — no IMAP mutation needed
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

`assertMoveAllowed` is exported so Phase C's `undo_move` can call the identical check — the policy exists in exactly one place.

```typescript
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

No tool parameter can bypass this — `move_message`'s input schema gains no new field. The only override is the operator-controlled `ALLOW_TRASH_JUNK_MOVES` environment variable, unset (blocking) by default, which the agent has no path to read or set.

## Testing

Extends the Vitest suite from Phase A. `lib/imap.ts` currently has no tests (Phase A only covered `lib/caldav.ts`) — this phase adds the first ones, mocking `imapflow`'s `ImapFlow` class the same way Phase A mocked `tsdav`.

Covered: a folder with `specialUse: '\Trash'` is blocked; a folder with `specialUse: '\Junk'` is blocked; a folder with no special-use metadata but named exactly `Junk E-mail` is blocked via fallback; a folder named `Junk Research` with no special-use metadata is **not** blocked (the substring-safety case); an unresolvable target path is rejected before any `messageMove` call; a move from `\Trash` to `INBOX` (recovery) succeeds; a move where source equals target is a no-op (`messageMove` never called); `ALLOW_TRASH_JUNK_MOVES=true` permits an otherwise-blocked move.

## Out of scope for this phase

Durable undo (Phase C) and read-only mode/rate limiting (Phase D) are specified separately. This phase only adds the destination check inside `moveMessage` itself and exports it for reuse.
