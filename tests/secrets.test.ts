import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import crypto from 'node:crypto';
import { checkMasterKey, CryptoError, generateMasterKey, open, seal, VERSION } from '../src/secrets.ts';

const MASTER = generateMasterKey();
const ACCOUNT = '11111111-1111-4111-8111-111111111111';
const OTHER = '22222222-2222-4222-8222-222222222222';
const TOKEN = '1//0gRefreshTokenLooksLikeThis-and_is~long';

test('a sealed secret round-trips', () => {
  assert.equal(open(MASTER, ACCOUNT, seal(MASTER, ACCOUNT, TOKEN)), TOKEN);
});

test('nothing recognisable survives into the stored row', () => {
  const s = seal(MASTER, ACCOUNT, TOKEN);
  const flat = JSON.stringify(s);
  assert.ok(!flat.includes(TOKEN));
  assert.ok(!flat.includes(MASTER));
  assert.ok(!flat.includes('RefreshToken'));
  assert.equal(s.v, VERSION);
});

test('sealing twice produces different ciphertext', () => {
  const a = seal(MASTER, ACCOUNT, TOKEN);
  const b = seal(MASTER, ACCOUNT, TOKEN);
  // Equal ciphertexts would mean a reused nonce, which in GCM is catastrophic rather than untidy.
  assert.notEqual(a.ct, b.ct);
  assert.notEqual(a.n, b.n);
  assert.notEqual(a.wk, b.wk);
});

test('a ciphertext cannot be replayed into another account', () => {
  const s = seal(MASTER, ACCOUNT, TOKEN);
  // The whole point of binding the account id as AAD: a leaked row lifted into a different
  // account must not decrypt there.
  assert.throws(() => open(MASTER, OTHER, s), CryptoError);
});

test('the wrong master key does not open it, and says nothing about which failure it was', () => {
  const s = seal(MASTER, ACCOUNT, TOKEN);
  try {
    open(generateMasterKey(), ACCOUNT, s);
    assert.fail('should not have opened');
  } catch (e) {
    assert.ok(e instanceof CryptoError);
    assert.doesNotMatch(String((e as Error).message), /tamper/i, 'must not tell an attacker which half failed');
    assert.doesNotMatch(String((e as Error).message), new RegExp(TOKEN));
  }
});

test('tampering with any field is detected', () => {
  for (const field of ['ct', 'n', 'wk', 'wn'] as const) {
    const s = seal(MASTER, ACCOUNT, TOKEN);
    const bytes = Buffer.from(s[field], 'base64url');
    bytes[0] ^= 0xff;
    s[field] = bytes.toString('base64url');
    assert.throws(() => open(MASTER, ACCOUNT, s), CryptoError, `flipping a bit in ${field} must not go unnoticed`);
  }
});

test('a short or missing master key is refused before anything is stored', () => {
  assert.throws(() => seal('', ACCOUNT, TOKEN), CryptoError);
  assert.throws(() => seal('dG9vLXNob3J0', ACCOUNT, TOKEN), CryptoError);
  // The message has to say how to make a correct one; this is a deployment-time mistake.
  try {
    seal('', ACCOUNT, TOKEN);
  } catch (e) {
    assert.match(String((e as Error).message), /openssl rand -base64 32/);
    // Both paths refuse a key for the same reason, so they must offer the same remedy: two
    // different commands for one condition is how somebody decides they are two problems.
    assert.equal(String((e as Error).message).includes('openssl rand -base64 32'), String(checkMasterKey('dG9vLXNob3J0')).includes('openssl rand -base64 32'));
  }
});

test('an unknown seal version is refused rather than misread', () => {
  const s = { ...seal(MASTER, ACCOUNT, TOKEN), v: 99 };
  assert.throws(() => open(MASTER, ACCOUNT, s), CryptoError);
});

test('empty and unicode secrets round-trip', () => {
  for (const secret of ['', 'ключ', '🔑 ključ', 'x'.repeat(4096)]) {
    assert.equal(open(MASTER, ACCOUNT, seal(MASTER, ACCOUNT, secret)), secret);
  }
});


