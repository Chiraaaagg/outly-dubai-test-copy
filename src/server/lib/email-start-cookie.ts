import "server-only";
import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import type { NextRequest, NextResponse } from "next/server";
import { env } from "./env";

/**
 * The email-code start cookie (Group B, review 103 finding 8).
 *
 * `POST /api/auth/email/start` sets it; `POST /api/auth/email/verify` needs
 * it. It proves that this browser asked for a code for this address, and it
 * carries a random id under which failed verify attempts are counted, so a
 * stranger who never started a sign-in for an address cannot spend that
 * address's attempts and lock its owner out. The per-address limit stays as a
 * wider backstop.
 *
 * `__Host-outlyy_email_start` in deployed environments (`outlyy_email_start`
 * on http://localhost, the same rule as the Google cookie): httpOnly, Secure
 * outside development, SameSite=Strict (only our own same-origin fetches use
 * it), Path=/, 15 minutes. It holds the first 32 hex characters of the
 * address's SHA-256 (never the address), the id and the issue time,
 * HMAC-SHA256 signed with a key derived from AUTH_COOKIE_SECRET under its own
 * label. Cleared on a successful verify.
 */

export const EMAIL_START_COOKIE = "outlyy_email_start";
export const EMAIL_START_COOKIE_MAX_AGE_SECONDS = 900;
const LABEL = "outlyy:email-start-cookie:v1";

export interface EmailStartCookieValue {
  /** First 32 hex characters of sha256(normalised email). */
  addressHash: string;
  /** Random id: the key of the per-start attempt counter. */
  id: string;
  issuedAt: number;
}

export function emailStartCookieName(): string {
  return env().APP_ENV !== "development" ? `__Host-${EMAIL_START_COOKIE}` : EMAIL_START_COOKIE;
}

function key(): Buffer {
  return createHmac("sha256", env().AUTH_COOKIE_SECRET).update(LABEL).digest();
}

function sign(body: string): string {
  return createHmac("sha256", key()).update(body).digest("base64url");
}

export function newEmailStartCookie(addressHash: string, now: Date = new Date()): EmailStartCookieValue {
  return { addressHash: addressHash.slice(0, 32), id: randomBytes(16).toString("base64url"), issuedAt: now.getTime() };
}

export function encodeEmailStartCookie(v: EmailStartCookieValue): string {
  const body = Buffer.from(JSON.stringify({ h: v.addressHash, i: v.id, t: v.issuedAt })).toString("base64url");
  return `${body}.${sign(body)}`;
}

/** Null when missing, tampered, malformed or older than the cookie's life. */
export function decodeEmailStartCookie(raw: string | undefined, now: Date = new Date()): EmailStartCookieValue | null {
  if (!raw || raw.length > 512) return null;
  const dot = raw.indexOf(".");
  if (dot < 1) return null;
  const body = raw.slice(0, dot);
  const given = Buffer.from(raw.slice(dot + 1), "base64url");
  const expected = Buffer.from(sign(body), "base64url");
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) return null;
  let p: { h?: unknown; i?: unknown; t?: unknown };
  try {
    p = JSON.parse(Buffer.from(body, "base64url").toString("utf8"));
  } catch {
    return null;
  }
  if (typeof p.h !== "string" || !/^[0-9a-f]{32}$/.test(p.h)) return null;
  if (typeof p.i !== "string" || !/^[A-Za-z0-9_-]{16,64}$/.test(p.i)) return null;
  if (typeof p.t !== "number") return null;
  const age = now.getTime() - p.t;
  if (age < -60_000 || age > EMAIL_START_COOKIE_MAX_AGE_SECONDS * 1000) return null;
  return { addressHash: p.h, id: p.i, issuedAt: p.t };
}

const base = () => ({
  httpOnly: true,
  sameSite: "strict" as const,
  secure: env().APP_ENV !== "development" || process.env.NODE_ENV === "production",
  path: "/",
});

export function setEmailStartCookie(res: NextResponse, v: EmailStartCookieValue) {
  res.cookies.set(emailStartCookieName(), encodeEmailStartCookie(v), { ...base(), maxAge: EMAIL_START_COOKIE_MAX_AGE_SECONDS });
}

export function clearEmailStartCookie(res: NextResponse) {
  res.cookies.set(emailStartCookieName(), "", { ...base(), maxAge: 0 });
}

export function emailStartCookieFromRequest(req: NextRequest): string | undefined {
  return req.cookies.get(emailStartCookieName())?.value || undefined;
}
