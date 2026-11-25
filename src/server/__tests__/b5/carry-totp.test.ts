import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { createCipheriv, createHash, createHmac, randomBytes } from "node:crypto";
import { assertDisposableDb, cleanupPeople, createStaff, dbEnabled, runId } from "@/server/__tests__/helpers/fixtures";
import { resetEnvCache } from "@/server/lib/env";

/**
 * Lazy TOTP re-wrap at staff sign-in (doc 22 §32.9, B4 recheck P3-2),
 * against the disposable database. A secret stored by the pre-B4 code
 * (key derived from the JWT secret) signs in while the temporary
 * TOTP_LEGACY_ENCRYPTION_SECRET is set and is re-encrypted under
 * TOTP_ENCRYPTION_KEY in the same flow, audited with ids only. A wrong code
 * re-wraps nothing; without the variable nothing changes.
 */

const run = runId();
const savedLegacy = process.env.TOTP_LEGACY_ENCRYPTION_SECRET;
let prisma: typeof import("@/server/lib/db").prisma;
let auth: typeof import("@/server/services/auth.service").authService;
let crypto: typeof import("@/server/lib/crypto");
let session: typeof import("@/server/lib/session");
let jwtSecret: string;

/** RFC 6238 code computed independently of the app's helper. */
function totpCode(secretB32: string, at = Date.now()): string {
  const buf = Buffer.alloc(8);
  buf.writeBigUInt64BE(BigInt(Math.floor(at / 1000 / 30)));
  const h = createHmac("sha1", crypto.base32Decode(secretB32)).update(buf).digest();
  const o = h[h.length - 1] & 0x0f;
  const n = ((h[o] & 0x7f) << 24) | (h[o + 1] << 16) | (h[o + 2] << 8) | h[o + 3];
  return String(n % 1_000_000).padStart(6, "0");
}

/** The v1 value the pre-B4 code wrote without TOTP_ENCRYPTION_KEY: AES-256-GCM under sha256("totp:" + JWT secret). */
function legacyWrap(plain: string): string {
  const iv = randomBytes(12);
  const c = createCipheriv("aes-256-gcm", createHash("sha256").update(`totp:${jwtSecret}`).digest(), iv);
  const enc = Buffer.concat([c.update(plain, "utf8"), c.final()]);
  return `v1.${iv.toString("base64url")}.${c.getAuthTag().toString("base64url")}.${enc.toString("base64url")}`;
}

function setLegacy(value: string | undefined) {
  if (value === undefined) delete process.env.TOTP_LEGACY_ENCRYPTION_SECRET;
  else process.env.TOTP_LEGACY_ENCRYPTION_SECRET = value;
  resetEnvCache();
}

async function legacyAdmin(label: string) {
  const s = await createStaff(run, label, ["admin"]);
  const secret = crypto.generateTotpSecret();
  const stored = legacyWrap(secret);
  await prisma.adminUser.update({ where: { id: s.id }, data: { totpSecretEncrypted: stored } });
  const pendingToken = await session.signPendingToken({ sub: s.id, stage: "totp" });
  return { s, secret, stored, pendingToken };
}

async function storedOf(id: string) {
  return (await prisma.adminUser.findUniqueOrThrow({ where: { id }, select: { totpSecretEncrypted: true } })).totpSecretEncrypted!;
}

