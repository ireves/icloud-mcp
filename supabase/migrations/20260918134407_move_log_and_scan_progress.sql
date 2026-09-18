-- Durable storage for move-undo tracking and mail scan progress.
-- Replaces the Upstash Redis keyspace that previously held the same data.

create extension if not exists pg_cron;

-- One row per logged move_message call. Reads always filter on expires_at, so
-- an operation past its 7-day retention is invisible even before the nightly
-- sweep deletes it. That matches the Redis TTL behaviour this replaces.
create table if not exists public.move_operations (
  id uuid primary key,
  status text not null check (status in ('pending', 'confirmed', 'failed', 'uncertain', 'undone')),
  source_path text not null,
  source_uid bigint not null,
  source_uid_validity text not null,
  dest_path text not null,
  dest_uid bigint,
  dest_uid_validity text,
  identity jsonb not null,
  created_at timestamptz not null,
  confirmed_at timestamptz,
  error text,
  undo_of uuid,
  undone_by uuid,
  expires_at timestamptz not null
);

create index if not exists move_operations_created_at_idx
  on public.move_operations (created_at desc);
create index if not exists move_operations_expires_at_idx
  on public.move_operations (expires_at);

-- Short-lived mutual exclusion for undo_move. The primary key is what makes
-- acquiring a lock atomic: while one caller holds the row, a second caller's
-- insert is rejected as a unique violation rather than quietly succeeding.
create table if not exists public.undo_locks (
  operation_id uuid primary key,
  expires_at timestamptz not null
);

-- Highest UID ever confirmed processed in a folder, across all past runs.
create table if not exists public.scan_progress (
  folder text primary key,
  last_seen_uid bigint not null
);

-- Highest UID actually returned from list_messages for a folder, kept for 24
-- hours. mark_scanned is checked against this, so the mark can only be moved
-- to somewhere the caller has been shown.
create table if not exists public.max_listed_uids (
  folder text primary key,
  uid bigint not null,
  expires_at timestamptz not null
);

-- UIDs that were flagged the last time a folder was scanned.
create table if not exists public.pending_flagged_uids (
  folder text primary key,
  uids bigint[] not null
);

-- The MCP server reaches these tables with the service role key, which
-- bypasses row level security. Enabling RLS with no policies attached means
-- nothing else can read or write them, including anyone holding the
-- publishable key.
alter table public.move_operations enable row level security;
alter table public.undo_locks enable row level security;
alter table public.scan_progress enable row level security;
alter table public.max_listed_uids enable row level security;
alter table public.pending_flagged_uids enable row level security;

-- Postgres has no per-row expiry of its own, so retention is swept nightly.
create or replace function public.purge_expired_storage()
returns void
language sql
security definer
set search_path = public, pg_temp
as $$
  delete from public.move_operations where expires_at <= now();
  delete from public.undo_locks where expires_at <= now();
  delete from public.max_listed_uids where expires_at <= now();
$$;

revoke all on function public.purge_expired_storage() from public, anon, authenticated;

select cron.unschedule('purge-expired-icloud-mcp-storage')
where exists (select 1 from cron.job where jobname = 'purge-expired-icloud-mcp-storage');

select cron.schedule(
  'purge-expired-icloud-mcp-storage',
  '17 3 * * *',
  $$select public.purge_expired_storage()$$
);
