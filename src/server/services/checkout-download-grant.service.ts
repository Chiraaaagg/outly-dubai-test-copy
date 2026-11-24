import "server-only";
import { prisma, type Tx } from "../lib/db";
import { safeEqual } from "../lib/crypto";
import { emitEvent } from "../lib/structured-events";
import { addAccessEntry, capabilityService, checkoutGrantMs, checkoutGrantsEnabled } from "./capability.service";
import { guestSessionService } from "./guest-session.service";

/**
 * Guest same-browser voucher download (checkout redesign batch 3, CO-02;
 * rollout-plan §1C; design: docs/checkout-redesign-review/notes/batch3-design.md).
 *
 * The browser that paid as a guest may download that order's vouchers on the
 * page it is sent to, for a fixed 24 hours, without an account. It gets the
 * order's one checkout grant (`download_tickets`, `issued_for = 'checkout'`)
 * as a signed entry ADDED to its `outlyy_ticket_access` cookie (HttpOnly,
 * Secure outside development, SameSite=Strict), in the 201 response of
 * `POST /api/checkout` and nowhere else.
 *
 * Issued only when, in the database:
 *  - the release switch `GUEST_DOWNLOAD_GRANT_ENABLED` is on;
 *  - the caller's guest session is live;
 *  - the quote this order was made from (`used_by_order_id`) was made by that
 *    guest session (`owner_kind = 'guest'`);
 *  - an order-bound contact verification exists for this order and that quote
 *    (checkout binds it in the transaction that creates the order), and the
 *    request names it: the `verificationId` in the checkout body must equal
 *    that verification's id (compared in constant time). A repeat checkout
 *    for a used quote (checkout.service hands back the same Stripe page
 *    without re-checking the verification) therefore re-signs the grant only
 *    for a caller that still holds the verification it paid with.
 *
 * Authority never comes from the request body, the URL or the order
 * reference: the only body field used is `verificationId`, and it only
 * narrows (it must match the bound verification found in the database). The grant expires `GUEST_DOWNLOAD_GRANT_HOURS` (default 24,
 * bounded 1–24) after that verification, is never
 * extended or re-minted (a revoked or expired one stays gone), is revocable
 * like any grant, and is ignored by every resolver while the switch is off.
 * Each refusal is a structured event with a reason code; the caller simply
 * sets no cookie.
 */

type Db = Tx | typeof prisma;

export interface CheckoutGrantInput {
  orderId: string;
  guestSessionId: string;
  /** The `verificationId` the checkout request carried; must be the order-bound one. */
  verificationId: string;
  /** The browser's current ticket-access cookie value: its other entries are kept. */
  existingCookie: string | undefined;
}

export interface CheckoutDownloadGrant {
  /** The browser's new access cookie (value and expiry), or null when no grant is given. */
  issue(input: CheckoutGrantInput, now?: Date): Promise<{ value: string; expiresAt: Date } | null>;
}

function refused(reason: string): null {
  emitEvent("capability.checkout_refused", { reason });
  return null;
}

export function createCheckoutDownloadGrant(db: Db = prisma): CheckoutDownloadGrant {
  return {
    async issue(input, now = new Date()) {
      if (!checkoutGrantsEnabled()) return null;
      if (!(await guestSessionService.isLive(input.guestSessionId, now, db))) return refused("session_not_live");
      const quote = await db.quote.findFirst({ where: { usedByOrderId: input.orderId, ownerKind: "guest", guestSessionId: input.guestSessionId }, select: { id: true } });
      if (!quote) return refused("not_quote_owner");
      const verification = await db.orderContactVerification.findFirst({
        where: { orderId: input.orderId, quoteId: quote.id },
        orderBy: { verifiedAt: "asc" },
        select: { id: true, verifiedAt: true },
      });
      if (!verification) return refused("not_verified");
      if (typeof input.verificationId !== "string" || !safeEqual(verification.id.toLowerCase(), input.verificationId.toLowerCase())) return refused("verification_mismatch");
      const notAfter = new Date(verification.verifiedAt.getTime() + checkoutGrantMs());
      const access = await capabilityService.checkoutAccess(db, { orderId: input.orderId, notAfter }, now);
      if (!access) return refused("grant_unavailable");
      const cookie = addAccessEntry(input.existingCookie, access.cookieValue, now);
      if (!cookie) return refused("entry_invalid");
      // The browser's cookie is full of emailed-link and recovery entries: the checkout entry gives way, not them.
      if (!cookie.added) return refused("cookie_full");
      emitEvent("capability.checkout_issued", { grantId: access.grantId, reused: access.reused });
      return { value: cookie.value, expiresAt: cookie.expiresAt };
    },
  };
}

export const checkoutDownloadGrant = createCheckoutDownloadGrant();
