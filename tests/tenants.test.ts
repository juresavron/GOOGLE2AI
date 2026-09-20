import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import pino from 'pino';
import { configFromEnv } from '../src/env.ts';
import type { Account, Connector, Db, Settings } from '../src/db.ts';
import { GoogleOAuth } from '../src/google-oauth.ts';
import { generateMasterKey, seal } from '../src/secrets.ts';
import { mintToken, Tenants, tokenHash } from '../src/tenants.ts';

const MASTER = generateMasterKey();
const ACCOUNT = '33333333-3333-4333-8333-333333333333';
const log = pino({ level: 'silent' });

const account = (over: Partial<Account> = {}): Account => ({
  id: ACCOUNT,
  user_id: '11111111-1111-4111-8111-111111111111',
  label: 'Ocenagor',
  google_email: 'jure@example.com',
  property: 'sc-domain:ocenagor.si',
  all_properties: false,
  quota_project: 'proj-from-row',
  status: 'connected',
  allow_write: false,
  last_checked_at: null,
  last_error: null,
  created_at: new Date(),
  ...over,
});

class FakeDb {
  connector: Connector | null = null;
  calls: { tool: string; ok: boolean }[] = [];
  perMinute = 0;
  touched: string[] = [];
  pending: { id: string; sealed: any }[] = [];
  finished: string[] = [];
  droppedSecrets: string[] = [];

  /**
   * The deployment-wide write switch. Present on the fake on purpose: without it every resolve()
   * would take the fail-closed branch, and a suite that is green because the switch is unreadable
   * is not testing the switch.
   */
  settings: Settings = { allow_write: false, allow_write_by: null, allow_write_at: null };
  async getSettings() {
    return this.settings;
  }

  async connectorByToken(): Promise<Connector | null> {
    return this.connector;
  }
  async callsInLastMinute(): Promise<number> {
    return this.perMinute;
  }
  async touchToken(id: string): Promise<void> {
    this.touched.push(id);
  }
  async recordCall(_a: string, c: { tool: string; ok: boolean }): Promise<void> {
    this.calls.push({ tool: c.tool, ok: c.ok });
  }
  async pendingDeletes() {
    return this.pending;
  }
  async finishDelete(id: string): Promise<void> {
    this.finished.push(id);
  }
  async dropSecret(id: string): Promise<void> {
    this.droppedSecrets.push(id);
  }
}

const connected = (db: FakeDb, over: Partial<Account> = {}) => {
  db.connector = { account: account(over), sealed: seal(MASTER, ACCOUNT, '1//0refresh'), token_id: 'tok-1' };
  return db;
};

const build = (db: FakeDb, revoke?: (t: string) => Promise<void>) => {
  const cfg = { ...configFromEnv(), clientId: 'cid', clientSecret: 'csec', quotaProject: 'proj-from-env' };
  const oauth = new GoogleOAuth('cid', 'csec', 'https://x/cb');
  if (revoke) (oauth as unknown as { revoke: (t: string) => Promise<void> }).revoke = revoke;
  return new Tenants(cfg, db as unknown as Db, oauth, log, MASTER, { maxCallsPerMinute: 5, ttlMs: 60_000 });
};

const isCtx = (r: unknown): r is { cfg: { defaultSite: string }; gsc: unknown; onCall?: (c: any) => void } =>
  Boolean(r && typeof r === 'object' && 'gsc' in (r as object));

test('an unknown or revoked token is 404, not a reason', async () => {
  const db = new FakeDb();
  db.connector = null;
  // connectorByToken already filters revoked tokens and deleted accounts in SQL, so both arrive
  // here as null — and both must answer the same, or a dead URL tells its holder which it was.
  assert.equal(await build(db).resolve('whatever'), null);
  assert.equal(await build(db).resolve(''), null);
});

test('an account that has not consented yet is 503 with what to do', async () => {
  const db = new FakeDb();
  db.connector = { account: account({ status: 'pending' }), sealed: null, token_id: 't' };
  const r = await build(db).resolve('tok');
  assert.match(String((r as { unavailable: string }).unavailable), /has not been connected yet/);
});

test('a withdrawn Google grant says the connector URL still works', async () => {
  const db = connected(new FakeDb(), { status: 'revoked' });
  const r = await build(db).resolve('tok');
  // The distinction that matters to the owner: reconnect Google, do not reissue the URL and
  // update it everywhere.
  assert.match(String((r as { unavailable: string }).unavailable), /connector URL itself stays the same/);
});

test('an account with no property selected says so rather than failing per tool', async () => {
  const db = connected(new FakeDb(), { property: null });
  const r = await build(db).resolve('tok');
  assert.match(String((r as { unavailable: string }).unavailable), /no Search Console property selected/);
});

test('a runaway loop gets 429 and a Retry-After', async () => {
  const db = connected(new FakeDb());
  db.perMinute = 5;
  const r = (await build(db).resolve('tok')) as { tooMany: string; retryAfter: number };
  assert.match(r.tooMany, /ceiling/);
  assert.equal(r.retryAfter, 30);
});

