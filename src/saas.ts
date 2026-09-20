// The tenant surface: sign in, connect a Google account, pick a property, mint a connector URL.
//
// Mounted only when SUPABASE_URL, SUPABASE_ANON_KEY and DATABASE_URL are all set. Without them this
// is the single-account server it has always been, with no login and no database to go wrong —
// the same "two shapes, one codebase" arrangement whatsapp2ai has.
//
// CSRF: there are no tokens on these forms, and that is deliberate rather than missing. The session
// cookie is SameSite=Lax, so a cross-site POST does not carry it and every mutating route here is a
// POST. The one GET that changes anything is Google's callback, which has its own cookie-bound
// state check in google-oauth.ts.
import type { Express, Request, Response } from 'express';
import type pino from 'pino';
import { Attempts, Auth, clearSession, COOKIE, OneShot, readCookie, setSession, type SessionUser } from './auth.ts';
import type { Account, Db } from './db.ts';
import { clearConsentCookie, consentCookie, CONSENT_COOKIE, GoogleOAuth, OAuthError, readCookie as readRawCookie } from './google-oauth.ts';
import type { Config } from './env.ts';
import { esc, page } from './html.ts';
import { mountMcp } from './mcp.ts';
import { seal } from './secrets.ts';
import { mintToken, Tenants, tokenHash } from './tenants.ts';

export interface SaasDeps {
  cfg: Config;
  auth: Auth;
  db: Db;
  tenants: Tenants;
  oauth: GoogleOAuth;
  masterKey: string;
  log: pino.Logger;
}

const MAX_ACCOUNTS = Number(process.env.MAX_ACCOUNTS_PER_USER || 5);

// ---------------------------------------------------------------- small page pieces

const S = {
  card: 'border:1px solid #e3e3e3;border-radius:10px;padding:1.1rem 1.25rem;margin:0 0 1rem',
  input: 'width:100%;padding:.55rem .7rem;border:1px solid #ccc;border-radius:7px;font:inherit;box-sizing:border-box',
  btn: 'padding:.55rem 1rem;border:0;border-radius:7px;background:#1a1a1a;color:#fff;font:inherit;cursor:pointer',
  ghost: 'padding:.4rem .8rem;border:1px solid #ccc;border-radius:7px;background:#fff;font:inherit;cursor:pointer',
  muted: 'color:#666;font-size:.9rem',
  code: 'font:13px ui-monospace,SFMono-Regular,Menlo,monospace;background:#f5f5f5;padding:.6rem .7rem;border-radius:7px;word-break:break-all;display:block',
};

const notice = (text: string, bad = false) =>
  text ? `<p style="${S.card};background:${bad ? '#fff5f5' : '#f4faf4'};border-color:${bad ? '#f0c6c6' : '#c6e0c6'}">${esc(text)}</p>` : '';

/** Status as a word a person can act on, not the enum. */
const statusLine = (a: Account): string => {
  if (a.status === 'pending') return 'Not connected yet';
  if (a.status === 'revoked') return 'Google withdrew this connection — reconnect';
  if (a.status === 'failing') return 'Google is refusing this connection';
  if (!a.property) return 'Connected, but no property chosen';
  return 'Ready';
};

// ---------------------------------------------------------------- routes

