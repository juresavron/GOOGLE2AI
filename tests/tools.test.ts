import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { configFromEnv } from '../src/env.ts';
import { MockGSC, type AnalyticsQuery, type GSC, type InspectionResult } from '../src/gsc.ts';
import { buildServer, instructions, LAG_DAYS, type Ctx } from '../src/tools.ts';
import type { Store } from '../src/store.ts';

/** The mock, plus a record of exactly what each tool asked Google for. */
class RecordingGSC extends MockGSC {
  queries: AnalyticsQuery[] = [];
  inspection: InspectionResult | null = null;

  override async searchAnalytics(q: AnalyticsQuery) {
    this.queries.push(q);
    return super.searchAnalytics(q);
  }
  override async inspectUrl(siteUrl: string, url: string) {
    return this.inspection ?? super.inspectUrl(siteUrl, url);
  }
}

const makeCtx = (over: Partial<ReturnType<typeof configFromEnv>> = {}, gsc: GSC = new MockGSC()): Ctx => {
  const saved = { ...process.env };
  for (const k of ['GSC_DEFAULT_SITE', 'GOOGLE_CLIENT_ID', 'GOOGLE_CLIENT_SECRET', 'GOOGLE_REFRESH_TOKEN', 'GOOGLE_CREDENTIALS_JSON', 'GOOGLE_APPLICATION_CREDENTIALS']) delete process.env[k];
  const cfg = { ...configFromEnv(), ...over };
  process.env = saved;
  return { cfg, gsc };
};

/** A connected client speaking to a server built from this Ctx, over the SDK's in-memory pair. */
const connect = async (ctx: Ctx) => {
  const server = buildServer(ctx);
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'test', version: '0' });
  await Promise.all([server.connect(serverSide), client.connect(clientSide)]);
  return {
    client,
    async call(name: string, args: Record<string, unknown> = {}) {
      const r = (await client.callTool({ name, arguments: args })) as { isError?: boolean; content: { text: string }[] };
      return { isError: Boolean(r.isError), text: r.content.map((c) => c.text).join('\n') };
    },
    async close() {
      await client.close();
      await server.close();
    },
  };
};

const DAY = 86400000;
const iso = (d: Date) => d.toISOString().slice(0, 10);

test('the instructions state the reporting lag, which is the fact that silently ruins answers', () => {
  const text = instructions(makeCtx());
  assert.match(text, new RegExp(`${LAG_DAYS} DAYS BEHIND`));
  assert.match(text, /16 months/);
  assert.match(text, /sc-domain:example\.com/, 'shows both property spellings, which are not guessable');
});

test('the instructions name the bound property when one is configured, and say to call list_sites when not', () => {
  assert.match(instructions(makeCtx({ defaultSite: 'sc-domain:ocenagor.si' })), /Bound to sc-domain:ocenagor\.si/);
  assert.match(instructions(makeCtx()), /call it first/);
});

test('every tool is registered, including the writes, which exist even when switched off', async () => {
  const c = await connect(makeCtx());
  const names = (await c.client.listTools()).tools.map((t) => t.name).sort();
  // The write tools are REGISTERED rather than hidden when writes are off, so a refusal can say
  // how to turn them on — hiding them makes "why can't you do that" unanswerable.
  assert.deepEqual(names, [
    'add_property', 'compare_periods', 'delete_sitemap', 'inspect_url', 'list_sitemaps', 'list_sites',
    'remove_property', 'request_indexing', 'search_analytics', 'status', 'submit_sitemap',
  ]);
  await c.close();
});

test('a range left unset ends at the last complete day, not today', async () => {
  const gsc = new RecordingGSC();
  const c = await connect(makeCtx({ defaultSite: 'sc-domain:example.com' }, gsc));
  await c.call('search_analytics');

  const q = gsc.queries[0]!;
  assert.equal(q.endDate, iso(new Date(Date.now() - LAG_DAYS * DAY)));
  // 28 days INCLUSIVE of both ends, which is what "the last 28 days" means to a reader and what
  // Search Console's own date picker does.
  assert.equal(q.startDate, iso(new Date(Date.now() - (LAG_DAYS + 27) * DAY)));
  await c.close();
});

