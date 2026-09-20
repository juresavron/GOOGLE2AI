// GOOGLE2AI — the entry point, and nothing but composition.
//
//   public              GET /healthz, GET /status   liveness and a payload safe for a stranger
//   secret-scoped       POST /<MCP_SECRET>/mcp      the connector Claude talks to
//                       GET  /<MCP_SECRET>/setup    what is configured and what is missing
//
// The secret in the path IS the credential, the same arrangement imap2ai and whatsapp2ai use. Stage 4
// adds the second surface — sign-in, a dashboard and per-tenant revocable tokens at /c/<token>/mcp —
// which is why the MCP route already goes through a resolver rather than being wired up inline.
import crypto from 'node:crypto';
import express from 'express';
import pino from 'pino';
import { authKind, configFromEnv, loadDotenv } from './env.ts';
import { GoogleGSC, MockGSC } from './gsc.ts';
import type { GSC } from './gsc.ts';
import { APP_JS, esc, page, SECURITY_HEADERS } from './html.ts';
import { mountMcp } from './mcp.ts';
import { LAG_DAYS, VERSION, type Ctx } from './tools.ts';

loadDotenv();
const cfg = configFromEnv();
const log = pino({ level: cfg.logLevel });
if (cfg.secretGenerated) log.warn({ secret: cfg.secret }, 'MCP_SECRET not set — using a random one for this run');

// Stamped into the image by the deploy workflow (Dockerfile ARG GIT_SHA), so a deploy can prove
// which commit is serving without holding the secret.
const COMMIT = (process.env.GIT_SHA ?? '').slice(0, 7);

const gsc: GSC = cfg.mock ? new MockGSC() : new GoogleGSC(cfg);
if (cfg.mock) log.warn('GSC_MOCK=1 — not calling Google, serving seeded demo data');
const ctx: Ctx = { cfg, gsc };

// The tenant surface appears only when all three are set. Without them this is the single-account
// server it has always been, with no login and no database to go wrong.
const saasReady = Boolean(cfg.supabaseUrl && cfg.supabaseAnonKey && cfg.databaseUrl);
const masterKey = process.env.MASTER_KEY || '';

// One probe at boot, not awaited: it turns /healthz from "the process is up" into "the credentials
// work", which is the thing a deploy actually needs to know. Listening must not wait on Google, so
// the failure path here only records — status() carries it, and every tool reports it properly.
//
// Skipped under GSC_MOCK, where it would log "credentials accepted" having called nothing. Saying
// that on a server with no credentials at all is worse than saying nothing.
if (!cfg.mock) {
  void gsc
    .listSites()
    .then((s) => log.info({ sites: s.length, auth: authKind(cfg) }, 'Google credentials accepted'))
    .catch((e) => log.error({ err: String(e instanceof Error ? e.message : e) }, 'Google credentials are not working — /<MCP_SECRET>/setup explains what is missing'));
}

const app = express();
app.disable('x-powered-by');
app.set('trust proxy', true);
app.use((_req, res, next) => {
  res.set(SECURITY_HEADERS);
  next();
});
// The one place a request body is capped. The MCP transport receives an already-parsed body and has
// no size option of its own. A Search Console request is small; a megabyte is already generous.
app.use(express.json({ limit: '1mb' }));
// The dashboard's forms. Small on purpose: nothing here posts anything but a label, a property and
// a button press.
app.use(express.urlencoded({ extended: false, limit: '32kb' }));

// The only script any page loads, and the reason the CSP can refuse inline script. Public and
// immutable: it contains no secrets and no per-user anything.
app.get('/app.js', (_req, res) => {
  res.type('application/javascript').set('Cache-Control', 'public, max-age=3600').send(APP_JS);
});

// ---------------------------------------------------------------- public endpoints

/** Coarse, and deliberately not the error text: /healthz is world-readable. */
const health = (): string => {
  const st = gsc.status();
  if (cfg.mock) return 'mock';
  if (st.error) return 'auth-error';
  return st.ready ? 'ready' : 'unchecked';
};

app.get('/healthz', (_req, res) => {
  res.type('text/plain').send(`ok ${health()}${COMMIT ? ' ' + COMMIT : ''}`);
});

/**
 * Readable by anyone who knows the hostname, so every field here must survive being public.
 *
 * No siteUrl, no default_site, no error text: a property name is the customer's domain, and the
 * error string can quote it. Counts and states only. The deploy workflow asserts the absence of
 * those keys rather than trusting review to catch a regression that a green deploy would hide.
 */
