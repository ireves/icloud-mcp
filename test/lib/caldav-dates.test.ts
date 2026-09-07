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
