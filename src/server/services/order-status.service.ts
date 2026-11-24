import "server-only";
import type { NextRequest } from "next/server";
import { prisma } from "../lib/db";
import type { DocumentSummary, TicketFulfilment } from "../documents/contracts";
import { chargedTotal } from "./order.service";
import { documentService } from "./document.service";
import { orderAccessService, type OrderAccess } from "./order-access.service";
import { evaluateCancellation, loadCancellationFacts, serviceStartUtc, type CancellationFacts } from "./cancellation.service";
import { ticketFactsForOrder } from "./ticket-facts.service";
import { EXTERNAL_RELEASE_CODES } from "../suppliers/external-confirmation";
import { inquiryHref } from "@/lib/inquiry-handoff";
import type { CustomerTicketFacts } from "@/lib/ticket-validity";
import { EXTERNAL_CONFIRMATION_STATEMENT, freeCancellationCopy, TICKET_NON_REFUNDABLE_STATEMENT } from "@/lib/utils";
import {
  formatDubaiAndUtc,
  remedySentence,
  type CancellationRequestStatus,
  type CancellationView,
  type CustomerDocument,
  type CustomerItemStatus,
  type CustomerOrderState,
  type CustomerOrderStatus,
  type CustomerStep,
  type CustomerTone,
  type StepStatus,
} from "@/lib/customer-status";

/**
 * The customer status projection (doc 22 §23 B5; PRD-17, TKT-8, F1, F15,
 * F23, F39, F51; contract `src/lib/customer-status.ts`).
 *
 * Built on the server from stored, provider-verified and supplier-verified
 * state only: the order and its items, the payment saga and its payment,
 * the supplier attempts' states, the documents (`documentService.
 * listForOrder`), refunds, customer remedies, cancellation requests and the
 * quote snapshot (the exact refund deadline). Nothing comes from a URL, a
 * query parameter or the browser.
 *
 * Every state is mapped honestly: an unknown outcome is "processing" with the
 * time the approved remedy runs by itself (TKT-8), a saga in `attention` is
 * `needs_attention` with a plain next step, never a fake success. The
 * projection never carries net costs, margins, supplier ids or names,
 * internal reason codes, ticket codes, storage keys, gateway ids or the
 * order id. Documents are listed only for a caller who may download them
 * (the owning customer or a `download_tickets` grant); their hrefs are
 * `/api/tickets/documents/<id>`, which re-checks ownership on every request.
 *
 * `projectCustomerStatus` is pure (tests drive it with synthetic
 * snapshots); `loadCustomerOrderStatusForRequest` and
 * `loadCustomerOrderStatusFromCookies` decide access first
 * (order-access.service.ts) and return null when the caller may not see the
 * order, so callers answer one uniform 404.
 */

type Currency = "INR" | "AED";


/**
 * The time a customer sees. An instant item stores the supplier slot
 * reference (`<timeSlotId>@HH:mm`, traveldesk.quote.ts `slotRefOf`); only its
 * time is shown. Any other stored text (an agent's "21:00 sailing") is shown
 * as it is.
 */
export function customerTimeslot(timeslot: string | null): string | null {
  if (!timeslot) return null;
  const ref = /^\d{1,9}@(\d{2}:\d{2})$/.exec(timeslot);
  return ref ? ref[1] : timeslot;
}

/* ---------------------------------------------------------------------------
 * Snapshot: everything the projection reads, already loaded
 * ------------------------------------------------------------------------ */


export interface StatusItemSnapshot {
  id: string;
  title: string;
  /** YYYY-MM-DD (Dubai calendar day). */
  serviceDate: string;
  timeslot: string | null;
  pax: unknown;
  /** order_items.status */
  status: string;
  /** The item's latest supplier attempt. */
  booking: {
    state: string;
    startMinutes: number | null;
    confirmedAt: Date | null;
    cancelledAt: Date | null;
    updatedAt: Date;
    pickupTimeMinutes?: number | null;
    /** Doc 29 Batch 6: the attempt books through an external supplier; absent or null reads as internal. */
    externalRoute?: boolean | null;
    /** Doc 29 Batch 6: still waiting on the external supplier, and flagged for our team (the hand-off, or any other flag). */
    externalHandedOff?: boolean;
    /** Doc 29 Batch 6: the external operator's hold was too short to book online and was released. */
    externalHoldUnusable?: boolean;
  } | null;
  /** The pickup hotel chosen at checkout (`order_items.pickup_hotel_name_snapshot`); absent or null without pickup. */
  pickupHotelName?: string | null;
  tickets: { fulfilment: TicketFulfilment; documents: DocumentSummary[] };
  refunds: Array<{ status: string; createdAt: Date; updatedAt: Date }>;
  remedies: Array<{ kind: string; status: string; refunded: boolean; updatedAt: Date }>;
  /** The item's latest cancellation or exception request. */
  request: { kind: "supported" | "exception"; status: CancellationRequestStatus; createdAt: Date; updatedAt: Date } | null;
  /** Stored policy and payment facts for the cancellation offer; null when there are none. */
  cancellation: CancellationFacts | null;
  /** A `TICKETS_READY` email for this item reached the provider (`sent`, `delivered` or `read`). */
  ticketsEmailed?: boolean;
  /** An `instant_checkout` item: the order's payment saga covers it even when it names another item (multi-item). */
  instant?: boolean;
  /** Doc 29 Batch 5: an open-dated ticket item (no codes); absent or null for other items. */
  ticket?: CustomerTicketFacts | null;
}

export interface StatusSnapshot {
  order: { reference: string; status: string; rail: "self_serve" | "assisted"; currency: Currency; totalMinor: bigint; placedAt: Date; updatedAt: Date; paidAt: Date | null };
  saga: { orderItemId: string; state: string; deadlineAt: Date | null; attentionRequiredAt: Date | null; updatedAt: Date } | null;
  /** The saga's payment, or the order's latest payment. */
  payment: { status: string; capturedMinor: bigint; refundedMinor: bigint; authorizedAt: Date | null; capturedAt: Date | null } | null;
  items: StatusItemSnapshot[];
  /** Whether the caller may download documents (documents are listed only then). */
  canDownload: boolean;
}

