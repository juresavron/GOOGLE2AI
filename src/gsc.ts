// The Google Search Console API, behind an interface.
//
// Two implementations satisfy it: the real one, and a seeded mock. The mock is not a testing
// nicety — it is what lets `npm test` and the deploy workflow run with no credentials and no
// network, the same job WA_MOCK does for whatsapp2ai. Without it, CI could only ever assert that
// the process starts.
//
// Nothing here formats anything for a reader. Tools do that, so the shapes below stay close to what
// Google returns and a change in presentation never means touching the client.
import type { Config } from './env.ts';
import { authKind } from './env.ts';

export const SCOPE = 'https://www.googleapis.com/auth/webmasters.readonly';

export interface SiteEntry {
  siteUrl: string;
  permissionLevel: string;
}

export interface AnalyticsQuery {
  siteUrl: string;
  startDate: string;
  endDate: string;
  dimensions: string[];
  rowLimit: number;
  searchType: string;
  filters: { dimension: string; operator: string; expression: string }[];
}

export interface AnalyticsRow {
  keys: string[];
  clicks: number;
  impressions: number;
  ctr: number;
  position: number;
}

export interface InspectionResult {
  coverageState?: string | null;
  indexingState?: string | null;
  lastCrawlTime?: string | null;
  crawledAs?: string | null;
  robotsTxtState?: string | null;
  pageFetchState?: string | null;
  verdict?: string | null;
  googleCanonical?: string | null;
  userCanonical?: string | null;
  referringUrls?: string[] | null;
  sitemaps?: string[] | null;
  mobile?: { verdict?: string | null; issues: { issueType?: string | null; message?: string | null }[] } | null;
}

export interface SitemapEntry {
  path: string;
  lastSubmitted: string | null;
  lastDownloaded: string | null;
  isPending: boolean;
  isSitemapsIndex: boolean;
  type: string | null;
  warnings: number;
  errors: number;
  submitted: number;
  indexed: number;
}

export interface GscStatus {
  auth: string;
  ready: boolean;
  error: string | null;
  quota_project: string | null;
  checked_at: number | null;
  sites: number | null;
}

export interface GSC {
  listSites(): Promise<SiteEntry[]>;
  searchAnalytics(q: AnalyticsQuery): Promise<AnalyticsRow[]>;
  inspectUrl(siteUrl: string, inspectionUrl: string): Promise<InspectionResult | null>;
  listSitemaps(siteUrl: string): Promise<SitemapEntry[]>;
  status(): GscStatus;
}

/**
 * A Google error, reduced to one line a person can act on.
 *
 * The raw shape buries the useful sentence three levels down and the top-level `message` is often
 * just "Request failed with status code 403" — which is the difference between "your quota project
 * is not set" and a support ticket. The two 403s that actually happen are named, because their
 * remedies are completely different and neither is guessable from the status code.
 */
export function cleanError(e: unknown): string {
  const any = e as { message?: string; code?: number | string; errors?: { message?: string }[]; response?: { status?: number; data?: { error?: { message?: string; status?: string } } } };
  const inner = any?.response?.data?.error?.message || any?.errors?.[0]?.message || any?.message || String(e);
  const status = Number(any?.response?.status ?? any?.code);

  if (status === 403 && /quota project/i.test(inner)) {
    return 'Google refused the call because no quota project is attached to these credentials. Set GOOGLE_QUOTA_PROJECT to a project id with the Search Console API enabled.';
  }
  if (status === 403) {
    return `Google refused the call (403). These credentials can reach the API but not this property — check that the account was added in Search Console → Settings → Users and permissions. (${inner})`;
  }
  if (status === 401) {
    return `Google rejected the credentials (401). A refresh token can be revoked by changing the account password or withdrawing consent; reissue one. (${inner})`;
  }
  if (status === 429) return `Google is rate-limiting these credentials (429). Search Console allows roughly 1200 queries per minute per project. (${inner})`;
  return inner;
}

// ------------------------------------------------------------------ the real client

export class GoogleGSC implements GSC {
  private readonly cfg: Config;
  private readonly kind: string;
  private api: any = null;
  private err: string | null = null;
  private checked: number | null = null;
  private siteCount: number | null = null;

  constructor(cfg: Config) {
    this.cfg = cfg;
    this.kind = authKind(cfg);
  }

