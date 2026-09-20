// Every statement this server runs. Nothing else in the codebase writes SQL.
//
// It takes a Queryable rather than a pg.Pool so the suite can drive every path against a fake with
// no database running — the arrangement both siblings use. scripts/check-sql.py then parses db/*.sql
// with Postgres's own grammar, because a fake will happily accept a query string Postgres would not.
//
// THE RULE THAT HOLDS THIS FILE TOGETHER: a statement reachable from a signed-in user takes
// `userId` and joins on it, in the same statement. Not "look it up, check the owner, then write" —
// one statement, so there is no window between the check and the write and no path where a caller
// forgets the check. The RLS policies in db/schema.sql say the same thing a second time, for the
// PostgREST surface this code does not go through; the server connects as the service role, which
// bypasses RLS entirely, so these joins are the real enforcement for everything here.
import type { Sealed } from './secrets.ts';

export interface QueryResult {
  rows: Record<string, any>[];
  rowCount: number | null;
}
export interface Queryable {
  query(text: string, values?: unknown[]): Promise<QueryResult>;
}

export type AccountStatus = 'pending' | 'connected' | 'failing' | 'revoked';

export interface Account {
  id: string;
  user_id: string;
  label: string;
  google_email: string | null;
  property: string | null;
  quota_project: string | null;
  status: AccountStatus;
  /** AND-ed with the server-wide cfg.allowWrite in tenants.ts. Both must be true. */
  allow_write: boolean;
  last_checked_at: Date | null;
  last_error: string | null;
  created_at: Date;
}

/** What the connector route needs, in one round trip: who this token is, and the sealed credential. */
export interface Connector {
  account: Account;
  sealed: Sealed | null;
  token_id: string;
}

export interface TokenRow {
  id: string;
  label: string | null;
  created_at: Date;
  last_used_at: Date | null;
  revoked_at: Date | null;
}

const ACCOUNT_COLS = 'a.id, a.user_id, a.label, a.google_email, a.property, a.quota_project, a.status, a.allow_write, a.last_checked_at, a.last_error, a.created_at';

export class Db {
  // Written out rather than a `private readonly q` constructor parameter: parameter properties are
  // not erasable syntax, and this project runs its TypeScript through Node's type stripping, which
  // rejects anything that would need a transform. tsconfig's erasableSyntaxOnly catches it at
  // typecheck rather than at boot.
  private readonly q: Queryable;

  constructor(q: Queryable) {
    this.q = q;
  }

  // ---------------------------------------------------------------- the connector hot path

  /**
   * Resolve a connector token to its account and sealed credential.
   *
   * One statement on purpose — it runs on every single tool call, and splitting it would be three
   * round trips per call. The three conditions are all here and none is optional: the token must
   * not be revoked, the account must not be soft-deleted, and only the sha256 is ever compared
   * because the token itself is never stored.
   */
  async connectorByToken(tokenSha256: string): Promise<Connector | null> {
    const { rows } = await this.q.query(
      `select ${ACCOUNT_COLS}, t.id as token_id, s.sealed
         from public.mcp_tokens t
         join public.gsc_accounts a on a.id = t.account_id
         left join public.gsc_account_secrets s on s.account_id = a.id
        where t.token_sha256 = $1
          and t.revoked_at is null
          and a.deleted_at is null`,
      [tokenSha256],
    );
    const r = rows[0];
    if (!r) return null;
    const { token_id, sealed, ...account } = r;
    return { account: account as Account, sealed: (sealed as Sealed | null) ?? null, token_id: String(token_id) };
  }

  /**
   * Last-used, written without blocking the call that triggered it.
   *
   * Deliberately coarse: it only moves the timestamp when the stored one is over a minute old, so a
   * busy connector writes once a minute rather than once per tool call. The dashboard shows this to
   * the minute anyway, and a row-level write on every call is contention for nothing.
   */
  async touchToken(tokenId: string): Promise<void> {
    await this.q.query(
      `update public.mcp_tokens
          set last_used_at = now()
        where id = $1
          and (last_used_at is null or last_used_at < now() - interval '1 minute')`,
      [tokenId],
    );
  }

