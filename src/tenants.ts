// Turning a connector token into a Ctx.
//
// This is the resolver mountMcp takes for /c/<token>/mcp, and the reason mountMcp took a resolver in
// the first place: the single-account route and this one differ in nothing else.
//
// Its job is four checks and a cache. The checks are: does this token exist and is it live, is the
// account actually connected, is it inside its rate limit, and can its credential be unsealed. Each
// answers differently on purpose — a revoked token is 404, an unfinished setup is 503 with a reason,
// a loop is 429 with a Retry-After.
import crypto from 'node:crypto';
import type pino from 'pino';
import type { Config } from './env.ts';
import type { Db } from './db.ts';
import { GoogleGSC, type GSC } from './gsc.ts';
import type { GoogleOAuth } from './google-oauth.ts';
import { open as unseal } from './secrets.ts';
import type { McpResolution } from './mcp.ts';
import { Store } from './store.ts';
import type { Ctx } from './tools.ts';

export const tokenHash = (token: string): string => crypto.createHash('sha256').update(token).digest('hex');

/** A connector token, printed once and never stored. 32 bytes: it is the whole credential. */
export const mintToken = (): string => crypto.randomBytes(32).toString('base64url');

interface Entry {
  gsc: GSC;
  at: number;
}

export interface TenantsOptions {
  /** Tool calls a minute, per ACCOUNT. The threat is an agent loop, not a stolen URL. */
  maxCallsPerMinute?: number;
  /** How long a built client is reused. See the note on the cache. */
  ttlMs?: number;
  maxEntries?: number;
}

/**
 * How stale the deployment-wide write switch may be on a call already in flight. Short, because
 * the value it caches is a permission; not zero, because it is read on every tool call.
 */
const SETTINGS_TTL_MS = 15_000;

export class Tenants {
  private readonly cfg: Config;
  private readonly db: Db;
  private readonly oauth: GoogleOAuth;
  private readonly masterKey: string;
  private readonly log: pino.Logger;
  private readonly maxCalls: number;
  private readonly ttlMs: number;
  private readonly maxEntries: number;
  readonly store: Store;

  /**
   * Built clients, by account.
   *
   * NOT an optimisation — a correctness fix. googleapis' OAuth2 client caches its access token on
   * the instance, so a fresh instance per request means a round trip to Google's token endpoint
   * before EVERY tool call: one extra second of latency each time, and a self-inflicted rate limit
   * on a busy connector. Reusing the client for a few minutes means one token exchange per hour,
   * which is what the access token's lifetime was for.
   *
   * Bounded and swept, because an unbounded map keyed by account id is a memory leak with extra
   * steps, and dropped on revoke/delete so a withdrawn credential cannot outlive its row.
   */
  private readonly cache = new Map<string, Entry>();

  /**
   * The deployment-wide write switch, cached briefly.
   *
   * Read on every tool call, so a round trip per call would put a query on the hottest path in the
   * process for a value that changes perhaps twice in a deployment's life. The TTL is short, and
   * the operator panel calls forgetSettings() the moment it toggles, so the delay is zero for the
   * person who flipped it and at most SETTINGS_TTL_MS for a call already in flight.
   *
   * Cached as the VALUE, not the promise: a failed read must not be remembered as false for the
   * next fifteen seconds, it must be retried.
   */
  private settings: { at: number; allowWrite: boolean } | null = null;

  constructor(cfg: Config, db: Db, oauth: GoogleOAuth, log: pino.Logger, masterKey: string, opts: TenantsOptions = {}) {
    this.cfg = cfg;
    this.db = db;
    this.oauth = oauth;
    this.masterKey = masterKey;
    this.log = log;
    this.maxCalls = opts.maxCallsPerMinute ?? Number(process.env.MAX_CALLS_PER_MINUTE || 120);
    this.ttlMs = opts.ttlMs ?? 5 * 60_000;
    this.maxEntries = opts.maxEntries ?? 500;
    this.store = new Store(db);
  }

  /** Called by the operator panel the moment it toggles, so the switch appears to take effect now. */
  forgetSettings(): void {
    this.settings = null;
  }

  /**
   * Fails CLOSED. A database that cannot answer is not permission to write, and the only way to
   * reach that branch is a real outage — in which case every tool call is failing anyway.
   */
  private async globalAllowWrite(): Promise<boolean> {
    const hit = this.settings;
    if (hit && Date.now() - hit.at < SETTINGS_TTL_MS) return hit.allowWrite;
    try {
      const allowWrite = (await this.db.getSettings()).allow_write;
      this.settings = { at: Date.now(), allowWrite };
      return allowWrite;
    } catch (e) {
      this.log.error({ err: String(e instanceof Error ? e.message : e) }, 'could not read the write switch; refusing writes');
      return false;
    }
  }

  /** Drop a cached client — after a revocation, a delete, or fresh consent replacing the token. */
  forget(accountId: string): void {
    this.cache.delete(accountId);
  }

