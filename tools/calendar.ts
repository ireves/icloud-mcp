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
      description: "Lists the account's event calendars (name, identifier, colour if available).",
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
