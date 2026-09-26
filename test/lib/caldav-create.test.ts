import { beforeEach, describe, expect, it, vi } from 'vitest';
import ICAL from 'ical.js';

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
  mockClient.createCalendarObject.mockResolvedValue({ ok: true, status: 201, statusText: 'Created' });
  process.env.ICLOUD_EMAIL = 'test@icloud.com';
  process.env.ICLOUD_APP_PASSWORD = 'app-specific-password';
  return import('../../lib/caldav.js');
}

function written(): { ics: string; vevent: ICAL.Component; vcalendar: ICAL.Component } {
  const ics = mockClient.createCalendarObject.mock.calls[0][0].iCalString as string;
  const vcalendar = new ICAL.Component(ICAL.parse(ics));
  return { ics, vevent: vcalendar.getFirstSubcomponent('vevent')!, vcalendar };
}

const base = { calendarId: TEST_CALENDAR.url, title: 'Test' };

describe('createEvent', () => {
  beforeEach(() => vi.clearAllMocks());

  it('still creates a plain timed event in UTC', async () => {
    const caldav = await freshCaldav();
    await caldav.createEvent({ ...base, startTime: '2026-10-01T09:00:00Z', endTime: '2026-10-01T10:00:00Z' });
    const { ics, vevent } = written();
    expect(ics).toContain('DTSTART:20261001T090000Z');
    expect(ics).toContain('DTEND:20261001T100000Z');
    expect(vevent.getFirstProperty('rrule')).toBeNull();
    expect(vevent.getAllSubcomponents('valarm')).toHaveLength(0);
  });

  it('creates a single-day all-day event with an exclusive end date', async () => {
    const caldav = await freshCaldav();
    await caldav.createEvent({ ...base, allDay: true, startTime: '2026-10-03' });
    const { ics } = written();
    expect(ics).toContain('DTSTART;VALUE=DATE:20261003');
    expect(ics).toContain('DTEND;VALUE=DATE:20261004');
  });

  it('treats the all-day end_time as the last day, inclusive', async () => {
    const caldav = await freshCaldav();
    await caldav.createEvent({ ...base, allDay: true, startTime: '2026-12-30', endTime: '2027-01-02' });
    expect(written().ics).toContain('DTEND;VALUE=DATE:20270103');
  });

  it('rejects bad all-day dates', async () => {
    const caldav = await freshCaldav();
    await expect(caldav.createEvent({ ...base, allDay: true, startTime: '2026-10-03T09:00:00Z' })).rejects.toThrow(
      /YYYY-MM-DD/,
    );
    await expect(caldav.createEvent({ ...base, allDay: true, startTime: '2026-02-30' })).rejects.toThrow(
      /not a valid calendar date/,
    );
    await expect(
      caldav.createEvent({ ...base, allDay: true, startTime: '2026-10-03', endTime: '2026-10-02' }),
    ).rejects.toThrow(/must not be before/);
    expect(mockClient.createCalendarObject).not.toHaveBeenCalled();
  });

  it('requires end_time for a timed event', async () => {
    const caldav = await freshCaldav();
    await expect(caldav.createEvent({ ...base, startTime: '2026-10-01T09:00:00Z' })).rejects.toThrow(
      /end_time is required/,
    );
  });

  it('creates a yearly all-day event, such as a birthday', async () => {
    const caldav = await freshCaldav();
    await caldav.createEvent({ ...base, allDay: true, startTime: '2026-11-14', repeat: { frequency: 'yearly' } });
    expect(written().ics).toContain('RRULE:FREQ=YEARLY');
  });

  it('writes a repeat rule with interval, days and an end date for an all-day event', async () => {
    const caldav = await freshCaldav();
    await caldav.createEvent({
      ...base,
      allDay: true,
      startTime: '2026-10-05',
      repeat: { frequency: 'weekly', interval: 2, daysOfWeek: ['MO', 'TH'], until: '2026-12-31' },
    });
    expect(written().ics).toContain('RRULE:FREQ=WEEKLY;INTERVAL=2;BYDAY=MO,TH;UNTIL=20261231');
  });

  it('requires a time zone for a repeating timed event', async () => {
    const caldav = await freshCaldav();
    await expect(
      caldav.createEvent({
        ...base,
        startTime: '2026-10-05T09:00:00+01:00',
        endTime: '2026-10-05T10:00:00+01:00',
        repeat: { frequency: 'weekly' },
      }),
    ).rejects.toThrow(/time_zone is required/);
  });

  it('anchors a repeating timed event to its zone so it keeps its local time across clock changes', async () => {
    const caldav = await freshCaldav();
    await caldav.createEvent({
      ...base,
      startTime: '2026-10-19T09:00:00+01:00',
      endTime: '2026-10-19T10:00:00+01:00',
      timeZone: 'Europe/London',
      repeat: { frequency: 'weekly', count: 3 },
    });
    const { ics, vcalendar, vevent } = written();
    expect(ics).toContain('DTSTART;TZID=Europe/London:20261019T090000');
    expect(ics).toContain('DTEND;TZID=Europe/London:20261019T100000');
    expect(ics).toContain('RRULE:FREQ=WEEKLY;COUNT=3');
    const vtimezone = vcalendar.getFirstSubcomponent('vtimezone')!;
    ICAL.TimezoneService.register(new ICAL.Timezone(vtimezone));
    const iterator = new ICAL.Event(vevent).iterator();
    const starts: string[] = [];
    for (let next = iterator.next(); next; next = iterator.next()) starts.push(next.toJSDate().toISOString());
    // British Summer Time ends on 25 October 2026.
    expect(starts).toEqual(['2026-10-19T08:00:00.000Z', '2026-10-26T09:00:00.000Z', '2026-11-02T09:00:00.000Z']);
  });

  it('writes UNTIL as the end of the named day, in UTC, for a zoned event', async () => {
    const caldav = await freshCaldav();
    await caldav.createEvent({
      ...base,
      startTime: '2026-10-05T09:00:00-04:00',
      endTime: '2026-10-05T10:00:00-04:00',
      timeZone: 'America/New_York',
      repeat: { frequency: 'daily', until: '2026-12-01' },
    });
    expect(written().ics).toContain('UNTIL=20261202T045959Z');
  });

  it('handles zones with half-hour offsets', async () => {
    const caldav = await freshCaldav();
    await caldav.createEvent({
      ...base,
      startTime: '2026-10-05T09:00:00Z',
      endTime: '2026-10-05T10:00:00Z',
      timeZone: 'Asia/Kolkata',
    });
    const { ics } = written();
    expect(ics).toContain('DTSTART;TZID=Asia/Kolkata:20261005T143000');
    expect(ics).toContain('TZOFFSETTO:+0530');
  });

  it('rejects invalid repeat rules', async () => {
    const caldav = await freshCaldav();
    const allDay = { ...base, allDay: true, startTime: '2026-10-05' };
    await expect(
      caldav.createEvent({ ...allDay, repeat: { frequency: 'daily', until: '2026-12-01', count: 3 } }),
    ).rejects.toThrow(/not both/);
    await expect(caldav.createEvent({ ...allDay, repeat: { frequency: 'monthly', daysOfWeek: ['MO'] } })).rejects.toThrow(
      /weekly/,
    );
    await expect(caldav.createEvent({ ...allDay, repeat: { frequency: 'daily', until: '2026-10-01' } })).rejects.toThrow(
      /before the start/,
    );
    await expect(
      caldav.createEvent({
        ...base,
        startTime: '2026-10-05T09:00:00Z',
        endTime: '2026-10-05T10:00:00Z',
        timeZone: 'Not/AZone',
      }),
    ).rejects.toThrow(/IANA/);
  });

  it('adds alerts before the start', async () => {
    const caldav = await freshCaldav();
    await caldav.createEvent({
      ...base,
      startTime: '2026-10-01T09:00:00Z',
      endTime: '2026-10-01T10:00:00Z',
      alerts: [60, 0, 15, 15],
    });
    const alarms = written().vevent.getAllSubcomponents('valarm');
    expect(alarms.map((a) => a.getFirstPropertyValue('trigger')!.toString())).toEqual(['PT0S', '-PT15M', '-PT1H']);
    for (const alarm of alarms) {
      expect(alarm.getFirstPropertyValue('action')).toBe('DISPLAY');
      expect(alarm.getFirstProperty('attendee')).toBeNull();
    }
  });

  it('rejects too many or out-of-range alerts', async () => {
    const caldav = await freshCaldav();
    const timed = { ...base, startTime: '2026-10-01T09:00:00Z', endTime: '2026-10-01T10:00:00Z' };
    await expect(caldav.createEvent({ ...timed, alerts: [1, 2, 3, 4, 5, 6] })).rejects.toThrow(/At most 5/);
    await expect(caldav.createEvent({ ...timed, alerts: [-5] })).rejects.toThrow(/whole number/);
  });

  it('never adds attendees or an organiser', async () => {
    const caldav = await freshCaldav();
    await caldav.createEvent({
      ...base,
      startTime: '2026-10-01T09:00:00Z',
      endTime: '2026-10-01T10:00:00Z',
      timeZone: 'Europe/London',
      repeat: { frequency: 'daily', count: 2 },
      alerts: [10],
    });
    expect(written().ics).not.toMatch(/ATTENDEE|ORGANIZER/);
  });

  it('reads back a zoned event at the right instant', async () => {
    const caldav = await freshCaldav();
    await caldav.createEvent({
      ...base,
      startTime: '2026-07-01T09:00:00+01:00',
      endTime: '2026-07-01T10:00:00+01:00',
      timeZone: 'Europe/London',
    });
    const { ics } = written();
    mockClient.fetchCalendarObjects.mockResolvedValue([{ url: `${TEST_CALENDAR.url}x.ics`, data: ics, etag: '1' }]);
    const event = await caldav.getEvent({ calendarId: TEST_CALENDAR.url, eventId: `${TEST_CALENDAR.url}x.ics` });
    expect(event.start).toBe('2026-07-01T08:00:00.000Z');
    expect(event.end).toBe('2026-07-01T09:00:00.000Z');
  });
});