  /** What was called and whether it worked. Never an argument — see the note on mcp_calls. */
  async recordCall(accountId: string, call: { tool: string; ok: boolean; ms: number; code: string | null }): Promise<void> {
    await this.q.query(
      `insert into public.mcp_calls (account_id, tool, ok, duration_ms, error_code) values ($1, $2, $3, $4, $5)`,
      [accountId, call.tool, call.ok, Math.round(call.ms), call.code],
    );
  }

  /** Calls in the last minute, for the per-account ceiling. The threat is an agent loop, not theft. */
  async callsInLastMinute(accountId: string): Promise<number> {
    const { rows } = await this.q.query(
      `select count(*)::int as n from public.mcp_calls where account_id = $1 and created_at > now() - interval '1 minute'`,
      [accountId],
    );
    return Number(rows[0]?.n ?? 0);
  }

  // ---------------------------------------------------------------- accounts

  async listAccounts(userId: string): Promise<Account[]> {
    const { rows } = await this.q.query(
      `select ${ACCOUNT_COLS} from public.gsc_accounts a
        where a.user_id = $1 and a.deleted_at is null
        order by a.created_at`,
      [userId],
    );
    return rows as Account[];
  }

  /** Scoped by user_id as well as id: an account id from another tenant must read as "no such row". */
  async getAccount(userId: string, accountId: string): Promise<Account | null> {
    const { rows } = await this.q.query(
      `select ${ACCOUNT_COLS} from public.gsc_accounts a
        where a.id = $1 and a.user_id = $2 and a.deleted_at is null`,
      [accountId, userId],
    );
    return (rows[0] as Account) ?? null;
  }

  /**
   * A row before consent exists. It has no property and no credential yet — that is what `pending`
   * means, and the OAuth callback is what fills them in. Creating it first is what gives the
   * consent redirect a `state` to carry that is already bound to a user.
   */
  async createAccount(userId: string, label: string, quotaProject: string | null): Promise<Account> {
    const { rows } = await this.q.query(
      `insert into public.gsc_accounts (user_id, label, quota_project) values ($1, $2, $3) returning ${ACCOUNT_COLS.replace(/a\./g, '')}`,
      [userId, label, quotaProject],
    );
    return rows[0] as Account;
  }

  async countAccounts(userId: string): Promise<number> {
    const { rows } = await this.q.query(
      `select count(*)::int as n from public.gsc_accounts where user_id = $1 and deleted_at is null`,
      [userId],
    );
    return Number(rows[0]?.n ?? 0);
  }

  /** Renaming is the only field a user edits directly, so it is the only one with a user-scoped setter. */
  async renameAccount(userId: string, accountId: string, label: string): Promise<boolean> {
    const { rowCount } = await this.q.query(
      `update public.gsc_accounts set label = $3, updated_at = now() where id = $1 and user_id = $2 and deleted_at is null`,
      [accountId, userId, label],
    );
    return (rowCount ?? 0) > 0;
  }

  /**
   * The account's own half of the write switch. User-scoped, and a server route rather than a
   * client grant — see the note at the foot of db/schema.sql for why the column is never granted.
   */
  async setAllowWrite(userId: string, accountId: string, allow: boolean): Promise<boolean> {
    const { rowCount } = await this.q.query(
      `update public.gsc_accounts set allow_write = $3, updated_at = now() where id = $1 and user_id = $2 and deleted_at is null`,
      [accountId, userId, allow],
    );
    return (rowCount ?? 0) > 0;
  }

  /**
   * The property this connector reads. User-scoped, and the CHECK constraint in the schema is what
   * refuses a spelling the API would 403 on — enforced there rather than here so it holds for every
   * route, including ones not yet written.
   */
  async setProperty(userId: string, accountId: string, property: string): Promise<boolean> {
    const { rowCount } = await this.q.query(
      `update public.gsc_accounts set property = $3, updated_at = now() where id = $1 and user_id = $2 and deleted_at is null`,
      [accountId, userId, property],
    );
    return (rowCount ?? 0) > 0;
  }

