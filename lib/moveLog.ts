import { randomUUID } from 'node:crypto';
import { failQuery, getSupabase, UNIQUE_VIOLATION } from './supabase.js';

export type MoveOperationStatus = 'pending' | 'confirmed' | 'failed' | 'uncertain' | 'undone';

export interface MoveIdentity {
  messageId: string | null;
  date: string | null;
  subject: string | null;
}

export interface MoveOperationRecord {
  id: string;
  status: MoveOperationStatus;
  sourcePath: string;
  sourceUid: number;
  sourceUidValidity: string;
  destPath: string;
  destUid: number | null;
  destUidValidity: string | null;
  identity: MoveIdentity;
  createdAt: number;
  confirmedAt: number | null;
  error: string | null;
  undoOf: string | null;
  undoneBy: string | null;
}

export interface CreatePendingOperationParams {
  sourcePath: string;
  sourceUid: number;
  sourceUidValidity: bigint;
  destPath: string;
  identity: MoveIdentity;
  undoOf?: string;
}

export interface ListOperationsResult {
  operations: MoveOperationRecord[];
  nextCursor: number | null;
}

export const OPERATION_TTL_SECONDS = 7 * 24 * 60 * 60;
export const UNDO_LOCK_TTL_SECONDS = 30;
export const DEFAULT_LIST_LIMIT = 20;
export const MAX_LIST_LIMIT = 100;

export const OPERATIONS_TABLE = 'move_operations';
export const UNDO_LOCKS_TABLE = 'undo_locks';

/** The stored shape: snake_case columns, timestamps as ISO strings. */
interface MoveOperationRow {
  id: string;
  status: MoveOperationStatus;
  source_path: string;
  source_uid: number;
  source_uid_validity: string;
  dest_path: string;
  dest_uid: number | null;
  dest_uid_validity: string | null;
  identity: MoveIdentity;
  created_at: string;
  confirmed_at: string | null;
  error: string | null;
  undo_of: string | null;
  undone_by: string | null;
}

function toRecord(row: MoveOperationRow): MoveOperationRecord {
  return {
    id: row.id,
    status: row.status,
    sourcePath: row.source_path,
    sourceUid: Number(row.source_uid),
    sourceUidValidity: row.source_uid_validity,
    destPath: row.dest_path,
    destUid: row.dest_uid === null ? null : Number(row.dest_uid),
    destUidValidity: row.dest_uid_validity,
    identity: row.identity,
    createdAt: Date.parse(row.created_at),
    confirmedAt: row.confirmed_at === null ? null : Date.parse(row.confirmed_at),
    error: row.error,
    undoOf: row.undo_of,
    undoneBy: row.undone_by,
  };
}

/** Only the columns a patch actually touches, so updates stay narrow. */
function toRowPatch(patch: Partial<MoveOperationRecord>): Record<string, unknown> {
  const row: Record<string, unknown> = {};
  if (patch.status !== undefined) row.status = patch.status;
  if (patch.destUid !== undefined) row.dest_uid = patch.destUid;
  if (patch.destUidValidity !== undefined) row.dest_uid_validity = patch.destUidValidity;
  if (patch.confirmedAt !== undefined) {
    row.confirmed_at = patch.confirmedAt === null ? null : new Date(patch.confirmedAt).toISOString();
  }
  if (patch.error !== undefined) row.error = patch.error;
  if (patch.undoneBy !== undefined) row.undone_by = patch.undoneBy;
  return row;
}

export async function createPendingOperation(params: CreatePendingOperationParams): Promise<string> {
  const id = randomUUID();
  const createdAt = new Date();
  const { error } = await getSupabase()
    .from(OPERATIONS_TABLE)
    .insert({
      id,
      status: 'pending',
      source_path: params.sourcePath,
      source_uid: params.sourceUid,
      source_uid_validity: params.sourceUidValidity.toString(),
      dest_path: params.destPath,
      dest_uid: null,
      dest_uid_validity: null,
      identity: params.identity,
      created_at: createdAt.toISOString(),
      confirmed_at: null,
      error: null,
      undo_of: params.undoOf ?? null,
      undone_by: null,
      expires_at: new Date(createdAt.getTime() + OPERATION_TTL_SECONDS * 1000).toISOString(),
    });
  if (error) failQuery('Recording the move operation', error);
  return id;
}