describe.skipIf(!dbEnabled)("B5 carry-over: lazy TOTP re-wrap at sign-in (recheck P3-2)", () => {
  beforeAll(async () => {
    assertDisposableDb();
    prisma = (await import("@/server/lib/db")).prisma;
    auth = (await import("@/server/services/auth.service")).authService;
    crypto = await import("@/server/lib/crypto");
    session = await import("@/server/lib/session");
    const { env } = await import("@/server/lib/env");
    jwtSecret = env().AUTH_JWT_SECRET;
    expect(env().TOTP_ENCRYPTION_KEY, "the test database environment sets TOTP_ENCRYPTION_KEY").toBeTruthy();
  });

  afterEach(() => setLegacy(savedLegacy));

  afterAll(async () => {
    setLegacy(savedLegacy);
    if (prisma) await cleanupPeople(run);
  });

  it("a legacy-wrapped secret signs in and is re-wrapped under the current key, audited by ids only", async () => {
    setLegacy(jwtSecret);
    const { s, secret, stored, pendingToken } = await legacyAdmin("legacy-ok");
    expect(() => crypto.decryptSecret(stored)).toThrow();

    const r = await auth.completeTotp({ pendingToken, code: totpCode(secret) });
    expect(r.sessionId).toBeTruthy();

    const after = await storedOf(s.id);
    expect(after).not.toBe(stored);
    expect(crypto.decryptSecret(after)).toBe(secret);
    expect(crypto.openTotpSecret(after)).toEqual({ secret, legacy: false });

    const rows = await prisma.auditLog.findMany({ where: { action: "auth.totp_rewrapped", entityId: s.id } });
    expect(rows).toHaveLength(1);
    const text = JSON.stringify(rows[0], (_k, v) => (typeof v === "bigint" ? v.toString() : v));
    expect(text).not.toContain(secret);
    expect(text).not.toContain(stored);
    expect(text).not.toContain(after);

    // Works without the variable from now on.
    setLegacy(undefined);
    const next = await auth.completeTotp({ pendingToken: await session.signPendingToken({ sub: s.id, stage: "totp" }), code: totpCode(secret, Date.now() + 30_000) });
    expect(next.sessionId).toBeTruthy();
    expect(await prisma.auditLog.count({ where: { action: "auth.totp_rewrapped", entityId: s.id } })).toBe(1);
  });

  it("a wrong code with the legacy secret fails and re-wraps nothing", async () => {
    setLegacy(jwtSecret);
    const { s, secret, stored, pendingToken } = await legacyAdmin("legacy-wrong");
    const good = totpCode(secret);
    const bad = good === "000000" ? "000001" : "000000";
    await expect(auth.completeTotp({ pendingToken, code: bad })).rejects.toMatchObject({ status: 401 });
    expect(await storedOf(s.id)).toBe(stored);
    expect(await prisma.auditLog.count({ where: { action: "auth.totp_rewrapped", entityId: s.id } })).toBe(0);
    expect(await prisma.auditLog.count({ where: { action: "auth.totp_failed", entityId: s.id } })).toBe(1);
  });

  it("without the legacy variable behaviour is unchanged: the legacy value cannot be read and stays as it was", async () => {
    setLegacy(undefined);
    const { s, secret, stored, pendingToken } = await legacyAdmin("legacy-off");
    await expect(auth.completeTotp({ pendingToken, code: totpCode(secret) })).rejects.toThrow();
    expect(await storedOf(s.id)).toBe(stored);
    expect(await prisma.adminSession.count({ where: { adminUserId: s.id } })).toBe(1); // the fixture's own session only
    expect(await prisma.auditLog.count({ where: { action: "auth.totp_rewrapped", entityId: s.id } })).toBe(0);
  });

  it("a secret already under the current key is never re-wrapped, with or without the variable", async () => {
    setLegacy(jwtSecret);
    const s = await createStaff(run, "current-key", ["admin"]);
    const secret = crypto.generateTotpSecret();
    const stored = crypto.encryptSecret(secret);
    await prisma.adminUser.update({ where: { id: s.id }, data: { totpSecretEncrypted: stored } });
    await auth.completeTotp({ pendingToken: await session.signPendingToken({ sub: s.id, stage: "totp" }), code: totpCode(secret) });
    expect(await storedOf(s.id)).toBe(stored);
    expect(await prisma.auditLog.count({ where: { action: "auth.totp_rewrapped", entityId: s.id } })).toBe(0);
  });
});
