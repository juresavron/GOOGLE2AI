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
import { banner, chip, emptyState, esc, page, pageHeader, panel, stat, stats, table, type State } from './html.ts';
import { mountMcp } from './mcp.ts';
import { mountPages } from './pages.ts';
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

/** A blocking state, once per screen. Anything quieter is a line of quiet text (rule 7 in html.ts). */
const notice = (text: string, bad = false) => (text ? banner(bad ? 'danger' : 'info', esc(text)) : '');

/** Status as a word a person can act on, plus the chip colour that word deserves. */
const accountState = (a: Account): { state: State; label: string } => {
  if (a.status === 'pending') return { state: 'pending', label: 'Not connected' };
  if (a.status === 'revoked') return { state: 'danger', label: 'Google withdrew access' };
  if (a.status === 'failing') return { state: 'danger', label: 'Google is refusing' };
  if (!a.property) return { state: 'pending', label: 'No property chosen' };
  return { state: 'ok', label: 'Ready' };
};

// ---------------------------------------------------------------- routes

export function mountSaas(app: Express, d: SaasDeps): void {
  const { cfg, auth, db, tenants, oauth, masterKey, log } = d;
  const attempts = new Attempts();
  const oneShot = new OneShot();

  /**
   * An account id from a URL, or null.
   *
   * Postgres throws `invalid input syntax for type uuid` on anything that is not one, and these
   * ids arrive from :id path segments and ?account query strings — so without this, /app/accounts/x
   * is a 500 rather than "no such account". A 500 is both a worse answer and a louder one: it says
   * the id reached the database, which a caller probing for valid ids can use.
   */
  const accountId = (v: unknown): string | null => {
    const s = String(v ?? '');
    return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(s) ? s : null;
  };
  const noSuchAccount = (res: Response) => redirect(res, '/app?e=' + encodeURIComponent('No such account.'));

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

  // ---------------------------------------------------------------- legal

  // Not decoration: Google's OAuth verification asks for both before it will publish a consent
  // screen, and an unpublished one expires every tenant's refresh token after seven days.
  mountPages(app, cfg);

  // ---------------------------------------------------------------- landing

  // With the tenant surface mounted this owns /, so the single-account build's placeholder is not
  // registered at all (see index.ts). Deliberately static and database-free: it is the page a
  // stranger sees, and it must still render when Postgres is down.
  app.get('/', async (req, res) => {
    if (await userOf(req).catch(() => null)) return redirect(res, '/app');
    res.type('html').send(
      page(
        'GOOGLE2AI — your Search Console, in Claude',
        `<div class="hero">
           <h1>Your Search Console, in Claude</h1>
           <p class="lede">Ask what people searched for, which pages are gaining or losing, and why a page is not
             indexed — in the conversation, not in a dashboard.</p>
           <div class="btnrow"><a class="button" href="/login">Get started</a></div>
         </div>

         <div class="cols">
           <div class="card">
             <h2>What you can ask</h2>
             <div class="prose">
               <ul>
                 <li>Top queries and pages for any range</li>
                 <li>This month against last, with the change on every row</li>
                 <li>Why one URL is not indexed, and which canonical Google chose</li>
                 <li>Whether your sitemaps are actually being read</li>
               </ul>
             </div>
           </div>
           <div class="card">
             <h2>What it does with your data</h2>
             <div class="prose">
               <p>Nothing is copied here. Every answer is fetched from Google when you ask and passed
                 straight back.</p>
               <p>Reading is what it does by default. Sitemap and property changes are possible, and
                 switched off until you turn them on for a connection.</p>
             </div>
           </div>
         </div>

         <div class="card">
           <h2>Three steps</h2>
           <ol class="steps">
             <li>Create an account and connect Google — you choose which property.</li>
             <li>Get a connector URL. It is shown once, and you can revoke it at any time.</li>
             <li>Paste it into Claude as a custom connector. That is the whole setup.</li>
           </ol>
         </div>`,
        {
          description: 'Read your Google Search Console from Claude over the Model Context Protocol.',
          footer: '<a href="/privacy">Privacy</a> · <a href="/terms">Terms</a>',
        },
      ),
    );
  });

  // ---------------------------------------------------------------- sign in

  app.get('/login', async (req, res) => {
    if (await userOf(req)) return redirect(res, '/app');
    const err = typeof req.query.e === 'string' ? req.query.e : '';
    const msg = typeof req.query.m === 'string' ? req.query.m : '';

    /**
     * ONE set of fields, two submit buttons.
     *
     * This was two stacked forms, each with its own Email and Password labelled identically and
     * nothing saying which one a new person wanted. `formaction` on the second button posts the
     * same fields to /signup instead — no JavaScript, no tab state, and no second copy of the
     * inputs to keep in sync.
     */
    res.type('html').send(
      page(
        'Sign in · GOOGLE2AI',
        `<h1>GOOGLE2AI</h1>
         <p class="muted" style="margin:0 0 1.25rem">Your Google Search Console, in Claude.</p>` +
          notice(msg) +
          notice(err, true) +
          `<form method="post" action="/login" class="card">
             <label for="email">Email</label>
             <input id="email" type="email" name="email" autocomplete="email" autofocus required>
             <label for="password">Password</label>
             <input id="password" type="password" name="password" autocomplete="current-password" minlength="8" required>
             <p class="muted" style="margin:.375rem 0 1rem">At least 8 characters.</p>
             <div class="btnrow" style="margin:0">
               <button type="submit">Sign in</button>
               <button class="ghost" type="submit" formaction="/signup">Create account</button>
             </div>
           </form>
           <p class="muted">New here? Fill both fields in and press <strong>Create account</strong>.</p>`,
        { narrow: true, footer: '<a href="/privacy">Privacy</a> · <a href="/terms">Terms</a>' },
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
    if (!r.ok) {
      // Supabase answers "For security purposes, you can only request this after N seconds" when
      // its built-in SMTP is rate-limited, which reads as though the PASSWORD were the problem.
      // Naming the real cause saves the next person the twenty minutes it cost this one.
      const hint = /only request this after/i.test(r.error)
        ? `${r.error} — that is the email rate limit on the Supabase project, not your password. Turning off Authentication → Email → "Confirm email" removes it.`
        : r.error;
      return redirect(res, '/login?e=' + encodeURIComponent(hint));
    }

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

  /** The one piece of chrome every signed-in page carries: who you are, and the way out. */
  const topbar = (user: SessionUser, admin: boolean) =>
    `<div class="topbar">
       <a class="brand" href="/app">GOOGLE2AI</a>
       <div class="acts">
         <span class="who">${esc(user.email)}</span>
         ${admin ? `<a class="btn" href="/app/operator">Operator</a>` : ''}
         <form method="post" action="/logout" class="rowform"><button type="submit">Sign out</button></form>
       </div>
     </div>`;

  app.get('/app', async (req, res) => {
    const user = await guard(req, res);
    if (!user) return;

    const accounts = await db.listAccounts(user.id);
    const msg = typeof req.query.m === 'string' ? req.query.m : '';
    const err = typeof req.query.e === 'string' ? req.query.e : '';

    // The plaintext connector URL, carried across a redirect exactly once. Never in the URL, in
    // history or in a log — see OneShot in auth.ts for what that fixed.
    const fresh = typeof req.query.t === 'string' ? oneShot.take(user.id, req.query.t) : null;
    const base = (process.env.PUBLIC_ORIGIN || '').replace(/\/+$/, '') || `${secure(req) ? 'https' : 'http'}://${req.get('host')}`;

    const cards = accounts.length
      ? (
          await Promise.all(
            accounts.map(async (a) => {
              const tokens = (await db.listTokens(user.id, a.id)).filter((t) => !t.revoked_at);
              const sites = a.status === 'connected' && !a.property ? await sitesFor(a).catch(() => []) : [];
              const st = accountState(a);
              const id = encodeURIComponent(a.id);

              const body: string[] = [];

              if (a.status === 'pending' || a.status === 'revoked') {
                body.push(
                  `<p class="meta">${a.status === 'revoked'
                    ? 'Google has withdrawn this connection. Reconnecting keeps the same connector URLs working.'
                    : 'This account has not been connected to Google yet.'}</p>
                   <div class="acts"><a class="btn primary" href="/oauth/google/start?account=${id}">${a.status === 'revoked' ? 'Reconnect' : 'Connect'} Google</a></div>`,
                );
              }

              if (a.status === 'connected' && !a.property) {
                body.push(
                  sites.length
                    ? `<form method="post" action="/app/accounts/${id}/property">
                         <label for="p-${id}">Which property?</label>
                         <select id="p-${id}" name="property">${sites.map((x) => `<option value="${esc(x)}">${esc(x)}</option>`).join('')}</select>
                         <div class="acts" style="margin-top:.625rem"><button class="primary" type="submit">Use this one</button></div>
                       </form>`
                    : `<p class="meta">No properties are visible to ${esc(a.google_email ?? 'this account')}. That usually means
                         consent was given as a different Google account than the one that owns the property.</p>`,
                );
              }

              if (a.property) {
                body.push(
                  `<div class="stats">
                     ${stat({ label: 'Connector URLs', value: tokens.length })}
                     ${stat({ label: 'Writing', value: a.allow_write ? 'On' : 'Off', state: a.allow_write ? 'pending' : 'info' })}
                   </div>` +
                    (a.allow_write && !cfg.allowWrite
                      ? `<p class="micro">On for this account, but off server-wide — the tools will still refuse.</p>`
                      : '') +
                    `<div class="acts">
                       <form method="post" action="/app/accounts/${id}/tokens" class="rowform"><button type="submit">New connector URL</button></form>
                       <form method="post" action="/app/accounts/${id}/write" class="rowform"
                             data-confirm="${a.allow_write ? `Stop ${esc(a.label)} writing?` : `Let ${esc(a.label)} submit and delete sitemaps, and add and remove properties? Removing a property is not undone by re-adding it.`}">
                         <input type="hidden" name="allow" value="${a.allow_write ? '0' : '1'}">
                         <button type="submit">${a.allow_write ? 'Stop writing' : 'Allow writing'}</button>
                       </form>
                     </div>`,
                );
              }

              return panel({
                title: a.label,
                meta: `${chip(st.state, st.label)} ${a.google_email ? esc(a.google_email) : '<span class="muted">no Google account yet</span>'}${a.property ? ` · <code>${esc(a.property)}</code>` : ''}`,
                action: `<form method="post" action="/app/accounts/${id}/delete" class="rowform"
                           data-confirm="Delete ${esc(a.label)}? This revokes its Google grant and every connector URL.">
                           <button class="danger" type="submit">Delete</button>
                         </form>`,
                body: body.join(''),
              });
            }),
          )
        ).join('')
      : panel({
          body: emptyState({
            title: 'Nothing connected yet',
            meta: 'Add a Search Console property below, and connect the Google account that owns it.',
          }),
          flush: true,
        });

    res.type('html').send(
      page(
        'Dashboard · GOOGLE2AI',
        topbar(user, isAdmin(user)) +
          pageHeader({ title: 'Your connections', meta: `${accounts.length} of ${MAX_ACCOUNTS}` }) +
          `<div class="stack" style="margin-top:1.25rem">` +
          notice(msg) +
          notice(err, true) +
          (fresh
            ? panel({
                title: 'Your connector URL',
                meta: 'Shown once — only its hash is stored.',
                body: `<pre class="jsonbox">${esc(`${base}/c/${fresh}/mcp`)}</pre>
                       <p class="meta">Add it in claude.ai → Settings → Connectors → Add custom connector, with no OAuth.
                          Treat the whole URL like a password; revoke it here if it leaks.</p>`,
              })
            : '') +
          cards +
          (accounts.length < MAX_ACCOUNTS
            ? panel({
                title: 'Add a property',
                body: `<form method="post" action="/app/accounts">
                         <label for="label">Name it</label>
                         <input id="label" name="label" placeholder="e.g. Ocenagor" maxlength="80" required>
                         <p class="meta" style="margin:.375rem 0 .75rem">Your own name for this connection — you pick the Search Console property next.</p>
                         <div class="acts"><button class="primary" type="submit">Continue to Google</button></div>
                       </form>`,
              })
            : panel({ body: `<p class="meta">That is the maximum of ${MAX_ACCOUNTS} connections for one account.</p>` })) +
          `</div>`,
        { tool: true, footer: '<a href="/privacy">Privacy</a> · <a href="/terms">Terms</a>' },
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
      return (await client.listSites()).map((x) => x.siteUrl);
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
    const id = accountId(req.params.id);
    if (!id) return noSuchAccount(res);
    const property = String(req.body?.property ?? '').trim();
    // The CHECK constraint refuses a spelling the API would 403 on; this turns that into a sentence.
    const ok = await db.setProperty(user.id, id, property).catch(() => false);
    tenants.forget(id);
    redirect(res, ok ? '/app?m=' + encodeURIComponent('Property set.') : '/app?e=' + encodeURIComponent('That is not a property Search Console would accept.'));
  });

  app.post('/app/accounts/:id/write', async (req, res) => {
    const user = await guard(req, res);
    if (!user) return;
    const id = accountId(req.params.id);
    if (!id) return noSuchAccount(res);
    const allow = String(req.body?.allow ?? '') === '1';
    const ok = await db.setAllowWrite(user.id, id, allow);
    // The cached client carries the old cfg, so a toggle that did not drop it would leave writes
    // enabled — or refused — for up to the cache TTL after the button said otherwise.
    tenants.forget(id);
    if (!ok) return noSuchAccount(res);
    redirect(
      res,
      '/app?m=' +
        encodeURIComponent(
          allow
            ? cfg.allowWrite
              ? 'Writing enabled for this account.'
              : 'Enabled for this account — but writing is off server-wide (GSC_ALLOW_WRITE), so the tools will still refuse.'
            : 'Writing disabled for this account.',
        ),
    );
  });

  app.post('/app/accounts/:id/tokens', async (req, res) => {
    const user = await guard(req, res);
    if (!user) return;

    const id = accountId(req.params.id);
    if (!id) return noSuchAccount(res);
    const token = mintToken();
    const ok = await db.addToken(user.id, id, tokenHash(token), null);
    if (!ok) return noSuchAccount(res);
    // Post/Redirect/Get: rendering here would leave the browser on a POST, where every refresh
    // mints another live credential.
    redirect(res, '/app?t=' + encodeURIComponent(oneShot.put(user.id, token)));
  });

  app.post('/app/accounts/:id/delete', async (req, res) => {
    const user = await guard(req, res);
    if (!user) return;

    const id = accountId(req.params.id);
    if (!id) return noSuchAccount(res);
    const ok = await db.beginDelete(user.id, id);
    if (!ok) return noSuchAccount(res);
    tenants.forget(id);
    // The tombstone and the token revocation are done; ending the Google grant is a call to
    // somebody else's service, so it happens here if it can and in the reaper if it cannot.
    void tenants.reap().catch((e) => log.error({ err: String(e) }, 'reap after delete failed'));
    redirect(res, '/app?m=' + encodeURIComponent('Deleted. Its connector URLs stopped working immediately.'));
  });

  // ---------------------------------------------------------------- operator panel

  /**
   * ADMIN_EMAILS, checked SERVER-SIDE on every request. Empty means nobody, which is the right
   * default for a page that lists every customer on the deployment — the alternative is that a
   * deployment which forgot to configure it has an open one.
   *
   * Compared against the address GoTrue reports for the session, not one from the request.
   */
  const isAdmin = (user: SessionUser): boolean => cfg.adminEmails.length > 0 && cfg.adminEmails.includes(user.email.trim().toLowerCase());

  app.get('/app/operator', async (req, res) => {
    const user = await guard(req, res);
    if (!user) return;
    // 404, not 403: a signed-in stranger learns nothing about whether this panel exists.
    if (!isAdmin(user)) return res.status(404).type('text/plain').send('not found');

    const [totals, accounts, errors] = await Promise.all([db.totals(), db.allAccounts(), db.errorBreakdown()]);

    const rows = accounts.map((a) => {
      const st = accountState(a);
      return [
        `<span class="lead">${esc(a.label)}</span><div class="micro">${esc(a.google_email ?? '—')}</div>`,
        a.property ? `<code>${esc(a.property)}</code>` : '<span class="muted">—</span>',
        chip(st.state, st.label) + (a.allow_write ? ' ' + chip('pending', 'writes') : ''),
        String(a.tokens),
        String(a.calls_24h),
        // last_error is operator-facing and can quote the property. It is why this panel exists —
        // the tenant dashboard deliberately cannot show it.
        a.last_error ? `<span class="micro" style="color:hsl(var(--error-700))">${esc(a.last_error)}</span>` : '',
      ];
    });

    res.type('html').send(
      page(
        'Operator · GOOGLE2AI',
        topbar(user, true) +
          pageHeader({ title: 'Operator', meta: 'Every account on this deployment', back: { href: '/app', label: 'Dashboard' } }) +
          `<div class="stack" style="margin-top:1.25rem">` +
          stats(
            stat({ label: 'Accounts', value: totals.accounts }),
            stat({ label: 'Connected', value: totals.connected, state: totals.connected === totals.accounts ? 'ok' : 'pending' }),
            stat({ label: 'Connector URLs', value: totals.tokens }),
            stat({ label: 'Calls 24h', value: totals.calls_24h }),
            stat({ label: 'Errors 24h', value: totals.errors_24h, state: totals.errors_24h ? 'danger' : 'ok' }),
          ) +
          panel({
            title: 'Accounts',
            flush: true,
            body: table(
              [{ header: 'Account' }, { header: 'Property' }, { header: 'State' }, { header: 'URLs', num: true }, { header: '24h', num: true }, { header: 'Last error' }],
              rows,
              emptyState({ title: 'No accounts yet', meta: 'Nobody has signed up and connected a property.' }),
            ),
          }) +
          (errors.length
            ? panel({
                title: 'Failures in the last 24 hours',
                // errorCode() is a closed vocabulary precisely so this panel can be useful without
                // becoming a second copy of anybody's search traffic.
                meta: 'Codes only — never an argument, a property or a search term.',
                flush: true,
                body: table(
                  [{ header: 'Code' }, { header: 'Count', num: true }],
                  errors.map((e) => [`<code>${esc(e.error_code)}</code>`, String(e.n)]),
                ),
              })
            : '') +
          `</div>`,
        { tool: true, wide: true },
      ),
    );
  });

  // ---------------------------------------------------------------- Google consent

  app.get('/oauth/google/start', async (req, res) => {
    const user = await guard(req, res);
    if (!user) return;

    // Checked against the signed-in user before a consent is started, so the state cannot be made
    // to carry an account id belonging to somebody else.
    const id = accountId(req.query.account);
    if (!id) return noSuchAccount(res);
    const account = await db.getAccount(user.id, id);
    if (!account) return noSuchAccount(res);

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
      const { accountId: accountIdFromState, grant } = await oauth.complete({
        code: String(req.query.code ?? ''),
        state: String(req.query.state ?? ''),
        cookie: readRawCookie(req.headers.cookie, CONSENT_COOKIE),
      });

      // The account is re-fetched under the signed-in user rather than trusted from the state: the
      // state proves the browser, this proves the owner. Shape-checked first, because the state is
      // attacker-supplied even though it matched the cookie.
      const id = accountId(accountIdFromState);
      if (!id) return done('/app?e=' + encodeURIComponent('That consent does not belong to this account.'));
      const account = await db.getAccount(user.id, id);
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
