// MCP tools. One McpServer is built per request (stateless Streamable HTTP); all state that matters
// lives in the GSC client behind the Ctx.
import { McpServer, type ToolCallback } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { Config } from './env.ts';
import { authKind } from './env.ts';
import type { AnalyticsRow, GSC, SiteEntry } from './gsc.ts';
import type { Store } from './store.ts';

export const VERSION = '0.1.0';

export interface Ctx {
  cfg: Config;
  gsc: GSC;
  /**
   * The local mirror, on the multi-tenant build. Present only where there is a database and an
   * account to key it by; the single-account server has neither and simply asks Google every time.
   */
  mirror?: { store: Store; accountId: string };
  /**
   * Called after every tool call, with what happened and nothing about what was asked. Set by the
   * supervisor on the multi-tenant build, where it writes a usage row; unset on the single-account
   * server, which has no database to write to.
   */
  onCall?: (call: { tool: string; ok: boolean; ms: number; code: string | null }) => void;
}

type ToolResult = { content: { type: 'text'; text: string }[]; isError?: boolean };

const text = (t: string): ToolResult => ({ content: [{ type: 'text', text: t }] });
const json = (v: unknown): ToolResult => text(JSON.stringify(v, null, 1));
const fail = (e: unknown): ToolResult => ({ isError: true, content: [{ type: 'text', text: e instanceof Error ? e.message : String(e) }] });

/**
 * A coarse reason, from a fixed list — never the error message.
 *
 * The message is the right thing to show a caller and the wrong thing to STORE: it can quote a
 * property, a URL or a search term, and the usage table exists so support can see whether a
 * connector works, not to become a second copy of somebody's traffic. A closed vocabulary cannot
 * leak one.
 */
export function errorCode(e: unknown): string {
  const m = (e instanceof Error ? e.message : String(e)).toLowerCase();
  if (m.includes('quota project')) return 'no_quota_project';
  if (m.includes('rate-limiting')) return 'rate_limited';
  if (m.includes('rejected the credentials')) return 'bad_credentials';
  if (m.includes('refused the call')) return 'forbidden';
  if (m.includes('no property')) return 'no_site';
  if (m.includes('not valid json')) return 'bad_config';
  if (m.includes('date')) return 'bad_date';
  return 'error';
}

// ------------------------------------------------------------------ dates

const DAY = 86400000;
const iso = (d: Date) => d.toISOString().slice(0, 10);
const parseDay = (s: string): Date => {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) throw new Error(`Not a valid date: "${s}". Use YYYY-MM-DD.`);
  const d = new Date(`${s}T00:00:00Z`);
  if (Number.isNaN(d.getTime())) throw new Error(`Not a valid date: "${s}". Use YYYY-MM-DD.`);
  return d;
};

/**
 * Search Console is two to three days behind, always. Defaulting a range to "today" therefore
 * returns a fortnight of data and two empty days, and every reader concludes traffic collapsed.
 * Ranges that are not given explicitly end here instead.
 */
export const LAG_DAYS = 3;
const defaultEnd = () => iso(new Date(Date.now() - LAG_DAYS * DAY));
const daysBefore = (end: string, n: number) => iso(new Date(parseDay(end).getTime() - (n - 1) * DAY));

// ------------------------------------------------------------------ formatting

const pct = (n: number) => `${(n * 100).toFixed(2)}%`;
const pos = (n: number) => n.toFixed(1);

/** A markdown table — the one shape that survives being read by a person and by a model. */
function table(header: string[], rows: string[][]): string {
  const sep = header.map(() => '---');
  return [header, sep, ...rows].map((r) => r.join(' | ')).join('\n');
}

const totals = (rows: AnalyticsRow[]) => {
  const clicks = rows.reduce((n, r) => n + r.clicks, 0);
  const impressions = rows.reduce((n, r) => n + r.impressions, 0);
  return {
    clicks,
    impressions,
    ctr: impressions ? clicks / impressions : 0,
    // Weighted by impressions, which is how Search Console itself averages position. A plain mean
    // over rows lets a term with nine impressions at position 2 outweigh one with nine thousand
    // at position 30, and the number it produces appears nowhere in the Google UI.
    position: impressions ? rows.reduce((n, r) => n + r.position * r.impressions, 0) / impressions : 0,
  };
};

