import "server-only";
import { createHmac, timingSafeEqual } from "node:crypto";
import type { NextRequest, NextResponse } from "next/server";
import { env } from "./env";
import { safeNext } from "@/lib/safe-next";

/**
 * The Google round-trip cookie (Group B, plan 92 §1.3, §1.6 F1).
 *
 * `__Host-outlyy_oauth` in deployed environments (`outlyy_oauth` on
 * http://localhost, the same rule as the guest cookie): httpOnly, Secure
 * outside development, SameSite=Lax (Google's redirect back is a top-level
 * GET from another site, which Lax allows and Strict would drop), Path=/,
 * 10 minutes. It holds the state, the raw nonce, the PKCE verifier and the
 * already-sanitised `next` path, HMAC-SHA256 signed with a key derived from
 * AUTH_COOKIE_SECRET under its own label, so no new signing secret is needed
 * and no other cookie's signature can be replayed here. Read once and
 * cleared by the callback. `next` never travels through Google or Supabase.
 */

export const OAUTH_COOKIE = "outlyy_oauth";
export const OAUTH_COOKIE_MAX_AGE_SECONDS = 600;
const LABEL = "outlyy:oauth-cookie:v1";

export interface OAuthCookieValue {
  state: string;
  nonce: string;
  verifier: string;
  next: string;
  issuedAt: number;
}

export function oauthCookieName(): string {
  return env().APP_ENV !== "development" ? `__Host-${OAUTH_COOKIE}` : OAUTH_COOKIE;
}

function key(): Buffer {
  return createHmac("sha256", env().AUTH_COOKIE_SECRET).update(LABEL).digest();
}

function sign(body: string): string {
  return createHmac("sha256", key()).update(body).digest("base64url");
}

export function encodeOAuthCookie(v: OAuthCookieValue): string {
  const body = Buffer.from(JSON.stringify({ s: v.state, n: v.nonce, v: v.verifier, x: safeNext(v.next), t: v.issuedAt })).toString("base64url");
  return `${body}.${sign(body)}`;
}

/** Null when missing, tampered, malformed or older than the cookie's life. */
export function decodeOAuthCookie(raw: string | undefined, now: Date = new Date()): OAuthCookieValue | null {
  if (!raw || raw.length > 2048) return null;
  const dot = raw.indexOf(".");
  if (dot < 1) return null;
  const body = raw.slice(0, dot);
  const given = Buffer.from(raw.slice(dot + 1), "base64url");
  const expected = Buffer.from(sign(body), "base64url");
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) return null;
  let p: { s?: unknown; n?: unknown; v?: unknown; x?: unknown; t?: unknown };
  try {
    p = JSON.parse(Buffer.from(body, "base64url").toString("utf8"));
  } catch {
    return null;
  }
  const ok = (s: unknown): s is string => typeof s === "string" && s.length >= 16 && s.length <= 128;
  if (!ok(p.s) || !ok(p.n) || !ok(p.v) || typeof p.x !== "string" || typeof p.t !== "number") return null;
  const age = now.getTime() - p.t;
  if (age < -60_000 || age > OAUTH_COOKIE_MAX_AGE_SECONDS * 1000) return null;
  return { state: p.s, nonce: p.n, verifier: p.v, next: safeNext(p.x), issuedAt: p.t };
}

const base = () => ({
  httpOnly: true,
  sameSite: "lax" as const,
  secure: env().APP_ENV !== "development" || process.env.NODE_ENV === "production",
  path: "/",
});

export function setOAuthCookie(res: NextResponse, v: OAuthCookieValue) {
  res.cookies.set(oauthCookieName(), encodeOAuthCookie(v), { ...base(), maxAge: OAUTH_COOKIE_MAX_AGE_SECONDS });
}

export function clearOAuthCookie(res: NextResponse) {
  res.cookies.set(oauthCookieName(), "", { ...base(), maxAge: 0 });
}

export function oauthCookieFromRequest(req: NextRequest): string | undefined {
  return req.cookies.get(oauthCookieName())?.value || undefined;
}
