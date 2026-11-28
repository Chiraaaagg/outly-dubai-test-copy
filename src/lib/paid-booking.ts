import { CART_PAID_STATES } from "@/lib/checkout-draft";
import { isValidReference, normaliseReference } from "@/lib/reference";

/**
 * The "recently paid" marker (production fix, 28 Nov 2026).
 *
 * Once the status page has emptied the cart this tab paid for (CO-19), the
 * order hint and the payment hand-off are already spent, so an empty
 * `/checkout` or `/cart` (most often reached with the browser's Back button)
 * had nothing to say about the booking that was just paid and looked as if
 * the order had vanished.
 *
 * So, when the status page clears a paid cart, it keeps the order reference
 * and the time it did so in this tab's `sessionStorage`, and nothing else: no
 * name, contact, item or amount (PRV-4, as `order-hint.ts` and
 * `checkout-draft.ts`). It is never put in a URL or an analytics event, and
 * it is never evidence: an empty cart page that finds it asks the status API
 * about that order (`fetchOrderStatus`, which answers only what this browser
 * may see) and shows the booking only when the server says the payment
 * arrived. Otherwise, or when the request fails, the page shows its usual
 * empty state. The marker lasts 24 hours; blocked or full storage is ignored.
 */

export const PAID_MARKER_KEY = "outlyy.recentlyPaid";
export const PAID_MARKER_TTL_MS = 24 * 60 * 60 * 1000;
/** A stored time further ahead than this is not believed (a clock change, or a value not written by us). */
const FUTURE_SKEW_MS = 5 * 60 * 1000;

export interface PaidMarker {
  reference: string;
  /** Epoch milliseconds when the status page cleared the paid cart. */
  paidAt: number;
}

type MarkerStorage = Pick<Storage, "getItem" | "setItem" | "removeItem">;

function browserStorage(): MarkerStorage | null {
  try {
    return typeof window === "undefined" ? null : window.sessionStorage;
  } catch {
    return null;
  }
}

function cleanRef(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const ref = normaliseReference(raw);
  return isValidReference(ref, "OUT") ? ref : null;
}

/** Keeps the reference and the time only. A malformed reference writes nothing. */
export function writePaidMarker(reference: string, now: number = Date.now(), storage: MarkerStorage | null = browserStorage()): void {
  const ref = cleanRef(reference);
  if (!storage || !ref || !Number.isFinite(now)) return;
  const marker: PaidMarker = { reference: ref, paidAt: Math.floor(now) };
  try {
    storage.setItem(PAID_MARKER_KEY, JSON.stringify(marker));
  } catch {
    /* private mode or full storage: the empty cart page then shows its usual state */
  }
}

export function clearPaidMarker(storage: MarkerStorage | null = browserStorage()): void {
  if (!storage) return;
  try {
    storage.removeItem(PAID_MARKER_KEY);
  } catch {
    /* ignore */
  }
}

/** The marker while it is fresh (under 24 hours old), or null. An expired or unreadable one is removed. */
export function readPaidMarker(now: number = Date.now(), storage: MarkerStorage | null = browserStorage()): PaidMarker | null {
  if (!storage) return null;
  let raw: string | null;
  try {
    raw = storage.getItem(PAID_MARKER_KEY);
  } catch {
    return null;
  }
  if (!raw) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    parsed = null;
  }
  const o = parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : null;
  const reference = cleanRef(o?.reference);
  const at: unknown = o ? o.paidAt : null;
  const paidAt = typeof at === "number" && Number.isFinite(at) ? at : null;
  if (!reference || paidAt === null || paidAt > now + FUTURE_SKEW_MS || now - paidAt >= PAID_MARKER_TTL_MS) {
    clearPaidMarker(storage);
    return null;
  }
  return { reference, paidAt };
}

/* ---------------------------------------------------------------------------
 * Decisions (pure, so they are tested without a browser)
 * ------------------------------------------------------------------------ */

/**
 * The states in which an empty cart page may say the trip was paid: the
 * states in which the status page empties the cart (`CART_PAID_STATES`), and
 * `completed`. Never `awaiting_payment` or `payment_failed`, and not once the
 * payment was released, refunded or cancelled, or our team is looking.
 */
export const PAID_BOOKING_STATES: readonly string[] = [...CART_PAID_STATES, "completed"];

/** Of those, the states in which the operator has confirmed the booking (tickets ready or still coming). */
export const CONFIRMED_BOOKING_STATES: readonly string[] = ["confirmed_ticket_pending", "confirmed", "paid_confirmed_by_team", "completed"];

export interface PaidBookingNotice {
  reference: string;
  confirmed: boolean;
  title: string;
  body: string;
  href: string;
}

export const PAID_BOOKING_BODY = "You've already paid for this trip, so your cart is empty.";

/** What an empty cart page shows for the order the server returned, or null for its usual empty state. */
export function paidBookingNotice(expectedReference: string, status: { reference: string; state: string } | null): PaidBookingNotice | null {
  if (!status || !PAID_BOOKING_STATES.includes(status.state)) return null;
  const reference = cleanRef(status.reference);
  if (!reference || reference !== cleanRef(expectedReference)) return null;
  const confirmed = CONFIRMED_BOOKING_STATES.includes(status.state);
  return {
    reference,
    confirmed,
    title: confirmed ? `Your booking ${reference} is confirmed` : `We're confirming your booking ${reference}`,
    body: PAID_BOOKING_BODY,
    href: `/booking/${encodeURIComponent(reference)}`,
  };
}

/**
 * Asks the server about the marked order. A 404 (this browser may no longer
 * see it) removes the marker; a failed request keeps it and shows nothing,
 * so a later visit can ask again. Never throws.
 */
export async function resolvePaidBooking(
  marker: PaidMarker | null,
  fetchStatus: (reference: string) => Promise<{ reference: string; state: string } | null>,
  storage: MarkerStorage | null = browserStorage(),
): Promise<PaidBookingNotice | null> {
  if (!marker) return null;
  try {
    const status = await fetchStatus(marker.reference);
    if (!status) {
      clearPaidMarker(storage);
      return null;
    }
    return paidBookingNotice(marker.reference, status);
  } catch {
    return null;
  }
}
