# Calendar Correctness & Recurrence Safety Fixes Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fix recurrence detection (RDATE), occurrence identity, date validation, and DURATION/DTEND handling in `lib/caldav.ts`, with a full test suite using synthetic ICS fixtures and a mocked `tsdav` client — no live iCloud access.

**Architecture:** All changes are internal to `lib/caldav.ts` (helper functions, `listEvents`, `getEvent`, `updateEvent`) plus tool-description updates in `tools/calendar.ts`. A new Vitest test suite exercises the exported pure helpers directly and the higher-level functions against a mocked `tsdav` client returning synthetic ICS strings.

**Tech Stack:** TypeScript, `ical.js`, `tsdav` (mocked in tests), Vitest (new dev dependency).

## Global Constraints

- No live iCloud access, no real network calls, no live mailbox/calendar mutations in tests — synthetic fixtures and a mocked `tsdav` client only (spec: Testing).
- Every date input (`start_time`, `end_time`, `start_date`, `end_date`, `due_date`) goes through the same strict validator; no silent date-rollover, no timezone assumptions (spec: Date validation).
- `list_events` date ranges are capped at 366 days (spec: Occurrence identifiers).
- A submitted `VEVENT` string must never contain both `DURATION` and `DTEND` (spec: DURATION and DTEND).
- Occurrence resolution never falls back to the series master when the specific occurrence can't be resolved — an explicit error instead (spec: Occurrence identifiers).
- A pre-fix positional identifier (`<url>#<small-integer>`) must produce an explicit "deprecated format" error, not a wrong answer (spec: Occurrence identifiers).
- Preserve all fixes already on `main` (mail size limits, scheduling-object rejection, reminder VTODO filter) — this plan only touches the recurrence/date/DURATION code paths.
- British English in documentation and user-facing tool description text (per the review's instruction).

---

## File Structure

```
package.json          # add vitest devDependency + "test" script
vitest.config.ts       # new — Vitest config
lib/caldav.ts          # modified — all Phase A fixes
tools/calendar.ts      # modified — tool description updates only
test/
  fixtures/
    ics.ts             # new — synthetic VEVENT/VCALENDAR builders
  lib/
    caldav-mock-client.ts   # new — shared mocked tsdav client factory
    caldav-dates.test.ts    # new — pure unit tests (no mocking needed)
    caldav.test.ts          # new — mocked-client tests (recurrence, occurrence ids, DURATION/DTEND)
```

---

### Task 1: Add Vitest and a synthetic ICS fixture builder

**Files:**
- Modify: `package.json`
- Create: `vitest.config.ts`
- Create: `test/fixtures/ics.ts`

**Interfaces:**
- Produces: `npm test` script; `buildVevent(opts: VeventFixtureOptions): string` and `wrapCalendar(vevents: string[]): string`, consumed by every later test task.

- [ ] **Step 1: Add Vitest to `package.json`**

Add to `devDependencies`: `"vitest": "^2.1.8"`. Add to `scripts`: `"test": "vitest run"`.

- [ ] **Step 2: Write `vitest.config.ts`**

```typescript
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['test/**/*.test.ts'],
  },
});
```

- [ ] **Step 3: Install**

Run: `npm install`
Expected: `vitest` added to `node_modules`, no errors.

- [ ] **Step 4: Write `test/fixtures/ics.ts`**

```typescript
export interface VeventFixtureOptions {
  uid: string;
  summary: string;
  dtstart: string;
  dtstartValueDate?: boolean;
  dtend?: string;
  duration?: string;
  rrule?: string;
  rdate?: string;
  recurrenceId?: string;
  attendee?: string;
  organizer?: string;
  location?: string;
  description?: string;
  status?: string;
  tzid?: string;
}

export function buildVevent(opts: VeventFixtureOptions): string {
  const lines = ['BEGIN:VEVENT'];
  lines.push(`UID:${opts.uid}`);
  lines.push('DTSTAMP:20260101T000000Z');
  if (opts.dtstartValueDate) {
    lines.push(`DTSTART;VALUE=DATE:${opts.dtstart}`);
  } else if (opts.tzid) {
    lines.push(`DTSTART;TZID=${opts.tzid}:${opts.dtstart}`);
  } else {
    lines.push(`DTSTART:${opts.dtstart}`);
  }
  if (opts.dtend) {
    lines.push(opts.dtstartValueDate ? `DTEND;VALUE=DATE:${opts.dtend}` : `DTEND:${opts.dtend}`);
  }
  if (opts.duration) lines.push(`DURATION:${opts.duration}`);
  if (opts.rrule) lines.push(`RRULE:${opts.rrule}`);
  if (opts.rdate) lines.push(`RDATE:${opts.rdate}`);
  if (opts.recurrenceId) lines.push(`RECURRENCE-ID:${opts.recurrenceId}`);
  if (opts.attendee) lines.push(`ATTENDEE:mailto:${opts.attendee}`);
  if (opts.organizer) lines.push(`ORGANIZER:mailto:${opts.organizer}`);
  if (opts.location) lines.push(`LOCATION:${opts.location}`);
  if (opts.description) lines.push(`DESCRIPTION:${opts.description}`);
  if (opts.status) lines.push(`STATUS:${opts.status}`);
  lines.push(`SUMMARY:${opts.summary}`);
  lines.push('END:VEVENT');
  return lines.join('\r\n') + '\r\n';
}

export function wrapCalendar(vevents: string[]): string {
  return `BEGIN:VCALENDAR\r\nVERSION:2.0\r\nPRODID:-//test//EN\r\n${vevents.join('')}END:VCALENDAR\r\n`;
}
```

- [ ] **Step 5: Verify the fixture builder works**

Run: `npx vitest run --reporter=verbose 2>&1 || true` (no tests exist yet, this just confirms Vitest itself runs without config errors)
Expected: Vitest reports "No test files found" — not a config/crash error.

- [ ] **Step 6: Commit**

```bash
git add package.json package-lock.json vitest.config.ts test/fixtures/ics.ts
git commit -m "Add Vitest and synthetic ICS fixture builder

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>"
```

---

### Task 2: Strict calendar-date validation

**Files:**
- Modify: `lib/caldav.ts` (replace `parseRequiredDateTime`)
- Create: `test/lib/caldav-dates.test.ts`

**Interfaces:**
- Consumes: nothing new.
- Produces: `export function parseRequiredDateTime(value: string, fieldName: string): Date` (now exported — was private before). Signature unchanged from the existing private version, so every existing call site (`createEvent`, `updateEvent`, `listEvents`, `createReminder`) keeps working unmodified.

- [ ] **Step 1: Write the failing tests**

```typescript
// test/lib/caldav-dates.test.ts
import { describe, expect, it } from 'vitest';
import { parseRequiredDateTime, assertStartBeforeEnd } from '../../lib/caldav.js';