  private sweep(): void {
    const cutoff = Date.now() - this.ttlMs;
    for (const [id, e] of this.cache) if (e.at < cutoff) this.cache.delete(id);
    // A sweep by age alone cannot bound a map that is churning faster than the TTL, so the oldest
    // go too once it is over the ceiling. Map preserves insertion order, which is good enough.
    while (this.cache.size > this.maxEntries) {
      const oldest = this.cache.keys().next().value;
      if (oldest === undefined) break;
      this.cache.delete(oldest);
    }
  }

  /**
   * A client for an account the caller already owns, bypassing the token lookup.
   *
   * The dashboard needs this to show which properties a fresh consent actually grants — a list that
   * must be asked of Google live, because it is exactly what the user is about to choose from and a
   * stale one would offer a property the credential cannot read. It shares the same cache as
   * resolve(), so opening the dashboard does not cost an extra token exchange.
   *
   * It takes an Account the caller fetched under a user id, so the ownership check has already
   * happened; there is no path from a request parameter to this method.
   */
  async clientFor(account: { id: string; quota_project: string | null }): Promise<GSC | null> {
    const hit = this.cache.get(account.id);
    if (hit && Date.now() - hit.at < this.ttlMs) return hit.gsc;

    const sealed = await this.db.getSecret(account.id);
    if (!sealed) return null;
    let refreshToken: string;
    try {
      refreshToken = unseal(this.masterKey, account.id, sealed);
    } catch (e) {
      this.log.error({ account: account.id, err: String(e instanceof Error ? e.message : e) }, 'could not unseal a tenant credential');
      return null;
    }
    const gsc = new GoogleGSC(this.cfg, {
      clientId: this.cfg.clientId,
      clientSecret: this.cfg.clientSecret,
      refreshToken,
      // NOT `|| this.cfg.quotaProject`. See the note on TenantCreds.quotaProject in gsc.ts: the
      // operator's project is exactly the wrong default, because the header asserts that the
      // TENANT may consume quota there.
      quotaProject: account.quota_project || '',
    });
    this.cache.set(account.id, { gsc, at: Date.now() });
    this.sweep();
    return gsc;
  }

  async resolve(token: string): Promise<McpResolution> {
    if (!token) return null;
    const row = await this.db.connectorByToken(tokenHash(token));

    // No such token, revoked, or its account is on its way out. All three are 404 — a distinguishable
    // answer would tell whoever holds a dead URL which of those happened, and the owner cannot act
    // on any of it anyway.
    if (!row) return null;

    const { account, sealed, token_id } = row;

    if (!sealed || account.status === 'pending') {
      return { unavailable: 'This connector is not finished: its Google account has not been connected yet. Open the dashboard and connect it.' };
    }
    if (account.status === 'revoked') {
      // Distinct from 404 on purpose: the URL is valid and the owner can fix this, which is not
      // true of a revoked token.
      return { unavailable: 'Google has withdrawn this connection. Reconnect the Google account in the dashboard — the connector URL itself stays the same.' };
    }
    // "No property" and "every property" are different accounts, and only the first is unfinished.
    // all_properties is what tells them apart — see db/005_all_properties.sql.
    if (!account.property && !account.all_properties) {
      return { unavailable: 'This connector has no Search Console property selected yet. Choose one in the dashboard, or set it to all properties.' };
    }

    // Counted per account rather than per token: several tokens on one account share one quota,
    // because Google's rate limit is per project and the account is what maps onto it.
    const recent = await this.db.callsInLastMinute(account.id);
    if (recent >= this.maxCalls) {
      return { tooMany: `This connector has made ${recent} calls in the last minute, which is its ceiling. Slow down and try again shortly.`, retryAfter: 30 };
    }

    let gsc: GSC;
    const hit = this.cache.get(account.id);
    if (hit && Date.now() - hit.at < this.ttlMs) {
      gsc = hit.gsc;
    } else {
      let refreshToken: string;
      try {
        refreshToken = unseal(this.masterKey, account.id, sealed);
      } catch (e) {
        // Almost always a MASTER_KEY that changed, which is a deployment error rather than a
        // tenant's problem — so it is logged for the operator and reported as unavailable, never
        // as "your connection is broken".
        this.log.error({ account: account.id, err: String(e instanceof Error ? e.message : e) }, 'could not unseal a tenant credential');
        return { unavailable: 'This connector cannot be opened right now. The operator has been notified.' };
      }
      gsc = new GoogleGSC(this.cfg, {
        clientId: this.cfg.clientId,
        clientSecret: this.cfg.clientSecret,
        refreshToken,
        // Only what the row explicitly says, never the operator's own project — see clientFor.
        quotaProject: account.quota_project || '',
      });
      this.cache.set(account.id, { gsc, at: Date.now() });
      this.sweep();
    }

    // Not awaited: a usage row and a timestamp must never delay or fail a tool call. Both are
    // nice-to-have telemetry, and the connector working is not.
    void this.db.touchToken(token_id).catch(() => undefined);

    const globalWrite = await this.globalAllowWrite();

    const ctx: Ctx = {
      // defaultSite: the account's property, so tools can be called with no siteUrl and the
      // instructions can name it — how the siblings read as bound to one account rather than to a
      // service. EMPTY when the account is set to all properties, which makes tools.ts require
      // every call to name its own. Never a restriction either way: no tool filters by it, so this
      // only decides what a call means when it does not say.
      //
      // allowWrite: TWO SWITCHES, BOTH REQUIRED — the deployment's, set in the operator panel, and
      // the account's own. One switch would mean enabling writes for yourself enabled them for
      // every tenant, and the blast radius is somebody's property being removed from Search
      // Console by an agent that misread a sentence.
      //
      // NOT cfg.allowWrite. GSC_ALLOW_WRITE governs the OPERATOR connector, which has no database
      // to read a setting from — and while one variable governed both, arming your own connector
      // silently armed the tenant-side server switch too. A tenant controls their own allow_write
      // from their dashboard, so that combination let a tenant grant themselves writes the
      // operator never intended.
      cfg: { ...this.cfg, defaultSite: account.property ?? '', allowWrite: globalWrite && account.allow_write },
      gsc,
      // The mirror is keyed by account, so it only exists on this surface. The single-account
      // server has no database and no account id, and asks Google every time.
      mirror: { store: this.store, accountId: account.id },
      onCall: (call) => {
        void this.db.recordCall(account.id, call).catch((e) => this.log.error({ err: String(e) }, 'could not record a tool call'));
      },
    };
    return ctx;
  }

