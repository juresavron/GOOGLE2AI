// The real server, over real HTTP, with no credentials and no network (GSC_MOCK=1).
//
// This is the suite the deploy workflow leans on: everything below is asserted again against the
// live machine after a release, so a regression that only shows up once the process is actually
// listening cannot reach production green.
import { strict as assert } from 'node:assert';
import { after, before, test } from 'node:test';
import { spawn, type ChildProcess } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.dirname(fileURLToPath(import.meta.url)).replace(/\/tests$/, '');
const SECRET = 'test-secret-not-a-real-one';
let child: ChildProcess;
let base: string;

const waitForHealth = async (url: string, tries = 60): Promise<void> => {
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
  // Port 0 would be chosen by the kernel, but the server logs rather than returns it — so a fixed
  // high port it is, with the PID mixed in to keep parallel runs on one machine apart.
  const port = 18000 + (process.pid % 2000);
  base = `http://127.0.0.1:${port}`;
  child = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', 'src/index.ts'], {
    cwd: ROOT,
    env: { ...process.env, GSC_MOCK: '1', MCP_SECRET: SECRET, PORT: String(port), HOST: '127.0.0.1', LOG_LEVEL: 'silent', GIT_SHA: 'abcdef1234567890' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  await waitForHealth(`${base}/healthz`);
});

after(() => void child?.kill('SIGTERM'));

const rpc = async (body: unknown, secret = SECRET) => {
  const res = await fetch(`${base}/${secret}/mcp`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' },
    body: JSON.stringify(body),
  });
  return { status: res.status, body: res.ok ? await res.json() : await res.text() };
};

test('/healthz carries the state and the commit it is running', async () => {
  const text = await (await fetch(`${base}/healthz`)).text();
  assert.match(text, /^ok mock abcdef1/, 'the deploy workflow greps this for the sha it just pushed');
});

test('/status is public and leaks no property, no error text and no secret', async () => {
  const res = await fetch(`${base}/status`);
  assert.equal(res.status, 200);
  const s = (await res.json()) as Record<string, unknown>;

  assert.equal(s.commit, 'abcdef1');
  assert.equal(s.writes_possible, false, 'GSC_ALLOW_WRITE is unset in this run');
  assert.equal(s.multi_tenant, 'off');
  assert.equal(s.properties, 2, 'a count is fine; the names are not');

  // Asserted here AND again by the deploy against the live server, because a regression that
  // published a customer's domain would be invisible from a green deploy.
  const flat = JSON.stringify(s);
  for (const forbidden of ['siteUrl', 'default_site', 'defaultSite', 'error', 'secret', 'token', 'refresh']) {
    assert.ok(!Object.keys(s).includes(forbidden), `/status must not carry ${forbidden}`);
  }
  assert.ok(!flat.includes('example.com'), '/status must not name a property');
  assert.ok(!flat.includes(SECRET), '/status must never echo the secret');
});

test('the wrong secret is a 404 — the same answer a nonexistent path gets', async () => {
  const { status } = await rpc({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 't', version: '0' } } }, 'wrong-secret');
  // Not 401 or 403: a distinguishable answer confirms to a scanner that the path shape is right
  // and only the secret is wrong.
  assert.equal(status, 404);
});

test('the setup page is behind the secret', async () => {
  assert.equal((await fetch(`${base}/${SECRET}/setup`)).status, 200);
  assert.equal((await fetch(`${base}/wrong-secret/setup`)).status, 404);
});

test('the setup page never prints the secret it is guarded by', async () => {
  const html = await (await fetch(`${base}/${SECRET}/setup`)).text();
  // It is already in the URL bar; putting it in the body puts it into screenshots and into any
  // page the browser saves or syncs.
  assert.ok(!html.includes(SECRET), 'the setup page must not echo the secret into its body');
});

test('security headers are on every response', async () => {
  for (const p of ['/healthz', '/status', `/${SECRET}/setup`]) {
    const res = await fetch(`${base}${p}`);
    assert.equal(res.headers.get('x-content-type-options'), 'nosniff', p);
    assert.equal(res.headers.get('x-frame-options'), 'DENY', p);
    assert.equal(res.headers.get('referrer-policy'), 'no-referrer', p);
    const csp = String(res.headers.get('content-security-policy'));
    assert.match(csp, /default-src 'none'/, p);
    // Chrome checks form-action against every redirect hop, and the consent flow's last hop is
    // Google's. Without this the "Continue to Google" button does nothing at all — no error, no
    // navigation, just a dead button.
    assert.match(csp, /form-action 'self' https:\/\/accounts\.google\.com/, p);
    // And nothing wider: 'self' plus exactly one host, not a wildcard.
    assert.doesNotMatch(csp, /form-action[^;]*\*/, p);
  }
});

test('GET and DELETE on the connector are 405, not 404', async () => {
  for (const method of ['GET', 'DELETE']) {
    const res = await fetch(`${base}/${SECRET}/mcp`, { method });
    assert.equal(res.status, 405, method);
    assert.equal(res.headers.get('allow'), 'POST');
  }
});

test('the connector completes a handshake and lists its tools', async () => {
  const init = await rpc({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 't', version: '0' } } });
  assert.equal(init.status, 200);
  const result = (init.body as { result: { serverInfo: { name: string }; instructions?: string } }).result;
  assert.equal(result.serverInfo.name, 'GOOGLE2AI');
  // The instructions ride the handshake. Without them a client gets a bag of tools and no idea
  // that the data is three days old — which is the whole difference between this and a thin
  // wrapper over the API.
  assert.match(String(result.instructions), /DAYS BEHIND/);

  const list = await rpc({ jsonrpc: '2.0', id: 2, method: 'tools/list' });
  const names = (list.body as { result: { tools: { name: string }[] } }).result.tools.map((t) => t.name);
  assert.ok(names.includes('compare_periods'));
  assert.ok(names.includes('submit_sitemap'), 'the write tools are registered even with writes off');
  assert.equal(names.length, 11);
});

test('a tool call returns real content through the transport', async () => {
  const res = await rpc({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'list_sites', arguments: {} } });
  const text = (res.body as { result: { content: { text: string }[] } }).result.content[0]!.text;
  assert.match(text, /sc-domain:example\.com/);
});

test('an oversized body is refused rather than parsed', async () => {
  const res = await fetch(`${base}/${SECRET}/mcp`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 4, method: 'tools/call', params: { name: 'list_sites', arguments: { pad: 'x'.repeat(2 * 1024 * 1024) } } }),
  });
  assert.equal(res.status, 413);
});
