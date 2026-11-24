import { mocksAllowed, startCheckout } from "@/lib/api";
import { payPageUrl } from "@/lib/checkout-gate";
import type { PaymentHandoff } from "@/lib/checkout-draft";
import { writeOrderHint } from "@/components/commerce/order-status/order-hint";

/**
 * "Return to payment" (checkout redesign batch 1, CO-06).
 *
 * No new payment path: this repeats, unchanged, the `POST /api/checkout` body
 * the pay button sent (saved with the hand-off). For a quote that already has
 * its order, `checkout.service` hands back the order's stored Stripe link
 * while the saga is open and the quote has at least the minimum payment
 * window left, and refuses otherwise; it never opens a second order or
 * payment for that quote. The server also checks the caller is the session
 * that made the quote.
 *
 *  - `redirect`: the same payment page, still open; the caller navigates to it;
 *  - `closed`: that page can no longer be used (the server refused it). This
 *    says nothing about money: a payment made on it may still be confirmed;
 *  - `failed`: a network or server hiccup; trying again is safe.
 */
export type ResumeResult = { kind: "redirect"; url: string } | { kind: "closed" } | { kind: "failed" };

/** The exact request "Return to payment" repeats. */
export function resumeRequest(handoff: PaymentHandoff) {
  return { quoteId: handoff.quoteId, verificationId: handoff.verificationId, method: handoff.method, traveller: handoff.traveller };
}

export async function resumePayment(handoff: PaymentHandoff): Promise<ResumeResult> {
  try {
    const r = await startCheckout(resumeRequest(handoff));
    if ("refused" in r) return r.refused === "try_again" ? { kind: "failed" } : { kind: "closed" };
    const url = payPageUrl(r.redirectUrl, { production: !mocksAllowed() });
    if (!url) return { kind: "closed" };
    // The return page used up the reference hint on the first trip back from
    // Stripe; write it again so the next return (paid or not) finds the order.
    writeOrderHint(r.orderReference);
    return { kind: "redirect", url };
  } catch {
    return { kind: "failed" };
  }
}