  /**
   * One pass of the backfill, across every connected account.
   *
   * The budget is per account and small on purpose: Search Console's quota is per PROJECT and
   * shared by every tenant here, so one account's first backfill — which is sixteen months, close
   * to five hundred calls — must not be able to spend all of it. Sixteen months at this budget
   * takes a few hours of passes, and the days that matter are fetched first because backfill()
   * walks newest-first.
   */
  async syncPass(dims = 'query', perAccount = 10): Promise<{ accounts: number; days: number; remaining: number }> {
    const accounts = await this.db.connectedAccounts();
    const to = this.store.earliestFetchable();
    let days = 0;
    let remaining = 0;
    let touched = 0;

    for (const a of accounts) {
      if (!a.property) continue;
      const gsc = await this.clientFor(a);
      if (!gsc) continue;
      try {
        // Ends five days back rather than today: a day inside the lag window would be stored
        // provisional and immediately re-fetched, spending quota to learn nothing.
        const end = new Date(Date.now() - 5 * 86400000).toISOString().slice(0, 10);
        const r = await this.store.backfill(a.id, gsc, a.property, dims, to, end, perAccount);
        days += r.days;
        remaining += r.remaining;
        if (r.days) touched++;
      } catch (e) {
        // One account's credential failing must not stop the sweep for everyone else. It is
        // already recorded on the row by the tool path; here it is only logged.
        this.log.warn({ account: a.id, err: String(e instanceof Error ? e.message : e) }, 'backfill failed for one account');
      }
    }
    return { accounts: touched, days, remaining };
  }

  /**
   * End a tenant's Google grant, then finish the delete. Called by the reaper for any row that
   * beginDelete tombstoned — including one whose previous attempt died halfway, which is why
   * revoke() treats an already-forgotten token as success.
   */
  async reap(limit = 25): Promise<number> {
    const pending = await this.db.pendingDeletes(limit);
    let done = 0;
    for (const { id, sealed, googleEmail } of pending) {
      try {
        if (sealed) {
          const refreshToken = unseal(this.masterKey, id, sealed);
          // Google's /revoke ends the GRANT for a (client, Google account) pair, not one token —
          // so revoking for this deleted connection would also kill every other connection the
          // same Google account has here, and the operator's own connector when it runs as that
          // account. Withdrawing the grant is still the right thing when this was the last one,
          // which is what the count asks. When it is not, the sealed row is dropped and the token
          // is simply abandoned: nothing here can reach it any more, and it expires on its own.
          const shared = googleEmail ? await this.db.otherLiveAccountsFor(googleEmail, id) : 0;
          if (shared > 0) {
            this.log.info({ account: id, shared }, 'not revoking: this Google account still has other connections here');
          } else {
            await this.oauth.revoke(refreshToken);
          }
          await this.db.dropSecret(id);
        }
        await this.db.finishDelete(id);
        this.forget(id);
        done++;
      } catch (e) {
        // Left for the next pass rather than dropped: the row stays tombstoned, its tokens stay
        // revoked, and the only thing outstanding is the call to Google.
        this.log.error({ account: id, err: String(e instanceof Error ? e.message : e) }, 'could not finish deleting an account — will retry');
      }
    }
    return done;
  }
}