  /**
   * Server-written, so no userId: this is called from the OAuth callback and from the health probe,
   * neither of which is acting on behalf of a browser session. `last_error` is operator-facing and
   * never rendered to a tenant — the dashboard reads gsc_account_status, which excludes it.
   */
  async setStatus(accountId: string, status: AccountStatus, opts: { error?: string | null; googleEmail?: string | null } = {}): Promise<void> {
    await this.q.query(
      `update public.gsc_accounts
          set status = $2,
              last_error = $3,
              google_email = coalesce($4, google_email),
              last_checked_at = now(),
              updated_at = now()
        where id = $1`,
      [accountId, status, opts.error ?? null, opts.googleEmail ?? null],
    );
  }

  // ---------------------------------------------------------------- the credential

  async setSecret(accountId: string, sealed: Sealed): Promise<void> {
    await this.q.query(
      `insert into public.gsc_account_secrets (account_id, sealed, updated_at) values ($1, $2, now())
         on conflict (account_id) do update set sealed = excluded.sealed, updated_at = now()`,
      [accountId, JSON.stringify(sealed)],
    );
  }

  async getSecret(accountId: string): Promise<Sealed | null> {
    const { rows } = await this.q.query(`select sealed from public.gsc_account_secrets where account_id = $1`, [accountId]);
    return (rows[0]?.sealed as Sealed) ?? null;
  }

  /** Dropped the moment Google rejects the grant for good, so a dead token is not kept around. */
  async dropSecret(accountId: string): Promise<void> {
    await this.q.query(`delete from public.gsc_account_secrets where account_id = $1`, [accountId]);
  }

  // ---------------------------------------------------------------- deletion

  /**
   * Step one of two. The row is tombstoned and its tokens are revoked immediately — so the
   * connector stops working the instant the user asks — but the Google grant is still live at this
   * point. finishDelete() runs after it has been revoked at Google.
   *
   * Two steps rather than one because the revocation is a network call to somebody else's service:
   * doing it inside the delete means a Google outage either blocks the delete or silently leaves a
   * live credential belonging to a row that no longer exists.
   */
  async beginDelete(userId: string, accountId: string): Promise<boolean> {
    const { rowCount } = await this.q.query(
      `update public.gsc_accounts set deleted_at = now(), updated_at = now()
        where id = $1 and user_id = $2 and deleted_at is null`,
      [accountId, userId],
    );
    if ((rowCount ?? 0) === 0) return false;
    await this.q.query(`update public.mcp_tokens set revoked_at = now() where account_id = $1 and revoked_at is null`, [accountId]);
    return true;
  }

  /** Step two: the grant is gone at Google, so the sealed token and the row can go. */
  async finishDelete(accountId: string): Promise<void> {
    await this.q.query(`delete from public.gsc_accounts where id = $1 and deleted_at is not null`, [accountId]);
  }

  /**
   * Interrupted deletes, for the reaper. A row with deleted_at set and a secret still present is a
   * live Google grant with no owner and no UI to revoke it — the thing whatsapp2ai's schema note 3
   * warns about, in this product's costume.
   */
  async pendingDeletes(limit = 50): Promise<{ id: string; sealed: Sealed | null }[]> {
    const { rows } = await this.q.query(
      `select a.id, s.sealed
         from public.gsc_accounts a
         left join public.gsc_account_secrets s on s.account_id = a.id
        where a.deleted_at is not null
        order by a.deleted_at
        limit $1`,
      [limit],
    );
    return rows.map((r) => ({ id: String(r.id), sealed: (r.sealed as Sealed | null) ?? null }));
  }

  // ---------------------------------------------------------------- connector tokens

  /**
   * Store the hash of a freshly minted token. The token itself is returned to the caller once, put
   * into a URL, and never stored anywhere — which is why a lost connector URL is reissued rather
   * than looked up.
   */
  async addToken(userId: string, accountId: string, tokenSha256: string, label: string | null): Promise<boolean> {
    // The select-with-user_id inside the insert is what scopes this: an account id belonging to
    // another tenant selects no row, so the insert writes nothing rather than minting them a token.
    const { rowCount } = await this.q.query(
      `insert into public.mcp_tokens (account_id, token_sha256, label)
       select a.id, $3, $4 from public.gsc_accounts a
        where a.id = $1 and a.user_id = $2 and a.deleted_at is null`,
      [accountId, userId, tokenSha256, label],
    );
    return (rowCount ?? 0) > 0;
  }

