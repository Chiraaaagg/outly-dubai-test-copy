import type {
  CancellationIneligibleReason,
  CancellationRequestStatus,
  CancellationView,
  CustomerDocument,
  CustomerItemStatus,
  CustomerOrderState,
  CustomerOrderStatus,
  CustomerStep,
  CustomerTone,
  StepStatus,
} from "@/lib/customer-status";
import { describeFile, remedySentence } from "@/lib/customer-status";
import { NON_REFUNDABLE_STATEMENT } from "@/lib/utils";

/**
 * Customer words for the B5 status projection (src/lib/customer-status.ts).
 *
 * Pure: no React, no I/O, so the status, confirmation, voucher and trips
 * pages and their tests share one vocabulary. Every state, step and request
 * has a plain-text label; colour and icons only ever repeat it
 * (accessibility criterion 4). Nothing here promises a time or an outcome the
 * projection does not carry: refund timings, operator response times and
 * ticket delivery speed are left to the server's own `headline` and
 * `nextStep` sentences.
 */

/** Short label for a state, for pills and lists. The page headline is the server's `headline`. */
export const STATE_LABEL: Record<CustomerOrderState, string> = {
  // Batch 1 (CO-14): the payment and booking steps share one label, so a saga
  // step that tells the customer nothing new does not change the pill.
  // Rail-neutral: an order our team arranged is paid by link, not on Stripe.
  awaiting_payment: "Awaiting payment",
  payment_processing: "Booking with the operator",
  booking_processing: "Booking with the operator",
  confirmed_ticket_pending: "Booked, voucher being prepared",
  confirmed: "Booked",
  partially_fulfilled: "Partly booked",
  payment_released: "Payment released",
  refund_processing: "Refund in progress",
  refunded: "Refunded",
  payment_failed: "Payment did not go through",
  cancellation_processing: "Cancellation in progress",
  cancelled: "Cancelled",
  needs_attention: "Our team is checking",
  // Owner wording is open (PRD-17, product review question 6).
  paid_confirmed_by_team: "Arranged by our team",
  completed: "Completed",
};

export function stateLabel(state: CustomerOrderState): string {
  return STATE_LABEL[state] ?? "Status unavailable";
}

/**
 * The tone of one item's state. The order's own tone comes from the
 * projection; items carry a state only, so they use this fallback.
 */
export function toneForState(state: CustomerOrderState): CustomerTone {
  switch (state) {
    case "confirmed":
    case "paid_confirmed_by_team":
      return "success";
    case "awaiting_payment":
    case "payment_processing":
    case "booking_processing":
    case "confirmed_ticket_pending":
    case "refund_processing":
    case "cancellation_processing":
      return "progress";
    case "partially_fulfilled":
    case "needs_attention":
      return "warning";
    case "payment_failed":
      return "danger";
    default:
      return "neutral";
  }
}

/* ---------------------------------------------------------------------------
 * Timeline
 * ------------------------------------------------------------------------ */

export const STEP_STATUS_TEXT: Record<StepStatus, string> = {
  not_started: "Not started",
  in_progress: "In progress",
  done: "Done",
  failed: "Did not complete",
  not_applicable: "Not needed",
};

export interface TimelineRow {
  key: "payment" | "booking" | "tickets" | "refund";
  title: string;
  step: CustomerStep;
  /** "Done", "In progress"…: the step's status as a word. */
  statusText: string;
}

const STEP_TITLES: Record<TimelineRow["key"], string> = {
  payment: "Payment",
  booking: "Booking with the operator",
  tickets: "Voucher",
  refund: "Refund",
};

/** Payment, booking and tickets in that order, then the refund row when one applies. */
export function timelineRows(steps: CustomerOrderStatus["steps"]): TimelineRow[] {
  const keys = ["payment", "booking", "tickets"] as const;
  const rows: TimelineRow[] = keys.map((key) => ({ key, title: STEP_TITLES[key], step: steps[key], statusText: STEP_STATUS_TEXT[steps[key].status] }));
  if (steps.refund) rows.push({ key: "refund", title: STEP_TITLES.refund, step: steps.refund, statusText: STEP_STATUS_TEXT[steps.refund.status] });
  return rows;
}

/* ---------------------------------------------------------------------------
 * Money
 * ------------------------------------------------------------------------ */

/**
 * A minor-unit decimal string in its currency: "₹12,345", "AED 560.50".
 * BigInt arithmetic, so no float rounding; an unreadable amount renders as an
 * empty string rather than a wrong figure.
 */
export function formatMinor(minor: string, currency: "INR" | "AED"): string {
  if (!/^-?\d+$/.test(minor)) return "";
  const value = BigInt(minor);
  const negative = value < 0n;
  const abs = negative ? -value : value;
  const major = abs / 100n;
  const fraction = abs % 100n;
  const locale = currency === "INR" ? "en-IN" : "en-AE";
  const whole = Number(major).toLocaleString(locale, { maximumFractionDigits: 0 });
  const text = fraction === 0n ? whole : `${whole}.${fraction.toString().padStart(2, "0")}`;
  const sign = negative ? "-" : "";
  return currency === "INR" ? `${sign}₹${text}` : `${sign}AED ${text}`;
}