const delta = (now: number, then: number) => {
  if (then === 0) return now === 0 ? '0%' : 'new';
  const d = ((now - then) / then) * 100;
  return `${d >= 0 ? '+' : ''}${d.toFixed(1)}%`;
};

// ------------------------------------------------------------------ instructions

/**
 * What Claude reads before it calls anything. The siblings each carry one and it is most of why
 * they feel like a colleague rather than an API: it names the account, says where to start, and
 * states the one domain fact that silently ruins answers — here, the reporting lag.
 */
export function instructions(ctx: Ctx): string {
  const { cfg } = ctx;
  // Two shapes, and the second is a real configuration rather than a missing one. A connector was
  // never limited to its default property — no tool filters by it — so a deployment with many
  // properties is expected to set no default and name one per call.
  const bound = cfg.defaultSite
    ? ` Bound to ${cfg.defaultSite}, which every tool assumes when siteUrl is omitted. Other properties on this account are still reachable by passing siteUrl.`
    : ' This connector has no default property and reaches every property its Google account can see.';
  return `Google Search Console.${bound}
Properties are addressed exactly as Search Console spells them: "sc-domain:example.com" for a domain property, "https://example.com/" (with the trailing slash) for a URL-prefix one. list_sites is the authority on which exist${cfg.defaultSite ? '' : ' — call it first and pass siteUrl on every call, since there is no default to fall back on. If the person names a site in words ("the Spanish one"), match it against list_sites rather than guessing the spelling'}.
Start with search_analytics for what people searched and where the site ranked, compare_periods for whether that is getting better or worse, inspect_url for why one page is or is not in the index, list_sitemaps for whether Google is reading the sitemap at all.
SEARCH CONSOLE IS ${LAG_DAYS} DAYS BEHIND. There is no data for today or yesterday, and the last two days of any range are incomplete and will rise later. Ranges left unset end ${LAG_DAYS} days ago for that reason; a range that ends today is not an error but its tail is not real. Data older than 16 months does not exist at Google at all${ctx.mirror ? ', but this connector keeps its own copy of what it has already seen — status() says how far back that reaches, and a range inside it is answered from there without spending API quota' : ''}.
Times are ${cfg.tz}.
${
    cfg.allowWrite
      ? 'WRITES ARE ENABLED on this connector: submit_sitemap, delete_sitemap, add_property, remove_property and request_indexing all change something at Google, and remove_property drops a property out of Search Console along with its history. Confirm the exact target with the person before calling any of them, every time — none is undone by calling it again.'
      : 'Everything here reads. The write tools (submit_sitemap, delete_sitemap, add_property, remove_property, request_indexing) exist but are switched off for this connector and will refuse.'
  }`;
}

// ------------------------------------------------------------------ the server

