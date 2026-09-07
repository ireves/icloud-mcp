import { Redis } from '@upstash/redis';
import { randomUUID } from 'node:crypto';

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`${name} is not set`);
  }
  return value;
}

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
export const DEFAULT_LIST_LIMIT = 20;
export const MAX_LIST_LIMIT = 100;

const OP_KEY_PREFIX = 'move:op:';
const INDEX_KEY = 'move:by-time';
const LOCK_KEY_PREFIX = 'move:lock:';

let cachedClient: Redis | null = null;

export function getRedis(): Redis {
  if (cachedClient) return cachedClient;
  cachedClient = new Redis({
    // Vercel's Upstash marketplace integration names these KV_REST_API_* —
    // not UPSTASH_REDIS_REST_* — regardless of the underlying Upstash product.
    url: requireEnv('KV_REST_API_URL'),
    token: requireEnv('KV_REST_API_TOKEN'),
  });
  return cachedClient;
}

function opKey(operationId: string): string {
  return `${OP_KEY_PREFIX}${operationId}`;
}

async function writeRecord(record: MoveOperationRecord): Promise<void> {
  const redis = getRedis();
  await redis.set(opKey(record.id), JSON.stringify(record));
  await redis.expire(opKey(record.id), OPERATION_TTL_SECONDS);
}

export async function createPendingOperation(params: CreatePendingOperationParams): Promise<string> {
  const id = randomUUID();
  const createdAt = Date.now();
  const record: MoveOperationRecord = {
    id,
    status: 'pending',
    sourcePath: params.sourcePath,
    sourceUid: params.sourceUid,
    sourceUidValidity: params.sourceUidValidity.toString(),
    destPath: params.destPath,
    destUid: null,
    destUidValidity: null,
    identity: params.identity,
    createdAt,
    confirmedAt: null,
    error: null,
    undoOf: params.undoOf ?? null,
    undoneBy: null,
  };
  await writeRecord(record);
  const redis = getRedis();
  await redis.zadd(INDEX_KEY, { score: createdAt, member: id });
  return id;
}

export async function getOperation(operationId: string): Promise<MoveOperationRecord | null> {
  const redis = getRedis();
  const raw = await redis.get(opKey(operationId));
  if (!raw) return null;
  return (typeof raw === 'string' ? JSON.parse(raw) : raw) as MoveOperationRecord;
}

async function updateRecord(operationId: string, patch: Partial<MoveOperationRecord>): Promise<void> {
  const existing = await getOperation(operationId);
  if (!existing) {
    throw new Error(`Move operation ${operationId} not found or has expired.`);
  }
  await writeRecord({ ...existing, ...patch });
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
  const redis = getRedis();
  const limit = Math.min(params.limit ?? DEFAULT_LIST_LIMIT, MAX_LIST_LIMIT);
  const start = params.cursor ?? 0;
  // Reverse-chronological: highest score (most recent) first.
  const ids = (await redis.zrange(INDEX_KEY, start, start + limit - 1, { rev: true })) as string[];
  const operations: MoveOperationRecord[] = [];
  for (const id of ids) {
    const record = await getOperation(id);
    if (record) {
      operations.push(record);
    } else {
      await redis.zrem(INDEX_KEY, id);
    }
  }
  const nextCursor = ids.length === limit ? start + limit : null;
  return { operations, nextCursor };
}

export async function acquireUndoLock(operationId: string): Promise<boolean> {
  const redis = getRedis();
  const result = await redis.set(`${LOCK_KEY_PREFIX}${operationId}`, '1', { nx: true, ex: 30 });
  return result === 'OK';
}

export async function releaseUndoLock(operationId: string): Promise<void> {
  const redis = getRedis();
  await redis.del(`${LOCK_KEY_PREFIX}${operationId}`);
}
