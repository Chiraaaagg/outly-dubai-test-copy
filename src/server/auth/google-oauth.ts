import "server-only";
import { createHash, randomBytes } from "node:crypto";
import { createRemoteJWKSet, jwtVerify, type JWTVerifyGetKey } from "jose";
import { env } from "../lib/env";

/**
 * Google sign-in on our own callback (Group B, plan 92 §1.6 F1; owner Q-B1:
 * "build the fix and launch", so Google's screen names outlyy.com, not the
 * Supabase host, with no paid custom domain).
 *
 * OUTLYY runs the OpenID Connect authorization code flow with Google itself:
 *
 *  1. `/api/auth/google/start` makes a state, a raw nonce and a PKCE verifier,
 *     keeps them in the signed `__Host-outlyy_oauth` cookie, and redirects to
 *     Google with `redirect_uri = <site>/api/auth/google/callback`, the S256
 *     challenge and `nonce = sha256(raw nonce)`.
 *  2. The callback checks the state against the cookie (login CSRF), exchanges
 *     the code with the client secret and the verifier, and verifies the ID
 *     token here: RS256 against Google's JWKS, issuer, audience = our client
 *     id, expiry, the hashed nonce, and `email_verified === true`.
 *  3. The ID token then goes to Supabase `grant_type=id_token` with the RAW
 *     nonce; Supabase hashes it and checks it against the token's claim, so a
 *     token minted for another login cannot be replayed there.
 *
 * Supabase Auth stays the identity store: the Google identity lands on the
 * same Supabase user as an email code for the same verified address.
 * Never logged: the code, the tokens, the verifier, the nonce.
 */

export const GOOGLE_AUTHORIZE_URL = "https://accounts.google.com/o/oauth2/v2/auth";
export const GOOGLE_CODE_EXCHANGE_URL = "https://oauth2.googleapis.com/token";
export const GOOGLE_JWKS_URL = "https://www.googleapis.com/oauth2/v3/certs";
export const GOOGLE_ISSUERS = ["https://accounts.google.com", "accounts.google.com"];
export const GOOGLE_SCOPES = "openid email profile";
const TIMEOUT_MS = 5_000;

interface Endpoints {
  token: string;
  keys: JWTVerifyGetKey | null;
}

let endpoints: Endpoints = { token: GOOGLE_CODE_EXCHANGE_URL, keys: null };
let remote: JWTVerifyGetKey | null = null;

/** Test seam: the fake Google token endpoint and its keys. `null` restores Google. */
export function setGoogleEndpointsForTests(next: { token: string; keys: JWTVerifyGetKey } | null) {
  endpoints = next ? { token: next.token, keys: next.keys } : { token: GOOGLE_CODE_EXCHANGE_URL, keys: null };
}

function googleKeys(): JWTVerifyGetKey {
  if (endpoints.keys) return endpoints.keys;
  remote ??= createRemoteJWKSet(new URL(GOOGLE_JWKS_URL), { timeoutDuration: TIMEOUT_MS, cooldownDuration: 30_000 });
  return remote;
}

export function googleConfig(): { clientId: string; clientSecret: string } | null {
  const e = env();
  if (!e.GOOGLE_OAUTH_CLIENT_ID || !e.GOOGLE_OAUTH_CLIENT_SECRET) return null;
  return { clientId: e.GOOGLE_OAUTH_CLIENT_ID, clientSecret: e.GOOGLE_OAUTH_CLIENT_SECRET };
}

export function googleRedirectUri(siteUrl: string): string {
  return `${siteUrl.replace(/\/+$/, "")}/api/auth/google/callback`;
}

const b64url = (buf: Buffer) => buf.toString("base64url");

export function sha256Hex(s: string): string {
  return createHash("sha256").update(s).digest("hex");
}

export interface GoogleFlowSecrets {
  state: string;
  /** Raw nonce: Google gets its SHA-256 hex, Supabase gets this. */
  nonce: string;
  verifier: string;
}

