-- The deployment-wide write switch, moved out of the environment and into the operator panel.
--
-- It lived in GSC_ALLOW_WRITE, which had a flaw beyond the inconvenience of needing a redeploy:
-- one variable governed BOTH surfaces. Setting it to arm the operator's own single-account
-- connector also armed the tenant-side server switch -- and a tenant controls their own
-- allow_write from their dashboard, so a tenant could then grant themselves writes the operator
-- never intended. Two products sharing a process should not share this.
--
-- Now:
--   operator connector (/<MCP_SECRET>/mcp)  <- GSC_ALLOW_WRITE, unchanged. It has no database.
--   tenant connectors  (/c/<token>/mcp)     <- this row, AND the account's own allow_write.
--
-- Still two switches, both still defaulting false. What changed is which hand reaches the first
-- one: the operator panel, gated by ADMIN_EMAILS, which is itself an environment variable. The
-- authority is still rooted in something only whoever controls the server can set.
--
-- Recorded with who and when, because arming writes across every account on a deployment is not
-- a preference. `remove_property` drops a property out of Search Console along with its history
-- and re-adding it needs ownership verification again.
do $$
begin
  if to_regclass('public.gsc_accounts') is null then
    raise exception 'Apply db/schema.sql first — this migration extends it.';
  end if;
end $$;

create table if not exists public.gsc_settings (
  -- A singleton. The CHECK is what makes it one: a second row cannot be inserted, so no code path
  -- anywhere has to decide which row is "the" settings row.
  id                  boolean primary key default true,
  constraint gsc_settings_singleton check (id),

  allow_write         boolean     not null default false,
  allow_write_by      text,
  allow_write_at      timestamptz,

  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now()
);

comment on table public.gsc_settings is
  'Deployment-wide operator settings, one row. Reached only by the ADMIN_EMAILS-gated operator panel and by the server itself; never exposed to a signed-in tenant.';
comment on column public.gsc_settings.allow_write is
  'The server half of the two-switch write gate for TENANT connectors, AND-ed with gsc_accounts.allow_write in tenants.ts. Both must be true. The operator connector reads GSC_ALLOW_WRITE from the environment instead and ignores this.';

insert into public.gsc_settings (id) values (true) on conflict (id) do nothing;

-- Operator-only, and RLS with no policies is how that is said: the server connects as the service
-- role and bypasses RLS, and every other role is refused by default rather than by a rule someone
-- has to remember to write. The revokes say it a second time for PostgREST, which is the surface
-- a published anon key and curl meet at.
alter table public.gsc_settings enable row level security;
revoke all on public.gsc_settings from authenticated, anon;