  /**
   * Built on first use rather than in the constructor, so a misconfigured deployment still serves
   * /healthz and the setup page that explains what is wrong. A server that refuses to start cannot
   * tell anybody why.
   */
  private async client(): Promise<any> {
    if (this.api) return this.api;
    const { google } = await import('googleapis');
    const cfg = this.cfg;
    let auth: any;

    if (this.kind === 'oauth') {
      const o = new google.auth.OAuth2({ clientId: cfg.clientId, clientSecret: cfg.clientSecret });
      o.setCredentials({ refresh_token: cfg.refreshToken });
      auth = o;
    } else if (this.kind === 'inline') {
      let credentials: Record<string, unknown>;
      try {
        credentials = JSON.parse(cfg.credentialsJson);
      } catch {
        // Thrown rather than logged: every tool call needs this, so failing here gives one clear
        // message instead of four different downstream ones.
        throw new Error('GOOGLE_CREDENTIALS_JSON is not valid JSON. It must hold the whole service account key file, not a path to it.');
      }
      auth = new google.auth.GoogleAuth({ credentials, scopes: [SCOPE] });
    } else if (this.kind === 'file') {
      auth = new google.auth.GoogleAuth({ keyFile: cfg.credentialsFile, scopes: [SCOPE] });
    } else {
      auth = new google.auth.GoogleAuth({ scopes: [SCOPE] });
    }

    this.api = google.searchconsole({ version: 'v1', auth });
    return this.api;
  }

  /**
   * The quota project travels as a header rather than as a client option.
   *
   * GoogleAuth accepts `quotaProjectId`, the OAuth2 client does not — and OAuth2 is precisely the
   * path that REQUIRES one. One header covers both, and applying it uniformly means the service
   * account paths (which bill their own project and ignore it) behave no differently.
   */
  private opts(): { headers?: Record<string, string> } {
    return this.cfg.quotaProject ? { headers: { 'x-goog-user-project': this.cfg.quotaProject } } : {};
  }

  private async call<T>(fn: (api: any) => Promise<T>): Promise<T> {
    try {
      const api = await this.client();
      const out = await fn(api);
      this.err = null;
      this.checked = Math.floor(Date.now() / 1000);
      return out;
    } catch (e) {
      this.err = cleanError(e);
      this.checked = Math.floor(Date.now() / 1000);
      throw new Error(this.err);
    }
  }

  async listSites(): Promise<SiteEntry[]> {
    const sites = await this.call(async (api) => {
      const res = await api.sites.list(this.opts());
      return (res.data.siteEntry || []) as { siteUrl?: string; permissionLevel?: string }[];
    });
    this.siteCount = sites.length;
    return sites.map((s) => ({ siteUrl: String(s.siteUrl ?? ''), permissionLevel: String(s.permissionLevel ?? 'unknown') }));
  }

  async searchAnalytics(q: AnalyticsQuery): Promise<AnalyticsRow[]> {
    return this.call(async (api) => {
      const requestBody: Record<string, unknown> = {
        startDate: q.startDate,
        endDate: q.endDate,
        dimensions: q.dimensions,
        rowLimit: q.rowLimit,
        type: q.searchType,
        // `all` includes the most recent, still-incomplete days. `final` would drop them silently,
        // which turns "yesterday looks terrible" into a support question every single time.
        dataState: 'all',
      };
      if (q.filters.length) requestBody.dimensionFilterGroups = [{ filters: q.filters }];
      const res = await api.searchanalytics.query({ siteUrl: q.siteUrl, requestBody }, this.opts());
      return ((res.data.rows || []) as Record<string, any>[]).map((r) => ({
        keys: (r.keys || []) as string[],
        clicks: Number(r.clicks ?? 0),
        impressions: Number(r.impressions ?? 0),
        ctr: Number(r.ctr ?? 0),
        position: Number(r.position ?? 0),
      }));
    });
  }

  async inspectUrl(siteUrl: string, inspectionUrl: string): Promise<InspectionResult | null> {
    return this.call(async (api) => {
      const res = await api.urlInspection.index.inspect({ requestBody: { inspectionUrl, siteUrl } }, this.opts());
      const r = res.data.inspectionResult;
      if (!r) return null;
      const idx = r.indexStatusResult ?? {};
      const mob = r.mobileUsabilityResult;
      return {
        coverageState: idx.coverageState,
        indexingState: idx.indexingState,
        lastCrawlTime: idx.lastCrawlTime,
        crawledAs: idx.crawledAs,
        robotsTxtState: idx.robotsTxtState,
        pageFetchState: idx.pageFetchState,
        verdict: idx.verdict,
        googleCanonical: idx.googleCanonical,
        userCanonical: idx.userCanonical,
        referringUrls: idx.referringUrls,
        sitemaps: idx.sitemap,
        mobile: mob ? { verdict: mob.verdict, issues: (mob.issues || []).map((i: any) => ({ issueType: i.issueType, message: i.message })) } : null,
      };
    });
  }

