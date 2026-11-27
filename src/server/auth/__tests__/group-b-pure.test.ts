import { describe, expect, it } from "vitest";
import { decideVerifiedEmail, confirmedPhone } from "../../services/customer-identity.service";
import { volumeCrossings } from "../../services/account-alerts";
import { notMeLink, renderAccountLinkNotice, renderSignInCode } from "../../notifications/auth-templates";
import { maskEmail, normaliseEmail, parseLoginNotice, hasAnySignInOption } from "@/lib/customer-auth-options";
import { buildCsp, edgePolicy } from "@/proxy";
import type { SupabaseUser } from "../supabase-auth.client";

const user = (over: Partial<SupabaseUser> = {}): SupabaseUser => ({ id: "u", email: "jo@example.com", emailConfirmedAt: "2026-11-27T00:00:00Z", phone: null, phoneConfirmedAt: null, identities: [], ...over });

describe("verified email decision (plan 92 §1.4 step 3)", () => {
  it("email code for exactly that confirmed address", () => {
    expect(decideVerifiedEmail(user(), { method: "email_otp", email: " Jo@Example.com " })).toBe("jo@example.com");
    expect(decideVerifiedEmail(user(), { method: "email_otp", email: "other@example.com" })).toBeNull();
    expect(decideVerifiedEmail(user({ emailConfirmedAt: null }), { method: "email_otp", email: "jo@example.com" })).toBeNull();
  });

  it("Google only with a verified Google identity for the same address; user_metadata is never read", () => {
    const g = { provider: "google", identityData: { email: "jo@example.com", emailVerified: true, sub: "g" } };
    expect(decideVerifiedEmail(user({ identities: [g] }), { method: "google", email: "jo@example.com" })).toBe("jo@example.com");
    expect(decideVerifiedEmail(user({ identities: [{ ...g, identityData: { ...g.identityData, emailVerified: false } }] }), { method: "google", email: "jo@example.com" })).toBeNull();
    expect(decideVerifiedEmail(user({ identities: [{ ...g, provider: "email" }] }), { method: "google", email: "jo@example.com" })).toBeNull();
    // The address changed at Supabase since Google verified the old one.
    expect(decideVerifiedEmail(user({ email: "new@example.com", identities: [g] }), { method: "google", email: "jo@example.com" })).toBeNull();
  });

  it("plus or dot variants are different addresses", () => {
    expect(decideVerifiedEmail(user({ email: "j.o+trip@example.com" }), { method: "email_otp", email: "jo@example.com" })).toBeNull();
  });

  it("a phone counts only when Supabase confirmed it", () => {
    expect(confirmedPhone(user({ phone: ["971", "50", "1234567"].join(""), phoneConfirmedAt: null }))).toBeNull();
    expect(confirmedPhone(user({ phone: ["971", "50", "1234567"].join(""), phoneConfirmedAt: "2026-11-27T00:00:00Z" }))).toBe(`+${["971", "50", "1234567"].join("")}`);
  });
});

describe("Resend volume crossings (owner Q-B6)", () => {
  const now = new Date("2026-11-27T15:00:00Z");
  it("alerts at the share of the daily cap, raised at the start of today", () => {
    const per = new Map([["2026-11-27", 80]]);
    const c = volumeCrossings(per, now, { daily: 100, monthly: 3000, percent: 80 });
    expect(c).toEqual([{ window: "day", key: "2026-11-27", crossedOn: new Date("2026-11-27T00:00:00Z"), count: 80, cap: 100 }]);
    expect(volumeCrossings(new Map([["2026-11-27", 79]]), now, { daily: 100, monthly: 3000, percent: 80 })).toEqual([]);
  });
  it("alerts on the month on the day the running total crossed", () => {
    const per = new Map([["2026-11-01", 1500], ["2026-11-10", 900], ["2026-11-27", 10]]);
    const c = volumeCrossings(per, now, { daily: 100, monthly: 3000, percent: 80 });
    expect(c).toEqual([{ window: "month", key: "2026-11", crossedOn: new Date("2026-11-10T00:00:00Z"), count: 2400, cap: 3000 }]);
  });
});

describe("Group B emails", () => {
  it("sign-in code: the code in subject and body, no link", () => {
    const r = renderSignInCode({ code: "123456", ttlMinutes: 10 });
    expect(r.subject).toBe("123456 is your OUTLYY sign-in code");
    expect(r.text).toContain("expires in 10 minutes");
    expect(r.html).not.toMatch(/href=/);
    expect(() => renderSignInCode({ code: "12<b>", ttlMinutes: 10 })).toThrow();
  });
  it("attach notice: reference, method, and the not-me link with the token in the fragment", () => {
    const link = notMeLink("https://outlyy.com/", "A".repeat(43));
    expect(link).toBe(`https://outlyy.com/booking/not-me#${"A".repeat(43)}`);
    const r = renderAccountLinkNotice({ orderReference: "OUT-100", rule: "guest_session", attachedLabel: "27 Nov 2026, 14:05 Dubai time", notMeLink: link, expiresLabel: "27 Dec 2026" });
    expect(r.subject).toBe("Booking OUT-100 was added to an account");
    expect(r.text).toContain("same browser that paid");
    expect(r.html).toContain(link);
    expect(() => notMeLink("https://outlyy.com", "short")).toThrow();
  });
});

describe("Sign-in contract helpers", () => {
  it("normalises exactly and masks", () => {
    expect(normaliseEmail("  A.B+c@Example.COM ")).toBe("a.b+c@example.com");
    expect(normaliseEmail("nope")).toBeNull();
    expect(normaliseEmail(`${"a".repeat(250)}@x.co`)).toBeNull();
    expect(maskEmail("jo@example.com")).toBe("j•••@example.com");
    expect(parseLoginNotice("google_cancelled")).toBe("google_cancelled");
    expect(parseLoginNotice("<script>")).toBeNull();
    expect(hasAnySignInOption({ emailCode: false, google: false, phone: false, turnstileSiteKey: null })).toBe(false);
  });
});

describe("CSP: Turnstile on /login only", () => {
  const base = { isProd: true, nonce: "n", analyticsConfigured: false, otpWidgetConfigured: false };
  it("adds challenges.cloudflare.com to script-src and frame-src on /login when configured", () => {
    const csp = edgePolicy({ ...base, pathname: "/login", turnstileConfigured: true }).csp;
    expect(csp).toMatch(/script-src [^;]*https:\/\/challenges\.cloudflare\.com/);
    expect(csp).toMatch(/frame-src https:\/\/challenges\.cloudflare\.com/);
    expect(csp).toContain("connect-src 'self'");
    expect(csp).not.toMatch(/connect-src [^;]*cloudflare/);
  });
  it("never elsewhere, never unconfigured, never on admin", () => {
    for (const pathname of ["/", "/account", "/admin/login", "/booking/not-me", "/login/x"]) expect(edgePolicy({ ...base, pathname, turnstileConfigured: true }).csp).not.toContain("cloudflare");
    expect(edgePolicy({ ...base, pathname: "/login", turnstileConfigured: false }).csp).not.toContain("cloudflare");
    expect(edgePolicy({ ...base, pathname: "/login" }).csp).toBe(buildCsp("'self' 'unsafe-inline'", true, false, false));
  });
});
