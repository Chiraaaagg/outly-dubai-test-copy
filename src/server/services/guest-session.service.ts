import "server-only";
import type { NextRequest } from "next/server";
import { prisma, type Tx } from "../lib/db";
import { uuidv7 } from "../lib/ids";
import { randomToken, sha256Hex } from "../lib/crypto";
import { guestTokenFromCookies, guestTokenFromRequest } from "../lib/customer-session";
import { isSessionLive } from "../domain/otp";
import type { QuoteSnapshot } from "../quotes/contracts";

/**
 * Guest checkout sessions (doc 22 §23 B2, TKT-4).
 *
 * A browser identity for checkout without an account. It owns quotes and,
 * through them, contact verifications; it never creates or implies a
 * customer row, and it is not a recovery credential after payment (that is
 * the B4 capability token).
 *
 *  - Token: 32 random bytes, base64url, sent only in the httpOnly
 *    `outlyy_guest_session` cookie. Only its SHA-256 is stored.
 *  - Fixed expiry (`GUEST_SESSION_TTL_MS`), no sliding extension.
 *  - Revocation sets `revoked_at`; a revoked or expired row never resolves.
 *    Rows are not deleted here: quotes reference them (ON DELETE RESTRICT).
 */

export const GUEST_SESSION_TTL_MS = 24 * 3600_000;

type Db = Tx | typeof prisma;

export interface GuestSessionHandle {
  guestSessionId: string;
  expiresAt: Date;
}

function plausibleToken(token: string | undefined): token is string {
  return Boolean(token) && token!.length >= 16 && token!.length <= 256;
}

export const guestSessionService = {
  /** Opens a session. The caller sets the cookie with `setGuestCookie(res, token, expiresAt)`. */
  async create(now: Date = new Date(), db: Db = prisma): Promise<GuestSessionHandle & { token: string }> {
    const token = randomToken(32);
    const id = uuidv7();
    const expiresAt = new Date(now.getTime() + GUEST_SESSION_TTL_MS);
    await db.guestSession.create({ data: { id, tokenHash: sha256Hex(token), createdAt: now, expiresAt } });
    return { token, guestSessionId: id, expiresAt };
  },

  async resolveToken(token: string | undefined, now: Date = new Date(), db: Db = prisma): Promise<GuestSessionHandle | null> {
    if (!plausibleToken(token)) return null;
    const row = await db.guestSession.findUnique({ where: { tokenHash: sha256Hex(token) } });
    if (!row || !isSessionLive(row, now)) return null;
    return { guestSessionId: row.id, expiresAt: row.expiresAt };
  },

  /** Route handlers. */
  async resolveRequest(req: NextRequest): Promise<GuestSessionHandle | null> {
    return guestSessionService.resolveToken(guestTokenFromRequest(req));
  },

  /** Server Components / Server Actions. */
  async resolveCookies(): Promise<GuestSessionHandle | null> {
    return guestSessionService.resolveToken(await guestTokenFromCookies());
  },

  /** Whether this id names a live session; quote and verification services check owners with it. */
  async isLive(guestSessionId: string, now: Date = new Date(), db: Db = prisma): Promise<boolean> {
    const row = await db.guestSession.findUnique({ where: { id: guestSessionId } });
    return Boolean(row && isSessionLive(row, now));
  },

  /** Revokes by token (the cookie). Returns false when there was nothing live to revoke. */
  async revoke(token: string | undefined, now: Date = new Date(), db: Db = prisma): Promise<boolean> {
    if (!plausibleToken(token)) return false;
    const r = await db.guestSession.updateMany({ where: { tokenHash: sha256Hex(token), revokedAt: null }, data: { revokedAt: now } });
    return r.count === 1;
  },

  async revokeById(guestSessionId: string, now: Date = new Date(), db: Db = prisma): Promise<boolean> {
    const r = await db.guestSession.updateMany({ where: { id: guestSessionId, revokedAt: null }, data: { revokedAt: now } });
    return r.count === 1;
  },

  owner(handle: GuestSessionHandle): QuoteSnapshot["owner"] {
    return { kind: "guest", guestSessionId: handle.guestSessionId };
  },
};
