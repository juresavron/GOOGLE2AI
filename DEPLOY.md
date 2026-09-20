# Deploying GOOGLE2AI

Fly.io is the deployed path. A VPS with Caddy works too and is at the bottom.

Budget about 20 minutes, most of it in the Google Cloud Console.

---

## 1. Google Cloud: a project and the API

1. [Google Cloud Console](https://console.cloud.google.com/) → create a project (or pick one). Note
   its **project ID** — not its name; they differ, and the ID is what goes in the config.
2. Enable the [Search Console API](https://console.cloud.google.com/marketplace/product/google/searchconsole.googleapis.com).

## 2. Google Cloud: an OAuth client

**APIs & Services → Credentials → Create credentials → OAuth client ID → Desktop app.**

A *Desktop* client is what you want even though this ends up on a server. It accepts any
`http://127.0.0.1` redirect, which is what `scripts/get-refresh-token.mjs` needs; a *Web* client
would need a redirect URI registered in advance. The client is only ever used to mint the refresh
token, never by the running server to talk to a browser.

Then, on the **OAuth consent screen**:

- Add yourself under **Test users** if the app is in Testing.
- **Publish the app.** While it is in Testing, Google expires refresh tokens after **7 days**, and
  the connector dies every week with `invalid_grant`. Publishing needs no verification review while
  you are the only user and the scope is one you own data for.

## 3. Mint the refresh token

On your own machine, signed into the Google account that owns the Search Console property:

```bash
node scripts/get-refresh-token.mjs --client-id=… --client-secret=…
```

It prints a consent URL, waits for the callback, and then prints the exact `fly secrets set` command
to run. Nothing is stored on disk.

If it reports no refresh token, this account has consented to this client before — revoke it at
[myaccount.google.com/permissions](https://myaccount.google.com/permissions) and run it again.

## 4. Fly

```bash
fly launch --no-deploy --copy-config --name google2ai --region ams

fly secrets set MCP_SECRET="$(node -e "console.log(require('crypto').randomBytes(24).toString('base64url'))")" -a google2ai

# the command step 3 printed:
fly secrets set \
  GOOGLE_CLIENT_ID="…" \
  GOOGLE_CLIENT_SECRET="…" \
  GOOGLE_REFRESH_TOKEN="…" \
  GOOGLE_QUOTA_PROJECT="your-project-id" -a google2ai

# optional: bind the connector to one property
fly secrets set GSC_DEFAULT_SITE="sc-domain:example.com" -a google2ai

fly deploy
```

No volume is created, on purpose. This server holds nothing between requests — unlike whatsapp2ai,
whose linked-device session lives on a mount and pins it to exactly one machine. Scale this one
freely.

## 5. Check it

```bash
curl https://google2ai.fly.dev/healthz     # ok ready <sha>
curl https://google2ai.fly.dev/status      # version, auth kind, counts — no property names
```

| `/healthz` says | meaning |
|---|---|
| `ok ready <sha>` | Google accepted the credentials and answered |
| `ok unchecked <sha>` | up, but no call has succeeded yet — normal for a second after boot |
| `ok auth-error <sha>` | serving, but every tool will fail. Open `/<MCP_SECRET>/setup` |
| `ok mock <sha>` | `GSC_MOCK=1` is set. Never correct in production |

`https://google2ai.fly.dev/<MCP_SECRET>/setup` is the checklist: it names which of the four
configuration items is missing and what Google said if it refused.

## 6. Connect Claude

claude.ai → **Settings → Connectors → Add custom connector**

- Name: `GOOGLE2AI`
- URL: `https://google2ai.fly.dev/<MCP_SECRET>/mcp`
- No OAuth — the secret in the path is the credential. **Treat the whole URL like a password.**

Enable it in the chat's connector list, then ask for `list_sites()`.

## 7. Continuous deploy

`.github/workflows/deploy.yml` runs on every push to `main`: tests, deploy, then it asserts the live
`/healthz` carries the commit just pushed and that `/status` still names no property.

One-time setup, and the first step is not optional:

1. Fly dashboard → google2ai → **detach the GitHub repo**. While attached, Fly deploys too, and two
   pipelines releasing at once fails with `failed to acquire lease … held by …@tokens.fly.io`.
2. `fly tokens create deploy -a google2ai`
3. GitHub → Settings → Secrets and variables → Actions → new secret `FLY_API_TOKEN`.

---

## Running it for other people

Everything above gives you the single-account server. To add sign-in, a dashboard and per-tenant
connector URLs, read **[SAAS.md](SAAS.md)** first — it covers what you are taking on — then:

1. **A Supabase project of its own.** Not imap2ai's or whatsapp2ai's: `db/schema.sql` refuses to run
   on either, because `mcp_tokens` and `mcp_calls` exist in all three and the collision is silent.
2. Apply, in the SQL editor and in this order: `db/schema.sql`, `db/002_mirror.sql`,
   `db/003_allow_write.sql`, `db/004_tenant_quota_project.sql`. Each is safe to re-run.
3. Set the rest:

```bash
fly secrets set   SUPABASE_URL="https://<ref>.supabase.co"   SUPABASE_ANON_KEY="sb_publishable_..."   DATABASE_URL="postgresql://postgres.<ref>:<password>@aws-0-<region>.pooler.supabase.com:5432/postgres"   MASTER_KEY="$(openssl rand -base64 32)"   PUBLIC_ORIGIN="https://google2ai.fly.dev"   OPERATOR_NAME="..." OPERATOR_CONTACT="..." OPERATOR_LAW="..."   ADMIN_EMAILS="you@example.com" -a google2ai
```

**`MASTER_KEY` must be 32 bytes**, given either as base64url/base64 (43-44 characters) or as hex
(64 characters). Both are read correctly; anything else is refused at boot with a message naming
the byte count it got. The trap worth knowing is `openssl rand -hex 32` — right number of bytes,
but every hex character is also a valid base64 character, so before hex was recognised its output
decoded to 48 bytes and the server would not start on a perfectly good key. `-base64 48` and
`-hex 48` really are wrong and are still refused.

**`DATABASE_URL` must be the Session pooler string**, not `db.<ref>.supabase.co`. The direct host
publishes only an AAAA record and Fly has no public IPv6 egress, so it is unreachable there and
fails as `ENETUNREACH`, which names nothing. The pooler username carries the project ref
(`postgres.<ref>`) and the port is 5432, not 6543 — 6543 is the transaction pooler, and this server
holds a pool. `validateDatabaseUrl()` checks all three before a socket is opened.

4. Add `<PUBLIC_ORIGIN>/oauth/google/callback` to the OAuth client's authorised redirect URIs. It
   must match **exactly**, including the scheme and any trailing slash.
5. **Publish the OAuth consent screen.** In Testing, Google expires every tenant's refresh token
   after 7 days.

`curl https://google2ai.fly.dev/status` should then report `"multi_tenant": "ready"`. If it says
`database-unavailable`, the reason is in `fly logs` — `diagnose()` turns the driver's error into the
thing to actually go and do.

---

## Troubleshooting

**`403` and a message about a quota project.** User credentials must name a project to bill. Set
`GOOGLE_QUOTA_PROJECT` to the project ID from step 1 — the ID, not the display name.

**`403` and "does not have sufficient permission for site".** The credentials work but that account
is not on that property. Search Console → Settings → Users and permissions.

**`401 invalid_grant` a week after it worked.** The OAuth consent screen is still in Testing. See
step 2.

**`list_sites` returns nothing.** Almost never "you have no sites". With OAuth it means you
consented as a different Google account than the one that owns the property.

**A service account cannot be added in Search Console.** Known Google-side bug — *"Failed to add
user: email not found"* for newly created service accounts. Use OAuth; it is why OAuth is first.

---

## VPS with Caddy

Needs ports 80/443 open and a DNS A record pointing at the box.

```bash
git clone https://github.com/juresavron/GOOGLE2AI.git && cd GOOGLE2AI
cp .env.example .env
nano .env        # MCP_SECRET, the Google variables, DOMAIN, ACME_EMAIL
docker compose up -d --build
curl https://gsc.example.com/healthz
```

Caddy gets the certificate on first request. Never expose port 8080 directly — the secret in the URL
is a bearer credential and plain HTTP puts it in every intermediary's logs.