/* ---------------------------------------------------------------------------
 * Projection (pure)
 * ------------------------------------------------------------------------ */

const LIVE_SAGA = ["authorized", "captured", "capture_unknown", "reserve_pending", "reserved", "confirm_pending"];
const BOOKING_PROCESSING = ["queued", "reserving", "reserved", "awaiting_payment", "confirming", "awaiting_external", "outcome_unknown", "not_found_unresolved", "manual_review"];
const BOOKING_HELD = ["confirmed", "cancelling", "cancel_unverified", "cancel_refused"];
const BOOKING_FAILED = ["rejected", "expired", "not_created"];
const OPEN_REFUND = ["requested", "accepted", "unknown"];
const PAID_ORDER = ["paid", "supplier_pending", "confirmed", "partially_confirmed"];
const DAY_MS = 86_400_000;

/**
 * How soon the status page asks again while a state can still change by
 * itself (`pollAfterMs`; checkout redesign batch 4, CO-09, CO-40): 5 s while
 * the payment, the booking or the voucher is in flight (the voucher usually
 * lands seconds after the operator confirms), slower for steps that take
 * minutes or days. The client backs off from this when nothing changes for a
 * while, on failures and while the tab is hidden (`pollDelay` in
 * presenters.ts). A state missing here never polls.
 */
export const POLL_MS: Partial<Record<CustomerOrderState, number>> = {
  awaiting_payment: 5_000,
  payment_processing: 5_000,
  booking_processing: 5_000,
  confirmed_ticket_pending: 5_000,
  cancellation_processing: 15_000,
  refund_processing: 60_000,
};
/** A hold being released (`payment_released` while the saga is `release_pending`). */
export const RELEASE_POLL_MS = 30_000;
/** A voucher late enough to raise attention (F12, 2 min) whose download is still being retried (CO-09). */
export const LATE_VOUCHER_POLL_MS = 60_000;

const TONE: Record<CustomerOrderState, CustomerTone> = {
  awaiting_payment: "progress",
  payment_processing: "progress",
  booking_processing: "progress",
  confirmed_ticket_pending: "progress",
  confirmed: "success",
  partially_fulfilled: "warning",
  payment_released: "neutral",
  refund_processing: "progress",
  refunded: "success",
  payment_failed: "danger",
  cancellation_processing: "progress",
  cancelled: "neutral",
  needs_attention: "warning",
  paid_confirmed_by_team: "success",
  completed: "neutral",
};

/** Which of several item states the order shows first. */
const PRIORITY: CustomerOrderState[] = [
  "needs_attention",
  "cancellation_processing",
  "refund_processing",
  "payment_processing",
  "booking_processing",
  "awaiting_payment",
  "confirmed_ticket_pending",
  "payment_failed",
  "paid_confirmed_by_team",
  "confirmed",
  "payment_released",
  "refunded",
  "cancelled",
  "completed",
  "partially_fulfilled",
];

function iso(d: Date | null | undefined): string | null {
  return d ? d.toISOString() : null;
}

function step(status: StepStatus, label: string, at: Date | null = null): CustomerStep {
  return { status, label, at: iso(at) };
}

function captured(s: StatusSnapshot): boolean {
  return Boolean(s.payment && s.payment.capturedMinor > 0n);
}

function serviceOver(item: StatusItemSnapshot, now: Date): boolean {
  return serviceStartUtc(item.serviceDate, null).getTime() + DAY_MS <= now.getTime();
}

const PAX_NAMES: Record<string, [string, string]> = {
  adult: ["adult", "adults"],
  child: ["child", "children"],
  infant: ["infant", "infants"],
  senior: ["senior", "seniors"],
  youth: ["youth", "youths"],
  student: ["student", "students"],
};

/** "2 adults, 1 child" from the stored pax counts; unknown unit names are shown as stored. */
export function paxLabel(pax: unknown): string {
  if (!pax || typeof pax !== "object" || Array.isArray(pax)) return "";
  const parts: string[] = [];
  const entries = Object.entries(pax as Record<string, unknown>);
  const order = (k: string) => {
    const i = Object.keys(PAX_NAMES).indexOf(k.replace(/s$/, "").replace(/^children$/, "child"));
    return i < 0 ? 99 : i;
  };
  for (const [rawKey, rawValue] of entries.sort((a, b) => order(a[0]) - order(b[0]))) {
    const n = typeof rawValue === "number" ? rawValue : Number(rawValue);
    if (!Number.isInteger(n) || n <= 0) continue;
    const key = rawKey === "children" ? "child" : rawKey.replace(/s$/, "");
    const names = PAX_NAMES[key];
    const label = names ? names[n === 1 ? 0 : 1] : rawKey.replace(/[^A-Za-z ]/g, "").slice(0, 30);
    if (label) parts.push(`${n} ${label}`);
  }
  return parts.join(", ");
}

interface ItemProjection {
  state: CustomerOrderState;
  /** The item carries the payment saga. */
  sagaItem: boolean;
}

/** Historic assisted orders, and anything without a saga: the order row is what our team recorded. */
function recordedState(status: string, over: boolean): CustomerOrderState {
  switch (status) {
    case "pending_payment":
      return "awaiting_payment";
    case "payment_failed":
      return "payment_failed";
    case "cancelled":
      return "cancelled";
    case "refunded":
      return "refunded";
    case "completed":
      return "completed";
    default:
      if (PAID_ORDER.includes(status)) return over ? "completed" : "paid_confirmed_by_team";
      return "needs_attention";
  }
}

