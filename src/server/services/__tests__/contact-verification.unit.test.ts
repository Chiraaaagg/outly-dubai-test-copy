import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { contactHash, contactVerificationService, isVerificationChallengeSubject, normaliseContact } from "../contact-verification.service";

/**
 * Input rules of contact-verification.service.ts that are decided before any
 * read or send. Pure: the database module is replaced by one that throws, so
 * a refusal here proves nothing was touched. The flow itself runs against the
 * disposable database in src/server/__tests__/security/contact-verification.test.ts.
 */

vi.mock("../../lib/db", () => ({
  prisma: new Proxy({}, { get: () => { throw new Error("no database in this suite"); } }),
  TX_OPTIONS: {},
}));

const QUOTE = "01890000-0000-7000-8000-000000000001";
const GUEST = { kind: "guest" as const, guestSessionId: "01890000-0000-7000-8000-000000000002" };

describe("normaliseContact / contactHash", () => {
  it("phones must be international E.164; emails are trimmed and lower-cased", () => {
    expect(normaliseContact("phone", " +91 99000 00001 ")).toBe("+919900000001");
    expect(normaliseContact("phone", "9900000001")).toBeNull(); // no country code: ambiguous, refused
    expect(normaliseContact("phone", "+12")).toBeNull();
    expect(normaliseContact("email", "  Guest@Example.TEST ")).toBe("guest@example.test");
    expect(normaliseContact("email", "not-an-email")).toBeNull();
    expect(normaliseContact("email", `${"a".repeat(250)}@x.io`)).toBeNull();
  });

  it("the stored hash is sha256 hex of the normalised contact", () => {
    expect(contactHash("+919900000001")).toBe(createHash("sha256").update("+919900000001").digest("hex"));
    expect(contactHash("+919900000001")).toMatch(/^[0-9a-f]{64}$/);
  });

  it("verification subjects can never be mistaken for a sign-in phone", () => {
    expect(isVerificationChallengeSubject(`ocv:v1:${QUOTE}:phone:${"a".repeat(64)}`)).toBe(true);
    expect(isVerificationChallengeSubject("+919900000001")).toBe(false);
  });
});

describe("contactVerificationService input refusals", () => {
  it("start refuses an unknown channel or a malformed contact with a validation error", async () => {
    await expect(contactVerificationService.start({ ip: null, quoteId: QUOTE, channel: "phone", contact: "12345", owner: GUEST })).rejects.toMatchObject({ code: "VALIDATION_FAILED" });
    await expect(contactVerificationService.start({ ip: null, quoteId: QUOTE, channel: "email", contact: "nope", owner: GUEST })).rejects.toMatchObject({ code: "VALIDATION_FAILED" });
    await expect(contactVerificationService.start({ ip: null, quoteId: QUOTE, channel: "fax" as "phone", contact: "+919900000001", owner: GUEST })).rejects.toMatchObject({ code: "VALIDATION_FAILED" });
  });

  it("verify answers `invalid` for a malformed code or challenge id", async () => {
    await expect(contactVerificationService.verify({ ip: null, challengeId: QUOTE, code: "12a456", owner: GUEST })).resolves.toEqual({ refused: "invalid" });
    await expect(contactVerificationService.verify({ ip: null, challengeId: QUOTE, code: "12345", owner: GUEST })).resolves.toEqual({ refused: "invalid" });
    await expect(contactVerificationService.verify({ ip: null, challengeId: "not-a-uuid", code: "123456", owner: GUEST })).resolves.toEqual({ refused: "invalid" });
  });

  it("forQuote ignores a malformed quote id", async () => {
    await expect(contactVerificationService.forQuote("nope")).resolves.toEqual([]);
  });
});
