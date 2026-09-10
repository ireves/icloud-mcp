import { ImapFlow } from 'imapflow';
import { simpleParser } from 'mailparser';
import { convert } from 'html-to-text';
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
  // No separate "recovery" exception is needed here: a recovery move (out of
  // Trash/Junk into an ordinary folder) already returns above, since its
  // target isn't prohibited. Reaching this point means the target itself is
  // Trash or Junk, regardless of where the message is coming from — including
  // a Trash-to-Junk move, which is not a recovery and must stay blocked.
  if (process.env.ALLOW_TRASH_JUNK_MOVES === 'true') return; // explicit operator override
  throw new Error(
    `Moving messages into "${targetPath}" is blocked by default because it is a Trash or Junk folder. ` +
      `This restriction is enforced by the server, not the agent, and has no per-call override. ` +
      `An operator can lift it by setting ALLOW_TRASH_JUNK_MOVES=true in the deployment's environment.`,
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

async function extractBody(source: Buffer | undefined): Promise<string> {
  if (!source) return '';
  const parsed = await simpleParser(source);
  let body: string;
  if (parsed.text) {
    body = parsed.text;
  } else if (parsed.html) {
    body = convert(parsed.html, { wordwrap: 100 });
  } else {
    return '';
  }
  if (body.length > MAX_BODY_CHARS) {
    return `${body.slice(0, MAX_BODY_CHARS)}\n\n[... truncated, message body exceeds ${MAX_BODY_CHARS} characters]`;
  }
  return body;
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
  beforeUid?: number;
}

export interface ListMessagesResult {
  messages: MessageSummary[];
  nextCursor?: number;
}

export async function listMessages(params: ListMessagesParams): Promise<ListMessagesResult> {
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

      let uids = await client.search(query, { uid: true });
      if (!uids || uids.length === 0) return { messages: [] };

      if (params.beforeUid !== undefined) {
        uids = uids.filter((uid) => uid < params.beforeUid!);
      }
      if (uids.length === 0) return { messages: [] };

      const limit = params.limit ?? 25;
      const hasMore = uids.length > limit;
      const limited = uids.slice(-limit).reverse();
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
      results.sort((a, b) => b.uid - a.uid);
      const nextCursor = hasMore ? results[results.length - 1]?.uid : undefined;
      return { messages: results, nextCursor };
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
      date: envelope?.date ? envelope.date.toISOString() : null,
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
        date: destMeta.envelope?.date ? destMeta.envelope.date.toISOString() : null,
        subject: destMeta.envelope?.subject ?? null,
      };
      if (!identityMatches(liveIdentity, effectiveRecord.identity)) {
        throw new Error(
          `Cannot undo move operation ${operationId}: the message at the recorded destination UID no longer matches what was originally moved.`,
        );
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
