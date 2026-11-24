import "server-only";
import {
  createCipheriv,
  createDecipheriv,
  createHash,
  createHmac,
  randomBytes,
  randomInt,
  scryptSync,
  timingSafeEqual,
} from "node:crypto";
import { env } from "./env";

/**
 * Cryptographic primitives — all from node:crypto, no native dependencies.
 *
 * Deviation from §13.2.2 (Argon2id): scrypt is used for admin passwords because
 * the argon2 packages need a native binary that complicates Windows dev and
 * serverless builds. scrypt with N=2^15 is an accepted OWASP alternative;
 * swapping to Argon2id later is a change to `hashPassword`/`verifyPassword`
 * only — the stored format is self-describing.
 */

/* ---------------------------------------------------------------------------
 * Passwords
 * ------------------------------------------------------------------------ */

const SCRYPT = { N: 1 << 15, r: 8, p: 1, keylen: 64 };

export function hashPassword(password: string): string {
  const salt = randomBytes(16);
  const hash = scryptSync(password.normalize("NFKC"), salt, SCRYPT.keylen, {
    N: SCRYPT.N,
    r: SCRYPT.r,
    p: SCRYPT.p,
    maxmem: 128 * SCRYPT.N * SCRYPT.r * 2,
  });
  return `scrypt$${SCRYPT.N}$${SCRYPT.r}$${SCRYPT.p}$${salt.toString("base64")}$${hash.toString("base64")}`;
}

export function verifyPassword(password: string, stored: string): boolean {
  try {
    const [algo, n, r, p, saltB64, hashB64] = stored.split("$");
    if (algo !== "scrypt") return false;
    const N = Number(n);
    const expected = Buffer.from(hashB64, "base64");
    const actual = scryptSync(password.normalize("NFKC"), Buffer.from(saltB64, "base64"), expected.length, {
      N,
      r: Number(r),
      p: Number(p),
      maxmem: 128 * N * Number(r) * 2,
    });
    return timingSafeEqual(actual, expected);
  } catch {
    return false;
  }
}

/* ---------------------------------------------------------------------------
 * Hashing, HMAC, tokens
 * ------------------------------------------------------------------------ */

export function sha256Hex(input: string | Buffer): string {
  return createHash("sha256").update(input).digest("hex");
}

export function hmacSha256Hex(key: string | Buffer, input: string | Buffer): string {
  return createHmac("sha256", key).update(input).digest("hex");
}

export function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ab.length !== bb.length) return false;
  return timingSafeEqual(ab, bb);
}

/** IP is stored hashed with a server-side pepper, never raw (§13.7.2). */
export function hashIp(ip: string | null | undefined): string | undefined {
  if (!ip) return undefined;
  return hmacSha256Hex(env().AUTH_COOKIE_SECRET, ip).slice(0, 32);
}

export function randomToken(bytes = 32): string {
  return randomBytes(bytes).toString("base64url");
}

export function randomPassword(length = 20): string {
  const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZabcdefghjkmnpqrstuvwxyz23456789!@#$%";
  let out = "";
  for (let i = 0; i < length; i++) out += alphabet[randomInt(alphabet.length)];
  return out;
}

/* ---------------------------------------------------------------------------
 * TOTP (RFC 6238) — mandatory admin MFA (AC-SEC-02)
 * ------------------------------------------------------------------------ */

const B32 = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";

export function base32Encode(buf: Buffer): string {
  let bits = 0;
  let value = 0;
  let out = "";
  for (const byte of buf) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += B32[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += B32[(value << (5 - bits)) & 31];
  return out;
}

export function base32Decode(str: string): Buffer {
  const clean = str.toUpperCase().replace(/[^A-Z2-7]/g, "");
  let bits = 0;
  let value = 0;
  const out: number[] = [];
  for (const ch of clean) {
    value = (value << 5) | B32.indexOf(ch);
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 255);
      bits -= 8;
    }
  }
  return Buffer.from(out);
}

export function generateTotpSecret(): string {
  return base32Encode(randomBytes(20));
}

function hotp(secret: Buffer, counter: number, digits = 6): string {
  const buf = Buffer.alloc(8);
  buf.writeBigUInt64BE(BigInt(counter));
  const hmac = createHmac("sha1", secret).update(buf).digest();
  const offset = hmac[hmac.length - 1] & 0x0f;
  const code =
    ((hmac[offset] & 0x7f) << 24) |
    ((hmac[offset + 1] & 0xff) << 16) |
    ((hmac[offset + 2] & 0xff) << 8) |
    (hmac[offset + 3] & 0xff);
  return String(code % 10 ** digits).padStart(digits, "0");
}

