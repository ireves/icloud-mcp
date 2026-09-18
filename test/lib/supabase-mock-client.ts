import { vi } from 'vitest';

export type QueryOp = 'select' | 'insert' | 'upsert' | 'update' | 'delete';

export interface QueryResult {
  data: unknown;
  error: { message: string; code?: string } | null;
}

export interface RecordedQuery {
  table: string;
  op: QueryOp;
  /** The values passed to insert/upsert/update, or the columns for select. */
  args: unknown;
  filters: Array<[string, string, unknown]>;
  order?: [string, unknown];
  range?: [number, number];
}

/**
 * Stands in for supabase-js. Its query builders are chainable and awaited at
 * the end, so each `from()` hands back an object whose filter methods return
 * itself and which resolves to whichever result the test queued for that
 * table and operation. Every call is recorded so tests can assert on the
 * query that was actually built.
 */
export function createMockSupabaseClient() {
  const calls: RecordedQuery[] = [];
  const queues = new Map<string, QueryResult[]>();

  const key = (table: string, op: QueryOp) => `${table}.${op}`;

  const from = vi.fn((table: string) => {
    const recorded: RecordedQuery = { table, op: 'select', args: undefined, filters: [] };
    let recordedOnce = false;

    const setOp = (op: QueryOp, args?: unknown) => {
      recorded.op = op;
      recorded.args = args;
      if (!recordedOnce) {
        calls.push(recorded);
        recordedOnce = true;
      }
      return chain;
    };

    const settle = (): QueryResult => {
      const queue = queues.get(key(table, recorded.op));
      return queue && queue.length > 0 ? queue.shift()! : { data: null, error: null };
    };

    const addFilter = (kind: string) => (column: string, value: unknown) => {
      recorded.filters.push([kind, column, value]);
      return chain;
    };

    const chain = {
      select: (columns?: string) => setOp('select', columns),
      insert: (values: unknown) => setOp('insert', values),
      upsert: (values: unknown, options?: unknown) => setOp('upsert', { values, options }),
      update: (values: unknown) => setOp('update', values),
      delete: () => setOp('delete'),
      eq: addFilter('eq'),
      gt: addFilter('gt'),
      gte: addFilter('gte'),
      lt: addFilter('lt'),
      lte: addFilter('lte'),
      order: (column: string, options?: unknown) => {
        recorded.order = [column, options];
        return chain;
      },
      range: (start: number, end: number) => {
        recorded.range = [start, end];
        return chain;
      },
      maybeSingle: () => Promise.resolve(settle()),
      single: () => Promise.resolve(settle()),
      // Awaiting the builder without a terminal method runs the query, which
      // is how insert, update and delete are used.
      then: (
        onFulfilled?: (value: QueryResult) => unknown,
        onRejected?: (reason: unknown) => unknown,
      ) => Promise.resolve(settle()).then(onFulfilled, onRejected),
    };

    return chain;
  });

  return {
    from,
    calls,
    /** Queues one result for the next query of this shape. */
    queue(table: string, op: QueryOp, result: QueryResult) {
      const existing = queues.get(key(table, op)) ?? [];
      existing.push(result);
      queues.set(key(table, op), existing);
    },
    queueData(table: string, op: QueryOp, data: unknown) {
      this.queue(table, op, { data, error: null });
    },
    queueError(table: string, op: QueryOp, error: { message: string; code?: string }) {
      this.queue(table, op, { data: null, error });
    },
    callsFor(table: string, op: QueryOp): RecordedQuery[] {
      return calls.filter((call) => call.table === table && call.op === op);
    },
    lastCall(table: string, op: QueryOp): RecordedQuery | undefined {
      return this.callsFor(table, op).at(-1);
    },
    reset() {
      calls.length = 0;
      queues.clear();
      from.mockClear();
    },
  };
}

export type MockSupabaseClient = ReturnType<typeof createMockSupabaseClient>;
