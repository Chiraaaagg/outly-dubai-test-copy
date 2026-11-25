import "server-only";
import type { NextRequest } from "next/server";
import type { GuestCapabilityGrant } from "@prisma/client";
import { prisma, type Tx } from "../lib/db";
import { env } from "../lib/env";
import { hasPermission, type Actor } from "../lib/actor";
import { ticketAccessFromRequest } from "../lib/customer-session";
import { authService } from "./auth.service";
import { customerAuthService } from "./customer-auth.service";
import { uuidv7 } from "../lib/ids";
import { decryptFor, encryptFor, hmacCandidates, hmacFor, randomToken, safeEqual, sha256Hex } from "../lib/crypto";
import { emitEvent } from "../lib/structured-events";
import type { CapabilityGrant, CapabilityIssuedFor, CapabilityPurpose } from "../documents/contracts";
import { GUARD_RELEASING_STATES } from "../suppliers/booking-port";

/**
 * Guest capability grants (TKT-5, doc 22 §10 line 225, §26 F39).
 *
 * A grant lets whoever holds its token reach one order for one purpose,
 * without an account. Rules:
 *
 *  - The token is 32 random bytes (base64url). Only `sha256Hex(token)` is
 *    stored. With `keepForRetry` the token is also kept encrypted under the
 *    `capability_tokens` ring, so a notification whose send outcome is
 *    `unknown` can be re-rendered byte for byte under the same provider
 *    idempotency key (TKT-6); the ciphertext is cleared as soon as that
 *    outcome is known.
 *  - Minting supersedes: by default (`supersede: "now"`) the live grants of
 *    the same (order, purpose) are revoked (`superseded`) in the same
 *    transaction, so a staff resend kills the previous link. With
 *    `supersede: "after_sent"` nothing is revoked at mint; the caller calls
 *    `supersedePrevious` once the message carrying the new link is known to
 *    be `sent`, so a send the provider rejects never leaves the customer
 *    without a working link (R-B4-4).
 *  - Exchange is a deliberate POST from the landing page, never a GET, so a
 *    mail scanner or link preview consumes nothing. Unknown, expired, revoked
 *    and over-used tokens get one uniform refusal; the reason goes to the
 *    structured log only. Exchange is bounded (`maxExchanges`).
 *  - A successful exchange yields an access entry signed with the
 *    `access_cookie` HMAC ring, carrying the grant id and an expiry of at
 *    most `accessSessionMs` and never after the grant's own expiry. One
 *    browser keeps several entries in its access cookie, one per grant
 *    (R-B4-11): `addAccessEntry` adds one, drops expired, forged and
 *    duplicate entries and keeps the `ACCESS_COOKIE_MAX_ENTRIES` newest.
 *    `resolveAccessForOrder` re-reads the grants on every request, so a
 *    revocation takes effect at once. The cookie never holds an order id,
 *    a purpose or a token.
 *  - The database guard (migration 20261102110000) keeps token, order and
 *    purpose fixed, never extends an expiry and keeps a revoked grant
 *    revoked.
 *  - Checkout grants (`issued_for = 'checkout'`, checkout redesign batch 3,
 *    CO-02): one per order (partial unique index, migration
 *    20261112120000), `download_tickets`, a fixed 24 hours from the
 *    order-bound verification. Their token is discarded at mint: the browser
 *    that checked out receives a signed access entry straight away
 *    (`checkoutAccess`), so there is nothing to exchange, mail or log. Like
 *    recovery grants they are never superseded by a message. While the
 *    `GUEST_DOWNLOAD_GRANT_ENABLED` release switch is off, every resolver
 *    ignores them.
 */

type Db = Tx | typeof prisma;

const DAY_MS = 24 * 3600_000;

/**
 * PROVISIONAL limits (owner policy pending; doc 22 §24.3 leaves holders and
 * thresholds to the owner). Change here only.
 */
