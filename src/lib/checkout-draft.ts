/**
 * The checkout's tab-scoped memory (checkout redesign batch 1, CO-06, CO-07).
 *
 * Two small `sessionStorage` records, both gone when the tab closes:
 *
 *  - the details draft: the lead traveller's name, email and mobile number as
 *    typed on the details step, so a customer who comes back from Stripe, or
 *    is sent to the inquiry form, does not type them again. Nothing else: no
 *    card data (Stripe's page holds that), no dietary needs, notes, hotel or
 *    consent. It is cleared once the status page shows the payment arrived;
 *  - the payment hand-off: the order reference, a fingerprint of the cart it
 *    was for, and the exact `POST /api/checkout` body the pay button sent, so
 *    "Return to payment" can repeat that call unchanged (`checkout.service`
 *    re-hands an open session's stored link for a used quote, and only to the
 *    session that made the quote). It is acted on only for the same cart, and
 *    it is a convenience, never evidence: what the page says comes from the
 *    server.
 *
 * Every read and write tolerates blocked or full storage: the page then
 * simply starts empty.
 */

import { isValidReference } from "@/lib/reference";

export const CHECKOUT_DRAFT_KEY = "outlyy.checkoutDraft";
export const PAYMENT_HANDOFF_KEY = "outlyy.paymentHandoff";

export interface CheckoutDraft {
  fullName: string;
  email: string;
  phone: string;
  countryCode: string;
}

export interface HandoffTraveller {
  fullName: string;
  phoneE164: string | null;
  email: string | null;
}

export interface PaymentHandoff {
  reference: string;
  /** `cartFingerprint` of the cart this payment was for. */
  cartKey: string;
  quoteId: string;
  verificationId: string;
  method: string;
  /** The traveller exactly as the pay button sent it. */
  traveller: HandoffTraveller;
}

type DraftStorage = Pick<Storage, "getItem" | "setItem" | "removeItem">;

function browserStorage(): DraftStorage | null {
  try {
    return typeof window === "undefined" ? null : window.sessionStorage;
  } catch {
    return null;
  }
}

const COUNTRY_CODE = /^\+\d{1,4}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function text(v: unknown, max: number): string {
  return typeof v === "string" ? v.slice(0, max) : "";
}

function readJson(key: string, storage: DraftStorage | null): unknown {
  if (!storage) return null;
  try {
    const raw = storage.getItem(key);
    return raw ? (JSON.parse(raw) as unknown) : null;
  } catch {
    return null;
  }
}

function remove(key: string, storage: DraftStorage | null): void {
  if (!storage) return;
  try {
    storage.removeItem(key);
  } catch {
    /* ignore */
  }
}

/** The kept details, or null when there are none (or they are unreadable). */
export function readCheckoutDraft(storage: DraftStorage | null = browserStorage()): CheckoutDraft | null {
  const o = readJson(CHECKOUT_DRAFT_KEY, storage) as Record<string, unknown> | null;
  if (!o || typeof o !== "object") return null;
  const draft: CheckoutDraft = {
    fullName: text(o.fullName, 120),
    email: text(o.email, 254),
    phone: text(o.phone, 20),
    countryCode: COUNTRY_CODE.test(text(o.countryCode, 5)) ? text(o.countryCode, 5) : "",
  };
  return draft.fullName || draft.email || draft.phone ? draft : null;
}

/** Keeps name, email and mobile only. An all-empty draft removes the record. */
export function writeCheckoutDraft(draft: CheckoutDraft, storage: DraftStorage | null = browserStorage()): void {
  if (!storage) return;
  const kept: CheckoutDraft = {
    fullName: text(draft.fullName, 120),
    email: text(draft.email, 254),
    phone: text(draft.phone, 20),
    countryCode: COUNTRY_CODE.test(draft.countryCode) ? draft.countryCode : "",
  };
  if (!kept.fullName && !kept.email && !kept.phone) return remove(CHECKOUT_DRAFT_KEY, storage);
  try {
    storage.setItem(CHECKOUT_DRAFT_KEY, JSON.stringify(kept));
  } catch {
    /* private mode or full storage: the details are simply not kept */
  }
}

export function clearCheckoutDraft(storage: DraftStorage | null = browserStorage()): void {
  remove(CHECKOUT_DRAFT_KEY, storage);
}

export function readPaymentHandoff(storage: DraftStorage | null = browserStorage()): PaymentHandoff | null {
  const o = readJson(PAYMENT_HANDOFF_KEY, storage) as Record<string, unknown> | null;
  if (!o || typeof o !== "object") return null;
  const t = (o.traveller && typeof o.traveller === "object" ? o.traveller : {}) as Record<string, unknown>;
  const h: PaymentHandoff = {
    reference: text(o.reference, 32),
    cartKey: text(o.cartKey, 4000),
    quoteId: text(o.quoteId, 36),
    verificationId: text(o.verificationId, 36),
    method: text(o.method, 20),
    traveller: {
      fullName: text(t.fullName, 120),
      phoneE164: typeof t.phoneE164 === "string" ? t.phoneE164.slice(0, 20) : null,
      email: typeof t.email === "string" ? t.email.slice(0, 254) : null,
    },
  };
  if (!isValidReference(h.reference, "OUT") || !h.cartKey || !UUID.test(h.quoteId) || !UUID.test(h.verificationId) || !/^[a-z_]{2,20}$/.test(h.method)) return null;
  if (!h.traveller.fullName.trim()) return null;
  return h;
}

