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
      description: "Lists the account's reminder lists.",
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
