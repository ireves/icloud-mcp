import { z } from 'zod';

/**
 * Output schemas for every tool. Each one describes exactly what its tool
 * returns: the server validates a successful result against it before the
 * result leaves, so a shape that drifts from its schema fails loudly here
 * rather than quietly confusing whatever is reading it.
 *
 * Shapes are exported so the tests can check them against payloads typed as
 * the real return types, which is what keeps these in step with the library.
 */

// ---------------------------------------------------------------- mail

export const mailboxInfoSchema = z.object({
  path: z.string(),
  name: z.string(),
  flags: z.array(z.string()),
  specialUse: z.string().optional(),
});

export const messageSummarySchema = z.object({
  uid: z.number().int(),
  subject: z.string(),
  from: z.string(),
  date: z.string(),
  unread: z.boolean(),
});

export const messageDetailSchema = messageSummarySchema.extend({
  to: z.string(),
  body: z.string(),
});

export const moveOperationSchema = z.object({
  id: z.string(),
  status: z.enum(['pending', 'confirmed', 'failed', 'uncertain', 'undone']),
  sourcePath: z.string(),
  sourceUid: z.number().int(),
  sourceUidValidity: z.string(),
  destPath: z.string(),
  destUid: z.number().int().nullable(),
  destUidValidity: z.string().nullable(),
  identity: z.object({
    messageId: z.string().nullable(),
    date: z.string().nullable(),
    subject: z.string().nullable(),
  }),
  createdAt: z.number(),
  confirmedAt: z.number().nullable(),
  error: z.string().nullable(),
  undoOf: z.string().nullable(),
  undoneBy: z.string().nullable(),
});

export const listFoldersOutput = { folders: z.array(mailboxInfoSchema) };

export const listExceptionsOutput = {
  exceptions: z.array(
    z.object({
      sender: z.string(),
      action: z.enum(['keep_in_inbox', 'move_to_folder']),
      destination_folder: z.string().optional(),
      notes: z.string().optional(),
      timing: z.string().optional(),
    }),
  ),
};

export const listMessagesOutput = {
  messages: z.array(messageSummarySchema),
  next_cursor: z.number().int().optional(),
};

export const markScannedOutput = { last_seen_uid: z.number().int() };

export const reconcileFlaggedOutput = { newly_unflagged: z.array(messageSummarySchema) };

export const getMessageOutput = messageDetailSchema.shape;

export const okOutput = { ok: z.literal(true) };

export const moveMessageOutput = {
  ok: z.literal(true),
  operation_id: z.string().optional(),
  undoable_for_days: z.number().int().optional(),
  // Present instead of an operation when the source and destination matched
  // and nothing was moved.
  note: z.string().optional(),
};

export const saveDraftOutput = {
  ok: z.literal(true),
  folder: z.string(),
  // Absent when the server does not report the new message's UID.
  uid: z.number().int().optional(),
};

export const undoMoveOutput = { ok: z.literal(true), operation_id: z.string() };

export const listMoveOperationsOutput = {
  operations: z.array(moveOperationSchema),
  next_cursor: z.number().int().nullable(),
};

export const getMoveOperationOutput = moveOperationSchema.shape;

// ------------------------------------------------------------ calendar

export const calendarInfoSchema = z.object({
  id: z.string(),
  name: z.string(),
  color: z.string().optional(),
});

export const eventSummarySchema = z.object({
  id: z.string(),
  title: z.string(),
  start: z.string(),
  end: z.string(),
  location: z.string().optional(),
  hasAttendees: z.boolean(),
  isRecurring: z.boolean(),
});

export const eventDetailSchema = eventSummarySchema.extend({
  notes: z.string().optional(),
});

export const listCalendarsOutput = { calendars: z.array(calendarInfoSchema) };
export const listEventsOutput = { events: z.array(eventSummarySchema) };
export const getEventOutput = eventDetailSchema.shape;
export const createdIdOutput = { id: z.string() };

// ----------------------------------------------------------- reminders

export const reminderListInfoSchema = z.object({
  id: z.string(),
  name: z.string(),
});

export const reminderSummarySchema = z.object({
  id: z.string(),
  title: z.string(),
  dueDate: z.string().optional(),
  completed: z.boolean(),
});

export const reminderDetailSchema = reminderSummarySchema.extend({
  notes: z.string().optional(),
});

export const listReminderListsOutput = { lists: z.array(reminderListInfoSchema) };
export const listRemindersOutput = { reminders: z.array(reminderSummarySchema) };
export const getReminderOutput = reminderDetailSchema.shape;
