// The tenant surface, over real HTTP, with the database deliberately unreachable.
//
// CI has no Postgres and no Supabase, so this cannot exercise a sign-in or a consent. What it CAN
// prove is the half that a unit test cannot: that the routes mount at all, that the surface
// degrades rather than crashes when the database is down, and that a misconfiguration which would
// store credentials unsealed refuses to start instead.
import { strict as assert } from 'node:assert';
import { after, before, test } from 'node:test';
import { spawn, type ChildProcess } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.dirname(fileURLToPath(import.meta.url)).replace(/\/tests$/, '');
const SECRET = 'operator-secret-not-a-real-one';
let child: ChildProcess;
let base: string;

const SAAS_ENV = {
  GSC_MOCK: '1',
  MCP_SECRET: SECRET,
  HOST: '127.0.0.1',
  LOG_LEVEL: 'silent',
  GIT_SHA: 'beef1234567890',
  SUPABASE_URL: 'https://example.supabase.co',
  SUPABASE_ANON_KEY: 'anon-key',
  // Points nowhere on purpose: every assertion below is about what happens when it does not answer.
  DATABASE_URL: 'postgresql://postgres.ref:pw@127.0.0.1:59999/postgres',
  PUBLIC_ORIGIN: 'https://google2ai.example',
  MASTER_KEY: 'MDEyMzQ1Njc4OWFiY2RlZjAxMjM0NTY3ODlhYmNkZWY',
};

const waitForHealth = async (url: string, tries = 80): Promise<void> => {
  for (let i = 0; i < tries; i++) {
    try {
      if ((await fetch(url)).ok) return;
    } catch {
      /* not listening yet */
    }
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error(`server never became healthy at ${url}`);
};

before(async () => {
  const port = 19000 + (process.pid % 2000);
  base = `http://127.0.0.1:${port}`;
  child = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', 'src/index.ts'], {
    cwd: ROOT,
    env: { ...process.env, ...SAAS_ENV, PORT: String(port) },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  await waitForHealth(`${base}/healthz`);
});

after(() => void child?.kill('SIGTERM'));

test('the server starts and serves even with the database unreachable', async () => {
  // A tenant surface that refused to listen without Postgres would take the operator connector and
  // the health endpoint down with it, and leave nothing able to say why.
  assert.match(await (await fetch(`${base}/healthz`)).text(), /^ok mock beef123/);
});

test('/status distinguishes "no tenant surface" from "its database is down"', async () => {
  const s = (await (await fetch(`${base}/status`)).json()) as Record<string, unknown>;
  assert.equal(s.multi_tenant, 'database-unavailable');
  // Still no property names and no error text on the public endpoint, tenant surface or not.
  const flat = JSON.stringify(s);
  assert.ok(!flat.includes('supabase'), '/status must not name the database');
  assert.ok(!flat.includes(SAAS_ENV.MASTER_KEY));
  assert.ok(!flat.includes(SECRET));
});

test('the landing page renders without touching the database', async () => {
  const res = await fetch(`${base}/`, { redirect: 'manual' });
  assert.equal(res.status, 200);
  const html = await res.text();
  assert.match(html, /GOOGLE2AI/);
  // It is the page a stranger sees; it must not depend on Postgres being up.
  assert.match(html, /Get started/);
  // The claim rather than the wording: the landing page must keep saying that writes exist and are
  // off until you enable them. Copy gets rewritten; that promise should not vanish with it.
  assert.match(html, /switched off until you turn them on/i);
});

test('the sign-in page renders, and the dashboard refuses without a session', async () => {
  assert.equal((await fetch(`${base}/login`, { redirect: 'manual' })).status, 200);

  const app = await fetch(`${base}/app`, { redirect: 'manual' });
  assert.equal(app.status, 303);
  assert.equal(app.headers.get('location'), '/login');
});

test('every mutating route requires a session', async () => {
  for (const p of ['/app/accounts', '/app/accounts/x/property', '/app/accounts/x/tokens', '/app/accounts/x/delete']) {
    const res = await fetch(`${base}${p}`, { method: 'POST', redirect: 'manual', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: 'label=x' });
    assert.equal(res.status, 303, p);
    assert.equal(res.headers.get('location'), '/login', p);
  }
  const start = await fetch(`${base}/oauth/google/start?account=x`, { redirect: 'manual' });
  assert.equal(start.status, 303);
  assert.equal(start.headers.get('location'), '/login');
});

test('a malformed account id is "no such account", never a 500', async () => {
  // These ids land in a uuid column. Postgres throws `invalid input syntax for type uuid` on
  // anything else, which without a guard is a 500 — a worse answer, and a louder one: it tells a
  // caller probing for valid ids that theirs reached the database.
  //
  // Asserted via the redirect target rather than the database, which is unreachable in this run:
  // a guarded route redirects to /login (no session) before touching Postgres at all, while an
  // unguarded one would have to reach it to fail.
  for (const path of ['/app/accounts/not-a-uuid/property', '/app/accounts/..%2F..%2Fetc/tokens', "/app/accounts/'; drop table gsc_accounts;--/delete", '/app/accounts/x/write']) {
    const res = await fetch(`${base}${path}`, {
      method: 'POST',
      redirect: 'manual',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: 'allow=1&property=sc-domain%3Aexample.com',
    });
    assert.equal(res.status, 303, path);
    assert.ok([503, 500].includes(res.status) === false, path);
  }

  const start = await fetch(`${base}/oauth/google/start?account=not-a-uuid`, { redirect: 'manual' });
  assert.equal(start.status, 303);
});

test('a connector token answers 503 while the database is down, not 404', async () => {
  const res = await fetch(`${base}/c/some-token/mcp`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 't', version: '0' } } }),
  });
  // 404 would tell the holder of a perfectly good connector URL that it had been revoked, and they
  // would go and reissue it. "Temporarily unavailable" is the truth.
  assert.equal(res.status, 503);
  assert.match(JSON.stringify(await res.json()), /Temporarily unavailable/);
});

