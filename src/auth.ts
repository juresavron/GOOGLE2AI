// Supabase Auth (GoTrue) over its REST API, plus the cookie session.
//
// Called from the server rather than from a browser SDK, for two reasons: this project has no build
// step, so there is no bundle to put an SDK in; and keeping the access token in an httpOnly cookie
// means no script on the page can read it, which is not true of the SDK's localStorage default.
//
// `fetch` is injected so every path here is testable without a network — the tests drive a fake that
// returns GoTrue's real response shapes.
import crypto from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';

export interface SessionUser {
  id: string;
  email: string;
}

export interface SignInOk {
  ok: true;
  accessToken: string;
  refreshToken: string;
  expiresIn: number;
}
export interface SignInErr {
  ok: false;
  error: string;
}

export type Fetch = (url: string, init?: { method?: string; headers?: Record<string, string>; body?: string }) => Promise<{
  ok: boolean;
  status: number;
  json(): Promise<unknown>;
}>;

/** The cookie the session lives in. Prefixed so it cannot be set by a parent domain over plain HTTP. */
export const COOKIE = 'g2a_session';

export class Auth {
  private readonly url: string;
  private readonly anonKey: string;
  private readonly f: Fetch;

  constructor(url: string, anonKey: string, f: Fetch = fetch as unknown as Fetch) {
    this.url = url.replace(/\/+$/, '');
    this.anonKey = anonKey;
    this.f = f;
  }

  get configured(): boolean {
    return Boolean(this.url && this.anonKey);
  }

  private headers(token?: string): Record<string, string> {
    const h: Record<string, string> = { apikey: this.anonKey, 'Content-Type': 'application/json' };
    if (token) h.Authorization = `Bearer ${token}`;
    return h;
  }

  async signUp(email: string, password: string): Promise<SignInOk | SignInErr> {
    const res = await this.f(`${this.url}/auth/v1/signup`, {
      method: 'POST',
      headers: this.headers(),
      body: JSON.stringify({ email, password }),
    });
    const body = (await res.json().catch(() => ({}))) as Record<string, any>;
    if (!res.ok) return { ok: false, error: message(body, 'Could not create the account.') };
    // With email confirmation on (Supabase's default) there is no session yet: the user must click
    // the link first. Saying so is the difference between "it silently did nothing" and a clear next
    // step, and it is the most common confusion on a fresh project.
    if (!body.access_token) return { ok: false, error: 'Account created. Check your email for the confirmation link, then sign in.' };
    return session(body);
  }

  async signIn(email: string, password: string): Promise<SignInOk | SignInErr> {
    const res = await this.f(`${this.url}/auth/v1/token?grant_type=password`, {
      method: 'POST',
      headers: this.headers(),
      body: JSON.stringify({ email, password }),
    });
    const body = (await res.json().catch(() => ({}))) as Record<string, any>;
    // Deliberately one message for every failure. Distinguishing "no such account" from "wrong
    // password" turns this form into a way to test whether an address is registered here.
    if (!res.ok || !body.access_token) return { ok: false, error: 'Wrong email or password.' };
    return session(body);
  }

  /**
   * Who this token belongs to, asked of GoTrue rather than decoded locally. Verifying the JWT here
   * would mean holding the project's signing secret and reimplementing its checks; asking costs one
   * request and is correct by construction, including for tokens revoked since they were issued.
   */
  async user(accessToken: string): Promise<SessionUser | null> {
    if (!accessToken) return null;
    const res = await this.f(`${this.url}/auth/v1/user`, { headers: this.headers(accessToken) });
    if (!res.ok) return null;
    const body = (await res.json().catch(() => ({}))) as Record<string, any>;
    return body?.id ? { id: String(body.id), email: String(body.email ?? '') } : null;
  }

  /**
   * Ask GoTrue to email a recovery link. Returns NOTHING, deliberately: the caller shows the same
   * answer either way, because a form that says "no such account" is a way to test which addresses
   * are registered here — the same reason signIn has one message for every failure.
   */
  async recover(email: string, redirectTo: string): Promise<void> {
    if (!email) return;
    await this.f(`${this.url}/auth/v1/recover?redirect_to=${encodeURIComponent(redirectTo)}`, {
      method: 'POST',
      headers: this.headers(),
      body: JSON.stringify({ email }),
    }).catch(() => undefined);
  }

  /**
   * Set a new password using the token from a recovery link. That token IS the session GoTrue
   * issued — PUT /user returns the user rather than a new session, so it is what the caller signs
   * the browser in with afterwards.
   */
  async setPassword(accessToken: string, password: string): Promise<SignInOk | SignInErr> {
    if (!accessToken) return { ok: false, error: 'That link is missing its token. Ask for a new one.' };
    const res = await this.f(`${this.url}/auth/v1/user`, {
      method: 'PUT',
      headers: this.headers(accessToken),
      body: JSON.stringify({ password }),
    });
    const body = (await res.json().catch(() => ({}))) as Record<string, any>;
    if (!res.ok) return { ok: false, error: message(body, 'That link has expired. Ask for a new one.') };
    return { ok: true, accessToken, refreshToken: '', expiresIn: 3600 };
  }

  async signOut(accessToken: string): Promise<void> {
    // Best effort: the cookie is cleared regardless, so a failure here cannot strand a signed-in user.
    await this.f(`${this.url}/auth/v1/logout`, { method: 'POST', headers: this.headers(accessToken) }).catch(() => undefined);
  }
}

