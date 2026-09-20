# GOOGLE2AI — architecture

An MCP server over the Google Search Console API, built to the same pattern as its siblings
[IMAP2AI](https://github.com/juresavron/IMAP2AI) (Python) and
[WHATSAPP2AI](https://github.com/juresavron/WHATSAPP2AI) (TypeScript). Read WHATSAPP2AI's `CLAUDE.md`
first if you have not — this one only records where GOOGLE2AI departs from it and why.

## Shape

```
src/env.ts      .env loader + typed Config. No dependencies.
src/gsc.ts      the Search Console API behind an interface, plus a seeded mock
src/tools.ts    the MCP tools, the instructions string, buildServer(ctx)
src/mcp.ts      mounting an MCP endpoint on an Express route (ported from whatsapp2ai)
src/html.ts     escaping + the headers every response carries
src/index.ts    composition and nothing else
```

`node src/index.ts` — Node ≥ 22.18 runs the TypeScript directly. There is **no build step**, so
`tsc` exists only as `npm run typecheck`. Imports carry explicit `.ts` extensions because Node's
type stripping requires them.

## The three rules it inherits

**One `McpServer` per request.** The Streamable HTTP endpoint is stateless. `mountMcp` takes a
resolver — "how does this request become a `Ctx`" — because stage 4 adds a second route
(`/c/<token>/mcp`) that differs in nothing else, and the siblings both learned that the hard way,
by fixing the same 500 twice.

**The secret in the path is the credential.** No OAuth between Claude and this server. Compared
constant-time, and both sides are hashed to a fixed width first so the comparison leaks neither the
secret's prefix nor its length. A wrong secret gets `404`, the same answer a nonexistent path gets:
a distinguishable `401` would confirm to a scanner that the path shape was right.

**`/status` must survive being public.** Counts and states, never names. A property name is the
customer's domain, and the error strings quote it — so neither appears there. Asserted twice: in
`tests/e2e.test.ts` and again by the deploy workflow against the live machine, because a regression
that published one would be invisible from a green deploy.

## Where it departs from whatsapp2ai

**It is stateless.** WhatsApp2AI owns a linked-device session on a volume, which is why it has
`[[mounts]]`, a `docker-entrypoint.sh` that chowns the mount while still root, and a hard rule never
to scale past one machine. GOOGLE2AI holds nothing between requests: no volume, no entrypoint, `USER
node` at build time, and it scales freely. Every piece of that machinery was deleted rather than
copied.

**Authentication runs in the other direction.** IMAP2AI stores a mailbox password and WhatsApp2AI
stores a device session — credentials the server holds and replays. Search Console has neither. The
four paths in `env.ts` (`oauth` → `inline` → `file` → `adc`) are ordered by what works on a hosted
box, which is not the order Google documents:

- `adc` cannot work in a container; there is no gcloud there.
- `inline` and `file` are service accounts, and Search Console's own *Add user* form rejects a
  freshly created service account with "email not found" — a Google-side bug, so a service account
  can only read properties some other route already granted it.
- `oauth` runs the calls as the person who consented, who already has access to everything they
  own. It is the only path that works, so it is first.

`GOOGLE_QUOTA_PROJECT` is required with OAuth and ignored with a service account key, and its
absence produces a `403` whose message reads like a permissions problem. `cleanError` in `gsc.ts`
separates that `403` from the other one by name, because their remedies have nothing in common.

**The domain has a lag, and the lag is a correctness problem.** Search Console publishes nothing for
today or yesterday and the last two days of any range are incomplete. A range defaulting to today
therefore returns two empty columns, and every reader — person or model — concludes traffic
collapsed. So: unset ranges end `LAG_DAYS` ago, `status()` reports `latest_complete_date`, and the
instructions string says it in capitals. This is the single highest-value thing in the repository
and it is three lines of code.

## The instructions string

`instructions(ctx)` in `tools.ts` is what Claude reads before calling anything, and it is most of
why these connectors feel like a colleague rather than an API. It names the bound property, gives
both property spellings (which are not guessable), says which tool to start with for which question,
and states the lag. Its siblings each carry one; a tool list without it is a bag of endpoints.

## Testing

Everything runs offline against `MockGSC` — no credentials, no network, no API quota. That is not a
convenience: it is what lets CI assert real behaviour instead of just that the process starts.

- `tests/env.test.ts` — config precedence, auth resolution, clamps
- `tests/gsc.test.ts` — error classification, mock determinism
- `tests/tools.test.ts` — the tools over the SDK's in-memory transport, so registration is real
- `tests/e2e.test.ts` — the actual server over actual HTTP: headers, the secret guard, the
  handshake, and the `/status` leak assertions

The mock is deterministic on purpose. One that drifted would make the suite flake for reasons
unrelated to the server.

## The database

`db/schema.sql` is applied to GOOGLE2AI's **own** Supabase project, and the preflight block at the
top of it refuses to run on imap2ai's or whatsapp2ai's. That guard is not paranoia: `mcp_tokens` and
`mcp_calls` exist in all three, `create table if not exists` would skip them, and the policy
statements would then drop that product's working policies and recreate them joined to
`gsc_accounts` — cutting its customers off with no error anywhere.

`src/pg.ts` and `src/supabase-ca.ts` are whatsapp2ai's, essentially unchanged: only the probe table
and the migration filenames differ. Read `validateDatabaseUrl()` first if a deploy cannot reach the
database — Supabase's direct host publishes only an AAAA record and Fly has no public IPv6 egress,
so the Session pooler string is the one that works.

`src/db.ts` holds every statement the server runs, and the rule that holds it together is that a
statement reachable from a signed-in user takes `userId` and joins on it **in the same statement** —
not look-up-then-check-then-write, which has a window and a path to forget. The RLS policies say the
same thing a second time for the PostgREST surface; the server connects as the service role and
bypasses RLS, so those joins are the real enforcement for everything in this file.

## Stages

1. ✅ hosted MCP core over Streamable HTTP
2. ✅ deploy pipeline and docs
3. ✅ Postgres mirror (`db/002_mirror.sql`, `src/store.ts`)
4. ✅ multi-tenant SaaS — schema, sealed credentials, `pg.ts`, `db.ts`, the **Google OAuth consent
   flow** (`google-oauth.ts` — net-new; neither sibling has one, because their tenants hand over a
   password and a Search Console tenant cannot), the tenant resolver (`tenants.ts`), Supabase
   sign-in (`auth.ts`), the dashboard, landing and legal pages (`saas.ts`, `pages.ts`), the
   `ADMIN_EMAILS` operator panel, and `/c/<token>/mcp`.
## No billing, by decision

Both siblings carry Stripe — imap2ai has `billing.py`, `plans.py` and a Stripe catalogue,
whatsapp2ai has `db/002_subscriptions.sql`. **GOOGLE2AI deliberately does not**, and this is a
settled decision rather than an unfinished stage. Do not port theirs across on the assumption that
parity means all of it.

What that means concretely, so nobody adds half of it back by accident:

- No `subscriptions` or `stripe_events` table, no webhook endpoint, no plan gating anywhere.
- `MAX_ACCOUNTS_PER_USER` is a **capacity ceiling, not a plan tier** — every account is a live
  Google grant this deployment is responsible for, and the limit exists so one user cannot take the
  shared API quota down by accident. It is not a lever to sell against.
- `gsc_accounts.quota_project` is about who pays **Google Cloud** for API quota. It is the only
  thing in this repository the word "billing" refers to.
- Access is controlled by sign-in and by connector tokens, both revocable. There is no paid state
  for anything to check, so there is no path where a lapsed payment can silently disable a
  connector — which is one fewer failure mode than either sibling has.

**Never run live:** sign-in and the Google consent have no end-to-end coverage, because CI has
neither a Postgres nor an OAuth client. `tests/saas.test.ts` proves the surface mounts and degrades
correctly with the database unreachable; it cannot prove a consent completes. The first real
sign-in is still a first.

## The mirror

`gsc_rows` holds grouped daily rows; `gsc_sync` records which `(day, grouping)` pairs were actually
fetched. Two tables rather than one, because **a day with genuinely zero impressions and a day that
was never synced look identical in a rows table** — answering from the first while believing the
second is how a mirror starts lying.

Two judgements live in `store.ts` and both are deliberately conservative:

**When is a day finished?** Google publishes a day ~3 days late and then keeps revising it.
`FINAL_AFTER_DAYS` is 5 — the lag plus margin — because a provisional day marked final is never
corrected afterwards. The cost of waiting is one re-fetch; the cost of being wrong is permanent.

**When may the mirror answer?** Only when *every* day in the range is present *and* final, and only
for an unfiltered web query — it stores grouped totals, so it has nothing to apply a filter to. A
90%-synced range would answer with 90% of the clicks and no sign anything was missing, and that is
indistinguishable from a drop in traffic. Everything else falls through to Google, and the tool
output always names which of the two answered.

Position is averaged **weighted by impressions**, in `store.ts` and `tools.ts` alike. Proven against
Postgres rather than assumed: two days of one query at 9000 impressions/position 2.0 and 9
impressions/position 30.0 give 2.028 weighted and 16.000 as a naive mean.

The backfill walks **newest-first** on a small per-account budget, because the quota is per *project*
and shared by every tenant, and because a sweep starting sixteen months ago leaves "last week"
missing for hours.

## Two surfaces, one process

```
operator (always)    /<MCP_SECRET>/{mcp,setup}      one account, the secret IS the login
tenant   (optional)  /, /login, /app, /c/<t>/mcp    many accounts, a real sign-in
```

The tenant surface appears only when `SUPABASE_URL`, `SUPABASE_ANON_KEY` and `DATABASE_URL` are all
set, and it **refuses to start without `MASTER_KEY`** — starting would mean storing every tenant's
Google refresh token in the clear, on a server that looks healthy right up until the database leaks.

They are genuinely separate products sharing a process, and `tests/saas.test.ts` holds them to it:
with Postgres unreachable, the operator connector still answers and `/healthz` still reports.

**CSRF.** There are no tokens on these forms, deliberately rather than by omission. The session
cookie is `SameSite=Lax`, so a cross-site POST does not carry it, and every mutating route is a
POST. The one GET that changes anything is Google's callback, which has its own cookie-bound state
check — and that cookie is `Lax` too, not `Strict`, because Google's callback is a top-level
cross-site GET and `Strict` would withhold it on exactly that navigation.

**`PUBLIC_ORIGIN`, not the Host header.** The Google redirect URI is built from configuration. A
Host header is attacker-controlled, and deriving the redirect from one would let a forged request
send a consent somewhere else.

## Provenance

The four original tools came from
[sarahpark/google-search-console-mcp](https://github.com/sarahpark/google-search-console-mcp) (MIT),
a stdio server, vendored at `cacaf96`. The transport, config, deployment, tests, `status` and
`compare_periods` are this repository's. `LICENSE` keeps the upstream copyright notice unchanged.
