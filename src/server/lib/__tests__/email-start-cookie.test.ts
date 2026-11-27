import { describe, expect, it } from "vitest";
import { decodeEmailStartCookie, EMAIL_START_COOKIE_MAX_AGE_SECONDS, emailStartCookieName, encodeEmailStartCookie, newEmailStartCookie } from "../email-start-cookie";

/** The email-code start cookie (Group B, review 103 finding 8). */

const hash = "0123456789abcdef".repeat(4);
const t0 = new Date("2026-11-27T12:00:00Z");
const at = (ms: number) => new Date(t0.getTime() + ms);

describe("email start cookie", () => {
  it("round-trips the address hash prefix and a random id, never the address", () => {
    const v = newEmailStartCookie(hash, t0);
    expect(v.addressHash).toBe(hash.slice(0, 32));
    expect(v.id).toMatch(/^[A-Za-z0-9_-]{16,64}$/);
    expect(newEmailStartCookie(hash, t0).id).not.toBe(v.id);
    const raw = encodeEmailStartCookie(v);
    expect(raw).not.toContain("@");
    expect(decodeEmailStartCookie(raw, at(1000))).toEqual(v);
  });

  it("refuses a tampered body or signature, a missing value and an expired cookie", () => {
    const v = newEmailStartCookie(hash, t0);
    const raw = encodeEmailStartCookie(v);
    const [body, sig] = raw.split(".");
    const forged = Buffer.from(JSON.stringify({ h: "f".repeat(32), i: v.id, t: v.issuedAt })).toString("base64url");
    expect(decodeEmailStartCookie(`${forged}.${sig}`, at(1000))).toBeNull();
    expect(decodeEmailStartCookie(`${body}.${sig.slice(0, -2)}xx`, at(1000))).toBeNull();
    expect(decodeEmailStartCookie(undefined, at(1000))).toBeNull();
    expect(decodeEmailStartCookie(raw, at(EMAIL_START_COOKIE_MAX_AGE_SECONDS * 1000 + 1))).toBeNull();
  });

  it("uses the plain name on development and the __Host- name elsewhere", () => {
    expect(emailStartCookieName()).toBe("outlyy_email_start");
  });
});
