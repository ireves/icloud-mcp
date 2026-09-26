import ICAL from 'ical.js';

// Builds iCalendar time zone data from the runtime's own IANA database
// (via Intl), since ical.js ships none. A repeating timed event must be
// anchored to a named zone; stored in UTC, "every Monday at 09:00" would
// drift by an hour across each daylight-saving change.

export function assertValidTimeZone(zone: string): void {
  try {
    new Intl.DateTimeFormat('en-GB', { timeZone: zone });
  } catch {
    throw new Error(`time_zone "${zone}" is not a recognised IANA time zone name, e.g. "Europe/London".`);
  }
}

const formatters = new Map<string, Intl.DateTimeFormat>();

function formatterFor(zone: string): Intl.DateTimeFormat {
  let formatter = formatters.get(zone);
  if (!formatter) {
    formatter = new Intl.DateTimeFormat('en-GB', {
      timeZone: zone,
      hourCycle: 'h23',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    });
    formatters.set(zone, formatter);
  }
  return formatter;
}

export interface WallClock {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
}

// The local date and time shown on a clock in `zone` at the instant `ms`.
export function wallClockAt(zone: string, ms: number): WallClock {
  const parts: Record<string, number> = {};
  for (const part of formatterFor(zone).formatToParts(new Date(ms))) {
    if (part.type !== 'literal') parts[part.type] = Number(part.value);
  }
  return {
    year: parts.year,
    month: parts.month,
    day: parts.day,
    hour: parts.hour,
    minute: parts.minute,
    second: parts.second,
  };
}

// Offset from UTC in minutes (e.g. 60 for BST) in `zone` at the instant `ms`.
export function offsetMinutesAt(zone: string, ms: number): number {
  const w = wallClockAt(zone, Math.floor(ms / 1000) * 1000);
  const asUtc = Date.UTC(w.year, w.month - 1, w.day, w.hour, w.minute, w.second);
  return Math.round((asUtc - Math.floor(ms / 1000) * 1000) / 60_000);
}

// The UTC instant at which a clock in `zone` shows the given local time.
export function wallClockToUtc(zone: string, w: WallClock): number {
  const naive = Date.UTC(w.year, w.month - 1, w.day, w.hour, w.minute, w.second);
  let guess = naive - offsetMinutesAt(zone, naive) * 60_000;
  guess = naive - offsetMinutesAt(zone, guess) * 60_000;
  return guess;
}

interface Transition {
  at: number;
  from: number;
  to: number;
}

const DAY_MS = 24 * 60 * 60 * 1000;

function transitionsInYear(zone: string, year: number): Transition[] {
  const transitions: Transition[] = [];
  const end = Date.UTC(year + 1, 0, 1);
  let prev = Date.UTC(year, 0, 1);
  let prevOffset = offsetMinutesAt(zone, prev);
  for (let t = prev + DAY_MS; t <= end; t += DAY_MS) {
    const offset = offsetMinutesAt(zone, t);
    if (offset !== prevOffset) {
      // Narrow the change down to the minute.
      let lo = prev;
      let hi = t;
      while (hi - lo > 60_000) {
        const mid = lo + Math.floor((hi - lo) / 120_000) * 60_000;
        if (offsetMinutesAt(zone, mid) === prevOffset) lo = mid;
        else hi = mid;
      }
      transitions.push({ at: hi, from: prevOffset, to: offset });
    }
    prev = t;
    prevOffset = offset;
  }
  return transitions;
}

const WEEKDAYS = ['SU', 'MO', 'TU', 'WE', 'TH', 'FR', 'SA'];

function observance(t: Transition, repeatYearly: boolean): ICAL.Component {
  const name = t.to > t.from ? 'daylight' : 'standard';
  const comp = new ICAL.Component(name);
  // DTSTART of an observance is the local time just before the change,
  // read in the offset being left.
  const local = new Date(t.at + t.from * 60_000);
  comp.updatePropertyWithValue(
    'dtstart',
    ICAL.Time.fromData({
      year: local.getUTCFullYear(),
      month: local.getUTCMonth() + 1,
      day: local.getUTCDate(),
      hour: local.getUTCHours(),
      minute: local.getUTCMinutes(),
      second: 0,
      isDate: false,
    }),
  );
  comp.updatePropertyWithValue('tzoffsetfrom', ICAL.UtcOffset.fromSeconds(t.from * 60));
  comp.updatePropertyWithValue('tzoffsetto', ICAL.UtcOffset.fromSeconds(t.to * 60));
  if (repeatYearly) {
    const day = local.getUTCDate();
    const daysInMonth = new Date(Date.UTC(local.getUTCFullYear(), local.getUTCMonth() + 1, 0)).getUTCDate();
    const nth = day + 7 > daysInMonth ? -1 : Math.ceil(day / 7);
    comp.updatePropertyWithValue(
      'rrule',
      ICAL.Recur.fromString(`FREQ=YEARLY;BYMONTH=${local.getUTCMonth() + 1};BYDAY=${nth}${WEEKDAYS[local.getUTCDay()]}`),
    );
  }
  return comp;
}

// A VTIMEZONE for `zone`, describing its rules as they stand in the year
// before `fromYear` onwards, so every occurrence from `fromYear` is covered.
export function buildVtimezone(zone: string, fromYear: number): ICAL.Component {
  const vtimezone = new ICAL.Component('vtimezone');
  vtimezone.updatePropertyWithValue('tzid', zone);
  const baseYear = fromYear - 1;
  const transitions = transitionsInYear(zone, baseYear);
  if (transitions.length === 0) {
    const offset = offsetMinutesAt(zone, Date.UTC(baseYear, 0, 1));
    const standard = new ICAL.Component('standard');
    standard.updatePropertyWithValue(
      'dtstart',
      ICAL.Time.fromData({ year: 1970, month: 1, day: 1, hour: 0, minute: 0, second: 0, isDate: false }),
    );
    standard.updatePropertyWithValue('tzoffsetfrom', ICAL.UtcOffset.fromSeconds(offset * 60));
    standard.updatePropertyWithValue('tzoffsetto', ICAL.UtcOffset.fromSeconds(offset * 60));
    vtimezone.addSubcomponent(standard);
    return vtimezone;
  }
  // Two changes a year is the regular daylight-saving pattern, which
  // repeats; anything else is a one-off change and is written as such.
  const repeatYearly = transitions.length === 2;
  for (const t of transitions) vtimezone.addSubcomponent(observance(t, repeatYearly));
  return vtimezone;
}
