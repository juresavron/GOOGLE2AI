// Envelope encryption for a tenant's Google refresh token.
//
// A port of imap2ai's secrets_box.py, and it exists here for the same reason it exists there — with
// one difference in what is being protected that is worth stating, because it is exactly why
// whatsapp2ai has no equivalent file.
//
// whatsapp2ai cannot store its credential: a WhatsApp session is a Signal key store that Baileys
// rewrites continuously, so it lives on a volume and Postgres never sees it. imap2ai can: an IMAP
// password is a string. So is a Google refresh token — and it is a worse thing to leak than a
// mailbox password, because it is bearer-grade (no second factor applies to it) and it is silent
// (the owner sees nothing in their inbox).
//
// The design assumption is that the database WILL leak one day, and that this must not hand the
// attacker every customer's Search Console.
//
// Per credential:
//   - a fresh 256-bit data key is generated
//   - the token is sealed with AES-256-GCM under that data key
//   - the data key is itself sealed under the master key, and only the wrapped form is stored
//   - the account's id is bound in as additional authenticated data, so a ciphertext lifted from
//     one row cannot be replayed into another
//
// What lands in the database is therefore useless without MASTER_KEY, which lives only in the
// process environment (a Fly secret), never in the database and never in git.
import crypto from 'node:crypto';

const KEY_BYTES = 32; // AES-256
const NONCE_BYTES = 12; // GCM standard
export const VERSION = 1; // bumped if the scheme changes, so old rows stay readable

/** Exactly what is stored in the `sealed` jsonb column. */
export interface Sealed {
  v: number;
  wk: string; // the data key, wrapped under the master key
  wn: string; // nonce for that wrapping
  ct: string; // the ciphertext
  n: string; // nonce for the ciphertext
}

/** Never carries the plaintext, the key, or the ciphertext in its message. */
export class CryptoError extends Error {}

const b64 = (b: Buffer) => b.toString('base64url');
const unb64 = (s: string) => Buffer.from(s, 'base64url');

/** A new master key. Store as the MASTER_KEY secret. */
export const generateMasterKey = (): string => b64(crypto.randomBytes(KEY_BYTES));

const HEX_KEY = new RegExp(`^[0-9a-fA-F]{${KEY_BYTES * 2}}$`);

/**
 * The ONE place a MASTER_KEY string becomes bytes. Both the boot check and every seal/open go
 * through it, because two decoders that disagree would produce the worst failure available here: a
 * server that boots reporting a good key and then cannot read a single credential.
 *
 * Two encodings are accepted, and the hex one is not politeness:
 * `openssl rand -hex 32` is the most common way anybody generates 32 random bytes, and every hex
 * character is ALSO a valid base64url character — so its output does not fail to decode, it
 * silently decodes to 48 bytes of something else. A 64-character all-hex string has exactly one
 * reading that yields a usable key, so read it that way rather than refusing 256 perfectly good
 * bits over an encoding detail.
 *
 * Trimming happens here rather than in the callers for the same single-decoder reason: a key with
 * a trailing newline is still hex to the regex only if both sides trim identically.
 */
function decodeMasterKey(raw: string): Buffer {
  const s = (raw ?? '').trim();
  if (HEX_KEY.test(s)) return Buffer.from(s, 'hex');
  // Base64url decoding is lenient — it drops characters it does not recognise rather than
  // failing — so a key with stray characters decodes SHORT instead of raising, and the callers'
  // length check is what actually catches it.
  return unb64(s);
}

function masterKey(raw: string): Buffer {
  const key = decodeMasterKey(raw);
  // Checked here rather than at the first decrypt: a short key is a configuration mistake, and
  // finding out about it when a customer's connector stops working is too late.
  if (key.length !== KEY_BYTES) {
    // Same wording as checkMasterKey's, deliberately: two different remedies for one condition is
    // how somebody ends up believing they are two different problems.
    throw new CryptoError(`MASTER_KEY must decode to ${KEY_BYTES} bytes, as base64url (43 characters) or hex (64 characters). Generate one with: openssl rand -base64 32`);
  }
  return key;
}

const seal1 = (key: Buffer, plaintext: Buffer, aad?: Buffer) => {
  const nonce = crypto.randomBytes(NONCE_BYTES);
  const c = crypto.createCipheriv('aes-256-gcm', key, nonce, { authTagLength: 16 });
  if (aad) c.setAAD(aad);
  return { nonce, body: Buffer.concat([c.update(plaintext), c.final(), c.getAuthTag()]) };
};

