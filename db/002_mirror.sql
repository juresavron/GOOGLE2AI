-- The Search Console mirror.
--
-- WHY A MIRROR AT ALL. Two reasons, and only one of them is speed:
--
--   1. GOOGLE DELETES THE HISTORY. Search Console keeps 16 months and then the data is gone — not
--      archived, gone. A site that has been running for three years cannot answer "how did last
--      spring compare to the one before" from Google at all, and never will be able to again. Every
--      day this mirror runs is a day of history that outlives Google's window.
--   2. The API allows roughly 1200 queries per minute per project, shared by every tenant on the
--      deployment. An answer served from here costs none of it.
--
-- WHAT IT IS NOT: a copy of everything. Search Console itself caps a query at 25000 rows and
-- samples below a threshold, so a "complete" mirror is not a thing that exists. This stores the
-- grouped rows that were actually asked for, per day, and records exactly which (day, grouping)
-- pairs have been fetched — because a day with genuinely zero clicks and a day that was never
-- synced look identical in a rows table, and answering from the first while believing the second
-- is how a mirror starts lying.

do $$
begin
  if to_regclass('public.gsc_accounts') is null then
    raise exception 'Apply db/schema.sql first — this migration extends it.';
  end if;
end $$;

-- ---------------------------------------------------------------- rows

create table if not exists public.gsc_rows (
  account_id  uuid not null references public.gsc_accounts(id) on delete cascade,
  day         date not null,

  -- The grouping these numbers are FOR, as the comma-joined dimension list that produced them
  -- ("query", "page", "query,page"). Rows from different groupings are not comparable and must
  -- never be summed together: the same clicks appear once per grouping.
  dims        text not null,
  -- The dimension values, in the order `dims` names them. An array rather than columns because the
  -- grouping is chosen per sync, and a column per possible dimension would be mostly null and would
  -- need a migration every time Search Console adds one.
  keys        text[] not null,

  clicks      integer not null,
  impressions integer not null,
  -- Stored, not derived: it is an average Google computed over data we do not have, so it cannot be
  -- recomputed from clicks and impressions.
  position    real not null,

  -- (account, day, dims, keys) is the natural key and arrays work in a primary key, which is what
  -- makes the upsert in store.ts a plain ON CONFLICT rather than a delete-then-insert.
  primary key (account_id, day, dims, keys)
);

-- The read path: one account, one grouping, a date range.
create index if not exists gsc_rows_read_idx on public.gsc_rows (account_id, dims, day);

-- ---------------------------------------------------------------- what has actually been fetched

create table if not exists public.gsc_sync (
  account_id uuid not null references public.gsc_accounts(id) on delete cascade,
  day        date not null,
  dims       text not null,
  -- How many rows that fetch returned. Zero is a real, useful answer -- a day with no impressions --
  -- and is why this table exists separately from gsc_rows.
  rows       integer not null default 0,
  -- Search Console keeps revising the last few days after first publishing them, so a day synced
  -- inside the lag window is provisional and gets re-fetched later. This is how store.ts knows.
  final      boolean not null default false,
  synced_at  timestamptz not null default now(),
  primary key (account_id, day, dims)
);

create index if not exists gsc_sync_stale_idx on public.gsc_sync (account_id, dims, day) where not final;

-- ---------------------------------------------------------------- row level security

alter table public.gsc_rows enable row level security;
alter table public.gsc_sync enable row level security;

-- Readable by the owner, same shape as everything else here. Written only by the server, as the
-- service role -- a tenant who could write these could fabricate their own history.
drop policy if exists gsc_rows_select on public.gsc_rows;
create policy gsc_rows_select on public.gsc_rows
  for select using (exists (select 1 from public.gsc_accounts a where a.id = account_id and a.user_id = auth.uid()));

drop policy if exists gsc_sync_select on public.gsc_sync;
create policy gsc_sync_select on public.gsc_sync
  for select using (exists (select 1 from public.gsc_accounts a where a.id = account_id and a.user_id = auth.uid()));

revoke insert, update, delete on public.gsc_rows, public.gsc_sync from authenticated, anon;
-- TRUNCATE is not subject to RLS and Supabase grants it by default: without this revoke, any
-- signed-in user could erase every tenant's accumulated history -- the one thing here that cannot
-- be re-fetched, because Google has already deleted its copy.
revoke truncate, trigger, references on public.gsc_rows, public.gsc_sync from authenticated, anon;