export async function getOperation(operationId: string): Promise<MoveOperationRecord | null> {
  const { data, error } = await getSupabase()
    .from(OPERATIONS_TABLE)
    .select('*')
    // Postgres does not expire rows on its own, so retention is enforced on
    // read as well as by the nightly sweep. An operation past its 7 days
    // reads as absent either way.
    .gt('expires_at', new Date().toISOString())
    .eq('id', operationId)
    .maybeSingle();
  if (error) failQuery('Reading the move operation', error);
  return data ? toRecord(data as MoveOperationRow) : null;
}

async function updateRecord(operationId: string, patch: Partial<MoveOperationRecord>): Promise<void> {
  const existing = await getOperation(operationId);
  if (!existing) {
    throw new Error(`Move operation ${operationId} not found or has expired.`);
  }
  const { error } = await getSupabase()
    .from(OPERATIONS_TABLE)
    .update(toRowPatch(patch))
    .eq('id', operationId);
  if (error) failQuery('Updating the move operation', error);
}

export async function markConfirmed(
  operationId: string,
  params: { destUid: number; destUidValidity: bigint },
): Promise<void> {
  await updateRecord(operationId, {
    status: 'confirmed',
    destUid: params.destUid,
    destUidValidity: params.destUidValidity.toString(),
    confirmedAt: Date.now(),
  });
}

export async function markFailed(operationId: string, error: string): Promise<void> {
  await updateRecord(operationId, { status: 'failed', error });
}

export async function markUncertain(operationId: string, error: string): Promise<void> {
  await updateRecord(operationId, { status: 'uncertain', error });
}

export async function markUndone(operationId: string, undoneByOperationId: string): Promise<void> {
  await updateRecord(operationId, { status: 'undone', undoneBy: undoneByOperationId });
}

export async function listOperations(
  params: { limit?: number; cursor?: number } = {},
): Promise<ListOperationsResult> {
  const limit = Math.min(params.limit ?? DEFAULT_LIST_LIMIT, MAX_LIST_LIMIT);
  const start = params.cursor ?? 0;
  const { data, error } = await getSupabase()
    .from(OPERATIONS_TABLE)
    .select('*')
    .gt('expires_at', new Date().toISOString())
    // Reverse-chronological: most recent first.
    .order('created_at', { ascending: false })
    .range(start, start + limit - 1);
  if (error) failQuery('Listing move operations', error);
  const rows = (data ?? []) as MoveOperationRow[];
  const nextCursor = rows.length === limit ? start + limit : null;
  return { operations: rows.map(toRecord), nextCursor };
}

export async function acquireUndoLock(operationId: string): Promise<boolean> {
  const supabase = getSupabase();
  const now = new Date();
  // Clear a lock whose holder never released it, then claim the slot. Only the
  // insert needs to be atomic, and the primary key makes it so: a second
  // caller arriving while the first still holds the row is rejected outright.
  const { error: clearError } = await supabase
    .from(UNDO_LOCKS_TABLE)
    .delete()
    .lte('expires_at', now.toISOString())
    .eq('operation_id', operationId);
  if (clearError) failQuery('Clearing a stale undo lock', clearError);

  const { error } = await supabase.from(UNDO_LOCKS_TABLE).insert({
    operation_id: operationId,
    expires_at: new Date(now.getTime() + UNDO_LOCK_TTL_SECONDS * 1000).toISOString(),
  });
  if (!error) return true;
  if (error.code === UNIQUE_VIOLATION) return false;
  failQuery('Acquiring the undo lock', error);
}

export async function releaseUndoLock(operationId: string): Promise<void> {
  const { error } = await getSupabase()
    .from(UNDO_LOCKS_TABLE)
    .delete()
    .eq('operation_id', operationId);
  if (error) failQuery('Releasing the undo lock', error);
}