export function writePaymentHandoff(handoff: PaymentHandoff, storage: DraftStorage | null = browserStorage()): void {
  if (!storage) return;
  try {
    storage.setItem(PAYMENT_HANDOFF_KEY, JSON.stringify(handoff));
  } catch {
    /* ignore */
  }
}

export function clearPaymentHandoff(storage: DraftStorage | null = browserStorage()): void {
  remove(PAYMENT_HANDOFF_KEY, storage);
}

/* ---------------------------------------------------------------------------
 * Decisions (pure, so they are tested without a browser)
 * ------------------------------------------------------------------------ */

/** What identifies a cart for the hand-off: its lines, in order. */
export function cartFingerprint(items: ReadonlyArray<{ id: string; date: string; time: string; pax: unknown }>): string {
  return items.map((i) => `${i.id}:${i.date}:${i.time}:${JSON.stringify(i.pax)}`).join(",");
}

/**
 * What the checkout does with a hand-off it finds on load (CO-06):
 *  - `ignore`: there is none;
 *  - `clear`: it was for another cart, or this browser can no longer see the
 *    order: drop the record and carry on (never leave /checkout because of it);
 *  - `offer_return`: the same cart's order still has no verified payment: offer
 *    to go back to that payment page, worded for a customer who may have paid;
 *  - `show_booking`: the order has moved on (paid, or ended): point to its page
 *    so the customer checks it before paying again, and drop the record.
 */
export type HandoffAction = "ignore" | "clear" | "offer_return" | "show_booking";

export function handoffAction(handoff: PaymentHandoff | null, currentCartKey: string, orderState: string | null): HandoffAction {
  if (!handoff) return "ignore";
  if (handoff.cartKey !== currentCartKey) return "clear";
  if (orderState === null) return "clear";
  return orderState === "awaiting_payment" ? "offer_return" : "show_booking";
}

/**
 * Actions on the "back from the payment page" notice. While the server has
 * not ruled out a payment (`awaiting_payment` covers "paid, not yet
 * confirmed by Stripe's message" too), the only ways forward reuse that same
 * payment page or look at the booking; starting again, which makes a new
 * quote and order, is offered only once the old page can no longer be used.
 */
/**
 * `unchecked`: the order's status could not be read just now (offline, a
 * server error). The payment page may still have been paid, so it is treated
 * like `open`, with a "Check again".
 */
export type LeftPaymentState = "open" | "unchecked" | "resuming" | "failed" | "closed";

export function leftPaymentActions(state: LeftPaymentState): { returnToPayment: boolean; viewBooking: boolean; startAgain: boolean; checkAgain: boolean } {
  return {
    returnToPayment: state !== "closed",
    viewBooking: true,
    startAgain: state === "closed",
    checkAgain: state === "unchecked",
  };
}

/**
 * Whether this cart was handed to a payment page that may still be paid:
 * then no second payment starts from this page, and nothing on it says that
 * nothing was charged. `moved_on` (the order has moved on, shown with a link)
 * and `closed` (the server refused the old page) are not outstanding.
 */
export function paymentOutstanding(state: LeftPaymentState | "moved_on" | null | undefined): boolean {
  return state === "open" || state === "unchecked" || state === "resuming" || state === "failed";
}

/**
 * The pay button works only with a ready quote, no reason to send the trip to
 * our team (CO-07), and no earlier payment page for this cart that may still
 * be paid (CO-06).
 */
export function canPay(input: { quoteReady: boolean; hasLiveQuote: boolean; inquiryReason: string | null; paymentOutstanding?: boolean }): boolean {
  // `paymentOutstanding`: this tab handed this cart to a payment page that may still be paid; no second payment from here.
  return input.quoteReady && input.hasLiveQuote && !input.inquiryReason && !input.paymentOutstanding;
}

/**
 * Order states after which this tab's checkout draft and hand-off are spent:
 * the payment arrived, or the order is over. Not `awaiting_payment` (the
 * customer may go back to pay) and not `payment_failed` (the page invites
 * another try, so the details stay).
 */
export const PAYMENT_SETTLED_STATES: readonly string[] = [
  "payment_processing",
  "booking_processing",
  "confirmed_ticket_pending",
  "confirmed",
  "partially_fulfilled",
  "payment_released",
  "refund_processing",
  "refunded",
  "cancellation_processing",
  "cancelled",
  "needs_attention",
  "paid_confirmed_by_team",
  "completed",
];

/**
 * Whether the status page should empty the cart now (CO-19): this tab paid for
 * this order (its hand-off names it), the server says the payment arrived or
 * the order is over (never `awaiting_payment` or `payment_failed`), and the
 * cart still holds exactly the lines that were paid for. A cart the customer
 * has changed since is left alone.
 */
/**
 * The states in which the paid lines leave the cart: the payment arrived and the booking is going ahead or done.
 * Not when the hold was released, refunded, cancelled or needs our team: the customer may want to book again.
 */
export const CART_PAID_STATES: readonly string[] = [
  "payment_processing",
  "booking_processing",
  "confirmed_ticket_pending",
  "confirmed",
  "partially_fulfilled",
  "paid_confirmed_by_team",
];

export function shouldClearPaidCart(handoff: PaymentHandoff | null, reference: string, orderState: string, currentCartKey: string): boolean {
  if (!handoff || handoff.reference !== reference) return false;
  if (!CART_PAID_STATES.includes(orderState)) return false;
  return currentCartKey !== "" && handoff.cartKey === currentCartKey;
}
