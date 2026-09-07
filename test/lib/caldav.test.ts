import { beforeEach, describe, expect, it, vi } from 'vitest';
import { buildVevent, wrapCalendar } from '../fixtures/ics.js';

const mockClient = vi.hoisted(() => ({
  fetchCalendars: vi.fn(),
  fetchCalendarObjects: vi.fn(),
  createCalendarObject: vi.fn(),
  updateCalendarObject: vi.fn(),
}));

vi.mock('tsdav', () => ({
  createDAVClient: vi.fn(async () => mockClient),
}));

const TEST_CALENDAR = {
  url: 'https://caldav.example.com/calendars/user/calendar/',
  displayName: 'Test Calendar',
  components: ['VEVENT'],
};

async function freshCaldav() {
  vi.resetModules();
  for (const fn of Object.values(mockClient)) fn.mockReset();
  mockClient.fetchCalendars.mockResolvedValue([TEST_CALENDAR]);
  process.env.ICLOUD_EMAIL = 'test@icloud.com';
  process.env.ICLOUD_APP_PASSWORD = 'app-specific-password';
  return import('../../lib/caldav.js');
}

describe('isRecurringVevent (via listEvents)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('detects RDATE-only recurrence in list_events output', async () => {
    const caldav = await freshCaldav();
    // No RECURRENCE-ID and no RRULE here — RDATE must be the sole signal
    // that this component is recurring, isolating the fix under test.
    const ics = wrapCalendar([
      buildVevent({
        uid: 'rdate-event',
        summary: 'RDATE meeting',
        dtstart: '20260914T100000Z',
        dtend: '20260914T110000Z',
        rdate: '20260921T100000Z',
      }),
    ]);
    mockClient.fetchCalendarObjects.mockResolvedValue([
      { url: `${TEST_CALENDAR.url}rdate-event.ics`, etag: 'etag-1', data: ics },
    ]);

    const events = await caldav.listEvents({
      calendarId: TEST_CALENDAR.url,
      startDate: '2026-09-01T00:00:00Z',
      endDate: '2026-09-30T00:00:00Z',
    });

    expect(events).toHaveLength(1);
    expect(events[0].isRecurring).toBe(true);
  });
});