export const CAPABILITY_LIMITS = Object.freeze({
  /** download_tickets and view_status: this long after the end of the order's last service date… */
  afterLastServiceMs: 30 * DAY_MS,
  /** …but never less than this from minting… */
  minTtlMs: 7 * DAY_MS,
  /** …and never more. */
  maxTtlMs: 180 * DAY_MS,
  /** cancel_request: a short, fixed window. */
  cancelRequestTtlMs: 3 * DAY_MS,
  /** Exchanges per grant (a customer opening the email on a few devices). */
  maxExchanges: 10,
  /** Access session made by one exchange. */
  accessSessionMs: 12 * 3600_000,
  /** Checkout grant (batch 3, CO-02): the longest it may live after the order-bound verification (`GUEST_DOWNLOAD_GRANT_HOURS` may shorten it). */
  checkoutGrantMaxMs: 24 * 3600_000,
});

/**
 * The checkout grant's lifetime after the order-bound verification: `GUEST_DOWNLOAD_GRANT_HOURS`
 * (default 24), bounded to 1–24 hours whatever is configured. Fixed per grant at mint; never extended.
 */
export function checkoutGrantMs(): number {
  const hours = env().GUEST_DOWNLOAD_GRANT_HOURS;
  const bounded = Number.isFinite(hours) ? Math.min(24, Math.max(1, Math.floor(hours))) : 24;
  return Math.min(CAPABILITY_LIMITS.checkoutGrantMaxMs, bounded * 3600_000);
}

/** Grants earned by proving control of the order (not carried by a message): no later message supersedes them. */
const NEVER_SUPERSEDED: CapabilityIssuedFor[] = ["recovery", "checkout"];

/** The guest same-browser download release switch (`GUEST_DOWNLOAD_GRANT_ENABLED`, strict, default off). */
export function checkoutGrantsEnabled(): boolean {
  return env().GUEST_DOWNLOAD_GRANT_ENABLED === true;
}

const TOKEN = /^[A-Za-z0-9_-]{43,128}$/;
const COOKIE_VERSION = "v1";
/** Entries for checkout grants carry their own version, inside the signature, so eviction can tell them apart (batch 3 review). */
const CHECKOUT_COOKIE_VERSION = "c1";
type EntryVersion = typeof COOKIE_VERSION | typeof CHECKOUT_COOKIE_VERSION;
/** Entries in one access cookie are joined with this (a cookie-octet, never inside an entry). */
const ENTRY_SEPARATOR = "~";
/** One browser keeps at most this many grants (the newest), so the cookie stays far below 4 KB. */
export const ACCESS_COOKIE_MAX_ENTRIES = 8;
/** An entry is about 115 characters; anything longer than this is not ours and is ignored whole. */
const ACCESS_COOKIE_MAX_LENGTH = 3800;
const ENTRY_MAX_LENGTH = 300;

export interface MintInput {
  orderId: string;
  purpose: CapabilityPurpose;
  issuedFor: CapabilityIssuedFor;
  notificationId?: string | null;
  /** Keep the token encrypted until the carrying message's outcome is known (TKT-6). */
  keepForRetry?: boolean;
  /**
   * `now` (default): revoke the live grants of the same order and purpose in
   * the mint's transaction. `after_sent`: revoke nothing yet; the caller
   * calls `supersedePrevious(db, grantId)` once the new message is `sent`
   * (R-B4-4). Recovery mints with `after_sent` and never supersedes, so a
   * recovered browser does not kill the emailed link.
   */
  supersede?: "now" | "after_sent";
  /** An earlier expiry than the purpose's own (never a later one): the checkout grant's fixed 24 hours. */
  notAfter?: Date;
}

export interface MintResult {
  grantId: string;
  /** The bearer token. Goes into one message and nowhere else: never logged, never stored in plaintext. */
  token: string;
  expiresAt: Date;
}

/** `customer`: "Remove access on this browser" (batch 3 review; migration 20261112120000). */
export type RevokeReason = "superseded" | "staff" | "erasure" | "order_cancelled" | "customer";

/** `cookieValue` is one signed access entry; add it to the browser's cookie with `addAccessEntry`. */
export type ExchangeResult = { ok: true; grantId: string; orderId: string; purpose: CapabilityPurpose; cookieValue: string; expiresAt: Date } | { ok: false };