describe('parseRequiredDateTime', () => {
  it('accepts a valid UTC date-time', () => {
    const date = parseRequiredDateTime('2026-09-14T10:00:00Z', 'start_time');
    expect(date.toISOString()).toBe('2026-09-14T10:00:00.000Z');
  });

  it('accepts a valid positive offset and preserves the instant', () => {
    const date = parseRequiredDateTime('2026-09-14T10:00:00+05:00', 'start_time');
    expect(date.toISOString()).toBe('2026-09-14T05:00:00.000Z');
  });

  it('accepts a valid negative offset and preserves the instant', () => {
    const date = parseRequiredDateTime('2026-09-14T10:00:00-05:00', 'start_time');
    expect(date.toISOString()).toBe('2026-09-14T15:00:00.000Z');
  });

  it('rejects 30 February', () => {
    expect(() => parseRequiredDateTime('2026-02-30T10:00:00Z', 'start_time')).toThrow(/not a valid calendar date/);
  });

  it('rejects 31 April', () => {
    expect(() => parseRequiredDateTime('2026-04-31T10:00:00Z', 'start_time')).toThrow(/not a valid calendar date/);
  });

  it('rejects 29 February in a non-leap year', () => {
    expect(() => parseRequiredDateTime('2026-02-29T10:00:00Z', 'start_time')).toThrow(/not a valid calendar date/);
  });

  it('accepts 29 February in a leap year', () => {
    const date = parseRequiredDateTime('2028-02-29T10:00:00Z', 'start_time');
    expect(date.toISOString()).toBe('2028-02-29T10:00:00.000Z');
  });

  it('rejects an invalid hour', () => {
    expect(() => parseRequiredDateTime('2026-09-14T25:00:00Z', 'start_time')).toThrow(/invalid time component/);
  });

  it('rejects an invalid minute', () => {
    expect(() => parseRequiredDateTime('2026-09-14T10:75:00Z', 'start_time')).toThrow(/invalid time component/);
  });

  it('rejects a malformed offset', () => {
    expect(() => parseRequiredDateTime('2026-09-14T10:00:00+25:99', 'start_time')).toThrow(/invalid timezone offset/);
  });

  it('rejects a date-time with no offset or Z', () => {
    expect(() => parseRequiredDateTime('2026-09-14T10:00:00', 'start_time')).toThrow(/explicit UTC "Z" or timezone offset/);
  });

  it('rejects a non-date string', () => {
    expect(() => parseRequiredDateTime('not-a-date', 'start_time')).toThrow(/explicit UTC "Z" or timezone offset/);
  });
});

