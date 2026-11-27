import { describe, expect, it } from "vitest";
import { decideVerifiedEmail, confirmedPhone, emailStartLimits, signInCodeDailyBudget, signupClaimFor, selectAttachable, ATTACH_CAP, ATTACH_SCAN_LIMIT, EMAIL_START_LIMITS, EMAIL_VERIFY_LIMITS, type AttachCandidate } from "../../services/customer-identity.service";
import { accountIncidents, noticeGaveUpAt, volumeCrossings } from "../../services/account-alerts";
import { budgetWindowStart, signInBudgetCrossings } from "../signin-code-budget";
import { codeStepMessage, cookieBlockedMessage, CODE_TIMED_OUT_MESSAGE, emailStepMessage, waitWords } from "@/components/auth/email-code-messages";
import { createHash } from "node:crypto";
import { MAX_ATTEMPTS, RETRY_WINDOW_MS } from "../../services/notification.service";
import { inquiryNeedsVerification } from "../../services/inquiry.service";
import { supabaseUrlProblem } from "../../lib/env";
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

  it("a phone counts only when Supabase confirmed it on a phone identity (finding 4)", () => {
    const digits = ["971", "50", "1234567"].join("");
    const phoneIdentity = { provider: "phone", identityData: { email: null, emailVerified: false, sub: "p" } };
    expect(confirmedPhone(user({ phone: digits, phoneConfirmedAt: null, identities: [phoneIdentity] }))).toBeNull();
    // Set through `PUT /user` on an email user: confirmed, but no phone identity.
    expect(confirmedPhone(user({ phone: digits, phoneConfirmedAt: "2026-11-27T00:00:00Z", identities: [{ ...phoneIdentity, provider: "email" }] }))).toBeNull();
    expect(confirmedPhone(user({ phone: digits, phoneConfirmedAt: "2026-11-27T00:00:00Z", identities: [phoneIdentity] }))).toBe(`+${digits}`);
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

describe("sign-in code limits (review 103 findings 3 and 8)", () => {
  it("the daily code budget is 40 % of the plan cap, at least one", () => {
    expect(signInCodeDailyBudget(100)).toBe(40);
    expect(signInCodeDailyBudget(3000)).toBe(1200);
    expect(signInCodeDailyBudget(1)).toBe(1);
    expect(signInCodeDailyBudget(0)).toBe(1);
    expect(signInCodeDailyBudget(Number.NaN)).toBe(1);
  });

  it("a code request passes per address, per IP hour, per IP day, global hour and the global day budget, in that order", () => {
    const limits = emailStartLimits({ contactHash: "a".repeat(64), ipHash: "b".repeat(32), dailyCap: 100 });
    expect(limits).toEqual([
      { key: `auth_email_start:email:${"a".repeat(32)}`, max: 3, windowSeconds: 900, scope: "address" },
      { key: `auth_email_start:ip:${"b".repeat(32)}`, max: 10, windowSeconds: 3600, scope: "ip" },
      { key: `auth_email_start:ip_day:${"b".repeat(32)}`, max: 20, windowSeconds: 86_400, scope: "ip" },
      { key: "auth_email_start:global", max: 30, windowSeconds: 3600, scope: "site" },
      { key: "auth_email_start:global_day", max: 40, windowSeconds: 86_400, scope: "site" },
    ]);
    expect(emailStartLimits({ contactHash: "a".repeat(64), ipHash: undefined, dailyCap: 100 })[1].key).toBe("auth_email_start:ip:none");
    expect(EMAIL_START_LIMITS.globalHour).toBeLessThanOrEqual(30);
  });

  it("verify attempts: per start (its whole life), per IP, and per address as a backstop of 15 to 20 (re-review 103b N2)", () => {
    expect(EMAIL_VERIFY_LIMITS).toEqual({ perStart: 5, perIp15m: 30, perAddress15m: 20 });
    expect(EMAIL_VERIFY_LIMITS.perAddress15m).toBeGreaterThanOrEqual(15);
    expect(EMAIL_VERIFY_LIMITS.perAddress15m).toBeLessThanOrEqual(20);
    // The owner's own three starts in a window still fit under the backstop.
    expect(EMAIL_VERIFY_LIMITS.perAddress15m).toBeGreaterThanOrEqual(EMAIL_VERIFY_LIMITS.perStart * EMAIL_START_LIMITS.perAddress15m);
  });
});

describe("attach notice gave up (review 103 finding 5)", () => {
  const now = new Date("2026-11-27T12:00:00Z");
  const row = (over: Partial<Parameters<typeof noticeGaveUpAt>[0]> = {}) => ({ status: "failed", providerError: "retryable:http_500", attempt: 1, createdAt: new Date(now.getTime() - 3_600_000), failedAt: new Date(now.getTime() - 60_000), attentionRequiredAt: null, ...over });
  it("a retryable failure under the attempts and inside the window is still pending", () => {
    expect(noticeGaveUpAt(row(), now)).toBeNull();
  });
  it("a definite failure, spent attempts, a spent window or a flagged unknown row has given up", () => {
    expect(noticeGaveUpAt(row({ providerError: "definite:token_unavailable" }), now)).toEqual(new Date(now.getTime() - 60_000));
    expect(noticeGaveUpAt(row({ attempt: MAX_ATTEMPTS }), now)).toEqual(new Date(now.getTime() - 60_000));
    const old = new Date(now.getTime() - RETRY_WINDOW_MS - 60_000);
    expect(noticeGaveUpAt(row({ createdAt: old, failedAt: old }), now)).toEqual(new Date(old.getTime() + RETRY_WINDOW_MS));
    const flagged = new Date(now.getTime() - 5_000);
    expect(noticeGaveUpAt(row({ status: "unknown", attentionRequiredAt: flagged }), now)).toEqual(flagged);
    expect(noticeGaveUpAt(row({ status: "unknown" }), now)).toBeNull();
  });
  it("a sent row, or a notice dropped because the order was already detached, is not a failure", () => {
    expect(noticeGaveUpAt(row({ status: "sent" }), now)).toBeNull();
    expect(noticeGaveUpAt(row({ providerError: "definite:link_detached" }), now)).toBeNull();
  });
  it("a suppressed notice was never sent: given up at once, except the non-production allowlist (re-review 103b N5)", () => {
    const createdAt = new Date(now.getTime() - 120_000);
    expect(noticeGaveUpAt(row({ status: "suppressed", suppressedReason: "opted_out", createdAt, failedAt: null }), now)).toEqual(createdAt);
    expect(noticeGaveUpAt(row({ status: "suppressed", suppressedReason: "unsupported_channel", createdAt, failedAt: null }), now)).toEqual(createdAt);
    expect(noticeGaveUpAt(row({ status: "suppressed", suppressedReason: "non_production_allowlist", createdAt, failedAt: null }), now)).toBeNull();
  });
});

describe("verified inquiries need a verified phone (review 103 finding 6)", () => {
  it("with the flag on, no session and a phone-less session both need verification", () => {
    const phone = `+${["971", "50", "1234567"].join("")}`;
    expect(inquiryNeedsVerification(true, null)).toBe(true);
    expect(inquiryNeedsVerification(true, { phoneE164: null })).toBe(true);
    expect(inquiryNeedsVerification(true, { phoneE164: phone })).toBe(false);
  });
  it("with the flag off or unset, nobody does", () => {
    expect(inquiryNeedsVerification(false, null)).toBe(false);
    expect(inquiryNeedsVerification(undefined, { phoneE164: null })).toBe(false);
  });
});

describe("SUPABASE_URL shape, shared by the email and Google options (review 103 finding 15)", () => {
  it("is required, and must be a supabase.co project URL in production", () => {
    expect(supabaseUrlProblem({ SUPABASE_URL: undefined, isProduction: false })).toMatch(/missing/);
    expect(supabaseUrlProblem({ SUPABASE_URL: "http://127.0.0.1:54321", isProduction: false })).toBeNull();
    expect(supabaseUrlProblem({ SUPABASE_URL: "http://127.0.0.1:54321", isProduction: true })).toMatch(/supabase\.co/);
    expect(supabaseUrlProblem({ SUPABASE_URL: "https://example-project.supabase.co", isProduction: true })).toBeNull();
  });
});

describe("sign-in code budget alert (re-review 103b N1)", () => {
  // An injected clock: nothing here depends on the real time of day, so a run across UTC midnight cannot flake.
  const now = new Date("2031-03-04T23:59:30Z");
  it("raises at 80 % of the budget and again when it is spent, both at the start of that UTC day", () => {
    const day = new Date("2031-03-04T00:00:00Z");
    expect(budgetWindowStart(now)).toEqual(day);
    expect(signInBudgetCrossings(31, 40, now)).toEqual([]);
    expect(signInBudgetCrossings(32, 40, now)).toEqual([{ reason: "signin_code_budget_80pct", raisedAt: day, count: 32, budget: 40 }]);
    expect(signInBudgetCrossings(40, 40, now).map((c) => c.reason)).toEqual(["signin_code_budget_80pct", "signin_code_budget_spent"]);
    expect(signInBudgetCrossings(55, 40, now).map((c) => c.reason)).toEqual(["signin_code_budget_80pct", "signin_code_budget_spent"]);
    expect(signInBudgetCrossings(0, 40, now)).toEqual([]);
    // A paid plan: 1200 codes a day, the alert at 960.
    expect(signInBudgetCrossings(959, signInCodeDailyBudget(3000), now)).toEqual([]);
    expect(signInBudgetCrossings(960, signInCodeDailyBudget(3000), now)).toHaveLength(1);
  });
  it("the next UTC day is a new window", () => {
    expect(budgetWindowStart(new Date("2031-03-05T00:00:00Z"))).toEqual(new Date("2031-03-05T00:00:00Z"));
  });
});

describe("email code form words (re-review 103b N6 and the cookie case)", () => {
  it("caps the stated wait: an hour or less in minutes, anything longer reads later", () => {
    expect(waitWords(900)).toBe("in 15 minutes");
    expect(waitWords(3600)).toBe("in 60 minutes");
    expect(waitWords(3601)).toBe("later");
    expect(waitWords(86_400)).toBe("later");
    expect(emailStepMessage("RATE_LIMITED", 82_800)).not.toMatch(/\d+ minutes/);
  });
  it("a site-wide refusal does not blame the customer, and offers Google only when it is on", () => {
    expect(emailStepMessage("RATE_LIMITED", 82_800, { scope: "site", alternative: "google" })).toBe("We can't send more email codes right now. Try again later, or continue with Google.");
    expect(emailStepMessage("RATE_LIMITED", 82_800, { scope: "site" })).toBe("We can't send more email codes right now. Try again later.");
    expect(emailStepMessage("RATE_LIMITED", 900, { alternative: "google" })).toBe("Too many codes requested. Try again in 15 minutes, or continue with Google.");
    expect(emailStepMessage("RATE_LIMITED", 900)).toBe("Too many codes requested. Try again in 15 minutes.");
  });
  it("a server CODE_EXPIRED covers another browser or a lost cookie; the page's own timer says expired", () => {
    expect(codeStepMessage("CODE_EXPIRED")).toBe("That code can't be used here any more. Send a new one.");
    expect(CODE_TIMED_OUT_MESSAGE).toBe("That code has expired. Send a new one.");
  });
  it("blocked cookies: says what will work instead of another code that fails the same way", () => {
    expect(cookieBlockedMessage(true)).toMatch(/Allow cookies for this site.*or continue with Google\.$/);
    expect(cookieBlockedMessage(false)).not.toMatch(/Google/);
  });
});

describe("signup claim (re-review 103b, finding 7)", () => {
  it("is fixed per intent, differs between intents and never contains the intent id", () => {
    const a = "0190f7a2-0000-7000-8000-0000000a0001";
    const b = "0190f7a2-0000-7000-8000-0000000a0002";
    expect(signupClaimFor(a)).toBe(signupClaimFor(a));
    expect(signupClaimFor(a)).not.toBe(signupClaimFor(b));
    expect(signupClaimFor(a)).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(signupClaimFor(a)).not.toContain(a);
  });
});

describe("attach cap counts the orders that pass the per-order checks (review 103 finding 12)", () => {
  const sha = (v: string) => createHash("sha256").update(v).digest("hex");
  const gs = "0190f7a2-0000-7000-8000-0000000000aa";
  const order = (n: number, opts: { lead: string; verified: string; session?: string | null }): AttachCandidate => ({
    id: `0190f7a2-0000-7000-8000-${String(n).padStart(12, "0")}`,
    reference: `OUT-${100000 + n}`,
    leadEmail: opts.lead,
    quote: { ownerKind: "guest", guestSessionId: opts.session === undefined ? gs : opts.session },
    verifications: [{ id: `v-${n}`, contactHash: sha(opts.verified) }],
  });
  const ctx = { verifiedEmail: "signer@example.com", guestSessionId: gs, grantOrderIds: [] as string[] };

  it("25 loose matches in this browser whose email was not the one proven do not block the one that qualifies", () => {
    const loose = Array.from({ length: 25 }, (_, i) => order(i, { lead: `buyer${i}@example.com`, verified: "someone-else@example.com" }));
    const good = order(99, { lead: "buyer99@example.com", verified: "buyer99@example.com" });
    const r = selectAttachable([...loose, good], ctx);
    expect(r.capped).toBe(false);
    expect(r.chosen.map((c) => [c.order.id, c.rule, c.recipient])).toEqual([[good.id, "guest_session", "buyer99@example.com"]]);
  });

  it("rule (a) wins over rule (b) for the same order; more than 20 qualifying orders attach none", () => {
    const own = order(1, { lead: "signer@example.com", verified: "signer@example.com", session: null });
    expect(selectAttachable([own], ctx).chosen[0]).toMatchObject({ rule: "verified_email", recipient: "signer@example.com" });
    const many = Array.from({ length: ATTACH_CAP + 1 }, (_, i) => order(i, { lead: `b${i}@example.com`, verified: `b${i}@example.com` }));
    expect(selectAttachable(many, ctx)).toEqual({ chosen: [], capped: true });
    expect(selectAttachable(many.slice(0, ATTACH_CAP), ctx).chosen).toHaveLength(ATTACH_CAP);
  });

  it("more candidates than the scan limit is itself unusual volume: none attached", () => {
    const loose = Array.from({ length: ATTACH_SCAN_LIMIT + 1 }, (_, i) => order(i, { lead: `x${i}@example.com`, verified: "nobody@example.com" }));
    expect(selectAttachable(loose, ctx)).toEqual({ chosen: [], capped: true });
  });

  it("another session, or no browser link at all, never attaches by rule (b)", () => {
    const other = order(5, { lead: "b5@example.com", verified: "b5@example.com", session: "0190f7a2-0000-7000-8000-0000000000bb" });
    expect(selectAttachable([other], ctx).chosen).toEqual([]);
    expect(selectAttachable([order(6, { lead: "b6@example.com", verified: "b6@example.com" })], { ...ctx, guestSessionId: null }).chosen).toEqual([]);
  });
});

describe("account alerts survive a failing part (re-review 103b N3)", () => {
  it("a notice query that throws loses only the notice alerts; the cap alert still comes through", async () => {
    const createdAt = new Date("2031-03-04T10:00:00Z");
    const fake = {
      orderAccountLink: { findMany: async () => [] },
      auditLog: { findMany: async () => [{ entityType: "customer_attach_cap", entityId: "0190f7a2-0000-7000-8000-0000000000cc", createdAt }] },
      $queryRaw: async () => {
        throw new Error("relation does not exist");
      },
    } as unknown as Parameters<typeof accountIncidents>[3];
    const out = await accountIncidents(new Date("2031-03-04T00:00:00Z"), new Date("2031-03-04T12:00:00Z"), 100, fake);
    expect(out.map((i) => [i.kind, i.entityId])).toEqual([["account_attach_capped", "0190f7a2-0000-7000-8000-0000000000cc"]]);
  });
});
