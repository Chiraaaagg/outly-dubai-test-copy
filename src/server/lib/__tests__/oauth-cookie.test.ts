import { describe, expect, it } from "vitest";
import { decodeOAuthCookie, encodeOAuthCookie, OAUTH_COOKIE_MAX_AGE_SECONDS, oauthCookieName } from "../oauth-cookie";

const v = { state: "s".repeat(32), nonce: "n".repeat(32), verifier: "v".repeat(43), next: "/account/bookings", issuedAt: Date.parse("2026-11-27T12:00:00Z") };
const at = (ms: number) => new Date(v.issuedAt + ms);

describe("Google round-trip cookie", () => {
  it("round-trips and keeps only a safe next", () => {
    expect(decodeOAuthCookie(encodeOAuthCookie(v), at(1000))).toEqual(v);
    expect(decodeOAuthCookie(encodeOAuthCookie({ ...v, next: "//evil.example/x" }), at(1000))?.next).toBe("/account");
    expect(decodeOAuthCookie(encodeOAuthCookie({ ...v, next: "/admin" }), at(1000))?.next).toBe("/account");
  });

  it("refuses a tampered body or signature, a missing value and an expired cookie", () => {
    const c = encodeOAuthCookie(v);
    const [body, sig] = c.split(".");
    const forged = Buffer.from(JSON.stringify({ s: v.state, n: v.nonce, v: v.verifier, x: "/account", t: v.issuedAt + 1 })).toString("base64url");
    expect(decodeOAuthCookie(`${forged}.${sig}`, at(1000))).toBeNull();
    expect(decodeOAuthCookie(`${body}.${sig.slice(0, -2)}xx`, at(1000))).toBeNull();
    expect(decodeOAuthCookie(undefined, at(1000))).toBeNull();
    expect(decodeOAuthCookie(c, at(OAUTH_COOKIE_MAX_AGE_SECONDS * 1000 + 1))).toBeNull();
  });

  it("uses the plain name on development and the __Host- name elsewhere", () => {
    expect(oauthCookieName()).toBe("outlyy_oauth");
  });
});