test('compare_periods puts the two windows back to back, never overlapping', async () => {
  const gsc = new RecordingGSC();
  const c = await connect(makeCtx({ defaultSite: 'sc-domain:example.com' }, gsc));
  await c.call('compare_periods', { days: 7, endDate: '2026-03-31' });

  const [recent, prior] = gsc.queries;
  assert.equal(recent!.startDate, '2026-03-25');
  assert.equal(recent!.endDate, '2026-03-31');
  assert.equal(prior!.startDate, '2026-03-18');
  // The prior window ends the day BEFORE the recent one starts. An overlap of even one day
  // double-counts it and flatters every trend the tool reports.
  assert.equal(prior!.endDate, '2026-03-24');
  await c.close();
});

test('compare_periods reports an improved ranking as a positive change', async () => {
  const gsc = new RecordingGSC();
  const c = await connect(makeCtx({ defaultSite: 'sc-domain:example.com' }, gsc));
  const { text } = await c.call('compare_periods', { days: 7, endDate: '2026-03-31' });
  // Both windows come from the same seeded mock, so every position delta is exactly zero — the
  // assertion that matters is the SIGN convention, which is inverted against the raw number.
  assert.match(text, /Δ pos/);
  assert.match(text, /positive when the ranking improved/);
  await c.close();
});

test('a tool called with no property and none configured says how to find one', async () => {
  const c = await connect(makeCtx());
  const { isError, text } = await c.call('list_sitemaps');
  assert.equal(isError, true);
  assert.match(text, /list_sites/);
  await c.close();
});

test('a malformed date is refused before it reaches Google', async () => {
  const gsc = new RecordingGSC();
  const c = await connect(makeCtx({ defaultSite: 'sc-domain:example.com' }, gsc));
  const { isError, text } = await c.call('search_analytics', { startDate: '31/03/2026' });
  assert.equal(isError, true);
  assert.match(text, /YYYY-MM-DD/);
  assert.equal(gsc.queries.length, 0, 'a bad date costs no quota');
  await c.close();
});

test('inspect_url calls out a canonical Google chose over the declared one', async () => {
  const gsc = new RecordingGSC();
  gsc.inspection = { coverageState: 'Duplicate, Google chose different canonical than user', verdict: 'NEUTRAL', googleCanonical: 'https://example.com/a', userCanonical: 'https://example.com/b', mobile: null };
  const c = await connect(makeCtx({ defaultSite: 'sc-domain:example.com' }, gsc));
  const { text } = await c.call('inspect_url', { inspectionUrl: 'https://example.com/b' });
  // The single most common reason a page is missing from search while every other field reads
  // healthy. Left to the reader it is two similar URLs to diff by eye.
  assert.match(text, /will not rank on its own/);
  await c.close();
});

test('an empty result explains itself rather than just saying zero', async () => {
  // Subclassed, not spread: class methods live on the prototype, so { ...new MockGSC() } copies
  // none of them and every method added to GSC later would have to be re-listed here.
  class EmptyGSC extends MockGSC {
    override async searchAnalytics() {
      return [];
    }
    override async listSites() {
      return [];
    }
    override async listSitemaps() {
      return [];
    }
    override async inspectUrl() {
      return null;
    }
  }
  const c = await connect(makeCtx({ defaultSite: 'sc-domain:example.com' }, new EmptyGSC()));
  const { text } = await c.call('search_analytics');
  assert.match(text, new RegExp(`last ${LAG_DAYS} days`), 'the likeliest cause is named');
  await c.close();
});

test('onCall records the outcome of each call without recording what was asked', async () => {
  const seen: { tool: string; ok: boolean; code: string | null }[] = [];
  const ctx = makeCtx({ defaultSite: 'sc-domain:example.com' });
  ctx.onCall = (c) => void seen.push({ tool: c.tool, ok: c.ok, code: c.code });
  const c = await connect(ctx);

  await c.call('status');
  await c.call('search_analytics', { startDate: 'nonsense' });

  assert.deepEqual(seen.map((s) => [s.tool, s.ok]), [['status', true], ['search_analytics', false]]);
  assert.equal(seen[1]!.code, 'bad_date');
  // A search term or a URL in this table would make it a second copy of the customer's traffic.
  for (const s of seen) assert.doesNotMatch(String(s.code), /nonsense/);
  await c.close();
});