export interface TicketAccess {
  grantId: string;
  orderId: string;
  purpose: CapabilityPurpose;
  /** Where the grant came from (audit only; never a reason to grant more). */
  issuedFor: CapabilityIssuedFor;
  /** When the access session ends (cookie expiry or grant expiry, whichever is first). */
  expiresAt: Date;
}

function toGrant(row: GuestCapabilityGrant): CapabilityGrant {
  return {
    id: row.id,
    orderId: row.orderId,
    purpose: row.purpose as CapabilityPurpose,
    expiresAt: row.expiresAt,
    revokedAt: row.revokedAt,
    exchangedAt: row.exchangedAt,
  };
}

async function inTransaction<T>(db: Db, fn: (tx: Tx) => Promise<T>): Promise<T> {
  if ("$transaction" in db && typeof db.$transaction === "function") return (db as typeof prisma).$transaction(fn);
  return fn(db as Tx);
}

function plausibleToken(token: unknown): token is string {
  return typeof token === "string" && TOKEN.test(token);
}

/** Grant expiry for a purpose, from the order's service dates. Exported for tests. */
export function grantExpiry(purpose: CapabilityPurpose, lastServiceDate: Date | null, now: Date): Date {
  const L = CAPABILITY_LIMITS;
  if (purpose === "cancel_request") return new Date(now.getTime() + L.cancelRequestTtlMs);
  const min = now.getTime() + L.minTtlMs;
  const max = now.getTime() + L.maxTtlMs;
  // A service date is a calendar day (UTC midnight in the column): count from the end of it.
  const wanted = lastServiceDate ? lastServiceDate.getTime() + DAY_MS + L.afterLastServiceMs : min;
  return new Date(Math.min(max, Math.max(min, wanted)));
}

function cookiePayload(version: EntryVersion, grantId: string, expSeconds: number): string {
  return `ticket_access:${version}:${grantId}:${expSeconds}`;
}

/**
 * `v1.<grantId>.<exp seconds>.<hmac>` (`c1.` for a checkout grant). Carries no order id, purpose or token.
 * The version is inside the signed payload, so an entry cannot be relabelled.
 */
function signCookie(grantId: string, expiresAt: Date, version: EntryVersion = COOKIE_VERSION): string {
  const exp = Math.floor(expiresAt.getTime() / 1000);
  return [version, grantId, String(exp), hmacFor("access_cookie", cookiePayload(version, grantId, exp))].join(".");
}

function verifyCookie(value: string | undefined | null, now: Date): { grantId: string; expiresAt: Date; checkout: boolean } | null {
  if (!value || value.length > ENTRY_MAX_LENGTH) return null;
  const parts = value.split(".");
  if (parts.length !== 4 || (parts[0] !== COOKIE_VERSION && parts[0] !== CHECKOUT_COOKIE_VERSION)) return null;
  const [version, grantId, expRaw, sig] = parts as [EntryVersion, string, string, string];
  if (!/^[0-9a-f-]{36}$/.test(grantId) || !/^\d{1,12}$/.test(expRaw) || !/^[0-9a-f]{64}$/.test(sig)) return null;
  const exp = Number(expRaw);
  // Every key in the ring verifies, so a rotation does not sign everyone out.
  const ok = hmacCandidates("access_cookie", cookiePayload(version, grantId, exp)).some((c) => safeEqual(c, sig));
  if (!ok) return null;
  const expiresAt = new Date(exp * 1000);
  if (expiresAt.getTime() <= now.getTime()) return null;
  return { grantId, expiresAt, checkout: version === CHECKOUT_COOKIE_VERSION };
}

interface AccessEntry {
  grantId: string;
  expiresAt: Date;
  /** A checkout-grant entry (`c1`): evicted before any other when the cookie is full. */
  checkout: boolean;
  raw: string;
}

/**
 * The verified, unexpired entries of an access cookie, oldest first, one per
 * grant (the later copy wins). A value that is too long is ignored whole; a
 * forged or expired entry is dropped without affecting the others. A cookie
 * written before B5 holds one entry and reads the same way.
 */
