/**
 * Why a cart went from instant checkout to the inquiry form (checkout
 * redesign batch 1, CO-07). The rules themselves are unchanged and stay the
 * server's (mixed carts, the five-item cap, cut-offs, pickup): this only puts
 * the reason into words, so the customer is never moved without being told.
 *
 * The reason travels as a short code in the `/inquiry` URL (`?reason=`); it
 * names a rule, never a person, an item or an amount. A pickup hotel chosen
 * or typed at checkout travels on the cart line and is filled into the
 * inquiry form (`hotelForInquiry`, src/lib/pickup-selection.ts), never the URL.
 */

export type InquiryReason = "mixed" | "over_limit" | "cutoff" | "time_slot" | "sold_out" | "pickup" | "ticket_validity" | "ages" | "guest_types" | "unavailable" | "external_hold";

const TEXT: Record<InquiryReason, string> = {
  mixed: "Some activities in your trip are confirmed by our team before you pay, so the whole trip goes to them in one message.",
  over_limit: "Online booking takes up to 5 activities in one order, each at a different time. Our team books this trip in one go.",
  cutoff: "The date or time you picked is past the operator's online booking cut-off.",
  time_slot: "The time you picked isn't one the operator takes online bookings for, so our team confirms the time with you before you pay.",
  sold_out: "The time you picked is no longer available online.",
  pickup: "This activity includes hotel pickup, and our team confirms the pickup point with you before you pay.",
  ticket_validity: "The tickets on sale now can't be used on the date you picked. Pick an earlier visit date, or our team finds tickets for your date.",
  // Doc 30 N4 (review 102 N4-01): the option's child or infant ages changed after the guests were chosen. Wording pending owner review (K10).
  ages: "The ages this activity counts as children or infants have changed since you chose your guests. Check your guest numbers on the activity page, or our team confirms them with you before you pay.",
  // Guest picker fix (28 Nov 2026): a line asks for a guest type (child, infant) the option has no unit for (`unknown_unit`).
  guest_types:
    "This option takes only some guest types online, such as adults. Change your guests on the activity page, or our team books everyone with you before you pay.",
  unavailable: "This trip can't be booked online as it is, so our team confirms it with the operator before you pay.",
  // Doc 29 Batch 6 (owner decision d): from the status page, after an external hold too short to book online was released.
  external_hold: "The operator couldn't hold your place long enough to book it online, so our team books it with them for you before you pay.",
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
  if (reasons.some((r) => r === "ticket_validity_ended")) return "ticket_validity";
  if (reasons.some((r) => r === "ages_changed")) return "ages";
  if (reasons.some((r) => r === "unknown_unit")) return "guest_types";
  if (reasons.some((r) => r === "past_cutoff" || r === "same_day_inquiry_only" || r === "closed")) return "cutoff";
  // The time is not one the operator's live availability lists. Not a cut-off: calling it one sent customers
  // looking for a later date when the date was fine.
  if (reasons.some((r) => r === "invalid_slot")) return "time_slot";
  if (reasons.some((r) => r === "sold_out")) return "sold_out";
  if (reasons.some((r) => r === "multi_instant_inquiry")) return "over_limit";
  return "unavailable";
}

export function inquiryHref(reason: InquiryReason, from: "checkout" | "booking" = "checkout"): string {
  // Review 89 B6-21 (PRV-4): never a booking reference in this URL. `/inquiry` is a measured page, and its URL reaches
  // analytics. The status page hands the reference over in this tab's sessionStorage instead (`rememberBookingForInquiry`).
  return `/inquiry?from=${from}&reason=${reason}`;
}

/** sessionStorage key of the booking the status page hands to the inquiry form (review 89 B6-16, B6-21). */
export const INQUIRY_BOOKING_KEY = "outly.inquiry.booking.v1";
const BOOKING_REFERENCE = /^[A-Z0-9-]{4,40}$/;

type HandoffStorage = Pick<Storage, "getItem" | "setItem" | "removeItem">;

function tabStorage(): HandoffStorage | null {
  try {
    return typeof window === "undefined" ? null : window.sessionStorage;
  } catch {
    return null;
  }
}

/** The status page, on "Send it to our team": keep the booking reference for the inquiry form in this tab only. */
export function rememberBookingForInquiry(reference: string, storage: HandoffStorage | null = tabStorage()): void {
  if (!storage || !BOOKING_REFERENCE.test(reference)) return;
  try {
    storage.setItem(INQUIRY_BOOKING_KEY, reference);
  } catch {
    /* ignore: the form then opens without the booking */
  }
}

/** The inquiry page: the handed-over booking reference, or null when there is none. `forgetBookingForInquiry` removes it. */
export function readBookingForInquiry(storage: HandoffStorage | null = tabStorage()): string | null {
  if (!storage) return null;
  try {
    const ref = storage.getItem(INQUIRY_BOOKING_KEY);
    return ref && BOOKING_REFERENCE.test(ref) ? ref : null;
  } catch {
    return null;
  }
}

/** Removes the handed-over booking reference once the inquiry page has read it. */
export function forgetBookingForInquiry(storage: HandoffStorage | null = tabStorage()): void {
  try {
    storage?.removeItem(INQUIRY_BOOKING_KEY);
  } catch {
    /* ignore */
  }
}

/** What the inquiry form needs from a booking the status page sent here (review 89 B6-16): no personal data. */
export interface InquiryFromBooking {
  reference: string;
  items: ReadonlyArray<{ title: string; serviceDate: string; timeslot: string | null; paxLabel: string }>;
}

/**
 * The note filled into the inquiry form for a booking the status page sent
 * here, so our team sees the activity, date, time and guests without the
 * customer retyping them. Null when the booking has no item.
 */
export function inquiryNotesFromBooking(b: InquiryFromBooking): string | null {
  if (!b.items.length) return null;
  const lines = b.items.map((i) => `${i.title}, ${i.serviceDate}${i.timeslot ? ` at ${i.timeslot}` : ""}, ${i.paxLabel}`);
  return `Booking ${b.reference} could not be booked online. Please book: ${lines.join("; ")}.`;
}
