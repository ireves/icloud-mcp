import { createDAVClient, type DAVCalendar } from 'tsdav';

type DAVClient = Awaited<ReturnType<typeof createDAVClient>>;
import ICAL from 'ical.js';
import type {
  CalendarInfo,
  EventDetail,
  EventSummary,
  ReminderDetail,
  ReminderListInfo,
  ReminderSummary,
} from './types.js';

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`${name} is not set`);
  }
  return value;
}

let cachedClient: DAVClient | null = null;

async function getClient(): Promise<DAVClient> {
  if (cachedClient) return cachedClient;
  const username = requireEnv('ICLOUD_EMAIL');
  const password = requireEnv('ICLOUD_APP_PASSWORD');
  cachedClient = await createDAVClient({
    serverUrl: 'https://caldav.icloud.com',
    credentials: { username, password },
    authMethod: 'Basic',
    defaultAccountType: 'caldav',
  });
  return cachedClient;
}

async function fetchAllCalendars(): Promise<DAVCalendar[]> {
  const client = await getClient();
  return client.fetchCalendars();
}

function isEventCalendar(cal: DAVCalendar): boolean {
  return Boolean(cal.components?.includes('VEVENT'));
}

function isTodoCalendar(cal: DAVCalendar): boolean {
  return Boolean(cal.components?.includes('VTODO'));
}

function toCalendarInfo(cal: DAVCalendar): CalendarInfo {
  return {
    id: cal.url,
    name: String(cal.displayName ?? cal.url),
    color: cal.calendarColor,
  };
}

async function findCalendar(calendarId: string): Promise<DAVCalendar> {
  const calendars = await fetchAllCalendars();
  const calendar = calendars.find((c) => c.url === calendarId);
  if (!calendar) {
    throw new Error(`Calendar or list ${calendarId} not found`);
  }
  return calendar;
}

export async function listCalendars(): Promise<CalendarInfo[]> {
  const calendars = await fetchAllCalendars();
  return calendars.filter(isEventCalendar).map(toCalendarInfo);
}

export async function listReminderLists(): Promise<ReminderListInfo[]> {
  const calendars = await fetchAllCalendars();
  return calendars.filter(isTodoCalendar).map((c) => ({ id: c.url, name: String(c.displayName ?? c.url) }));
}

// --- Events ---

function parseEventObject(obj: { url: string; data: string }): EventSummary | null {
  const jcal = ICAL.parse(obj.data);
  const comp = new ICAL.Component(jcal);
  const vevent = comp.getFirstSubcomponent('vevent');
  if (!vevent) return null;
  const event = new ICAL.Event(vevent);
  return {
    id: obj.url,
    title: event.summary ?? '(untitled)',
    start: event.startDate ? event.startDate.toJSDate().toISOString() : '',
    end: event.endDate ? event.endDate.toJSDate().toISOString() : '',
    location: (vevent.getFirstPropertyValue('location') as string | null) ?? undefined,
    hasAttendees: vevent.getAllProperties('attendee').length > 0,
  };
}

export interface ListEventsParams {
  calendarId: string;
  startDate: string;
  endDate: string;
}

export async function listEvents(params: ListEventsParams): Promise<EventSummary[]> {
  const client = await getClient();
  const calendar = await findCalendar(params.calendarId);
  const objects = await client.fetchCalendarObjects({
    calendar,
    timeRange: {
      start: new Date(params.startDate).toISOString(),
      end: new Date(params.endDate).toISOString(),
    },
  });
  return objects
    .map((obj) => parseEventObject({ url: obj.url, data: obj.data ?? '' }))
    .filter((e): e is EventSummary => e !== null);
}

export interface GetEventParams {
  calendarId: string;
  eventId: string;
}

export async function getEvent(params: GetEventParams): Promise<EventDetail> {
  const client = await getClient();
  const calendar = await findCalendar(params.calendarId);
  const objects = await client.fetchCalendarObjects({ calendar, objectUrls: [params.eventId] });
  const obj = objects[0];
  if (!obj || !obj.data) {
    throw new Error(`Event ${params.eventId} not found in calendar ${params.calendarId}`);
  }
  const summary = parseEventObject({ url: obj.url, data: obj.data });
  if (!summary) {
    throw new Error(`Event ${params.eventId} could not be parsed as a VEVENT`);
  }
  const jcal = ICAL.parse(obj.data);
  const comp = new ICAL.Component(jcal);
  const vevent = comp.getFirstSubcomponent('vevent');
  const notes = (vevent?.getFirstPropertyValue('description') as string | null) ?? undefined;
  return { ...summary, notes };
}