const open1 = (key: Buffer, nonce: Buffer, body: Buffer, aad?: Buffer) => {
  if (body.length < 16) throw new CryptoError('Ciphertext is too short to be authentic.');
  const d = crypto.createDecipheriv('aes-256-gcm', key, nonce, { authTagLength: 16 });
  if (aad) d.setAAD(aad);
  d.setAuthTag(body.subarray(body.length - 16));
  return Buffer.concat([d.update(body.subarray(0, body.length - 16)), d.final()]);
};

/**
 * Check the key at STARTUP, not at first use.
 *
 * The boot check used to be `if (!MASTER_KEY) exit`, which only catches an absent key. A key that
 * is present but the wrong shape — too short, a password someone typed, a value truncated on
 * paste — passed that test, booted a server that looked entirely healthy, and then threw on the
 * first consent, AFTER Google had already authorised the user. The tenant sees "connected to
 * Google" followed by a failure they cannot act on, and the operator sees a green deploy.
 *
 * Returns the problem as a sentence, or null when the key is usable. Deliberately not a boolean:
 * "MASTER_KEY is wrong" is not an actionable thing to read at 3am.
 */
export function checkMasterKey(raw: string): string | null {
  const s = (raw ?? '').trim();
  if (!s) return 'MASTER_KEY is not set.';
  const key = decodeMasterKey(s);
  if (key.length !== KEY_BYTES) {
    // Name the near miss. "Wrong length" sends someone to re-read the docs; "you asked for 48"
    // sends them to the command they actually typed.
    const near =
      key.length === KEY_BYTES + 16
        ? ' A 48-byte value usually means the generator was asked for 48 instead of 32.'
        : key.length < KEY_BYTES
          ? ' A short value usually means the secret was truncated on paste.'
          : '';
    return `MASTER_KEY decodes to ${key.length} bytes and must be exactly ${KEY_BYTES}.${near} Either form is accepted: ${KEY_BYTES} random bytes as base64url (43 characters) or as hex (64 characters). Generate one with: openssl rand -base64 32`;
  }
  // Prove it round-trips rather than trusting the length. Cheap, and it is the actual property
  // every consent depends on.
  try {
    const probe = 'startup-probe';
    const id = '00000000-0000-4000-8000-000000000000';
    if (open(s, id, seal(s, id, probe)) !== probe) return 'MASTER_KEY did not round-trip a test value.';
  } catch (e) {
    return `MASTER_KEY is unusable: ${e instanceof Error ? e.message : String(e)}`;
  }
  return null;
}

/** Seal a secret for one account. `accountId` is bound in and must be passed back to open it. */
export function seal(master: string, accountId: string, secret: string): Sealed {
  const mk = masterKey(master);
  const dataKey = crypto.randomBytes(KEY_BYTES);
  const aad = Buffer.from(accountId, 'utf8');
  const body = seal1(dataKey, Buffer.from(secret, 'utf8'), aad);
  const wrapped = seal1(mk, dataKey, aad);
  // The data key never leaves this function in the clear.
  dataKey.fill(0);
  return { v: VERSION, wk: b64(wrapped.body), wn: b64(wrapped.nonce), ct: b64(body.body), n: b64(body.nonce) };
}

export function open(master: string, accountId: string, sealed: Sealed): string {
  const mk = masterKey(master);
  if (sealed?.v !== VERSION) throw new CryptoError(`Unknown seal version ${sealed?.v}; this build understands ${VERSION}.`);
  const aad = Buffer.from(accountId, 'utf8');
  let dataKey: Buffer;
  try {
    dataKey = open1(mk, unb64(sealed.wn), unb64(sealed.wk), aad);
  } catch {
    // One message for both failures, deliberately. Distinguishing "wrong master key" from
    // "tampered row" tells an attacker which of the two they achieved.
    throw new CryptoError('Could not unseal this credential: wrong MASTER_KEY, or the row does not belong to this account.');
  }
  try {
    return open1(dataKey, unb64(sealed.n), unb64(sealed.ct), aad).toString('utf8');
  } catch {
    throw new CryptoError('Could not unseal this credential: the stored ciphertext failed authentication.');
  } finally {
    dataKey.fill(0);
  }
}
