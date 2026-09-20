#!/usr/bin/env node
// Mint a Google OAuth refresh token for GOOGLE2AI. Run it ONCE, on your own machine, as the Google
// account that owns the Search Console property; put what it prints into `fly secrets set`.
//
// Why this exists rather than a line in the README: the consent flow needs a redirect URI that
// Google will accept, and http://localhost on a random port is the only one that works without
// hosting a page. Doing it by hand means pasting a code out of a browser URL bar, which is where
// people lose the `&scope=` suffix and get an invalid_grant an hour later.
//
//   node scripts/get-refresh-token.mjs --client-id=... --client-secret=...
//
// It listens on a FIXED loopback port (8765 by default, --port=N to change), because a Web
// application client only accepts redirect URIs registered on it exactly, port included. A Desktop
// client would accept any loopback port and need none registered -- if you have one of those, this
// still works, the registration is simply unnecessary. Register this on the Web client:
//
//   http://127.0.0.1:8765/callback
//   http://localhost:8765/callback      (register both; which one Google accepts has varied)
//
// The token it prints does not expire on a schedule. It stops working if the Google account's
// password changes, if consent is withdrawn, or -- the one that catches people -- if the OAuth
// client is still in "Testing" on the consent screen, where refresh tokens expire after 7 days.
// Publish the app (no verification is needed while you are the only user) or expect to re-run this.
import http from 'node:http';
import crypto from 'node:crypto';

const arg = (name) => {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : process.env[name.toUpperCase().replace(/-/g, '_')] || '';
};

const clientId = arg('client-id');
const clientSecret = arg('client-secret');
const port = Number(arg('port') || 8765);
if (!clientId || !clientSecret) {
  console.error('Usage: node scripts/get-refresh-token.mjs --client-id=... --client-secret=...\n');
  console.error('Create the client in Google Cloud Console -> APIs & Services -> Credentials ->');
  console.error('Create credentials -> OAuth client ID.');
  console.error('');
  console.error('  Desktop app       accepts any loopback port; nothing to register.');
  console.error('  Web application   register http://127.0.0.1:8765/callback as an authorised');
  console.error('                    redirect URI (and http://localhost:8765/callback alongside it).');
  process.exit(2);
}

// Must match src/google-oauth.ts SCOPES. A token minted with less than the server asks for fails
// later at the first write, with an error about the scope rather than about the tool.
const SCOPE = [
  'https://www.googleapis.com/auth/webmasters',
  'https://www.googleapis.com/auth/indexing',
  'openid',
  'email',
].join(' ');
const state = crypto.randomBytes(16).toString('hex');

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://127.0.0.1');
  if (url.pathname !== '/callback') {
    res.writeHead(404).end('not found');
    return;
  }
  const done = (msg) => {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' }).end(`<!doctype html><meta charset="utf-8"><body style="font:16px system-ui;margin:4rem auto;max-width:34rem">${msg}</body>`);
  };

  // Checked before the code is spent: without it any page you visit could drive this callback.
  if (url.searchParams.get('state') !== state) {
    done('<h1>Mismatched state</h1><p>Start again.</p>');
    console.error('\nstate did not match — ignoring this callback');
    return;
  }
  const err = url.searchParams.get('error');
  if (err) {
    done(`<h1>Refused</h1><p>${err}</p>`);
    console.error(`\nGoogle refused consent: ${err}`);
    server.close();
    process.exit(1);
  }

  const body = new URLSearchParams({
    code: url.searchParams.get('code') ?? '',
    client_id: clientId,
    client_secret: clientSecret,
    redirect_uri: redirectUri,
    grant_type: 'authorization_code',
  });
  const r = await fetch('https://oauth2.googleapis.com/token', { method: 'POST', body });
  const j = await r.json();

  if (!j.refresh_token) {
    done('<h1>No refresh token</h1><p>Check the terminal.</p>');
    // Google issues a refresh token only on the FIRST consent for a client unless prompt=consent is
    // sent, which this script always sends — so reaching here usually means something stripped it.
    console.error('\nGoogle returned no refresh_token. Response:\n', JSON.stringify(j, null, 2));
    console.error('\nIf this account has consented to this client before, revoke it at');
    console.error('https://myaccount.google.com/permissions and run this again.');
    server.close();
    process.exit(1);
  }

  done('<h1>Done</h1><p>The refresh token is in your terminal. You can close this tab.</p>');
  console.log('\n─────────────────────────────────────────────────────────────');
  console.log('fly secrets set \\');
  console.log(`  GOOGLE_CLIENT_ID="${clientId}" \\`);
  console.log(`  GOOGLE_CLIENT_SECRET="${clientSecret}" \\`);
  console.log(`  GOOGLE_REFRESH_TOKEN="${j.refresh_token}" \\`);
  console.log(`  GOOGLE_QUOTA_PROJECT="your-project-id" -a google2ai`);
  console.log('\nThe write tools stay OFF until you also set GSC_ALLOW_WRITE=true. This token can');
  console.log('submit and delete sitemaps and add and remove properties, so that switch is the');
  console.log('difference between a connector that reads and one that can remove a property.');
  console.log('─────────────────────────────────────────────────────────────');
  console.log('\nGOOGLE_QUOTA_PROJECT is not optional with user credentials: Search Console answers');
  console.log('403 without it. Use the project where you enabled the Search Console API.');
  server.close();
  process.exit(0);
});

let redirectUri = '';
server.on('error', (e) => {
  if (e.code === 'EADDRINUSE') {
    // Named rather than left as a stack trace: a fixed port is the price of a Web client, and
    // something else holding it is the one failure that has nothing to do with Google.
    console.error(`\nPort ${port} is already in use. Close whatever is using it, or pass --port=N`);
    console.error('and register http://127.0.0.1:N/callback on the OAuth client to match.');
    process.exit(1);
  }
  throw e;
});
server.listen(port, '127.0.0.1', () => {
  redirectUri = `http://127.0.0.1:${port}/callback`;
  const consent = new URL('https://accounts.google.com/o/oauth2/v2/auth');
  consent.search = new URLSearchParams({
    client_id: clientId,
    redirect_uri: redirectUri,
    response_type: 'code',
    scope: SCOPE,
    // Both are load-bearing. offline is what asks for a refresh token at all; consent forces one to
    // be issued even if this account already approved this client, which is the difference between
    // this working the second time and printing nothing.
    access_type: 'offline',
    prompt: 'consent',
    state,
  }).toString();

  console.log('\nOpen this in a browser, signed in as the Google account that owns the property:\n');
  console.log(consent.toString());
  console.log(`\nThis must be registered on the client EXACTLY, port and path included: ${redirectUri}`);
  console.log("(A Desktop client needs no registration. A Web application client does, and Google's");
  console.log('changes can take a few minutes to take effect.)');
  console.log('\nWaiting for the callback…');
});
