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
 * A folder's UIDVALIDITY, as the mail server reports it, or null when it could
 * not be read. UIDs are only meaningful within one UIDVALIDITY: if the server
 * resets a folder's numbering, every stored UID stops referring to anything.
 */
export type UidValidity = string | null;

/**
 * Whether a stored record belongs to a numbering the folder has since left
 * behind, which makes the UID in it meaningless.
 *
 * A null on either side means there is nothing to compare. Stored null is a
 * record written before this was tracked; a null argument means the caller
 * could not read the folder's current value. Neither is treated as stale,
 * because wrongly discarding a mark restarts a scan from the beginning of the
 * folder, and the checks in markScanned still bound what can be marked.
 */
function isStaleNumbering(stored: string | null, current: UidValidity): boolean {
  if (stored === null || current === null) return false;
  return stored !== current;
}

/**
 * The highest UID this server has actually returned from list_messages for a
 * folder in the last 24 hours, or null if it has returned none. This is what
 * mark_scanned is checked against: the mark can only be moved to somewhere the
 * caller has been shown.
 */
export async function getMaxListedUid(
  folder: string,
  uidValidity: UidValidity = null,
): Promise<number | null> {
  const { data, error } = await getSupabase()
    .from(MAX_LISTED_TABLE)
    .select('uid, uid_validity')
    // Postgres has no per-row expiry, so the 24-hour window is applied here as
    // well as by the nightly sweep. A lapsed record reads as absent.
    .gt('expires_at', new Date().toISOString())
    .eq('folder', folder)
    .maybeSingle();
  if (error) failQuery('Reading the listed-UID record', error);
  if (!data) return null;
  const row = data as { uid: number; uid_validity: string | null };
  if (isStaleNumbering(row.uid_validity, uidValidity)) return null;
  return toUid(row.uid);
}

/** Records a newly-listed high-water mark, never moving it backwards. */
export async function recordMaxListedUid(
  folder: string,
  uid: number,
  uidValidity: UidValidity = null,
): Promise<void> {
  if (!Number.isFinite(uid)) return;
  // Reading with the same uidValidity means a record from an older numbering
  // comes back as null, so the write below replaces it outright.
  const current = await getMaxListedUid(folder, uidValidity);
  // Same or lower, but the folder is still being listed, so the record is
  // rewritten with a fresh window rather than being left to lapse mid-scan.
  const nextUid = current === null || uid > current ? uid : current;
  const { error } = await getSupabase()
    .from(MAX_LISTED_TABLE)
    .upsert(
      {
        folder,
        uid: nextUid,
        uid_validity: uidValidity,
        expires_at: new Date(Date.now() + MAX_LISTED_TTL_SECONDS * 1000).toISOString(),
      },
      { onConflict: 'folder' },
    );
  if (error) failQuery('Recording the listed-UID record', error);
}

/** Highest UID ever confirmed processed in this folder, across all past runs. */
export async function getLastSeenUid(
  folder: string,
  uidValidity: UidValidity = null,
): Promise<number | null> {
  const { data, error } = await getSupabase()
    .from(SCAN_PROGRESS_TABLE)
    .select('last_seen_uid, uid_validity')
    .eq('folder', folder)
    .maybeSingle();
  if (error) failQuery('Reading the scan progress mark', error);
  if (!data) return null;
  const row = data as { last_seen_uid: number; uid_validity: string | null };
  if (isStaleNumbering(row.uid_validity, uidValidity)) return null;
  return toUid(row.last_seen_uid);
}

/** Advances the high-water mark, never moving it backwards. */
export async function advanceLastSeenUid(
  folder: string,
  uid: number,
  uidValidity: UidValidity = null,
): Promise<void> {
  // A mark left over from an older numbering reads as null here, so the write
  // below replaces it instead of being held back by a number that no longer
  // refers to anything.
  const current = await getLastSeenUid(folder, uidValidity);
  if (current !== null && uid <= current) return;
  const { error } = await getSupabase()
    .from(SCAN_PROGRESS_TABLE)
    .upsert({ folder, last_seen_uid: uid, uid_validity: uidValidity }, { onConflict: 'folder' });
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
