import { createClient, type SupabaseClient } from '@supabase/supabase-js';

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`${name} is not set`);
  }
  return value;
}

/**
 * The full-access key, under either of the names it goes by. A project
 * created through Vercel's Supabase integration supplies SUPABASE_SECRET_KEY
 * (an `sb_secret_...` key); a project set up by hand, and anything older,
 * supplies SUPABASE_SERVICE_ROLE_KEY. The two behave the same here, so
 * whichever is present is used.
 */
export const SECRET_KEY_ENV_NAMES = ['SUPABASE_SECRET_KEY', 'SUPABASE_SERVICE_ROLE_KEY'] as const;

function requireSecretKey(): string {
  for (const name of SECRET_KEY_ENV_NAMES) {
    const value = process.env[name];
    if (value) return value;
  }
  throw new Error(`Neither ${SECRET_KEY_ENV_NAMES.join(' nor ')} is set`);
}

let cachedClient: SupabaseClient | null = null;

/**
 * The Supabase client used for all durable server-side state. It talks to
 * PostgREST over HTTPS rather than holding a Postgres connection open, which
 * is what makes it safe to construct per serverless invocation.
 *
 * The key it uses bypasses row level security. That is deliberate: these
 * tables carry no RLS policies, so the server is the only thing that can
 * reach them. The key must never be exposed to a client.
 */
export function getSupabase(): SupabaseClient {
  if (cachedClient) return cachedClient;
  cachedClient = createClient(
    // Vercel's Supabase integration provisions SUPABASE_URL automatically
    // when the integration is connected to the project.
    requireEnv('SUPABASE_URL'),
    requireSecretKey(),
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