test('checkMasterKey catches a key that is present but the wrong shape', () => {
  assert.equal(checkMasterKey(generateMasterKey()), null, 'a real key passes');
  assert.equal(checkMasterKey(`  ${generateMasterKey()}  `), null, 'whitespace on paste is tolerated');

  assert.match(String(checkMasterKey('')), /not set/);
  assert.match(String(checkMasterKey('   ')), /not set/);

  // The case that actually happened: set, non-empty, boots fine, then throws on the first consent
  // AFTER Google has authorised the user. Base64url decoding is lenient, so a short or malformed
  // value decodes to fewer bytes rather than failing — the length check is what catches it.
  for (const bad of ['hunter2', 'dG9vLXNob3J0', generateMasterKey().slice(0, 20)]) {
    const problem = checkMasterKey(bad);
    assert.ok(problem, `"${bad}" must be rejected`);
    assert.match(problem, /must be exactly 32/);
    assert.match(problem, /43 characters/, 'says what a correct one looks like');
    assert.match(problem, /openssl rand -base64 32/, 'and how to make one');
  }
});

test('a key generated as hex is read as hex, not misread as 48 bytes', () => {
  // The one that reached production. `openssl rand -hex 32` is the most common way to make 32
  // random bytes, and every hex character is ALSO a valid base64url character — so its output does
  // not fail to decode, it silently decodes to 48 bytes of something else and the server refuses
  // to boot on 256 perfectly good bits.
  const hex = crypto.randomBytes(32).toString('hex');
  assert.equal(hex.length, 64);
  assert.equal(Buffer.from(hex, 'base64url').length, 48, 'the trap this guards against still exists');

  assert.equal(checkMasterKey(hex), null);
  assert.equal(open(hex, ACCOUNT, seal(hex, ACCOUNT, TOKEN)), TOKEN);
  // Case and stray whitespace are how it arrives from a terminal or a paste, not a different key.
  assert.equal(checkMasterKey(hex.toUpperCase()), null);
  assert.equal(checkMasterKey(`\n${hex}\n`), null);
  assert.equal(open(`\n${hex}\n`, ACCOUNT, seal(hex, ACCOUNT, TOKEN)), TOKEN, 'and it is the SAME key either way');
});

test('48 bytes is still refused, and the message names the near miss', () => {
  // `openssl rand -base64 48` — the other way to arrive at 48, and the one hex support must not
  // start silently accepting.
  const tooBig = crypto.randomBytes(48).toString('base64url');
  const problem = String(checkMasterKey(tooBig));
  assert.match(problem, /decodes to 48 bytes/);
  assert.match(problem, /asked for 48 instead of 32/, 'points at the command, not the docs');
  assert.throws(() => seal(tooBig, ACCOUNT, TOKEN), CryptoError);
});

test('the boot check and the seal path never disagree about a key', () => {
  // Two decoders would produce the worst failure available here: a server that boots reporting a
  // good key and then cannot read a single credential. Asserted as an equivalence over every shape
  // that has actually turned up, rather than trusting that both call the same helper.
  const candidates = [
    generateMasterKey(),
    crypto.randomBytes(32).toString('hex'),
    crypto.randomBytes(32).toString('base64'), // openssl rand -base64 32: padded, other alphabet
    `  ${generateMasterKey()}\n`,
    crypto.randomBytes(48).toString('base64url'),
    crypto.randomBytes(32).toString('hex').slice(0, 63),
    crypto.randomBytes(16).toString('hex'),
    'correct horse battery staple',
    '',
  ];
  for (const k of candidates) {
    const accepted = checkMasterKey(k) === null;
    let seals = true;
    try {
      open(k, ACCOUNT, seal(k, ACCOUNT, TOKEN));
    } catch {
      seals = false;
    }
    assert.equal(accepted, seals, `boot check and seal disagree about a ${k.length}-character key`);
  }
});

test('checkMasterKey proves a round-trip, not just a length', () => {
  // 32 bytes of the right length that still cannot seal would pass a length check alone.
  const real = generateMasterKey();
  assert.equal(checkMasterKey(real), null);
  assert.equal(open(real, 'id', seal(real, 'id', 'x')), 'x');
});
