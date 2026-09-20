import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import type { Db } from '../src/db.ts';
import type { AnalyticsQuery } from '../src/gsc.ts';
import { MockGSC } from '../src/gsc.ts';
import { FINAL_AFTER_DAYS, isFinal, Store } from '../src/store.ts';

const ACCOUNT = '33333333-3333-4333-8333-333333333333';
const DAY_MS = 86400000;
const iso = (d: Date) => d.toISOString().slice(0, 10);
const ago = (n: number) => iso(new Date(Date.now() - n * DAY_MS));

class FakeDb {
  put: { dims: string; day: string; rows: number; final: boolean }[] = [];
  due: string[] = [];
  cover = { synced: 0, final: 0 };
  mirror: { keys: string[]; clicks: number; impressions: number; position: number }[] = [];

  async putDay(_a: string, dims: string, day: string, rows: unknown[], final: boolean) {
    this.put.push({ dims, day, rows: rows.length, final });
  }
  async daysToSync(_a: string, _d: string, _f: string, _t: string, limit: number) {
    return this.due.slice(0, limit);
  }
  async countDaysToSync() {
    return this.due.length;
  }
  async coverage() {
    return this.cover;
  }
  async readMirror() {
    return this.mirror;
  }
  async mirrorStats() {
    return [];
  }
}

class SpyGSC extends MockGSC {
  queries: AnalyticsQuery[] = [];
  override async searchAnalytics(q: AnalyticsQuery) {
    this.queries.push(q);
    return super.searchAnalytics(q);
  }
}

const store = (db: FakeDb) => new Store(db as unknown as Db);

test('a day is final only once Google has stopped revising it', () => {
  const now = Date.now();
  assert.equal(isFinal(ago(FINAL_AFTER_DAYS + 1), now), true);
  assert.equal(isFinal(ago(FINAL_AFTER_DAYS), now), true, 'the boundary day itself counts');
  assert.equal(isFinal(ago(FINAL_AFTER_DAYS - 1), now), false);
  assert.equal(isFinal(ago(0), now), false);
  // Marking a provisional day final is never corrected afterwards, so the margin errs toward
  // one extra re-fetch rather than toward permanently wrong numbers.
  assert.ok(FINAL_AFTER_DAYS > 3, 'the publishing lag is "roughly" three days, so three is not margin');
});

test('syncDay asks for exactly one day and never groups by date', async () => {
  const db = new FakeDb();
  const gsc = new SpyGSC();
  await store(db).syncDay(ACCOUNT, gsc, 'sc-domain:example.com', 'query,date', '2026-03-01');

  const q = gsc.queries[0]!;
  assert.equal(q.startDate, '2026-03-01');
  assert.equal(q.endDate, '2026-03-01');
  // The day is already fixed by the range. Grouping by it too returns the same rows with a
  // redundant column, and the stored keys would then disagree with every other day's.
  assert.deepEqual(q.dimensions, ['query']);
});

test('syncDay records finality from the day, not from when it ran', async () => {
  const db = new FakeDb();
  await store(db).syncDay(ACCOUNT, new SpyGSC(), 'p', 'query', ago(FINAL_AFTER_DAYS + 10));
  await store(db).syncDay(ACCOUNT, new SpyGSC(), 'p', 'query', ago(1));
  assert.equal(db.put[0]!.final, true);
  assert.equal(db.put[1]!.final, false, 'yesterday will still be revised');
});

test('an empty day is stored as a fetch, not skipped', async () => {
  const db = new FakeDb();
  // Subclassed rather than spread: class methods live on the prototype, so { ...new MockGSC() }
  // copies none of them.
  class EmptyGSC extends MockGSC {
    override async searchAnalytics() {
      return [];
    }
  }
  await store(db).syncDay(ACCOUNT, new EmptyGSC(), 'p', 'query', '2026-03-01');
  // A day with genuinely zero impressions and a day never fetched look identical in a rows table.
  // Recording the fetch is what stops it being re-fetched forever.
  assert.equal(db.put.length, 1);
  assert.equal(db.put[0]!.rows, 0);
});