describe('assertStartBeforeEnd', () => {
  it('accepts start before end', () => {
    expect(() => assertStartBeforeEnd(new Date('2026-01-01T00:00:00Z'), new Date('2026-01-02T00:00:00Z'))).not.toThrow();
  });

  it('rejects an inverted range', () => {
    expect(() => assertStartBeforeEnd(new Date('2026-01-02T00:00:00Z'), new Date('2026-01-01T00:00:00Z'))).toThrow(
      /must be before/,
    );
  });

  it('rejects an equal start and end', () => {
    const same = new Date('2026-01-01T00:00:00Z');
    expect(() => assertStartBeforeEnd(same, same)).toThrow(/must be before/);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run test/lib/caldav-dates.test.ts`
Expected: FAIL — `parseRequiredDateTime` is not exported yet (import error), and the 30 Feb / 31 Apr / non-leap-Feb-29 cases would pass through unvalidated even once exported.

- [ ] **Step 3: Replace `parseRequiredDateTime` in `lib/caldav.ts`**

Find the existing `parseRequiredDateTime` function (added in the previous fix round) and `assertStartBeforeEnd` right after it. Replace both with:

```typescript
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
```

- [ ] **Step 4: Run to verify it passes**

Run: `npx vitest run test/lib/caldav-dates.test.ts`
Expected: PASS, all cases.

- [ ] **Step 5: Typecheck**

Run: `npx tsc -p tsconfig.json --noEmit`
Expected: no errors.

- [ ] **Step 6: Commit**

```bash
git add lib/caldav.ts test/lib/caldav-dates.test.ts
git commit -m "Reject impossible calendar dates instead of silently rolling them forward

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>"
```

---

### Task 3: Recurrence detection (RDATE) and the shared mock client

**Files:**
- Modify: `lib/caldav.ts` (`isRecurringVevent`, new `anyVeventIsRecurring`/`anyVeventIsScheduling` are NOT needed as separate exports — see Task 5, which uses `.some()` inline)
- Create: `test/lib/caldav-mock-client.ts`
- Create: `test/lib/caldav.test.ts` (started here, extended in later tasks)

**Interfaces:**
- Consumes: `buildVevent`, `wrapCalendar` from `test/fixtures/ics.ts` (Task 1).
- Produces: `export function isRecurringVevent(vevent: ICAL.Component): boolean` (now exported); `createMockDavClient()` returning `{ fetchCalendars, fetchCalendarObjects, createCalendarObject, updateCalendarObject }` (all `vi.fn()`), consumed by every later task's higher-level tests.

- [ ] **Step 1: Write `test/lib/caldav-mock-client.ts`**

```typescript
import { vi } from 'vitest';

export function createMockDavClient() {
  return {
    fetchCalendars: vi.fn(),
    fetchCalendarObjects: vi.fn(),
    createCalendarObject: vi.fn(),
    updateCalendarObject: vi.fn(),
  };
}

export type MockDavClient = ReturnType<typeof createMockDavClient>;
```

- [ ] **Step 2: Write `test/lib/caldav.test.ts` with the module-mocking harness and the first (failing) recurrence test**

```typescript
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { buildVevent, wrapCalendar } from '../fixtures/ics.js';
import { createMockDavClient } from './caldav-mock-client.js';

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
    const ics = wrapCalendar([
      buildVevent({
        uid: 'rdate-event',
        summary: 'RDATE meeting',
        dtstart: '20260914T100000Z',
        dtend: '20260914T110000Z',
        rdate: '20260921T100000Z',
        recurrenceId: '20260914T100000Z',
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
```

- [ ] **Step 3: Run to verify it fails**

Run: `npx vitest run test/lib/caldav.test.ts`
Expected: FAIL — `isRecurringVevent` doesn't check `RDATE` yet, so `isRecurring` is `false`.

- [ ] **Step 4: Update `isRecurringVevent` in `lib/caldav.ts`**

Find the existing `isRecurringVevent` function and export + extend it:

```typescript
export function isRecurringVevent(vevent: ICAL.Component): boolean {
  return (
    Boolean(vevent.getFirstProperty('rrule')) ||
    Boolean(vevent.getFirstProperty('recurrence-id')) ||
    Boolean(vevent.getFirstProperty('rdate'))
  );
}
```

- [ ] **Step 5: Run to verify it passes**

Run: `npx vitest run test/lib/caldav.test.ts`
Expected: PASS.

- [ ] **Step 6: Typecheck**

Run: `npx tsc -p tsconfig.json --noEmit`
Expected: no errors.

- [ ] **Step 7: Commit**

```bash
git add lib/caldav.ts test/lib/caldav-mock-client.ts test/lib/caldav.test.ts
git commit -m "Detect RDATE-based recurrence, add mocked-tsdav test harness

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>"
```

---

### Task 4: `getEffectiveEnd` for DURATION and implicit-end events

**Files:**
- Modify: `lib/caldav.ts` (add `getEffectiveEnd`)
- Modify: `test/lib/caldav-dates.test.ts` (add unit tests — this one doesn't need the mocked client, just `ical.js` directly)

**Interfaces:**
- Consumes: `ICAL` from `ical.js` (already imported in `lib/caldav.ts`).
- Produces: `export function getEffectiveEnd(vevent: ICAL.Component): ICAL.Time | null`, consumed by `updateEvent` in Task 5.

- [ ] **Step 1: Write the failing tests**

Append to `test/lib/caldav-dates.test.ts`:

```typescript
import ICAL from 'ical.js';
import { getEffectiveEnd } from '../../lib/caldav.js';

function parseFirstVevent(ics: string): ICAL.Component {
  const jcal = ICAL.parse(ics);
  const comp = new ICAL.Component(jcal);
  const vevent = comp.getFirstSubcomponent('vevent');
  if (!vevent) throw new Error('fixture has no VEVENT');
  return vevent;
}

describe('getEffectiveEnd', () => {
  it('returns DTEND when present', () => {
    const vevent = parseFirstVevent(
      'BEGIN:VCALENDAR\r\nBEGIN:VEVENT\r\nUID:a\r\nDTSTAMP:20260101T000000Z\r\nDTSTART:20260914T100000Z\r\nDTEND:20260914T110000Z\r\nSUMMARY:x\r\nEND:VEVENT\r\nEND:VCALENDAR\r\n',
    );
    const end = getEffectiveEnd(vevent);
    expect(end?.toJSDate().toISOString()).toBe('2026-09-14T11:00:00.000Z');
  });

  it('derives the end from DTSTART + DURATION', () => {
    const vevent = parseFirstVevent(
      'BEGIN:VCALENDAR\r\nBEGIN:VEVENT\r\nUID:a\r\nDTSTAMP:20260101T000000Z\r\nDTSTART:20260914T100000Z\r\nDURATION:PT1H30M\r\nSUMMARY:x\r\nEND:VEVENT\r\nEND:VCALENDAR\r\n',
    );
    const end = getEffectiveEnd(vevent);
    expect(end?.toJSDate().toISOString()).toBe('2026-09-14T11:30:00.000Z');
  });

  it('derives an implicit zero-length end for a timed event with neither DTEND nor DURATION', () => {
    const vevent = parseFirstVevent(
      'BEGIN:VCALENDAR\r\nBEGIN:VEVENT\r\nUID:a\r\nDTSTAMP:20260101T000000Z\r\nDTSTART:20260914T100000Z\r\nSUMMARY:x\r\nEND:VEVENT\r\nEND:VCALENDAR\r\n',
    );
    const end = getEffectiveEnd(vevent);
    expect(end?.toJSDate().toISOString()).toBe('2026-09-14T10:00:00.000Z');
  });

  it('derives an implicit one-day end for an all-day event with neither DTEND nor DURATION', () => {
    const vevent = parseFirstVevent(
      'BEGIN:VCALENDAR\r\nBEGIN:VEVENT\r\nUID:a\r\nDTSTAMP:20260101T000000Z\r\nDTSTART;VALUE=DATE:20260914\r\nSUMMARY:x\r\nEND:VEVENT\r\nEND:VCALENDAR\r\n',
    );
    const end = getEffectiveEnd(vevent);
    expect(end?.toJSDate().toISOString().slice(0, 10)).toBe('2026-09-15');
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run test/lib/caldav-dates.test.ts`
Expected: FAIL — `getEffectiveEnd` is not exported/defined yet.

- [ ] **Step 3: Add `getEffectiveEnd` to `lib/caldav.ts`**

Add near `isSchedulingObject`/`isRecurringVevent`:

```typescript
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
```

- [ ] **Step 4: Run to verify it passes**

Run: `npx vitest run test/lib/caldav-dates.test.ts`
Expected: PASS.

- [ ] **Step 5: Typecheck**

Run: `npx tsc -p tsconfig.json --noEmit`
Expected: no errors. If `ICAL.Duration` is not exported by `ical.js`'s type declarations, use `vevent.getFirstPropertyValue('duration') as { toSeconds?: () => number } | null` cast narrowly enough for `.clone().addDuration(...)` to still typecheck — check `node_modules/ical.js/dist/types/duration.d.ts` for the exact exported type name first.

- [ ] **Step 6: Commit**

```bash
git add lib/caldav.ts test/lib/caldav-dates.test.ts
git commit -m "Add getEffectiveEnd to correctly derive DURATION/implicit event ends

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>"
```

---

### Task 5: `updateEvent` — multi-component checks, all-day rejection, DURATION/DTEND, stale TZID

**Files:**
- Modify: `lib/caldav.ts` (replace the body of `updateEvent`)
- Modify: `test/lib/caldav.test.ts`

**Interfaces:**
- Consumes: `isRecurringVevent`, `isSchedulingObject` (already exported/existing), `getEffectiveEnd` (Task 4), `parseRequiredDateTime`, `assertStartBeforeEnd` (Task 2), `baseObjectUrl` (existing private helper — unchanged).
- Produces: `updateEvent` behaviour relied on by `tools/calendar.ts` (unchanged signature: `updateEvent(params: UpdateEventParams): Promise<void>`).

- [ ] **Step 1: Write the failing tests**

Append to `test/lib/caldav.test.ts`:

```typescript
describe('updateEvent safeguards', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockClient.fetchCalendars.mockResolvedValue([TEST_CALENDAR]);
  });

  it('rejects an update to an event with an ATTENDEE on a non-first component', async () => {
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

    await caldav.updateEvent({ calendarId: TEST_CALENDAR.url, eventId: `${TEST_CALENDAR.url}e9.ics`, startTime: '2026-09-14T15:00:00Z' });

    const written = mockClient.updateCalendarObject.mock.calls[0][0].calendarObject.data as string;
    const dtstartLine = written.split(/\r?\n/).find((line) => line.startsWith('DTSTART'));
    expect(dtstartLine).not.toContain('TZID');
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run test/lib/caldav.test.ts`
Expected: FAIL on most of the new cases — current `updateEvent` only inspects the first `VEVENT`, doesn't check all-day/timed mismatch, and doesn't strip `DURATION`/`TZID`.

- [ ] **Step 3: Replace `updateEvent` in `lib/caldav.ts`**

Find the existing `updateEvent` function and replace its entire body with:

```typescript
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
```

This replaces the version from the previous fix round (which only checked `comp.getFirstSubcomponent('vevent')` for recurrence/scheduling and always wrote `dtend` unconditionally).

- [ ] **Step 4: Run to verify it passes**

Run: `npx vitest run test/lib/caldav.test.ts`
Expected: PASS, all cases in this file.

- [ ] **Step 5: Typecheck**

Run: `npx tsc -p tsconfig.json --noEmit`
Expected: no errors.

- [ ] **Step 6: Commit**

```bash
git add lib/caldav.ts test/lib/caldav.test.ts
git commit -m "Fix update_event: scan all VEVENT components, reject all-day/timed
mismatches, never emit both DURATION and DTEND, strip stale TZID

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>"
```

---

### Task 6: Stable occurrence identifiers and range bounding in `listEvents`

**Files:**
- Modify: `lib/caldav.ts` (`parseEventObjects`, `listEvents`)
- Modify: `test/lib/caldav.test.ts`

**Interfaces:**
- Consumes: `summarizeVevent` (existing), `isCancelledVevent` (new, this task), `recurrenceIdIso` (new, this task).
- Produces: `listEvents` output ids in `<url>#<RECURRENCE-ID-ISO>` form for occurrences, plain `<url>` for non-recurring objects; consumed by `getEvent` in Task 7.

- [ ] **Step 1: Write the failing tests**

Append to `test/lib/caldav.test.ts`:

```typescript
describe('listEvents occurrence identifiers and bounds', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockClient.fetchCalendars.mockResolvedValue([TEST_CALENDAR]);
  });

  it('gives a plain URL id to a non-recurring event', async () => {
    const caldav = await freshCaldav();
    const ics = wrapCalendar([buildVevent({ uid: 'p1', summary: 'Plain', dtstart: '20260914T100000Z', dtend: '20260914T110000Z' })]);
    mockClient.fetchCalendarObjects.mockResolvedValue([{ url: `${TEST_CALENDAR.url}p1.ics`, etag: 'e', data: ics }]);

    const events = await caldav.listEvents({ calendarId: TEST_CALENDAR.url, startDate: '2026-09-01T00:00:00Z', endDate: '2026-09-30T00:00:00Z' });

    expect(events[0].id).toBe(`${TEST_CALENDAR.url}p1.ics`);
  });

  it('gives a RECURRENCE-ID-based id to an expanded occurrence, correct even though the master starts in January', async () => {
    const caldav = await freshCaldav();
    const ics = wrapCalendar([
      buildVevent({
        uid: 'r1',
        summary: 'Weekly',
        dtstart: '20260914T100000Z',
        dtend: '20260914T110000Z',
        recurrenceId: '20260914T100000Z',
      }),
    ]);
    mockClient.fetchCalendarObjects.mockResolvedValue([{ url: `${TEST_CALENDAR.url}r1.ics`, etag: 'e', data: ics }]);

    const events = await caldav.listEvents({ calendarId: TEST_CALENDAR.url, startDate: '2026-09-01T00:00:00Z', endDate: '2026-09-30T00:00:00Z' });

    expect(events[0].id).toBe(`${TEST_CALENDAR.url}r1.ics#2026-09-14T10:00:00.000Z`);
    expect(events[0].start).toBe('2026-09-14T10:00:00.000Z');
  });

  it('excludes cancelled occurrences', async () => {
    const caldav = await freshCaldav();
    const ics = wrapCalendar([
      buildVevent({
        uid: 'c1',
        summary: 'Cancelled instance',
        dtstart: '20260914T100000Z',
        dtend: '20260914T110000Z',
        recurrenceId: '20260914T100000Z',
        status: 'CANCELLED',
      }),
    ]);
    mockClient.fetchCalendarObjects.mockResolvedValue([{ url: `${TEST_CALENDAR.url}c1.ics`, etag: 'e', data: ics }]);

    const events = await caldav.listEvents({ calendarId: TEST_CALENDAR.url, startDate: '2026-09-01T00:00:00Z', endDate: '2026-09-30T00:00:00Z' });

    expect(events).toHaveLength(0);
  });

  it('returns exactly one event for a window containing a single occurrence', async () => {
    const caldav = await freshCaldav();
    const ics = wrapCalendar([
      buildVevent({ uid: 's1', summary: 'Solo', dtstart: '20260914T100000Z', dtend: '20260914T110000Z', recurrenceId: '20260914T100000Z' }),
    ]);
    mockClient.fetchCalendarObjects.mockResolvedValue([{ url: `${TEST_CALENDAR.url}s1.ics`, etag: 'e', data: ics }]);

    const events = await caldav.listEvents({ calendarId: TEST_CALENDAR.url, startDate: '2026-09-14T00:00:00Z', endDate: '2026-09-15T00:00:00Z' });

    expect(events).toHaveLength(1);
  });

  it('rejects a range longer than 366 days', async () => {
    const caldav = await freshCaldav();
    await expect(
      caldav.listEvents({ calendarId: TEST_CALENDAR.url, startDate: '2026-01-01T00:00:00Z', endDate: '2028-01-01T00:00:00Z' }),
    ).rejects.toThrow(/366-day maximum/);
  });

  it('rejects an inverted range', async () => {
    const caldav = await freshCaldav();
    await expect(
      caldav.listEvents({ calendarId: TEST_CALENDAR.url, startDate: '2026-09-30T00:00:00Z', endDate: '2026-09-01T00:00:00Z' }),
    ).rejects.toThrow(/must be before/);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run test/lib/caldav.test.ts`
Expected: FAIL — current `parseEventObjects` uses positional `#<index>` ids and doesn't filter cancelled instances; `listEvents` has no range cap.

- [ ] **Step 3: Add `isCancelledVevent`, `recurrenceIdIso`, and update `parseEventObjects`/`listEvents` in `lib/caldav.ts`**

Add near `isRecurringVevent`:

```typescript
function isCancelledVevent(vevent: ICAL.Component): boolean {
  const status = vevent.getFirstPropertyValue('status') as string | null;
  return status === 'CANCELLED';
}

function recurrenceIdIso(vevent: ICAL.Component): string | null {
  const recurrenceId = vevent.getFirstPropertyValue('recurrence-id') as ICAL.Time | null;
  return recurrenceId ? recurrenceId.toJSDate().toISOString() : null;
}

const MAX_LIST_EVENTS_RANGE_DAYS = 366;
```

Replace `parseEventObjects`:

```typescript
function parseEventObjects(obj: { url: string; data: string }): EventSummary[] {
  const jcal = ICAL.parse(obj.data);
  const comp = new ICAL.Component(jcal);
  const vevents = comp.getAllSubcomponents('vevent').filter((v) => !isCancelledVevent(v));
  return vevents.map((vevent) => {
    const recId = recurrenceIdIso(vevent);
    const id = recId ? `${obj.url}#${recId}` : obj.url;
    return summarizeVevent(vevent, id);
  });
}
```

Replace `listEvents`:

```typescript
export async function listEvents(params: ListEventsParams): Promise<EventSummary[]> {
  const client = await getClient();
  const calendar = await findCalendar(params.calendarId);
  const startDate = parseRequiredDateTime(params.startDate, 'start_date');
  const endDate = parseRequiredDateTime(params.endDate, 'end_date');
  assertStartBeforeEnd(startDate, endDate);
  const rangeDays = (endDate.getTime() - startDate.getTime()) / (24 * 60 * 60 * 1000);
  if (rangeDays > MAX_LIST_EVENTS_RANGE_DAYS) {
    throw new Error(`Date range exceeds the ${MAX_LIST_EVENTS_RANGE_DAYS}-day maximum for list_events; narrow the range.`);
  }
  const objects = await client.fetchCalendarObjects({
    calendar,
    timeRange: { start: startDate.toISOString(), end: endDate.toISOString() },
    expand: true,
  });
  return objects.flatMap((obj) => parseEventObjects({ url: obj.url, data: obj.data ?? '' }));
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `npx vitest run test/lib/caldav.test.ts`
Expected: PASS, all cases.

- [ ] **Step 5: Typecheck**

Run: `npx tsc -p tsconfig.json --noEmit`
Expected: no errors.

- [ ] **Step 6: Commit**

```bash
git add lib/caldav.ts test/lib/caldav.test.ts
git commit -m "Use RECURRENCE-ID-based occurrence identifiers, exclude cancelled
instances, cap list_events range at 366 days

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>"
```

---

### Task 7: `get_event` occurrence resolution (direct fetch, expand fallback, legacy-id rejection)

**Files:**
- Modify: `lib/caldav.ts` (replace `getEvent`, add `findVeventByRecurrenceId`, `eventDetailFromVevent`, `isIsoDateTime`)
- Modify: `test/lib/caldav.test.ts`

**Interfaces:**
- Consumes: `parseRequiredDateTime` (Task 2), `recurrenceIdIso`/`isCancelledVevent` (Task 6), `baseObjectUrl` (existing).
- Produces: `getEvent(params: GetEventParams): Promise<EventDetail>` — same exported signature, new resolution behaviour for `#`-suffixed ids.

- [ ] **Step 1: Write the failing tests**

Append to `test/lib/caldav.test.ts`:

```typescript
describe('getEvent occurrence resolution', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockClient.fetchCalendars.mockResolvedValue([TEST_CALENDAR]);
  });

  it('resolves an overridden (moved) occurrence via direct fetch, matching what list_events would show', async () => {
    const caldav = await freshCaldav();
    const objUrl = `${TEST_CALENDAR.url}m1.ics`;
    const ics = wrapCalendar([
      buildVevent({ uid: 'm1', summary: 'Master (January)', dtstart: '20260112T100000Z', dtend: '20260112T110000Z', rrule: 'FREQ=WEEKLY;COUNT=40' }),
      buildVevent({
        uid: 'm1',
        summary: 'Moved occurrence',
        dtstart: '20260915T140000Z',
        dtend: '20260915T150000Z',
        recurrenceId: '20260914T100000Z',
        location: 'Room 2',
        description: 'Moved a day and an hour later',
      }),
    ]);
    mockClient.fetchCalendarObjects.mockResolvedValue([{ url: objUrl, etag: 'e', data: ics }]);

    const event = await caldav.getEvent({ calendarId: TEST_CALENDAR.url, eventId: `${objUrl}#2026-09-14T10:00:00.000Z` });

    expect(event.title).toBe('Moved occurrence');
    expect(event.start).toBe('2026-09-15T14:00:00.000Z');
    expect(event.location).toBe('Room 2');
    expect(event.notes).toBe('Moved a day and an hour later');
    // Only the direct (non-expand) fetch should have been needed.
    expect(mockClient.fetchCalendarObjects).toHaveBeenCalledTimes(1);
  });

  it('resolves a non-overridden virtual occurrence via the expand fallback', async () => {
    const caldav = await freshCaldav();
    const objUrl = `${TEST_CALENDAR.url}v1.ics`;
    const masterOnly = wrapCalendar([
      buildVevent({ uid: 'v1', summary: 'Master', dtstart: '20260112T100000Z', dtend: '20260112T110000Z', rrule: 'FREQ=WEEKLY;COUNT=40' }),
    ]);
    const expandedInstance = wrapCalendar([
      buildVevent({ uid: 'v1', summary: 'Master', dtstart: '20260914T100000Z', dtend: '20260914T110000Z', recurrenceId: '20260914T100000Z' }),
    ]);
    mockClient.fetchCalendarObjects
      .mockResolvedValueOnce([{ url: objUrl, etag: 'e', data: masterOnly }]) // direct fetch: no override present
      .mockResolvedValueOnce([{ url: objUrl, etag: 'e', data: expandedInstance }]); // expand fallback

    const event = await caldav.getEvent({ calendarId: TEST_CALENDAR.url, eventId: `${objUrl}#2026-09-14T10:00:00.000Z` });

    expect(event.start).toBe('2026-09-14T10:00:00.000Z');
    expect(mockClient.fetchCalendarObjects).toHaveBeenCalledTimes(2);
  });

  it('throws an explicit error for an excluded (EXDATE) occurrence, never falling back to the master', async () => {
    const caldav = await freshCaldav();
    const objUrl = `${TEST_CALENDAR.url}x1.ics`;
    const masterOnly = wrapCalendar([
      buildVevent({ uid: 'x1', summary: 'Master', dtstart: '20260112T100000Z', dtend: '20260112T110000Z', rrule: 'FREQ=WEEKLY;COUNT=40' }),
    ]);
    mockClient.fetchCalendarObjects
      .mockResolvedValueOnce([{ url: objUrl, etag: 'e', data: masterOnly }])
      .mockResolvedValueOnce([]); // excluded: expand returns nothing for this instant

    await expect(
      caldav.getEvent({ calendarId: TEST_CALENDAR.url, eventId: `${objUrl}#2026-09-14T10:00:00.000Z` }),
    ).rejects.toThrow(/could not be resolved/);
  });

  it('rejects a legacy positional identifier with an explicit error', async () => {
    const caldav = await freshCaldav();
    await expect(
      caldav.getEvent({ calendarId: TEST_CALENDAR.url, eventId: `${TEST_CALENDAR.url}legacy.ics#2` }),
    ).rejects.toThrow(/deprecated format/);
    expect(mockClient.fetchCalendarObjects).not.toHaveBeenCalled();
  });

  it('still resolves a plain (non-recurring) event by URL with no suffix', async () => {
    const caldav = await freshCaldav();
    const ics = wrapCalendar([buildVevent({ uid: 'p2', summary: 'Plain', dtstart: '20260914T100000Z', dtend: '20260914T110000Z' })]);
    mockClient.fetchCalendarObjects.mockResolvedValue([{ url: `${TEST_CALENDAR.url}p2.ics`, etag: 'e', data: ics }]);

    const event = await caldav.getEvent({ calendarId: TEST_CALENDAR.url, eventId: `${TEST_CALENDAR.url}p2.ics` });

    expect(event.title).toBe('Plain');
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run test/lib/caldav.test.ts`
Expected: FAIL — current `getEvent` strips the suffix and returns the master via `parseEventObject`.

- [ ] **Step 3: Replace `getEvent` in `lib/caldav.ts`**

Find the existing `getEvent` function and replace it, adding the new helper functions alongside it:

```typescript
function isIsoDateTime(value: string): boolean {
  try {
    parseRequiredDateTime(value, '_');
    return true;
  } catch {
    return false;
  }
}

function findVeventByRecurrenceId(icsData: string, recurrenceIdIsoTarget: string): ICAL.Component | null {
  const jcal = ICAL.parse(icsData);
  const comp = new ICAL.Component(jcal);
  return (
    comp
      .getAllSubcomponents('vevent')
      .filter((v) => !isCancelledVevent(v))
      .find((v) => recurrenceIdIso(v) === recurrenceIdIsoTarget) ?? null
  );
}

function eventDetailFromVevent(vevent: ICAL.Component, id: string): EventDetail {
  const summary = summarizeVevent(vevent, id);
  const notes = (vevent.getFirstPropertyValue('description') as string | null) ?? undefined;
  return { ...summary, notes };
}

export async function getEvent(params: GetEventParams): Promise<EventDetail> {
  const client = await getClient();
  const calendar = await findCalendar(params.calendarId);
  const hashIndex = params.eventId.indexOf('#');

  if (hashIndex === -1) {
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

  const baseUrl = params.eventId.slice(0, hashIndex);
  const recurrenceIdRaw = params.eventId.slice(hashIndex + 1);
  if (!isIsoDateTime(recurrenceIdRaw)) {
    throw new Error(
      `Event identifier "${params.eventId}" uses a deprecated format; call list_events again to get a current identifier.`,
    );
  }

  // Step 1: an overridden/moved occurrence is stored as its own VEVENT
  // component inside the object itself, at its real current time — a direct
  // fetch finds it correctly regardless of where it moved to. A CalDAV
  // time-range query filters on the occurrence's *current* time, not its
  // RECURRENCE-ID, so querying around the original slot would miss a move.
  const directObjects = await client.fetchCalendarObjects({ calendar, objectUrls: [baseUrl] });
  const directObj = directObjects[0];
  if (directObj?.data) {
    const match = findVeventByRecurrenceId(directObj.data, recurrenceIdRaw);
    if (match) return eventDetailFromVevent(match, params.eventId);
  }

  // Step 2: no override component — a non-overridden ("virtual") instance
  // that only materializes through server-side expansion, occurring by
  // definition exactly at its RECURRENCE-ID time.
  const target = new Date(recurrenceIdRaw);
  const windowEnd = new Date(target.getTime() + 60_000);
  const expanded = await client.fetchCalendarObjects({
    calendar,
    timeRange: { start: target.toISOString(), end: windowEnd.toISOString() },
    expand: true,
  });
  for (const obj of expanded) {
    if (!obj.data) continue;
    const match = findVeventByRecurrenceId(obj.data, recurrenceIdRaw);
    if (match) return eventDetailFromVevent(match, params.eventId);
  }

  throw new Error(`Occurrence ${params.eventId} could not be resolved — it may have been moved, cancelled, or excluded.`);
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `npx vitest run test/lib/caldav.test.ts`
Expected: PASS, all cases in the file.

- [ ] **Step 5: Typecheck**

Run: `npx tsc -p tsconfig.json --noEmit`
Expected: no errors.

- [ ] **Step 6: Run the full test suite and typecheck together**

Run: `npx vitest run && npx tsc -p tsconfig.json --noEmit`
Expected: all tests across `test/lib/caldav-dates.test.ts` and `test/lib/caldav.test.ts` pass; no type errors.

- [ ] **Step 7: Commit**

```bash
git add lib/caldav.ts test/lib/caldav.test.ts
git commit -m "Fix get_event occurrence resolution: direct fetch then expand
fallback, explicit errors for unresolved/legacy/excluded occurrences

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>"
```

---

### Task 8: Update tool descriptions and README

**Files:**
- Modify: `tools/calendar.ts`
- Modify: `README.md`

**Interfaces:**
- Consumes: nothing new (text-only changes).
- Produces: nothing consumed by later tasks — this is the last task in this plan.

- [ ] **Step 1: Update `list_events`'s description in `tools/calendar.ts`**

Find the `list_events` tool registration and update its `description`:

```typescript
description:
  'Lists event summaries (title, start/end, location, whether it has attendees, whether it is part of a recurring series) in a calendar within a date range. The date range cannot exceed 366 days.',
```

- [ ] **Step 2: Update `get_event`'s description**

Find the `get_event` tool registration and update its `description`:

```typescript
description:
  'Returns full details for one event or occurrence. An occurrence identifier that no longer resolves (moved, cancelled, or excluded) returns an explicit error rather than the wrong event.',
```

- [ ] **Step 3: Update `update_event`'s description**

Find the `update_event` tool registration and update its `description` (extends the wording already added in the previous fix round):

```typescript
description:
  'Updates fields on an existing event. Only include the fields that are changing. Never adds attendees or sends invitations. Rejects events that already have attendees/an organizer (to avoid triggering meeting-update notifications), events that are part of a recurring series (not yet supported), and attempts to set timed values on an all-day event.',
```

- [ ] **Step 4: Typecheck**

Run: `npx tsc -p tsconfig.json --noEmit`
Expected: no errors.

- [ ] **Step 5: Update README's tool table**

In `README.md`, find the Calendar (CalDAV) table row for `list_events` and update its description cell to: `List events in a calendar within a date range (max 366 days); occurrence identifiers are stable and resolve to the exact occurrence`. Find the `get_event` row and update to: `Get full details for one event or occurrence (explicit error if the occurrence can no longer be resolved)`.

- [ ] **Step 6: Run the full test suite one more time**

Run: `npx vitest run`
Expected: PASS, all tests.

- [ ] **Step 7: Commit**

```bash
git add tools/calendar.ts README.md
git commit -m "Update tool descriptions and README for recurrence/occurrence fixes

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>"
```
