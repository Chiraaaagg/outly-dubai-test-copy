import "server-only";
import type { NextRequest } from "next/server";
import { prisma, type Tx } from "../lib/db";
import { isValidReference } from "../lib/ids";
import { ticketAccessFromCookies, ticketAccessFromRequest } from "../lib/customer-session";
import { capabilityService } from "./capability.service";
import { customerAuthService } from "./customer-auth.service";
import { guestSessionService } from "./guest-session.service";
import type { CapabilityIssuedFor, CapabilityPurpose } from "../documents/contracts";

/**
 * Who may see an order by its reference (doc 22 §23 B5; TKT-4, TKT-5, F39).
 * Every customer route and server page that shows one order asks here, on
 * every request:
 *
 *  - the signed-in customer whose `orders.customer_id` it is (never a phone
 *    match, TKT-4);
 *  - the live guest session that created the order's quote
 *    (`quotes.used_by_order_id` = the order and `quotes.guest_session_id` =
 *    the caller's session): the same browser after the gateway's return;
 *  - a live ticket-access grant for this order with purpose `view_status` or
 *    `download_tickets`, from the `/t` exchange, a recovery challenge, or the
 *    guest checkout itself (checkout redesign batch 3, CO-02: the guest
 *    browser that made the quote and verified the order's contact, 24 hours,
 *    only while `GUEST_DOWNLOAD_GRANT_ENABLED` is on). The access cookie may
 *    hold grants for several orders (R-B4-11).
 *
 * Staff are not customers here: they use the console. Anything else is null,
 * and an unknown reference, a malformed one and someone else's order are the
 * same null, so callers answer one uniform 404.
 */

type Db = Tx | typeof prisma;

export type OrderAccessVia = "customer" | "guest_session" | "grant";

export interface OrderAccess {
  orderId: string;
  reference: string;
  via: OrderAccessVia;
  /** Whether the caller may also download the order's ticket documents (the owning customer, or a `download_tickets` grant). */
  canDownload: boolean;
  /** The grant used, when `via` is `grant`. */
  grantId: string | null;
  /** Where that grant came from (`checkout` grants may download but never request a cancellation). */
  grantIssuedFor?: CapabilityIssuedFor | null;
  /** The caller is also the live guest session that made the order's quote (checked only when a checkout grant is used). */
  quoteSession?: boolean;
}

/** What the caller presents: resolved credentials only, never a raw token. */
export interface OrderPrincipals {
  customerId: string | null;
  guestSessionId: string | null;
  accessCookie: string | undefined;
}

const VIEW_PURPOSES: readonly CapabilityPurpose[] = ["view_status", "download_tickets"];

/** `OUT-…` in upper case when it is a well-formed order reference, else null. */
export function normaliseOrderReference(raw: string | null | undefined): string | null {
  const reference = (raw ?? "").trim().toUpperCase();
  return reference.length <= 32 && isValidReference(reference, "OUT") ? reference : null;
}

/** The decision itself, on credentials already resolved. Exported for tests and for the two request forms below. */
export async function decideOrderAccess(rawReference: string, who: OrderPrincipals, now: Date = new Date(), db: Db = prisma): Promise<OrderAccess | null> {
  const reference = normaliseOrderReference(rawReference);
  if (!reference) return null;
  const order = await db.order.findUnique({ where: { reference }, select: { id: true, reference: true, customerId: true } });
  if (!order) return null;

  if (who.customerId && order.customerId && who.customerId === order.customerId) {
    return { orderId: order.id, reference: order.reference, via: "customer", canDownload: true, grantId: null };
  }

  const grants = (await capabilityService.resolveAccessForOrder(who.accessCookie, order.id, now, db)).filter((g) => VIEW_PURPOSES.includes(g.purpose));
  // The resolver already checked that the session is live; the quote must be the one this order was made from.
  const isQuoteSession = async () =>
    Boolean(who.guestSessionId && (await db.quote.findFirst({ where: { usedByOrderId: order.id, ownerKind: "guest", guestSessionId: who.guestSessionId }, select: { id: true } })));
  // An emailed link or a recovery first; the checkout grant (batch 3) only when it is the one download grant.
  const download = grants.find((g) => g.purpose === "download_tickets" && g.issuedFor !== "checkout") ?? grants.find((g) => g.purpose === "download_tickets");
  if (download) {
    const quoteSession = download.issuedFor === "checkout" ? await isQuoteSession() : false;
    return { orderId: order.id, reference: order.reference, via: "grant", canDownload: true, grantId: download.grantId, grantIssuedFor: download.issuedFor, quoteSession };
  }

  if (await isQuoteSession()) return { orderId: order.id, reference: order.reference, via: "guest_session", canDownload: false, grantId: null };

  if (grants[0]) return { orderId: order.id, reference: order.reference, via: "grant", canDownload: false, grantId: grants[0].grantId, grantIssuedFor: grants[0].issuedFor };
  return null;
}

export const orderAccessService = {
  /** Route handlers. */
  async forRequest(req: NextRequest, reference: string, now: Date = new Date()): Promise<OrderAccess | null> {
    if (!normaliseOrderReference(reference)) return null;
    const [customer, guest] = await Promise.all([customerAuthService.resolveRequest(req), guestSessionService.resolveRequest(req)]);
    return decideOrderAccess(reference, { customerId: customer?.customer.id ?? null, guestSessionId: guest?.guestSessionId ?? null, accessCookie: ticketAccessFromRequest(req) }, now);
  },

  /** Server Components / Server Actions (`cookies()`). */
  async fromCookies(reference: string, now: Date = new Date()): Promise<OrderAccess | null> {
    if (!normaliseOrderReference(reference)) return null;
    const [customer, guest, accessCookie] = await Promise.all([customerAuthService.resolveCookies(), guestSessionService.resolveCookies(), ticketAccessFromCookies()]);
    return decideOrderAccess(reference, { customerId: customer?.customer.id ?? null, guestSessionId: guest?.guestSessionId ?? null, accessCookie }, now);
  },

  /**
   * Whether this access may also ask for a cancellation (R-B5-7): the owning
   * customer, the guest session that made the quote, or a `download_tickets`
   * grant (the ticket email's link or a recovery). A `view_status` grant
   * only shows the order, and a checkout grant (batch 3 review) only
   * downloads: its browser may still ask through the guest session that made
   * the quote, as before. Callers refuse with the same uniform 404.
   */
  mayRequestCancellation(access: OrderAccess): boolean {
    if (access.via === "customer" || access.via === "guest_session" || access.quoteSession === true) return true;
    return access.via === "grant" && access.canDownload && access.grantIssuedFor !== "checkout";
  },

  /** How a request made through this access is recorded (`cancellation_requests.requested_via`). */
  requestedVia(access: OrderAccess): "customer" | "guest" {
    return access.via === "customer" ? "customer" : "guest";
  },
};