function accessEntries(value: string | undefined | null, now: Date): AccessEntry[] {
  if (!value || value.length > ACCESS_COOKIE_MAX_LENGTH) return [];
  const out: AccessEntry[] = [];
  for (const raw of value.split(ENTRY_SEPARATOR).slice(-ACCESS_COOKIE_MAX_ENTRIES * 2)) {
    const claims = verifyCookie(raw, now);
    if (!claims) continue;
    const at = out.findIndex((e) => e.grantId === claims.grantId);
    if (at >= 0) out.splice(at, 1);
    out.push({ ...claims, raw });
  }
  return out;
}

function toAccess(row: GuestCapabilityGrant, entry: AccessEntry): TicketAccess {
  return {
    grantId: row.id,
    orderId: row.orderId,
    purpose: row.purpose as CapabilityPurpose,
    issuedFor: row.issuedFor as CapabilityIssuedFor,
    expiresAt: new Date(Math.min(entry.expiresAt.getTime(), row.expiresAt.getTime())),
  };
}

/**
 * The live grants behind a cookie's entries, newest entry first. One query, re-read on every request.
 * Checkout grants count only while their release switch is on.
 */
async function liveAccess(value: string | undefined | null, now: Date, db: Db, orderId?: string): Promise<TicketAccess[]> {
  const entries = accessEntries(value, now);
  if (!entries.length) return [];
  const rows = await db.guestCapabilityGrant.findMany({ where: { id: { in: entries.map((e) => e.grantId) }, ...(orderId ? { orderId } : {}) } });
  const checkoutOn = checkoutGrantsEnabled();
  const live = new Map(
    rows.filter((r) => !r.revokedAt && r.expiresAt.getTime() > now.getTime() && (checkoutOn || r.issuedFor !== "checkout")).map((r) => [r.id, r]),
  );
  return entries
    .reverse()
    .filter((e) => live.has(e.grantId))
    .map((e) => toAccess(live.get(e.grantId)!, e));
}

/**
 * The browser's access cookie with `entry` added: expired, forged and
 * duplicate entries dropped, at most `ACCESS_COOKIE_MAX_ENTRIES` kept.
 * When it is full, checkout-grant entries go first, oldest first, and only
 * then the oldest other entry, so abandoned checkouts never push out an
 * emailed link or a recovery (batch 3 review). A new checkout entry that
 * would itself be the one to go is simply not added (`added: false`).
 * `expiresAt` is the latest entry expiry (the cookie lives as long as its
 * longest entry; each entry still expires on its own). Null when `entry`
 * itself does not verify.
 */
export function addAccessEntry(existing: string | undefined | null, entry: string, now: Date = new Date()): { value: string; expiresAt: Date; added: boolean } | null {
  const claims = verifyCookie(entry, now);
  if (!claims) return null;
  const fresh: AccessEntry = { ...claims, raw: entry };
  const all = [...accessEntries(existing, now).filter((e) => e.grantId !== claims.grantId), fresh];
  while (all.length > ACCESS_COOKIE_MAX_ENTRIES) {
    const oldestCheckout = all.findIndex((e) => e.checkout);
    all.splice(oldestCheckout >= 0 ? oldestCheckout : 0, 1);
  }
  if (!all.length) return null;
  const expiresAt = new Date(Math.max(...all.map((e) => e.expiresAt.getTime())));
  return { value: all.map((e) => e.raw).join(ENTRY_SEPARATOR), expiresAt, added: all.includes(fresh) };
}

/** The verified entries of a cookie with their grant ids and kinds (no database read). For "Remove access on this browser". */
export function accessCookieGrants(value: string | undefined | null, now: Date = new Date()): { grantId: string; checkout: boolean }[] {
  return accessEntries(value, now).map((e) => ({ grantId: e.grantId, checkout: e.checkout }));
}

function refused(reason: string): { ok: false } {
  emitEvent("capability.refused", { reason });
  return { ok: false };
}

