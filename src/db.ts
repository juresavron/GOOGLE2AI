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

const ACCOUNT_COLS = 'a.id, a.user_id, a.label, a.google_email, a.property, a.quota_project, a.status, a.last_checked_at, a.last_error, a.created_at';

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