  async listTokens(userId: string, accountId: string): Promise<TokenRow[]> {
    const { rows } = await this.q.query(
      `select t.id, t.label, t.created_at, t.last_used_at, t.revoked_at
         from public.mcp_tokens t
         join public.gsc_accounts a on a.id = t.account_id
        where t.account_id = $1 and a.user_id = $2
        order by t.created_at`,
      [accountId, userId],
    );
    return rows as TokenRow[];
  }

  /**
   * One-way. `revoked_at is null` in the WHERE is not redundant: without it, re-revoking would move
   * the timestamp, and imap2ai's version of this bug was worse — a grant that let a client write the
   * column made revocation a toggle, because an UPDATE policy constrains which ROW you may write,
   * never which VALUE.
   */
  async revokeToken(userId: string, tokenId: string): Promise<boolean> {
    const { rowCount } = await this.q.query(
      `update public.mcp_tokens t set revoked_at = now()
         from public.gsc_accounts a
        where t.id = $1 and a.id = t.account_id and a.user_id = $2 and t.revoked_at is null`,
      [tokenId, userId],
    );
    return (rowCount ?? 0) > 0;
  }

  /** Accounts the backfill sweep should work on: connected, with a property, not deleted. */
  async connectedAccounts(limit = 100): Promise<Account[]> {
    const { rows } = await this.q.query(
      `select ${ACCOUNT_COLS} from public.gsc_accounts a
        where a.deleted_at is null and a.status = 'connected' and a.property is not null
        order by a.created_at limit $1`,
      [limit],
    );
    return rows as Account[];
  }

  // ---------------------------------------------------------------- the mirror

  /**
   * Write one day's grouped rows, then record that the day was fetched.
   *
   * TWO STATEMENTS, NO TRANSACTION, AND THE ORDER IS THE CORRECTNESS ARGUMENT.
   *
   * This was written as begin / insert-per-row / commit, which was wrong in a way a fake Queryable
   * cannot show: `pg.Pool.query()` checks out a connection PER CALL. The BEGIN therefore lands on
   * one connection and is handed straight back to the pool still inside a transaction, the inserts
   * land on whichever connections they get, and the COMMIT on another — so nothing was atomic, and
   * a pooled connection was left permanently mid-transaction for the next unrelated query to
   * inherit. A real transaction needs a checked-out client, which this interface deliberately does
   * not expose.
   *
   * It does not need one. The rows go in ONE multi-row upsert, and a single statement is atomic by
   * itself; the sync marker follows as a second. A failure between them leaves the day unmarked, so
   * it is simply re-fetched and re-upserted next pass — harmless. The reverse order is the one that
   * breaks: a marker written before its rows says "synced" for a day that would then read as empty
   * forever, which is exactly the lie gsc_sync exists to prevent.
   *
   * ON CONFLICT rather than delete-then-insert because (account, day, dims, keys) is the primary
   * key, so re-syncing a provisional day rewrites exactly the rows it returns.
   */
  async putDay(
    accountId: string,
    dims: string,
    day: string,
    rows: { keys: string[]; clicks: number; impressions: number; position: number }[],
    final: boolean,
  ): Promise<void> {
    if (rows.length) {
      // Carried as one JSON payload rather than N placeholders: the row count is Google's to
      // choose (up to 25000), and building a parameter list that long is both slower and closer to
      // Postgres's 65535-parameter ceiling than anything here should be.
      const payload = JSON.stringify(
        rows.map((r) => ({ keys: r.keys, clicks: Math.round(r.clicks), impressions: Math.round(r.impressions), position: r.position })),
      );
      await this.q.query(
        `insert into public.gsc_rows (account_id, day, dims, keys, clicks, impressions, position)
         select $1, $2::date, $3, r.keys, r.clicks, r.impressions, r.position
           from jsonb_to_recordset($4::jsonb) as r(keys text[], clicks int, impressions int, position real)
         on conflict (account_id, day, dims, keys)
         do update set clicks = excluded.clicks, impressions = excluded.impressions, position = excluded.position`,
        [accountId, day, dims, payload],
      );
    }
    await this.q.query(
      `insert into public.gsc_sync (account_id, day, dims, rows, final, synced_at)
       values ($1, $2, $3, $4, $5, now())
       on conflict (account_id, day, dims)
       do update set rows = excluded.rows, final = excluded.final, synced_at = now()`,
      [accountId, day, dims, rows.length, final],
    );
  }

