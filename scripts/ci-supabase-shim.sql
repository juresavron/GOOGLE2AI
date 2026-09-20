-- The parts of a Supabase project that db/schema.sql depends on, for a plain Postgres in CI.
--
-- Only what the schema actually references: the auth.users table its foreign key points at, the
-- auth.uid() the RLS policies call, and the three roles the grant/revoke statements name. Nothing
-- here is a model of Supabase — it exists so `psql -f db/schema.sql` can run somewhere with no
-- Supabase, which is what lets check-db-sql.mjs PREPARE the real statements against the real
-- column names.
--
-- Deliberately NOT part of db/*.sql: those files are applied to production, and a stub auth schema
-- is the last thing that should be able to reach it. scripts/check-sql.py skips this directory.
create schema if not exists auth;

-- gsc_accounts.user_id references this. Only the id column is used.
create table if not exists auth.users (
  id uuid primary key default gen_random_uuid()
);

-- Every RLS policy calls it. In Supabase it reads a JWT claim; here it only has to exist and
-- return a uuid, because CI checks that the policies PARSE, not that they authorise.
create or replace function auth.uid() returns uuid language sql stable as $$
  select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid
$$;

do $$
begin
  if not exists (select 1 from pg_roles where rolname = 'anon') then create role anon nologin; end if;
  if not exists (select 1 from pg_roles where rolname = 'authenticated') then create role authenticated nologin; end if;
  if not exists (select 1 from pg_roles where rolname = 'service_role') then create role service_role nologin bypassrls; end if;
end $$;