/** Whether the order's saga covers this item: the item it names, and every instant item of a multi-item order. */
function sagaCovers(s: StatusSnapshot, item: StatusItemSnapshot): boolean {
  return Boolean(s.saga && (s.saga.orderItemId === item.id || item.instant === true));
}

/** A multi-item instant order (lead design, 3 November 2026): after the capture each item stands alone. */
function multiItem(s: StatusSnapshot): boolean {
  return s.items.filter((i) => sagaCovers(s, i)).length > 1;
}

/** The customer state of one item. */
function itemState(s: StatusSnapshot, item: StatusItemSnapshot, now: Date): ItemProjection {
  const saga = sagaCovers(s, item) ? s.saga : null;
  const req = item.request;
  if (req?.kind === "supported") {
    if (req.status === "requested" || req.status === "cancelling" || req.status === "cancel_unverified") return { state: "cancellation_processing", sagaItem: Boolean(saga) };
    if (req.status === "refund_pending") return { state: "refund_processing", sagaItem: Boolean(saga) };
    if (req.status === "refunded") return { state: "cancelled", sagaItem: Boolean(saga) };
    if (req.status === "refund_failed") return { state: "needs_attention", sagaItem: Boolean(saga) };
    // refused: the booking stands; fall through to its normal state.
  }

  if (!saga) return { state: recordedState(s.order.status, serviceOver(item, now)), sagaItem: false };

  const openRefund = item.refunds.some((r) => OPEN_REFUND.includes(r.status));
  const refundDone = item.refunds.length > 0 && item.refunds.every((r) => r.status === "succeeded");
  if (multiItem(s) && (saga.state === "confirm_pending" || saga.state === "fulfilled")) {
    // This item was not supplied and is refunded on its own; the other items keep their own state.
    const waitingRefund = item.remedies.some((r) => r.kind === "refund" && (r.status === "pending" || r.status === "in_progress"));
    // An item-scoped problem the saga recorded (a refund refused or short): our team is on it.
    if (item.remedies.some((r) => r.kind === "refund" && r.status === "failed" && !r.refunded)) return { state: "needs_attention", sagaItem: true };
    if (item.status === "rejected" || item.refunds.length > 0 || waitingRefund) {
      if (openRefund || waitingRefund) return { state: "refund_processing", sagaItem: true };
      if (refundDone) return { state: "refunded", sagaItem: true };
      return { state: "needs_attention", sagaItem: true };
    }
    // Until the whole order is settled (`fulfilled`) every other item shows as processing, and none can be
    // cancelled yet (lead decision, 3 November 2026; cancellation.service.ts `orderSettling`).
    if (saga.state === "confirm_pending") return { state: "booking_processing", sagaItem: true };
  }
  switch (saga.state) {
    case "session_created":
      return { state: "awaiting_payment", sagaItem: true };
    case "authorized":
    case "captured":
    case "capture_unknown":
      return { state: "payment_processing", sagaItem: true };
    case "reserve_pending":
    case "reserved":
    case "confirm_pending":
      return { state: "booking_processing", sagaItem: true };
    case "release_pending":
      return { state: captured(s) || openRefund ? "refund_processing" : "payment_released", sagaItem: true };
    case "released":
      return { state: openRefund ? "refund_processing" : "payment_released", sagaItem: true };
    case "refund_pending":
      return { state: "refund_processing", sagaItem: true };
    case "refunded":
      return { state: "refunded", sagaItem: true };
    case "failed":
      return { state: openRefund ? "refund_processing" : "payment_failed", sagaItem: true };
    case "attention":
      return { state: "needs_attention", sagaItem: true };
    case "fulfilled": {
      const b = item.booking?.state ?? null;
      if (b === "cancelled") {
        // Cancelled outside a customer request (by our team): only what is stored is said.
        if (openRefund) return { state: "refund_processing", sagaItem: true };
        return { state: refundDone ? "cancelled" : "needs_attention", sagaItem: true };
      }
      if (serviceOver(item, now)) return { state: "completed", sagaItem: true };
      if (item.tickets.fulfilment === "attention") return { state: "needs_attention", sagaItem: true };
      if (item.tickets.fulfilment === "ticket_pending") return { state: "confirmed_ticket_pending", sagaItem: true };
      return { state: "confirmed", sagaItem: true };
    }
    default:
      return { state: "needs_attention", sagaItem: true };
  }
}

function orderState(states: CustomerOrderState[]): CustomerOrderState {
  const unique = [...new Set(states)];
  if (unique.length === 1) return unique[0];
  if (!unique.length) return "needs_attention";
  const ok = ["confirmed", "confirmed_ticket_pending", "paid_confirmed_by_team", "completed"];
  const off = ["refunded", "payment_released", "cancelled", "payment_failed"];
  if (unique.some((x) => ok.includes(x)) && unique.some((x) => off.includes(x)) && unique.every((x) => ok.includes(x) || off.includes(x))) return "partially_fulfilled";
  return PRIORITY.find((p) => unique.includes(p)) ?? unique[0];
}

function paymentStep(s: StatusSnapshot, state: CustomerOrderState): CustomerStep {
  const p = s.payment;
  if (s.order.rail === "assisted" || !s.saga) {
    if (state === "awaiting_payment") return step("in_progress", "Waiting for payment");
    if (state === "payment_failed") return step("failed", "Payment did not go through");
    return step("done", "Payment received by our team", s.order.paidAt);
  }
  if (p && p.capturedMinor > 0n) return step("done", "Payment received", p.capturedAt);
  if (s.saga.state === "capture_unknown") return step("in_progress", "Confirming your payment with the bank");
  if (p?.authorizedAt) return step("done", "Payment received: held on your card, charged once the operator has reserved your place", p.authorizedAt);
  if (s.saga.state === "failed") return step("failed", "Payment did not go through", s.saga.updatedAt);
  if (s.saga.state === "session_created") return step("in_progress", "Waiting for Stripe to confirm");
  return step("not_started", "Not started");
}

