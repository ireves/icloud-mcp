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

// tsdav's fetchCalendarObjects defaults to a VEVENT comp-filter when no
// explicit filter is given, which silently excludes VTODOs from a reminder
// list. Reminder calls must always pass this filter explicitly.
const VTODO_FILTERS = [
  {
    'comp-filter': {
      _attributes: { name: 'VCALENDAR' },
      'comp-filter': {
        _attributes: { name: 'VTODO' },
      },
    },
  },
];

export function parseRequiredDateTime(value: string, fieldName: string): Date {
  const match = value.match(
    /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2}))?(?:\.\d+)?(Z|[+-]\d{2}:\d{2})$/,
  );
  if (!match) {
    throw new Error(
      `${fieldName} must be an ISO 8601 date-time with an explicit UTC "Z" or timezone offset, got: "${value}"`,
    );
  }
  const [, y, mo, d, h, mi, s, offset] = match;
  const [year, month, day, hour, minute, second] = [y, mo, d, h, mi, s ?? '0'].map(Number);
  if (hour > 23 || minute > 59 || second > 60) {
    throw new Error(`${fieldName} has an invalid time component: "${value}"`);
  }
  if (offset !== 'Z') {
    const [offH, offM] = offset.slice(1).split(':').map(Number);
    if (offH > 23 || offM > 59) {
      throw new Error(`${fieldName} has an invalid timezone offset: "${value}"`);
    }
  }
  // Reconstruct the parsed calendar-date components in UTC and compare back —
  // this catches 30 February / 31 April / 29 February in a non-leap year,
  // which `new Date()` would otherwise silently roll forward into the next
  // month. The offset only shifts the instant, never the calendar date being
  // validated here, so it's intentionally ignored in this reconstruction.
  const reconstructed = new Date(Date.UTC(year, month - 1, day, hour, minute, second));
  if (
    reconstructed.getUTCFullYear() !== year ||
    reconstructed.getUTCMonth() !== month - 1 ||
    reconstructed.getUTCDate() !== day
  ) {
    throw new Error(`${fieldName} is not a valid calendar date: "${value}"`);
  }
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    throw new Error(`${fieldName} is not a valid date: "${value}"`);
  }
  return date;
}

export function assertStartBeforeEnd(start: Date, end: Date): void {
  if (start.getTime() >= end.getTime()) {
    throw new Error(`start_time (${start.toISOString()}) must be before end_time (${end.toISOString()})`);
  }
}

function isSchedulingObject(vevent: ICAL.Component): boolean {
  return vevent.getAllProperties('attendee').length > 0 || Boolean(vevent.getFirstProperty('organizer'));
}

export function getEffectiveEnd(vevent: ICAL.Component): ICAL.Time | null {
  const dtend = vevent.getFirstPropertyValue('dtend') as ICAL.Time | null;
  if (dtend) return dtend;
  const dtstart = vevent.getFirstPropertyValue('dtstart') as ICAL.Time | null;
  if (!dtstart) return null;
  const duration = vevent.getFirstPropertyValue('duration') as ICAL.Duration | null;
  if (duration) {
    const end = dtstart.clone();
    end.addDuration(duration);
    return end;
  }
  // RFC 5545 3.6.1: with neither DTEND nor DURATION, a DATE-TIME DTSTART's
  // implicit end equals DTSTART; a DATE (all-day) DTSTART's implicit end is
  // DTSTART + 1 day.
  if (dtstart.isDate) {
    const end = dtstart.clone();
    end.adjust(1, 0, 0, 0);
    return end;
  }
  return dtstart.clone();
}

