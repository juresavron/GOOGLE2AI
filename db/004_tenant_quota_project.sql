-- Clear the quota project every tenant account inherited from the operator.
--
-- `x-goog-user-project` does not mean "bill this project". It means "I, the authenticated caller,
-- am entitled to consume quota in this project", and Google checks `serviceusage.services.use` for
-- the identity that consented — the TENANT's Google account, not the operator's.
--
-- New accounts were created with the operator's GOOGLE_QUOTA_PROJECT in this column, so every
-- tenant call carried a header asserting something untrue, and Google refused all of them:
--
--   403 Caller does not have required permission to use project <operator-project>.
--       Grant the caller the roles/serviceusage.serviceUsageConsumer role ...
--
-- The message is accurate and the remedy it proposes is not available to a SaaS: it would mean
-- adding every customer as an IAM principal on the operator's Cloud project, which also lets them
-- consume quota on every other API enabled there.
--
-- Null is the correct value. With no header, Google attributes quota to the project that owns the
-- OAuth CLIENT — the operator's project either way. Same payer, no IAM, no per-customer step.
--
-- Safe to run repeatedly, and safe as a blanket update: nothing in the product ever SET this
-- column deliberately. There is no dashboard control for it, and `gsc_account_status` has always
-- excluded it as operator-facing, so every non-null value present is one this seeded.
do $$
begin
  if to_regclass('public.gsc_accounts') is null then
    raise exception 'Apply db/schema.sql first — this migration extends it.';
  end if;
end $$;

update public.gsc_accounts set quota_project = null where quota_project is not null;

comment on column public.gsc_accounts.quota_project is
  'Google Cloud project to attribute API quota to, via x-goog-user-project. Normally NULL, which attributes quota to the project owning the OAuth client. Set it only when a tenant has their own Cloud project AND the Google account that consented holds roles/serviceusage.serviceUsageConsumer on it — otherwise every call for this account 403s. Operator-facing: never exposed through gsc_account_status and never writable by a tenant.';