/** ±1 step (30s) tolerance. Constant-time compare on the code. */
export function verifyTotp(secretB32: string, code: string, now = Date.now()): boolean {
  const cleaned = code.replace(/\s+/g, "");
  if (!/^\d{6}$/.test(cleaned)) return false;
  const secret = base32Decode(secretB32);
  const step = Math.floor(now / 1000 / 30);
  for (const delta of [-1, 0, 1]) {
    if (safeEqual(hotp(secret, step + delta), cleaned)) return true;
  }
  return false;
}

export function totpUri(secretB32: string, accountEmail: string, issuer = "OUTLYY"): string {
  const label = encodeURIComponent(`${issuer}:${accountEmail}`);
  return `otpauth://totp/${label}?secret=${secretB32}&issuer=${encodeURIComponent(issuer)}&algorithm=SHA1&digits=6&period=30`;
}

/* ---------------------------------------------------------------------------
 * At-rest encryption for TOTP secrets — AES-256-GCM (format v1)
 * ------------------------------------------------------------------------ */

/**
 * TOTP_ENCRYPTION_KEY, or outside production a key derived from the JWT
 * secret so MFA works in every development environment. Production never
 * derives a key from the JWT secret (PRV-5): without TOTP_ENCRYPTION_KEY it
 * refuses, and `assertBootEnv` reports the missing key.
 */
function totpKey(): Buffer {
  const e = env();
  if (e.TOTP_ENCRYPTION_KEY) return createHash("sha256").update(e.TOTP_ENCRYPTION_KEY).digest();
  if (e.isProduction) throw new KeyUnavailableError("totp");
  return createHash("sha256").update(`totp:${e.AUTH_JWT_SECRET}`).digest();
}

