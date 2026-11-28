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
 * may see) and points to the booking in the server's words: "paid" only when
 * the server's payment step is done (`paidBookingNotice`). An order this
 * browser may not see, an unpaid one, or a failed request leaves the page's
 * usual empty state. The marker lasts 24 hours, goes as soon as something is
 * added to the cart or a new payment starts, and blocked or full storage is
 * ignored.
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
 * How the notice reads, by the server's state:
 *  - `confirmed`: the operator confirmed the booking (tickets ready or still coming);
 *  - `completed`: the service date has passed ("has taken place", as the server says);
 *  - `partial`: some items are booked and the rest are not (refunded, released, cancelled or failed);
 *  - `confirming`: the payment or the booking is still on its way;
 *  - `recent`: the order has moved on (released, refunded, cancelled, or our team is looking). It claims
 *    nothing about the payment: it only points to the booking (review 116 D5; owner wording open).
 * `awaiting_payment`, `payment_failed` and any state not listed show the usual empty state.
 */
export type PaidBookingKind = "confirmed" | "completed" | "partial" | "confirming" | "recent";

const KIND_BY_STATE: Readonly<Record<string, PaidBookingKind>> = {
  confirmed_ticket_pending: "confirmed",
  confirmed: "confirmed",
  paid_confirmed_by_team: "confirmed",
  completed: "completed",
  partially_fulfilled: "partial",
  payment_processing: "confirming",
  booking_processing: "confirming",
  payment_released: "recent",
  refund_processing: "recent",
  refunded: "recent",
  cancellation_processing: "recent",
  cancelled: "recent",
  needs_attention: "recent",
};

/** The states in which the empty cart page points to the booking at all. */
export const NOTICE_STATES: readonly string[] = Object.keys(KIND_BY_STATE);

/** The states whose notice may say the trip was paid (only when the server's payment step is also done). */
export const PAID_BOOKING_STATES: readonly string[] = [...CART_PAID_STATES, "completed"];

export interface PaidBookingNotice {
  reference: string;
  kind: PaidBookingKind;
  title: string;
  body: string;
  href: string;
}

/** Said only when the server's payment step is `done`. */
export const PAID_BOOKING_BODY = "You've already paid for this trip, so your cart is empty.";
/** A booking whose payment step is not (yet) done: claims no payment. */
export const CONFIRMING_BODY = "We're still confirming your payment and booking.";
export const HAS_BOOKING_BODY = "This trip already has a booking, so your cart is empty.";
export const PARTIAL_BODY = "Some of this trip is booked and some isn't, so your cart is empty. Your booking page shows what happens next.";
export const RECENT_BODY = "Your cart is empty. Your booking page shows where this booking stands.";

/** The part of the status projection the notice reads. */
export interface NoticeStatus {
  reference: string;
  state: string;
  steps?: { payment?: { status?: string } | null } | null;
}

/** What an empty cart page shows for the order the server returned, or null for its usual empty state. */
export function paidBookingNotice(expectedReference: string, status: NoticeStatus | null): PaidBookingNotice | null {
  if (!status) return null;
  const kind = Object.prototype.hasOwnProperty.call(KIND_BY_STATE, status.state) ? KIND_BY_STATE[status.state] : undefined;
  if (!kind) return null;
  const reference = cleanRef(status.reference);
  if (!reference || reference !== cleanRef(expectedReference)) return null;
  // Review 116 D1: "paid" only when the server's own payment step says so.
  const paid = PAID_BOOKING_STATES.includes(status.state) && status.steps?.payment?.status === "done";
  const words: Record<PaidBookingKind, { title: string; body: string }> = {
    confirmed: { title: `Your booking ${reference} is confirmed`, body: paid ? PAID_BOOKING_BODY : HAS_BOOKING_BODY },
    completed: { title: `Your booking ${reference} has taken place`, body: paid ? PAID_BOOKING_BODY : HAS_BOOKING_BODY },
    partial: { title: `Part of your booking ${reference} is confirmed`, body: PARTIAL_BODY },
    confirming: { title: `We're confirming your booking ${reference}`, body: paid ? PAID_BOOKING_BODY : CONFIRMING_BODY },
    recent: { title: `You have a recent booking, ${reference}`, body: RECENT_BODY },
  };
  return { reference, kind, ...words[kind], href: `/booking/${encodeURIComponent(reference)}` };
}

/**
 * Asks the server about the marked order. A 404 (this browser may no longer
 * see it) removes the marker; a failed request keeps it and shows nothing,
 * so a later visit can ask again. Never throws.
 */
export async function resolvePaidBooking(
  marker: PaidMarker | null,
  fetchStatus: (reference: string) => Promise<NoticeStatus | null>,
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

/** After this long without an answer the page shows its usual empty state. */
export const CHECK_TIMEOUT_MS = 8_000;

/**
 * Runs one check for the empty cart page and reports what to show
 * (`onResult`), at most twice:
 *  - the server's answer, if it comes within `timeoutMs`;
 *  - otherwise `{ notice: null }` at `timeoutMs` (the usual empty state), and
 *    then the notice if a good answer still arrives (review 116 D9). A late
 *    failure changes nothing, and nothing ever replaces a notice.
 * The returned function cancels it (the page unmounted): nothing is reported after that.
 */
export function startPaidBookingCheck(
  marker: PaidMarker,
  opts: {
    fetchStatus: (reference: string) => Promise<NoticeStatus | null>;
    onResult: (result: { notice: PaidBookingNotice | null }) => void;
    timeoutMs?: number;
    storage?: MarkerStorage | null;
  },
): () => void {
  let cancelled = false;
  let answered = false;
  let fellBack = false;
  const timer = setTimeout(() => {
    if (cancelled || answered) return;
    fellBack = true;
    opts.onResult({ notice: null });
  }, opts.timeoutMs ?? CHECK_TIMEOUT_MS);
  void resolvePaidBooking(marker, opts.fetchStatus, opts.storage === undefined ? browserStorage() : opts.storage).then((notice) => {
    if (cancelled || answered) return;
    answered = true;
    clearTimeout(timer);
    if (fellBack && !notice) return;
    opts.onResult({ notice });
  });
  return () => {
    cancelled = true;
    clearTimeout(timer);
  };
}
