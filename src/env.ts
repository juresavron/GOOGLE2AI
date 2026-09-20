// Tiny .env loader + typed config. No dependencies (mirrors whatsapp2ai's env.ts and imap2ai's
// _load_dotenv), so the config that decides whether this server can reach Google is not itself
// waiting on an install.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

export function loadDotenv(file = path.resolve(process.cwd(), '.env')): void {
  if (!fs.existsSync(file)) return;
  for (const raw of fs.readFileSync(file, 'utf8').split('\n')) {
    const line = raw.trim();
    if (!line || line.startsWith('#') || !line.includes('=')) continue;
    const i = line.indexOf('=');
    const k = line.slice(0, i).trim();
    let v = line.slice(i + 1).trim();
    const hash = v.search(/\s#/);
    if (hash >= 0 && !/^["']/.test(v)) v = v.slice(0, hash).trim();
    v = v.replace(/^"(.*)"$/, '$1').replace(/^'(.*)'$/, '$1');
    if (!(k in process.env)) process.env[k] = v;
  }
}

const bool = (v: string | undefined, d: boolean) => (v == null || v === '' ? d : /^(1|true|yes|on)$/i.test(v));

/**
 * How this server proves to Google who it is. Four ways, and the order below is the order they are
 * tried — which is NOT the order the upstream project documents, for a reason that only shows up
 * once the server stops being local:
 *
 *   oauth   GOOGLE_CLIENT_ID + GOOGLE_CLIENT_SECRET + GOOGLE_REFRESH_TOKEN
 *           The only one that works on a hosted box. The calls run as the person who consented, so
 *           every property they own is readable with nothing to configure in Search Console.
 *   inline  GOOGLE_CREDENTIALS_JSON — a service account key as a string, for `fly secrets set`.
 *           There is no file to mount on Fly, and writing one to the volume to satisfy a library
 *           that wants a path is how a key ends up in a backup.
 *   file    GOOGLE_APPLICATION_CREDENTIALS — the standard path variable, for a VPS or local run.
 *   adc     Nothing set: fall back to gcloud Application Default Credentials. Local development
 *           only — there is no gcloud on a container, so this resolves to "no credentials" there.
 *
 * Service accounts are listed after OAuth because Search Console's own "Add user" form rejects a
 * fresh service account address ("email not found"), so `inline` and `file` only work with an
 * account that was already granted access. That is a Google-side bug, documented upstream, and it
 * is the reason a hosted deploy of this server is OAuth-first.
 */
export type AuthKind = 'oauth' | 'inline' | 'file' | 'adc';

export interface Config {
  host: string;
  port: number;
  secret: string;
  secretGenerated: boolean;

  clientId: string;
  clientSecret: string;
  refreshToken: string;
  credentialsJson: string;
  credentialsFile: string;
  /**
   * Billed for the API calls. REQUIRED with user credentials — Search Console answers
   * 403 PERMISSION_DENIED without one — and ignored with a service account key, which bills its own
   * project. Getting this wrong produces an error that reads like a permissions problem, so
   * diagnostics names it explicitly.
   */
  quotaProject: string;

  /**
   * A property to assume when a tool is called without one, e.g. `sc-domain:example.com`. The
   * connector then behaves like its siblings — bound to one thing, named in the instructions — while
   * still reaching every other property the credentials can see.
   */
  defaultSite: string;

  /**
   * Whether the write tools will actually act. FALSE BY DEFAULT, and the tools are registered
   * either way so that a refusal can say how to turn it on.
   *
   * The same arrangement as whatsapp2ai's WA_ALLOW_SEND and imap2ai's MAIL_ALLOW_SEND, for the
   * same reason: the read half of these connectors is safe to hand an agent, and the write half
   * removes a sitemap or a whole property from Search Console. One of those is undone by asking
   * again; the other is not.
   */
  allowWrite: boolean;

  tz: string;
  logLevel: string;
  mock: boolean;
  maxRows: number;

  /** Who runs this deployment. Read only by the legal pages, which say so loudly when it is unset. */
  operator: { name: string; contact: string; law: string };
  /** Who may open the operator panel. Checked server-side on every request; empty means nobody. */
  adminEmails: string[];

  // Multi-tenant build only (stage 4). Absent = the single-account server, with no login, no
  // dashboard and no database to go wrong.
  supabaseUrl: string;
  supabaseAnonKey: string;
  databaseUrl: string;
}

export function authKind(c: Config): AuthKind {
  if (c.clientId && c.clientSecret && c.refreshToken) return 'oauth';
  if (c.credentialsJson) return 'inline';
  if (c.credentialsFile) return 'file';
  return 'adc';
}

export function configFromEnv(): Config {
  let secret = process.env.MCP_SECRET || '';
  const secretGenerated = !secret;
  if (secretGenerated) secret = crypto.randomBytes(24).toString('base64url');
  return {
    host: process.env.HOST || '0.0.0.0',
    port: Number(process.env.PORT || 8080),
    secret,
    secretGenerated,

    clientId: (process.env.GOOGLE_CLIENT_ID || '').trim(),
    clientSecret: (process.env.GOOGLE_CLIENT_SECRET || '').trim(),
    refreshToken: (process.env.GOOGLE_REFRESH_TOKEN || '').trim(),
    credentialsJson: (process.env.GOOGLE_CREDENTIALS_JSON || '').trim(),
    credentialsFile: (process.env.GOOGLE_APPLICATION_CREDENTIALS || '').trim(),
    quotaProject: (process.env.GOOGLE_QUOTA_PROJECT || '').trim(),

    defaultSite: (process.env.GSC_DEFAULT_SITE || '').trim(),
    allowWrite: bool(process.env.GSC_ALLOW_WRITE, false),

    tz: process.env.GSC_TZ || process.env.TZ || 'Europe/Ljubljana',
    logLevel: process.env.LOG_LEVEL || 'info',
    mock: bool(process.env.GSC_MOCK, false),
    // Google's own ceiling for one searchanalytics.query call. Configurable downward only; a larger
    // number is not accepted by the API and would fail every request that used it.
    maxRows: Math.min(Number(process.env.GSC_MAX_ROWS || 25000), 25000),

    adminEmails: (process.env.ADMIN_EMAILS || '')
      .split(',')
      .map((s) => s.trim().toLowerCase())
      .filter(Boolean),
    operator: {
      name: (process.env.OPERATOR_NAME || '').trim(),
      contact: (process.env.OPERATOR_CONTACT || '').trim(),
      law: (process.env.OPERATOR_LAW || '').trim(),
    },

    // Trailing slash trimmed once here: every auth URL is built by concatenation, and a doubled
    // slash in a GoTrue path is a 404 that reads like a wrong password.
    supabaseUrl: (process.env.SUPABASE_URL || '').replace(/\/+$/, ''),
    supabaseAnonKey: process.env.SUPABASE_ANON_KEY || '',
    databaseUrl: process.env.DATABASE_URL || '',
  };
}
