import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { resetEnvCache } from "../../lib/env";
import { classifySupabaseError, SupabaseAuthError, supabaseAuthClient } from "../supabase-auth.client";
import { verifySupabaseAccessToken } from "../supabase-jwt";
import { startFakeSupabase, type FakeSupabase } from "./fake-supabase-auth";

/**
 * Pins the request and response shapes OUTLYY uses against the fake Auth
 * server (loopback only; never the real Supabase). The same shapes must be
 * confirmed against the hosted project at the staging step (record 100).
 */

let fake: FakeSupabase;
const KEY = "sb_publishable_test_only_0123456789";

beforeAll(async () => {
  fake = await startFakeSupabase();
  vi.stubEnv("SUPABASE_URL", fake.url);
  vi.stubEnv("SUPABASE_PUBLISHABLE_KEY", KEY);
  resetEnvCache();
});
afterAll(async () => {
  await fake.close();
  vi.unstubAllEnvs();
  resetEnvCache();
});

const last = (path: string) => [...fake.requests].reverse().find((r) => r.path.startsWith(path))!;

describe("Supabase Auth client contract", () => {
  it("POST /otp: email and create_user, the apikey and version headers, no bearer", async () => {
    await supabaseAuthClient.sendEmailOtp("jo@example.com");
    const r = last("/otp");
    expect(r.method).toBe("POST");
    expect(r.body).toEqual({ email: "jo@example.com", create_user: true });
    expect(r.headers.apikey).toBe(KEY);
    expect(r.headers["x-supabase-api-version"]).toBe("2024-01-01");
    expect(r.headers.authorization).toBeUndefined();
  });

  it("POST /otp with our signup claim: sent as data (user_metadata on creation) (re-review 103b, finding 7)", async () => {
    const claim = "c".repeat(43);
    await supabaseAuthClient.sendEmailOtp("jo@example.com", { signupClaim: claim });
    expect(last("/otp").body).toEqual({ email: "jo@example.com", create_user: true, data: { outlyy_signup_claim: claim } });
  });

  it("POST /verify: type email, email, token; returns a session whose access token verifies against the JWKS", async () => {
    await supabaseAuthClient.sendEmailOtp("ana@example.com");
    const code = fake.codes.get("ana@example.com")!;
    const s = await supabaseAuthClient.verifyEmailOtp("ana@example.com", code);
    expect(last("/verify").body).toEqual({ type: "email", email: "ana@example.com", token: code });
    const { sub } = await verifySupabaseAccessToken(s.accessToken, { baseUrl: fake.url });
    const user = await supabaseAuthClient.getUser(s.accessToken);
    expect(user.id).toBe(sub);
    expect(user.email).toBe("ana@example.com");
    expect(user.emailConfirmedAt).toBeTruthy();
    expect(last("/user").headers.authorization).toBe(`Bearer ${s.accessToken}`);
    expect(await supabaseAuthClient.signOut(s.accessToken)).toBe(true);
    expect(last("/logout").path).toBe("/logout?scope=local");
  });

  it("a wrong or used code is invalid_code; a second use of the right code too", async () => {
    await supabaseAuthClient.sendEmailOtp("bo@example.com");
    const code = fake.codes.get("bo@example.com")!;
    await expect(supabaseAuthClient.verifyEmailOtp("bo@example.com", code === "000000" ? "111111" : "000000")).rejects.toMatchObject({ kind: "invalid_code" });
    await supabaseAuthClient.verifyEmailOtp("bo@example.com", code);
    await expect(supabaseAuthClient.verifyEmailOtp("bo@example.com", code)).rejects.toMatchObject({ kind: "invalid_code" });
  });

  it("POST /token?grant_type=id_token: provider google, id_token and the raw nonce", async () => {
    const claims = Buffer.from(JSON.stringify({ email: "g@example.com", email_verified: true, sub: "g-1" })).toString("base64url");
    const s = await supabaseAuthClient.signInWithGoogleIdToken(`h.${claims}.s`, "raw-nonce-value-0123456789");
    expect(last("/token").path).toBe("/token?grant_type=id_token");
    expect(last("/token").body).toEqual({ provider: "google", id_token: `h.${claims}.s`, nonce: "raw-nonce-value-0123456789" });
    expect(s.accessToken).toBeTruthy();
  });

  it("maps Supabase errors to the closed list and never carries provider text", async () => {
    fake.failNext("/otp", 429, { code: 429, error_code: "over_email_send_rate_limit", msg: "email rate limit exceeded for jo@example.com" });
    const err = await supabaseAuthClient.sendEmailOtp("jo@example.com").catch((e: unknown) => e);
    expect(err).toBeInstanceOf(SupabaseAuthError);
    expect((err as SupabaseAuthError).kind).toBe("rate_limited");
    expect((err as Error).message).toBe("supabase_auth:rate_limited");
    expect(JSON.stringify(err)).not.toContain("jo@example.com");
    fake.failNext("/otp", 500, { code: 500, error_code: "hook_timeout_after_retry", msg: "x" });
    await expect(supabaseAuthClient.sendEmailOtp("jo@example.com")).rejects.toMatchObject({ kind: "delivery_failed" });
    fake.failNext("/user", 401, { code: 401, error_code: "bad_jwt", msg: "x" });
    await expect(supabaseAuthClient.getUser("x".repeat(40))).rejects.toMatchObject({ kind: "unauthorized" });
  });

  it("classification table", () => {
    expect(classifySupabaseError("verify", 403, "otp_expired")).toBe("invalid_code");
    expect(classifySupabaseError("verify", 429, null)).toBe("rate_limited");
    expect(classifySupabaseError("verify", 503, null)).toBe("unavailable");
    expect(classifySupabaseError("otp", 400, "email_address_invalid")).toBe("invalid_request");
    expect(classifySupabaseError("otp", 422, "signup_disabled")).toBe("rejected");
    expect(classifySupabaseError("otp", 422, "hook_payload_invalid_content_type")).toBe("delivery_failed");
    expect(classifySupabaseError("id_token", 400, "email_not_confirmed")).toBe("rejected");
    expect(classifySupabaseError("user", 403, null)).toBe("unauthorized");
  });

  it("an unreachable server is unavailable, and a missing configuration is not_configured", async () => {
    vi.stubEnv("SUPABASE_URL", "http://127.0.0.1:9");
    resetEnvCache();
    await expect(supabaseAuthClient.sendEmailOtp("jo@example.com")).rejects.toMatchObject({ kind: "unavailable" });
    vi.stubEnv("SUPABASE_URL", "");
    resetEnvCache();
    await expect(supabaseAuthClient.sendEmailOtp("jo@example.com")).rejects.toMatchObject({ kind: "not_configured" });
    vi.stubEnv("SUPABASE_URL", fake.url);
    resetEnvCache();
  });
});
