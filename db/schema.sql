-- GOOGLE2AI, multi-tenant schema. Supabase/Postgres, mirroring imap2ai's and whatsapp2ai's so the
-- three products are operated the same way -- same auth.users, same mcp_tokens model, same RLS
-- posture, same rule that a column the SERVER acts on is never client-writable.
--
-- WHERE THIS DIFFERS FROM ITS SIBLINGS, and why. Each difference is structural:
--
--   1. THERE IS A SECRETS TABLE, and it holds something worse than a mailbox password.
--      whatsapp2ai has none because a WhatsApp session is a Signal key store that cannot be put in
--      Postgres. imap2ai has one because an IMAP password is a string. A Google refresh token is
--      also a string -- so it is stored the same way, sealed by src/secrets.ts under MASTER_KEY --
--      but it is a worse thing to leak than a mailbox password on two counts: it is bearer-grade,
--      so no second factor applies to it, and using it is SILENT, where reading a mailbox at least
--      leaves a session in the account's own security log.
--
--   2. REVOKING ACCESS IS NOT LOCAL. Deleting a row here does not end Google's grant: the refresh
--      token keeps working until it is revoked at Google's endpoint or the owner withdraws consent.
--      This is whatsapp2ai's note 3 in a different costume -- a cascade delete would leave a live
--      credential with no owner and no UI to revoke it. Deletion is therefore a SERVER operation
--      that calls Google first; `deleted_at` is the tombstone that makes an interrupted delete
--      recoverable instead of an orphan.
--
--   3. THE SSRF CLASS IS ABSENT, as in whatsapp2ai. imap2ai's 003 migration exists because a
--      customer could PATCH imap_host and aim the server at 169.254.169.254. Google's endpoints are
--      constants, so there is no host, port or scheme column here to aim anywhere.

-- ---------------------------------------------------------------- preflight

-- REFUSE TO RUN ON A SIBLING'S DATABASE. mcp_tokens and mcp_calls exist in all three, and the
-- failure is silent rather than loud: `create table if not exists` would skip them, and the policy
-- statements below would then `drop policy` the sibling's working ones and recreate them joined to
-- gsc_accounts. Every one of that product's customers would see zero tokens and zero history,
-- immediately, with no error anywhere.
--
-- GOOGLE2AI therefore gets its OWN Supabase project. This guard makes that a rule the database
-- enforces rather than something a tired operator has to remember at 1am.
do $$
begin
  if to_regclass('public.mail_accounts') is not null then
    raise exception 'Refusing to apply: public.mail_accounts exists, so this looks like the imap2ai database. GOOGLE2AI needs its own Supabase project.';
  end if;
  if to_regclass('public.wa_accounts') is not null then
    raise exception 'Refusing to apply: public.wa_accounts exists, so this looks like the whatsapp2ai database. GOOGLE2AI needs its own Supabase project.';
  end if;
end $$;

-- ---------------------------------------------------------------- accounts

create table if not exists public.gsc_accounts (
  id            uuid primary key default gen_random_uuid(),
  user_id       uuid not null references auth.users(id) on delete cascade,

  label         text not null,                    -- "Ocenagor" -- the user's own name for it
  google_email  text,                             -- learned at consent, never entered by hand

  -- The property this connector is bound to, spelled as Search Console spells it. Null until the
  -- user picks one from what their consent actually grants.
  property      text,

  -- Billed for the API calls. Ours, not the tenant's: user credentials must name a project and it
  -- is the operator who has the Search Console API enabled. Kept as a column rather than an env
  -- var so a tenant can be moved to a different project without a redeploy.
  quota_project text,

  -- Server-written, every one of them. pending: created, no consent yet. connected: a refresh token
  -- is stored and worked. failing: stored but Google is refusing it (transient). revoked: Google
  -- has rejected it in a way that needs fresh consent -- distinct from failing, which retries.
  status        text not null default 'pending',
  last_checked_at timestamptz,
  last_error    text,                             -- plain-language, never a stack trace

  -- Set before the grant is revoked at Google, cleared once it is gone. A row with deleted_at set
  -- and a secret still present is an interrupted delete for the reaper to finish. See note 2.
  deleted_at    timestamptz,

  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),

  constraint gsc_accounts_status_ck check (status in ('pending', 'connected', 'failing', 'revoked')),
  constraint gsc_accounts_label_ck  check (length(label) between 1 and 80),
  -- Exactly the two spellings the API accepts. A property that is neither is a guaranteed 403 that
  -- reads like a permissions problem, so it is refused at the point it is written instead.
  constraint gsc_accounts_property_ck check (
    property is null or property ~ '^sc-domain:[a-z0-9.-]+$' or property ~ '^https?://[^ ]+/$'
  )
);

