-- Per-account write permission.
--
-- The server-wide GSC_ALLOW_WRITE is not enough on a deployment serving other people. whatsapp2ai
-- learned this with sending: one switch means turning it on for yourself turns it on for everyone,
-- and the blast radius here is a customer's property being removed from Search Console by an agent
-- that misread a sentence.
--
-- So: two switches, and BOTH must be on. The server's, and this one. Default false, like its
-- siblings' allow_send -- a connector that can read is useful on its own, and a connector that can
-- delete should be something somebody deliberately asked for.

do $$
begin
  if to_regclass('public.gsc_accounts') is null then
    raise exception 'Apply db/schema.sql first — this migration extends it.';
  end if;
end $$;

alter table public.gsc_accounts
  add column if not exists allow_write boolean not null default false;

comment on column public.gsc_accounts.allow_write is
  'Whether this account may submit/delete sitemaps, add/remove properties and call the Indexing API. AND-ed with the server-wide GSC_ALLOW_WRITE in tools.ts; both must be true. Server-written, via /api — never granted to clients, for the reason in schema.sql: an UPDATE policy constrains which ROW you may write, never which VALUE.';

-- The dashboard view gains it, so the toggle can render its current state. Still no last_error and
-- no quota_project: those stay operator-facing.
drop view if exists public.gsc_account_status;
create view public.gsc_account_status
  with (security_invoker = true) as
select id, user_id, label, google_email, property, status, allow_write, last_checked_at, created_at
from public.gsc_accounts
where deleted_at is null;

grant select on public.gsc_account_status to authenticated;
