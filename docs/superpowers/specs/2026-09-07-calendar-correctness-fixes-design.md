# Calendar correctness & recurrence safety fixes — Design (Phase A)

## Purpose

A second security/code review of `icloud-mcp` (commit `984088e`) found that the recurrence and date-handling fixes from the first review pass were incomplete: `isRecurringVevent` misses `RDATE`, occurrence identifiers are positional and can resolve to the wrong event, date validation lets JavaScript silently roll invalid calendar dates forward, and `update_event` can emit an invalid iCalendar object (`DURATION` + `DTEND` together). This is Phase A of a four-phase response to that review: A (this spec — calendar correctness), B (Trash/Junk mailbox destination policy), C (durable undo for mail moves), D (read-only mode / rate limiting and safety controls). Phases B–D are specified and built separately, each with its own design doc.

Scope: `lib/caldav.ts`, `lib/types.ts`, `tools/calendar.ts`, plus a new test suite. No new infrastructure.

## Recurrence detection and editing safeguards

`isRecurringVevent(vevent)` currently checks `RRULE` and `RECURRENCE-ID`. It gains an `RDATE` check:

```ts
function isRecurringVevent(vevent: ICAL.Component): boolean {
  return (
    Boolean(vevent.getFirstProperty('rrule')) ||
    Boolean(vevent.getFirstProperty('recurrence-id')) ||
    Boolean(vevent.getFirstProperty('rdate'))
  );
}
```

A parsed calendar object can contain multiple `VEVENT` components: the recurring master plus one override per changed occurrence. `updateEvent` currently only inspects `comp.getFirstSubcomponent('vevent')`. It will instead inspect **every** `VEVENT` in the object before permitting a write:

```ts
function anyVeventIsRecurring(vevents: ICAL.Component[]): boolean {
  return vevents.some(isRecurringVevent);
}
function anyVeventIsScheduling(vevents: ICAL.Component[]): boolean {
  return vevents.some(isSchedulingObject);
}
```

`updateEvent` fetches the object, collects `comp.getAllSubcomponents('vevent')`, and rejects (before any write) if either check is true across the whole set — an override component can carry its own `ATTENDEE`/`RECURRENCE-ID` even when the master doesn't.

## Occurrence identifiers

**Problem:** `list_events` currently expands recurring events server-side (via CalDAV `expand`) and assigns positional ids like `<url>#2`. `get_event` strips the suffix and re-fetches the object without `expand`, returning the master's own `DTSTART`/`DTEND` — silently wrong for any occurrence whose date differs from the master.

**Fix:** CalDAV's `expand` REPORT attaches a `RECURRENCE-ID` to every returned instance, including ones that were never individually overridden — the server synthesizes it to equal that instance's occurrence start. This is a stable identity we can re-resolve later, unlike a list position.