app.get('/status', (_req, res) => {
  const st = gsc.status();
  res.json({
    version: VERSION,
    commit: COMMIT || null,
    auth: st.auth,
    ready: st.ready,
    healthy: !st.error,
    writes_possible: false,
    reporting_lag_days: LAG_DAYS,
    // Tells "the database is misconfigured" from "the dashboard is broken", without saying which —
    // the reason is in the logs, where it belongs.
    multi_tenant: !saasReady ? 'off' : pgHandle?.health.ready() ? 'ready' : 'database-unavailable',
    properties: st.sites,
  });
});

// ---------------------------------------------------------------- tenant surface

// Mounted BEFORE the secret guard, because /login, /app and /c/<token>/mcp are not secret-scoped: a
// person carries a session cookie, a connector carries its own revocable token.
let pgHandle: Awaited<ReturnType<typeof import('./pg.ts').connectPg>> | null = null;
let reaper: NodeJS.Timeout | null = null;

if (saasReady) {
  if (!masterKey) {
    // Refused rather than warned: without it every consent would be stored unsealed, and a server
    // that starts here would look healthy right up until the database leaked.
    log.fatal('MASTER_KEY is not set, and the multi-tenant build cannot store credentials without it. Generate one with: node -e "console.log(require(\'crypto\').randomBytes(32).toString(\'base64url\'))"');
    process.exit(1);
  }

  const [{ connectPg }, { Auth }, { GoogleOAuth }, { Tenants }, { mountSaas }] = await Promise.all([
    import('./pg.ts'),
    import('./auth.ts'),
    import('./google-oauth.ts'),
    import('./tenants.ts'),
    import('./saas.ts'),
  ]);

  pgHandle = await connectPg(cfg.databaseUrl, log);

  // Must match a redirect URI registered on the OAuth client exactly, so it is built from one
  // configured origin rather than from the request — a Host header is attacker-controlled, and
  // deriving it from one would let a forged request send the consent somewhere else.
  const origin = (process.env.PUBLIC_ORIGIN || '').replace(/\/+$/, '');
  if (!origin) log.warn('PUBLIC_ORIGIN is not set — the Google redirect URI cannot be built, so connecting an account will fail');
  const oauth = new GoogleOAuth(cfg.clientId, cfg.clientSecret, `${origin}/oauth/google/callback`);

  const tenants = new Tenants(cfg, pgHandle.db, oauth, log, masterKey);
  mountSaas(app, { cfg, auth: new Auth(cfg.supabaseUrl, cfg.supabaseAnonKey), db: pgHandle.db, tenants, oauth, masterKey, log });

  // Interrupted deletes: a row tombstoned but its Google grant not yet revoked. Started only once
  // the database is usable, through the latch, which runs it immediately if it already is.
  pgHandle.health.onReady(() => {
    if (reaper) return;
    const sweep = () => void tenants.reap().catch((e) => log.error({ err: String(e) }, 'reaper failed'));
    sweep();
    reaper = setInterval(sweep, 10 * 60_000);
    reaper.unref?.();
  });
} else {
  log.info('single-account mode — set SUPABASE_URL, SUPABASE_ANON_KEY and DATABASE_URL for the multi-account build');
}

// ---------------------------------------------------------------- the secret guard

/**
 * Constant-time, and length-independent. `===` on a secret leaks its prefix to anyone who can time
 * a few thousand requests; timingSafeEqual throws rather than compares when the lengths differ,
 * which leaks the length instead — so both sides are hashed to a fixed width first.
 */
const sha = (s: string) => crypto.createHash('sha256').update(s).digest();
const SECRET_HASH = sha(cfg.secret);
const secretOk = (given: unknown): boolean => typeof given === 'string' && given.length > 0 && crypto.timingSafeEqual(sha(given), SECRET_HASH);

// ---------------------------------------------------------------- connector

mountMcp(app, '/:secret/mcp', (req) => (secretOk(req.params.secret) ? ctx : null), log);

// ---------------------------------------------------------------- setup page

