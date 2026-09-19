// The Google OAuth consent flow.
//
// NEITHER SIBLING HAS ONE, and the reason is the whole shape of this file. An imap2ai tenant types a
// mailbox password into a form and the server stores it; a whatsapp2ai tenant scans a QR and the
// server holds the session. A Search Console tenant can do neither — Google will not issue a
// password, and there is no device to link. The only way for this server to read somebody else's
// Search Console is for them to grant it, at Google, and for the server to keep the refresh token
// that grant produces.
//
// That makes this file the most security-sensitive one in the repository: it is the only place where
// a bearer credential for someone else's Google account is handled in the clear. It is sealed by
// src/secrets.ts the moment it arrives and never logged, never rendered, never returned to a
// browser.
//
// `fetch` is injected so every path here is testable without a network — the tests drive a fake that
// returns Google's real response shapes, including its real error shapes.
import crypto from 'node:crypto';

/**
 * What the connector needs, plus the two that only exist to stop the most common support ticket.
 *
 * `openid email` is not needed to read Search Console. It is here because "I consented as the wrong
 * Google account" is the single most common way this fails, and it is invisible without an address
 * to show: list_sites simply comes back empty, which reads as "I have no properties". Both are
 * non-sensitive scopes and neither widens what the token can do to Search Console.
 */
export const SCOPES = ['https://www.googleapis.com/auth/webmasters.readonly', 'openid', 'email'];

const AUTH_URL = 'https://accounts.google.com/o/oauth2/v2/auth';
const TOKEN_URL = 'https://oauth2.googleapis.com/token';
const REVOKE_URL = 'https://oauth2.googleapis.com/revoke';
const USERINFO_URL = 'https://openidconnect.googleapis.com/v1/userinfo';

export type Fetch = (url: string, init?: { method?: string; headers?: Record<string, string>; body?: string }) => Promise<{
  ok: boolean;
  status: number;
  text(): Promise<string>;
  json(): Promise<unknown>;
}>;

export interface Started {
  /** Where to send the browser. */
  url: string;
  /**
   * Goes in a short-lived httpOnly cookie, NOT in the URL. The state parameter alone is not CSRF
   * protection: an attacker who can make the victim's browser follow a callback URL supplies both
   * the code and the state. Binding the flow to a cookie the attacker cannot read or set is what
   * makes the callback provably the same browser that started it.
   */
  cookie: string;
}

export interface Grant {
  refreshToken: string;
  accessToken: string;
  expiresIn: number;
  email: string | null;
}

export class OAuthError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.code = code;
  }
}

const b64url = (b: Buffer) => b.toString('base64url');
const s256 = (v: string) => b64url(crypto.createHash('sha256').update(v).digest());

/** Google's errors are a short machine code plus an optional sentence; both are worth keeping. */
function googleError(body: Record<string, any>, fallback: string): OAuthError {
  const code = String(body?.error ?? 'oauth_error');
  const detail = String(body?.error_description ?? '').trim();
  if (code === 'invalid_grant') {
    return new OAuthError(
      code,
      // By far the most common one, and its usual cause has nothing to do with the code being
      // wrong: an OAuth consent screen left in Testing expires refresh tokens after seven days.
      `Google rejected the grant (invalid_grant). Usual causes: the consent screen is still in Testing, which expires refresh tokens after 7 days; the grant was withdrawn at myaccount.google.com/permissions; or the account's password changed.${detail ? ` (${detail})` : ''}`,
    );
  }
  if (code === 'redirect_uri_mismatch') {
    return new OAuthError(code, 'Google refused the redirect URI. It must match one registered on the OAuth client EXACTLY, including scheme, port and trailing slash.');
  }
  return new OAuthError(code, detail || fallback);
}

export class GoogleOAuth {
  private readonly clientId: string;
  private readonly clientSecret: string;
  private readonly redirectUri: string;
  private readonly f: Fetch;

  constructor(clientId: string, clientSecret: string, redirectUri: string, f: Fetch = fetch as unknown as Fetch) {
    this.clientId = clientId;
    this.clientSecret = clientSecret;
    this.redirectUri = redirectUri;
    this.f = f;
  }

  get configured(): boolean {
    return Boolean(this.clientId && this.clientSecret && this.redirectUri);
  }

  /**
   * Start a consent. `accountId` rides in the state so the callback knows which pending row it is
   * completing, and is checked against the cookie's copy rather than trusted from the URL.
   */
  begin(accountId: string): Started {
    if (!this.configured) throw new OAuthError('not_configured', 'Google OAuth is not configured on this server (GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET).');

    const nonce = b64url(crypto.randomBytes(24));
    const verifier = b64url(crypto.randomBytes(32));
    const state = `${accountId}.${nonce}`;

    const u = new URL(AUTH_URL);
    u.search = new URLSearchParams({
      client_id: this.clientId,
      redirect_uri: this.redirectUri,
      response_type: 'code',
      scope: SCOPES.join(' '),
      state,
      // Both are load-bearing. offline is what asks for a refresh token at all; consent forces one
      // to be issued even when this account has already approved this client, which is the
      // difference between re-connecting working and silently returning no refresh token.
      access_type: 'offline',
      prompt: 'consent',
      // PKCE, even though this is a confidential client holding a secret. It costs one hash and it
      // closes code interception at the redirect — a class that does not depend on the secret
      // staying secret, and the one thing a client secret cannot help with.
      code_challenge: s256(verifier),
      code_challenge_method: 'S256',
    }).toString();

    return { url: u.toString(), cookie: `${state}:${verifier}` };
  }