function bookingStep(s: StatusSnapshot, items: StatusItemSnapshot[], state: CustomerOrderState): CustomerStep {
  if (s.order.rail === "assisted" || !s.saga) {
    if (state === "paid_confirmed_by_team" || state === "completed") return step("done", "Arranged by our team");
    if (state === "cancelled" || state === "refunded") return step("not_applicable", "Cancelled");
    return step("not_started", "Not started");
  }
  if (multiItem(s)) {
    // Several items: the step is done once each item is confirmed or out of the order; per-item states say which.
    const steps = items.filter((i) => sagaCovers(s, i)).map((i) => bookingStepOf(s, i));
    return steps.find((x) => x.status === "in_progress") ?? steps.find((x) => x.status === "not_started") ?? steps.find((x) => x.status === "done") ?? steps[0];
  }
  return bookingStepOf(s, items.find((i) => i.id === s.saga!.orderItemId));
}

function bookingStepOf(s: StatusSnapshot, item: StatusItemSnapshot | undefined): CustomerStep {
  const saga = s.saga!;
  const b = item?.booking;
  if (!b) {
    if (["session_created", "authorized", "captured", "capture_unknown", "reserve_pending"].includes(saga.state)) return step("not_started", "Starts once your payment is confirmed");
    return step("not_applicable", "Not booked");
  }
  if (b.state === "cancelled") return b.confirmedAt ? step("done", "Cancelled with the operator", b.cancelledAt ?? b.updatedAt) : step("failed", "The operator could not confirm this booking", b.updatedAt);
  if (BOOKING_HELD.includes(b.state)) return step("done", "Booked with the operator", b.confirmedAt);
  if (BOOKING_FAILED.includes(b.state)) return step("failed", "The operator could not confirm this booking", b.updatedAt);
  if (b.state === "manual_review") return step("in_progress", "Our team is checking with the operator");
  if (BOOKING_PROCESSING.includes(b.state)) return step("in_progress", "Confirming with the operator");
  return step("in_progress", "Confirming with the operator");
}

function ticketsStep(s: StatusSnapshot, items: StatusItemSnapshot[], state: CustomerOrderState): CustomerStep {
  if (s.order.rail === "assisted" || !s.saga) return step("not_applicable", state === "paid_confirmed_by_team" ? "Sent to you by our team" : "Not applicable");
  if (multiItem(s)) {
    // Several items: tickets are ready when every confirmed item's are; refunded items need none.
    const steps = items.filter((i) => sagaCovers(s, i) && i.status !== "rejected").map((i) => ticketsStepOf(i, state));
    if (!steps.length) return step("not_applicable", "Not needed");
    return steps.find((x) => x.status === "in_progress") ?? steps.find((x) => x.status === "not_started") ?? steps.find((x) => x.status === "done") ?? steps[0];
  }
  return ticketsStepOf(items.find((i) => i.id === s.saga!.orderItemId), state);
}

function ticketsStepOf(item: StatusItemSnapshot | undefined, state: CustomerOrderState): CustomerStep {
  const f = item?.tickets.fulfilment ?? "not_applicable";
  if (f === "issued") {
    const at = item!.tickets.documents.map((d) => Date.parse(d.createdAt)).filter(Number.isFinite);
    return step("done", "Voucher ready", at.length ? new Date(Math.max(...at)) : null);
  }
  if (f === "ticket_pending") return step("in_progress", "Voucher being prepared");
  if (f === "attention") return step("in_progress", "Our team is getting your voucher");
  if (item?.booking && BOOKING_HELD.includes(item.booking.state)) return step("done", "No voucher needed");
  if (["refunded", "payment_released", "payment_failed", "cancelled", "refund_processing"].includes(state)) return step("not_applicable", "Not needed");
  return step("not_started", "Follows the operator's confirmation");
}

function refundStep(s: StatusSnapshot, items: StatusItemSnapshot[]): CustomerStep | null {
  const refunds = items.flatMap((i) => i.refunds);
  const remedies = items.flatMap((i) => i.remedies);
  const latest = (xs: Array<{ updatedAt: Date }>) => (xs.length ? new Date(Math.max(...xs.map((x) => x.updatedAt.getTime()))) : null);
  if (refunds.length) {
    if (refunds.some((r) => OPEN_REFUND.includes(r.status))) return step("in_progress", "Refund in progress");
    if (refunds.every((r) => r.status === "succeeded")) return step("done", "Refunded", latest(refunds));
    if (refunds.some((r) => r.status === "failed") && !refunds.some((r) => r.status === "succeeded")) return step("failed", "Your refund is delayed: our team is on it", latest(refunds));
    return step("done", "Refunded", latest(refunds));
  }
  const waitingRefund = remedies.find((r) => r.kind === "refund" && (r.status === "pending" || r.status === "in_progress"));
  if (waitingRefund) return step("in_progress", "Refund in progress");
  const releases = remedies.filter((r) => r.kind === "release_authorization");
  if (releases.some((r) => r.status === "pending" || r.status === "in_progress")) return step("in_progress", "Releasing the hold on your card");
  if (releases.some((r) => r.status === "failed")) return step("failed", "Releasing the hold is taking longer: our team is on it", latest(releases));
  if (releases.some((r) => r.status === "completed")) return step("done", "Hold released: nothing was charged", latest(releases));
  if (s.saga?.state === "release_pending") return step("in_progress", "Releasing the hold on your card");
  if (s.saga?.state === "released") return step("done", "Hold released: nothing was charged", s.saga.updatedAt);
  return null;
}

function remedyFor(s: StatusSnapshot): { at: string | null; kind: "release" | "refund" | null } {
  const saga = s.saga;
  if (!saga || !LIVE_SAGA.includes(saga.state) || !saga.deadlineAt) return { at: null, kind: null };
  const kind = saga.state === "capture_unknown" || captured(s) ? "refund" : "release";
  return { at: saga.deadlineAt.toISOString(), kind };
}

