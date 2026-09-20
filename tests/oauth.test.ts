import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import crypto from 'node:crypto';
import { clearConsentCookie, consentCookie, CONSENT_COOKIE, GoogleOAuth, OAuthError, readCookie, SCOPES, type Fetch } from '../src/google-oauth.ts';

const ACCOUNT = '33333333-3333-4333-8333-333333333333';
const REDIRECT = 'https://google2ai.fly.dev/oauth/google/callback';

/** A fake Google. Records what was sent and answers with its real response shapes. */
class FakeGoogle {
  sent: { url: string; body: URLSearchParams; headers: Record<string, string> }[] = [];
  replies: { ok: boolean; status: number; body: unknown }[] = [];

  reply(body: unknown, ok = true, status = ok ? 200 : 400) {
    this.replies.push({ ok, status, body });
    return this;
  }

  fetch: Fetch = async (url, init) => {
    this.sent.push({ url, body: new URLSearchParams(init?.body ?? ''), headers: init?.headers ?? {} });
    const r = this.replies.shift() ?? { ok: true, status: 200, body: {} };
    return { ok: r.ok, status: r.status, json: async () => r.body, text: async () => JSON.stringify(r.body) };
  };
}

const make = (g: FakeGoogle) => new GoogleOAuth('client-id', 'client-secret', REDIRECT, g.fetch);

const GOOD_TOKEN = { access_token: 'ya29.access', refresh_token: '1//0refresh', expires_in: 3599, scope: SCOPES.join(' ') };

test('begin asks for the things that make a refresh token arrive at all', () => {
  const { url } = make(new FakeGoogle()).begin(ACCOUNT);
  const p = new URL(url).searchParams;

  assert.equal(p.get('access_type'), 'offline', 'without this Google issues no refresh token');
  // Without prompt=consent, an account that already approved this client gets a token response
  // with no refresh_token in it — so re-connecting silently produces a dead connector.
  assert.equal(p.get('prompt'), 'consent');
  assert.equal(p.get('response_type'), 'code');
  assert.equal(p.get('redirect_uri'), REDIRECT);
  assert.deepEqual(p.get('scope')?.split(' '), SCOPES);
});

test('begin uses PKCE, and the challenge really is S256 of the verifier', () => {
  const { url, cookie } = make(new FakeGoogle()).begin(ACCOUNT);
  const p = new URL(url).searchParams;
  const verifier = cookie.slice(cookie.lastIndexOf(':') + 1);

  assert.equal(p.get('code_challenge_method'), 'S256');
  assert.equal(p.get('code_challenge'), crypto.createHash('sha256').update(verifier).digest('base64url'));
  // A plain challenge would be no protection at all, and Google accepts "plain" if asked.
  assert.notEqual(p.get('code_challenge'), verifier);
});

test('the verifier never appears in the URL — only its hash does', () => {
  const { url, cookie } = make(new FakeGoogle()).begin(ACCOUNT);
  const verifier = cookie.slice(cookie.lastIndexOf(':') + 1);
  assert.ok(!url.includes(verifier), 'a verifier in the redirect URL defeats the whole point of PKCE');
});

test('two consents never share a state or a verifier', () => {
  const o = make(new FakeGoogle());
  const a = o.begin(ACCOUNT);
  const b = o.begin(ACCOUNT);
  assert.notEqual(a.cookie, b.cookie);
  assert.notEqual(new URL(a.url).searchParams.get('state'), new URL(b.url).searchParams.get('state'));
});

test('a completed consent yields the grant and the account it belongs to', async () => {
  const g = new FakeGoogle().reply(GOOD_TOKEN).reply({ email: 'jure@example.com' });
  const o = make(g);
  const { cookie } = o.begin(ACCOUNT);
  const state = cookie.slice(0, cookie.lastIndexOf(':'));

  const { accountId, grant } = await o.complete({ code: 'auth-code', state, cookie });
  assert.equal(accountId, ACCOUNT);
  assert.equal(grant.refreshToken, '1//0refresh');
  assert.equal(grant.email, 'jure@example.com');

  const token = g.sent[0]!;
  assert.equal(token.body.get('grant_type'), 'authorization_code');
  assert.equal(token.body.get('code'), 'auth-code');
  // The verifier is what proves this exchange belongs to the browser that started the flow.
  assert.equal(token.body.get('code_verifier'), cookie.slice(cookie.lastIndexOf(':') + 1));
});

test('a callback that did not start in this browser is refused WITHOUT spending the code', async () => {
  const g = new FakeGoogle().reply(GOOD_TOKEN);
  const o = make(g);
  const mine = o.begin(ACCOUNT);
  const attacker = o.begin(ACCOUNT);
  const attackerState = attacker.cookie.slice(0, attacker.cookie.lastIndexOf(':'));

  // The classic CSRF: the victim's browser is made to follow a callback carrying the ATTACKER's
  // code and state. The victim's cookie is the one thing the attacker cannot supply.
  await assert.rejects(() => o.complete({ code: 'attacker-code', state: attackerState, cookie: mine.cookie }), (e: unknown) => {
    assert.ok(e instanceof OAuthError);
    assert.equal((e as OAuthError).code, 'state_mismatch');
    return true;
  });
  // A code can be exchanged exactly once, so a rejected callback that still called Google would
  // burn the real user's code and leave them an error they cannot act on.
  assert.equal(g.sent.length, 0, 'nothing may be sent to Google before the state check passes');
});

