# GOOGLE2AI

A small, self-hosted [MCP](https://modelcontextprotocol.io) server that gives Claude read access to
Google Search Console. Sibling of [IMAP2AI](https://github.com/juresavron/IMAP2AI) and
[WHATSAPP2AI](https://github.com/juresavron/WHATSAPP2AI): same deployment pattern (Docker, secret in
the URL, no OAuth between Claude and the server), same "clean text in, clean text out" philosophy.

It talks to the Search Console API as you, and exposes MCP tools over Streamable HTTP. Nothing is
sent anywhere except to Google and to the Claude client that holds the secret URL.

**Reading by default, writing by decision.** The six read tools work as soon as it is connected.
The five write tools are registered but **refuse unless `GSC_ALLOW_WRITE=true`**, and on the
multi-account build the account's own switch must be on as well — both, or nothing happens. Same
arrangement as whatsapp2ai's `WA_ALLOW_SEND`, for the same reason: the read half is safe to hand an
agent, and the write half removes a property from Search Console.

## Tools

| tool | what it does |
|---|---|
| `status()` | which credentials are in use, whether Google accepts them, how many properties are visible, and how far back the mirror reaches |
| `list_sites()` | every property these credentials can read, with the permission level on each |
| `search_analytics(siteUrl, startDate, endDate, dimensions, rowLimit, searchType, …filters)` | clicks, impressions, CTR and position, grouped by query / page / country / device / date |
| `compare_periods(siteUrl, days, endDate, dimensions, rowLimit, …filters)` | the same metrics over two consecutive windows, with the change on every row |
| `inspect_url(inspectionUrl, siteUrl)` | indexing status, last crawl, the canonical Google chose, mobile usability |
| `list_sitemaps(siteUrl)` | submitted sitemaps: when each was last read, URLs found, URLs indexed |

Write tools, all refused unless switched on:

| tool | what it does |
|---|---|
| `submit_sitemap(feedpath, siteUrl)` | submit or resubmit a sitemap |
| `delete_sitemap(feedpath, siteUrl)` | un-submit one; Google stops tracking it |
| `add_property(siteUrl)` | add a property — it still needs ownership verification separately |
| `remove_property(siteUrl)` | remove one. **Not reversible from here**: re-adding needs verification again. Takes no default target, deliberately |
| `request_indexing(url, type)` | Indexing API. Google supports it only for `JobPosting` and `BroadcastEvent` pages, 200/day — passed through honestly rather than pretended otherwise |

Properties are addressed exactly as Search Console spells them — `sc-domain:example.com` for a
domain property, `https://example.com/` (with the trailing slash) for a URL-prefix one. Set
`GSC_DEFAULT_SITE` and every tool may be called without one.

Filters are shared by the two analytics tools: `queryFilter`, `pageFilter` (both accept a `regex:`
prefix), `countryFilter` (ISO alpha-3), `deviceFilter`.

### The three-day lag

Search Console publishes nothing for today or yesterday, and the last two days of any range are
incomplete and will rise later. Every date range left unset therefore **ends three days ago**, and
the connector's instructions say so, because the alternative is a chart that appears to fall off a
cliff at the right-hand edge in every single conversation. Data older than 16 months does not exist.

## Deploy to Fly.io (~10 minutes)

Full walkthrough, including minting the Google credentials: **[DEPLOY.md](DEPLOY.md)**. In short:

```bash
fly launch --no-deploy --copy-config --name google2ai --region ams
fly secrets set MCP_SECRET="$(node -e "console.log(require('crypto').randomBytes(24).toString('base64url'))")" -a google2ai
node scripts/get-refresh-token.mjs --client-id=… --client-secret=…   # prints the next command
fly deploy
curl https://google2ai.fly.dev/healthz          # → ok ready <sha>
```

Then in claude.ai → **Settings → Connectors → Add custom connector**:

- Name: `GOOGLE2AI`
- URL: `https://google2ai.fly.dev/<MCP_SECRET>/mcp`
- No OAuth (the secret in the path is the credential).

Enable it in the chat's connector list and ask Claude for `list_sites()`.

Unlike whatsapp2ai this app is **stateless** — no volume, nothing to restore, and it can be scaled
across machines freely. `.github/workflows/deploy.yml` owns the deploy: a push to `main` runs the
tests, deploys, then asserts that the live `/healthz` carries the commit it just pushed and that the
public `/status` still names no property.

### VPS with Caddy, instead of Fly

```bash
cp .env.example .env && nano .env   # also DOMAIN, ACME_EMAIL
docker compose up -d --build
```

### Without docker

Node ≥ 22.18 (runs the TypeScript directly, no build step):

```bash
npm install && cp .env.example .env && nano .env
node src/index.ts            # http://0.0.0.0:8080/<MCP_SECRET>/mcp
```

## Authentication

Four ways, tried in this order. **On a hosted box only the first one works.**

| | how | works on Fly |
|---|---|---|
| OAuth refresh token | `GOOGLE_CLIENT_ID` + `GOOGLE_CLIENT_SECRET` + `GOOGLE_REFRESH_TOKEN` | **yes** |
| Service account, inline | `GOOGLE_CREDENTIALS_JSON` holds the whole key | only if already granted |
| Service account, file | `GOOGLE_APPLICATION_CREDENTIALS` points at the key | only if already granted |
| gcloud ADC | nothing set | no — there is no gcloud on a container |

The service-account rows carry a caveat that is Google's, not this project's: Search Console's
**Add user** form rejects a freshly created service account with *"Failed to add user: email not
found"*, so a service account can only read properties some other route already granted it. OAuth
runs the calls as the person who consented, who already has access to everything they own, which is
why it is the supported path here.

With OAuth, `GOOGLE_QUOTA_PROJECT` is **required** — user credentials must name a project to bill or
Search Console answers `403 PERMISSION_DENIED` with a message that reads like a permissions problem.
`/<MCP_SECRET>/setup` is a checklist that names whichever of these is missing.

## Two shapes, one codebase

**One account, yours.** Set `MCP_SECRET` and the Google variables, put
`https://host/<MCP_SECRET>/mcp` into Claude. No sign-in, no database, nothing to visit but a setup
checklist at `/<MCP_SECRET>/setup`. This is the whole product for a person who wants their own
Search Console in Claude.

**Several accounts, with sign-in.** Set `SUPABASE_URL`, `SUPABASE_ANON_KEY`, `DATABASE_URL`,
`MASTER_KEY` and `PUBLIC_ORIGIN` as well, and the same server also serves a landing page, sign-in,
and a dashboard where somebody connects their own Google account, picks a property and gets a
revocable connector URL of their own — plus `/privacy`, `/terms` and an `ADMIN_EMAILS`-gated
operator panel. Accounts live in Postgres; each tenant's refresh token is sealed under `MASTER_KEY`.
Read [SAAS.md](SAAS.md) before running this for other people.

The tenant build **refuses to start without `MASTER_KEY`**, because starting would mean storing
every tenant's Google credential in the clear.

## The mirror

On the multi-account build, the server backfills Search Console into Postgres every fifteen minutes.
That is not primarily a cache:

**Google deletes the history.** Search Console keeps sixteen months and then the data is gone — not
archived, gone. A site running three years cannot ask "how did last spring compare to the one
before" from Google at all, and never will be able to. Every day the mirror runs is a day of history
that outlives that window.

It answers a range only when *every* day in it has been fetched *and* settled, and only for an
unfiltered web query. Anything else falls through to Google, and `search_analytics` always says
which of the two answered. Set `GSC_MIRROR=off` if you would rather not store it.

## Endpoints

| path | who can read it |
|---|---|
| `GET /healthz` | anyone — `ok <state> <commit>`, for the deploy to grep |
| `GET /status` | anyone — version, commit, auth kind, counts. **No property names, no error text** |
| `GET /<MCP_SECRET>/setup` | whoever holds the secret — the configuration checklist |
| `POST /<MCP_SECRET>/mcp` | whoever holds the secret — the connector |
| `GET /`, `/login`, `/privacy`, `/terms` | anyone — multi-account build only |
| `GET /app` | a signed-in tenant — their own accounts only |
| `GET /app/operator` | an `ADMIN_EMAILS` address — every account. 404 for anyone else |
| `POST /c/<token>/mcp` | whoever holds that tenant's connector URL |

`/status` is deliberately dull: a property name is a customer's domain and the error strings quote
it, so both are kept off the one endpoint a stranger can read. The deploy asserts their absence on
every release.

## Development

```bash
npm install
npm run mock       # GSC_MOCK=1 — seeded demo data, no credentials, no network
npm run check      # typecheck + the whole suite
```

The entire suite runs offline against the mock, which is what lets CI assert real behaviour rather
than just that the process starts.

## Credits

The Search Console tool surface began as a copy of
[sarahpark/google-search-console-mcp](https://github.com/sarahpark/google-search-console-mcp) by
Sarah Park (MIT), vendored at upstream commit
[`cacaf96`](https://github.com/sarahpark/google-search-console-mcp/commit/cacaf9628d119a40490e80fa8e5f936eba761c7d).
That project is a stdio server; the transport, configuration, deployment, tests and the `status` and
`compare_periods` tools are this repository's. See [LICENSE](LICENSE), whose copyright notice is
retained unchanged.

## License

MIT