test('a live connector resolves, bound to its own property', async () => {
  const db = connected(new FakeDb());
  const r = await build(db).resolve('tok');
  assert.ok(isCtx(r));
  // This is what makes a tenant connector read as bound to one property: its tools can be called
  // with no siteUrl and the instructions name it.
  assert.equal(r.cfg.defaultSite, 'sc-domain:ocenagor.si');
});

const quotaOf = (r: unknown) => (r as { gsc: { status(): { quota_project: string | null; auth: string } } }).gsc.status();

test('the account row’s quota project is used when it has one', async () => {
  const db = connected(new FakeDb());
  const r = await build(db).resolve('tok');
  assert.ok(isCtx(r));
  const status = quotaOf(r);
  assert.equal(status.quota_project, 'proj-from-row');
  assert.equal(status.auth, 'tenant', 'a tenant client must never report the operator’s auth chain');
});

test('a tenant with NO quota project does not inherit the operator’s', async () => {
  // This inheritance broke every tenant call with a 403. x-goog-user-project asserts that the
  // CALLER may consume quota in that project, and Google checks serviceusage.services.use against
  // the identity that consented — a tenant, who is a stranger to the operator's Cloud project. The
  // remedy Google's message proposes (grant them roles/serviceusage.serviceUsageConsumer) means
  // adding every customer as an IAM principal, so the fix is to send no header at all: quota then
  // attributes to the project owning the OAuth client, which is the operator's regardless.
  const db = connected(new FakeDb(), { quota_project: null });
  const r = await build(db).resolve('tok');
  assert.ok(isCtx(r));
  assert.equal(quotaOf(r).quota_project, null, 'proj-from-env must not leak into a tenant client');
});

test('the built client is reused, so a tool call does not cost a token exchange', async () => {
  const db = connected(new FakeDb());
  const t = build(db);
  const a = await t.resolve('tok');
  const b = await t.resolve('tok');
  assert.ok(isCtx(a) && isCtx(b));
  // googleapis caches the access token on the instance. A new one per request means a round trip
  // to Google before every single tool call.
  assert.equal(a.gsc, b.gsc);

  t.forget(ACCOUNT);
  const c = await t.resolve('tok');
  assert.ok(isCtx(c));
  assert.notEqual(a.gsc, c.gsc, 'forget() must drop it, or a revoked credential outlives its row');
});

test('a credential that will not unseal is the operator’s problem, not the tenant’s', async () => {
  const db = new FakeDb();
  db.connector = { account: account(), sealed: seal(generateMasterKey(), ACCOUNT, 'x'), token_id: 't' };
  const r = await build(db).resolve('tok');
  const msg = String((r as { unavailable: string }).unavailable);
  // A MASTER_KEY that changed is a deployment error. Telling the tenant their connection is broken
  // would send them to re-consent, which would not fix it.
  assert.match(msg, /operator has been notified/);
  assert.doesNotMatch(msg, /MASTER_KEY/, 'and the reason does not leak to whoever holds the URL');
});

test('usage is recorded and the token touched, without either being able to break a call', async () => {
  const db = connected(new FakeDb());
  const r = await build(db).resolve('tok');
  assert.ok(isCtx(r));

  r.onCall?.({ tool: 'search_analytics', ok: true, ms: 12, code: null });
  await new Promise((res) => setImmediate(res));
  assert.deepEqual(db.calls, [{ tool: 'search_analytics', ok: true }]);
  assert.deepEqual(db.touched, ['tok-1']);
});

test('a failing usage write does not throw into the caller', async () => {
  const db = connected(new FakeDb());
  db.recordCall = async () => {
    throw new Error('database gone');
  };
  db.touchToken = async () => {
    throw new Error('database gone');
  };
  const r = await build(db).resolve('tok');
  assert.ok(isCtx(r));
  assert.doesNotThrow(() => r.onCall?.({ tool: 'status', ok: true, ms: 1, code: null }));
  await new Promise((res) => setImmediate(res));
});

test('the reaper revokes at Google before it forgets the row', async () => {
  const db = new FakeDb();
  db.pending = [{ id: ACCOUNT, sealed: seal(MASTER, ACCOUNT, '1//0refresh') }];
  const revoked: string[] = [];
  const done = await build(db, async (t) => void revoked.push(t)).reap();

  assert.equal(done, 1);
  assert.deepEqual(revoked, ['1//0refresh'], 'the grant is ended at Google, which deleting a row cannot do');
  // Order matters: the secret goes only once Google has accepted the revocation, or an interrupted
  // reap would leave a live grant with nothing left to revoke it with.
  assert.deepEqual(db.droppedSecrets, [ACCOUNT]);
  assert.deepEqual(db.finished, [ACCOUNT]);
});