export function encryptSecret(plain: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", totpKey(), iv);
  const enc = Buffer.concat([cipher.update(plain, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `v1.${iv.toString("base64url")}.${tag.toString("base64url")}.${enc.toString("base64url")}`;
}

export function decryptSecret(stored: string): string {
  const [v, ivB, tagB, encB] = stored.split(".");
  if (v !== "v1") throw new Error("Unknown secret format");
  const decipher = createDecipheriv("aes-256-gcm", totpKey(), Buffer.from(ivB, "base64url"));
  decipher.setAuthTag(Buffer.from(tagB, "base64url"));
  return Buffer.concat([decipher.update(Buffer.from(encB, "base64url")), decipher.final()]).toString("utf8");
}

/** Decrypts a v1 value with the key the pre-B4 code derived from a JWT secret. Never encrypts. */
function decryptWithLegacyTotpKey(stored: string, legacyJwtSecret: string): string {
  const [v, ivB, tagB, encB] = stored.split(".");
  if (v !== "v1") throw new Error("Unknown secret format");
  const legacy = createHash("sha256").update(`totp:${legacyJwtSecret}`).digest();
  const decipher = createDecipheriv("aes-256-gcm", legacy, Buffer.from(ivB, "base64url"));
  decipher.setAuthTag(Buffer.from(tagB, "base64url"));
  return Buffer.concat([decipher.update(Buffer.from(encB, "base64url")), decipher.final()]).toString("utf8");
}

/**
 * One-time migration for a deployment whose TOTP secrets were encrypted with
 * the old key derived from the JWT secret (R-B4-3). Decrypts `stored` with
 * that legacy key and re-encrypts it with TOTP_ENCRYPTION_KEY (required).
 * The caller passes the legacy JWT secret explicitly; nothing here reads it
 * as a fallback. A value already under TOTP_ENCRYPTION_KEY is returned
 * unchanged. Sign-in uses the lazy path instead (`openTotpSecret`).
 */
export function rewrapLegacyTotpSecret(stored: string, legacyJwtSecret: string): string {
  if (!env().TOTP_ENCRYPTION_KEY) throw new KeyUnavailableError("totp", "TOTP_ENCRYPTION_KEY must be set to re-wrap");
  try {
    decryptSecret(stored);
    return stored;
  } catch {
    // Not under the configured key: try the legacy derived key below.
  }
  return encryptSecret(decryptWithLegacyTotpKey(stored, legacyJwtSecret));
}

export interface OpenedTotpSecret {
  secret: string;
  /**
   * True when the value opened only under the temporary legacy key. The
   * caller verifies the code with `secret` and, only when it matches, stores
   * `encryptSecret(secret)` in its place (lazy re-wrap, recheck P3-2).
   */
  legacy: boolean;
}

/**
 * Opens a stored TOTP secret for a sign-in or step-up check (recheck P3-2).
 *
 * Under the configured key (TOTP_ENCRYPTION_KEY) the secret is returned as
 * is. Otherwise, and only while the temporary TOTP_LEGACY_ENCRYPTION_SECRET
 * is set (to the AUTH_JWT_SECRET value the old code derived its key from)
 * and TOTP_ENCRYPTION_KEY is set to re-wrap under, the legacy derived key is
 * tried. So no admin loses MFA across the deploy that stops deriving the key
 * from the JWT secret: each one is re-wrapped at their next sign-in, and the
 * variable is removed once all have signed in. The JWT secret itself is
 * never read here, and the legacy key never encrypts anything.
 *
 * Throws what `decryptSecret` threw when neither key opens the value.
 */
export function openTotpSecret(stored: string): OpenedTotpSecret {
  try {
    return { secret: decryptSecret(stored), legacy: false };
  } catch (first) {
    const e = env();
    const legacySecret = e.TOTP_LEGACY_ENCRYPTION_SECRET;
    if (!legacySecret || !e.TOTP_ENCRYPTION_KEY) throw first;
    try {
      return { secret: decryptWithLegacyTotpKey(stored, legacySecret), legacy: true };
    } catch {
      throw first;
    }
  }
}

/* ---------------------------------------------------------------------------
 * Key hierarchy for supplier, ticket and recovery data (PRV-5, doc 22 B4)
 *
 * One key ring per purpose, so a key for one kind of data never opens
 * another. Each ring comes from its own variable, `OUTLY_KEYS_<PURPOSE>`:
 *
 *     OUTLY_KEYS_TICKET_CODES="k2:<base64 32 bytes>,k1:<base64 32 bytes>"
 *
 * The first entry is the active key: it encrypts (and, for HMAC purposes,
 * hashes). Every listed key still decrypts, which is the rotation path: add
 * a new key in front, re-wrap stored values with `rewrapFor`, then drop the
 * old key. Key ids are 1–16 lowercase letters or digits.
 *
 * Ciphertext format v2: `v2.<purpose>.<keyId>.<iv>.<tag>.<data>` (base64url),
 * AES-256-GCM with `outly:v2:<purpose>:<keyId>` as associated data, so a
 * value cannot be moved to another purpose or relabelled with another key id.
 *
 * Production has no fallback: a missing or malformed ring throws
 * `KeyUnavailableError`, and `assertBootEnv` lists it. Outside production an
 * unset ring falls back to a key derived from AUTH_JWT_SECRET and the purpose
 * (key id `dev`), so development and tests need no setup.
 *
 * Values that are only ever compared (capability tokens, contact lookups,
 * suppression entries) are hashed, never encrypted: `hmacFor` with an HMAC
 * purpose, or `sha256Hex` for random tokens of at least 32 bytes.
 * ------------------------------------------------------------------------ */

/** Encryption purposes. Never reuse one purpose's ring for another kind of data. */
export const ENCRYPTION_PURPOSES = ["ticket_codes", "capability_tokens", "supplier_identifiers", "recovery"] as const;
/** HMAC purposes: keyed hashes for values that are only compared. */
export const HMAC_PURPOSES = ["lookup", "ticket_code_hash", "access_cookie"] as const;

export type EncryptionPurpose = (typeof ENCRYPTION_PURPOSES)[number];
export type HmacPurpose = (typeof HMAC_PURPOSES)[number];
export type KeyPurpose = EncryptionPurpose | HmacPurpose;

/** The variable that holds a purpose's ring. */
export function keyVariable(purpose: KeyPurpose): string {
  return `OUTLY_KEYS_${purpose.toUpperCase()}`;
}

export class KeyUnavailableError extends Error {
  readonly purpose: string;
  constructor(purpose: string, why = "no key configured") {
    super(`Encryption key for ${purpose} unavailable: ${why}`);
    this.name = "KeyUnavailableError";
    this.purpose = purpose;
  }
}

interface RingKey {
  id: string;
  key: Buffer;
}

const KEY_ID = /^[a-z0-9]{1,16}$/;

/** Parses a ring value. Throws on any malformed entry: a typo never silently drops a key. */
export function parseKeyRing(purpose: string, raw: string): RingKey[] {
  const out: RingKey[] = [];
  for (const part of raw.split(",").map((p) => p.trim()).filter(Boolean)) {
    const i = part.indexOf(":");
    const id = i > 0 ? part.slice(0, i) : "";
    if (!KEY_ID.test(id)) throw new KeyUnavailableError(purpose, "malformed key id");
    if (out.some((k) => k.id === id)) throw new KeyUnavailableError(purpose, "duplicate key id");
    const key = Buffer.from(part.slice(i + 1), "base64");
    if (key.length !== 32) throw new KeyUnavailableError(purpose, `key ${id} is not 32 bytes`);
    out.push({ id, key });
  }
  if (!out.length) throw new KeyUnavailableError(purpose, "empty key ring");
  return out;
}

let ringOverride: Partial<Record<KeyPurpose, string | null>> | null = null;

/**
 * Test seam: replaces ring values (`null` makes a purpose unconfigured, as if
 * in production). Pass `null` to restore the environment.
 */
export function setKeyRingsForTests(rings: Partial<Record<KeyPurpose, string | null>> | null) {
  ringOverride = rings;
}

function ringFor(purpose: KeyPurpose): RingKey[] {
  const e = env();
  const overridden = ringOverride && purpose in ringOverride;
  const raw = overridden ? ringOverride![purpose] : process.env[keyVariable(purpose)];
  if (raw && raw.trim()) return parseKeyRing(purpose, raw);
  // An override of null means "not configured", whatever the environment.
  if (overridden || e.isProduction) throw new KeyUnavailableError(purpose);
  return [{ id: "dev", key: createHash("sha256").update(`outly-dev-key:${purpose}:${e.AUTH_JWT_SECRET}`).digest() }];
}

function aad(purpose: string, keyId: string) {
  return Buffer.from(`outly:v2:${purpose}:${keyId}`, "utf8");
}

/** The id of the purpose's active key (the one `encryptFor` uses). */
export function activeKeyId(purpose: KeyPurpose): string {
  return ringFor(purpose)[0].id;
}

/** Every key id in the purpose's ring, active first. */
export function ringKeyIds(purpose: KeyPurpose): string[] {
  return ringFor(purpose).map((k) => k.id);
}

/** Encrypts with the purpose's active key. */
export function encryptFor(purpose: EncryptionPurpose, plain: string): string {
  const [active] = ringFor(purpose);
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", active.key, iv);
  cipher.setAAD(aad(purpose, active.id));
  const enc = Buffer.concat([cipher.update(plain, "utf8"), cipher.final()]);
  return ["v2", purpose, active.id, iv.toString("base64url"), cipher.getAuthTag().toString("base64url"), enc.toString("base64url")].join(".");
}

function splitV2(stored: string): { purpose: string; keyId: string; iv: Buffer; tag: Buffer; data: Buffer } {
  const parts = stored.split(".");
  if (parts.length !== 6 || parts[0] !== "v2") throw new Error("Unknown ciphertext format");
  return { purpose: parts[1], keyId: parts[2], iv: Buffer.from(parts[3], "base64url"), tag: Buffer.from(parts[4], "base64url"), data: Buffer.from(parts[5], "base64url") };
}

/** The key id a stored value was encrypted with. */
export function ciphertextKeyId(stored: string): string {
  return splitV2(stored).keyId;
}

/** Decrypts a v2 value of this purpose with whichever ring key it names. A value of another purpose is refused. */
export function decryptFor(purpose: EncryptionPurpose, stored: string): string {
  const c = splitV2(stored);
  if (c.purpose !== purpose) throw new Error("Ciphertext belongs to another purpose");
  const k = ringFor(purpose).find((r) => r.id === c.keyId);
  if (!k) throw new KeyUnavailableError(purpose, `key ${c.keyId} is not in the ring`);
  const decipher = createDecipheriv("aes-256-gcm", k.key, c.iv);
  decipher.setAAD(aad(purpose, c.keyId));
  decipher.setAuthTag(c.tag);
  return Buffer.concat([decipher.update(c.data), decipher.final()]).toString("utf8");
}

/** True when the value is not under the purpose's active key (rotation). */
export function needsRewrap(purpose: EncryptionPurpose, stored: string): boolean {
  return ciphertextKeyId(stored) !== ringFor(purpose)[0].id;
}

/** Re-encrypts under the active key; returns the value unchanged when it already is. */
export function rewrapFor(purpose: EncryptionPurpose, stored: string): string {
  return needsRewrap(purpose, stored) ? encryptFor(purpose, decryptFor(purpose, stored)) : stored;
}

/** Keyed hash with the purpose's active key (hex). */
export function hmacFor(purpose: HmacPurpose, value: string): string {
  return hmacSha256Hex(ringFor(purpose)[0].key, `${purpose}:${value}`);
}

/** The value's hash under every ring key, active first: match stored hashes against all of them during a rotation. */
export function hmacCandidates(purpose: HmacPurpose, value: string): string[] {
  return ringFor(purpose).map((k) => hmacSha256Hex(k.key, `${purpose}:${value}`));
}

/** Rings that are missing or malformed. Production boot reports these (`assertBootEnv`). */
export function keyRingProblems(): string[] {
  const problems: string[] = [];
  for (const purpose of [...ENCRYPTION_PURPOSES, ...HMAC_PURPOSES]) {
    try {
      ringFor(purpose);
    } catch (e) {
      problems.push(`${keyVariable(purpose)}: ${e instanceof Error ? e.message : "invalid"}`);
    }
  }
  return problems;
}
