-- A folder's UIDs only mean anything within one UIDVALIDITY. If the mail
-- server resets a folder's numbering, every stored UID stops referring to
-- anything, and a scan mark left over from before would silently skip mail.
-- Recording the numbering alongside each mark lets a stale one be spotted.
--
-- Nullable on purpose: rows written before this column existed cannot have
-- their numbering established after the fact, so null means "unknown, do not
-- verify" rather than a value that would falsely match or falsely differ.
alter table public.scan_progress add column if not exists uid_validity text;
alter table public.max_listed_uids add column if not exists uid_validity text;

comment on column public.scan_progress.uid_validity is
  'The folder UIDVALIDITY that last_seen_uid belongs to. Null means it was recorded before this was tracked and cannot be verified.';
comment on column public.max_listed_uids.uid_validity is
  'The folder UIDVALIDITY that uid belongs to. Null means it was recorded before this was tracked and cannot be verified.';
