// PREPARE every statement in src/db.ts against a real Postgres.
//
// This exists because a statement shipped that no test could catch. setProperty carried
//
//   set property = $3, all_properties = ($3 is null)
//
// which node-postgres cannot use: it sends parameters with no type OIDs and lets the server infer
// them, and `$3 IS NULL` constrains nothing, so the server refuses to parse the statement at all
// (42P08). It failed for every value, not only null, and the only thing anybody saw was a button
// reporting that Search Console would not accept the spelling.
//
// Nothing was in a position to notice:
//   - tests/db.test.ts drives a fake Queryable that accepts any string. Its own header says so.
//   - scripts/check-sql.py parses db/*.sql, and these statements live in TypeScript.
//   - `PREPARE sp(uuid, uuid, text)` by hand succeeds, because naming the types is exactly the
//     thing the driver never does. That was the safety net, and it is the one that failed.
//
// So: drive every Db method through a recording fake, then hand each captured statement to
// Postgres with INFERRED parameter types — the same position the driver puts it in.
//
// The call table below is deliberately exhaustive rather than reflective. A method added without
// an entry FAILS this check, which is the property worth having: a new statement cannot reach
// production without something having parsed it.
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { Db } from '../src/db.ts';

const ROOT = path.dirname(fileURLToPath(import.meta.url)).replace(/\/scripts$/, '');
const URL_ = process.env.DATABASE_URL;
if (!URL_) {
  console.error('DATABASE_URL is not set. This check needs a real Postgres; it is not a unit test.');
  process.exit(2);
}

const UUID = '11111111-1111-4111-8111-111111111111';
const SEALED = { v: 1, wk: 'x', wn: 'x', ct: 'x', n: 'x' };

/** Records the SQL and returns something shaped enough that the method usually gets to the end. */
class Recorder {
  seen = [];
  async query(text, values = []) {
    this.seen.push({ text, values });
    return { rows: [], rowCount: 0 };
  }
}

/** Every Db method, with arguments whose only job is to reach the query. */
const CALLS = {
  connectorByToken: ['a'.repeat(64)],
  touchToken: [UUID],
  recordCall: [UUID, { tool: 'search_analytics', ok: true, ms: 12, code: null }],
  callsInLastMinute: [UUID],
  listAccounts: [UUID],
  getAccount: [UUID, UUID],
  createAccount: [UUID, 'label', null],
  countAccounts: [UUID],
  renameAccount: [UUID, UUID, 'label'],
  setAllowWrite: [UUID, UUID, true],
  // The one that shipped broken, in both of its shapes.
  setProperty: [UUID, UUID, 'sc-domain:example.com'],
  setStatus: [UUID, 'connected', { error: null, googleEmail: null }],
  setSecret: [UUID, SEALED],
  getSecret: [UUID],
  dropSecret: [UUID],
  beginDelete: [UUID, UUID],
  finishDelete: [UUID],
  pendingDeletes: [50],
  addToken: [UUID, UUID, 'b'.repeat(64), 'label'],
  listTokens: [UUID, UUID],
  revokeToken: [UUID, UUID],
  connectedAccounts: [100],
  putDay: [UUID, 'query', '2026-01-01', [{ keys: ['k'], clicks: 1, impressions: 2, position: 3 }], true],
  coverage: [UUID, 'query', '2026-01-01', '2026-01-31'],
  daysToSync: [UUID, 'query', '2026-01-01', '2026-01-31', 10],
  countDaysToSync: [UUID, 'query', '2026-01-01', '2026-01-31'],
  readMirror: [UUID, 'query', '2026-01-01', '2026-01-31', 100],
  mirrorStats: [UUID],
  allAccounts: [200],
  totals: [],
  errorBreakdown: [24],
  recentCalls: [UUID, UUID, 20],
};

// Second shapes worth covering: a method whose SQL or parameter typing changes with its arguments.
// setProperty(null) is the exact case that broke — and it is the same statement text, which is the
// point: the failure was at PARSE time, so either argument would have caught it.
const EXTRA = [
  ['setProperty', [UUID, UUID, null]],
  ['setStatus', [UUID, 'failing', { error: 'boom', googleEmail: 'a@b.c' }]],
  ['putDay', [UUID, 'query', '2026-01-01', [], false]],
];

const missing = Object.getOwnPropertyNames(Db.prototype).filter(
  (m) => m !== 'constructor' && typeof Db.prototype[m] === 'function' && !(m in CALLS),
);
if (missing.length) {
  console.error(`These Db methods have no entry in CALLS, so their SQL is unchecked:\n  ${missing.join('\n  ')}`);
  process.exit(1);
}

const rec = new Recorder();
const db = new Db(rec);
const label = [];

for (const [method, args] of [...Object.entries(CALLS), ...EXTRA]) {
  const before = rec.seen.length;
  try {
    await db[method](...args);
  } catch {
    // Only the SQL matters. A method that trips over the empty result the fake returns has already
    // recorded everything it sent.
  }
  for (let i = before; i < rec.seen.length; i++) label[i] = method;
}

const client = new pg.Client({ connectionString: URL_ });
await client.connect();

let failures = 0;
const seenText = new Set();
for (let i = 0; i < rec.seen.length; i++) {
  const { text } = rec.seen[i];
  if (seenText.has(text)) continue;
  seenText.add(text);
  const name = `chk_${i}`;
  try {
    // No type list. That is the whole point: this is the position node-postgres puts the server in.
    await client.query(`prepare ${name} as ${text}`);
    const { rows } = await client.query('select parameter_types from pg_prepared_statements where name = $1', [name]);
    console.log(`ok   ${label[i]}  ${rows[0]?.parameter_types ?? '{}'}`);
    await client.query(`deallocate ${name}`);
  } catch (e) {
    failures++;
    console.error(`FAIL ${label[i]}: ${e.code ?? ''} ${e.message}`);
    console.error(`     ${text.replace(/\s+/g, ' ').trim().slice(0, 300)}`);
    if (e.code === '42P08') {
      console.error('     42P08 means a parameter has no inferable type. A bare $n used only in');
      console.error('     `IS NULL` does not get one — cast it, e.g. $n::text, in EVERY use.');
    }
  }
}

await client.end();
console.log(`\n${seenText.size} statements from src/db.ts, ${failures} unparseable.`);
process.exit(failures ? 1 : 0);