/* ---------------------------------------------------------------------------
 * Tickets
 * ------------------------------------------------------------------------ */

const DOCUMENT_KIND: Record<CustomerDocument["kind"], string> = {
  tickets_pdf: "Tickets",
  voucher_pdf: "Voucher",
};

/**
 * Visible text of a download link. The file type and size are part of the
 * link's own text, so they are in its accessible name (criterion 5). When an
 * item has several files of one kind they are numbered; the contract carries
 * no per-guest or per-unit label, so none is invented.
 */
export function documentLinkText(doc: CustomerDocument, all: CustomerDocument[]): { name: string; file: string } {
  const same = all.filter((d) => d.kind === doc.kind);
  const position = same.indexOf(doc);
  const base = `Download ${DOCUMENT_KIND[doc.kind]?.toLowerCase() ?? "file"}`;
  const name = same.length > 1 ? `${base}, file ${position + 1} of ${same.length}` : base;
  return { name, file: describeFile(doc.contentType, doc.byteSize) };
}

/** Item states before the operator has answered: the voucher is still to come. */
const BEFORE_CONFIRMATION: CustomerOrderState[] = ["awaiting_payment", "payment_processing", "booking_processing"];

/**
 * One sentence on where the item's voucher stands (CO-02, CO-15). Never says
 * a file "will appear here" to a viewer who cannot download it, and never
 * says there are no files before the operator has confirmed.
 */
export function ticketStatusText(
  tickets: CustomerItemStatus["tickets"],
  itemState?: CustomerOrderState,
  canDownload = true,
): string {
  switch (tickets.fulfilment) {
    case "issued":
      if (tickets.documents.length) return "Your voucher is ready. Download it and keep it with you on the day.";
      return canDownload
        ? "Your voucher is being prepared. It appears here as soon as the file is ready."
        : "Your voucher is ready. To keep it private, confirm it's you.";
    case "ticket_pending":
      // An item can hold its own confirmed booking while the order is still settling (e2e, final run).
      if (itemState && BEFORE_CONFIRMATION.includes(itemState)) return "Your voucher will appear here once the operator confirms.";
      return "Booked. Your voucher is being prepared.";
    case "attention":
      return "We are having trouble getting your voucher from the operator. Our team has been alerted and is looking into it.";
    case "not_applicable":
    default:
      if (itemState && BEFORE_CONFIRMATION.includes(itemState)) return "Your voucher will appear here once the operator confirms.";
      if (itemState && !["confirmed", "paid_confirmed_by_team", "completed", "cancellation_processing"].includes(itemState)) return "There is no voucher for this activity.";
      return "There are no ticket files for this activity.";
  }
}

/** The items whose voucher is ready but hidden from this viewer (CO-02): they need the order-bound unlock. */
export function lockedVoucherItems(status: Pick<CustomerOrderStatus, "items" | "canDownload">): CustomerItemStatus[] {
  if (status.canDownload !== false) return [];
  return status.items.filter((i) => i.tickets.fulfilment === "issued" && i.tickets.documents.length === 0);
}

/** The items with a voucher this viewer can download now, in page order. */
export function downloadableItems(status: Pick<CustomerOrderStatus, "items">): CustomerItemStatus[] {
  return status.items.filter((i) => i.tickets.documents.length > 0);
}

/* ---------------------------------------------------------------------------
 * Cancellation
 * ------------------------------------------------------------------------ */

export const INELIGIBLE_REASON_TEXT: Record<CancellationIneligibleReason, string> = {
  past_deadline: "The free cancellation deadline for this booking has passed, so it cannot be cancelled for a refund online.",
  // The same words as the quote and the review step (CO-01, `freeCancellationCopy`).
  non_refundable: NON_REFUNDABLE_STATEMENT,
  tickets_issued: "These tickets are non-refundable once issued: the operator issues them as soon as the booking is confirmed, and they cannot be cancelled online.",
  activity_started: "This activity has already started or its date has passed.",
  not_supported: "This booking cannot be cancelled online.",
  payment_not_refundable: "A refund cannot be started online for this payment right now.",
};

export function ineligibleReasonText(reason: CancellationIneligibleReason): string {
  return INELIGIBLE_REASON_TEXT[reason] ?? "This booking cannot be cancelled online.";
}

/** Plain progress sentence for an existing request. Promises nothing beyond what the status says. */
export function cancellationProgressText(status: CancellationRequestStatus, requestKind: "supported" | "exception"): string {
  switch (status) {
    case "requested":
      return requestKind === "exception" ? "We have your request. Our team will look at it and reply." : "We have your cancellation request and are sending it to the operator.";
    case "cancelling":
      return "We are cancelling this booking with the operator.";
    case "cancel_unverified":
      return "We have asked the operator to cancel and are waiting for them to confirm it. Your booking stays as it is until they do.";
    case "refund_pending":
      return "The operator has cancelled this booking and your refund has been started.";
    case "refunded":
      return "The operator has cancelled this booking and your refund has been sent.";
    case "refused":
      return requestKind === "exception"
        ? "Our team looked at your request, and this booking cannot be cancelled under the operator's terms. Your booking stands."
        : "The operator did not accept the cancellation, so your booking stands.";
    case "refund_failed":
      return "The operator has cancelled this booking, but the refund did not go through. Our team has been alerted and will sort it out.";
    case "exception_open":
      return "Our team has your request and is looking at it.";
    case "exception_closed":
      return "Our team has finished looking at your request.";
    default:
      return "We have your request.";
  }
}

