import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import {
  flagMessage,
  getMessage,
  getMoveOperation,
  listFolders,
  listMessages,
  listMoveOperations,
  markMessage,
  moveMessage,
  undoMove,
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
        'Lists message headers (subject, sender, date, unread status, UID) in a folder — not full bodies. Use get_message for a full body. Returns next_cursor when more messages remain; pass it as before_uid to page further back.',
      inputSchema: {
        folder: z.string().describe('Folder path, e.g. "INBOX"'),
        limit: z.number().int().positive().max(200).optional().describe('Max messages to return, default 25'),
        unread_only: z.boolean().optional().describe('Only return unread messages'),
        since_date: z.string().optional().describe('ISO 8601 date; only messages on or after this date'),
        from_address: z.string().optional().describe('Only messages from this sender address'),
        before_uid: z.number().int().positive().optional().describe("Pagination cursor from a previous call's next_cursor; returns messages older than this UID"),
      },
    },
    async (args) => {
      try {
        const result = await listMessages({
          folder: args.folder,
          limit: args.limit,
          unreadOnly: args.unread_only,
          sinceDate: args.since_date,
          fromAddress: args.from_address,
          beforeUid: args.before_uid,
        });
        return toResult({ messages: result.messages, next_cursor: result.nextCursor });
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
        'Moves a message from one folder to another. Moving into Trash or Junk is blocked by default and enforced by the server (not by this description) — there is no parameter to override it. Moving a message out of Trash or Junk is always allowed. On success, returns an operation_id that can be passed to undo_move within 7 days to reverse the move.',
      inputSchema: {
        folder: z.string().describe('Current folder path'),
        uid: z.number().int().describe('Message UID'),
        target_folder: z.string().describe('Destination folder path'),
      },
    },
    async (args) => {
      try {
        const { operationId } = await moveMessage({
          folder: args.folder,
          uid: args.uid,
          targetFolder: args.target_folder,
        });
        return toResult(
          operationId
            ? { ok: true, operation_id: operationId, undoable_for_days: 7 }
            : { ok: true, note: 'Source and destination were the same folder; no move was performed.' },
        );
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

  server.registerTool(
    'undo_move',
    {
      title: 'Undo Message Move',
      description:
        "Reverses a previous move_message operation, using its operation_id. Verifies the destination folder's UIDVALIDITY and the message's identity before moving anything back, and applies the same Trash/Junk destination policy as move_message in reverse. Operations remain undoable for 7 days. An uncertain operation (the original move could not be confirmed) is automatically reconciled where possible before undoing.",
      inputSchema: {
        operation_id: z.string().describe('The operation_id returned by move_message or a previous undo_move'),
      },
    },
    async (args) => {
      try {
        const { newOperationId } = await undoMove(args.operation_id);
        return toResult({ ok: true, operation_id: newOperationId });
      } catch (error) {
        return toErrorResult(error);
      }
    },
  );

  server.registerTool(
    'list_move_operations',
    {
      title: 'List Move Operations',
      description:
        'Lists recent move_message operations, most recent first, including their status (pending, confirmed, failed, uncertain, or undone). Use with undo_move to reverse a move, or get_move_operation to inspect one in detail.',
      inputSchema: {
        limit: z.number().int().positive().max(100).optional().describe('Max operations to return, default 20'),
        cursor: z.number().int().nonnegative().optional().describe("Pagination cursor from a previous call's next_cursor"),
      },
    },
    async (args) => {
      try {
        const result = await listMoveOperations({ limit: args.limit, cursor: args.cursor });
        return toResult({ operations: result.operations, next_cursor: result.nextCursor });
      } catch (error) {
        return toErrorResult(error);
      }
    },
  );

  server.registerTool(
    'get_move_operation',
    {
      title: 'Get Move Operation',
      description: 'Returns the full record for one move_message operation by its operation_id.',
      inputSchema: {
        operation_id: z.string().describe('The operation_id to look up'),
      },
    },
    async (args) => {
      try {
        const record = await getMoveOperation(args.operation_id);
        if (!record) {
          return toErrorResult(new Error(`Move operation ${args.operation_id} not found or has expired.`));
        }
        return toResult(record);
      } catch (error) {
        return toErrorResult(error);
      }
    },
  );
}
