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

/**
 * Payment, booking and tickets in that order, then the refund row when one applies.
 * Post-payment A7: the tickets row is named for what the order's files are (`orderDocumentWord`).
 */
export function timelineRows(steps: CustomerOrderStatus["steps"], word: OrderDocumentWord = "voucher"): TimelineRow[] {
  const keys = ["payment", "booking", "tickets"] as const;
  const title = (key: (typeof keys)[number]) => (key === "tickets" ? capitalise(ORDER_WORD[word].noun) : STEP_TITLES[key]);
  const rows: TimelineRow[] = keys.map((key) => ({ key, title: title(key), step: steps[key], statusText: STEP_STATUS_TEXT[steps[key].status] }));
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
 * Tickets or voucher (post-payment A7)
 * ------------------------------------------------------------------------ */

/** What one item's entry document is called. */
export type DocumentWord = "tickets" | "voucher";
/** What an order's documents are called, together ("vouchers": several voucher items). */
export type OrderDocumentWord = DocumentWord | "vouchers" | "mixed";

/**
 * "tickets" or "voucher" for one item, from what the projection says: the
 * kind of its listed files first; then, when none is listed to this viewer
 * (not ready yet, or locked), an open-dated ticket item (`ticket`) is
 * tickets. Everything else keeps the established word, voucher.
 */
export function documentWord(item: Pick<CustomerItemStatus, "tickets" | "ticket">): DocumentWord {
  const docs = item.tickets.documents;
  if (docs.length > 0) return docs.every((d) => d.kind === "tickets_pdf") ? "tickets" : "voucher";
  return item.ticket ? "tickets" : "voucher";
}

/** The order's word: one word when every item agrees (plural for several vouchers), "mixed" otherwise. No items reads as voucher. */
export function orderDocumentWord(items: ReadonlyArray<Pick<CustomerItemStatus, "tickets" | "ticket">>): OrderDocumentWord {
  const words = new Set(items.map(documentWord));
  if (words.size > 1) return "mixed";
  if (words.has("tickets")) return "tickets";
  return items.length > 1 ? "vouchers" : "voucher";
}

/** Grammar per word: "Your tickets are ready" / "Your voucher is ready". */
export const ORDER_WORD: Record<OrderDocumentWord, { noun: string; is: "is" | "are"; it: "it" | "them" }> = {
  tickets: { noun: "tickets", is: "are", it: "them" },
  voucher: { noun: "voucher", is: "is", it: "it" },
  vouchers: { noun: "vouchers", is: "are", it: "them" },
  mixed: { noun: "tickets and vouchers", is: "are", it: "them" },
};

function capitalise(text: string): string {
  return text ? `${text.charAt(0).toUpperCase()}${text.slice(1)}` : text;
}

/** "Tickets" / "Voucher": an item's own heading. */
export function documentHeading(word: OrderDocumentWord): string {
  return capitalise(ORDER_WORD[word].noun);
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
  word: DocumentWord = "voucher",
): string {
  const { noun, is, it } = ORDER_WORD[word];
  switch (tickets.fulfilment) {
    case "issued":
      if (tickets.documents.length) return `Your ${noun} ${is} ready. Download ${it} and keep ${it} with you on the day.`;
      return canDownload
        ? `Your ${noun} ${is} being prepared. ${word === "tickets" ? "They appear" : "It appears"} here as soon as the file is ready.`
        : `Your ${noun} ${is} ready. To keep ${it} private, confirm it's you.`;
    case "ticket_pending":
      // An item can hold its own confirmed booking while the order is still settling (e2e, final run).
      if (itemState && BEFORE_CONFIRMATION.includes(itemState)) return `Your ${noun} will appear here once the operator confirms.`;
      return `Booked. Your ${noun} ${is} being prepared.`;
    case "attention":
      return `We are having trouble getting your ${noun} from the operator. Our team has been alerted and is looking into it.`;
    case "not_applicable":
    default:
      if (itemState && BEFORE_CONFIRMATION.includes(itemState)) return `Your ${noun} will appear here once the operator confirms.`;
      if (itemState && !["confirmed", "paid_confirmed_by_team", "completed", "cancellation_processing"].includes(itemState)) return `There ${word === "tickets" ? "are no tickets" : "is no voucher"} for this activity.`;
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
  if (ready.length === 1) return `${ready[0].title}: ${ORDER_WORD[documentWord(ready[0])].noun} ready.`;
  if (ready.length > 1) {
    return `${capitalise(ORDER_WORD[orderDocumentWord(ready)].noun)} ready for ${ready.length} activities.`;
  }
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

/* ---------------------------------------------------------------------------
 * Progress while waiting (post-payment A6)
 * ------------------------------------------------------------------------ */

/** The order states while the booking is still on its way: the progress card shows in these. */
export const IN_FLIGHT_STATES: readonly CustomerOrderState[] = Object.freeze([
  "awaiting_payment",
  "payment_processing",
  "booking_processing",
  "confirmed_ticket_pending",
]);

/** An item the operator has confirmed: its own ticket card shows (post-payment A5). */
export const BOOKED_ITEM_STATES: readonly CustomerOrderState[] = Object.freeze(["confirmed_ticket_pending", "confirmed"]);

export type MilestoneState = "done" | "current" | "waiting" | "failed" | "skipped";

export interface Milestone {
  key: "payment" | "operator" | "tickets";
  /** What this milestone is, in its state: "Checking your payment", "Payment received". */
  title: string;
  state: MilestoneState;
  /** The state in words, never colour alone (criterion 4). */
  stateText: string;
  /** One more fact from the projection (the server's step label, or "1 of 2 activities confirmed"), or null. */
  detail: string | null;
  /** When it happened (UTC ISO), only once done; null otherwise. */
  at: string | null;
}

const MILESTONE_STATE_TEXT: Record<MilestoneState, string> = {
  done: "Done",
  current: "In progress",
  waiting: "Waiting",
  failed: "Did not complete",
  skipped: "Not needed",
};

function milestoneState(status: StepStatus): MilestoneState {
  switch (status) {
    case "done":
      return "done";
    case "in_progress":
      return "current";
    case "failed":
      return "failed";
    case "not_applicable":
      return "skipped";
    default:
      return "waiting";
  }
}

/**
 * The progress card's rows, from the projection's own steps and nothing else
 * (no percentage, countdown or estimate: none has a true source, 20-status-ui
 * §3.3). Payment, operator confirmation and tickets, for one item and for
 * several alike (a multi-item order keeps its payment row). The first row not
 * yet done is the current one; a time is shown only for a row that is done.
 */
export function progressMilestones(status: Pick<CustomerOrderStatus, "steps" | "items">): Milestone[] {
  const { payment, booking, tickets } = status.steps;
  const noun = ORDER_WORD[orderDocumentWord(status.items)].noun;
  const Noun = capitalise(noun);
  const multi = status.items.length > 1;

  // Only one row is "current": the first that is in progress. A later in-progress row waits behind it.
  const states = [payment, booking, tickets].map((step) => milestoneState(step.status));
  const first = states.indexOf("current");
  const [pay, op, tk] = states.map((st, i) => (st === "current" && i !== first ? "waiting" : st)) as [MilestoneState, MilestoneState, MilestoneState];

  const booked = status.items.filter((i) => BOOKED_ITEM_STATES.includes(i.state) || i.state === "completed").length;
  const operatorDetail =
    multi && op !== "done" && booked > 0 ? `${booked} of ${status.items.length} activities confirmed` : booking.label || null;

  const row = (key: Milestone["key"], state: MilestoneState, title: string, detail: string | null, at: string | null): Milestone => ({
    key,
    title,
    state,
    stateText: MILESTONE_STATE_TEXT[state],
    // The server's step label, unless it only repeats the title.
    detail: detail && detail.trim().toLowerCase() !== title.toLowerCase() ? detail : null,
    at: state === "done" ? at : null,
  });
  // Titles are neutral until done, so a row never reads as done when it is not (review fix 3).
  return [
    row("payment", pay, pay === "done" ? "Payment received" : pay === "failed" ? "Payment did not go through" : "Checking your payment", payment.label || null, payment.at),
    row("operator", op, op === "done" ? "Confirmed by the operator" : "Operator confirmation", operatorDetail, booking.at),
    row(
      "tickets",
      tk,
      tk === "done" ? `${Noun} ready` : tk === "skipped" ? `No ${noun} needed` : tk === "current" ? `Getting your ${noun}` : Noun,
      tickets.label || null,
      tickets.at,
    ),
  ];
}

/** The milestone the order is on now, or null when every row is settled. */
export function currentMilestone(rows: readonly Milestone[]): Milestone | null {
  return rows.find((r) => r.state === "current") ?? rows.find((r) => r.state === "waiting") ?? null;
}

/* ---------------------------------------------------------------------------
 * Ticket email (post-payment A3, A4)
 * ------------------------------------------------------------------------ */

/** "14:43" in Dubai time, or "" for an unreadable instant. */
export function dubaiClock(iso: string): string {
  const ms = Date.parse(iso);
  if (!Number.isFinite(ms)) return "";
  return new Intl.DateTimeFormat("en-GB", { timeZone: "Asia/Dubai", hour: "2-digit", minute: "2-digit", hour12: false }).format(new Date(ms));
}

export interface DeliveryText {
  /** The one sentence on where the ticket email stands, in the recorded state's own word. */
  line: string;
  /** What the customer can do now, or null. */
  next: string | null;
  tone: "success" | "info" | "warning";
}

/**
 * Words for `status.delivery` (contract: `TicketDeliveryView`). "Sent" means
 * the provider accepted the message; "delivered" is said only for the
 * `delivered` state, which comes from a verified provider event. A failure or
 * bounce never hides the files: it says where they are on this page.
 */
export function deliveryText(
  delivery: { state: "pending" | "sent" | "delivered" | "failed" | "bounced"; recipientMasked: string | null },
  word: OrderDocumentWord,
  canDownload: boolean,
): DeliveryText {
  const { noun, is } = ORDER_WORD[word];
  const Noun = capitalise(noun);
  const to = delivery.recipientMasked ? ` to ${delivery.recipientMasked}` : "";
  const here = canDownload ? `You can download ${ORDER_WORD[word].it} on this page.` : `Confirm it's you on this page to download ${ORDER_WORD[word].it}.`;
  switch (delivery.state) {
    case "delivered":
      return { line: `${Noun} delivered${to}.`, next: null, tone: "success" };
    case "sent":
      return { line: `${Noun} sent${to}.`, next: "If it isn't in your inbox, check your spam folder.", tone: "success" };
    case "pending":
      return { line: `We're emailing your ${noun}${to}.`, next: `It can take a few minutes. ${here}`, tone: "info" };
    case "failed":
      return { line: `We couldn't email your ${noun}${to}. Our team has been alerted.`, next: here, tone: "warning" };
    case "bounced":
      return {
        line: `The email with your ${noun} couldn't be delivered${to}: the address rejected it.`,
        next: `${here} To use another address, message us.`,
        tone: "warning",
      };
    default:
      return { line: `Your ${noun} ${is} on this page.`, next: null, tone: "info" };
  }
}

function dubaiDay(ms: number): string {
  return new Intl.DateTimeFormat("en-GB", { timeZone: "Asia/Dubai", weekday: "short", day: "numeric", month: "short" }).format(new Date(ms)).replace(",", "");
}

/**
 * The resend button's wait, in words: "You can ask again at 14:52 Dubai time.",
 * naming the day when it is not today in Dubai (the 24-hour limit can move it
 * to tomorrow): "You can ask again on Wed 2 Jan at 13:12 Dubai time."
 */
export function resendWaitText(availableAtIso: string | null, nowMs: number = Date.now()): string {
  const clock = availableAtIso ? dubaiClock(availableAtIso) : "";
  if (!availableAtIso || !clock) return "You can ask again a little later.";
  const at = Date.parse(availableAtIso);
  const day = dubaiDay(at);
  return day === dubaiDay(nowMs) ? `You can ask again at ${clock} Dubai time.` : `You can ask again on ${day} at ${clock} Dubai time.`;
}

/**
 * The days of several activities, short: one day as "Tue 15 Jan 2030", two as
 * "Fri 11 Jan and Tue 15 Jan 2030", more as a span "Fri 11 Jan to Tue 15 Jan
 * 2030" (the progress card's label; each activity's own day is in its row
 * below). Calendar days (YYYY-MM-DD, Dubai); unreadable keys are skipped.
 */
export function dateSpanText(dateKeys: readonly string[]): string {
  const days = [...new Set(dateKeys.filter((k) => /^\d{4}-\d{2}-\d{2}$/.test(k)))].sort();
  if (days.length === 0) return "";
  const fmt = (k: string, year: boolean) =>
    new Intl.DateTimeFormat("en-GB", { timeZone: "UTC", weekday: "short", day: "numeric", month: "short", ...(year ? { year: "numeric" } : {}) })
      .format(new Date(`${k}T00:00:00Z`))
      .replace(",", "");
  const first = days[0];
  const last = days[days.length - 1];
  if (days.length === 1) return fmt(first, true);
  const sameYear = first.slice(0, 4) === last.slice(0, 4);
  return `${fmt(first, !sameYear)} ${days.length === 2 ? "and" : "to"} ${fmt(last, true)}`;
}
