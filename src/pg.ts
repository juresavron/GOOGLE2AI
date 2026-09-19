// Getting a usable Postgres connection, and being honest about it when there isn't one.
//
// Ported from whatsapp2ai's src/pg.ts essentially unchanged, because every rule in it is about
// Supabase and Postgres rather than about WhatsApp: which roots to trust, how to report a failure a
// human can act on, and when to try again. Only the probe table and the migration filenames differ.
//
// The IPv6 check in validateDatabaseUrl() is the one to read first if a deploy cannot reach the
// database: Supabase's direct host publishes only an AAAA record, and Fly has no public IPv6 egress.
import type pino from 'pino';
import { Db } from './db.ts';
import { SUPABASE_ROOT_CA, isSupabaseHost } from './supabase-ca.ts';

export interface DbHealth {
  /** Complaints about the URL itself, found without opening a socket. */
  problems(): string[];
  /** True once a query has actually succeeded against the expected schema. */
  ready(): boolean;
  /**
   * Run this when the database is usable: now if it already is, and again each time it comes back
   * after a failure. Registering late is the normal case, not a missed event — see readyLatch.
   */
  onReady(cb: () => void): void;
  /** The last failure, for operators. Never rendered to a browser. */
  error(): string | null;
  stop(): void;
}

/**
 * Callbacks that must run when something becomes ready, INCLUDING those registered after it already
 * did. This exists because the obvious shape — pass an onReady callback to connectPg — cost every
 * WhatsApp session on the machine:
 *
 *   pgHandle = await connectPg(url, log, { onReady: () => supervisor?.bootAll() });
 *   supervisor = new Supervisor(...);
 *
 * connectPg pings before it returns, so on a reachable database onReady fired while `supervisor` was
 * still null, and the `?.` swallowed it. Sessions then started only if the FIRST ping had failed —
 * meaning a healthy deployment was the case that silently came back with no WhatsApp sessions at all,
 * and the failure was invisible until someone called a tool.
 *
 * A latch cannot be registered too late: if it has already fired, registering runs the callback.
 */
export function readyLatch(onError?: (e: unknown) => void) {
  const waiting: Array<() => void> = [];
  let open = false;
  const run = (cb: () => void) => {
    try {
      cb();
    } catch (e) {
      onError?.(e);
    }
  };
  return {
    /** Ready again. Fires every registered callback; a second call while already open does nothing. */
    open(): void {
      if (open) return;
      open = true;
      for (const cb of waiting) run(cb);
    },
    /** Not ready any more — the next open() fires the callbacks again. */
    close(): void {
      open = false;
    },
    on(cb: () => void): void {
      waiting.push(cb);
      if (open) run(cb);
    },
  };
}

export interface PgHandle {
  db: Db;
  health: DbHealth;
  close(): Promise<void>;
}

const truthy = (v: string | undefined) => /^(1|true|yes|on)$/i.test(v || '');

/** Postgres on the same machine needs no TLS, and demanding it would just fail. */
const isLocal = (url: string) => /@(localhost|127\.0\.0\.1|\[::1\])[:/]/.test(url);

/**
 * Turn a driver error into the thing to actually go and do. These four cover every failure this
 * project has hit, and each is indistinguishable from the others if you only see "an empty dashboard".
 */
export function diagnose(message: string): string {
  if (/does not exist|relation/i.test(message))
    return 'The connection works but the schema is missing — apply db/schema.sql in the Supabase SQL editor.';
  if (/password authentication|SASL|SCRAM/i.test(message))
    return 'Wrong password. Supabase copies its URI with a [YOUR-PASSWORD] placeholder that has to be replaced.';
  if (/self.signed|certificate|CERT/i.test(message))
    return "The database certificate could not be verified. Supabase's own root is bundled, so this usually means DATABASE_URL points somewhere else — or set DATABASE_CA to the right CA.";
  if (/ENETUNREACH|EHOSTUNREACH/i.test(message))
    // Supabase's direct host (db.<ref>.supabase.co) publishes ONLY an AAAA record, and a network
    // without public IPv6 egress cannot reach it at all. The pooler host is IPv4-only, so it works
    // from anywhere — which is why it is the recommendation rather than a workaround.
    return 'The database host is IPv6-only and this network has no IPv6 route to it. Use the Session pooler connection string (Project Settings → Database → Session pooler); its host is IPv4.';
  if (/ENOTFOUND|EAI_AGAIN|ECONNREFUSED|timeout|ETIMEDOUT/i.test(message))
    return 'Host unreachable. Use the connection string from Supabase → Project Settings → Database — the Session pooler tab if the direct host does not resolve.';
  return 'Check DATABASE_URL.';
}

/**
 * Complaints about the connection string itself, found before a socket is opened.
 *
 * Every one of these has cost this project a deploy cycle, and none of them produces an error that
 * names its own cause: the direct host fails as ENETUNREACH, the wrong pooler user fails as a
 * password error, and an unreplaced placeholder fails as a password error too.
 */
