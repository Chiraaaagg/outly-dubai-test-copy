import { afterEach, describe, expect, it } from "vitest";
import { createHash } from "node:crypto";
import { createLocalJWKSet, exportJWK, generateKeyPair, SignJWT } from "jose";
import { googleAuthorizeUrl, newGoogleFlow, pkceChallenge, setGoogleEndpointsForTests, sha256Hex, verifyGoogleIdToken } from "../google-oauth";

const clientId = "123-test.apps.googleusercontent.com";

async function keys() {
  const { publicKey, privateKey } = await generateKeyPair("RS256");
  const set = createLocalJWKSet({ keys: [{ ...(await exportJWK(publicKey)), kid: "g1", alg: "RS256" }] });
  const sign = (claims: Record<string, unknown>, iss = "https://accounts.google.com") =>
    new SignJWT(claims).setProtectedHeader({ alg: "RS256", kid: "g1" }).setIssuer(iss).setAudience(clientId).setSubject("google-sub-1").setIssuedAt().setExpirationTime("10m").sign(privateKey);
  return { set, sign };
}

afterEach(() => setGoogleEndpointsForTests(null));

describe("Google own-callback flow (owner Q-B1)", () => {
  it("builds the authorize URL with our callback, S256 PKCE and the hashed nonce, and nothing about next", () => {
    const flow = newGoogleFlow();
    const u = new URL(googleAuthorizeUrl({ clientId, redirectUri: "https://outlyy.com/api/auth/google/callback", flow }));
    expect(u.origin + u.pathname).toBe("https://accounts.google.com/o/oauth2/v2/auth");
    expect(u.searchParams.get("redirect_uri")).toBe("https://outlyy.com/api/auth/google/callback");
    expect(u.searchParams.get("response_type")).toBe("code");
    expect(u.searchParams.get("scope")).toBe("openid email profile");
    expect(u.searchParams.get("state")).toBe(flow.state);
    expect(u.searchParams.get("code_challenge_method")).toBe("S256");
    expect(u.searchParams.get("code_challenge")).toBe(createHash("sha256").update(flow.verifier).digest("base64url"));
    expect(u.searchParams.get("nonce")).toBe(sha256Hex(flow.nonce));
    expect(u.searchParams.get("nonce")).not.toBe(flow.nonce);
    expect(u.search).not.toContain("next");
    expect(pkceChallenge("abc")).toBe(createHash("sha256").update("abc").digest("base64url"));
  });

  it("accepts a verified ID token for this login and returns the lower-case email", async () => {
    const k = await keys();
    setGoogleEndpointsForTests({ token: "http://127.0.0.1:9/token", keys: k.set });
    const flow = newGoogleFlow();
    const t = await k.sign({ nonce: sha256Hex(flow.nonce), email: "Jo@Example.com", email_verified: true });
    await expect(verifyGoogleIdToken(t, { clientId, rawNonce: flow.nonce })).resolves.toEqual({ sub: "google-sub-1", email: "jo@example.com" });
    const legacyIss = await k.sign({ nonce: sha256Hex(flow.nonce), email: "jo@example.com", email_verified: true }, "accounts.google.com");
    await expect(verifyGoogleIdToken(legacyIss, { clientId, rawNonce: flow.nonce })).resolves.toMatchObject({ email: "jo@example.com" });
  });

  it("refuses another login's nonce, an unverified email, another issuer or audience", async () => {
    const k = await keys();
    setGoogleEndpointsForTests({ token: "http://127.0.0.1:9/token", keys: k.set });
    const flow = newGoogleFlow();
    const otherNonce = await k.sign({ nonce: sha256Hex("another-login-nonce-value"), email: "jo@example.com", email_verified: true });
    await expect(verifyGoogleIdToken(otherNonce, { clientId, rawNonce: flow.nonce })).rejects.toThrow("google_oauth:token_invalid");
    const raw = await k.sign({ nonce: flow.nonce, email: "jo@example.com", email_verified: true });
    await expect(verifyGoogleIdToken(raw, { clientId, rawNonce: flow.nonce })).rejects.toThrow("google_oauth:token_invalid");
    const unverified = await k.sign({ nonce: sha256Hex(flow.nonce), email: "jo@example.com", email_verified: false });
    await expect(verifyGoogleIdToken(unverified, { clientId, rawNonce: flow.nonce })).rejects.toThrow("google_oauth:email_unverified");
    const iss = await k.sign({ nonce: sha256Hex(flow.nonce), email: "jo@example.com", email_verified: true }, "https://evil.example");
    await expect(verifyGoogleIdToken(iss, { clientId, rawNonce: flow.nonce })).rejects.toThrow("google_oauth:token_invalid");
    await expect(verifyGoogleIdToken(await k.sign({ nonce: sha256Hex(flow.nonce), email: "jo@example.com", email_verified: true }), { clientId: "another-client", rawNonce: flow.nonce })).rejects.toThrow("google_oauth:token_invalid");
  });
});
