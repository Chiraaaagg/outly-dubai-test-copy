import "server-only";
import { createRemoteJWKSet, jwtVerify, type JWTVerifyGetKey } from "jose";
import { supabaseIssuer } from "./supabase-auth.client";

/**
 * Local verification of a Supabase access token against the project's JWKS
 * (Group B, plan 92 §1.4 step 1). Defence in depth: the token arrives over
 * TLS straight from the Auth server, and the authoritative read is
 * `GET /auth/v1/user` right after. This check pins what that call must agree
 * with: algorithm ES256 only (the project signs with one asymmetric ES256
 * key; `HS256` and `none` are refused), issuer `<SUPABASE_URL>/auth/v1`,
 * audience `authenticated`, a live `exp`, and a subject.
 */

export const SUPABASE_JWT_ALGORITHMS = ["ES256"] as const;
export const SUPABASE_JWT_AUDIENCE = "authenticated";
/** Clock skew allowed on `exp` / `nbf`. */
const CLOCK_TOLERANCE_SECONDS = 30;

const remoteSets = new Map<string, JWTVerifyGetKey>();

function remoteJwks(baseUrl: string): JWTVerifyGetKey {
  const url = `${supabaseIssuer(baseUrl)}/.well-known/jwks.json`;
  let set = remoteSets.get(url);
  if (!set) {
    set = createRemoteJWKSet(new URL(url), { timeoutDuration: 5_000, cooldownDuration: 30_000, cacheMaxAge: 10 * 60_000 });
    remoteSets.set(url, set);
  }
  return set;
}

export class SupabaseJwtError extends Error {
  constructor() {
    super("supabase_jwt_invalid");
    this.name = "SupabaseJwtError";
  }
}

/** Returns the token's subject (the Supabase user id). Throws `SupabaseJwtError` on anything else. */
export async function verifySupabaseAccessToken(token: string, opts: { baseUrl: string; keys?: JWTVerifyGetKey; now?: Date }): Promise<{ sub: string }> {
  if (typeof token !== "string" || token.length < 20 || token.length > 8192) throw new SupabaseJwtError();
  try {
    const { payload } = await jwtVerify(token, opts.keys ?? remoteJwks(opts.baseUrl), {
      algorithms: [...SUPABASE_JWT_ALGORITHMS],
      issuer: supabaseIssuer(opts.baseUrl),
      audience: SUPABASE_JWT_AUDIENCE,
      clockTolerance: CLOCK_TOLERANCE_SECONDS,
      requiredClaims: ["exp", "sub"],
      ...(opts.now ? { currentDate: opts.now } : {}),
    });
    if (typeof payload.sub !== "string" || !payload.sub || payload.sub.length > 128) throw new SupabaseJwtError();
    return { sub: payload.sub };
  } catch {
    throw new SupabaseJwtError();
  }
}