function cancellationView(item: StatusItemSnapshot, state: CustomerOrderState, now: Date): CancellationView {
  const r = item.request;
  if (r) return { kind: "requested", status: r.status, requestKind: r.kind, requestedAt: r.createdAt.toISOString(), updatedAt: r.updatedAt.toISOString() };
  if (!item.cancellation) return { kind: "none" };
  if (["refunded", "payment_released", "payment_failed", "refund_processing", "cancelled", "awaiting_payment", "completed"].includes(state)) return { kind: "none" };
  return evaluateCancellation(item.cancellation, now);
}

/**
 * The supplier's pickup time for a live booking (doc 29 §8.7), with the hotel
 * chosen at checkout. Only for a confirmed attempt: a time on a hold that was
 * released or refused is no promise.
 */
function pickupOf(item: StatusItemSnapshot): CustomerItemStatus["pickup"] {
  const m = item.booking?.state === "confirmed" ? item.booking.pickupTimeMinutes : null;
  if (typeof m !== "number" || !Number.isInteger(m) || m < 0 || m >= 24 * 60) return null;
  const time = `${String(Math.floor(m / 60)).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}`;
  return { time, hotel: item.pickupHotelName ?? null };
}

function refundUntil(item: StatusItemSnapshot): string | null {
  const p = item.cancellation?.policy;
  if (!p || p.nonRefundableAfterConfirm || !p.freeCancellationUntilUtc) return null;
  const t = Date.parse(p.freeCancellationUntilUtc);
  return Number.isFinite(t) ? new Date(t).toISOString() : null;
}

function documentsFor(item: StatusItemSnapshot, canDownload: boolean): CustomerDocument[] {
  if (!canDownload) return [];
  return item.tickets.documents
    .filter((d) => d.status === "valid" && (d.kind === "tickets_pdf" || d.kind === "voucher_pdf"))
    .map((d) => ({ id: d.id, kind: d.kind as "tickets_pdf" | "voucher_pdf", version: d.version, contentType: d.contentType, byteSize: d.byteSize, href: `/api/tickets/documents/${d.id}` }));
}

/**
 * Doc 29 Batch 6: a single-item order booked through an external supplier.
 * Its confirmation can take minutes and is never given up on a clock: the
 * money comes back once the operator shows it cannot confirm, so the page
 * promises no time for it (no remedy deadline). `handedOff`: still waiting,
 * and handed to our team at the wait limit. Multi-item orders keep their
 * per-item words.
 */
function externalView(s: StatusSnapshot): { external: boolean; handedOff: boolean; multiUnsettled: boolean; holdUnusable: boolean } {
  const covered = s.items.filter((i) => sagaCovers(s, i));
  const holdUnusable = covered.some((i) => i.booking?.externalHoldUnusable === true);
  if (multiItem(s)) {
    // Review 89 B6-02: an external item still waiting is never refunded at the saga's deadline, so the order-level
    // sentence names no time while one is unsettled.
    const multiUnsettled = covered.some((i) => i.booking?.externalRoute === true && !EXTERNAL_SETTLED.includes(i.booking.state));
    return { external: false, handedOff: false, multiUnsettled, holdUnusable };
  }
  const external = covered.some((i) => i.booking?.externalRoute === true);
  return { external, handedOff: external && covered.some((i) => i.booking?.externalHandedOff === true), multiUnsettled: false, holdUnusable };
}

/** Attempt states after which an external item no longer waits on its supplier. */
const EXTERNAL_SETTLED = ["confirmed", "cancelled", "rejected", "expired", "not_created", "cancelling", "cancel_unverified", "cancel_refused"];

/** "your Desert safari" for one item, "your 3 activities" for several. */
function whatBooked(s: StatusSnapshot): string {
  const live = s.items.filter((i) => i.status !== "rejected");
  if (live.length === 1) return `your ${live[0].title}`;
  return `your ${live.length || s.items.length} activities`;
}

/**
 * The customer words for a state (checkout redesign batch 1, design contract
 * §7; CO-04, CO-05, CO-14). Rules:
 *  - before the verified payment evidence arrives (`awaiting_payment`) the page
 *    never says nothing was taken: the customer may have just paid (CO-04);
 *  - from the payment to the operator's answer, one sentence covers every saga
 *    step (authorised, reserving, captured, confirming), so the page does not
 *    rewrite itself without news, and the remedy outcome is one sentence true
 *    for a release and a refund alike (CO-05). Its time (TKT-8) is the saga's
 *    deadline, which the saga itself can move; showing one fixed time needs a
 *    deadline stored at authorisation, a server change (reported, not done);
 *  - an order with no payment saga (arranged by our team, paid by link) is
 *    worded without naming a payment provider;
 *  - no channel is promised that does not exist (no confirmation email, CO-11).
 */