// Behind the secret, so operator detail is appropriate here in a way it is not on /status. It exists
// because every failure this server has is a configuration failure, and "403 PERMISSION_DENIED" in a
// log does not tell anyone which of four things to fix.
app.get('/:secret/setup', (req, res) => {
  if (!secretOk(req.params.secret)) {
    res.status(404).type('text/plain').send('not found');
    return;
  }
  const st = gsc.status();
  const kind = authKind(cfg);
  const row = (ok: boolean | null, label: string, detail: string) =>
    `<tr><td style="padding:.4rem .8rem .4rem 0;font-size:1.1rem">${ok === null ? '·' : ok ? '✓' : '✗'}</td>` +
    `<td style="padding:.4rem 0"><strong>${esc(label)}</strong><br><span style="color:#555">${detail}</span></td></tr>`;

  const rows = [
    row(!cfg.secretGenerated, 'MCP_SECRET', cfg.secretGenerated ? 'Not set — a random one was generated for this run, so the connector URL changes on every restart.' : 'Set. The connector URL is this page with <code>/setup</code> replaced by <code>/mcp</code>.'),
    row(kind !== 'adc', 'Google credentials', kind === 'oauth' ? 'OAuth refresh token — the supported path for a hosted deployment.' : kind === 'inline' ? 'Service account key from GOOGLE_CREDENTIALS_JSON.' : kind === 'file' ? `Service account key file at <code>${esc(cfg.credentialsFile)}</code>.` : 'None set. Falling back to gcloud Application Default Credentials, which do not exist on a container — set GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET and GOOGLE_REFRESH_TOKEN.'),
    row(kind !== 'oauth' || Boolean(cfg.quotaProject), 'Quota project', cfg.quotaProject ? `<code>${esc(cfg.quotaProject)}</code>` : kind === 'oauth' ? 'Not set, and user credentials require one — Search Console answers 403 without it. Set GOOGLE_QUOTA_PROJECT.' : 'Not needed with a service account key, which bills its own project.'),
    row(st.error ? false : st.ready ? true : null, 'Google answered', st.error ? esc(st.error) : st.ready ? `Yes — ${st.sites ?? 0} propert${st.sites === 1 ? 'y' : 'ies'} visible.` : 'Not called yet.'),
    row(cfg.defaultSite ? true : null, 'Default property', cfg.defaultSite ? `<code>${esc(cfg.defaultSite)}</code>` : 'None. Tools require an explicit siteUrl; set GSC_DEFAULT_SITE to bind this connector to one property.'),
  ].join('');

  res.type('html').send(
    page(
      'GOOGLE2AI setup',
      `<h1 style="margin:0 0 .25rem">GOOGLE2AI</h1>` +
        `<p style="color:#555;margin:0 0 1.5rem">v${VERSION}${COMMIT ? ` · ${esc(COMMIT)}` : ''} · auth: ${esc(kind)}</p>` +
        `<table style="border-collapse:collapse;width:100%">${rows}</table>` +
        `<p style="margin-top:2rem;color:#555">Add it in claude.ai → Settings → Connectors → Add custom connector, with no OAuth. The secret in the URL is the credential, so treat the whole URL like a password.</p>`,
    ),
  );
});

// Only on the single-account build: with the tenant surface mounted, / is its landing page.
if (!saasReady) {
  app.get('/', (_req, res) => {
    res.type('html').send(page('GOOGLE2AI', `<h1>GOOGLE2AI</h1><p>A Model Context Protocol server for Google Search Console. The connector lives at a secret path; if you are the operator, you know it.</p>`));
  });
}

// ---------------------------------------------------------------- lifecycle

const httpServer = app.listen(cfg.port, cfg.host, () => {
  log.info({ host: cfg.host, port: cfg.port, mock: cfg.mock, auth: gsc.status().auth, defaultSite: cfg.defaultSite || null, tenantSurface: saasReady }, `GOOGLE2AI v${VERSION} listening`);
});

const shutdown = (sig: string) => {
  log.info({ sig }, 'shutting down');
  if (reaper) clearInterval(reaper);
  void pgHandle?.close().catch(() => undefined);
  httpServer.close(() => process.exit(0));
  // A connection that never closes must not hold the process past the platform's grace period; Fly
  // sends SIGKILL after it, and a half-closed listener is a failed deploy that looks like a hang.
  setTimeout(() => process.exit(0), 5000).unref();
};

// A rejected promise nobody awaited must not kill the server: Node's default is to exit. Logged
// loudly — it is a bug every time — but no longer fatal.
process.on('unhandledRejection', (reason) => {
  log.error({ err: reason instanceof Error ? reason.stack : String(reason) }, 'unhandled promise rejection (a bug — the server stays up)');
});
// An uncaught exception leaves the process in an unknown state, so this one still exits, but through
// shutdown() so in-flight responses finish.
process.on('uncaughtException', (err) => {
  log.fatal({ err: err.stack ?? String(err) }, 'uncaught exception — shutting down');
  shutdown('uncaughtException');
});
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
