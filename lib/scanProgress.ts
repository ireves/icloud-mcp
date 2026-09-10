import { getRedis } from './moveLog.js';

const PROGRESS_KEY_PREFIX = 'mail:scan-progress:';
const PENDING_FLAGGED_KEY_PREFIX = 'mail:pending-flagged:';

function progressKey(folder: string): string {
  return `${PROGRESS_KEY_PREFIX}${folder}`;
}

function pendingFlaggedKey(folder: string): string {
  return `${PENDING_FLAGGED_KEY_PREFIX}${folder}`;
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
