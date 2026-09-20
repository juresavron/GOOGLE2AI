import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { authKind, configFromEnv, loadDotenv, type Config } from '../src/env.ts';

const withEnv = <T>(vars: Record<string, string | undefined>, fn: () => T): T => {
  const saved = { ...process.env };
  for (const [k, v] of Object.entries(vars)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  try {
    return fn();
  } finally {
    process.env = saved;
  }
};

const CLEAN = {
  GOOGLE_CLIENT_ID: undefined,
  GOOGLE_CLIENT_SECRET: undefined,
  GOOGLE_REFRESH_TOKEN: undefined,
  GOOGLE_CREDENTIALS_JSON: undefined,
  GOOGLE_APPLICATION_CREDENTIALS: undefined,
  GOOGLE_QUOTA_PROJECT: undefined,
  GSC_DEFAULT_SITE: undefined,
  GSC_MAX_ROWS: undefined,
  MCP_SECRET: undefined,
};

test('loadDotenv parses values, strips comments and quotes, and never overrides a real env var', () => {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'g2a-')), '.env');
  fs.writeFileSync(file, ['# a comment', 'PLAIN=hello', 'QUOTED="with spaces"', 'TRAILING=value   # explain', 'EMPTY=', 'ALREADY_SET=from-file', 'no_equals_line'].join('\n'));

  withEnv({ PLAIN: undefined, QUOTED: undefined, TRAILING: undefined, ALREADY_SET: 'from-environment' }, () => {
    loadDotenv(file);
    assert.equal(process.env.PLAIN, 'hello');
    assert.equal(process.env.QUOTED, 'with spaces');
    assert.equal(process.env.TRAILING, 'value', 'an inline comment is not part of the value');
    // The precedence matters on Fly, where secrets arrive as real environment variables and a
    // stale .env baked into an image must never win over them.
    assert.equal(process.env.ALREADY_SET, 'from-environment');
  });
});

test('a missing .env is not an error', () => {
  assert.doesNotThrow(() => loadDotenv('/nonexistent/.env'));
});

test('authKind prefers OAuth, then an inline key, then a key file, then ADC', () => {
  const kind = (vars: Record<string, string | undefined>) => withEnv({ ...CLEAN, ...vars }, () => authKind(configFromEnv()));

  assert.equal(kind({}), 'adc');
  assert.equal(kind({ GOOGLE_APPLICATION_CREDENTIALS: '/k.json' }), 'file');
  assert.equal(kind({ GOOGLE_CREDENTIALS_JSON: '{"type":"service_account"}', GOOGLE_APPLICATION_CREDENTIALS: '/k.json' }), 'inline');
  assert.equal(
    kind({ GOOGLE_CLIENT_ID: 'id', GOOGLE_CLIENT_SECRET: 'sec', GOOGLE_REFRESH_TOKEN: 'ref', GOOGLE_CREDENTIALS_JSON: '{"type":"service_account"}' }),
    'oauth',
    'OAuth wins even with a service account key present — it is the only path that works hosted',
  );
  // Two of the three OAuth variables is not OAuth. Treating it as such produced a client that threw
  // on the first call with a message about an invalid grant, which reads like a revoked token.
  assert.equal(kind({ GOOGLE_CLIENT_ID: 'id', GOOGLE_CLIENT_SECRET: 'sec' }), 'adc');
});

test('a generated secret is flagged, and a configured one is not', () => {
  const generated = withEnv({ ...CLEAN }, () => configFromEnv());
  assert.equal(generated.secretGenerated, true);
  assert.ok(generated.secret.length >= 32, 'a generated secret is long enough to be a credential');

  const configured = withEnv({ ...CLEAN, MCP_SECRET: 'a-real-secret' }, () => configFromEnv());
  assert.equal(configured.secretGenerated, false);
  assert.equal(configured.secret, 'a-real-secret');
});

test('maxRows is clamped to the ceiling the API actually accepts', () => {
  const rows = (v?: string) => withEnv({ ...CLEAN, GSC_MAX_ROWS: v }, () => configFromEnv().maxRows);
  assert.equal(rows(), 25000);
  assert.equal(rows('500'), 500);
  // Google rejects anything above 25000, so a larger configured value would fail every request
  // that used it rather than returning more rows.
  assert.equal(rows('100000'), 25000);
});

test('values that are only whitespace count as unset', () => {
  const cfg: Config = withEnv({ ...CLEAN, GSC_DEFAULT_SITE: '   ', GOOGLE_QUOTA_PROJECT: ' ' }, () => configFromEnv());
  assert.equal(cfg.defaultSite, '');
  assert.equal(cfg.quotaProject, '');
});


// ------------------------------------------------------------------ port agreement
//
// A deploy failed on exactly this: Fly's launcher rewrote fly.toml's internal_port to 8080 while
// leaving PORT at 8000, so the app listened on one port and Fly's proxy knocked on the other. Every
// health check reported "Request failed" while the container was perfectly healthy, and nothing in
// the logs said why — the app had no idea anyone was knocking.
//
// Four files have to agree about the port and none of them imports another, so nothing but a test
// can hold them together.

const ROOT = path.dirname(fileURLToPath(import.meta.url)).replace(/\/tests$/, '');
const read = (f: string) => fs.readFileSync(path.join(ROOT, f), 'utf8');

test('fly.toml, the Dockerfile and the config default all name the same port', () => {
  const fly = read('fly.toml');
  const dockerfile = read('Dockerfile');

  const internal = /internal_port\s*=\s*(\d+)/.exec(fly)?.[1];
  const flyEnv = /^\s*PORT\s*=\s*'(\d+)'/m.exec(fly)?.[1];
  const dockerEnv = /PORT=(\d+)/.exec(dockerfile)?.[1];
  const expose = /EXPOSE\s+(\d+)/.exec(dockerfile)?.[1];
  const healthcheck = /process\.env\.PORT\|\|(\d+)/.exec(dockerfile)?.[1];

  assert.ok(internal && flyEnv && dockerEnv && expose && healthcheck, 'every port must be findable');
  // internal_port is where Fly's proxy connects; PORT is where the app listens. They are not the
  // same setting and nothing makes them agree except this.
  assert.equal(internal, flyEnv, "fly.toml's internal_port must match its own PORT");
  assert.equal(dockerEnv, flyEnv, 'the image default must match fly.toml');
  assert.equal(expose, flyEnv, 'EXPOSE must match');
  assert.equal(healthcheck, flyEnv, "the image's own healthcheck must match");

  // And the code's default, for a bare `node src/index.ts` with no environment at all.
  const cfg = withEnv({ ...CLEAN, PORT: undefined }, () => configFromEnv());
  assert.equal(String(cfg.port), flyEnv, 'configFromEnv default must match');
});

test('the self-hosted path proxies to the same port too', () => {
  const flyEnv = /^\s*PORT\s*=\s*'(\d+)'/m.exec(read('fly.toml'))?.[1];
  // Caddy fronts the container on a VPS. It fails the same silent way if it points elsewhere.
  assert.match(read('Caddyfile'), new RegExp(`reverse_proxy google2ai:${flyEnv}`));
  assert.match(read('docker-compose.yml'), new RegExp(`PORT: ${flyEnv}`));
});