export function mountSaas(app: Express, d: SaasDeps): void {
  const { cfg, auth, db, tenants, oauth, masterKey, log } = d;
  const attempts = new Attempts();
  const oneShot = new OneShot();

  const secure = (req: Request) => req.protocol === 'https' || req.get('x-forwarded-proto') === 'https';
  const redirect = (res: Response, to: string) => res.redirect(303, to);

  /** The signed-in user, or null. Asked of GoTrue rather than decoded locally — see auth.ts. */
  const userOf = async (req: Request): Promise<SessionUser | null> => {
    const token = readCookie(req, COOKIE);
    return token ? auth.user(token) : null;
  };

  const guard = async (req: Request, res: Response): Promise<SessionUser | null> => {
    const user = await userOf(req);
    if (!user) {
      redirect(res, '/login');
      return null;
    }
    return user;
  };

  // ---------------------------------------------------------------- the connector

  // Mounted FIRST and outside the guard: a connector carries its own revocable token, not a session
  // cookie. Its resolver is the only thing that differs from the single-account route.
  mountMcp(app, '/c/:token/mcp', (req) => tenants.resolve(String(req.params.token ?? '')), log);

  // ---------------------------------------------------------------- landing

  // With the tenant surface mounted this owns /, so the single-account build's placeholder is not
  // registered at all (see index.ts). Deliberately static and database-free: it is the page a
  // stranger sees, and it must still render when Postgres is down.
  app.get('/', async (req, res) => {
    if (await userOf(req).catch(() => null)) return redirect(res, '/app');
    res.type('html').send(
      page(
        'GOOGLE2AI',
        `<h1>GOOGLE2AI</h1>
         <p>Your Google Search Console, in Claude. Ask what people searched for, which pages are gaining or losing, and why a page is not indexed — in the conversation, not in a dashboard.</p>
         <p style="${S.muted}">Read-only. This connector cannot submit URLs, change settings or write anything to your property.</p>
         <p><a style="${S.btn};text-decoration:none;display:inline-block" href="/login">Sign in</a></p>`,
      ),
    );
  });

  // ---------------------------------------------------------------- sign in

  app.get('/login', async (req, res) => {
    if (await userOf(req)) return redirect(res, '/app');
    const err = typeof req.query.e === 'string' ? req.query.e : '';
    res.type('html').send(
      page(
        'Sign in · GOOGLE2AI',
        `<h1>GOOGLE2AI</h1><p style="${S.muted}">Your Google Search Console, in Claude.</p>` +
          notice(err, true) +
          `<form method="post" action="/login" style="${S.card}">
             <p><label>Email<br><input style="${S.input}" type="email" name="email" autocomplete="email" required></label></p>
             <p><label>Password<br><input style="${S.input}" type="password" name="password" autocomplete="current-password" required></label></p>
             <p><button style="${S.btn}" type="submit">Sign in</button></p>
           </form>
           <form method="post" action="/signup" style="${S.card}">
             <p style="${S.muted}">No account yet? Use the same fields to create one.</p>
             <p><label>Email<br><input style="${S.input}" type="email" name="email" autocomplete="email" required></label></p>
             <p><label>Password<br><input style="${S.input}" type="password" name="password" autocomplete="new-password" minlength="8" required></label></p>
             <p><button style="${S.ghost}" type="submit">Create account</button></p>
           </form>`,
      ),
    );
  });

  const signInPost = (kind: 'signIn' | 'signUp') => async (req: Request, res: Response) => {
    const email = String(req.body?.email ?? '').trim().toLowerCase();
    const password = String(req.body?.password ?? '');

    // Keyed by address AND by client, so one address cannot be locked out from elsewhere and one
    // client cannot work through a list of addresses.
    const who = `${kind}:${email}|${req.ip ?? ''}`;
    if (attempts.tooMany(who)) return redirect(res, '/login?e=' + encodeURIComponent('Too many attempts. Wait a few minutes.'));

    const r = kind === 'signIn' ? await auth.signIn(email, password) : await auth.signUp(email, password);
    if (!r.ok) return redirect(res, '/login?e=' + encodeURIComponent(r.error));

    attempts.clear(who);
    setSession(res, r.accessToken, r.expiresIn, secure(req));
    redirect(res, '/app');
  };

  app.post('/login', signInPost('signIn'));
  app.post('/signup', signInPost('signUp'));

  app.post('/logout', async (req, res) => {
    const token = readCookie(req, COOKIE);
    if (token) await auth.signOut(token).catch(() => undefined);
    clearSession(res, secure(req));
    redirect(res, '/login');
  });

  // ---------------------------------------------------------------- dashboard

  app.get('/app', async (req, res) => {
    const user = await guard(req, res);
    if (!user) return;

    const accounts = await db.listAccounts(user.id);
    const msg = typeof req.query.m === 'string' ? req.query.m : '';
    const err = typeof req.query.e === 'string' ? req.query.e : '';

    // The plaintext connector URL, carried across a redirect exactly once. It is never in the URL,
    // in history or in a log — see OneShot in auth.ts for what that fixed.
    const fresh = typeof req.query.t === 'string' ? oneShot.take(user.id, req.query.t) : null;
    const base = `${secure(req) ? 'https' : 'http'}://${req.get('host')}`;

    const cards = accounts.length
      ? (
          await Promise.all(
            accounts.map(async (a) => {
              const tokens = (await db.listTokens(user.id, a.id)).filter((t) => !t.revoked_at);
              const sites = a.status === 'connected' && !a.property ? await sitesFor(a).catch(() => []) : [];
              return (
                `<div style="${S.card}">
                   <div style="display:flex;justify-content:space-between;gap:1rem;flex-wrap:wrap">
                     <strong>${esc(a.label)}</strong><span style="${S.muted}">${esc(statusLine(a))}</span>
                   </div>
                   <p style="${S.muted};margin:.4rem 0 0">${a.google_email ? esc(a.google_email) : 'no Google account yet'}${a.property ? ` · ${esc(a.property)}` : ''}</p>` +
                (a.status === 'pending' || a.status === 'revoked'
                  ? `<p><a style="${S.btn};text-decoration:none;display:inline-block" href="/oauth/google/start?account=${encodeURIComponent(a.id)}">${a.status === 'revoked' ? 'Reconnect' : 'Connect'} Google</a></p>`
                  : '') +
                (a.status === 'connected' && !a.property
                  ? sites.length
                    ? `<form method="post" action="/app/accounts/${encodeURIComponent(a.id)}/property">
                         <p><label>Which property?<br><select name="property" style="${S.input}">${sites.map((s) => `<option value="${esc(s)}">${esc(s)}</option>`).join('')}</select></label></p>
                         <p><button style="${S.btn}" type="submit">Use this one</button></p>
                       </form>`
                    : `<p style="${S.muted}">No properties are visible to ${esc(a.google_email ?? 'this account')}. That usually means the consent was given as a different Google account than the one that owns the property.</p>`
                  : '') +
                (a.property
                  ? `<p style="${S.muted}">${tokens.length} connector URL${tokens.length === 1 ? '' : 's'}</p>
                     <form method="post" action="/app/accounts/${encodeURIComponent(a.id)}/tokens" style="display:inline">
                       <button style="${S.ghost}" type="submit">New connector URL</button>
                     </form>`
                  : '') +
                ` <form method="post" action="/app/accounts/${encodeURIComponent(a.id)}/delete" style="display:inline" data-confirm="Delete ${esc(a.label)}? This revokes the Google grant and every connector URL.">
                     <button style="${S.ghost}" type="submit">Delete</button>
                   </form>
                 </div>`
              );
            }),
          )
        ).join('')
      : `<p style="${S.muted}">Nothing connected yet.</p>`;

    res.type('html').send(
      page(
        'GOOGLE2AI',
        `<div style="display:flex;justify-content:space-between;align-items:baseline">
           <h1 style="margin:0">GOOGLE2AI</h1>
           <form method="post" action="/logout"><button style="${S.ghost}" type="submit">Sign out</button></form>
         </div>
         <p style="${S.muted}">${esc(user.email)}</p>` +
          notice(msg) +
          notice(err, true) +
          (fresh
            ? `<div style="${S.card};background:#f4faf4;border-color:#c6e0c6">
                 <strong>Your connector URL — shown once</strong>
                 <p style="${S.muted}">Only its hash is stored, so this cannot be shown again. Add it in claude.ai → Settings → Connectors → Add custom connector, with no OAuth. Treat it like a password.</p>
                 <code style="${S.code}">${esc(`${base}/c/${fresh}/mcp`)}</code>
               </div>`
            : '') +
          cards +
          (accounts.length < MAX_ACCOUNTS
            ? `<form method="post" action="/app/accounts" style="${S.card}">
                 <p><label>Add a Search Console property<br><input style="${S.input}" name="label" placeholder="e.g. Ocenagor" maxlength="80" required></label></p>
                 <p><button style="${S.btn}" type="submit">Continue to Google</button></p>
               </form>`
            : `<p style="${S.muted}">That is the maximum of ${MAX_ACCOUNTS} for one account.</p>`),
      ),
    );

    /**
     * The properties this account's consent actually grants. Asked of Google rather than remembered:
     * it is the list the user is about to choose from, and a stale one would offer a property the
     * credential cannot read — which fails later as a 403 that reads like a permissions problem.
     */
    async function sitesFor(a: Account): Promise<string[]> {
      const client = await tenants.clientFor(a);
      if (!client) return [];
      return (await client.listSites()).map((s) => s.siteUrl);
    }
  });

  // ---------------------------------------------------------------- accounts

  app.post('/app/accounts', async (req, res) => {
    const user = await guard(req, res);
    if (!user) return;

    const label = String(req.body?.label ?? '').trim().slice(0, 80);
    if (!label) return redirect(res, '/app?e=' + encodeURIComponent('Give it a name.'));
    // Not a plan, a ceiling: every account is a live Google grant this server is responsible for.
    if ((await db.countAccounts(user.id)) >= MAX_ACCOUNTS) return redirect(res, '/app?e=' + encodeURIComponent(`Maximum of ${MAX_ACCOUNTS} reached.`));

    const a = await db.createAccount(user.id, label, cfg.quotaProject || null);
    redirect(res, `/oauth/google/start?account=${encodeURIComponent(a.id)}`);
  });

  app.post('/app/accounts/:id/property', async (req, res) => {
    const user = await guard(req, res);
    if (!user) return;
    const property = String(req.body?.property ?? '').trim();
    // The CHECK constraint refuses a spelling the API would 403 on; this turns that into a sentence.
    const ok = await db.setProperty(user.id, String(req.params.id), property).catch(() => false);
    tenants.forget(String(req.params.id));
    redirect(res, ok ? '/app?m=' + encodeURIComponent('Property set.') : '/app?e=' + encodeURIComponent('That is not a property Search Console would accept.'));
  });

  app.post('/app/accounts/:id/tokens', async (req, res) => {
    const user = await guard(req, res);
    if (!user) return;

    const token = mintToken();
    const ok = await db.addToken(user.id, String(req.params.id), tokenHash(token), null);
    if (!ok) return redirect(res, '/app?e=' + encodeURIComponent('No such account.'));
    // Post/Redirect/Get: rendering here would leave the browser on a POST, where every refresh
    // mints another live credential.
    redirect(res, '/app?t=' + encodeURIComponent(oneShot.put(user.id, token)));
  });

  app.post('/app/accounts/:id/delete', async (req, res) => {
    const user = await guard(req, res);
    if (!user) return;

    const id = String(req.params.id);
    const ok = await db.beginDelete(user.id, id);
    if (!ok) return redirect(res, '/app?e=' + encodeURIComponent('No such account.'));
    tenants.forget(id);
    // The tombstone and the token revocation are done; ending the Google grant is a call to
    // somebody else's service, so it happens here if it can and in the reaper if it cannot.
    void tenants.reap().catch((e) => log.error({ err: String(e) }, 'reap after delete failed'));
    redirect(res, '/app?m=' + encodeURIComponent('Deleted. Its connector URLs stopped working immediately.'));
  });

  // ---------------------------------------------------------------- Google consent

  app.get('/oauth/google/start', async (req, res) => {
    const user = await guard(req, res);
    if (!user) return;

    // Checked against the signed-in user before a consent is started, so the state cannot be made
    // to carry an account id belonging to somebody else.
    const account = await db.getAccount(user.id, String(req.query.account ?? ''));
    if (!account) return redirect(res, '/app?e=' + encodeURIComponent('No such account.'));

    try {
      const { url, cookie } = oauth.begin(account.id);
      res.setHeader('Set-Cookie', consentCookie(cookie, secure(req)));
      redirect(res, url);
    } catch (e) {
      redirect(res, '/app?e=' + encodeURIComponent(e instanceof OAuthError ? e.message : 'Could not start the Google consent.'));
    }
  });

  app.get('/oauth/google/callback', async (req, res) => {
    const user = await userOf(req);
    // The consent cookie is cleared on every exit from here, success or failure — an unused one is
    // a live verifier sitting in a browser.
    const done = (to: string) => {
      res.setHeader('Set-Cookie', clearConsentCookie(secure(req)));
      redirect(res, to);
    };
    if (!user) return done('/login');

    if (req.query.error) {
      return done('/app?e=' + encodeURIComponent(`Google did not grant access: ${String(req.query.error)}`));
    }

    try {
      const { accountId, grant } = await oauth.complete({
        code: String(req.query.code ?? ''),
        state: String(req.query.state ?? ''),
        cookie: readRawCookie(req.headers.cookie, CONSENT_COOKIE),
      });

      // The account is re-fetched under the signed-in user rather than trusted from the state: the
      // state proves the browser, this proves the owner.
      const account = await db.getAccount(user.id, accountId);
      if (!account) return done('/app?e=' + encodeURIComponent('That consent does not belong to this account.'));

      await db.setSecret(account.id, seal(masterKey, account.id, grant.refreshToken));
      await db.setStatus(account.id, 'connected', { googleEmail: grant.email });
      tenants.forget(account.id);
      done('/app?m=' + encodeURIComponent(grant.email ? `Connected as ${grant.email}. Now choose a property.` : 'Connected. Now choose a property.'));
    } catch (e) {
      // OAuthError messages are written for the person reading them and carry no token; anything
      // else is logged and generalised.
      if (e instanceof OAuthError) return done('/app?e=' + encodeURIComponent(e.message));
      log.error({ err: String(e) }, 'google consent failed');
      done('/app?e=' + encodeURIComponent('Could not finish connecting to Google.'));
    }
  });
}
