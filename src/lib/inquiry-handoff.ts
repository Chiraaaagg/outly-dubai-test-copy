/**
 * Why a cart went from instant checkout to the inquiry form (checkout
 * redesign batch 1, CO-07). The rules themselves are unchanged and stay the
 * server's (mixed carts, the five-item cap, cut-offs, pickup): this only puts
 * the reason into words, so the customer is never moved without being told.
 *
 * The reason travels as a short code in the `/inquiry` URL (`?reason=`); it
 * names a rule, never a person, an item or an amount.
 */

export type InquiryReason = "mixed" | "over_limit" | "cutoff" | "sold_out" | "pickup" | "unavailable";

const TEXT: Record<InquiryReason, string> = {
  mixed: "Some activities in your trip are confirmed by our team before you pay, so the whole trip goes to them in one message.",
  over_limit: "Online booking takes up to 5 activities in one order, each at a different time. Our team books this trip in one go.",
  cutoff: "The date or time you picked is past the operator's online booking cut-off.",
  sold_out: "The time you picked is no longer available online.",
  pickup: "This activity includes hotel pickup, and our team confirms the pickup point with you before you pay.",
  unavailable: "This trip can't be booked online as it is, so our team confirms it with the operator before you pay.",
};

export function inquiryReasonText(reason: InquiryReason): string {
  return TEXT[reason];
}

export function parseInquiryReason(raw: string | null | undefined): InquiryReason | null {
  return raw && Object.hasOwn(TEXT, raw) ? (raw as InquiryReason) : null;
}

/** The reason for a refused quote line (`QuoteRefusalReason`, src/server/quotes/contracts.ts). */
export function inquiryReasonForQuote(reasons: readonly string[]): InquiryReason {
  if (reasons.some((r) => r === "pickup_unavailable")) return "pickup";
  if (reasons.some((r) => r === "past_cutoff" || r === "same_day_inquiry_only" || r === "closed" || r === "invalid_slot")) return "cutoff";
  if (reasons.some((r) => r === "sold_out")) return "sold_out";
  if (reasons.some((r) => r === "multi_instant_inquiry")) return "over_limit";
  return "unavailable";
}

export function inquiryHref(reason: InquiryReason): string {
  return `/inquiry?from=checkout&reason=${reason}`;
}
