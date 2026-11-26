import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { randomBytes } from "node:crypto";
import {
  ciphertextKeyId,
  decryptFor,
  decryptSecret,
  encryptFor,
  encryptSecret,
  rewrapLegacyTotpSecret,
  hmacCandidates,
  hmacFor,
  KeyUnavailableError,
  keyRingProblems,
  needsRewrap,
  parseKeyRing,
  rewrapFor,
  setKeyRingsForTests,
} from "../crypto";
import { assertBootEnv, resetEnvCache } from "../env";

/**
 * Key hierarchy (PRV-5, doc 22 B4): purpose-separated rings, key id in the
 * ciphertext, rotation by re-wrap, keyed hashes with rotation candidates, and
 * no key derived from the JWT secret in production.
 */

const k = () => randomBytes(32).toString("base64");

function stubEnv(appEnv: "development" | "production") {
  vi.stubEnv("DATABASE_URL", "postgresql://unit@127.0.0.1:1/none");
  vi.stubEnv("AUTH_JWT_SECRET", "u".repeat(32));
  vi.stubEnv("AUTH_COOKIE_SECRET", "c".repeat(32));
  vi.stubEnv("APP_ENV", appEnv);
  resetEnvCache();
}

afterEach(() => {
  setKeyRingsForTests(null);
  vi.unstubAllEnvs();
  resetEnvCache();
});

describe("encryptFor / decryptFor", () => {
  beforeEach(() => stubEnv("development"));

  it("round-trips and names the purpose and active key id in the ciphertext", () => {
    setKeyRingsForTests({ ticket_codes: `k2:${k()},k1:${k()}` });
    const c = encryptFor("ticket_codes", "SYNTH-CODE-0001");
    expect(c.startsWith("v2.ticket_codes.k2.")).toBe(true);
    expect(c).not.toContain("SYNTH-CODE-0001");
    expect(ciphertextKeyId(c)).toBe("k2");
    expect(decryptFor("ticket_codes", c)).toBe("SYNTH-CODE-0001");
  });

  it("uses a fresh IV for every encryption", () => {
    setKeyRingsForTests({ ticket_codes: `k1:${k()}` });
    expect(encryptFor("ticket_codes", "same")).not.toBe(encryptFor("ticket_codes", "same"));
  });

  it("refuses a value of another purpose, even with the same key material", () => {
    const shared = k();
    setKeyRingsForTests({ ticket_codes: `k1:${shared}`, recovery: `k1:${shared}` });
    const c = encryptFor("recovery", "secret");
    expect(() => decryptFor("ticket_codes", c)).toThrow(/another purpose/);
    // Relabelling the purpose breaks the authentication tag (purpose is associated data).
    const relabelled = c.replace("v2.recovery.", "v2.ticket_codes.");
    expect(() => decryptFor("ticket_codes", relabelled)).toThrow();
  });

  it("refuses a relabelled key id and a tampered body", () => {
    const a = k();
    setKeyRingsForTests({ ticket_codes: `k2:${a},k1:${a}` });
    const c = encryptFor("ticket_codes", "secret");
    expect(() => decryptFor("ticket_codes", c.replace(".k2.", ".k1."))).toThrow();
    const parts = c.split(".");
    parts[5] = Buffer.from("tampered").toString("base64url");
    expect(() => decryptFor("ticket_codes", parts.join("."))).toThrow();
  });

  it("rotates: an old key still decrypts, rewrap moves the value to the active key", () => {
    const old = k();
    setKeyRingsForTests({ ticket_codes: `k1:${old}` });
    const c1 = encryptFor("ticket_codes", "rotate-me");
    setKeyRingsForTests({ ticket_codes: `k2:${k()},k1:${old}` });
    expect(needsRewrap("ticket_codes", c1)).toBe(true);
    expect(decryptFor("ticket_codes", c1)).toBe("rotate-me");
    const c2 = rewrapFor("ticket_codes", c1);
    expect(ciphertextKeyId(c2)).toBe("k2");
    expect(needsRewrap("ticket_codes", c2)).toBe(false);
    expect(rewrapFor("ticket_codes", c2)).toBe(c2);
  });

  it("after the old key is dropped, only the re-wrapped value opens", () => {
    const old = k();
    const active = k();
    setKeyRingsForTests({ ticket_codes: `k1:${old}` });
    const c1 = encryptFor("ticket_codes", "rotate-me");
    setKeyRingsForTests({ ticket_codes: `k2:${active},k1:${old}` });
    const c2 = rewrapFor("ticket_codes", c1);
    setKeyRingsForTests({ ticket_codes: `k2:${active}` });
    expect(decryptFor("ticket_codes", c2)).toBe("rotate-me");
    expect(() => decryptFor("ticket_codes", c1)).toThrow(KeyUnavailableError);
  });

  it("a value under a key no longer in the ring is refused", () => {
    setKeyRingsForTests({ ticket_codes: `k1:${k()}` });
    const c = encryptFor("ticket_codes", "x");
    setKeyRingsForTests({ ticket_codes: `k2:${k()}` });
    expect(() => decryptFor("ticket_codes", c)).toThrow(KeyUnavailableError);
  });
});

describe("parseKeyRing", () => {
  it("rejects malformed rings instead of dropping a key", () => {
    expect(() => parseKeyRing("ticket_codes", "")).toThrow(KeyUnavailableError);
    expect(() => parseKeyRing("ticket_codes", `K1:${k()}`)).toThrow(/key id/);
    expect(() => parseKeyRing("ticket_codes", `k1:${k()},k1:${k()}`)).toThrow(/duplicate/);
    expect(() => parseKeyRing("ticket_codes", `k1:${Buffer.alloc(16).toString("base64")}`)).toThrow(/32 bytes/);
    expect(parseKeyRing("ticket_codes", ` k2:${k()} , k1:${k()} `).map((r) => r.id)).toEqual(["k2", "k1"]);
  });
});

