import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { configFromEnv } from '../src/env.ts';
import { MockGSC, type AnalyticsQuery, type GSC, type InspectionResult } from '../src/gsc.ts';
import { buildServer, instructions, LAG_DAYS, type Ctx } from '../src/tools.ts';

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

test('every tool is registered and reads', async () => {
  const c = await connect(makeCtx());
  const names = (await c.client.listTools()).tools.map((t) => t.name).sort();
  assert.deepEqual(names, ['compare_periods', 'inspect_url', 'list_sitemaps', 'list_sites', 'search_analytics', 'status']);
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
  const empty: GSC = { ...new MockGSC(), searchAnalytics: async () => [], listSites: async () => [], listSitemaps: async () => [], inspectUrl: async () => null, status: () => new MockGSC().status() };
  const c = await connect(makeCtx({ defaultSite: 'sc-domain:example.com' }, empty));
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

test('status reports the lag and that nothing here can write', async () => {
  const c = await connect(makeCtx({ defaultSite: 'sc-domain:example.com' }));
  const st = JSON.parse((await c.call('status')).text);
  assert.equal(st.writes_possible, false);
  assert.equal(st.reporting_lag_days, LAG_DAYS);
  assert.equal(st.latest_complete_date, iso(new Date(Date.now() - LAG_DAYS * DAY)));
  await c.close();
});
