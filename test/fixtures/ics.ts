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
