import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { registerMailTools } from '../../tools/mail.js';
import { registerCalendarTools } from '../../tools/calendar.js';
import { registerReminderTools } from '../../tools/reminders.js';
import { toErrorResult, toResult } from '../../tools/result.js';
import * as schemas from '../../tools/schemas.js';
import type {
  CalendarInfo,
  EventDetail,
  EventSummary,
  MailboxInfo,
  MessageDetail,
  MessageSummary,
  ReminderDetail,
  ReminderListInfo,
  ReminderSummary,
} from '../../lib/types.js';
import type { MoveOperationRecord } from '../../lib/moveLog.js';

function registeredTools(): Record<string, { outputSchema?: unknown }> {
  const server = new McpServer({ name: 'icloud-mcp', version: 'test' });
  registerMailTools(server);
  registerCalendarTools(server);
  registerReminderTools(server);
  return (server as unknown as { _registeredTools: Record<string, { outputSchema?: unknown }> })
    ._registeredTools;
}

describe('every tool declares an output schema', () => {
  it('leaves none without one', () => {
    const missing = Object.entries(registeredTools())
      .filter(([, tool]) => !tool.outputSchema)
      .map(([name]) => name);
    expect(missing).toEqual([]);
  });

  it('registers the full set of tools', () => {
    expect(Object.keys(registeredTools())).toHaveLength(22);
  });
});

describe('result helper', () => {
  it('sends the same value as structured content and as JSON text', () => {
    const result = toResult({ ok: true });
    expect(result.structuredContent).toEqual({ ok: true });
    expect(JSON.parse(result.content[0].text)).toEqual({ ok: true });
  });

  it('leaves an error result unstructured, so the schema never applies to it', () => {
    const result = toErrorResult(new Error('refused'));
    expect(result).toEqual({
      content: [{ type: 'text', text: 'refused' }],
      isError: true,
    });
    expect('structuredContent' in result).toBe(false);
  });
});

/**
 * Each payload below is typed as the real return type, so TypeScript fails the
 * build if the library's shape changes. Parsing it through the declared schema
 * then proves the schema matches that shape, which is what stops a tool
 * returning something the server would reject.
 */
describe('declared schemas accept what the tools actually return', () => {
  const mailbox: MailboxInfo = { path: 'INBOX', name: 'INBOX', flags: ['\\HasNoChildren'] };
  const summary: MessageSummary = {
    uid: 33605,
    subject: 'Hello',
    from: 'someone@example.com',
    date: '2026-09-18T00:00:00.000Z',
    unread: true,
  };
  const detail: MessageDetail = { ...summary, to: 'me@icloud.com', body: 'Body text.' };
  const operation: MoveOperationRecord = {
    id: 'aaaaaaaa-0000-4000-8000-000000000001',
    status: 'confirmed',
    sourcePath: 'INBOX',
    sourceUid: 1,
    sourceUidValidity: '1000',
    destPath: 'INBOX.Archive',
    destUid: 99,
    destUidValidity: '2000',
    identity: { messageId: '<a@b>', date: null, subject: 'Hello' },
    createdAt: 1758000000000,
    confirmedAt: 1758000001000,
    error: null,
    undoOf: null,
    undoneBy: null,
  };
  const calendar: CalendarInfo = { id: 'cal-1', name: 'Personal' };
  const event: EventSummary = {
    id: 'evt-1',
    title: 'Dentist',
    start: '2026-09-20T09:00:00.000Z',
    end: '2026-09-20T09:30:00.000Z',
    hasAttendees: false,
    isRecurring: false,
  };
  const eventDetail: EventDetail = { ...event, notes: 'Bring the form.' };
  const reminderList: ReminderListInfo = { id: 'list-1', name: 'Errands' };
  const reminder: ReminderSummary = { id: 'rem-1', title: 'Post the letter', completed: false };
  const reminderDetail: ReminderDetail = { ...reminder, notes: 'Second class is fine.' };

  const cases: Array<[string, z.ZodRawShape, unknown]> = [
    ['list_folders', schemas.listFoldersOutput, { folders: [mailbox] }],
    [
      'list_exceptions',
      schemas.listExceptionsOutput,
      {
        exceptions: [
          { sender: 'a@b.com', action: 'keep_in_inbox' },
          {
            sender: 'c@d.com',
            action: 'move_to_folder',
            destination_folder: 'Receipts',
            notes: 'wrapped text',
            timing: 'wrapped text',
          },
        ],
      },
    ],
    ['list_messages (with more to come)', schemas.listMessagesOutput, { messages: [summary], next_cursor: 33600 }],
    ['list_messages (last page)', schemas.listMessagesOutput, { messages: [summary] }],
    ['mark_scanned', schemas.markScannedOutput, { last_seen_uid: 33536 }],
    ['reconcile_flagged', schemas.reconcileFlaggedOutput, { newly_unflagged: [summary] }],
    ['reconcile_flagged (nothing changed)', schemas.reconcileFlaggedOutput, { newly_unflagged: [] }],
    ['get_message', schemas.getMessageOutput, detail],
    ['mark_message', schemas.okOutput, { ok: true }],
    ['flag_message', schemas.okOutput, { ok: true }],
    [
      'move_message (moved)',
      schemas.moveMessageOutput,
      { ok: true, operation_id: 'op-1', undoable_for_days: 7 },
    ],
    ['move_message (same folder)', schemas.moveMessageOutput, { ok: true, note: 'no move was performed.' }],
    ['undo_move', schemas.undoMoveOutput, { ok: true, operation_id: 'op-2' }],
    [
      'list_move_operations',
      schemas.listMoveOperationsOutput,
      { operations: [operation], next_cursor: 20 },
    ],
    [
      'list_move_operations (last page)',
      schemas.listMoveOperationsOutput,
      { operations: [], next_cursor: null },
    ],
    ['get_move_operation', schemas.getMoveOperationOutput, operation],
    ['list_calendars', schemas.listCalendarsOutput, { calendars: [calendar] }],
    ['list_events', schemas.listEventsOutput, { events: [event] }],
    ['get_event', schemas.getEventOutput, eventDetail],
    ['create_event', schemas.createdIdOutput, { id: 'evt-2' }],
    ['update_event', schemas.okOutput, { ok: true }],
    ['list_reminder_lists', schemas.listReminderListsOutput, { lists: [reminderList] }],
    ['list_reminders', schemas.listRemindersOutput, { reminders: [reminder] }],
    ['get_reminder', schemas.getReminderOutput, reminderDetail],
    ['create_reminder', schemas.createdIdOutput, { id: 'rem-2' }],
    ['complete_reminder', schemas.okOutput, { ok: true }],
  ];

  it.each(cases)('%s', (_name, shape, payload) => {
    const parsed = z.object(shape).safeParse(payload);
    expect(parsed.success ? null : parsed.error.issues).toBeNull();
  });
});

describe('schemas reject a result that has drifted', () => {
  it('refuses a message summary missing its UID', () => {
    const { uid: _uid, ...withoutUid } = {
      uid: 1,
      subject: 's',
      from: 'f',
      date: 'd',
      unread: false,
    };
    expect(z.object(schemas.listMessagesOutput).safeParse({ messages: [withoutUid] }).success).toBe(
      false,
    );
  });

  it('refuses a bare list where a named field is required', () => {
    expect(z.object(schemas.listFoldersOutput).safeParse([]).success).toBe(false);
  });

  it('refuses an unknown move status', () => {
    expect(
      z.object(schemas.getMoveOperationOutput).safeParse({ status: 'nonsense' }).success,
    ).toBe(false);
  });
});
