-- One connector for every property, instead of one connector per property.
--
-- `property` was always only a DEFAULT: tools.ts falls back to it when siteUrl is omitted, and
-- nothing anywhere filters by it, so a connector could always reach every property its Google
-- account can see. The dashboard was the restriction — it refused to mint a connector URL until a
-- property was chosen, so somebody with twenty properties concluded they needed twenty connectors.
--
-- Opening that up needs a THIRD state, and it needs its own column rather than a sentinel in
-- `property`, because null already means something:
--
--   property is not null                        -> that property is the default
--   property is null and all_properties         -> no default; every call names its own siteUrl
--   property is null and not all_properties     -> nobody has chosen yet
--
-- Collapsing the last two would repeat this codebase's most expensive recurring bug: a day with
-- zero impressions and a day never synced, an empty property list and a refused call. Two facts
-- that share a representation become one fact nobody can recover.
do $$
begin
  if to_regclass('public.gsc_accounts') is null then
    raise exception 'Apply db/schema.sql first — this migration extends it.';
  end if;
end $$;

alter table public.gsc_accounts
  add column if not exists all_properties boolean not null default false;

comment on column public.gsc_accounts.all_properties is
  'True when this connector deliberately has no default property and every tool call names its own siteUrl. Distinct from property IS NULL alone, which means nobody has chosen yet. Never widens access on its own: what a connector can reach is what the consented Google account can reach, with or without this.';

-- The dashboard view gains it, so a client can tell "all properties" from "not set up yet".
-- Still no last_error and no quota_project: those stay operator-facing.
drop view if exists public.gsc_account_status;
create view public.gsc_account_status
  with (security_invoker = true) as
select id, user_id, label, google_email, property, all_properties, status, allow_write, last_checked_at, created_at
from public.gsc_accounts
where deleted_at is null;

grant select on public.gsc_account_status to authenticated;
