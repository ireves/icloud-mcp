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