function words(
  state: CustomerOrderState,
  s: StatusSnapshot,
  remedyAt: string | null,
  canDownload: boolean,
): { headline: string; nextStep: string } {
  const multi = multiItem(s);
  const what = whatBooked(s);
  const by = remedyAt ? formatDubaiAndUtc(remedyAt) : null;
  const team = s.saga?.attentionRequiredAt ? " Our team is also checking it." : "";
  const { external, handedOff, multiUnsettled, holdUnusable } = externalView(s);
  const remedy = external
    ? " If the operator cannot confirm it, you get the full amount back automatically, as a released hold or a refund."
    : ` ${remedySentence(multiUnsettled ? null : by, multi)}`;
  // Owner decision d (24 Nov 2026): after an external hold too short to book online, offer "Send it to our team".
  const handOver = holdUnusable ? " The operator couldn't hold your place long enough to book it online. Send it to our team and they book it with you." : "";
  switch (state) {
    case "awaiting_payment":
      if (!s.saga || s.order.rail === "assisted") {
        return { headline: "We are waiting for your payment.", nextStep: "Pay with the payment link our team sent you. This page updates once the payment is recorded." };
      }
      return {
        headline: "Waiting for Stripe to confirm your payment.",
        nextStep: "If you've just paid, don't pay again: this page updates by itself once Stripe confirms it. If you left the payment page without paying, nothing was charged.",
      };
    case "payment_processing":
      if (s.saga?.state === "capture_unknown") {
        return { headline: "We're still confirming your payment with the bank.", nextStep: `Don't pay again: you won't be charged twice for this booking. This page updates by itself.${remedy}${team}` };
      }
      return { headline: `Payment received. We're booking ${what} with the operator.`, nextStep: `This page updates by itself.${remedy}${team}` };
    case "booking_processing":
      if (handedOff) {
        return {
          headline: `Payment received. The operator is taking longer than usual to confirm ${what}.`,
          nextStep: `Our team is following it up with them and will contact you. This page updates by itself.${remedy}`,
        };
      }
      if (external) {
        return {
          headline: `Payment received. We're booking ${what} with the operator.`,
          nextStep: `This operator confirms through their own system, so it can take a few minutes. This page updates by itself.${remedy}${team}`,
        };
      }
      return { headline: `Payment received. We're booking ${what} with the operator.`, nextStep: `This page updates by itself.${remedy}${team}` };
    case "confirmed_ticket_pending":
      return {
        headline: multi ? "Booked. Your vouchers are being prepared." : "Booked. Your voucher is being prepared.",
        nextStep: "This page updates by itself when it's ready, and we email it to you too.",
      };
    case "confirmed": {
      // R-B5-10: say the tickets were emailed only when that email is recorded as sent.
      const issued = s.items.filter((i) => i.tickets.fulfilment === "issued");
      const headline = multi ? "Your activities are booked." : `${what.charAt(0).toUpperCase()}${what.slice(1)} is booked.`;
      let nextStep: string;
      const plural = issued.length > 1;
      if (!issued.length) nextStep = "Keep your booking reference to hand for the day. Message us on WhatsApp if you need anything.";
      else if (canDownload) nextStep = plural ? "Your vouchers are ready to download. Show them on your phone or print them for the day." : "Your voucher is ready to download. Show it on your phone or print it for the day.";
      else {
        nextStep = plural ? "Your vouchers are ready. To keep them private, confirm it's you." : "Your voucher is ready. To keep it private, confirm it's you.";
        if (issued.every((i) => i.ticketsEmailed)) nextStep += " We've also emailed you a link to it.";
      }
      return { headline, nextStep };
    }
    case "partially_fulfilled":
      return { headline: "Part of your order is booked.", nextStep: "Each activity below shows where it stands. Anything not booked is refunded or released automatically." };
    case "payment_released":
      return s.saga?.state === "released"
        ? { headline: "The hold on your card has been released. Nothing was charged.", nextStep: `Your bank may take a few days to remove the hold from your statement.${handOver}` }
        : { headline: "We are releasing the hold on your card. Nothing has been charged.", nextStep: `You do not need to do anything. Your bank may take a few days to remove the hold.${handOver}` };
    case "refund_processing":
      return { headline: "Your refund is on its way.", nextStep: `You do not need to do anything. Your bank may take several working days to show it.${handOver}` };
    case "refunded":
      return { headline: "You have been refunded in full.", nextStep: `Your bank may take several working days to show it on your statement.${handOver}` };
    case "payment_failed":
      return { headline: "Your payment did not go through. Nothing was taken.", nextStep: "You can try again with another card, or message us on WhatsApp and our team will help." };
    case "cancellation_processing":
      return { headline: "We are cancelling your booking with the operator.", nextStep: "Once the operator confirms the cancellation, your refund starts automatically. This page updates by itself." };
    case "cancelled":
      return { headline: "Your booking is cancelled.", nextStep: "Nothing more is owed. Any refund shown below has been completed." };
    case "needs_attention":
      return { headline: "Our team has been alerted and is looking into your booking.", nextStep: "Nothing is lost while they do. We will contact you, or you can message us on WhatsApp with your reference." };
    case "paid_confirmed_by_team":
      return { headline: "Your booking was arranged by our team and is paid.", nextStep: "Your confirmation and tickets come from our team. Message us on WhatsApp if you need anything." };
    case "completed":
      return { headline: "This booking has taken place.", nextStep: "We hope you enjoyed it. Message us on WhatsApp if anything was not right." };
  }
}

/** The item's cancellation statement in the quote's words (CO-01); none once the item is no longer a live booking. */
function cancellationTermsOf(item: StatusItemSnapshot, state: CustomerOrderState): string | null {
  if (["refunded", "payment_released", "payment_failed", "refund_processing", "cancelled", "completed"].includes(state)) return null;
  // Doc 29 Batch 5: a ticket item's one statement, whatever policy was stored.
  if (item.ticket) return TICKET_NON_REFUNDABLE_STATEMENT;
  const p = item.cancellation?.policy;
  if (!p) return null;
  return freeCancellationCopy(p.nonRefundableAfterConfirm ? null : p.freeCancellationUntilUtc);
}

/** The voucher of a confirmed item is still being fetched: a customer-visible PDF row is pending (failed rows are not listed). */
function voucherStillComing(item: StatusItemSnapshot): boolean {
  return Boolean(item.booking && BOOKING_HELD.includes(item.booking.state)) && item.tickets.documents.some((d) => d.status === "pending");
}

/**
 * `pollAfterMs` (CO-09): the fastest cadence of the order's state and of
 * every item that can still change by itself, or null when none can. So a
 * partly booked order keeps polling while one item's voucher is still being
 * prepared or its refund is running, and an order shown as needing attention
 * keeps polling while another item is in flight or a late voucher is still
 * being retried. Terminal states (booked with vouchers, refunded, released,
 * failed, cancelled, completed, arranged by our team) and an attention a
 * human must resolve stop it.
 */
