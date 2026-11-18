import "server-only";
import type { NextRequest } from "next/server";
import { assertSameOrigin, clientIp, handle, json, parseJson } from "@/server/lib/http";
import { hashIp } from "@/server/lib/crypto";
import { env } from "@/server/lib/env";
import { Errors } from "@/server/lib/errors";
import { log } from "@/server/lib/logger";
import { enforceRateLimit } from "@/server/lib/rate-limit";
import { setTicketAccessCookie, ticketAccessFromRequest } from "@/server/lib/customer-session";
import type { CheckoutService } from "@/server/payments/contracts";
import type { CheckoutDownloadGrant } from "@/server/services/checkout-download-grant.service";
import { CHECKOUT_MAX_BYTES, checkoutSessionEnded, checkoutStartSchema, ownerKey, resolveCheckoutOwner } from "./shared";

/**
 * Per IP and per owner, Postgres-backed and failing closed. Each call can
 * open one gateway session (idempotent per quote), so a customer needs a
 * handful at most: a retry after a failed payment, a second method.
 */
export const CHECKOUT_RATE = { limit: 10, windowSeconds: 300 } as const;

/**
 * Where the gateway sends the customer back. A neutral page: it never infers success from the URL (doc 22 B5).
 * The gateway adds only a wording hint, `?result=success` or `?result=cancel` (`gatewayReturnUrls`, CO-08).
 */
export const CHECKOUT_RETURN_PATH = "/booking/confirmation";

/** What a refused checkout tells the browser. Anything the payments side reports beyond these folds into `requires_inquiry`. */
export type PublicCheckoutRefusal = "quote_expired" | "verification_required" | "try_again" | "requires_inquiry";

/** The payments side's refusals (`CheckoutRefusal` in checkout.service.ts) that mean something other than "send it to inquiry". */
const PUBLIC_REFUSALS: Record<string, PublicCheckoutRefusal> = {
  quote_not_found: "quote_expired",
  quote_not_active: "quote_expired",
  quote_expired: "quote_expired",
  verification_required: "verification_required",
  queue_busy: "try_again",
  payment_session_failed: "try_again",
  payment_session_unavailable: "try_again",
};

/**
 * Folds the payments side's refusal into the public vocabulary. Anything not
 * listed, including a reason added later, reads as `requires_inquiry`, which
 * keeps the cart and offers the inquiry path; an internal reason (a pause, an
 * exposure cap, the release switch) never reaches the browser.
 */
export function publicRefusal(reason: string): PublicCheckoutRefusal {
  return Object.hasOwn(PUBLIC_REFUSALS, reason) ? PUBLIC_REFUSALS[reason] : "requires_inquiry";
}

/** The gateway's hosted page, only over https (CR-B3-12): card entry never starts on a plain-http page. */
function hostedPage(url: string): string | null {
  try {
    const u = new URL(url);
    return u.protocol === "https:" ? u.toString() : null;
  } catch {
    return null;
  }
}

/**
 * POST /api/checkout — starts payment for the caller's own active quote
 * (doc 22 §23 B3). Same-origin; body capped at CHECKOUT_MAX_BYTES.
 *
 * Order: the IP limit, the body, the release switch, then the owner (the
 * signed-in customer, otherwise the guest session that made the quote; none
 * is opened here) and its limit, then `CheckoutService.start` with the client
 * IP. The service creates the order from the quote, binds the order-bound
 * contact verification and opens one gateway session, refusing before any
 * session when the release switch, readiness, a pause or admission says no.
 *
 * 201 with `{ orderReference, redirectUrl }` only: the order id, amounts and
 * gateway ids stay on the server, and the browser is sent to the gateway's
 * hosted page (card data never touches Outly). 200 with `{ refused }`
 * (`PublicCheckoutRefusal`) when the payments side says no. Nothing here
 * decides that a payment succeeded; that is the gateway's verified evidence.
 *
 * Checkout redesign batch 3 (CO-02): on a 201 for a guest owner, the guest
 * download grant (`downloadGrant`, checkout-download-grant.service.ts) may add
 * a signed entry to the browser's `outlyy_ticket_access` cookie, so the page
 * this browser returns to can offer the voucher. The grant service re-checks
 * the quote owner and the order-bound verification (which the request's
 * `verificationId` must name) in the database and does
 * nothing while its release switch is off. A failure there never fails the
 * checkout: the customer still pays, and can unlock the voucher with a code.
 */
export function createCheckoutHandler(checkout: () => CheckoutService, downloadGrant?: () => CheckoutDownloadGrant) {
  return handle(async (req: NextRequest) => {
    assertSameOrigin(req);
    const ip = clientIp(req);
    await enforceRateLimit({ key: `checkout:ip:${hashIp(ip) ?? "unknown"}`, ...CHECKOUT_RATE });
    const body = await parseJson(req, checkoutStartSchema, { maxBytes: CHECKOUT_MAX_BYTES });

    const e = env();
    // The payments side refuses too; this only saves the session reads while the switch is off.
    if (e.INSTANT_RELEASE_ENABLED !== true) return json({ refused: "requires_inquiry" satisfies PublicCheckoutRefusal });

    const owner = await resolveCheckoutOwner(req);
    if (!owner) throw checkoutSessionEnded();
    await enforceRateLimit({ key: `checkout:owner:${ownerKey(owner)}`, ...CHECKOUT_RATE });

    const result = await checkout().start({
      owner,
      quoteId: body.quoteId,
      verificationId: body.verificationId,
      method: body.method,
      traveller: body.traveller,
      returnUrl: new URL(CHECKOUT_RETURN_PATH, e.NEXT_PUBLIC_SITE_URL).toString(),
      ip: ip ?? null,
    });
    if (!result.ok) {
      log.info("checkout.refused", { reason: result.reason });
      return json({ refused: publicRefusal(result.reason) });
    }
    const redirectUrl = hostedPage(result.redirectUrl);
    if (!redirectUrl) {
      log.error("checkout.bad_redirect", { orderReference: result.orderReference });
      throw Errors.internal("We couldn't open the payment page");
    }
    const res = json({ orderReference: result.orderReference, redirectUrl }, { status: 201 });
    if (owner.kind === "guest" && downloadGrant) {
      try {
        const cookie = await downloadGrant().issue({
          orderId: result.orderId,
          guestSessionId: owner.guestSessionId,
          // Must be the order-bound verification: a repeat for a used quote is not re-checked by the payments side.
          verificationId: body.verificationId,
          existingCookie: ticketAccessFromRequest(req),
        });
        if (cookie) setTicketAccessCookie(res, cookie.value, cookie.expiresAt);
      } catch (error) {
        log.warn("checkout.download_grant_failed", { error: error instanceof Error ? error.name : "unknown" });
      }
    }
    return res;
  });
}