test('backfill respects its budget and reports what is left', async () => {
  const db = new FakeDb();
  db.due = ['2026-03-05', '2026-03-04', '2026-03-03', '2026-03-02', '2026-03-01'];
  const r = await store(db).backfill(ACCOUNT, new SpyGSC(), 'p', 'query', '2026-03-01', '2026-03-05', 3);

  assert.equal(r.days, 3);
  // The truth, not what the fetched page could infer: five were due, three were done. Deriving
  // this from a budget+1 page would report 1 here, and 1 with four hundred outstanding elsewhere.
  assert.equal(r.remaining, 2);
  // Newest first: a backfill walking forward from sixteen months ago leaves "last week" missing
  // for hours, and last week is what anyone actually asks about.
  assert.deepEqual(db.put.map((p) => p.day), ['2026-03-05', '2026-03-04', '2026-03-03']);
});

test('backfill with nothing due is a no-op', async () => {
  const db = new FakeDb();
  const r = await store(db).backfill(ACCOUNT, new SpyGSC(), 'p', 'query', '2026-03-01', '2026-03-05', 10);
  assert.deepEqual(r, { days: 0, rows: 0, remaining: 0 });
  assert.equal(db.put.length, 0);
});

test('the mirror may answer only when every day is present AND final', async () => {
  const db = new FakeDb();
  const s = store(db);
  const from = '2026-03-01';
  const to = '2026-03-10'; // ten days

  db.cover = { synced: 10, final: 10 };
  assert.equal(await s.canAnswer(ACCOUNT, 'query', from, to), true);

  db.cover = { synced: 9, final: 9 };
  // A 90%-synced range answers with 90% of the clicks and no sign anything is missing, which reads
  // as a traffic drop rather than a gap in the data.
  assert.equal(await s.canAnswer(ACCOUNT, 'query', from, to), false);

  db.cover = { synced: 10, final: 8 };
  assert.equal(await s.canAnswer(ACCOUNT, 'query', from, to), false, 'provisional days will still change');

  db.cover = { synced: 0, final: 0 };
  assert.equal(await s.canAnswer(ACCOUNT, 'query', from, to), false);
});

test('a backwards or empty range never answers from the mirror', async () => {
  const db = new FakeDb();
  db.cover = { synced: 999, final: 999 };
  assert.equal(await store(db).canAnswer(ACCOUNT, 'query', '2026-03-10', '2026-03-01'), false);
});

test('reading recomputes CTR from the two counts it actually has', async () => {
  const db = new FakeDb();
  db.mirror = [{ keys: ['ocena gostilne'], clicks: 42, impressions: 1200, position: 3.2 }];
  const [row] = await store(db).read(ACCOUNT, 'query', '2026-03-01', '2026-03-10', 10);

  assert.equal(row!.clicks, 42);
  // Storing CTR would be a third number that can disagree with the two it is derived from.
  assert.ok(Math.abs(row!.ctr - 42 / 1200) < 1e-9);
  assert.equal(row!.position, 3.2);
});

test('a row with no impressions does not divide by zero', async () => {
  const db = new FakeDb();
  db.mirror = [{ keys: ['x'], clicks: 0, impressions: 0, position: 0 }];
  const [row] = await store(db).read(ACCOUNT, 'query', '2026-03-01', '2026-03-10', 10);
  assert.equal(row!.ctr, 0);
});

test('earliestFetchable is the edge of what Google still has', () => {
  const earliest = store(new FakeDb()).earliestFetchable();
  const days = Math.round((Date.now() - new Date(`${earliest}T00:00:00Z`).getTime()) / DAY_MS);
  // Anything older than this exists only in the mirror — which is the entire point of having one.
  assert.ok(days >= 470 && days <= 490, `expected ~16 months, got ${days} days`);
});