export function pollAfterFor(s: StatusSnapshot, state: CustomerOrderState, per: Array<{ item: StatusItemSnapshot | null; state: CustomerOrderState }>): number | null {
  const cadence = (st: CustomerOrderState, item: StatusItemSnapshot | null): number | null => {
    const base = POLL_MS[st];
    if (base !== undefined) return base;
    if (st === "payment_released" && s.saga?.state === "release_pending") return RELEASE_POLL_MS;
    if (st === "needs_attention" && item && voucherStillComing(item)) return LATE_VOUCHER_POLL_MS;
    return null;
  };
  const all = [cadence(state, per.length === 1 ? per[0].item : null), ...per.map((p) => cadence(p.state, p.item))].filter((x): x is number => x !== null);
  return all.length ? Math.min(...all) : null;
}

/** Builds the customer status from a loaded snapshot. Pure; `now` decides deadlines and completion. */
export function projectCustomerStatus(s: StatusSnapshot, now: Date): CustomerOrderStatus {
  const per = s.items.map((item) => ({ item, ...itemState(s, item, now) }));
  const sagaItem = per.find((p) => p.sagaItem);
  const state = !per.length ? recordedState(s.order.status, false) : sagaItem && per.length === 1 ? sagaItem.state : orderState(per.map((p) => p.state));
  const ext = externalView(s);
  const remedy = ["payment_processing", "booking_processing"].includes(state) && !ext.external && !ext.multiUnsettled ? remedyFor(s) : { at: null, kind: null };
  const { headline, nextStep } = words(state, s, remedy.at, s.canDownload);

  const items: CustomerItemStatus[] = per.map(({ item, state: itemSt }) => ({
    orderItemId: item.id,
    title: item.title,
    serviceDate: item.serviceDate,
    timeslot: customerTimeslot(item.timeslot),
    paxLabel: paxLabel(item.pax),
    state: itemSt,
    tickets: { fulfilment: item.tickets.fulfilment, documents: documentsFor(item, s.canDownload) },
    refundUntilUtc: refundUntil(item),
    pickup: pickupOf(item),
    cancellationTerms: cancellationTermsOf(item, itemSt),
    externalConfirmation: item.booking?.externalRoute === true ? EXTERNAL_CONFIRMATION_STATEMENT : null,
    cancellation: cancellationView(item, itemSt, now),
    ...(item.ticket
      ? {
          ticket: {
            validUntil: item.ticket.validUntil,
            validityCopy: item.ticket.validityCopy,
            nonRefundableCopy: item.ticket.nonRefundableCopy,
            types: item.ticket.types.map((t) => ({ label: t.label, count: t.count })),
            validityConcern: item.ticket.validityConcern ?? null,
          },
        }
      : {}),
  }));

  const ahead = items.map((i) => i.refundUntilUtc).filter((t): t is string => Boolean(t) && Date.parse(t!) > now.getTime());
  const stamps = [
    s.order.updatedAt,
    s.saga?.updatedAt,
    ...s.items.flatMap((i) => [i.booking?.updatedAt, i.request?.updatedAt, ...i.refunds.map((r) => r.updatedAt), ...i.remedies.map((r) => r.updatedAt)]),
  ].filter((d): d is Date => d instanceof Date);

  const pollable = pollAfterFor(s, state, per);

  return {
    reference: s.order.reference,
    state,
    tone: state === "payment_released" && s.saga?.state === "release_pending" ? "progress" : TONE[state],
    headline,
    nextStep,
    rail: s.order.rail,
    currency: s.order.currency,
    totalMinor: s.order.totalMinor.toString(),
    placedAt: s.order.placedAt.toISOString(),
    updatedAt: new Date(Math.max(...stamps.map((d) => d.getTime()))).toISOString(),
    steps: {
      payment: paymentStep(s, state),
      booking: bookingStep(s, s.items, state),
      tickets: ticketsStep(s, s.items, state),
      refund: refundStep(s, s.items),
    },
    deadlines: {
      refundUntilUtc: ahead.length ? ahead.sort()[0] : null,
      remedyAtUtc: remedy.at,
      remedyKind: remedy.kind,
    },
    items,
    canDownload: s.canDownload,
    inquiryHref: ext.holdUnusable && ["payment_released", "refund_processing", "refunded"].includes(state) ? inquiryHref("external_hold", "booking") : null,
    pollAfterMs: pollable ?? null,
  };
}

/* ---------------------------------------------------------------------------
 * Loader
 * ------------------------------------------------------------------------ */

