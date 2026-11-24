import { afterEach, describe, expect, it, vi } from "vitest";
import { randomBytes } from "node:crypto";
import { activeKeyId, decryptSecret, encryptSecret, KeyUnavailableError, openTotpSecret, ringKeyIds, setKeyRingsForTests } from "../crypto";
import { resetEnvCache } from "../env";

/**
 * Lazy TOTP re-wrap support (doc 22 §32.9, recheck P3-2) and the ring key id
 * helpers the re-wrap job uses (R-B4-10).
 */

const JWT = "u".repeat(32);
const SECRET = "JBSWY3DPEHPK3PXP";

function stubEnv(appEnv: "development" | "production", vars: { totpKey?: string; legacy?: string } = {}) {
  vi.stubEnv("DATABASE_URL", "postgresql://unit@127.0.0.1:1/none");
  vi.stubEnv("AUTH_JWT_SECRET", JWT);
  vi.stubEnv("AUTH_COOKIE_SECRET", "c".repeat(32));
  vi.stubEnv("APP_ENV", appEnv);
  vi.stubEnv("TOTP_ENCRYPTION_KEY", vars.totpKey);
  vi.stubEnv("TOTP_LEGACY_ENCRYPTION_SECRET", vars.legacy);
  resetEnvCache();
}

/** A secret as the pre-B4 code stored it: no TOTP_ENCRYPTION_KEY, so the key derived from the JWT secret. */
function legacyWrapped(): string {
  stubEnv("development");
  return encryptSecret(SECRET);
}

afterEach(() => {
  setKeyRingsForTests(null);
  vi.unstubAllEnvs();
  resetEnvCache();
});

describe("openTotpSecret", () => {
  it("a value under TOTP_ENCRYPTION_KEY opens directly and is not marked legacy", () => {
    stubEnv("production", { totpKey: "explicit-production-totp-key-material", legacy: JWT });
    expect(openTotpSecret(encryptSecret(SECRET))).toEqual({ secret: SECRET, legacy: false });
  });

  it("a legacy value opens with the temporary legacy secret and is marked for re-wrap", () => {
    const stored = legacyWrapped();
    stubEnv("production", { totpKey: "explicit-production-totp-key-material", legacy: JWT });
    expect(() => decryptSecret(stored)).toThrow();
    const opened = openTotpSecret(stored);
    expect(opened).toEqual({ secret: SECRET, legacy: true });
    // What the caller stores after a matching code opens under the current key.
    expect(openTotpSecret(encryptSecret(opened.secret))).toEqual({ secret: SECRET, legacy: false });
  });

  it("without the legacy variable a legacy value is refused, as before", () => {
    const stored = legacyWrapped();
    stubEnv("production", { totpKey: "explicit-production-totp-key-material" });
    expect(() => openTotpSecret(stored)).toThrow();
  });

  it("a wrong legacy secret is refused with the original error", () => {
    const stored = legacyWrapped();
    stubEnv("production", { totpKey: "explicit-production-totp-key-material", legacy: "not-the-old-jwt-secret-".repeat(2) });
    expect(() => openTotpSecret(stored)).toThrow();
  });

  it("production never falls back to the JWT secret: without TOTP_ENCRYPTION_KEY the legacy variable is ignored", () => {
    const stored = legacyWrapped();
    stubEnv("production", { legacy: JWT });
    expect(() => openTotpSecret(stored)).toThrow(KeyUnavailableError);
  });
});

describe("ring key ids", () => {
  it("activeKeyId is the first entry; ringKeyIds lists every key, active first", () => {
    stubEnv("development");
    const k = () => randomBytes(32).toString("base64");
    setKeyRingsForTests({ ticket_codes: `k2:${k()},k1:${k()}` });
    expect(activeKeyId("ticket_codes")).toBe("k2");
    expect(ringKeyIds("ticket_codes")).toEqual(["k2", "k1"]);
    setKeyRingsForTests({ ticket_codes: null });
    expect(() => ringKeyIds("ticket_codes")).toThrow(KeyUnavailableError);
  });
});