export const capabilityService = {
  /**
   * Mints a grant and, unless `supersede: "after_sent"`, supersedes the live
   * grants of the same order and purpose, in one transaction (on `db` when it
   * already is one).
   */
  async mint(db: Db, input: MintInput, now: Date = new Date()): Promise<MintResult> {
    const token = randomToken(32);
    const grantId = uuidv7();
    const supersedeNow = (input.supersede ?? "now") === "now";
    const result = await inTransaction(db, async (tx) => {
      const last = await tx.orderItem.aggregate({ where: { orderId: input.orderId }, _max: { serviceDate: true } });
      const own = grantExpiry(input.purpose, last._max.serviceDate ?? null, now);
      const expiresAt = input.notAfter && input.notAfter.getTime() < own.getTime() ? input.notAfter : own;
      const superseded = supersedeNow
        ? await tx.guestCapabilityGrant.findMany({ where: { orderId: input.orderId, purpose: input.purpose, revokedAt: null, issuedFor: { notIn: NEVER_SUPERSEDED } }, select: { id: true } })
        : [];
      if (superseded.length) {
        await tx.guestCapabilityGrant.updateMany({
          where: { id: { in: superseded.map((g) => g.id) }, revokedAt: null },
          data: { revokedAt: now, revokeReason: "superseded", tokenCiphertext: null },
        });
      }
      await tx.guestCapabilityGrant.create({
        data: {
          id: grantId,
          tokenHash: sha256Hex(token),
          tokenCiphertext: input.keepForRetry ? encryptFor("capability_tokens", token) : null,
          orderId: input.orderId,
          purpose: input.purpose,
          issuedFor: input.issuedFor,
          notificationId: input.notificationId ?? null,
          expiresAt,
          createdAt: now,
        },
      });
      return { expiresAt, superseded: superseded.map((g) => g.id) };
    });
    for (const id of result.superseded) emitEvent("capability.revoked", { grantId: id, reason: "superseded" });
    emitEvent("capability.minted", { grantId, purpose: input.purpose, issuedFor: input.issuedFor });
    return { grantId, token, expiresAt: result.expiresAt };
  },

  /**
   * R-B4-4: revokes (`superseded`) the live grants of the same order and
   * purpose created before `grantId`, once the message carrying `grantId` is
   * known to be `sent`. Revokes nothing when `grantId` is unknown or no
   * longer live, so a failed or withdrawn link never takes the working one
   * with it. Idempotent. Returns the number of grants revoked now.
   */
  async supersedePrevious(db: Db, grantId: string, now: Date = new Date()): Promise<number> {
    const g = await db.guestCapabilityGrant.findUnique({ where: { id: grantId }, select: { id: true, orderId: true, purpose: true, createdAt: true, revokedAt: true, expiresAt: true } });
    if (!g || g.revokedAt || g.expiresAt.getTime() <= now.getTime()) return 0;
    const older = await db.guestCapabilityGrant.findMany({
      where: {
        orderId: g.orderId,
        purpose: g.purpose,
        revokedAt: null,
        id: { not: g.id },
        // A recovery or checkout grant was earned by proving control of the verified contact, not carried
        // by a message, so a newer message does not replace it (B5, batch 3). Erasure and staff revocation still do.
        issuedFor: { notIn: NEVER_SUPERSEDED },
        // Created before this grant; ids are time-ordered (UUIDv7) and break a tie on the same instant.
        OR: [{ createdAt: { lt: g.createdAt } }, { createdAt: g.createdAt, id: { lt: g.id } }],
      },
      select: { id: true },
    });
    if (!older.length) return 0;
    const r = await db.guestCapabilityGrant.updateMany({
      where: { id: { in: older.map((o) => o.id) }, revokedAt: null },
      data: { revokedAt: now, revokeReason: "superseded", tokenCiphertext: null },
    });
    for (const o of older) emitEvent("capability.revoked", { grantId: o.id, reason: "superseded" });
    return r.count;
  },

  /**
   * The deliberate exchange (POST only). Counts the exchange, records the
   * first one, and returns a signed access-cookie value. Any refusal is the
   * same `{ ok: false }`.
   */
  async exchange(token: unknown, now: Date = new Date(), db: Db = prisma): Promise<ExchangeResult> {
    if (!plausibleToken(token)) return refused("malformed");
    const row = await db.guestCapabilityGrant.findUnique({ where: { tokenHash: sha256Hex(token) } });
    if (!row) return refused("unknown");
    if (row.revokedAt) return refused("revoked");
    if (row.expiresAt.getTime() <= now.getTime()) return refused("expired");
    if (row.exchangeCount >= CAPABILITY_LIMITS.maxExchanges) return refused("exhausted");
    // Conditional, so concurrent exchanges cannot pass the cap or race a revocation.
    const updated = await db.$executeRaw`
      UPDATE "guest_capability_grants"
         SET "exchange_count" = "exchange_count" + 1,
             "exchanged_at" = COALESCE("exchanged_at", ${now})
       WHERE "id" = ${row.id}::uuid
         AND "revoked_at" IS NULL
         AND "expires_at" > ${now}
         AND "exchange_count" < ${CAPABILITY_LIMITS.maxExchanges}`;
    if (updated !== 1) return refused("raced");
    const expiresAt = new Date(Math.min(now.getTime() + CAPABILITY_LIMITS.accessSessionMs, row.expiresAt.getTime()));
    emitEvent("capability.exchanged", { grantId: row.id, purpose: row.purpose });
    return { ok: true, grantId: row.id, orderId: row.orderId, purpose: row.purpose as CapabilityPurpose, cookieValue: signCookie(row.id, expiresAt), expiresAt };
  },

  /**
   * Resolves an access cookie to its newest live grant. Verifies each
   * entry's signature and expiry, then re-reads the grants: revoked or
   * expired grants resolve to nothing at once. Routes that serve one order
   * use `resolveAccessForOrder`.
   */
  async resolveAccess(cookieValue: string | undefined | null, now: Date = new Date(), db: Db = prisma): Promise<TicketAccess | null> {
    return (await liveAccess(cookieValue, now, db))[0] ?? null;
  },

  /** Every live grant in the cookie for this order (newest first), re-read now. Empty when none. */
  async resolveAccessForOrder(cookieValue: string | undefined | null, orderId: string, now: Date = new Date(), db: Db = prisma): Promise<TicketAccess[]> {
    return liveAccess(cookieValue, now, db, orderId);
  },

  /**
   * The order's one checkout grant as a signed access entry (checkout redesign
   * batch 3, CO-02). The caller has already proven, in the database, that the
   * browser is the guest session that made the order's quote and that the
   * order-bound verification exists; `notAfter` is that verification's time
   * plus `checkoutGrantMs()`.
   *
   * Minted the first time (`download_tickets`, never superseding anything, its
   * token discarded here); re-signed while it lives, with its own expiry; and
   * never minted again once it is revoked or expired, so calling checkout
   * again cannot undo a revocation. Null when the switch is off or no grant
   * can be given.
   */
  async checkoutAccess(db: Db, input: { orderId: string; notAfter: Date }, now: Date = new Date()): Promise<{ grantId: string; cookieValue: string; expiresAt: Date; reused: boolean } | null> {
    if (!checkoutGrantsEnabled()) return null;
    const existing = await db.guestCapabilityGrant.findFirst({ where: { orderId: input.orderId, issuedFor: "checkout" } });
    if (existing) {
      if (existing.revokedAt || existing.purpose !== "download_tickets" || existing.expiresAt.getTime() <= now.getTime()) return null;
      return { grantId: existing.id, cookieValue: signCookie(existing.id, existing.expiresAt, CHECKOUT_COOKIE_VERSION), expiresAt: existing.expiresAt, reused: true };
    }
    if (input.notAfter.getTime() <= now.getTime()) return null;
    let minted: MintResult;
    try {
      minted = await capabilityService.mint(db, { orderId: input.orderId, purpose: "download_tickets", issuedFor: "checkout", supersede: "after_sent", notAfter: input.notAfter }, now);
    } catch (e) {
      // Two checkout calls for the same order at once: the partial unique index lets one in; the other re-reads it.
      if ((e as { code?: string })?.code !== "P2002") throw e;
      const winner = await db.guestCapabilityGrant.findFirst({ where: { orderId: input.orderId, issuedFor: "checkout", revokedAt: null, expiresAt: { gt: now } } });
      return winner ? { grantId: winner.id, cookieValue: signCookie(winner.id, winner.expiresAt, CHECKOUT_COOKIE_VERSION), expiresAt: winner.expiresAt, reused: true } : null;
    }
    return { grantId: minted.grantId, cookieValue: signCookie(minted.grantId, minted.expiresAt, CHECKOUT_COOKIE_VERSION), expiresAt: minted.expiresAt, reused: false };
  },

  /**
   * "Remove access on this browser" (batch 3 review): revokes (`customer`) every
   * live checkout grant named by this browser's verified access-cookie entries.
   * Grants of other origins are not revoked (an emailed link must keep working
   * elsewhere); the caller clears the cookie. Idempotent. Returns the number
   * revoked now.
   */
  async revokeBrowserCheckoutGrants(db: Db, cookieValue: string | undefined | null, now: Date = new Date()): Promise<number> {
    const ids = accessEntries(cookieValue, now).filter((e) => e.checkout).map((e) => e.grantId);
    if (!ids.length) return 0;
    const live = await db.guestCapabilityGrant.findMany({ where: { id: { in: ids }, issuedFor: "checkout", revokedAt: null }, select: { id: true } });
    let n = 0;
    for (const g of live) if (await capabilityService.revoke(db, g.id, "customer", now)) n += 1;
    return n;
  },

  async get(grantId: string, db: Db = prisma): Promise<CapabilityGrant | null> {
    const row = await db.guestCapabilityGrant.findUnique({ where: { id: grantId } });
    return row ? toGrant(row) : null;
  },

  /** The grant minted for a notification row (the latest, if several). */
  async findForNotification(notificationId: string, db: Db = prisma): Promise<(CapabilityGrant & { hasCiphertext: boolean; revokeReason: string | null }) | null> {
    const row = await db.guestCapabilityGrant.findFirst({ where: { notificationId }, orderBy: { createdAt: "desc" } });
    return row ? { ...toGrant(row), hasCiphertext: Boolean(row.tokenCiphertext), revokeReason: row.revokeReason } : null;
  },

  /**
   * The kept token of a live grant, to re-render an `unknown` send
   * identically. Null when the grant is revoked, expired or has no ciphertext.
   */
  async tokenForRetry(grantId: string, now: Date = new Date(), db: Db = prisma): Promise<string | null> {
    const row = await db.guestCapabilityGrant.findUnique({ where: { id: grantId } });
    if (!row || row.revokedAt || !row.tokenCiphertext || row.expiresAt.getTime() <= now.getTime()) return null;
    const token = decryptFor("capability_tokens", row.tokenCiphertext);
    // Defence in depth: the ciphertext must still match the stored hash.
    return safeEqual(sha256Hex(token), row.tokenHash) ? token : null;
  },

  /** Revokes one grant (and drops its ciphertext). False when it was not live. */
  async revoke(db: Db, grantId: string, reason: RevokeReason, now: Date = new Date()): Promise<boolean> {
    const r = await db.guestCapabilityGrant.updateMany({
      where: { id: grantId, revokedAt: null },
      data: { revokedAt: now, revokeReason: reason, tokenCiphertext: null },
    });
    if (r.count === 1) emitEvent("capability.revoked", { grantId, reason });
    return r.count === 1;
  },

  /**
   * Revokes every live grant of these orders and drops every kept token,
   * revoked or not. The privacy erasure calls this (PRV-3). Returns the
   * number of grants revoked now.
   */
  async revokeAllForOrders(db: Db, orderIds: readonly string[], reason: RevokeReason, now: Date = new Date(), opts: { issuedFor?: CapabilityIssuedFor[] } = {}): Promise<number> {
    if (!orderIds.length) return 0;
    const ids = [...new Set(orderIds)];
    // `issuedFor` narrows it (an ended order revokes only its checkout grants; erasure revokes everything).
    const scope = opts.issuedFor ? { issuedFor: { in: opts.issuedFor } } : {};
    const live = await db.guestCapabilityGrant.findMany({ where: { orderId: { in: ids }, revokedAt: null, ...scope }, select: { id: true } });
    const r = await db.guestCapabilityGrant.updateMany({
      where: { id: { in: live.map((g) => g.id) }, revokedAt: null },
      data: { revokedAt: now, revokeReason: reason, tokenCiphertext: null },
    });
    await db.guestCapabilityGrant.updateMany({ where: { orderId: { in: ids }, tokenCiphertext: { not: null }, ...scope }, data: { tokenCiphertext: null } });
    for (const g of live) emitEvent("capability.revoked", { grantId: g.id, reason });
    return r.count;
  },

  /** Drops the kept token once the carrying message's outcome is known. */
  async clearCiphertext(grantId: string, db: Db = prisma): Promise<void> {
    await db.guestCapabilityGrant.updateMany({ where: { id: grantId, tokenCiphertext: { not: null } }, data: { tokenCiphertext: null } });
  },
};