- `id` becomes `<url>#<RECURRENCE-ID-as-ISO-8601>` for any object that expanded to more than one component; a genuinely non-recurring object keeps a plain `<url>` id.
- `get_event(eventId)`:
  1. Split `eventId` on `#`. No suffix → existing single-fetch-by-URL path, unchanged.
  2. Suffix present → validate it parses as an ISO 8601 date-time (via the same strict parser as Phase A's date validation, below). If it doesn't parse (e.g. it's a small integer — the old positional format), throw `"This event identifier uses a deprecated format; call list_events again to get a current identifier."` This makes the legacy-id case a hard, explicit error rather than a wrong-answer.
  3. **Step 1 — direct fetch:** fetch the object by its base URL (no expand). A moved/overridden occurrence is stored as its own `VEVENT` component with this `RECURRENCE-ID` *inside the object itself*, at its real current time — scanning the object's components directly finds it correctly regardless of where it moved to. (A CalDAV time-range query filters on the occurrence's *current* time, not its `RECURRENCE-ID`, so querying a window around the original slot would miss a moved occurrence — this is why the direct fetch has to come first.)
  4. **Step 2 — expand fallback:** if no component in the direct fetch carries that `RECURRENCE-ID`, this is a non-overridden ("virtual") instance that only materializes through server-side expansion — and, having never been overridden, it occurs by definition exactly at its `RECURRENCE-ID` time. Re-query with `fetchCalendarObjects({ calendar, timeRange: { start: recurrenceId, end: recurrenceId + 1 minute }, expand: true })` and match on `RECURRENCE-ID` again.
  5. No match in either step → explicit `"Occurrence <id> could not be resolved — it may have been moved, cancelled, or excluded."` Never fall back to the master.
- `STATUS:CANCELLED` instances are filtered out of `list_events` results entirely (a cancelled occurrence isn't really "on" the calendar). Requesting one directly via `get_event` (if a stale id is reused) hits the same "could not be resolved" path, since the cancelled instance won't be returned by a fresh non-cancelled-filtered query — this needs the resolution query in step 3 to apply the same cancelled-filter as listing, so a cancelled occurrence's id never resolves.
- **Bounding:** `list_events` now rejects `end_date - start_date > 366 days` with a clear error (`"Date range exceeds the 366-day maximum for list_events; narrow the range."`), which bounds both the CalDAV query and the expansion cost. This is also where `start_date < end_date` is enforced for this tool specifically (createEvent already has the equivalent check via `assertStartBeforeEnd`).

## Date validation

`parseRequiredDateTime` currently regex-checks syntax, then trusts `new Date(value)` — which silently rolls `2026-02-30` forward to `2026-03-02`. It's replaced with a validator that reconstructs the parsed year/month/day/hour/minute/second via `Date.UTC` and compares the result back against the input, rejecting any mismatch:

```ts
function parseRequiredDateTime(value: string, fieldName: string): Date {
  const match = value.match(
    /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2}))?(?:\.\d+)?(Z|[+-]\d{2}:\d{2})$/,
  );
  if (!match) {
    throw new Error(`${fieldName} must be an ISO 8601 date-time with an explicit UTC "Z" or timezone offset, got: "${value}"`);
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
  // Reconstruct in UTC from the parsed components (ignoring the offset, which
  // only shifts the instant, never the calendar date being validated) and
  // compare back — this is what catches 30 February / 31 April / Feb 29 in a
  // non-leap year, which `new Date()` would otherwise silently roll forward.
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
```

The actual returned `Date` still comes from `new Date(value)`, so a valid explicit offset continues to produce the correct instant — only the calendar-date *components* are re-validated, not the instant math.

Applied consistently: `createEvent` (start/end), `updateEvent` (start/end, merged with the effective current values — see below), `listEvents` (start/end, plus the new range-length check), `createReminder` (due date).

**All-day vs timed:** `create_event`/`update_event` only ever accept full date-times (no separate all-day input mode — out of scope to add one). If `update_event` targets an event whose `DTSTART` is `VALUE=DATE` (all-day) and the caller supplies `start_time`/`end_time`, that's an unsupported all-day↔timed conversion: reject with an explicit error before writing, per the same principle as the recurring/scheduling rejections.

## DURATION and DTEND

Two related bugs: (1) updating `end_time` on an event that uses `DURATION` (valid per RFC 5545 — a `VEVENT` has `DTEND` *or* `DURATION`, never both) currently adds a `DTEND` alongside the existing `DURATION`, producing an invalid object; (2) the "current end" used for start/end validation reads `DTEND` directly, which is `undefined` for a `DURATION`-based or implicit-end event, silently disabling that validation.

```ts
function getEffectiveEnd(vevent: ICAL.Component): ICAL.Time | null {
  const dtend = vevent.getFirstPropertyValue('dtend') as ICAL.Time | null;
  if (dtend) return dtend;
  const dtstart = vevent.getFirstPropertyValue('dtstart') as ICAL.Time | null;
  if (!dtstart) return null;
  const duration = vevent.getFirstPropertyValue('duration') as ICAL.Duration | null;
  if (duration) return dtstart.clone().addDuration(duration);
  // RFC 5545 §3.6.1: with neither DTEND nor DURATION, a DATE-TIME DTSTART's
  // implicit end equals DTSTART; a DATE (all-day) DTSTART's implicit end is
  // DTSTART + 1 day.
  if (dtstart.isDate) {
    const end = dtstart.clone();
    end.day += 1;
    return end;
  }
  return dtstart.clone();
}
```

`updateEvent` uses `getEffectiveEnd` (not raw `getFirstPropertyValue('dtend')`) to compute the current end for merge/validation. When writing a new end value, it always removes any existing `duration` property first:

```ts
if (params.endTime !== undefined && newEnd) {
  vevent.removeProperty('duration');
  vevent.updatePropertyWithValue('dtend', ICAL.Time.fromJSDate(newEnd, true));
}
```

**Stale TZID:** writing a UTC-converted value (`ICAL.Time.fromJSDate(date, true)`) must not leave a `TZID` parameter from the property's previous value. After each `updatePropertyWithValue('dtstart'/'dtend'/'due', ...)` call with a UTC value, the corresponding property object has its `tzid` parameter explicitly removed:

```ts
vevent.getFirstProperty('dtstart')?.removeParameter('tzid');
```

Existing behaviour already preserves unrelated properties (the full parsed component is mutated in place and re-serialized, not reconstructed from scratch) and already uses `etag`-based concurrency (`updateCalendarObject` passes the fetched `etag`) — no change needed there.

## Testing

No test framework exists in this project yet. Adding **Vitest** (fast, native ESM/TS support, no extra config beyond a `vitest.config.ts`) as a dev dependency, with tests in `test/lib/caldav.test.ts` and `test/lib/caldav-dates.test.ts`, run via `npm test`. `tsdav`'s `createDAVClient` is not called in tests — instead, the internal parsing/validation helpers (`parseRequiredDateTime`, `isRecurringVevent`, `isSchedulingObject`, `getEffectiveEnd`, occurrence-id parsing) are exported for direct unit testing, and the higher-level functions (`listEvents`, `getEvent`, `updateEvent`) are tested against a mocked `tsdav` client (via `vi.mock('tsdav')`) returning synthetic ICS fixtures — no real network or iCloud credentials involved.

Covered per the review's request: RDATE-only recurrence, RRULE recurrence, recurrence exceptions (override component with its own `RECURRENCE-ID`), attendee/organizer fields present only on a non-first component, an ordinary editable personal event (control case — must still succeed), an occurrence listed for 14 September resolving correctly even though the master starts in January, occurrence ids across different query windows, overridden occurrences, excluded (`EXDATE`) occurrences, a window containing exactly one occurrence, 30 February, 31 April, valid/invalid leap days, malformed offsets, valid positive/negative offsets, inverted ranges, duration-based events, start-only updates, end-only updates, all-day events, and events with `TZID` parameters — asserting no submitted `VEVENT` string contains both `DURATION` and `DTEND`.

## Out of scope for this phase

Trash/Junk mailbox policy, durable undo, rate limiting/read-only mode, and their tests are Phases B–D, specified separately.