  /**
   * Which days in a range have been fetched, and which of those are settled.
   *
   * `synced` counts fetches, not rows: a day with genuinely zero impressions is synced and empty,
   * and treating it as missing would re-fetch it forever. That distinction is the whole reason
   * gsc_sync exists separately from gsc_rows.
   */
  async coverage(accountId: string, dims: string, from: string, to: string): Promise<{ synced: number; final: number }> {
    const { rows } = await this.q.query(
      `select count(*)::int as synced, count(*) filter (where final)::int as final
         from public.gsc_sync
        where account_id = $1 and dims = $2 and day between $3::date and $4::date`,
      [accountId, dims, from, to],
    );
    return { synced: Number(rows[0]?.synced ?? 0), final: Number(rows[0]?.final ?? 0) };
  }

  /** The days in a range that still need fetching: never synced, or synced while still provisional. */
  async daysToSync(accountId: string, dims: string, from: string, to: string, limit: number): Promise<string[]> {
    const { rows } = await this.q.query(
      `select to_char(d.day, 'YYYY-MM-DD') as day
         from generate_series($3::date, $4::date, interval '1 day') as d(day)
         left join public.gsc_sync s
           on s.account_id = $1 and s.dims = $2 and s.day = d.day
        where s.day is null or not s.final
        order by d.day desc
        limit $5`,
      [accountId, dims, from, to, limit],
    );
    return rows.map((r) => String(r.day));
  }

  /**
   * How many days in a range still need fetching. Unlimited, unlike daysToSync.
   *
   * Its own query because backfill cannot infer this from the page it fetched: asking for
   * `budget + 1` days can only ever distinguish "done" from "at least one more", so reporting
   * progress from it would say "1 day remaining" with four hundred outstanding. A first backfill
   * runs for days, and a progress number that lies about that is worse than none.
   */
  async countDaysToSync(accountId: string, dims: string, from: string, to: string): Promise<number> {
    const { rows } = await this.q.query(
      `select count(*)::int as n
         from generate_series($3::date, $4::date, interval '1 day') as d(day)
         left join public.gsc_sync s
           on s.account_id = $1 and s.dims = $2 and s.day = d.day
        where s.day is null or not s.final`,
      [accountId, dims, from, to],
    );
    return Number(rows[0]?.n ?? 0);
  }

  /**
   * Read the mirror for a range, re-grouped across days.
   *
   * Position is averaged weighted by impressions, the same way Search Console does it and the same
   * way tools.ts does — a plain mean over days lets a day with nine impressions at position 2
   * outweigh one with nine thousand at position 30.
   */
  async readMirror(
    accountId: string,
    dims: string,
    from: string,
    to: string,
    limit: number,
  ): Promise<{ keys: string[]; clicks: number; impressions: number; position: number }[]> {
    const { rows } = await this.q.query(
      `select keys,
              sum(clicks)::int as clicks,
              sum(impressions)::int as impressions,
              case when sum(impressions) > 0
                   then sum(position::numeric * impressions) / sum(impressions)
                   else 0 end as position
         from public.gsc_rows
        where account_id = $1 and dims = $2 and day between $3::date and $4::date
        group by keys
        order by clicks desc, impressions desc
        limit $5`,
      [accountId, dims, from, to, limit],
    );
    return rows.map((r) => ({
      keys: (r.keys as string[]) ?? [],
      clicks: Number(r.clicks),
      impressions: Number(r.impressions),
      position: Number(r.position),
    }));
  }