/** A mirror that can answer, or refuses to, on demand — and records which it was asked. */
class FakeStore {
  asked: { dims: string; from: string; to: string }[] = [];
  reads = 0;
  answers = true;

  async canAnswer(_a: string, dims: string, from: string, to: string) {
    this.asked.push({ dims, from, to });
    return this.answers;
  }
  async read() {
    this.reads++;
    return [{ keys: ['mirrored term'], clicks: 7, impressions: 100, ctr: 0.07, position: 4.2 }];
  }
  async stats() {
    return [{ dims: 'query', days: 500, rows: 12000, oldest: '2025-01-01', newest: '2026-09-14' }];
  }
}

const withMirror = (store: FakeStore, over = {}) => {
  const ctx = makeCtx({ defaultSite: 'sc-domain:example.com', ...over }, new RecordingGSC());
  ctx.mirror = { store: store as unknown as Store, accountId: 'acct-1' };
  return ctx;
};

test('a fully-synced range is answered from the mirror, and says so', async () => {
  const store = new FakeStore();
  const ctx = withMirror(store);
  const c = await connect(ctx);
  const { text } = await c.call('search_analytics', { startDate: '2026-01-01', endDate: '2026-01-28' });

  assert.equal(store.reads, 1);
  assert.match(text, /from the local mirror/, 'the reader must be able to tell where a number came from');
  assert.match(text, /mirrored term/);
  // Nothing was spent at Google.
  assert.equal((ctx.gsc as RecordingGSC).queries.length, 0);
  await c.close();
});

test('a partially-synced range falls through to Google rather than under-reporting', async () => {
  const store = new FakeStore();
  store.answers = false;
  const ctx = withMirror(store);
  const c = await connect(ctx);
  const { text } = await c.call('search_analytics', { startDate: '2026-01-01', endDate: '2026-01-28' });

  assert.equal(store.reads, 0);
  assert.match(text, /from Google/);
  // Answering with 90% of the clicks and no sign anything is missing reads as a traffic drop.
  assert.equal((ctx.gsc as RecordingGSC).queries.length, 1);
  await c.close();
});

test('a filtered or non-web query never touches the mirror', async () => {
  for (const args of [{ queryFilter: 'ocena' }, { pageFilter: '/blog' }, { countryFilter: 'SVN' }, { deviceFilter: 'MOBILE' as const }, { searchType: 'image' as const }]) {
    const store = new FakeStore();
    const ctx = withMirror(store);
    const c = await connect(ctx);
    await c.call('search_analytics', { startDate: '2026-01-01', endDate: '2026-01-28', ...args });

    // The mirror stores grouped daily totals: it has nothing to apply a filter to, and nothing at
    // all for the other search types. It must not even be consulted.
    assert.equal(store.asked.length, 0, JSON.stringify(args));
    assert.equal(store.reads, 0, JSON.stringify(args));
    assert.equal((ctx.gsc as RecordingGSC).queries.length, 1, JSON.stringify(args));
    await c.close();
  }
});

test('the mirror is asked about exactly the grouping and range that was requested', async () => {
  const store = new FakeStore();
  const c = await connect(withMirror(store));
  await c.call('search_analytics', { dimensions: 'query,page', startDate: '2026-02-01', endDate: '2026-02-07' });
  assert.deepEqual(store.asked, [{ dims: 'query,page', from: '2026-02-01', to: '2026-02-07' }]);
  await c.close();
});

test('status surfaces how far back the mirror reaches, and the instructions say it exists', async () => {
  const store = new FakeStore();
  const ctx = withMirror(store);
  const c = await connect(ctx);
  const st = JSON.parse((await c.call('status')).text);

  assert.equal(st.mirror[0].oldest, '2025-01-01');
  // Without this nobody would think to ask for anything older than Google's 16 months, which is
  // the entire reason the mirror exists.
  assert.match(instructions(ctx), /keeps its own copy/);
  await c.close();
});

test('with no mirror configured, nothing mentions one', async () => {
  const ctx = makeCtx({ defaultSite: 'sc-domain:example.com' });
  const c = await connect(ctx);
  const st = JSON.parse((await c.call('status')).text);
  assert.equal(st.mirror, null);
  assert.doesNotMatch(instructions(ctx), /keeps its own copy/);
  assert.match((await c.call('search_analytics')).text, /from Google/);
  await c.close();
});

