import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { CryptoError, generateMasterKey, open, seal, VERSION } from '../src/secrets.ts';

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
    assert.match(String((e as Error).message), /randomBytes\(32\)/);
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