test('a callback with no cookie at all is refused, and spends nothing', async () => {
  const g = new FakeGoogle().reply(GOOD_TOKEN);
  const o = make(g);
  const { cookie } = o.begin(ACCOUNT);
  const state = cookie.slice(0, cookie.lastIndexOf(':'));

  await assert.rejects(() => o.complete({ code: 'c', state, cookie: '' }), /did not start in this browser/);
  assert.equal(g.sent.length, 0);
});

test('a missing code is refused before anything else', async () => {
  const g = new FakeGoogle();
  const o = make(g);
  const { cookie } = o.begin(ACCOUNT);
  await assert.rejects(() => o.complete({ code: '', state: cookie.slice(0, cookie.lastIndexOf(':')), cookie }), /did not return an authorization code/);
  assert.equal(g.sent.length, 0);
});

test('a token response with no refresh_token is an error, not a half-working account', async () => {
  const g = new FakeGoogle().reply({ access_token: 'ya29.only', expires_in: 3599 });
  const o = make(g);
  const { cookie } = o.begin(ACCOUNT);
  // Storing this produces a connector that works for an hour and then fails forever.
  await assert.rejects(() => o.complete({ code: 'c', state: cookie.slice(0, cookie.lastIndexOf(':')), cookie }), (e: unknown) => {
    assert.equal((e as OAuthError).code, 'no_refresh_token');
    assert.match((e as Error).message, /myaccount\.google\.com\/permissions/, 'says how to fix it');
    return true;
  });
});

test('invalid_grant explains the Testing-mode expiry, which is its usual cause', async () => {
  const g = new FakeGoogle().reply({ error: 'invalid_grant', error_description: 'Bad Request' }, false, 400);
  const o = make(g);
  const { cookie } = o.begin(ACCOUNT);
  await assert.rejects(() => o.complete({ code: 'c', state: cookie.slice(0, cookie.lastIndexOf(':')), cookie }), (e: unknown) => {
    assert.equal((e as OAuthError).code, 'invalid_grant');
    assert.match((e as Error).message, /Testing.*7 days/s);
    return true;
  });
});

test('redirect_uri_mismatch says what has to match', async () => {
  const g = new FakeGoogle().reply({ error: 'redirect_uri_mismatch' }, false, 400);
  const o = make(g);
  const { cookie } = o.begin(ACCOUNT);
  await assert.rejects(() => o.complete({ code: 'c', state: cookie.slice(0, cookie.lastIndexOf(':')), cookie }), /trailing slash/);
});

test('a failed userinfo lookup does not lose the grant', async () => {
  const g = new FakeGoogle().reply(GOOD_TOKEN).reply({ error: 'nope' }, false, 500);
  const o = make(g);
  const { cookie } = o.begin(ACCOUNT);
  const { grant } = await o.complete({ code: 'c', state: cookie.slice(0, cookie.lastIndexOf(':')), cookie });
  // The address is a convenience. Throwing it away is fine; throwing away the refresh token
  // because an optional lookup failed would not be.
  assert.equal(grant.email, null);
  assert.equal(grant.refreshToken, '1//0refresh');
});

test('refresh exchanges a stored token for an access token', async () => {
  const g = new FakeGoogle().reply({ access_token: 'ya29.new', expires_in: 3599 });
  const { accessToken } = await make(g).refresh('1//0refresh');
  assert.equal(accessToken, 'ya29.new');
  assert.equal(g.sent[0]!.body.get('grant_type'), 'refresh_token');
  assert.equal(g.sent[0]!.body.get('refresh_token'), '1//0refresh');
});

test('revoking a token Google has already forgotten is success, so the reaper can retry', async () => {
  const g = new FakeGoogle().reply({ error: 'invalid_token' }, false, 400);
  await assert.doesNotReject(() => make(g).revoke('1//0gone'));
});

test('revoke refuses silently for an empty token and complains for a real failure', async () => {
  const empty = new FakeGoogle();
  await make(empty).revoke('');
  assert.equal(empty.sent.length, 0, 'nothing to revoke, nothing sent');

  const broken = new FakeGoogle().reply({ error: 'internal_failure' }, false, 500);
  await assert.rejects(() => make(broken).revoke('1//0real'));
});

test('the consent cookie is httpOnly and Lax — Strict would break the callback', () => {
  const c = consentCookie('state:verifier', true);
  assert.match(c, /HttpOnly/);
  assert.match(c, /Secure/);
  // Google's callback is a top-level cross-site GET. SameSite=Strict withholds the cookie on
  // exactly that navigation, so the flow would fail its own state check every time.
  assert.match(c, /SameSite=Lax/);
  assert.doesNotMatch(c, /SameSite=Strict/);
  assert.match(c, /Path=\/oauth\/google/, 'not sent with any other request');
  assert.match(c, /Max-Age=600/);

  assert.match(clearConsentCookie(true), /Max-Age=0/);
  assert.doesNotMatch(consentCookie('x', false), /Secure/, 'a local http run must still work');
});

