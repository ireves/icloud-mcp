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