create index if not exists gsc_accounts_user_idx on public.gsc_accounts (user_id);

-- One property per user, once. A second row would be two connectors competing for the same quota
-- with no way to tell their usage apart. Partial, so a soft-deleted row does not permanently block
-- re-adding the same property. (Rows awaiting consent have property IS NULL and do not collide:
-- Postgres treats NULLs as distinct in a unique index.)
create unique index if not exists gsc_accounts_user_property_uk
  on public.gsc_accounts (user_id, property) where deleted_at is null;
-- The reaper's worklist: rows whose Google grant still has to be revoked.
create index if not exists gsc_accounts_orphan_idx on public.gsc_accounts (deleted_at)
  where deleted_at is not null;

-- ---------------------------------------------------------------- the credential

create table if not exists public.gsc_account_secrets (
  account_id uuid primary key references public.gsc_accounts(id) on delete cascade,
  sealed     jsonb not null,   -- exactly src/secrets.ts Sealed: {v, wk, wn, ct, n}
  updated_at timestamptz not null default now()
);

comment on table public.gsc_account_secrets is
  'Google OAuth refresh tokens, sealed by src/secrets.ts under MASTER_KEY. Useless without that key, which lives only in the process environment. No RLS policies exist on this table on purpose -- see below.';

-- ---------------------------------------------------------------- connector tokens

-- Identical in shape and intent to both siblings': the connector URL is the credential, so only its
-- sha256 is stored and a leaked URL can be killed without disturbing the account. One account may
-- have several (a laptop, a phone, a shared chat), each revocable on its own.
create table if not exists public.mcp_tokens (
  id           uuid primary key default gen_random_uuid(),
  account_id   uuid not null references public.gsc_accounts(id) on delete cascade,
  token_sha256 text not null unique,
  label        text,
  created_at   timestamptz not null default now(),
  last_used_at timestamptz,
  revoked_at   timestamptz,
  constraint mcp_tokens_sha_ck check (token_sha256 ~ '^[0-9a-f]{64}$')
);

create index if not exists mcp_tokens_account_idx on public.mcp_tokens (account_id);
create index if not exists mcp_tokens_active_idx  on public.mcp_tokens (token_sha256) where revoked_at is null;

-- ---------------------------------------------------------------- usage

-- What was called, whether it worked, how long it took. Never an argument, never a property, never
-- a search term: this table is read by support and must not become a second copy of the customer's
-- traffic. src/tools.ts errorCode() is the closed vocabulary that keeps error_code clean.
create table if not exists public.mcp_calls (
  id          bigserial primary key,
  account_id  uuid not null references public.gsc_accounts(id) on delete cascade,
  tool        text not null,
  ok          boolean not null,
  duration_ms integer,
  error_code  text,
  created_at  timestamptz not null default now()
);

create index if not exists mcp_calls_account_time_idx on public.mcp_calls (account_id, created_at desc);

-- ---------------------------------------------------------------- row level security

alter table public.gsc_accounts        enable row level security;
alter table public.gsc_account_secrets enable row level security;
alter table public.mcp_tokens          enable row level security;
alter table public.mcp_calls           enable row level security;

drop policy if exists gsc_accounts_select on public.gsc_accounts;
create policy gsc_accounts_select on public.gsc_accounts
  for select using (auth.uid() = user_id);