  /** What the mirror holds for an account, for status() and the dashboard. */
  async mirrorStats(accountId: string): Promise<{ dims: string; days: number; rows: number; oldest: string | null; newest: string | null }[]> {
    const { rows } = await this.q.query(
      `select dims,
              count(*)::int as days,
              coalesce(sum(rows), 0)::int as rows,
              to_char(min(day), 'YYYY-MM-DD') as oldest,
              to_char(max(day), 'YYYY-MM-DD') as newest
         from public.gsc_sync
        where account_id = $1
        group by dims order by dims`,
      [accountId],
    );
    return rows as { dims: string; days: number; rows: number; oldest: string | null; newest: string | null }[];
  }

  // ---------------------------------------------------------------- the operator panel

  /**
   * Every account on the deployment, for the ADMIN_EMAILS-gated panel.
   *
   * This one is NOT user-scoped, and it is the only read in this file that is not — which is
   * exactly why it is down here under its own heading rather than mixed in with the rest. The gate
   * is in the route, checked server-side on every request, and `adminEmails` empty means nobody.
   * `last_error` is included because the panel exists to answer "why is this customer's connector
   * broken", which is the one question the tenant dashboard deliberately cannot show.
   */
  async allAccounts(limit = 200): Promise<(Account & { tokens: number; calls_24h: number })[]> {
    const { rows } = await this.q.query(
      `select ${ACCOUNT_COLS},
              (select count(*)::int from public.mcp_tokens t where t.account_id = a.id and t.revoked_at is null) as tokens,
              (select count(*)::int from public.mcp_calls c where c.account_id = a.id and c.created_at > now() - interval '24 hours') as calls_24h
         from public.gsc_accounts a
        where a.deleted_at is null
        order by a.created_at desc
        limit $1`,
      [limit],
    );
    return rows as (Account & { tokens: number; calls_24h: number })[];
  }

  /** Deployment-wide totals. Counts only — the panel shows names in the table above, not here. */
  async totals(): Promise<{ accounts: number; connected: number; tokens: number; calls_24h: number; errors_24h: number }> {
    const { rows } = await this.q.query(
      `select
         (select count(*)::int from public.gsc_accounts where deleted_at is null) as accounts,
         (select count(*)::int from public.gsc_accounts where deleted_at is null and status = 'connected') as connected,
         (select count(*)::int from public.mcp_tokens where revoked_at is null) as tokens,
         (select count(*)::int from public.mcp_calls where created_at > now() - interval '24 hours') as calls_24h,
         (select count(*)::int from public.mcp_calls where created_at > now() - interval '24 hours' and not ok) as errors_24h`,
    );
    return rows[0] as { accounts: number; connected: number; tokens: number; calls_24h: number; errors_24h: number };
  }

  /**
   * What is going wrong across the deployment, by error code. Codes only — src/tools.ts errorCode()
   * is a closed vocabulary precisely so this panel can be useful without becoming a second copy of
   * anybody's search traffic.
   */
  async errorBreakdown(hours = 24): Promise<{ error_code: string; n: number }[]> {
    const { rows } = await this.q.query(
      `select coalesce(error_code, 'unknown') as error_code, count(*)::int as n
         from public.mcp_calls
        where not ok and created_at > now() - make_interval(hours => $1)
        group by 1 order by n desc limit 20`,
      [hours],
    );
    return rows as { error_code: string; n: number }[];
  }

  // ---------------------------------------------------------------- usage, for the dashboard

  async recentCalls(userId: string, accountId: string, limit = 20): Promise<Record<string, any>[]> {
    const { rows } = await this.q.query(
      `select c.tool, c.ok, c.duration_ms, c.error_code, c.created_at
         from public.mcp_calls c
         join public.gsc_accounts a on a.id = c.account_id
        where c.account_id = $1 and a.user_id = $2
        order by c.created_at desc
        limit $3`,
      [accountId, userId, limit],
    );
    return rows;
  }
}