export function buildServer(ctx: Ctx): McpServer {
  const { cfg, gsc } = ctx;
  const server = new McpServer({ name: 'GOOGLE2AI', version: VERSION }, { instructions: instructions(ctx) });

  // Small wrapper so every tool returns a clean one-line error instead of a stack trace, and so the
  // usage hook sees the outcome of each call without every tool remembering to report it.
  const tool = <S extends z.ZodRawShape>(name: string, description: string, shape: S, fn: (a: z.infer<z.ZodObject<S>>) => Promise<ToolResult> | ToolResult) =>
    server.registerTool(name, { description, inputSchema: shape }, (async (args: unknown) => {
      const started = Date.now();
      try {
        const r = await fn(args as z.infer<z.ZodObject<S>>);
        ctx.onCall?.({ tool: name, ok: true, ms: Date.now() - started, code: null });
        return r;
      } catch (e) {
        // Recorded, then swallowed: a usage row is a nicety and must never turn a tool error into a
        // transport error. The caller still gets the real message; only the STORED form is coarse.
        ctx.onCall?.({ tool: name, ok: false, ms: Date.now() - started, code: errorCode(e) });
        return fail(e);
      }
    }) as ToolCallback<S>);

  /**
   * Which property a call is about. Omitting it is only legal when the deployment named one, and
   * the error says how to find the spelling — "example.com" is not a property and the API's own
   * answer for it is an unhelpful 403.
   */
  const site = (given?: string): string => {
    const s = (given ?? '').trim() || cfg.defaultSite;
    if (!s) throw new Error('No property given and none is configured. Call list_sites and pass one of the siteUrl values exactly as it appears there.');
    return s;
  };

  const filters = (a: { queryFilter?: string; pageFilter?: string; countryFilter?: string; deviceFilter?: string }) => {
    const out: { dimension: string; operator: string; expression: string }[] = [];
    for (const [dimension, raw] of [['query', a.queryFilter], ['page', a.pageFilter]] as const) {
      if (!raw) continue;
      const isRegex = raw.startsWith('regex:');
      out.push({ dimension, operator: isRegex ? 'includingRegex' : 'contains', expression: isRegex ? raw.slice(6) : raw });
    }
    if (a.countryFilter) out.push({ dimension: 'country', operator: 'equals', expression: a.countryFilter.toLowerCase() });
    if (a.deviceFilter) out.push({ dimension: 'device', operator: 'equals', expression: a.deviceFilter.toUpperCase() });
    return out;
  };

  const filterShape = {
    queryFilter: z.string().optional().describe('Filter by search query; prefix with "regex:" for a regular expression'),
    pageFilter: z.string().optional().describe('Filter by page URL; prefix with "regex:" for a regular expression'),
    countryFilter: z.string().optional().describe('ISO 3166-1 alpha-3 country code, e.g. USA, GBR, SVN'),
    deviceFilter: z.enum(['DESKTOP', 'MOBILE', 'TABLET']).optional().describe('Restrict to one device type'),
  };

  // ------------------------------------------------------------------ tools

  tool('status', 'Credentials, reachability, which properties are visible, and how much history the local mirror holds. Call this first if other tools fail.', {}, async () => {
    const st = gsc.status();
    // What the mirror holds is the only way to know that history older than Google's 16 months is
    // available at all — without it nobody would think to ask for it.
    const mirror = ctx.mirror ? await ctx.mirror.store.stats(ctx.mirror.accountId).catch(() => null) : null;
    return json({
      ...st,
      default_site: cfg.defaultSite || null,
      timezone: cfg.tz,
      reporting_lag_days: LAG_DAYS,
      latest_complete_date: defaultEnd(),
      writes_possible: cfg.allowWrite,
      mirror: mirror?.length ? mirror : null,
      version: VERSION,
    });
  });

  tool('list_sites', 'Every Search Console property these credentials can read, with the permission level on each.', {}, async () => {
    const sites: SiteEntry[] = await gsc.listSites();
    if (!sites.length) {
      // The empty answer is the one worth explaining: it is almost never "you have no sites", it is
      // the wrong credentials or an account that was never added to the property.
      const kind = authKind(cfg);
      return text(
        kind === 'oauth'
          ? 'No properties. These OAuth credentials belong to a Google account with no Search Console access — check you consented as the account that owns the property.'
          : 'No properties. A service account has no Search Console access until it is added under Settings → Users and permissions on each property — and that form currently rejects newly created service accounts, which is why OAuth is the supported path for a hosted deployment.',
      );
    }
    return json(sites);
  });

  tool(
    'search_analytics',
    'Clicks, impressions, CTR and average position, grouped by whichever dimensions you ask for. The workhorse: use it for top queries, top pages, country and device splits, and daily trends.',
    {
      siteUrl: z.string().optional().describe('Property, exactly as list_sites spells it. Omit to use the configured default.'),
      startDate: z.string().optional().describe('YYYY-MM-DD. Omit to use the 28 days ending at the last complete day.'),
      endDate: z.string().optional().describe(`YYYY-MM-DD. Omit to use the last complete day (${LAG_DAYS} days ago).`),
      dimensions: z.string().optional().describe('Comma-separated: query, page, country, device, searchAppearance, date. Default "query".'),
      rowLimit: z.number().int().min(1).max(25000).optional().describe('Max rows (default 100)'),
      searchType: z.enum(['web', 'image', 'video', 'news', 'discover', 'googleNews']).optional().describe('Which surface (default web)'),
      ...filterShape,
    },
    async (a) => {
      const endDate = a.endDate ?? defaultEnd();
      const startDate = a.startDate ?? daysBefore(endDate, 28);
      parseDay(startDate);
      parseDay(endDate);
      const dimensions = (a.dimensions ?? 'query').split(',').map((d) => d.trim()).filter(Boolean);
      const rowLimit = Math.min(a.rowLimit ?? 100, cfg.maxRows);
      const f = filters(a);

      /**
       * The mirror answers only when it can answer COMPLETELY, and only for an unfiltered,
       * web-search query — it stores grouped totals per day, so it has nothing to apply a filter
       * to and nothing for the other search types. Everything else falls through to Google.
       *
       * A partial answer from here would under-report, and under-reporting is indistinguishable
       * from a drop in traffic to whoever reads it.
       */
      let rows: AnalyticsRow[] | null = null;
      let source = 'Google';
      const mirrorable = ctx.mirror && !f.length && (a.searchType ?? 'web') === 'web';
      if (mirrorable && (await ctx.mirror!.store.canAnswer(ctx.mirror!.accountId, dimensions.join(','), startDate, endDate))) {
        rows = await ctx.mirror!.store.read(ctx.mirror!.accountId, dimensions.join(','), startDate, endDate, rowLimit);
        source = 'the local mirror';
      }

      if (!rows) {
        rows = await gsc.searchAnalytics({
          siteUrl: site(a.siteUrl),
          startDate,
          endDate,
          dimensions,
          rowLimit,
          searchType: a.searchType ?? 'web',
          filters: f,
        });
      }

      if (!rows.length) return text(`No data for ${startDate} → ${endDate}. If that range ends within the last ${LAG_DAYS} days, Search Console has not published it yet.`);
      const t = totals(rows);
      const body = table(
        [...dimensions, 'clicks', 'impressions', 'ctr', 'position'],
        rows.map((r) => [...r.keys, String(r.clicks), String(r.impressions), pct(r.ctr), pos(r.position)]),
      );
      return text(
        `${startDate} → ${endDate} · ${rows.length} rows · from ${source} · totals: ${t.clicks} clicks, ${t.impressions} impressions, ${pct(t.ctr)} CTR, position ${pos(t.position)}\n\n${body}`,
      );
    },
  );

  tool(
    'compare_periods',
    'The same metrics over two consecutive windows, with the change on each row. Answers "is this getting better or worse" — week-over-week, month-over-month, or any window length you pass.',
    {
      siteUrl: z.string().optional().describe('Property, exactly as list_sites spells it. Omit to use the configured default.'),
      days: z.number().int().min(1).max(180).optional().describe('Length of each window in days (default 28)'),
      endDate: z.string().optional().describe(`Last day of the RECENT window, YYYY-MM-DD. Omit for the last complete day (${LAG_DAYS} days ago).`),
      dimensions: z.string().optional().describe('Comma-separated, as in search_analytics. Default "query".'),
      rowLimit: z.number().int().min(1).max(1000).optional().describe('Rows to compare, taken from the recent window by clicks (default 25)'),
      searchType: z.enum(['web', 'image', 'video', 'news', 'discover', 'googleNews']).optional(),
      ...filterShape,
    },
    async (a) => {
      const days = a.days ?? 28;
      const recentEnd = a.endDate ?? defaultEnd();
      const recentStart = daysBefore(recentEnd, days);
      // The prior window ends the day before the recent one starts, so the two abut and never
      // overlap — an overlap would double-count the boundary day and flatter every trend.
      const priorEnd = iso(new Date(parseDay(recentStart).getTime() - DAY));
      const priorStart = daysBefore(priorEnd, days);

      const dimensions = (a.dimensions ?? 'query').split(',').map((d) => d.trim()).filter(Boolean);
      const base = {
        siteUrl: site(a.siteUrl),
        dimensions,
        rowLimit: Math.min((a.rowLimit ?? 25) * 4, cfg.maxRows),
        searchType: a.searchType ?? 'web',
        filters: filters(a),
      };
      const [recent, prior] = await Promise.all([
        gsc.searchAnalytics({ ...base, startDate: recentStart, endDate: recentEnd }),
        gsc.searchAnalytics({ ...base, startDate: priorStart, endDate: priorEnd }),
      ]);

      const key = (r: AnalyticsRow) => r.keys.join(' | ');
      const before = new Map(prior.map((r) => [key(r), r]));
      const limit = a.rowLimit ?? 25;
      const rows = [...recent].sort((x, y) => y.clicks - x.clicks).slice(0, limit);

      const rt = totals(recent);
      const pt = totals(prior);
      const body = table(
        [...dimensions, 'clicks', 'Δ clicks', 'impressions', 'Δ impr', 'ctr', 'position', 'Δ pos'],
        rows.map((r) => {
          const b = before.get(key(r));
          // A position that improved is a SMALLER number, so the delta is inverted deliberately:
          // "+1.4" on this column means it moved up the page, which is what a reader expects a
          // positive change to mean.
          const dp = b ? (b.position - r.position >= 0 ? '+' : '') + (b.position - r.position).toFixed(1) : 'new';
          return [...r.keys, String(r.clicks), b ? delta(r.clicks, b.clicks) : 'new', String(r.impressions), b ? delta(r.impressions, b.impressions) : 'new', pct(r.ctr), pos(r.position), dp];
        }),
      );
      return text(
        `${recentStart} → ${recentEnd} vs ${priorStart} → ${priorEnd} (${days} days each)\n` +
          `clicks ${rt.clicks} (${delta(rt.clicks, pt.clicks)}) · impressions ${rt.impressions} (${delta(rt.impressions, pt.impressions)}) · ` +
          `CTR ${pct(rt.ctr)} (was ${pct(pt.ctr)}) · position ${pos(rt.position)} (was ${pos(pt.position)})\n\n${body}\n\n` +
          `"new" means the row had no impressions in the earlier window. Δ pos is positive when the ranking improved.`,
      );
    },
  );

  tool(
    'inspect_url',
    'Whether Google has indexed one URL, when it last crawled it, which canonical it chose, and any mobile usability problems.',
    {
      inspectionUrl: z.string().describe('The full URL to inspect; it must belong to the property'),
      siteUrl: z.string().optional().describe('Property, exactly as list_sites spells it. Omit to use the configured default.'),
    },
    async (a) => {
      const r = await gsc.inspectUrl(site(a.siteUrl), a.inspectionUrl);
      if (!r) return text(`Google returned no inspection result for ${a.inspectionUrl}.`);
      const lines = [`URL inspection: ${a.inspectionUrl}`, ''];
      lines.push('## Indexing');
      lines.push(`Coverage: ${r.coverageState ?? 'unknown'}`);
      lines.push(`Verdict: ${r.verdict ?? 'unknown'}`);
      if (r.indexingState) lines.push(`Indexing allowed: ${r.indexingState}`);
      if (r.lastCrawlTime) lines.push(`Last crawled: ${r.lastCrawlTime}`);
      if (r.crawledAs) lines.push(`Crawled as: ${r.crawledAs}`);
      if (r.robotsTxtState) lines.push(`robots.txt: ${r.robotsTxtState}`);
      if (r.pageFetchState) lines.push(`Page fetch: ${r.pageFetchState}`);
      // A canonical Google picked that differs from the declared one is the single most common
      // reason a page is missing from search while every other field reads healthy, so it is
      // called out rather than left for the reader to diff two URLs by eye.
      if (r.googleCanonical && r.userCanonical && r.googleCanonical !== r.userCanonical) {
        lines.push('', `⚠ Google chose a different canonical: ${r.googleCanonical} (the page declares ${r.userCanonical}). This page will not rank on its own.`);
      }
      if (r.sitemaps?.length) lines.push('', `In sitemaps: ${r.sitemaps.join(', ')}`);
      if (r.mobile) {
        lines.push('', '## Mobile usability', `Verdict: ${r.mobile.verdict ?? 'unknown'}`);
        for (const i of r.mobile.issues) lines.push(`  - ${i.issueType ?? 'issue'}: ${i.message ?? ''}`);
      }
      return text(lines.join('\n'));
    },
  );

  /**
   * Two switches upstream of every write, and the error names both routes because whoever reads it
   * is the one who has to act on it. Ported straight from whatsapp2ai's guardSend, which exists for
   * the same reason: the read half of one of these connectors is safe to hand an agent, and the
   * write half is not.
   *
   * On the multi-tenant build cfg.allowWrite is the ACCOUNT's switch (tenants.ts narrows it), so a
   * deployment with writes enabled still has them off per account until somebody says otherwise.
   */
  const guardWrite = (what: string) => {
    if (!cfg.allowWrite) {
      throw new Error(`Writing is switched off for this connector, so ${what} did nothing. Turn it on in the dashboard, or set GSC_ALLOW_WRITE=true on a self-hosted server.`);
    }
  };

  tool(
    'submit_sitemap',
    'Submit a sitemap to Search Console, or resubmit one to ask Google to re-read it. CHANGES YOUR PROPERTY — confirm the URL with the person first.',
    {
      feedpath: z.string().describe('Full URL of the sitemap, e.g. https://example.com/sitemap.xml'),
      siteUrl: z.string().optional().describe('Property, exactly as list_sites spells it. Omit to use the configured default.'),
    },
    async (a) => {
      guardWrite('submit_sitemap');
      const s = site(a.siteUrl);
      await gsc.submitSitemap(s, a.feedpath);
      return text(`Submitted ${a.feedpath} to ${s}. Google reads sitemaps on its own schedule — list_sitemaps will show a lastDownloaded once it has, which is usually hours rather than minutes.`);
    },
  );

  tool(
    'delete_sitemap',
    'Un-submit a sitemap from Search Console. DESTRUCTIVE: Google stops tracking it, and the submitted/indexed counts for it are lost. Confirm with the person first.',
    {
      feedpath: z.string().describe('Full URL of the sitemap, exactly as list_sitemaps shows it'),
      siteUrl: z.string().optional().describe('Property, exactly as list_sites spells it. Omit to use the configured default.'),
    },
    async (a) => {
      guardWrite('delete_sitemap');
      const s = site(a.siteUrl);
      await gsc.deleteSitemap(s, a.feedpath);
      return text(`Removed ${a.feedpath} from ${s}. This does not deindex anything — it only stops Google tracking that sitemap. Resubmit with submit_sitemap if it was a mistake.`);
    },
  );

  tool(
    'add_property',
    'Add a property to this Search Console account. It still has to be VERIFIED separately — adding it does not grant access to any data.',
    { siteUrl: z.string().describe('sc-domain:example.com for a domain property, or https://example.com/ with the trailing slash') },
    async (a) => {
      guardWrite('add_property');
      await gsc.addSite(a.siteUrl);
      return text(`Added ${a.siteUrl}. It will return no data until it is verified — Search Console → Settings → Ownership verification. A domain property needs a DNS TXT record, which cannot be done from here.`);
    },
  );

  tool(
    'remove_property',
    'Remove a property from this Search Console account. DESTRUCTIVE AND NOT REVERSIBLE FROM HERE: re-adding it needs ownership verification again, and Search Console history is not restored by it. Always confirm the exact property with the person first.',
    { siteUrl: z.string().describe('Property, exactly as list_sites spells it') },
    async (a) => {
      guardWrite('remove_property');
      // Deliberately no default: every other tool falls back to the configured property, and a
      // tool that DELETES one must never act on a target nobody typed.
      await gsc.deleteSite(a.siteUrl);
      return text(`Removed ${a.siteUrl} from this Search Console account. Re-adding it requires ownership verification again.`);
    },
  );

  tool(
    'request_indexing',
    'Ask Google to recrawl or drop one URL, via the Indexing API. HEAVILY RESTRICTED: Google officially supports it only for pages carrying JobPosting or BroadcastEvent structured data, and ignores it for ordinary pages. The quota is 200 requests per day.',
    {
      url: z.string().describe('The full URL, on a property you are a verified OWNER of'),
      type: z.enum(['URL_UPDATED', 'URL_DELETED']).optional().describe('URL_UPDATED to ask for a recrawl (default), URL_DELETED to report it gone'),
    },
    async (a) => {
      guardWrite('request_indexing');
      const type = a.type ?? 'URL_UPDATED';
      const r = await gsc.requestIndexing(a.url, type);
      return text(
        `Google accepted a ${type} notification for ${a.url}${r.notifyTime ? ` at ${r.notifyTime}` : ''}.\n\n` +
          `Accepting it is not the same as acting on it: outside JobPosting and BroadcastEvent pages Google documents no effect, and inspect_url is the only way to find out whether anything actually changed.`,
      );
    },
  );

  tool(
    'list_sitemaps',
    'Submitted sitemaps for a property: when Google last read each one, how many URLs it found and how many it indexed.',
    { siteUrl: z.string().optional().describe('Property, exactly as list_sites spells it. Omit to use the configured default.') },
    async (a) => {
      const s = site(a.siteUrl);
      const maps = await gsc.listSitemaps(s);
      if (!maps.length) return text(`No sitemaps submitted for ${s}.`);
      return text(
        table(
          ['path', 'last downloaded', 'submitted', 'indexed', 'errors', 'warnings'],
          maps.map((m) => [m.path + (m.isPending ? ' (pending)' : ''), m.lastDownloaded ?? 'never', String(m.submitted), String(m.indexed), String(m.errors), String(m.warnings)]),
        ),
      );
    },
  );

  return server;
}
