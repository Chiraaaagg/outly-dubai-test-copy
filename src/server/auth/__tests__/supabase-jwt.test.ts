import { describe, expect, it } from "vitest";
import { createLocalJWKSet, exportJWK, generateKeyPair, SignJWT, UnsecuredJWT, type CryptoKey } from "jose";
import { verifySupabaseAccessToken } from "../supabase-jwt";

const baseUrl = "https://example-project.supabase.co";

async function setup() {
  const { publicKey, privateKey } = await generateKeyPair("ES256");
  const other = await generateKeyPair("ES256");
  const keys = createLocalJWKSet({ keys: [{ ...(await exportJWK(publicKey)), kid: "k1", alg: "ES256" }] });
  const sign = (claims: Record<string, unknown> = {}, opts: { kid?: string; key?: CryptoKey; iss?: string; exp?: string } = {}) =>
    new SignJWT({ aud: "authenticated", ...claims })
      .setProtectedHeader({ alg: "ES256", kid: opts.kid ?? "k1" })
      .setIssuer(opts.iss ?? `${baseUrl}/auth/v1`)
      .setSubject("user-1")
      .setIssuedAt()
      .setExpirationTime(opts.exp ?? "1h")
      .sign(opts.key ?? privateKey);
  return { keys, sign, otherKey: other.privateKey };
}

describe("Supabase access token verification", () => {
  it("accepts an ES256 token from the project with the right audience", async () => {
    const { keys, sign } = await setup();
    await expect(verifySupabaseAccessToken(await sign(), { baseUrl, keys })).resolves.toEqual({ sub: "user-1" });
  });

  it("refuses a wrong issuer, a wrong audience, an expired token, an unknown key or a forged signature", async () => {
    const { keys, sign, otherKey } = await setup();
    await expect(verifySupabaseAccessToken(await sign({}, { iss: "https://other.supabase.co/auth/v1" }), { baseUrl, keys })).rejects.toThrow("supabase_jwt_invalid");
    await expect(verifySupabaseAccessToken(await sign({ aud: "anon" }), { baseUrl, keys })).rejects.toThrow("supabase_jwt_invalid");
    await expect(verifySupabaseAccessToken(await sign({}, { exp: "-10m" }), { baseUrl, keys })).rejects.toThrow("supabase_jwt_invalid");
    await expect(verifySupabaseAccessToken(await sign({}, { kid: "unknown" }), { baseUrl, keys })).rejects.toThrow("supabase_jwt_invalid");
    await expect(verifySupabaseAccessToken(await sign({}, { key: otherKey }), { baseUrl, keys })).rejects.toThrow("supabase_jwt_invalid");
  });

  it("refuses HS256 (even with a key the attacker knows) and alg none", async () => {
    const { keys } = await setup();
    const hs = await new SignJWT({ aud: "authenticated" }).setProtectedHeader({ alg: "HS256", kid: "k1" }).setIssuer(`${baseUrl}/auth/v1`).setSubject("user-1").setExpirationTime("1h").sign(new TextEncoder().encode("a-public-publishable-key-0123456789"));
    await expect(verifySupabaseAccessToken(hs, { baseUrl, keys })).rejects.toThrow("supabase_jwt_invalid");
    const none = new UnsecuredJWT({ aud: "authenticated" }).setIssuer(`${baseUrl}/auth/v1`).setSubject("user-1").setExpirationTime("1h").encode();
    await expect(verifySupabaseAccessToken(none, { baseUrl, keys })).rejects.toThrow("supabase_jwt_invalid");
  });

  it("refuses garbage", async () => {
    const { keys } = await setup();
    await expect(verifySupabaseAccessToken("not.a.token", { baseUrl, keys })).rejects.toThrow("supabase_jwt_invalid");
  });
});