describe("hmacFor / hmacCandidates", () => {
  beforeEach(() => stubEnv("development"));

  it("is keyed and purpose-separated", () => {
    const shared = k();
    setKeyRingsForTests({ lookup: `k1:${shared}`, ticket_code_hash: `k1:${shared}` });
    const a = hmacFor("lookup", "+971500000000");
    expect(a).toMatch(/^[0-9a-f]{64}$/);
    expect(hmacFor("ticket_code_hash", "+971500000000")).not.toBe(a);
    setKeyRingsForTests({ lookup: `k1:${k()}` });
    expect(hmacFor("lookup", "+971500000000")).not.toBe(a);
  });

  it("offers every ring key's hash during a rotation, active first", () => {
    const old = k();
    setKeyRingsForTests({ lookup: `k1:${old}` });
    const before = hmacFor("lookup", "a@example.test");
    setKeyRingsForTests({ lookup: `k2:${k()},k1:${old}` });
    const candidates = hmacCandidates("lookup", "a@example.test");
    expect(candidates).toHaveLength(2);
    expect(candidates[0]).toBe(hmacFor("lookup", "a@example.test"));
    expect(candidates[1]).toBe(before);
  });
});

describe("no JWT-derived key in production (PRV-5)", () => {
  it("development falls back to a per-purpose derived key with id `dev`", () => {
    stubEnv("development");
    for (const v of ["OUTLY_KEYS_TICKET_CODES", "OUTLY_KEYS_RECOVERY"]) vi.stubEnv(v, undefined);
    resetEnvCache();
    const c = encryptFor("ticket_codes", "dev-value");
    expect(ciphertextKeyId(c)).toBe("dev");
    expect(decryptFor("ticket_codes", c)).toBe("dev-value");
    // Different purposes derive different keys.
    expect(() => decryptFor("recovery", c.replace("v2.ticket_codes.", "v2.recovery."))).toThrow();
  });

  it("production refuses an unset ring and reports it at boot", () => {
    stubEnv("production");
    vi.stubEnv("OUTLY_KEYS_TICKET_CODES", undefined);
    resetEnvCache();
    expect(() => encryptFor("ticket_codes", "x")).toThrow(KeyUnavailableError);
    expect(() => hmacFor("lookup", "x")).toThrow(KeyUnavailableError);
    expect(keyRingProblems().some((p) => p.startsWith("OUTLY_KEYS_TICKET_CODES"))).toBe(true);
    expect(assertBootEnv().some((p) => p.startsWith("OUTLY_KEYS_TICKET_CODES"))).toBe(true);
  });

  it("production uses a configured ring", () => {
    stubEnv("production");
    vi.stubEnv("OUTLY_KEYS_TICKET_CODES", `p1:${k()}`);
    resetEnvCache();
    expect(ciphertextKeyId(encryptFor("ticket_codes", "x"))).toBe("p1");
    expect(keyRingProblems().some((p) => p.startsWith("OUTLY_KEYS_TICKET_CODES"))).toBe(false);
  });

  it("a test override of null makes a purpose unconfigured even outside production", () => {
    stubEnv("development");
    setKeyRingsForTests({ ticket_codes: null });
    expect(() => encryptFor("ticket_codes", "x")).toThrow(KeyUnavailableError);
  });

  it("TOTP secrets: production needs TOTP_ENCRYPTION_KEY; development keeps its derived key", () => {
    stubEnv("development");
    vi.stubEnv("TOTP_ENCRYPTION_KEY", undefined);
    resetEnvCache();
    expect(decryptSecret(encryptSecret("JBSWY3DPEHPK3PXP"))).toBe("JBSWY3DPEHPK3PXP");

    stubEnv("production");
    vi.stubEnv("TOTP_ENCRYPTION_KEY", undefined);
    resetEnvCache();
    expect(() => encryptSecret("JBSWY3DPEHPK3PXP")).toThrow(KeyUnavailableError);

    vi.stubEnv("TOTP_ENCRYPTION_KEY", "explicit-production-totp-key-material");
    resetEnvCache();
    expect(decryptSecret(encryptSecret("JBSWY3DPEHPK3PXP"))).toBe("JBSWY3DPEHPK3PXP");
  });

  it("a legacy derived-key TOTP secret can be re-wrapped once under TOTP_ENCRYPTION_KEY (R-B4-3)", () => {
    // Written by the old code: development, no TOTP_ENCRYPTION_KEY, so the JWT-derived key.
    stubEnv("development");
    vi.stubEnv("TOTP_ENCRYPTION_KEY", undefined);
    resetEnvCache();
    const legacy = encryptSecret("JBSWY3DPEHPK3PXP");

    stubEnv("production");
    vi.stubEnv("TOTP_ENCRYPTION_KEY", undefined);
    resetEnvCache();
    expect(() => rewrapLegacyTotpSecret(legacy, "u".repeat(32))).toThrow(KeyUnavailableError);

    vi.stubEnv("TOTP_ENCRYPTION_KEY", "explicit-production-totp-key-material");
    resetEnvCache();
    expect(() => decryptSecret(legacy)).toThrow();
    const rewrapped = rewrapLegacyTotpSecret(legacy, "u".repeat(32));
    expect(decryptSecret(rewrapped)).toBe("JBSWY3DPEHPK3PXP");
    expect(rewrapLegacyTotpSecret(rewrapped, "u".repeat(32))).toBe(rewrapped);
    expect(() => rewrapLegacyTotpSecret(legacy, "wrong-secret-".repeat(3))).toThrow();
  });
});