export function validateDatabaseUrl(url: string): string[] {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return ['DATABASE_URL is not a valid URL. It should start with postgresql:// and end with /postgres.'];
  }

  const problems: string[] = [];
  const host = u.hostname;
  const user = decodeURIComponent(u.username);
  const pass = decodeURIComponent(u.password);
  const ref = /^db\.([a-z0-9]+)\.supabase\.co$/.exec(host)?.[1];

  // The big one. db.<ref>.supabase.co has an AAAA record and no A record, so a host without public
  // IPv6 egress — Fly, among others — cannot reach it at all, whatever the credentials say.
  if (ref) {
    problems.push(
      `This is Supabase's DIRECT host, which is IPv6-only. Hosts without public IPv6 egress (Fly is one) ` +
        `cannot reach it at all. Use the Session pooler string instead: Supabase → Project Settings → ` +
        `Database → Connection string → Session pooler. Its username will be "postgres.${ref}".`,
    );
  }

  // Supavisor identifies the project from the username, so plain "postgres" reaches no tenant and is
  // reported as an authentication failure — which sends people looking at the password.
  if (host.includes('pooler.supabase.com') && !user.includes('.')) {
    problems.push(
      `The pooler needs the project ref in the username — "postgres.<your-project-ref>", not "${user}". ` +
        `Copy the whole URI from the Session pooler tab rather than editing the host by hand.`,
    );
  }

  // Supabase copies its URI with the password as a literal placeholder.
  if (/\[|\]|YOUR-PASSWORD/i.test(pass) || pass === '') {
    problems.push('The password is still a placeholder (or empty). Replace [YOUR-PASSWORD], square brackets and all.');
  }

  // Transaction mode recycles the connection per statement, which a long-lived pool does not want.
  if (u.port === '6543') {
    problems.push('Port 6543 is the TRANSACTION pooler. This server holds a connection pool, so use the SESSION pooler on port 5432.');
  }

  if (u.pathname.replace(/^\//, '') === '') {
    problems.push('No database name in the URL — it should end with /postgres.');
  }

  return problems;
}

/**
 * TLS settings for a connection string.
 *
 * The rule that matters: Supabase's root is added ALONGSIDE the public roots, never instead of them.
 * Node's `ca` option REPLACES the default store, so bundling only Supabase's root fixes the direct
 * host and breaks the pooler host, whose certificate is ordinary and publicly signed.
 */
export function sslFor(url: string, opts: { ca?: string; insecure?: boolean; rootCertificates: readonly string[] }) {
  if (isLocal(url)) return false as const;
  if (opts.insecure) return { rejectUnauthorized: false };
  let host = '';
  try {
    host = new URL(url).hostname;
  } catch {
    /* the caller reports an unparseable URL */
  }
  const extra = opts.ca || (isSupabaseHost(host) ? SUPABASE_ROOT_CA : '');
  return { ca: extra ? [...opts.rootCertificates, extra] : [...opts.rootCertificates], rejectUnauthorized: true };
}

/** Host, port, user and database — never the password. */
export function describeTarget(url: string): Record<string, string | boolean> | null {
  try {
    const u = new URL(url);
    return {
      host: u.hostname,
      port: u.port || '5432',
      user: decodeURIComponent(u.username),
      db: u.pathname.replace(/^\//, ''),
      pooler: u.hostname.includes('pooler.supabase.com'),
    };
  } catch {
    return null;
  }
}

export interface PgOptions {
  everyMs?: number;
}

export async function connectPg(databaseUrl: string, log: pino.Logger, opts: PgOptions = {}): Promise<PgHandle> {
  const { default: pg } = await import('pg');
  const { rootCertificates } = await import('node:tls');

  // Logged before anything is attempted: "I changed DATABASE_URL" and "the change never reached the
  // process" are indistinguishable otherwise, and Fly stages dashboard secrets until the next deploy.
  const target = describeTarget(databaseUrl);
  if (target) log.info(target, 'database target');

  // Checked before a socket is opened, because these all fail as something other than themselves.
  const problems = validateDatabaseUrl(databaseUrl);
  for (const p of problems) log.error(`DATABASE_URL PROBLEM — ${p}`);

  const insecure = truthy(process.env.DATABASE_SSL_INSECURE);
  const ca = process.env.DATABASE_CA || '';
  const ssl = sslFor(databaseUrl, { ca, insecure, rootCertificates });
  if (insecure) log.warn('DATABASE_SSL_INSECURE is set — the database certificate is NOT verified');

  const pool = new pg.Pool({ connectionString: databaseUrl, max: 8, ssl });
  // An idle client failing must not take the process down; the pool replaces it.
  pool.on('error', (e: Error) => log.error({ err: e.message }, 'idle database client failed'));

  let ready = false;
  let error: string | null = null;
  let lastReported: string | null = null;
  const latch = readyLatch((e) => log.error({ err: String(e) }, 'a database-ready callback threw'));

  const ping = async (): Promise<void> => {
    try {
      // Against a real table, not SELECT 1: a connection that works but has no schema is a different
      // problem with a different fix, and this is what tells them apart.
      await pool.query('SELECT 1 FROM public.gsc_accounts LIMIT 0');
      if (!ready) {
        ready = true;
        error = null;
        lastReported = null;
        log.info('database connected, schema present');
        latch.open();
      }
    } catch (e) {
      ready = false;
      latch.close();
      error = (e as Error).message;
      // Only on a change, so a database that stays down does not bury the log in one repeated line.
      if (error !== lastReported) {
        lastReported = error;
        log.error({ err: error }, `DATABASE IS NOT USABLE — ${diagnose(error)}`);
      }
    }
  };

  await ping();
  // Retried rather than decided once at boot: the interesting case is the database becoming usable
  // AFTER start — a schema applied, a password fixed, a paused project waking. Checking once makes the
  // answer depend on when the process happened to start, and "restart it and see" hides real problems.
  const timer = setInterval(() => void ping(), opts.everyMs ?? 30_000);
  timer.unref?.();

  return {
    db: new Db(pool),
    health: {
      problems: () => problems,
      ready: () => ready,
      onReady: (cb: () => void) => latch.on(cb),
      error: () => error,
      stop: () => clearInterval(timer),
    },
    close: async () => {
      clearInterval(timer);
      await pool.end().catch(() => undefined);
    },
  };
}