export function newGoogleFlow(): GoogleFlowSecrets {
  return { state: b64url(randomBytes(24)), nonce: b64url(randomBytes(24)), verifier: b64url(randomBytes(32)) };
}

export function pkceChallenge(verifier: string): string {
  return b64url(createHash("sha256").update(verifier).digest());
}

export function googleAuthorizeUrl(input: { clientId: string; redirectUri: string; flow: GoogleFlowSecrets }): string {
  const u = new URL(GOOGLE_AUTHORIZE_URL);
  u.searchParams.set("client_id", input.clientId);
  u.searchParams.set("redirect_uri", input.redirectUri);
  u.searchParams.set("response_type", "code");
  u.searchParams.set("scope", GOOGLE_SCOPES);
  u.searchParams.set("state", input.flow.state);
  u.searchParams.set("nonce", sha256Hex(input.flow.nonce));
  u.searchParams.set("code_challenge", pkceChallenge(input.flow.verifier));
  u.searchParams.set("code_challenge_method", "S256");
  u.searchParams.set("prompt", "select_account");
  return u.toString();
}

export class GoogleOAuthError extends Error {
  readonly reason: "exchange_failed" | "token_invalid" | "email_unverified" | "unavailable";
  constructor(reason: GoogleOAuthError["reason"]) {
    super(`google_oauth:${reason}`);
    this.name = "GoogleOAuthError";
    this.reason = reason;
  }
}

/** Exchanges the authorization code. Returns the ID token only; the access token is discarded. */
export async function exchangeGoogleCode(input: { code: string; verifier: string; redirectUri: string; clientId: string; clientSecret: string }): Promise<string> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  let res: Response;
  try {
    res = await fetch(endpoints.token, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded", accept: "application/json" },
      body: new URLSearchParams({
        grant_type: "authorization_code",
        code: input.code,
        code_verifier: input.verifier,
        redirect_uri: input.redirectUri,
        client_id: input.clientId,
        client_secret: input.clientSecret,
      }).toString(),
      signal: controller.signal,
      redirect: "error",
      cache: "no-store",
    });
  } catch {
    throw new GoogleOAuthError("unavailable");
  } finally {
    clearTimeout(timer);
  }
  if (!res.ok) {
    await res.body?.cancel().catch(() => {});
    throw new GoogleOAuthError(res.status >= 500 ? "unavailable" : "exchange_failed");
  }
  const data = (await res.json().catch(() => null)) as { id_token?: unknown } | null;
  const idToken = data?.id_token;
  if (typeof idToken !== "string" || idToken.length < 20 || idToken.length > 8192) throw new GoogleOAuthError("exchange_failed");
  return idToken;
}

/** Verifies the ID token for this login. Returns the verified email (lower case) and Google's subject. */
export async function verifyGoogleIdToken(idToken: string, input: { clientId: string; rawNonce: string; now?: Date }): Promise<{ sub: string; email: string }> {
  let payload: Record<string, unknown>;
  try {
    ({ payload } = await jwtVerify(idToken, googleKeys(), {
      algorithms: ["RS256"],
      issuer: GOOGLE_ISSUERS,
      audience: input.clientId,
      clockTolerance: 30,
      requiredClaims: ["exp", "sub", "nonce"],
      ...(input.now ? { currentDate: input.now } : {}),
    }));
  } catch {
    throw new GoogleOAuthError("token_invalid");
  }
  if (payload.nonce !== sha256Hex(input.rawNonce)) throw new GoogleOAuthError("token_invalid");
  const sub = payload.sub;
  const email = typeof payload.email === "string" ? payload.email.trim().toLowerCase() : "";
  if (typeof sub !== "string" || !sub || !email) throw new GoogleOAuthError("token_invalid");
  if (payload.email_verified !== true) throw new GoogleOAuthError("email_unverified");
  return { sub, email };
}
