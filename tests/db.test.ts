// db.ts against a fake Queryable. No database runs here — CI has none — so these assert the two
// things a fake can genuinely prove: that every user-scoped statement carries the user id, and that
// the conditions which make a statement safe are actually in the SQL.
//
// What a fake CANNOT prove is that the SQL is valid, since it accepts any string. That is covered
// separately: scripts/check-sql.py parses db/*.sql with Postgres's own grammar, and the statements
// below were each PREPAREd against a real Postgres once, against the applied schema.
import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { Db, type QueryResult, type Queryable } from '../src/db.ts';

class FakeQ implements Queryable {
  seen: { text: string; values: unknown[] }[] = [];
  next: QueryResult[] = [];

  async query(text: string, values: unknown[] = []): Promise<QueryResult> {
    this.seen.push({ text, values });
    return this.next.shift() ?? { rows: [], rowCount: 0 };
  }
  /** The last statement, whitespace collapsed, so assertions read like the SQL does. */
  last(): string {
    return (this.seen.at(-1)?.text ?? '').replace(/\s+/g, ' ').trim();
  }
  only(): { text: string; values: unknown[] } {
    assert.equal(this.seen.length, 1, 'expected exactly one statement');
    return this.seen[0]!;
  }
}

const USER = '11111111-1111-4111-8111-111111111111';
const OTHER_USER = '22222222-2222-4222-8222-222222222222';
const ACCOUNT = '33333333-3333-4333-8333-333333333333';

test('connectorByToken resolves in ONE statement — it runs on every tool call', async () => {
  const q = new FakeQ();
  q.next = [{ rows: [{ id: ACCOUNT, user_id: USER, label: 'x', status: 'connected', token_id: 'tok', sealed: { v: 1 } }], rowCount: 1 }];
  const c = await new Db(q).connectorByToken('a'.repeat(64));

  q.only();
  assert.equal(c?.account.id, ACCOUNT);
  assert.equal(c?.token_id, 'tok');
  assert.deepEqual(c?.sealed, { v: 1 });
  // token_id and sealed must not leak into the account object the rest of the code passes around.
  assert.ok(!('token_id' in (c!.account as object)));
  assert.ok(!('sealed' in (c!.account as object)));
});

test('connectorByToken refuses a revoked token and a deleted account, in the statement itself', async () => {
  const q = new FakeQ();
  await new Db(q).connectorByToken('b'.repeat(64));
  const sql = q.last();
  // Both conditions are the whole security of this route. Checking them in JS after the fact would
  // be a second place to forget.
  assert.match(sql, /t\.revoked_at is null/);
  assert.match(sql, /a\.deleted_at is null/);
  assert.match(sql, /t\.token_sha256 = \$1/);
});

test('the raw token is never a query parameter — only its hash', async () => {
  const q = new FakeQ();
  const sha = 'c'.repeat(64);
  await new Db(q).connectorByToken(sha);
  assert.deepEqual(q.only().values, [sha]);
  assert.doesNotMatch(q.last(), /token\b(?!_sha256)/, 'no column but token_sha256 is compared');
});

test('every user-scoped read and write carries the user id', async () => {
  const db = new Db(new FakeQ());
  const calls: [string, Promise<unknown>][] = [];
  const q = new FakeQ();
  const scoped = new Db(q);

  await scoped.getAccount(USER, ACCOUNT);
  assert.ok(q.only().values.includes(USER), 'getAccount');
  assert.match(q.last(), /a\.user_id = \$2/);

  for (const [name, run] of [
    ['listAccounts', () => scoped.listAccounts(USER)],
    ['renameAccount', () => scoped.renameAccount(USER, ACCOUNT, 'new')],
    ['setProperty', () => scoped.setProperty(USER, ACCOUNT, 'sc-domain:example.com')],
    ['beginDelete', () => scoped.beginDelete(USER, ACCOUNT)],
    ['listTokens', () => scoped.listTokens(USER, ACCOUNT)],
    ['revokeToken', () => scoped.revokeToken(USER, 'tok')],
    ['recentCalls', () => scoped.recentCalls(USER, ACCOUNT)],
    ['addToken', () => scoped.addToken(USER, ACCOUNT, 'd'.repeat(64), null)],
  ] as [string, () => Promise<unknown>][]) {
    q.seen = [];
    await run();
    assert.ok(
      q.seen.some((s) => s.values.includes(USER)),
      `${name} must pass the user id so another tenant's id reads as "no such row"`,
    );
    assert.match(q.seen[0]!.text, /user_id/, `${name} must join on user_id in the statement`);
  }
  void db;
  void calls;
});