/** True when the panel is waiting on something that can still change by itself. */
export function cancellationIsOpen(view: CancellationView): boolean {
  if (view.kind !== "requested") return false;
  return ["requested", "cancelling", "cancel_unverified", "refund_pending", "exception_open"].includes(view.status);
}

/* ---------------------------------------------------------------------------
 * Live updates
 * ------------------------------------------------------------------------ */

/**
 * The polite announcement for a refresh, or null when there is nothing new
 * to say. One announcement per change of the order's state (criterion 3):
 * a refresh that only moves `updatedAt` stays silent.
 */
export function announcementFor(
  previous: Pick<CustomerOrderStatus, "state" | "headline"> & Partial<Pick<CustomerOrderStatus, "items">> | null,
  next: Pick<CustomerOrderStatus, "state" | "headline"> & Partial<Pick<CustomerOrderStatus, "items">>,
): string | null {
  if (!previous) return null;
  // New words are news, whether or not the state changed; a new state with the same words (payment →
  // booking, CO-14) stays silent.
  if (previous.headline !== next.headline) return `Status updated: ${next.headline}`;
  // Item-only news (CO-09, announced only): a voucher became ready for one item.
  const before = new Map((previous.items ?? []).map((i) => [i.orderItemId, i]));
  const ready = (next.items ?? []).filter((i) => {
    const was = before.get(i.orderItemId);
    return i.tickets.fulfilment === "issued" && was && was.tickets.fulfilment !== "issued";
  });
  if (ready.length === 1) return `${ready[0].title}: voucher ready.`;
  if (ready.length > 1) return `${ready.length} vouchers ready.`;
  return null;
}

/** Next refresh delay: the server's suggestion, doubled per consecutive failure, capped at a minute. */
export function nextPollDelay(pollAfterMs: number, failures: number): number {
  const base = Math.max(2_000, pollAfterMs);
  return Math.min(60_000, base * 2 ** Math.min(failures, 5));
}

/**
 * Back-off while nothing changes (checkout redesign batch 4, CO-09): the
 * server's cadence for the first two minutes after the page last saw a
 * change (or loaded), then at least 15 s, and after ten minutes at least
 * 30 s. A change resets it.
 */
export const QUIET_BACKOFF: ReadonlyArray<{ afterMs: number; atLeastMs: number }> = Object.freeze([
  { afterMs: 10 * 60_000, atLeastMs: 30_000 },
  { afterMs: 2 * 60_000, atLeastMs: 15_000 },
]);

/**
 * The refresh delay the status page uses: the server's `pollAfterMs`, raised
 * by `QUIET_BACKOFF` for how long nothing has changed, then doubled per
 * consecutive failure (`nextPollDelay`, capped at a minute). After a 429
 * it waits at least the server's `Retry-After`. `random` (0–1) adds up to
 * 20% jitter. The server decides whether to poll at all (null stops it);
 * this only ever slows it.
 */
export function pollDelay(pollAfterMs: number, failures: number, unchangedForMs: number, opts: { retryAfterMs?: number; random?: number } = {}): number {
  const floor = QUIET_BACKOFF.find((b) => unchangedForMs >= b.afterMs)?.atLeastMs ?? 0;
  const base = Math.max(nextPollDelay(Math.max(pollAfterMs, floor), failures), opts.retryAfterMs ?? 0);
  // Review fix 6: up to 20% later, never earlier, so tabs behind one address (shared NAT) do not poll in step.
  return Math.round(base * (1 + 0.2 * Math.min(1, Math.max(0, opts.random ?? 0))));
}

/** What the customer could see change: the state, the stamps and, per item, its state and vouchers. */
export function statusSignature(s: Pick<CustomerOrderStatus, "state" | "updatedAt" | "headline"> & Partial<Pick<CustomerOrderStatus, "items">>): string {
  const items = (s.items ?? []).map((i) => `${i.orderItemId}:${i.state}:${i.tickets.fulfilment}:${i.tickets.documents.map((d) => `${d.id}.${d.version}`).join(",")}`);
  return [s.state, s.updatedAt, s.headline, ...items].join("|");
}

/**
 * What the remedy deadline means, beside its time: the projection's own
 * sentence (`remedySentence`), so the box and the status text say the same
 * thing for a release, a refund and a multi-item order. Null when no remedy is named.
 */
export function remedyText(kind: "release" | "refund" | null, multi = false): string | null {
  return kind ? remedySentence("then", multi) : null;
}
