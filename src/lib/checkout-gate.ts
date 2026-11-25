/**
 * Where the checkout page may send a visitor to pay (doc 22 §32.34).
 *
 * Gate 5d (doc 22 B0) kept self-serve payment out of production builds while
 * only fake gateways existed. With Stripe, production checkout is allowed,
 * and the safety comes from the server: the release switch, readiness and
 * the quote decide whether a cart is instant, the registry refuses fake
 * gateways in production, and `/api/checkout` only answers with an https URL.
 *
 * This is the browser's last check before leaving the site. A production
 * build only ever sends the visitor to Stripe's hosted Checkout page;
 * anything else (a fake gateway's page, a lookalike host) is refused, and the
 * page falls back to inquiry. Development and preview builds keep the fake
 * gateways' https pages for demos and tests.
 */

/** Stripe's hosted Checkout origin: the only payment page a production build opens. */
export const STRIPE_CHECKOUT_ORIGIN = "https://checkout.stripe.com";

export function payPageUrl(url: string, opts: { production: boolean }): string | null {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return null;
  }
  if (u.protocol !== "https:" || u.username || u.password) return null;
  if (opts.production && u.origin !== STRIPE_CHECKOUT_ORIGIN) return null;
  return u.toString();
}