test('an account id from another tenant is simply not found', async () => {
  const q = new FakeQ();
  q.next = [{ rows: [], rowCount: 0 }];
  assert.equal(await new Db(q).getAccount(OTHER_USER, ACCOUNT), null);
  // Not an error, not a 403 — the same answer a nonexistent id gets, so the dashboard cannot be
  // used to probe which account ids exist.
});

test('revokeToken is one-way', async () => {
  const q = new FakeQ();
  await new Db(q).revokeToken(USER, 'tok');
  // Without `revoked_at is null`, re-revoking moves the timestamp — and the imap2ai version of
  // this bug let a client write the column, which made revocation a toggle.
  assert.match(q.last(), /t\.revoked_at is null/);
  assert.match(q.last(), /set revoked_at = now\(\)/);
});

test('beginDelete tombstones the account AND kills its tokens in the same call', async () => {
  const q = new FakeQ();
  q.next = [{ rows: [], rowCount: 1 }];
  assert.equal(await new Db(q).beginDelete(USER, ACCOUNT), true);

  assert.equal(q.seen.length, 2, 'the tombstone and the token revocation');
  assert.match(q.seen[0]!.text.replace(/\s+/g, ' '), /set deleted_at = now\(\)/);
  // The connector has to stop working the instant the user asks, even though the Google grant is
  // still live until the reaper revokes it.
  assert.match(q.seen[1]!.text.replace(/\s+/g, ' '), /update public\.mcp_tokens set revoked_at = now\(\)/);
});

test('beginDelete on someone else’s account touches nothing', async () => {
  const q = new FakeQ();
  q.next = [{ rows: [], rowCount: 0 }];
  assert.equal(await new Db(q).beginDelete(OTHER_USER, ACCOUNT), false);
  assert.equal(q.seen.length, 1, 'it must not go on to revoke tokens it does not own');
});

test('finishDelete only removes a row that was already tombstoned', async () => {
  const q = new FakeQ();
  await new Db(q).finishDelete(ACCOUNT);
  // Without this the reaper could delete a live account if it were ever handed a wrong id.
  assert.match(q.last(), /deleted_at is not null/);
});

test('addToken scopes the insert through a select on user_id', async () => {
  const q = new FakeQ();
  q.next = [{ rows: [], rowCount: 0 }];
  assert.equal(await new Db(q).addToken(OTHER_USER, ACCOUNT, 'e'.repeat(64), 'laptop'), false);
  // An insert with a plain VALUES would mint a token against any account id supplied. The select
  // is what makes a foreign id write zero rows instead.
  assert.match(q.last(), /insert into public\.mcp_tokens .* select /);
  assert.match(q.last(), /a\.user_id = \$2/);
});

test('setSecret upserts, so re-consenting replaces rather than duplicating', async () => {
  const q = new FakeQ();
  await new Db(q).setSecret(ACCOUNT, { v: 1, wk: 'w', wn: 'n', ct: 'c', n: 'x' });
  assert.match(q.last(), /on conflict \(account_id\) do update/);
  assert.equal(typeof q.only().values[1], 'string', 'the sealed blob is passed as json text');
});

test('setStatus is server-only and coalesces the google email', async () => {
  const q = new FakeQ();
  await new Db(q).setStatus(ACCOUNT, 'connected', { googleEmail: 'a@b.c' });
  // No user_id: the OAuth callback and the health probe are not acting for a browser session.
  assert.doesNotMatch(q.last(), /user_id/);
  // coalesce, so a later status write does not blank an address learned at consent.
  assert.match(q.last(), /google_email = coalesce/);
});

test('touchToken does not write on every call', async () => {
  const q = new FakeQ();
  await new Db(q).touchToken('tok');
  // A row-level write per tool call is contention for a timestamp the dashboard shows to the minute.
  assert.match(q.last(), /last_used_at < now\(\) - interval '1 minute'/);
});

test('recordCall stores a code, never an argument', async () => {
  const q = new FakeQ();
  await new Db(q).recordCall(ACCOUNT, { tool: 'search_analytics', ok: false, ms: 12.7, code: 'bad_date' });
  const { values } = q.only();
  assert.deepEqual(values, [ACCOUNT, 'search_analytics', false, 13, 'bad_date']);
  assert.equal(values[3], 13, 'duration is rounded — the column is an integer');
});