export function isRecurringVevent(vevent: ICAL.Component): boolean {
  return (
    Boolean(vevent.getFirstProperty('rrule')) ||
    Boolean(vevent.getFirstProperty('recurrence-id')) ||
    Boolean(vevent.getFirstProperty('rdate'))
  );
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

function summarizeVevent(vevent: ICAL.Component, id: string): EventSummary {
  const event = new ICAL.Event(vevent);
  return {
    id,
    title: event.summary ?? '(untitled)',
    start: event.startDate ? event.startDate.toJSDate().toISOString() : '',
    end: event.endDate ? event.endDate.toJSDate().toISOString() : '',
    location: (vevent.getFirstPropertyValue('location') as string | null) ?? undefined,
    hasAttendees: vevent.getAllProperties('attendee').length > 0,
    isRecurring: isRecurringVevent(vevent),
  };
}

// Returns one summary per VEVENT component in the object. A non-recurring
// object has exactly one; a server-expanded recurring object (see listEvents'
// use of `expand`) has one per occurrence within the requested range.
function parseEventObjects(obj: { url: string; data: string }): EventSummary[] {
  const jcal = ICAL.parse(obj.data);
  const comp = new ICAL.Component(jcal);
  const vevents = comp.getAllSubcomponents('vevent');
  return vevents.map((vevent, index) =>
    summarizeVevent(vevent, vevents.length > 1 ? `${obj.url}#${index}` : obj.url),
  );
}

function parseEventObject(obj: { url: string; data: string }): EventSummary | null {
  const jcal = ICAL.parse(obj.data);
  const comp = new ICAL.Component(jcal);
  const vevent = comp.getFirstSubcomponent('vevent');
  if (!vevent) return null;
  return summarizeVevent(vevent, obj.url);
}

export interface ListEventsParams {
  calendarId: string;
  startDate: string;
  endDate: string;
}

export async function listEvents(params: ListEventsParams): Promise<EventSummary[]> {
  const client = await getClient();
  const calendar = await findCalendar(params.calendarId);
  const startDate = parseRequiredDateTime(params.startDate, 'start_date');
  const endDate = parseRequiredDateTime(params.endDate, 'end_date');
  const objects = await client.fetchCalendarObjects({
    calendar,
    timeRange: {
      start: startDate.toISOString(),
      end: endDate.toISOString(),
    },
    // Ask the server to expand recurring events into individual occurrences
    // within the range, instead of returning only the recurring master
    // (whose own dates may fall outside the requested window entirely).
    expand: true,
  });
  return objects.flatMap((obj) => parseEventObjects({ url: obj.url, data: obj.data ?? '' }));
}

export interface GetEventParams {
  calendarId: string;
  eventId: string;
}

// list_events may return an occurrence id like "<url>#2" for an expanded
// recurring event. Fetching the object itself always uses the base URL.
function baseObjectUrl(id: string): string {
  const hashIndex = id.indexOf('#');
  return hashIndex === -1 ? id : id.slice(0, hashIndex);
}

export async function getEvent(params: GetEventParams): Promise<EventDetail> {
  const client = await getClient();
  const calendar = await findCalendar(params.calendarId);
  const objects = await client.fetchCalendarObjects({ calendar, objectUrls: [baseObjectUrl(params.eventId)] });
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
  const startTime = parseRequiredDateTime(params.startTime, 'start_time');
  const endTime = parseRequiredDateTime(params.endTime, 'end_time');
  assertStartBeforeEnd(startTime, endTime);
  const uid = newUid();
  const filename = `${uid}.ics`;

  const vcalendar = new ICAL.Component(['vcalendar', [], []]);
  vcalendar.updatePropertyWithValue('version', '2.0');
  vcalendar.updatePropertyWithValue('prodid', '-//icloud-mcp//EN');
  const vevent = new ICAL.Component('vevent');
  vevent.updatePropertyWithValue('uid', uid);
  vevent.updatePropertyWithValue('summary', params.title);
  vevent.updatePropertyWithValue('dtstart', ICAL.Time.fromJSDate(startTime, true));
  vevent.updatePropertyWithValue('dtend', ICAL.Time.fromJSDate(endTime, true));
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
  const baseUrl = baseObjectUrl(params.eventId);
  const objects = await client.fetchCalendarObjects({ calendar, objectUrls: [baseUrl] });
  const obj = objects[0];
  if (!obj || !obj.data) {
    throw new Error(`Event ${params.eventId} not found in calendar ${params.calendarId}`);
  }
  const jcal = ICAL.parse(obj.data);
  const comp = new ICAL.Component(jcal);
  const vevents = comp.getAllSubcomponents('vevent');
  if (vevents.length === 0) {
    throw new Error(`Event ${params.eventId} has no VEVENT body`);
  }
  if (vevents.some(isRecurringVevent)) {
    throw new Error(
      `Event ${params.eventId} is part of a recurring series. Editing a single occurrence or the whole series is not yet supported — edit it directly in Calendar.app instead.`,
    );
  }
  if (vevents.some(isSchedulingObject)) {
    throw new Error(
      `Event ${params.eventId} has attendees or an organizer. Updating a scheduling object can trigger CalDAV meeting-update notifications to those attendees, which this tool never does — edit it directly in Calendar.app instead.`,
    );
  }
  const vevent = vevents[0];

  const currentStartProp = vevent.getFirstPropertyValue('dtstart') as ICAL.Time | null;
  if (currentStartProp?.isDate && (params.startTime !== undefined || params.endTime !== undefined)) {
    throw new Error(
      `Event ${params.eventId} is an all-day event. Updating its time-based fields with timed values is not supported.`,
    );
  }

  const currentEnd = getEffectiveEnd(vevent);
  const newStart = params.startTime !== undefined
    ? parseRequiredDateTime(params.startTime, 'start_time')
    : (currentStartProp?.toJSDate() ?? null);
  const newEnd = params.endTime !== undefined
    ? parseRequiredDateTime(params.endTime, 'end_time')
    : (currentEnd?.toJSDate() ?? null);
  if (newStart && newEnd) {
    assertStartBeforeEnd(newStart, newEnd);
  }

  if (params.title !== undefined) vevent.updatePropertyWithValue('summary', params.title);
  if (params.startTime !== undefined && newStart) {
    vevent.updatePropertyWithValue('dtstart', ICAL.Time.fromJSDate(newStart, true));
    vevent.getFirstProperty('dtstart')?.removeParameter('tzid');
  }
  if (params.endTime !== undefined && newEnd) {
    vevent.removeProperty('duration');
    vevent.updatePropertyWithValue('dtend', ICAL.Time.fromJSDate(newEnd, true));
    vevent.getFirstProperty('dtend')?.removeParameter('tzid');
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
  const objects = await client.fetchCalendarObjects({ calendar, filters: VTODO_FILTERS });
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
  if (params.dueDate) {
    vtodo.updatePropertyWithValue('due', ICAL.Time.fromJSDate(parseRequiredDateTime(params.dueDate, 'due_date'), true));
  }
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
