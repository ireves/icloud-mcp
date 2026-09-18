import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createMockSupabaseClient, type RecordedQuery } from './supabase-mock-client.js';

const supabase = vi.hoisted(async () => {
  const { createMockSupabaseClient: create } = await import('./supabase-mock-client.js');
  return { client: create() };
});

vi.mock('../../lib/supabase.js', async () => {
  const actual = await import('../../lib/supabase.js');
  const holder = await supabase;
  return {
    ...actual,
    getSupabase: vi.fn(() => holder.client),
  };
});

const PROGRESS = 'scan_progress';
const MAX_LISTED = 'max_listed_uids';
const PENDING_FLAGGED = 'pending_flagged_uids';

let client: ReturnType<typeof createMockSupabaseClient>;

function filterValue(query: RecordedQuery | undefined, kind: string, column: string): unknown {
  return query?.filters.find(([k, c]) => k === kind && c === column)?.[2];
}

function upsertValues(table: string): Record<string, unknown> {
  const args = client.lastCall(table, 'upsert')?.args as { values: Record<string, unknown> };
  return args.values;
}

async function freshScanProgress() {
  vi.resetModules();
  return import('../../lib/scanProgress.js');
}

beforeEach(async () => {
  client = (await supabase).client;
  client.reset();
});

describe('getMaxListedUid', () => {
  it('reads the folder row and ignores one past its 24-hour window', async () => {
    const scanProgress = await freshScanProgress();
    const before = Date.now();
    client.queueData(MAX_LISTED, 'select', { uid: 120 });

    expect(await scanProgress.getMaxListedUid('INBOX')).toBe(120);

    const query = client.lastCall(MAX_LISTED, 'select');
    expect(filterValue(query, 'eq', 'folder')).toBe('INBOX');
    const cutoff = Date.parse(filterValue(query, 'gt', 'expires_at') as string);
    expect(cutoff).toBeGreaterThanOrEqual(before);
    expect(cutoff).toBeLessThanOrEqual(Date.now());
  });

  it('returns null when no record survives', async () => {
    const scanProgress = await freshScanProgress();
    client.queueData(MAX_LISTED, 'select', null);
    expect(await scanProgress.getMaxListedUid('INBOX')).toBeNull();
  });
});

describe('recordMaxListedUid', () => {
  it('writes a higher UID with a fresh 24-hour window', async () => {
    const scanProgress = await freshScanProgress();
    const before = Date.now();
    client.queueData(MAX_LISTED, 'select', { uid: 100 });

    await scanProgress.recordMaxListedUid('INBOX', 120);

    const values = upsertValues(MAX_LISTED);
    expect(values.folder).toBe('INBOX');
    expect(values.uid).toBe(120);
    const ttlMs = scanProgress.MAX_LISTED_TTL_SECONDS * 1000;
    expect(Date.parse(values.expires_at as string)).toBeGreaterThanOrEqual(before + ttlMs);
  });

  it('keeps the existing UID but refreshes the window when the new one is lower', async () => {
    const scanProgress = await freshScanProgress();
    client.queueData(MAX_LISTED, 'select', { uid: 120 });

    await scanProgress.recordMaxListedUid('INBOX', 90);

    expect(upsertValues(MAX_LISTED).uid).toBe(120);
  });

  it('writes the UID when there is no surviving record', async () => {
    const scanProgress = await freshScanProgress();
    client.queueData(MAX_LISTED, 'select', null);

    await scanProgress.recordMaxListedUid('INBOX', 12);

    expect(upsertValues(MAX_LISTED).uid).toBe(12);
  });

  it('writes nothing for a UID that is not a finite number', async () => {
    const scanProgress = await freshScanProgress();

    await scanProgress.recordMaxListedUid('INBOX', Number.NaN);

    expect(client.callsFor(MAX_LISTED, 'upsert')).toHaveLength(0);
  });
});

describe('scan progress mark', () => {
  it('reads the mark for a folder', async () => {
    const scanProgress = await freshScanProgress();
    client.queueData(PROGRESS, 'select', { last_seen_uid: 100 });

    expect(await scanProgress.getLastSeenUid('INBOX')).toBe(100);
    expect(filterValue(client.lastCall(PROGRESS, 'select'), 'eq', 'folder')).toBe('INBOX');
  });

  it('returns null when a folder has never been marked', async () => {
    const scanProgress = await freshScanProgress();
    client.queueData(PROGRESS, 'select', null);
    expect(await scanProgress.getLastSeenUid('INBOX')).toBeNull();
  });

  it('advances the mark forwards', async () => {
    const scanProgress = await freshScanProgress();
    client.queueData(PROGRESS, 'select', { last_seen_uid: 100 });

    await scanProgress.advanceLastSeenUid('INBOX', 120);

    expect(upsertValues(PROGRESS)).toEqual({ folder: 'INBOX', last_seen_uid: 120 });
  });

  it('sets the first mark for a folder that has none', async () => {
    const scanProgress = await freshScanProgress();
    client.queueData(PROGRESS, 'select', null);

    await scanProgress.advanceLastSeenUid('INBOX', 42);

    expect(upsertValues(PROGRESS)).toEqual({ folder: 'INBOX', last_seen_uid: 42 });
  });

  it('never moves the mark backwards', async () => {
    const scanProgress = await freshScanProgress();
    client.queueData(PROGRESS, 'select', { last_seen_uid: 120 });

    await scanProgress.advanceLastSeenUid('INBOX', 90);

    expect(client.callsFor(PROGRESS, 'upsert')).toHaveLength(0);
  });

  it('does not rewrite the mark when the UID matches it exactly', async () => {
    const scanProgress = await freshScanProgress();
    client.queueData(PROGRESS, 'select', { last_seen_uid: 120 });

    await scanProgress.advanceLastSeenUid('INBOX', 120);

    expect(client.callsFor(PROGRESS, 'upsert')).toHaveLength(0);
  });
});

describe('pending flagged UIDs', () => {
  it('reads the stored list for a folder', async () => {
    const scanProgress = await freshScanProgress();
    client.queueData(PENDING_FLAGGED, 'select', { uids: [3, 1, 2] });

    expect(await scanProgress.getPendingFlaggedUids('INBOX')).toEqual([3, 1, 2]);
  });

  it('returns an empty list when the folder has no row', async () => {
    const scanProgress = await freshScanProgress();
    client.queueData(PENDING_FLAGGED, 'select', null);

    expect(await scanProgress.getPendingFlaggedUids('INBOX')).toEqual([]);
  });

  it('replaces the list wholesale', async () => {
    const scanProgress = await freshScanProgress();

    await scanProgress.setPendingFlaggedUids('INBOX', [5, 6]);

    expect(upsertValues(PENDING_FLAGGED)).toEqual({ folder: 'INBOX', uids: [5, 6] });
  });

  it('deletes the row rather than storing an empty list', async () => {
    const scanProgress = await freshScanProgress();

    await scanProgress.setPendingFlaggedUids('INBOX', []);

    expect(client.callsFor(PENDING_FLAGGED, 'upsert')).toHaveLength(0);
    expect(filterValue(client.lastCall(PENDING_FLAGGED, 'delete'), 'eq', 'folder')).toBe('INBOX');
  });
});

describe('database errors', () => {
  it('names what was being done', async () => {
    const scanProgress = await freshScanProgress();
    client.queueError(PROGRESS, 'select', { message: 'permission denied' });

    await expect(scanProgress.getLastSeenUid('INBOX')).rejects.toThrow(
      /Reading the scan progress mark failed: permission denied/,
    );
  });
});