function newUid(): string {
  return `${Date.now()}-${Math.random().toString(36).slice(2)}@icloud-mcp`;
}

export interface CreateEventParams {
  calendarId: string;
  title: string;
  startTime: string;
  endTime: string;
  location?: string;
  notes?: string;
}

export async function createEvent(params: CreateEventParams): Promise<{ id: string }> {
  const client = await getClient();
  const calendar = await findCalendar(params.calendarId);
  const uid = newUid();
  const filename = `${uid}.ics`;

  const vcalendar = new ICAL.Component(['vcalendar', [], []]);
  vcalendar.updatePropertyWithValue('version', '2.0');
  vcalendar.updatePropertyWithValue('prodid', '-//icloud-mcp//EN');
  const vevent = new ICAL.Component('vevent');
  vevent.updatePropertyWithValue('uid', uid);
  vevent.updatePropertyWithValue('summary', params.title);
  vevent.updatePropertyWithValue('dtstart', ICAL.Time.fromJSDate(new Date(params.startTime), true));
  vevent.updatePropertyWithValue('dtend', ICAL.Time.fromJSDate(new Date(params.endTime), true));
  vevent.updatePropertyWithValue('dtstamp', ICAL.Time.now());
  if (params.location) vevent.updatePropertyWithValue('location', params.location);
  if (params.notes) vevent.updatePropertyWithValue('description', params.notes);
  vcalendar.addSubcomponent(vevent);

  const response = await client.createCalendarObject({
    calendar,
    filename,
    iCalString: vcalendar.toString(),
  });
  if (!response.ok) {
    throw new Error(`Failed to create event: ${response.status} ${response.statusText}`);
  }
  return { id: new URL(filename, calendar.url).toString() };
}

export interface UpdateEventParams {
  calendarId: string;
  eventId: string;
  title?: string;
  startTime?: string;
  endTime?: string;
  location?: string;
  notes?: string;
}

export async function updateEvent(params: UpdateEventParams): Promise<void> {
  const client = await getClient();
  const calendar = await findCalendar(params.calendarId);
  const objects = await client.fetchCalendarObjects({ calendar, objectUrls: [params.eventId] });
  const obj = objects[0];
  if (!obj || !obj.data) {
    throw new Error(`Event ${params.eventId} not found in calendar ${params.calendarId}`);
  }
  const jcal = ICAL.parse(obj.data);
  const comp = new ICAL.Component(jcal);
  const vevent = comp.getFirstSubcomponent('vevent');
  if (!vevent) {
    throw new Error(`Event ${params.eventId} has no VEVENT body`);
  }
  if (params.title !== undefined) vevent.updatePropertyWithValue('summary', params.title);
  if (params.startTime !== undefined) {
    vevent.updatePropertyWithValue('dtstart', ICAL.Time.fromJSDate(new Date(params.startTime), true));
  }
  if (params.endTime !== undefined) {
    vevent.updatePropertyWithValue('dtend', ICAL.Time.fromJSDate(new Date(params.endTime), true));
  }
  if (params.location !== undefined) vevent.updatePropertyWithValue('location', params.location);
  if (params.notes !== undefined) vevent.updatePropertyWithValue('description', params.notes);

  const response = await client.updateCalendarObject({
    calendarObject: { url: obj.url, data: comp.toString(), etag: obj.etag },
  });
  if (!response.ok) {
    throw new Error(`Failed to update event: ${response.status} ${response.statusText}`);
  }
}

// --- Reminders (VTODO) ---

function parseTodoObject(obj: { url: string; data: string }): ReminderSummary | null {
  const jcal = ICAL.parse(obj.data);
  const comp = new ICAL.Component(jcal);
  const vtodo = comp.getFirstSubcomponent('vtodo');
  if (!vtodo) return null;
  const due = vtodo.getFirstPropertyValue('due') as ICAL.Time | null;
  const status = vtodo.getFirstPropertyValue('status') as string | null;
  return {
    id: obj.url,
    title: (vtodo.getFirstPropertyValue('summary') as string | null) ?? '(untitled)',
    dueDate: due ? due.toJSDate().toISOString() : undefined,
    completed: status === 'COMPLETED',
  };
}

