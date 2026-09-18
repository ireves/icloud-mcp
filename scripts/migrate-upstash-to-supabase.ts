import 'dotenv/config';
import { Redis } from '@upstash/redis';
import { getSupabase } from '../lib/supabase.js';
import { OPERATION_TTL_SECONDS, type MoveOperationRecord } from '../lib/moveLog.js';

/**
 * Copies the durable state this server keeps from Upstash Redis into Supabase,
 * for a one-off move between the two. Nothing in Upstash is changed or
 * deleted, and the script can be run again safely: every write is an upsert.
 *
 *   npm run migrate:storage            # report what would be copied
 *   npm run migrate:storage -- --apply # actually copy it
 *
 * It needs the Upstash credentials (KV_REST_API_URL, KV_REST_API_TOKEN) as
 * well as the Supabase ones, so put all four in .env before running.
 */

const OP_KEY_PREFIX = 'move:op:';
const PROGRESS_KEY_PREFIX = 'mail:scan-progress:';
const PENDING_FLAGGED_KEY_PREFIX = 'mail:pending-flagged:';
const MAX_LISTED_KEY_PREFIX = 'mail:max-listed-uid:';

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const apply = process.argv.includes('--apply');

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    console.error(`${name} is not set. Put the Upstash and Supabase credentials in .env first.`);
    process.exit(1);
  }
  return value;
}

const redis = new Redis({
  url: requireEnv('KV_REST_API_URL'),
  token: requireEnv('KV_REST_API_TOKEN'),
});

/** Walks the whole keyspace for one prefix, a page at a time. */
async function keysMatching(prefix: string): Promise<string[]> {
  const found: string[] = [];
  let cursor = '0';
  do {
    const [next, batch] = await redis.scan(cursor, { match: `${prefix}*`, count: 200 });
    found.push(...batch);
    cursor = String(next);
  } while (cursor !== '0');
  return found;
}

function folderFrom(key: string, prefix: string): string {
  return key.slice(prefix.length);
}

function parseRecord(raw: unknown): MoveOperationRecord | null {
  if (raw === null || raw === undefined) return null;
  try {
    return (typeof raw === 'string' ? JSON.parse(raw) : raw) as MoveOperationRecord;
  } catch {
    return null;
  }
}

const summary: string[] = [];
let skipped = 0;

async function copyMoveOperations(): Promise<void> {
  const keys = await keysMatching(OP_KEY_PREFIX);
  const now = Date.now();
  const rows = [];

  for (const key of keys) {
    const record = parseRecord(await redis.get(key));
    if (!record) {
      console.warn(`  skipped ${key}: could not be read as a move record`);
      skipped += 1;
      continue;
    }
    if (!UUID_PATTERN.test(record.id)) {
      console.warn(`  skipped ${key}: its id is not a UUID, which the new table requires`);
      skipped += 1;
      continue;
    }
    // The old store expired a record 7 days after it was created, so anything
    // already past that is not carried over.
    const expiresAt = record.createdAt + OPERATION_TTL_SECONDS * 1000;
    if (expiresAt <= now) {
      skipped += 1;
      continue;
    }
    rows.push({
      id: record.id,
      status: record.status,
      source_path: record.sourcePath,
      source_uid: record.sourceUid,
      source_uid_validity: record.sourceUidValidity,
      dest_path: record.destPath,
      dest_uid: record.destUid,
      dest_uid_validity: record.destUidValidity,
      identity: record.identity,
      created_at: new Date(record.createdAt).toISOString(),
      confirmed_at: record.confirmedAt === null ? null : new Date(record.confirmedAt).toISOString(),
      error: record.error,
      undo_of: UUID_PATTERN.test(record.undoOf ?? '') ? record.undoOf : null,
      undone_by: UUID_PATTERN.test(record.undoneBy ?? '') ? record.undoneBy : null,
      expires_at: new Date(expiresAt).toISOString(),
    });
  }

  summary.push(`move operations still undoable: ${rows.length}`);
  if (!apply || rows.length === 0) return;
  const { error } = await getSupabase().from('move_operations').upsert(rows, { onConflict: 'id' });
  if (error) throw new Error(`Copying move operations failed: ${error.message}`);
}

async function copyScanProgress(): Promise<void> {
  const keys = await keysMatching(PROGRESS_KEY_PREFIX);
  const rows = [];
  for (const key of keys) {
    const uid = Number(await redis.get(key));
    if (!Number.isFinite(uid)) {
      skipped += 1;
      continue;
    }
    rows.push({ folder: folderFrom(key, PROGRESS_KEY_PREFIX), last_seen_uid: uid });
  }

  summary.push(`folders with a scan position: ${rows.length}`);
  for (const row of rows) summary.push(`  ${row.folder} — scanned through UID ${row.last_seen_uid}`);
  if (!apply || rows.length === 0) return;
  const { error } = await getSupabase().from('scan_progress').upsert(rows, { onConflict: 'folder' });
  if (error) throw new Error(`Copying scan progress failed: ${error.message}`);
}

async function copyPendingFlagged(): Promise<void> {
  const keys = await keysMatching(PENDING_FLAGGED_KEY_PREFIX);
  const rows = [];
  for (const key of keys) {
    const members = await redis.smembers(key);
    const uids = members.map(Number).filter(Number.isFinite);
    if (uids.length === 0) continue;
    rows.push({ folder: folderFrom(key, PENDING_FLAGGED_KEY_PREFIX), uids });
  }

  summary.push(`folders with flagged messages held back: ${rows.length}`);
  if (!apply || rows.length === 0) return;
  const { error } = await getSupabase()
    .from('pending_flagged_uids')
    .upsert(rows, { onConflict: 'folder' });
  if (error) throw new Error(`Copying flagged UIDs failed: ${error.message}`);
}

async function copyMaxListed(): Promise<void> {
  const keys = await keysMatching(MAX_LISTED_KEY_PREFIX);
  const rows = [];
  for (const key of keys) {
    const uid = Number(await redis.get(key));
    // Whatever is left of the original 24 hours is carried over, so a mark
    // made just before the switch stays valid for as long as it would have.
    const remaining = Number(await redis.ttl(key));
    if (!Number.isFinite(uid) || !Number.isFinite(remaining) || remaining <= 0) {
      skipped += 1;
      continue;
    }
    rows.push({
      folder: folderFrom(key, MAX_LISTED_KEY_PREFIX),
      uid,
      expires_at: new Date(Date.now() + remaining * 1000).toISOString(),
    });
  }

  summary.push(`folders listed in the last 24 hours: ${rows.length}`);
  if (!apply || rows.length === 0) return;
  const { error } = await getSupabase().from('max_listed_uids').upsert(rows, { onConflict: 'folder' });
  if (error) throw new Error(`Copying listed-UID records failed: ${error.message}`);
}

async function main(): Promise<void> {
  console.log(apply ? 'Copying Upstash data into Supabase.\n' : 'Dry run. Nothing will be written.\n');

  await copyMoveOperations();
  await copyScanProgress();
  await copyPendingFlagged();
  await copyMaxListed();

  console.log(summary.join('\n'));
  if (skipped > 0) console.log(`\nleft behind (expired or unreadable): ${skipped}`);
  console.log(
    apply
      ? '\nDone. Nothing in Upstash was changed, so you can run this again if you need to.'
      : '\nRun again with --apply to copy this across.',
  );
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
