import { failQuery, getSupabase } from './supabase.js';

export const SCAN_PROGRESS_TABLE = 'scan_progress';
export const MAX_LISTED_TABLE = 'max_listed_uids';
export const PENDING_FLAGGED_TABLE = 'pending_flagged_uids';

// Long enough to cover a scan that is interrupted and resumed later the same
// day, short enough that a stale mark does not licence a huge jump weeks on.
export const MAX_LISTED_TTL_SECONDS = 24 * 60 * 60;

function toUid(value: unknown): number | null {
  if (value === null || value === undefined) return null;
  const uid = Number(value);
  return Number.isFinite(uid) ? uid : null;
}

/**
 * The highest UID this server has actually returned from list_messages for a
 * folder in the last 24 hours, or null if it has returned none. This is what
 * mark_scanned is checked against: the mark can only be moved to somewhere the
 * caller has been shown.
 */
export async function getMaxListedUid(folder: string): Promise<number | null> {
  const { data, error } = await getSupabase()
    .from(MAX_LISTED_TABLE)
    .select('uid')
    // Postgres has no per-row expiry, so the 24-hour window is applied here as
    // well as by the nightly sweep. A lapsed record reads as absent.
    .gt('expires_at', new Date().toISOString())
    .eq('folder', folder)
    .maybeSingle();
  if (error) failQuery('Reading the listed-UID record', error);
  return data ? toUid((data as { uid: number }).uid) : null;
}

/** Records a newly-listed high-water mark, never moving it backwards. */
export async function recordMaxListedUid(folder: string, uid: number): Promise<void> {
  if (!Number.isFinite(uid)) return;
  const current = await getMaxListedUid(folder);
  // Same or lower, but the folder is still being listed, so the record is
  // rewritten with a fresh window rather than being left to lapse mid-scan.
  const nextUid = current === null || uid > current ? uid : current;
  const { error } = await getSupabase()
    .from(MAX_LISTED_TABLE)
    .upsert(
      {
        folder,
        uid: nextUid,
        expires_at: new Date(Date.now() + MAX_LISTED_TTL_SECONDS * 1000).toISOString(),
      },
      { onConflict: 'folder' },
    );
  if (error) failQuery('Recording the listed-UID record', error);
}

/** Highest UID ever confirmed processed in this folder, across all past runs. */
export async function getLastSeenUid(folder: string): Promise<number | null> {
  const { data, error } = await getSupabase()
    .from(SCAN_PROGRESS_TABLE)
    .select('last_seen_uid')
    .eq('folder', folder)
    .maybeSingle();
  if (error) failQuery('Reading the scan progress mark', error);
  return data ? toUid((data as { last_seen_uid: number }).last_seen_uid) : null;
}

/** Advances the high-water mark, never moving it backwards. */
export async function advanceLastSeenUid(folder: string, uid: number): Promise<void> {
  const current = await getLastSeenUid(folder);
  if (current !== null && uid <= current) return;
  const { error } = await getSupabase()
    .from(SCAN_PROGRESS_TABLE)
    .upsert({ folder, last_seen_uid: uid }, { onConflict: 'folder' });
  if (error) failQuery('Advancing the scan progress mark', error);
}

/**
 * UIDs that were flagged the last time this folder was scanned. Flagged
 * messages are excluded from the main since-last-run scan (so they never
 * block the high-water mark), and this set is how a later run notices one
 * was unflagged and needs to be picked back up for sorting.
 */
export async function getPendingFlaggedUids(folder: string): Promise<number[]> {
  const { data, error } = await getSupabase()
    .from(PENDING_FLAGGED_TABLE)
    .select('uids')
    .eq('folder', folder)
    .maybeSingle();
  if (error) failQuery('Reading the pending flagged UIDs', error);
  if (!data) return [];
  const uids = (data as { uids: unknown[] | null }).uids ?? [];
  return uids.map(Number).filter(Number.isFinite);
}

export async function setPendingFlaggedUids(folder: string, uids: number[]): Promise<void> {
  const supabase = getSupabase();
  if (uids.length === 0) {
    const { error } = await supabase.from(PENDING_FLAGGED_TABLE).delete().eq('folder', folder);
    if (error) failQuery('Clearing the pending flagged UIDs', error);
    return;
  }
  const { error } = await supabase
    .from(PENDING_FLAGGED_TABLE)
    .upsert({ folder, uids }, { onConflict: 'folder' });
  if (error) failQuery('Writing the pending flagged UIDs', error);
}