const session = (b: Record<string, any>): SignInOk => ({
  ok: true,
  accessToken: String(b.access_token),
  refreshToken: String(b.refresh_token ?? ''),
  expiresIn: Number(b.expires_in ?? 3600),
});

/** GoTrue reports errors under several keys depending on the endpoint and version. */
const message = (b: Record<string, any>, fallback: string): string => {
  const m = b?.msg ?? b?.message ?? b?.error_description ?? b?.error;
  return typeof m === 'string' && m ? m : fallback;
};

// ------------------------------------------------------------------ cookies

/** Minimal cookie parsing — one cookie is not worth a dependency. */
export function readCookie(req: IncomingMessage, name: string): string {
  const raw = req.headers.cookie;
  if (!raw) return '';
  for (const part of raw.split(';')) {
    const i = part.indexOf('=');
    if (i < 0) continue;
    if (part.slice(0, i).trim() === name) return decodeURIComponent(part.slice(i + 1).trim());
  }
  return '';
}

/**
 * httpOnly so no script can read the token; SameSite=Lax so a cross-site form POST does not carry it,
 * which is what stands in for CSRF tokens on the forms here; Secure whenever the request arrived over
 * HTTPS — behind Fly it always does, and omitting it on plain HTTP keeps local development working.
 */
export function setSession(res: ServerResponse, token: string, maxAgeSeconds: number, secure: boolean): void {
  const bits = [
    `${COOKIE}=${encodeURIComponent(token)}`,
    'Path=/',
    'HttpOnly',
    'SameSite=Lax',
    `Max-Age=${Math.max(0, Math.floor(maxAgeSeconds))}`,
  ];
  if (secure) bits.push('Secure');
  res.setHeader('Set-Cookie', bits.join('; '));
}

export function clearSession(res: ServerResponse, secure: boolean): void {
  const bits = [`${COOKIE}=`, 'Path=/', 'HttpOnly', 'SameSite=Lax', 'Max-Age=0'];
  if (secure) bits.push('Secure');
  res.setHeader('Set-Cookie', bits.join('; '));
}

/**
 * A fixed-window attempt counter, keyed by whatever the caller decides identifies an attempt.
 *
 * The sign-in form had none, which on a service that reads somebody's WhatsApp is the one place a
 * password guesser gets unlimited tries. In-process and approximate, and MORE approximate here than
 * in whatsapp2ai, where this came from: that app pins itself to one machine because a WhatsApp
 * session lives on its volume, so its counter is the whole truth. GOOGLE2AI is stateless and scales
 * across machines, so each one keeps its own count and the real budget is the limit times the
 * machine count.
 *
 * Left in-process anyway, for now, because it degrades the right way — N times the budget rather
 * than none — and because the alternative is a Redis for one counter. If sign-in abuse ever becomes
 * real, the fix is Postgres (which this deployment already has) rather than a new dependency.
 *
 * Windows are fixed rather than sliding because the failure mode of a fixed window — twice the
 * budget across a boundary — is irrelevant at these numbers, and a sliding window costs a list per
 * key instead of a counter.
 */
export class Attempts {
  private readonly max: number;
  private readonly windowMs: number;
  private readonly m = new Map<string, { n: number; until: number }>();

  constructor(max = 10, windowMs = 15 * 60_000) {
    this.max = max;
    this.windowMs = windowMs;
  }

  /** True when this key is out of attempts. Counts the attempt as it answers. */
  tooMany(key: string): boolean {
    const now = Date.now();
    // Swept on write rather than on a timer: the map only grows while requests arrive, so the work
    // is proportional to the traffic that caused it and there is no interval to keep a process alive.
    if (this.m.size > 10_000) for (const [k, v] of this.m) if (v.until <= now) this.m.delete(k);
    const hit = this.m.get(key);
    if (!hit || hit.until <= now) {
      this.m.set(key, { n: 1, until: now + this.windowMs });
      return false;
    }
    hit.n += 1;
    return hit.n > this.max;
  }

  /** Forget a key — called after a success, so one wrong password does not count against the next. */
  clear(key: string): void {
    this.m.delete(key);
  }
}

/**
 * The plaintext connector token, held for exactly one page load.
 *
 * Creating a token used to RENDER the dashboard rather than redirect, because the token is shown once
 * and only its hash is stored — a redirect appeared to lose the one thing worth showing. The cost was
 * that the browser stayed on a POST: every refresh re-submitted the form and minted another live
 * credential, which is what "every refresh a new connector appears" was. Post/Redirect/Get is the fix,
 * and this carries the secret across the redirect without putting it in the URL, in history, or in a
 * log — the URL carries an opaque id that works once, for the user who made it, for two minutes.
 */
export class OneShot {
  private readonly m = new Map<string, { token: string; userId: string; at: number }>();
  private readonly ttlMs: number;

  constructor(ttlMs = 120_000) {
    this.ttlMs = ttlMs;
  }

  put(userId: string, token: string): string {
    if (this.m.size > 500) this.m.clear();
    const id = crypto.randomBytes(9).toString('base64url');
    this.m.set(id, { token, userId, at: Date.now() });
    return id;
  }

  take(userId: string, id: string): string | null {
    const hit = this.m.get(id);
    if (!hit) return null;
    // Deleted before it is checked: a mismatch or an expiry must still consume the id, or it stays
    // guessable for as long as someone keeps trying.
    this.m.delete(id);
    if (hit.userId !== userId || Date.now() - hit.at > this.ttlMs) return null;
    return hit.token;
  }
}