  async listSitemaps(siteUrl: string): Promise<SitemapEntry[]> {
    return this.call(async (api) => {
      const res = await api.sitemaps.list({ siteUrl }, this.opts());
      return ((res.data.sitemap || []) as Record<string, any>[]).map(toSitemap);
    });
  }

  status(): GscStatus {
    return {
      auth: this.kind,
      ready: this.err === null && this.checked !== null,
      error: this.err,
      quota_project: this.cfg.quotaProject || null,
      checked_at: this.checked,
      sites: this.siteCount,
    };
  }
}

/** Google reports per-type counts as an array; a total is what anyone actually asks for. */
function toSitemap(s: Record<string, any>): SitemapEntry {
  const sum = (key: string) => (s.contents || []).reduce((n: number, c: Record<string, any>) => n + Number(c[key] ?? 0), 0);
  return {
    path: String(s.path ?? ''),
    lastSubmitted: s.lastSubmitted ?? null,
    lastDownloaded: s.lastDownloaded ?? null,
    isPending: Boolean(s.isPending),
    isSitemapsIndex: Boolean(s.isSitemapsIndex),
    type: s.type ?? null,
    warnings: Number(s.warnings ?? 0),
    errors: Number(s.errors ?? 0),
    submitted: sum('submitted'),
    indexed: sum('indexed'),
  };
}

// ------------------------------------------------------------------ the mock

const MOCK_SITE = 'sc-domain:example.com';
const MOCK_QUERIES = [
  ['ocena gostilne', 1200, 42, 3.2],
  ['najboljsa restavracija ljubljana', 880, 31, 5.1],
  ['qr koda za mnenja', 640, 58, 2.4],
  ['google ocene za lokal', 410, 12, 8.7],
  ['kako pridobiti vec ocen', 260, 4, 14.3],
] as const;

/**
 * Seeded, deterministic Search Console data. Deterministic matters: the e2e test asserts on real
 * numbers, and a mock that drifted would make the suite flake for reasons that have nothing to do
 * with the server.
 */
export class MockGSC implements GSC {
  async listSites(): Promise<SiteEntry[]> {
    return [
      { siteUrl: MOCK_SITE, permissionLevel: 'siteOwner' },
      { siteUrl: 'https://shop.example.com/', permissionLevel: 'siteFullUser' },
    ];
  }

  async searchAnalytics(q: AnalyticsQuery): Promise<AnalyticsRow[]> {
    const rows: AnalyticsRow[] = MOCK_QUERIES.map(([term, impressions, clicks, position]) => ({
      keys: q.dimensions.map((d) => (d === 'date' ? q.startDate : d === 'country' ? 'svn' : d === 'device' ? 'DESKTOP' : d === 'page' ? `https://example.com/${String(term).replace(/\s+/g, '-')}` : String(term))),
      clicks,
      impressions,
      ctr: clicks / impressions,
      position,
    }));
    const matches = (r: AnalyticsRow) => q.filters.every((f) => r.keys.some((k) => k.toLowerCase().includes(f.expression.toLowerCase())));
    return rows.filter(matches).slice(0, q.rowLimit);
  }

  async inspectUrl(_siteUrl: string, inspectionUrl: string): Promise<InspectionResult | null> {
    // One URL deliberately comes back not-indexed, so the tools test covers the branch that
    // matters most to anyone actually using this.
    const indexed = !inspectionUrl.includes('/draft');
    return {
      coverageState: indexed ? 'Submitted and indexed' : 'Crawled - currently not indexed',
      indexingState: 'INDEXING_ALLOWED',
      lastCrawlTime: '2026-09-17T04:21:00Z',
      crawledAs: 'MOBILE',
      robotsTxtState: 'ALLOWED',
      pageFetchState: 'SUCCESSFUL',
      verdict: indexed ? 'PASS' : 'NEUTRAL',
      googleCanonical: inspectionUrl,
      userCanonical: inspectionUrl,
      referringUrls: null,
      sitemaps: ['https://example.com/sitemap.xml'],
      mobile: { verdict: 'PASS', issues: [] },
    };
  }

  async listSitemaps(_siteUrl: string): Promise<SitemapEntry[]> {
    return [
      { path: 'https://example.com/sitemap.xml', lastSubmitted: '2026-09-01T09:00:00Z', lastDownloaded: '2026-09-18T02:14:00Z', isPending: false, isSitemapsIndex: false, type: 'sitemap', warnings: 2, errors: 0, submitted: 143, indexed: 139 },
    ];
  }

  status(): GscStatus {
    return { auth: 'mock', ready: true, error: null, quota_project: null, checked_at: Math.floor(Date.now() / 1000), sites: 2 };
  }
}