describe('updateEvent safeguards', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockClient.fetchCalendars.mockResolvedValue([TEST_CALENDAR]);
  });

  it('rejects an update to an event with an ATTENDEE on a non-first component', async () => {
    // Any component after the first in a shared-UID object is necessarily an
    // override (it must carry its own RECURRENCE-ID), so this fixture is also
    // "recurring" — the recurrence check fires first. Either rejection reason
    // is a correct outcome here; what matters is that the write never happens.
    const caldav = await freshCaldav();
    const ics = wrapCalendar([
      buildVevent({ uid: 'e1', summary: 'Master', dtstart: '20260914T100000Z', dtend: '20260914T110000Z', rrule: 'FREQ=WEEKLY;COUNT=3' }),
      buildVevent({
        uid: 'e1',
        summary: 'Override with attendee',
        dtstart: '20260921T100000Z',
        dtend: '20260921T110000Z',
        recurrenceId: '20260921T100000Z',
        attendee: 'someone@example.com',
      }),
    ]);
    mockClient.fetchCalendarObjects.mockResolvedValue([{ url: `${TEST_CALENDAR.url}e1.ics`, etag: 'etag-1', data: ics }]);

    await expect(
      caldav.updateEvent({ calendarId: TEST_CALENDAR.url, eventId: `${TEST_CALENDAR.url}e1.ics`, title: 'New title' }),
    ).rejects.toThrow(/recurring series|attendees or an organizer/);
    expect(mockClient.updateCalendarObject).not.toHaveBeenCalled();
  });

  it('rejects an update to a non-recurring event with an ATTENDEE on a second, non-recurring-signaling component', async () => {
    // Isolates the "scan every component" requirement from recurrence
    // detection: two components sharing a UID with no RRULE/RDATE/RECURRENCE-ID
    // anywhere is not realistic iCalendar, but the scheduling-object check
    // must still be applied across the whole set, not just the first VEVENT.
    const caldav = await freshCaldav();
    const ics = wrapCalendar([
      buildVevent({ uid: 'e1b', summary: 'First', dtstart: '20260914T100000Z', dtend: '20260914T110000Z' }),
      buildVevent({ uid: 'e1b', summary: 'Second, with attendee', dtstart: '20260915T100000Z', dtend: '20260915T110000Z', attendee: 'someone@example.com' }),
    ]);
    mockClient.fetchCalendarObjects.mockResolvedValue([{ url: `${TEST_CALENDAR.url}e1b.ics`, etag: 'etag-1', data: ics }]);

    await expect(
      caldav.updateEvent({ calendarId: TEST_CALENDAR.url, eventId: `${TEST_CALENDAR.url}e1b.ics`, title: 'New title' }),
    ).rejects.toThrow(/attendees or an organizer/);
    expect(mockClient.updateCalendarObject).not.toHaveBeenCalled();
  });

  it('rejects an update to a recurring event (RRULE)', async () => {
    const caldav = await freshCaldav();
    const ics = wrapCalendar([
      buildVevent({ uid: 'e2', summary: 'Recurring', dtstart: '20260914T100000Z', dtend: '20260914T110000Z', rrule: 'FREQ=DAILY;COUNT=5' }),
    ]);
    mockClient.fetchCalendarObjects.mockResolvedValue([{ url: `${TEST_CALENDAR.url}e2.ics`, etag: 'etag-1', data: ics }]);

    await expect(
      caldav.updateEvent({ calendarId: TEST_CALENDAR.url, eventId: `${TEST_CALENDAR.url}e2.ics`, title: 'New title' }),
    ).rejects.toThrow(/recurring series/);
    expect(mockClient.updateCalendarObject).not.toHaveBeenCalled();
  });

  it('rejects an update to a recurring event (RDATE only)', async () => {
    const caldav = await freshCaldav();
    const ics = wrapCalendar([
      buildVevent({ uid: 'e3', summary: 'RDATE recurring', dtstart: '20260914T100000Z', dtend: '20260914T110000Z', rdate: '20260921T100000Z' }),
    ]);
    mockClient.fetchCalendarObjects.mockResolvedValue([{ url: `${TEST_CALENDAR.url}e3.ics`, etag: 'etag-1', data: ics }]);

    await expect(
      caldav.updateEvent({ calendarId: TEST_CALENDAR.url, eventId: `${TEST_CALENDAR.url}e3.ics`, title: 'New title' }),
    ).rejects.toThrow(/recurring series/);
  });

  it('rejects an update to a recurrence exception (override component)', async () => {
    const caldav = await freshCaldav();
    const ics = wrapCalendar([
      buildVevent({ uid: 'e4', summary: 'Master', dtstart: '20260914T100000Z', dtend: '20260914T110000Z', rrule: 'FREQ=WEEKLY;COUNT=3' }),
      buildVevent({ uid: 'e4', summary: 'Moved override', dtstart: '20260922T100000Z', dtend: '20260922T110000Z', recurrenceId: '20260921T100000Z' }),
    ]);
    mockClient.fetchCalendarObjects.mockResolvedValue([{ url: `${TEST_CALENDAR.url}e4.ics`, etag: 'etag-1', data: ics }]);

    await expect(
      caldav.updateEvent({ calendarId: TEST_CALENDAR.url, eventId: `${TEST_CALENDAR.url}e4.ics#2026-09-21T10:00:00.000Z`, title: 'New title' }),
    ).rejects.toThrow(/recurring series/);
  });

  it('allows updating an ordinary personal event', async () => {
    const caldav = await freshCaldav();
    const ics = wrapCalendar([
      buildVevent({ uid: 'e5', summary: 'Personal event', dtstart: '20260914T100000Z', dtend: '20260914T110000Z' }),
    ]);
    mockClient.fetchCalendarObjects.mockResolvedValue([{ url: `${TEST_CALENDAR.url}e5.ics`, etag: 'etag-1', data: ics }]);
    mockClient.updateCalendarObject.mockResolvedValue({ ok: true, status: 204, statusText: 'No Content' });

    await caldav.updateEvent({ calendarId: TEST_CALENDAR.url, eventId: `${TEST_CALENDAR.url}e5.ics`, title: 'Renamed' });

    expect(mockClient.updateCalendarObject).toHaveBeenCalledTimes(1);
    const written = mockClient.updateCalendarObject.mock.calls[0][0].calendarObject.data as string;
    expect(written).toContain('SUMMARY:Renamed');
  });

  it('rejects updating an all-day event with a timed value', async () => {
    const caldav = await freshCaldav();
    const ics = wrapCalendar([
      buildVevent({ uid: 'e6', summary: 'All-day', dtstart: '20260914', dtend: '20260915', dtstartValueDate: true }),
    ]);
    mockClient.fetchCalendarObjects.mockResolvedValue([{ url: `${TEST_CALENDAR.url}e6.ics`, etag: 'etag-1', data: ics }]);

    await expect(
      caldav.updateEvent({
        calendarId: TEST_CALENDAR.url,
        eventId: `${TEST_CALENDAR.url}e6.ics`,
        startTime: '2026-09-14T10:00:00Z',
      }),
    ).rejects.toThrow(/all-day event/);
  });

  it('rejects setting end_time before the existing start_time', async () => {
    const caldav = await freshCaldav();
    const ics = wrapCalendar([
      buildVevent({ uid: 'e7', summary: 'Event', dtstart: '20260914T100000Z', dtend: '20260914T110000Z' }),
    ]);
    mockClient.fetchCalendarObjects.mockResolvedValue([{ url: `${TEST_CALENDAR.url}e7.ics`, etag: 'etag-1', data: ics }]);

    await expect(
      caldav.updateEvent({ calendarId: TEST_CALENDAR.url, eventId: `${TEST_CALENDAR.url}e7.ics`, endTime: '2026-09-14T09:00:00Z' }),
    ).rejects.toThrow(/must be before/);
  });

  it('never submits both DURATION and DTEND when updating a duration-based event', async () => {
    const caldav = await freshCaldav();
    const ics = wrapCalendar([
      buildVevent({ uid: 'e8', summary: 'Duration event', dtstart: '20260914T100000Z', duration: 'PT1H' }),
    ]);
    mockClient.fetchCalendarObjects.mockResolvedValue([{ url: `${TEST_CALENDAR.url}e8.ics`, etag: 'etag-1', data: ics }]);
    mockClient.updateCalendarObject.mockResolvedValue({ ok: true, status: 204, statusText: 'No Content' });

    await caldav.updateEvent({ calendarId: TEST_CALENDAR.url, eventId: `${TEST_CALENDAR.url}e8.ics`, endTime: '2026-09-14T12:00:00Z' });

    const written = mockClient.updateCalendarObject.mock.calls[0][0].calendarObject.data as string;
    expect(written).toContain('DTEND');
    expect(written).not.toContain('DURATION');
  });

  it('does not leave a stale TZID parameter when updating start_time', async () => {
    const caldav = await freshCaldav();
    const ics = wrapCalendar([
      buildVevent({ uid: 'e9', summary: 'TZID event', dtstart: '20260914T100000', dtend: '20260914T110000', tzid: 'America/New_York' }),
    ]);
    mockClient.fetchCalendarObjects.mockResolvedValue([{ url: `${TEST_CALENDAR.url}e9.ics`, etag: 'etag-1', data: ics }]);
    mockClient.updateCalendarObject.mockResolvedValue({ ok: true, status: 204, statusText: 'No Content' });

    await caldav.updateEvent({ calendarId: TEST_CALENDAR.url, eventId: `${TEST_CALENDAR.url}e9.ics`, startTime: '2026-09-14T09:00:00Z' });

    const written = mockClient.updateCalendarObject.mock.calls[0][0].calendarObject.data as string;
    const dtstartLine = written.split(/\r?\n/).find((line) => line.startsWith('DTSTART'));
    expect(dtstartLine).not.toContain('TZID');
  });
});
