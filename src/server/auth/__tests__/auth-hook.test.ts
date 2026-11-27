import { describe, expect, it } from "vitest";
import { randomBytes } from "node:crypto";
import { hookSecretKey, parseBeforeUserCreatedHook, parseSendEmailHook, signHookPayload, verifyHookSignature, HOOK_TOLERANCE_SECONDS } from "../auth-hook";

const secret = `v1,whsec_${randomBytes(32).toString("base64")}`;
const key = hookSecretKey(secret)!;
const body = JSON.stringify({ user: { id: "u1", email: "jo@example.com" }, email_data: { token: "123456", email_action_type: "signup" } });
const now = new Date("2026-11-27T12:00:00.000Z");
const ts = String(Math.floor(now.getTime() / 1000));
const headers = (over: Partial<{ id: string | null; timestamp: string | null; signature: string | null }> = {}) => ({
  id: "msg_1",
  timestamp: ts,
  signature: `v1,${signHookPayload(key, "msg_1", ts, body)}`,
  ...over,
});

describe("Supabase hook signature (Standard Webhooks)", () => {
  it("accepts a correct signature within the tolerance", () => {
    expect(verifyHookSignature({ secret, headers: headers(), body, now })).toEqual({ ok: true, webhookId: "msg_1" });
  });

  it("accepts any matching entry of a multi-signature header", () => {
    const h = headers({ signature: `v1,${Buffer.alloc(32).toString("base64")} v1,${signHookPayload(key, "msg_1", ts, body)}` });
    expect(verifyHookSignature({ secret, headers: h, body, now }).ok).toBe(true);
  });

  it("refuses a missing secret, missing headers, a wrong secret, a changed body, a stale or future timestamp", () => {
    expect(verifyHookSignature({ secret: undefined, headers: headers(), body, now })).toEqual({ ok: false, reason: "not_configured" });
    expect(verifyHookSignature({ secret: "not-a-secret", headers: headers(), body, now })).toEqual({ ok: false, reason: "not_configured" });
    expect(verifyHookSignature({ secret, headers: headers({ signature: null }), body, now })).toEqual({ ok: false, reason: "missing_headers" });
    expect(verifyHookSignature({ secret, headers: headers({ timestamp: "soon" }), body, now })).toEqual({ ok: false, reason: "bad_timestamp" });
    const other = `v1,whsec_${randomBytes(32).toString("base64")}`;
    expect(verifyHookSignature({ secret: other, headers: headers(), body, now })).toEqual({ ok: false, reason: "bad_signature" });
    expect(verifyHookSignature({ secret, headers: headers(), body: body.replace("123456", "654321"), now })).toEqual({ ok: false, reason: "bad_signature" });
    expect(verifyHookSignature({ secret, headers: headers({ id: "msg_2" }), body, now })).toEqual({ ok: false, reason: "bad_signature" });
    const late = new Date(now.getTime() + (HOOK_TOLERANCE_SECONDS + 1) * 1000);
    expect(verifyHookSignature({ secret, headers: headers(), body, now: late })).toEqual({ ok: false, reason: "stale" });
    const early = new Date(now.getTime() - (HOOK_TOLERANCE_SECONDS + 1) * 1000);
    expect(verifyHookSignature({ secret, headers: headers(), body, now: early })).toEqual({ ok: false, reason: "stale" });
  });

  it("refuses a v0 or unversioned signature even with the right HMAC", () => {
    expect(verifyHookSignature({ secret, headers: headers({ signature: signHookPayload(key, "msg_1", ts, body) }), body, now }).ok).toBe(false);
    expect(verifyHookSignature({ secret, headers: headers({ signature: `v0,${signHookPayload(key, "msg_1", ts, body)}` }), body, now }).ok).toBe(false);
  });

  it("parses the Send Email body and refuses malformed fields", () => {
    expect(parseSendEmailHook(JSON.parse(body))).toEqual({ userId: "u1", email: "jo@example.com", token: "123456", actionType: "signup" });
    expect(parseSendEmailHook({ user: { id: "u1", email: "jo@example.com" }, email_data: { token: "12ab56", email_action_type: "signup" } })).toBeNull();
    expect(parseSendEmailHook({ user: { id: "u1" }, email_data: { token: "123456", email_action_type: "signup" } })).toBeNull();
    expect(parseSendEmailHook(null)).toBeNull();
  });

  it("parses the Before User Created body", () => {
    expect(parseBeforeUserCreatedHook({ user: { email: "guest@example.com", app_metadata: { provider: "google" } } })).toEqual({ email: "guest@example.com", phone: null, provider: "google", signupClaim: null });
    // Our start route's claim, from `user_metadata` (re-review 103b, finding 7); anything else there is ignored.
    expect(parseBeforeUserCreatedHook({ user: { email: "guest@example.com", app_metadata: { provider: "email" }, user_metadata: { outlyy_signup_claim: "c".repeat(43), full_name: "x" } } })?.signupClaim).toBe("c".repeat(43));
    expect(parseBeforeUserCreatedHook({ user: { email: "guest@example.com", user_metadata: { outlyy_signup_claim: 7 } } })?.signupClaim).toBeNull();
    expect(parseBeforeUserCreatedHook({})).toBeNull();
  });
});