test('readCookie finds its own cookie among others and never a prefix of one', () => {
  const header = `other=1; ${CONSENT_COOKIE}=${encodeURIComponent('st:ve')}; ${CONSENT_COOKIE}_decoy=no`;
  assert.equal(readCookie(header, CONSENT_COOKIE), 'st:ve');
  assert.equal(readCookie('', CONSENT_COOKIE), '');
  assert.equal(readCookie(undefined, CONSENT_COOKIE), '');
  assert.equal(readCookie('malformed', CONSENT_COOKIE), '');
});

test('a state with no separator is refused, not silently truncated', async () => {
  const g = new FakeGoogle().reply(GOOD_TOKEN);
  const o = make(g);
  // Both sides agree, so the CSRF check passes and the parse is what has to catch this. Reading
  // the account id with slice(0, indexOf('.')) on a dotless state hands back the state minus its
  // last character — a wrong value rather than an absent one.
  const cookie = 'nodotatall:someverifier';
  await assert.rejects(() => o.complete({ code: 'c', state: 'nodotatall', cookie }), (e: unknown) => {
    assert.equal((e as OAuthError).code, 'bad_state');
    return true;
  });
  assert.equal(g.sent.length, 0, 'and it still spends no code');
});

test('a state that begins with the separator is refused too', async () => {
  const o = make(new FakeGoogle());
  await assert.rejects(() => o.complete({ code: 'c', state: '.nonce', cookie: '.nonce:verifier' }), /malformed/);
});

test('an unconfigured server says so rather than building a broken URL', () => {
  const o = new GoogleOAuth('', '', REDIRECT, new FakeGoogle().fetch);
  assert.equal(o.configured, false);
  assert.throws(() => o.begin(ACCOUNT), /not configured/);
});

test('a consent that leaves Search Console unticked is refused, not stored', async () => {
  // Google's consent screen shows ONE CHECKBOX PER SCOPE. Untick the Search Console one and the
  // consent still completes, still returns a refresh token, and still tells you which account
  // signed in — it just cannot see a single property. That arrived on the dashboard as "no
  // properties are visible", which reads as "wrong Google account" and is the wrong thing to go
  // and check.
  const g = new FakeGoogle();
  g.reply({ ...GOOD_TOKEN, scope: 'https://www.googleapis.com/auth/indexing openid email' });
  const o = make(g);
  const { cookie } = o.begin(ACCOUNT);

  await assert.rejects(
    () => o.complete({ code: 'c', state: cookie.slice(0, cookie.lastIndexOf(':')), cookie }),
    (e: unknown) => {
      assert.ok(e instanceof OAuthError);
      assert.equal((e as OAuthError).code, 'scope_declined');
      assert.match((e as Error).message, /View and manage Search Console data/, 'quotes the checkbox, so it can be found');
      return true;
    },
  );

  // And it is NOT revoked, which is deliberate and used to be the other way round.
  //
  // Google's /revoke ends the GRANT for a (client, Google account) pair rather than one token, so
  // tidying this dead token away would also kill every other refresh token that account holds for
  // this client — the person's other connections here, and the operator's own connector when it
  // runs as the same Google account. For a token that by definition has no Search Console scope,
  // that is a bad trade.
  assert.ok(!g.sent.some((x) => x.url.includes('/revoke')), 'revoking would take the account\u2019s other grants with it');
});

test('a token response with no scope field completes, rather than failing closed', async () => {
  // An absent `scope` is not evidence of a refusal. Failing closed on it would break every consent
  // if Google ever stopped sending the field, which is a worse failure than the one being guarded.
  const g = new FakeGoogle();
  const { scope: _dropped, ...noScope } = GOOD_TOKEN;
  g.reply(noScope).reply({ email: 'someone@example.com' });
  const o = make(g);
  const { cookie } = o.begin(ACCOUNT);

  const { grant } = await o.complete({ code: 'c', state: cookie.slice(0, cookie.lastIndexOf(':')), cookie });
  assert.equal(grant.refreshToken, GOOD_TOKEN.refresh_token);
  assert.ok(!g.sent.some((x) => x.url.includes('/revoke')), 'and nothing was revoked on a guess');
});

test('a consent granting Search Console but not indexing is still accepted', async () => {
  // Only the Search Console scope is load-bearing. request_indexing failing is a tool returning
  // Google's refusal; no Search Console scope is a connector that can do nothing at all.
  const g = new FakeGoogle();
  g.reply({ ...GOOD_TOKEN, scope: 'https://www.googleapis.com/auth/webmasters openid email' }).reply({ email: 'someone@example.com' });
  const o = make(g);
  const { cookie } = o.begin(ACCOUNT);

  const { grant } = await o.complete({ code: 'c', state: cookie.slice(0, cookie.lastIndexOf(':')), cookie });
  assert.equal(grant.email, 'someone@example.com');
});
