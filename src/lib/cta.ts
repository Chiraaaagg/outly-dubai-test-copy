import type { FulfilmentMode } from "./types";

/**
 * CTA copy by fulfilment mode (pivot plan §4).
 *
 * One conditional, one place. The secondary CTA ("Ask on WhatsApp") is
 * identical in both modes so instant and inquiry SKUs render side by side in
 * the same result set without looking inconsistent (§4.4).
 *
 *  "Request availability & price" names the next step and is literally
 *  accurate: the visitor sends a request and the team checks availability and
 *  price with the operator before anything is paid. The confirm-first story
 *  only works if the CTA tells the truth (§4.3).
 */
export function ctaFor(mode: FulfilmentMode, opts: { quoteOnly?: boolean } = {}) {
  if (opts.quoteOnly) {
    return {
      primary: "Request a quote",
      primaryShort: "Get a quote",
      route: "/concierge",
      microcopy: "Free to request",
      cardAction: "View details",
    };
  }
  if (mode === "instant") {
    return {
      primary: "Book now",
      primaryShort: "Book now",
      route: "/checkout",
      // The voucher email is the one delivery that exists; it takes minutes, not seconds (CO-11, audit §4.2).
      microcopy: "Instant confirmation. Your voucher comes by email.",
      cardAction: "View & book",
    };
  }
  return {
    primary: "Request availability & price",
    primaryShort: "Request availability",
    route: "/inquiry",
    microcopy: "Free to enquire",
    cardAction: "View details",
  };
}

export const RESPONSE_PROMISE = "Reply from our team on WhatsApp";
export const RESPONSE_PROMISE_SHORT = "Reply on WhatsApp";