  /**
   * Finish a consent. Returns the grant; the caller seals the refresh token immediately.
   *
   * Everything that can be checked before spending the code is checked before spending the code,
   * because a code can only be exchanged once — a replay that reaches Google first burns the real
   * user's code and leaves them with an error they cannot act on.
   */
  async complete(params: { code: string; state: string; cookie: string }): Promise<{ accountId: string; grant: Grant }> {
    const { code, state, cookie } = params;
    if (!code) throw new OAuthError('no_code', 'Google did not return an authorization code.');
    if (!cookie) throw new OAuthError('no_cookie', 'This consent did not start in this browser, or it took too long. Start again.');

    const sep = cookie.lastIndexOf(':');
    const cookieState = sep < 0 ? '' : cookie.slice(0, sep);
    const verifier = sep < 0 ? '' : cookie.slice(sep + 1);

    // Constant-time, and hashed to a fixed width first so a length difference does not throw and
    // does not leak. This comparison IS the CSRF defence.
    const a = crypto.createHash('sha256').update(state).digest();
    const b = crypto.createHash('sha256').update(cookieState).digest();
    if (!state || !cookieState || !crypto.timingSafeEqual(a, b)) {
      throw new OAuthError('state_mismatch', 'This consent did not start in this browser. Start again.');
    }
    if (!verifier) throw new OAuthError('no_verifier', 'The consent cookie is malformed. Start again.');

    const accountId = state.slice(0, state.indexOf('.'));
    if (!accountId) throw new OAuthError('bad_state', 'The consent state is malformed. Start again.');

    const res = await this.f(TOKEN_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        code,
        client_id: this.clientId,
        client_secret: this.clientSecret,
        redirect_uri: this.redirectUri,
        grant_type: 'authorization_code',
        code_verifier: verifier,
      }).toString(),
    });
    const body = (await res.json().catch(() => ({}))) as Record<string, any>;
    if (!res.ok) throw googleError(body, 'Google refused the authorization code.');

    if (!body.refresh_token) {
      // prompt=consent above should make this impossible. It is still checked, because storing an
      // account with no refresh token produces a connector that works until the access token
      // expires an hour later and then fails forever.
      throw new OAuthError('no_refresh_token', 'Google returned no refresh token. Revoke this app at myaccount.google.com/permissions and connect again.');
    }

    const accessToken = String(body.access_token ?? '');
    return {
      accountId,
      grant: {
        refreshToken: String(body.refresh_token),
        accessToken,
        expiresIn: Number(body.expires_in ?? 3600),
        email: await this.email(accessToken).catch(() => null),
      },
    };
  }

  /** Which Google account consented. Best-effort: a connector still works without it. */
  async email(accessToken: string): Promise<string | null> {
    if (!accessToken) return null;
    const res = await this.f(USERINFO_URL, { headers: { Authorization: `Bearer ${accessToken}` } });
    if (!res.ok) return null;
    const body = (await res.json().catch(() => ({}))) as Record<string, any>;
    return body?.email ? String(body.email) : null;
  }

  /** Exchange a stored refresh token for a usable access token. */
  async refresh(refreshToken: string): Promise<{ accessToken: string; expiresIn: number }> {
    const res = await this.f(TOKEN_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        client_id: this.clientId,
        client_secret: this.clientSecret,
        refresh_token: refreshToken,
        grant_type: 'refresh_token',
      }).toString(),
    });
    const body = (await res.json().catch(() => ({}))) as Record<string, any>;
    if (!res.ok) throw googleError(body, 'Google refused the refresh token.');
    return { accessToken: String(body.access_token ?? ''), expiresIn: Number(body.expires_in ?? 3600) };
  }

  /**
   * End the grant at Google. This is the half that deleting a row cannot do, and the reason
   * deletion is a two-step operation in db.ts: until this succeeds, the credential is live and
   * belongs to a row that is on its way out.
   *
   * Google answers 200 for a token it has already forgotten, so a repeat is not an error — which is
   * what makes the reaper safe to retry.
   */
  async revoke(token: string): Promise<void> {
    if (!token) return;
    const res = await this.f(REVOKE_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ token }).toString(),
    });
    if (res.ok) return;
    const body = (await res.json().catch(() => ({}))) as Record<string, any>;
    // A token Google no longer knows is already in the state we wanted.
    if (String(body?.error ?? '') === 'invalid_token') return;
    throw googleError(body, 'Google refused to revoke the token.');
  }
}

/**
 * The cookie the consent rides in. Deliberately NOT SameSite=Strict: Google's callback is a
 * top-level cross-site GET, and Strict withholds the cookie on exactly that navigation — the flow
 * then fails at the state check every time, on a server that looks correctly configured. Lax sends
 * it on a top-level GET and withholds it everywhere else, which is what is wanted.
 */
export const CONSENT_COOKIE = 'g2a_consent';

export const consentCookie = (value: string, secure: boolean): string =>
  // Ten minutes: long enough to read a consent screen, short enough that an abandoned flow leaves
  // nothing behind. Scoped to the callback path so it is not sent with any other request.
  `${CONSENT_COOKIE}=${encodeURIComponent(value)}; Path=/oauth/google; Max-Age=600; HttpOnly; SameSite=Lax${secure ? '; Secure' : ''}`;

export const clearConsentCookie = (secure: boolean): string =>
  `${CONSENT_COOKIE}=; Path=/oauth/google; Max-Age=0; HttpOnly; SameSite=Lax${secure ? '; Secure' : ''}`;

/** Read one cookie from a Cookie header without pulling in a parser. */
export function readCookie(header: string | undefined, name: string): string {
  for (const part of (header ?? '').split(';')) {
    const i = part.indexOf('=');
    if (i < 0) continue;
    if (part.slice(0, i).trim() === name) return decodeURIComponent(part.slice(i + 1).trim());
  }
  return '';
}