export interface ListRemindersParams {
  listId: string;
  includeCompleted?: boolean;
}

export async function listReminders(params: ListRemindersParams): Promise<ReminderSummary[]> {
  const client = await getClient();
  const calendar = await findCalendar(params.listId);
  const objects = await client.fetchCalendarObjects({ calendar });
  const reminders = objects
    .map((obj) => parseTodoObject({ url: obj.url, data: obj.data ?? '' }))
    .filter((r): r is ReminderSummary => r !== null);
  return params.includeCompleted ? reminders : reminders.filter((r) => !r.completed);
}

export interface GetReminderParams {
  listId: string;
  reminderId: string;
}

export async function getReminder(params: GetReminderParams): Promise<ReminderDetail> {
  const client = await getClient();
  const calendar = await findCalendar(params.listId);
  const objects = await client.fetchCalendarObjects({ calendar, objectUrls: [params.reminderId] });
  const obj = objects[0];
  if (!obj || !obj.data) {
    throw new Error(`Reminder ${params.reminderId} not found in list ${params.listId}`);
  }
  const summary = parseTodoObject({ url: obj.url, data: obj.data });
  if (!summary) {
    throw new Error(`Reminder ${params.reminderId} could not be parsed as a VTODO`);
  }
  const jcal = ICAL.parse(obj.data);
  const comp = new ICAL.Component(jcal);
  const vtodo = comp.getFirstSubcomponent('vtodo');
  const notes = (vtodo?.getFirstPropertyValue('description') as string | null) ?? undefined;
  return { ...summary, notes };
}

export interface CreateReminderParams {
  listId: string;
  title: string;
  dueDate?: string;
  notes?: string;
}

export async function createReminder(params: CreateReminderParams): Promise<{ id: string }> {
  const client = await getClient();
  const calendar = await findCalendar(params.listId);
  const uid = newUid();
  const filename = `${uid}.ics`;

  const vcalendar = new ICAL.Component(['vcalendar', [], []]);
  vcalendar.updatePropertyWithValue('version', '2.0');
  vcalendar.updatePropertyWithValue('prodid', '-//icloud-mcp//EN');
  const vtodo = new ICAL.Component('vtodo');
  vtodo.updatePropertyWithValue('uid', uid);
  vtodo.updatePropertyWithValue('summary', params.title);
  vtodo.updatePropertyWithValue('dtstamp', ICAL.Time.now());
  vtodo.updatePropertyWithValue('status', 'NEEDS-ACTION');
  if (params.dueDate) vtodo.updatePropertyWithValue('due', ICAL.Time.fromJSDate(new Date(params.dueDate), true));
  if (params.notes) vtodo.updatePropertyWithValue('description', params.notes);
  vcalendar.addSubcomponent(vtodo);

  const response = await client.createCalendarObject({
    calendar,
    filename,
    iCalString: vcalendar.toString(),
  });
  if (!response.ok) {
    throw new Error(`Failed to create reminder: ${response.status} ${response.statusText}`);
  }
  return { id: new URL(filename, calendar.url).toString() };
}

export interface CompleteReminderParams {
  listId: string;
  reminderId: string;
  completed: boolean;
}

export async function completeReminder(params: CompleteReminderParams): Promise<void> {
  const client = await getClient();
  const calendar = await findCalendar(params.listId);
  const objects = await client.fetchCalendarObjects({ calendar, objectUrls: [params.reminderId] });
  const obj = objects[0];
  if (!obj || !obj.data) {
    throw new Error(`Reminder ${params.reminderId} not found in list ${params.listId}`);
  }
  const jcal = ICAL.parse(obj.data);
  const comp = new ICAL.Component(jcal);
  const vtodo = comp.getFirstSubcomponent('vtodo');
  if (!vtodo) {
    throw new Error(`Reminder ${params.reminderId} has no VTODO body`);
  }
  vtodo.updatePropertyWithValue('status', params.completed ? 'COMPLETED' : 'NEEDS-ACTION');
  if (params.completed) {
    vtodo.updatePropertyWithValue('completed', ICAL.Time.now());
  } else {
    vtodo.removeProperty('completed');
  }

  const response = await client.updateCalendarObject({
    calendarObject: { url: obj.url, data: comp.toString(), etag: obj.etag },
  });
  if (!response.ok) {
    throw new Error(`Failed to update reminder: ${response.status} ${response.statusText}`);
  }
}