-- WITH CHECK is not optional. Without it Postgres reuses USING for the post-update row, so a user
-- could reassign user_id and hand their Search Console access to someone else -- or take one.
-- (No write grants are handed to clients below; these policies are what a stranger with the
-- published anon key and curl meets at PostgREST.)
drop policy if exists gsc_accounts_insert on public.gsc_accounts;
create policy gsc_accounts_insert on public.gsc_accounts
  for insert with check (auth.uid() = user_id);

drop policy if exists gsc_accounts_update on public.gsc_accounts;
create policy gsc_accounts_update on public.gsc_accounts
  for update using (auth.uid() = user_id) with check (auth.uid() = user_id);

drop policy if exists gsc_accounts_delete on public.gsc_accounts;
create policy gsc_accounts_delete on public.gsc_accounts
  for delete using (auth.uid() = user_id);

-- gsc_account_secrets: deliberately NO policies. RLS enabled with zero policies denies everything
-- to every non-superuser role, including the owner's own user. The server reaches it as the service
-- role, which bypasses RLS. There is no query a signed-in customer can write -- for their own row
-- or anyone else's -- that returns a sealed token. That is the intent: the sealing under MASTER_KEY
-- is the second line, not the first.

-- A user may list and revoke their own tokens, but never read a hash back into a URL.
drop policy if exists mcp_tokens_select on public.mcp_tokens;
create policy mcp_tokens_select on public.mcp_tokens
  for select using (exists (select 1 from public.gsc_accounts a where a.id = account_id and a.user_id = auth.uid()));

drop policy if exists mcp_calls_select on public.mcp_calls;
create policy mcp_calls_select on public.mcp_calls
  for select using (exists (select 1 from public.gsc_accounts a where a.id = account_id and a.user_id = auth.uid()));

-- ---------------------------------------------------------------- grants

-- Table-level write privileges outrank column-level ones, so they go first.
revoke insert, update, delete on public.gsc_accounts        from authenticated, anon;
revoke insert, update, delete on public.gsc_account_secrets from authenticated, anon;
revoke insert, update, delete on public.mcp_tokens          from authenticated, anon;
revoke insert, update, delete on public.mcp_calls           from authenticated, anon;

-- TRUNCATE IS NOT SUBJECT TO ROW-LEVEL SECURITY, and Supabase's default privileges grant it along
-- with everything else -- so listing only insert/update/delete would leave either role able to wipe
-- every tenant's accounts, tokens and call log in one statement with the policies looking on.
-- TRIGGER goes for the same reason: with CREATE on schema public it is code execution as the owner.
revoke truncate, trigger, references on
  public.gsc_accounts, public.gsc_account_secrets, public.mcp_tokens, public.mcp_calls
from authenticated, anon;

-- SELECT too, on the secrets table. The policies above already deny it, but a revoke is not a
-- second opinion -- it is what still holds if a policy is ever added here by mistake.
revoke select on public.gsc_account_secrets from authenticated, anon;

-- NOTHING is granted back. Creating an account, consenting, choosing a property, minting a token,
-- revoking one and deleting the account all go through /api/*, running as the service role. imap2ai
-- learned this twice: `grant update(imap_host...)` was an SSRF, and `grant update(revoked_at)` made
-- revocation a toggle rather than a one-way door, because an UPDATE policy's WITH CHECK constrains
-- WHICH ROW you may write, never WHICH VALUE. Here the same grant would let a customer write
-- `status='connected'` over a revoked grant, or point quota_project at a project they do not pay
-- for. Every column here except label is server-written, and label goes through the API too.

-- ---------------------------------------------------------------- safe status view

-- What the dashboard renders. Excludes last_error, which is operator-facing and can quote the
-- property, and excludes quota_project, which is the operator's Google Cloud billing arrangement.
-- (The only thing "billing" means here: this product has no subscriptions of its own. See CLAUDE.md.)
drop view if exists public.gsc_account_status;
create view public.gsc_account_status
  with (security_invoker = true) as
select id, user_id, label, google_email, property, status, last_checked_at, created_at
from public.gsc_accounts
where deleted_at is null;

grant select on public.gsc_account_status to authenticated;
