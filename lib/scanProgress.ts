import { getRedis } from './moveLog.js';

const PROGRESS_KEY_PREFIX = 'mail:scan-progress:';
const PENDING_FLAGGED_KEY_PREFIX = 'mail:pending-flagged:';
const MAX_LISTED_KEY_PREFIX = 'mail:max-listed-uid:';

// Long enough to cover a scan that is interrupted and resumed later the same
// day, short enough that a stale mark does not licence a huge jump weeks on.
const MAX_LISTED_TTL_SECONDS = 24 * 60 * 60;

function progressKey(folder: string): string {
  return `${PROGRESS_KEY_PREFIX}${folder}`;
}

function pendingFlaggedKey(folder: string): string {
  return `${PENDING_FLAGGED_KEY_PREFIX}${folder}`;
}

function maxListedKey(folder: string): string {
  return `${MAX_LISTED_KEY_PREFIX}${folder}`;
}

/**
 * The highest UID this server has actually returned from list_messages for a
 * folder in the last 24 hours, or null if it has returned none. This is what
 * mark_scanned is checked against: the mark can only be moved to somewhere the
 * caller has been shown.
 */
export async function getMaxListedUid(folder: string): Promise<number | null> {
  const redis = getRedis();
  const value = await redis.get(maxListedKey(folder));
  if (value === null || value === undefined) return null;
  const uid = Number(value);
  return Number.isFinite(uid) ? uid : null;
}

/** Records a newly-listed high-water mark, never moving it backwards. */
export async function recordMaxListedUid(folder: string, uid: number): Promise<void> {
  if (!Number.isFinite(uid)) return;
  const redis = getRedis();
  const key = maxListedKey(folder);
  const current = await getMaxListedUid(folder);
  if (current === null || uid > current) {
    await redis.set(key, uid, { ex: MAX_LISTED_TTL_SECONDS });
    return;
  }
  // Same or lower, but the folder is still being listed, so keep the record
  // alive rather than letting it lapse mid-scan.
  await redis.expire(key, MAX_LISTED_TTL_SECONDS);
}

/** Highest UID ever confirmed processed in this folder, across all past runs. */
export async function getLastSeenUid(folder: string): Promise<number | null> {
  const redis = getRedis();
  const value = await redis.get(progressKey(folder));
  if (value === null || value === undefined) return null;
  const uid = Number(value);
  return Number.isFinite(uid) ? uid : null;
}

/** Advances the high-water mark, never moving it backwards. */
export async function advanceLastSeenUid(folder: string, uid: number): Promise<void> {
  const redis = getRedis();
  const current = await getLastSeenUid(folder);
  if (current !== null && uid <= current) return;
  await redis.set(progressKey(folder), uid);
}

/**
 * UIDs that were flagged the last time this folder was scanned. Flagged
 * messages are excluded from the main since-last-run scan (so they never
 * block the high-water mark), and this set is how a later run notices one
 * was unflagged and needs to be picked back up for sorting.
 */
export async function getPendingFlaggedUids(folder: string): Promise<number[]> {
  const redis = getRedis();
  const members = await redis.smembers(pendingFlaggedKey(folder));
  return members.map(Number).filter(Number.isFinite);
}

export async function setPendingFlaggedUids(folder: string, uids: number[]): Promise<void> {
  const redis = getRedis();
  const key = pendingFlaggedKey(folder);
  await redis.del(key);
  if (uids.length > 0) await redis.sadd(key, uids[0], ...uids.slice(1));
}