/* ---------------------------------------------------------------------------
 * Per-request ticket access (TKT-3, TKT-4, TKT-5; doc 22 §24.3, §26 F55)
 * ------------------------------------------------------------------------ */

/** What the caller wants: the document list (status) or a document's bytes. */
export type TicketNeed = "view" | "download";

export type TicketPrincipal = { kind: "customer" } | { kind: "guest"; grantId: string; issuedFor: CapabilityIssuedFor } | { kind: "staff"; actor: Actor };

export interface TicketOrder {
  id: string;
  reference: string;
  customerId: string | null;
}

/**
 * Who may reach an order's tickets, decided on every request:
 *  - a customer session whose customer owns the order (`orders.customer_id`;
 *    never a phone match, TKT-4);
 *  - a ticket-access cookie holding a live grant for this order, with
 *    purpose `download_tickets` for a download (`view_status` also lists);
 *    the cookie may hold grants for other orders too (R-B4-11). A checkout
 *    grant (batch 3) is one of these while its release switch is on;
 *  - staff holding `tickets.view` (the caller audits the access).
 * Anything else is null; routes answer 404 so existence never leaks.
 */
export const ticketAccess = {
  async orderByReference(reference: string, db: Db = prisma): Promise<TicketOrder | null> {
    return db.order.findUnique({ where: { reference }, select: { id: true, reference: true, customerId: true } });
  },

  /** The reference of an order a grant names (the exchange answers with it, B5). */
  async referenceOf(orderId: string, db: Db = prisma): Promise<string | null> {
    return (await db.order.findUnique({ where: { id: orderId }, select: { reference: true } }))?.reference ?? null;
  },

  /**
   * The order a document belongs to, without reading the document.
   * `customerVisible` is false for internal documents and, after a verified
   * cancellation or any other end that releases the booking (R-B5-8), for
   * every document of that booking: its tickets are void, so the customer
   * and guest download answers 404 like any other hidden document. Staff
   * still reach it.
   */
  async documentOwner(documentId: string, db: Db = prisma): Promise<{ order: TicketOrder; customerVisible: boolean } | null> {
    const doc = await db.supplierDocument.findUnique({ where: { id: documentId }, select: { orderId: true, customerVisible: true, supplierBooking: { select: { state: true } } } });
    if (!doc?.orderId) return null;
    const order = await db.order.findUnique({ where: { id: doc.orderId }, select: { id: true, reference: true, customerId: true } });
    const released = (GUARD_RELEASING_STATES as readonly string[]).includes(doc.supplierBooking.state);
    return order ? { order, customerVisible: doc.customerVisible && !released } : null;
  },

  async authorize(req: NextRequest, order: TicketOrder, need: TicketNeed, now: Date = new Date()): Promise<TicketPrincipal | null> {
    const customer = await customerAuthService.resolveRequest(req);
    if (customer && order.customerId && customer.customer.id === order.customerId) return { kind: "customer" };

    // The cookie may hold grants for several orders (R-B4-11); only this order's live ones count.
    const grants = await capabilityService.resolveAccessForOrder(ticketAccessFromRequest(req), order.id, now);
    const fits = (g: TicketAccess) => (need === "download" ? g.purpose === "download_tickets" : g.purpose === "download_tickets" || g.purpose === "view_status");
    // Another grant first, so the checkout grant's own download budget applies only when it is the one used (batch 3 review).
    const grant = grants.find((g) => fits(g) && g.issuedFor !== "checkout") ?? grants.find(fits);
    if (grant) return { kind: "guest", grantId: grant.grantId, issuedFor: grant.issuedFor };

    const staff = await authService.resolveRequest(req);
    if (staff && hasPermission(staff.actor, "tickets.view")) return { kind: "staff", actor: staff.actor };
    return null;
  },
};
