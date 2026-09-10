import { getRedis } from './moveLog.js';

const PROGRESS_KEY_PREFIX = 'mail:scan-progress:';

function progressKey(folder: string): string {
  return `${PROGRESS_KEY_PREFIX}${folder}`;
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