test('the operator connector still works while the tenant surface is degraded', async () => {
  // The two surfaces are genuinely separate products sharing a process; one being unable to reach
  // Postgres must not take the other down.
  const res = await fetch(`${base}/${SECRET}/mcp`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
  });
  assert.equal(res.status, 200);
  assert.match(JSON.stringify(await res.json()), /compare_periods/);
});

test('/app.js is served, so the CSP can keep refusing inline script', async () => {
  const res = await fetch(`${base}/app.js`);
  assert.equal(res.status, 200);
  assert.match(String(res.headers.get('content-type')), /javascript/);
  assert.match(await res.text(), /data-confirm|dataset\.confirm/);
});

test('the legal pages render, and refuse to invent an operator', async () => {
  for (const path of ['/privacy', '/terms']) {
    const res = await fetch(`${base}${path}`);
    assert.equal(res.status, 200, path);
    const html = await res.text();
    // OPERATOR_NAME and OPERATOR_CONTACT are unset in this run. A policy naming nobody is worse
    // than no policy, and an invented company would be a lie told to someone deciding whether to
    // trust this with their Google account.
    assert.match(html, /has not said who runs it/, path);
    assert.match(html, /OPERATOR_NAME/, path);
  }
});

test('the privacy page states the real scopes, that writing exists, and what is not stored', async () => {
  const html = await (await fetch(`${base}/privacy`)).text();
  assert.match(html, /<code>webmasters<\/code>/);
  assert.match(html, /<code>indexing<\/code>/);
  // The page used to promise read-only, which was true then and is not now. A privacy page that
  // understates what the software can do is worse than one that says nothing.
  assert.match(html, /That includes writing/);
  assert.match(html, /switched off unless you turn them on/);
  assert.doesNotMatch(html, /read-only/i);
  // The two claims the rest of the codebase actually has to keep: no copy of the traffic, and only
  // a hash of the connector URL.
  assert.match(html, /never a search term/);
  assert.match(html, /SHA-256 hash/);
});

test('the operator panel is not reachable without a session', async () => {
  const res = await fetch(`${base}/app/operator`, { redirect: 'manual' });
  assert.equal(res.status, 303);
  assert.equal(res.headers.get('location'), '/login');
});

test('the legal pages are linked from the pages a stranger lands on', async () => {
  for (const path of ['/', '/login']) {
    const html = await (await fetch(`${base}${path}`)).text();
    assert.match(html, /href="\/privacy"/, path);
    assert.match(html, /href="\/terms"/, path);
  }
});

test('the tenant build refuses to start with no MASTER_KEY', async () => {
  // Starting would mean storing every tenant's Google refresh token unsealed, on a server that
  // looks healthy right up until the database leaks.
  const { MASTER_KEY: _omitted, ...withoutKey } = SAAS_ENV;
  const proc = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', 'src/index.ts'], {
    cwd: ROOT,
    env: { ...process.env, ...withoutKey, MASTER_KEY: '', PORT: '19999', LOG_LEVEL: 'fatal' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let out = '';
  proc.stdout?.on('data', (b) => (out += String(b)));
  proc.stderr?.on('data', (b) => (out += String(b)));

  const code = await new Promise<number>((resolve) => proc.on('exit', (c) => resolve(c ?? -1)));
  assert.equal(code, 1, 'it must exit, not warn and carry on');
  assert.match(out, /MASTER_KEY is not set/);
});

test('the tenant build also refuses to start with a MALFORMED MASTER_KEY', async () => {
  // The case that reached production: present, so the old `if (!masterKey)` check passed, the
  // server booted looking healthy, and it threw on the first consent — AFTER Google had already
  // authorised the user, who then saw a failure they could do nothing about.
  const proc = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', 'src/index.ts'], {
    cwd: ROOT,
    env: { ...process.env, ...SAAS_ENV, MASTER_KEY: 'too-short-to-be-a-key', PORT: '19998', LOG_LEVEL: 'fatal' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let out = '';
  proc.stdout?.on('data', (b) => (out += String(b)));
  proc.stderr?.on('data', (b) => (out += String(b)));

  const code = await new Promise<number>((resolve) => proc.on('exit', (c) => resolve(c ?? -1)));
  assert.equal(code, 1, 'a wrong-shaped key must fail at BOOT, not at the first consent');
  assert.match(out, /must be exactly 32/);
  assert.match(out, /randomBytes\(32\)/, 'and say how to make one');
});
