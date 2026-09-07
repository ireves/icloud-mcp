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
        'Returns full headers and body for one message. HTML-only messages are converted to readable plain text. Rejects messages over 10MB, and truncates very long bodies.',
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
      description:
        'Moves a message from one folder to another. Moving into Trash or Junk is blocked by default and enforced by the server (not by this description) — there is no parameter to override it. Moving a message out of Trash or Junk is always allowed.',
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
