import { createClient, type SupabaseClient } from '@supabase/supabase-js';

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`${name} is not set`);
  }
  return value;
}

let cachedClient: SupabaseClient | null = null;

/**
 * The Supabase client used for all durable server-side state. It talks to
 * PostgREST over HTTPS rather than holding a Postgres connection open, which
 * is what makes it safe to construct per serverless invocation.
 *
 * The service role key bypasses row level security. That is deliberate: these
 * tables carry no RLS policies, so the server is the only thing that can
 * reach them. The key must never be exposed to a client.
 */
export function getSupabase(): SupabaseClient {
  if (cachedClient) return cachedClient;
  cachedClient = createClient(
    // Vercel's Supabase marketplace integration provisions these names
    // automatically when the integration is connected to the project.
    requireEnv('SUPABASE_URL'),
    requireEnv('SUPABASE_SERVICE_ROLE_KEY'),
    { auth: { persistSession: false, autoRefreshToken: false } },
  );
  return cachedClient;
}

export interface SupabaseErrorLike {
  message: string;
  code?: string;
}

/** Turns a PostgREST error into a thrown Error naming what was being done. */
export function failQuery(action: string, error: SupabaseErrorLike | null): never {
  throw new Error(`${action} failed: ${error?.message ?? 'unknown database error'}`);
}

/** Postgres SQLSTATE for a unique or primary key violation. */
export const UNIQUE_VIOLATION = '23505';