test('a reap that Google refuses leaves the row for the next pass', async () => {
  const db = new FakeDb();
  db.pending = [{ id: ACCOUNT, sealed: seal(MASTER, ACCOUNT, '1//0refresh') }];
  const done = await build(db, async () => {
    throw new Error('Google is down');
  }).reap();

  assert.equal(done, 0);
  // The row stays tombstoned and its tokens stay revoked, so nothing is reachable in the meantime;
  // the only thing outstanding is the call to Google.
  assert.deepEqual(db.finished, []);
  assert.deepEqual(db.droppedSecrets, []);
});

test('a tombstoned row with no credential still gets cleaned up', async () => {
  const db = new FakeDb();
  db.pending = [{ id: ACCOUNT, sealed: null }];
  assert.equal(await build(db, async () => assert.fail('nothing to revoke')).reap(), 1);
  assert.deepEqual(db.finished, [ACCOUNT]);
});

test('a minted token is never stored — only its hash', () => {
  const token = mintToken();
  assert.ok(token.length >= 40);
  assert.match(tokenHash(token), /^[0-9a-f]{64}$/);
  assert.notEqual(tokenHash(token), token);
  assert.notEqual(mintToken(), mintToken());
});

test('an all-properties account yields a connector with no default, not a broken one', async () => {
  // `property` was only ever the fallback for an omitted siteUrl — nothing filters by it — so one
  // connector always reached every property its Google account could see. The dashboard was the
  // restriction, and somebody with twenty properties concluded they needed twenty connectors.
  const db = connected(new FakeDb(), { property: null, all_properties: true });
  const r = await build(db).resolve('tok');
  assert.ok(isCtx(r));
  assert.equal(r.cfg.defaultSite, '', 'empty, so tools.ts requires each call to name its own siteUrl');
});

// ---------------------------------------------------------------- the write gate

/** Both switches, all four combinations. Neither alone may produce a writable connector. */
test('writing needs BOTH the deployment switch and the account switch', async () => {
  for (const deployment of [false, true]) {
    for (const account of [false, true]) {
      const db = connected(new FakeDb(), { allow_write: account });
      db.settings = { allow_write: deployment, allow_write_by: null, allow_write_at: null };
      const r = await build(db).resolve('tok');
      assert.ok(isCtx(r));
      assert.equal(
        (r.cfg as { allowWrite: boolean }).allowWrite,
        deployment && account,
        `deployment=${deployment} account=${account}`,
      );
    }
  }
});

test('the deployment switch does NOT come from GSC_ALLOW_WRITE any more', async () => {
  // One variable used to govern both surfaces, so arming the operator's own single-account
  // connector armed the tenant-side server switch too — and a tenant sets their own allow_write
  // from their dashboard, so that combination let a tenant grant themselves writes the operator
  // never intended. build() sets cfg.allowWrite true below; the tenant must still be refused.
  const db = connected(new FakeDb(), { allow_write: true });
  db.settings = { allow_write: false, allow_write_by: null, allow_write_at: null };
  const t = new Tenants(
    { ...configFromEnv(), clientId: 'cid', clientSecret: 'csec', allowWrite: true },
    db as unknown as Db,
    new GoogleOAuth('cid', 'csec', 'https://x/cb'),
    log,
    MASTER,
    { maxCallsPerMinute: 5, ttlMs: 60_000 },
  );
  const r = await t.resolve('tok');
  assert.ok(isCtx(r));
  assert.equal((r.cfg as { allowWrite: boolean }).allowWrite, false, 'the environment must not arm a tenant');
});

test('a write switch that cannot be read is not permission to write', async () => {
  // Fails CLOSED. The alternative is a database blip briefly arming every connector that has its
  // own switch on, which is the one direction this must never fail in.
  const db = connected(new FakeDb(), { allow_write: true });
  db.getSettings = async () => {
    throw new Error('connection terminated unexpectedly');
  };
  const r = await build(db).resolve('tok');
  assert.ok(isCtx(r), 'and the connector still WORKS — reads are unaffected');
  assert.equal((r.cfg as { allowWrite: boolean }).allowWrite, false);
});

test('the switch is cached, and forgetSettings makes a change visible at once', async () => {
  const db = connected(new FakeDb(), { allow_write: true });
  const t = build(db);

  let reads = 0;
  const base = db.getSettings.bind(db);
  db.getSettings = async () => {
    reads++;
    return base();
  };

  await t.resolve('tok');
  await t.resolve('tok');
  assert.equal(reads, 1, 'not a query on every tool call');

  db.settings = { allow_write: true, allow_write_by: 'op@example.com', allow_write_at: new Date() };
  assert.equal(((await t.resolve('tok')) as { cfg: { allowWrite: boolean } }).cfg.allowWrite, false, 'still cached');

  t.forgetSettings();
  assert.equal(((await t.resolve('tok')) as { cfg: { allowWrite: boolean } }).cfg.allowWrite, true, 'and now it is not');
});
