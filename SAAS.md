# Running GOOGLE2AI for other people

Read this before pointing anybody else's Google account at a deployment you run. The single-account
server is yours and the risk is yours; the moment a second person signs in, you are holding a bearer
credential for somebody else's Google account, and the considerations below are the ones that
actually differ from imap2ai and whatsapp2ai.

## What you are holding

A Google OAuth **refresh token**, per tenant, sealed by `src/secrets.ts` under `MASTER_KEY`.

It is a worse thing to leak than an IMAP password, on two counts:

- **Bearer-grade.** No second factor applies to it. Possession is access.
- **Silent.** Reading a mailbox at least leaves a session in the owner's security log. Using a
  refresh token to read Search Console leaves the owner nothing to notice.

It is *narrower* than either sibling's credential in reach — `webmasters` and `indexing` cannot send
mail as them, cannot message their contacts, and cannot touch any other Google product — but it is
**not read-only**. A leaked token on a connection with writing enabled can remove a property from
their Search Console account, and only ownership verification restores it.

That is why writing takes **two** switches, `GSC_ALLOW_WRITE` and the account's own `allow_write`,
both off by default. Turning it on server-wide turns it on for nobody.

## The three things that must be true

1. **`MASTER_KEY` is set and is not in the repository.** The tenant build refuses to start without
   it — see `index.ts` — because starting would mean storing every tenant's token in the clear.
   Losing the key is recoverable (tenants reconnect) but disruptive. It lives in `fly secrets`.
2. **`ADMIN_EMAILS` is set deliberately, or left empty.** It gates `/app/operator`, which lists
   every customer. Empty means nobody, which is the correct default.
3. **`OPERATOR_NAME` / `OPERATOR_CONTACT` / `OPERATOR_LAW` are real.** `/privacy` and `/terms` say
   in red that the deployment has not said who runs it until these are set, and they are right to.
   Google's OAuth verification also asks for both pages.

## Publish the consent screen

While your OAuth consent screen is in **Testing**, Google expires every refresh token after **seven
days**. Every tenant's connector dies weekly with `invalid_grant`, and nothing in the logs says why
unless you read the message this server writes for exactly that case.

Publishing needs no verification review while the app is internal or has few users. If you take it
further, `webmasters` and `indexing` are both **sensitive** scopes: Google will want the privacy policy, the
terms, a domain you control, and a demonstration video. Budget weeks, not days.

## Quota is shared, and it is yours

Search Console allows roughly **1200 queries per minute per project**, and every tenant on the
deployment spends from the same one, because `GOOGLE_QUOTA_PROJECT` is yours rather than theirs.
Three defences, all already in place:

- `MAX_CALLS_PER_MINUTE` (default 120), per account, enforced in `tenants.ts`. The threat is an
  agent loop, not a stolen URL.
- The mirror answers fully-synced ranges without touching Google at all.
- The backfill's per-account budget is small, so one tenant's first sixteen-month backfill cannot
  spend the whole minute.

`gsc_accounts.quota_project` overrides the environment per account, so a heavy tenant can be moved
onto their own project without a redeploy.

## Deletion is not local

Deleting a tenant's row does **not** end Google's grant. The refresh token keeps working until it is
revoked at Google's endpoint or the owner withdraws consent at `myaccount.google.com/permissions`.

So deletion is two steps: `beginDelete()` tombstones the row and revokes its connector URLs
immediately, and the reaper calls Google and then finishes. A row with `deleted_at` set and a secret
still present is an interrupted delete, not an account. **If the reaper is not running, deleted
accounts leave live grants behind.** It runs every ten minutes behind the readiness latch.

## The mirror holds data Google has thrown away

Once the mirror is more than sixteen months deep, it is the **only** copy of that history — Google
deletes it and will not serve it again at any price. Back up the database accordingly, and note that
`gsc_rows` is the one table here whose loss is not recoverable by re-fetching.

## One Supabase project, not a shared one

`db/schema.sql` refuses to run on imap2ai's or whatsapp2ai's database. `mcp_tokens` and `mcp_calls`
exist in all three; `create table if not exists` would skip them and the policy statements would
then drop that product's working policies and recreate them joined to `gsc_accounts`, cutting its
customers off with no error anywhere. The guard makes that a rule the database enforces rather than
something you have to remember at 1am.

## What the operator can and cannot see

`/app/operator` shows every account's label, Google address, property, status, connector count,
24-hour call count and last error. It does **not** show search terms, page URLs or any Search
Console data — `mcp_calls` stores a tool name and a coarse error code from a closed vocabulary
(`errorCode()` in `tools.ts`), specifically so that support can be useful without the log becoming a
second copy of the customer's traffic. Keep it that way.