/** Loads the snapshot for an order the caller was already allowed to see. */
export async function loadStatusSnapshot(access: Pick<OrderAccess, "orderId" | "canDownload">): Promise<StatusSnapshot | null> {
  const order = await prisma.order.findUnique({
    where: { id: access.orderId },
    select: {
      reference: true,
      status: true,
      rail: true,
      currency: true,
      totalInr: true,
      totalAed: true,
      placedAt: true,
      updatedAt: true,
      paidAt: true,
      items: {
        select: { id: true, titleSnapshot: true, serviceDate: true, timeslot: true, pax: true, status: true, fulfilmentOrigin: true, pickupHotelNameSnapshot: true },
        orderBy: [{ serviceDate: "asc" }, { id: "asc" }],
      },
      supplierBookings: {
        select: {
          orderItemId: true,
          state: true,
          startMinutes: true,
          confirmedAt: true,
          cancelledAt: true,
          updatedAt: true,
          createdAt: true,
          pickupTimeMinutes: true,
          externalRoute: true,
          errorCode: true,
          attentionRequiredAt: true,
        },
        orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      },
      paymentSaga: { select: { orderItemId: true, state: true, deadlineAt: true, attentionRequiredAt: true, updatedAt: true, paymentId: true } },
      payments: { select: { id: true, status: true, capturedMinor: true, refundedMinor: true, authorizedAt: true, capturedAt: true, createdAt: true }, orderBy: [{ createdAt: "desc" }, { id: "desc" }] },
      remedies: { select: { orderItemId: true, kind: true, status: true, refundId: true, updatedAt: true } },
      cancellationRequests: { select: { orderItemId: true, kind: true, status: true, createdAt: true, updatedAt: true }, orderBy: [{ createdAt: "desc" }, { id: "desc" }] },
    },
  });
  if (!order) return null;
  const itemIds = order.items.map((i) => i.id);
  const [refunds, tickets, facts, ticketEmails, ticketFacts] = await Promise.all([
    itemIds.length ? prisma.refund.findMany({ where: { orderItemId: { in: itemIds } }, select: { orderItemId: true, status: true, createdAt: true, updatedAt: true } }) : Promise.resolve([]),
    documentService.listForOrder(access.orderId),
    loadCancellationFacts(access.orderId),
    prisma.notification.findMany({ where: { orderId: access.orderId, event: "TICKETS_READY", status: { in: ["sent", "delivered", "read"] } }, select: { payload: true } }),
    ticketFactsForOrder(access.orderId),
  ]);
  const emailedItems = new Set(ticketEmails.map((n) => (n.payload as { orderItemId?: unknown } | null)?.orderItemId).filter((x): x is string => typeof x === "string"));
  const payment = order.paymentSaga?.paymentId ? (order.payments.find((p) => p.id === order.paymentSaga!.paymentId) ?? null) : (order.payments[0] ?? null);

  return {
    order: {
      reference: order.reference,
      status: order.status,
      rail: order.rail,
      currency: order.currency,
      totalMinor: chargedTotal(order),
      placedAt: order.placedAt,
      updatedAt: order.updatedAt,
      paidAt: order.paidAt,
    },
    saga: order.paymentSaga ? { orderItemId: order.paymentSaga.orderItemId, state: order.paymentSaga.state, deadlineAt: order.paymentSaga.deadlineAt, attentionRequiredAt: order.paymentSaga.attentionRequiredAt, updatedAt: order.paymentSaga.updatedAt } : null,
    payment: payment ? { status: payment.status, capturedMinor: payment.capturedMinor, refundedMinor: payment.refundedMinor, authorizedAt: payment.authorizedAt, capturedAt: payment.capturedAt } : null,
    canDownload: access.canDownload,
    items: order.items.map((item) => {
      const booking = order.supplierBookings.find((b) => b.orderItemId === item.id) ?? null;
      const t = tickets.find((x) => x.orderItemId === item.id);
      const request = order.cancellationRequests.find((r) => r.orderItemId === item.id) ?? null;
      return {
        id: item.id,
        title: item.titleSnapshot,
        serviceDate: item.serviceDate.toISOString().slice(0, 10),
        timeslot: customerTimeslot(item.timeslot),
        pax: item.pax,
        status: item.status,
        booking: booking
          ? {
              state: booking.state,
              startMinutes: booking.startMinutes,
              confirmedAt: booking.confirmedAt,
              cancelledAt: booking.cancelledAt,
              updatedAt: booking.updatedAt,
              pickupTimeMinutes: booking.pickupTimeMinutes,
              externalRoute: booking.externalRoute,
              // Doc 29 Batch 6: two booleans only; no internal code reaches the projection. Any flag on a waiting booking
              // means our team is on it (review 89 B6-06: a read dead-letter sets one without the hand-off code).
              externalHandedOff: booking.state === "awaiting_external" && booking.attentionRequiredAt !== null,
              // An unusable hold, or a reservation released while the provider was still making it (review 89 B6-15).
              externalHoldUnusable: booking.externalRoute === true && booking.errorCode !== null && EXTERNAL_RELEASE_CODES.includes(booking.errorCode),
            }
          : null,
        pickupHotelName: item.pickupHotelNameSnapshot,
        tickets: { fulfilment: t?.fulfilment ?? "not_applicable", documents: t?.documents ?? [] },
        refunds: refunds.filter((r) => r.orderItemId === item.id).map((r) => ({ status: r.status, createdAt: r.createdAt, updatedAt: r.updatedAt })),
        remedies: order.remedies.filter((r) => r.orderItemId === item.id).map((r) => ({ kind: r.kind, status: r.status, refunded: Boolean(r.refundId), updatedAt: r.updatedAt })),
        request: request ? { kind: request.kind as "supported" | "exception", status: request.status as CancellationRequestStatus, createdAt: request.createdAt, updatedAt: request.updatedAt } : null,
        cancellation: facts.get(item.id) ?? null,
        ticketsEmailed: emailedItems.has(item.id),
        instant: item.fulfilmentOrigin === "instant_checkout",
        ticket: ticketFacts.get(item.id) ?? null,
      };
    }),
  };
}

async function load(access: OrderAccess | null, now: Date): Promise<CustomerOrderStatus | null> {
  if (!access) return null;
  const snapshot = await loadStatusSnapshot(access);
  // Batch 3: a guest browser can remove its own access ("On a shared computer?"); a signed-in owner signs out instead.
  return snapshot ? { ...projectCustomerStatus(snapshot, now), canRemoveBrowserAccess: access.via !== "customer" } : null;
}

/** Route handlers. Null when the caller may not see the order (answer the uniform 404). */
export async function loadCustomerOrderStatusForRequest(req: NextRequest, reference: string, now: Date = new Date()): Promise<CustomerOrderStatus | null> {
  return load(await orderAccessService.forRequest(req, reference, now), now);
}

/** Server Components (`cookies()`). Null when the caller may not see the order (render the neutral "find your booking" state). */
export async function loadCustomerOrderStatusFromCookies(reference: string, now: Date = new Date()): Promise<CustomerOrderStatus | null> {
  return load(await orderAccessService.fromCookies(reference, now), now);
}