const WRITES: [string, Record<string, unknown>][] = [
  ['submit_sitemap', { feedpath: 'https://example.com/sitemap.xml' }],
  ['delete_sitemap', { feedpath: 'https://example.com/sitemap.xml' }],
  ['add_property', { siteUrl: 'sc-domain:example.com' }],
  ['remove_property', { siteUrl: 'sc-domain:example.com' }],
  ['request_indexing', { url: 'https://example.com/a' }],
];

test('with writes off, every write tool refuses AND reaches Google with nothing', async () => {
  for (const [name, args] of WRITES) {
    const gsc = new MockGSC();
    const c = await connect(makeCtx({ defaultSite: 'sc-domain:example.com', allowWrite: false }, gsc));
    const { isError, text } = await c.call(name, args);

    assert.equal(isError, true, name);
    // Both routes named, because whoever reads this is the one who has to act on it.
    assert.match(text, /dashboard/, name);
    assert.match(text, /GSC_ALLOW_WRITE=true/, name);
    // The guard is upstream of the call, not a check on the way back.
    assert.deepEqual(gsc.wrote, [], `${name} must not reach Google`);
    await c.close();
  }
});

test('with writes on, each write tool does exactly one thing', async () => {
  for (const [name, args] of WRITES) {
    const gsc = new MockGSC();
    const c = await connect(makeCtx({ defaultSite: 'sc-domain:example.com', allowWrite: true }, gsc));
    const { isError } = await c.call(name, args);
    assert.equal(isError, false, name);
    assert.equal(gsc.wrote.length, 1, name);
    await c.close();
  }
});

test('the destructive tools say what cannot be undone', async () => {
  const c = await connect(makeCtx({ defaultSite: 'sc-domain:example.com', allowWrite: true }, new MockGSC()));
  const tools = (await c.client.listTools()).tools;
  const desc = (n: string) => String(tools.find((t) => t.name === n)?.description ?? '');

  // Claude reads these before calling. A destructive tool whose description does not say so is
  // how an agent removes a property because a sentence was ambiguous.
  assert.match(desc('remove_property'), /DESTRUCTIVE/);
  assert.match(desc('remove_property'), /verification again/);
  assert.match(desc('delete_sitemap'), /DESTRUCTIVE/);
  assert.match(desc('request_indexing'), /JobPosting/, 'the restriction belongs in the description, not a footnote');
  await c.close();
});

test('remove_property has NO default target', async () => {
  const gsc = new MockGSC();
  const c = await connect(makeCtx({ defaultSite: 'sc-domain:example.com', allowWrite: true }, gsc));
  const { isError } = await c.call('remove_property', {});
  // Every other tool falls back to the configured property. A tool that DELETES one must never act
  // on a target nobody typed.
  assert.equal(isError, true);
  assert.deepEqual(gsc.wrote, []);
  await c.close();
});

test('the instructions state the write posture either way', async () => {
  assert.match(instructions(makeCtx({ allowWrite: true })), /WRITES ARE ENABLED/);
  assert.match(instructions(makeCtx({ allowWrite: true })), /Confirm the exact target/);
  assert.match(instructions(makeCtx({ allowWrite: false })), /switched off for this connector/);
  // The old blanket claim was true and is not any more; it must not survive anywhere.
  assert.doesNotMatch(instructions(makeCtx({ allowWrite: false })), /cannot submit URLs/);
});

test('status reports whether writing is actually possible', async () => {
  for (const allowWrite of [true, false]) {
    const c = await connect(makeCtx({ defaultSite: 'sc-domain:example.com', allowWrite }));
    assert.equal(JSON.parse((await c.call('status')).text).writes_possible, allowWrite);
    await c.close();
  }
});

test('status reports the lag, and writes off by default', async () => {
  const c = await connect(makeCtx({ defaultSite: 'sc-domain:example.com' }));
  const st = JSON.parse((await c.call('status')).text);
  assert.equal(st.writes_possible, false, 'off unless GSC_ALLOW_WRITE says otherwise');
  assert.equal(st.reporting_lag_days, LAG_DAYS);
  assert.equal(st.latest_complete_date, iso(new Date(Date.now() - LAG_DAYS * DAY)));
  await c.close();
});
