/**
 * B5 frozen contract (doc 22 §23 B5, PRD-17, TKT-8, F1, F15, F23, F39, F51).
 *
 * The customer status projection is computed on the server only, from stored
 * provider-verified and supplier-verified state. No page infers success from
 * a URL, a query parameter or browser storage: a page that cannot load this
 * projection for an order the caller may see shows a neutral "find your
 * booking" state.
 *
 * This file is shared by the server (order-status.service.ts builds it) and
 * the browser (the status, confirmation, voucher and trips pages render it),
 * so it holds types and pure helpers only: no server imports, no secrets, no
 * supplier ids, no net costs, no ticket codes.
 *
 * Owner: the lead. Changed only between batches.
 */

/* ---------------------------------------------------------------------------
 * Projection
 * ------------------------------------------------------------------------ */

/** The one customer-facing state of an order (PRD-17). */
export type CustomerOrderState =
  /** A payment session is open; nothing has been taken. */
  | "awaiting_payment"
  /** Authorised or captured (or capture outcome unknown); the booking has not started. */
  | "payment_processing"
  /** Paid; reserving or confirming with the operator, or that outcome is still being checked. */
  | "booking_processing"
  /** Confirmed by the operator; tickets are still being obtained. */
  | "confirmed_ticket_pending"
  /** Confirmed, and every item's tickets are ready (or no tickets apply). */
  | "confirmed"
  /** Some items confirmed, others not (multi-item orders; deferred while question 1 is open). */
  | "partially_fulfilled"
  /** A held authorisation is being, or was, released: nothing was charged. */
  | "payment_released"
  /** A refund is open (requested, accepted or its outcome unknown). */
  | "refund_processing"
  /** Every refund owed has succeeded. */
  | "refunded"
  /** The payment did not go through and nothing was taken. */
  | "payment_failed"
  /** A customer cancellation was sent to the operator and is not yet verified. */
  | "cancellation_processing"
  /** Cancelled with the operator (status-4 verified) and nothing more is owed. */
  | "cancelled"
  /** Our team has been alerted and is looking; nothing is lost while they do. */
  | "needs_attention"
  /** A historic order our team arranged and recorded as paid (assisted rail). Owner wording is open (PRD-17). */
  | "paid_confirmed_by_team"
  /** The service date has passed. */
  | "completed";

export type CustomerTone = "success" | "progress" | "warning" | "danger" | "neutral";

/** One row of the status timeline. */
export type StepStatus = "not_started" | "in_progress" | "done" | "failed" | "not_applicable";

export interface CustomerStep {
  status: StepStatus;
  /** Plain-text label of this step's state, e.g. "Payment received". Never only a colour or icon (a11y criterion 4). */
  label: string;
  /** When the step reached its current status (UTC ISO), or null. */
  at: string | null;
}

/** A downloadable document as a customer may see it. No storage key, checksum, code or supplier URL. */
export interface CustomerDocument {
  id: string;
  /** tickets_pdf | voucher_pdf */
  kind: "tickets_pdf" | "voucher_pdf";
  version: number;
  contentType: string | null;
  byteSize: number | null;
  /** `/api/tickets/documents/<id>`: ownership is re-checked on every download. */
  href: string;
}

export type CancellationRequestStatus =
  | "requested"
  | "cancelling"
  | "cancel_unverified"
  | "refund_pending"
  | "refunded"
  | "refused"
  | "refund_failed"
  | "exception_open"
  | "exception_closed";

export type CancellationIneligibleReason =
  /** The free-cancellation deadline in the stored verified policy has passed. */
  | "past_deadline"
  /** The stored policy is non-refundable once confirmed, or offers no free cancellation. */
  | "non_refundable"
  /** The offer issues tickets at confirmation (`issuesTicketsAtConfirm` is `yes` or `unknown`): the operator cannot cancel issued tickets through the API. */
  | "tickets_issued"
  /** The activity has started or its date has passed. */
  | "activity_started"
  /** Not a self-serve instant booking (an assisted order, or no confirmed operator booking). */
  | "not_supported"
  /** Payment is not in a state a refund can be made from (for example a dispute froze refunds). */
  | "payment_not_refundable";

/** What the cancellation panel of one item shows. Never a promise beyond the stored policy. */
export type CancellationView =
  /** Nothing to offer yet (not confirmed, or already refunded). */
  | { kind: "none" }
  /** A supported self-serve cancellation: an engine cancel (status-4 verified) and then a refund through the payment saga. */
  | { kind: "eligible"; refundMinor: string; currency: "INR" | "AED"; untilUtc: string }
  /** Not cancellable by the customer. `exceptionAllowed` offers a request to our team, which promises nothing. */
  | { kind: "not_eligible"; reason: CancellationIneligibleReason; exceptionAllowed: boolean }
  /** A request exists: show its progress. */
  | { kind: "requested"; status: CancellationRequestStatus; requestKind: "supported" | "exception"; requestedAt: string; updatedAt: string };

export interface CustomerItemStatus {
  orderItemId: string;
  title: string;
  /** YYYY-MM-DD, the activity's local (Asia/Dubai) calendar day. */
  serviceDate: string;
  timeslot: string | null;
  /** e.g. "2 adults, 1 child". */
  paxLabel: string;
  state: CustomerOrderState;
  tickets: {
    /** TicketFulfilment (src/server/documents/contracts.ts). */
    fulfilment: "not_applicable" | "issued" | "ticket_pending" | "attention";
    documents: CustomerDocument[];
  };
  /** Full-refund cancellation deadline from the stored verified policy (quote snapshot), UTC ISO, or null when none. */
  refundUntilUtc: string | null;
  /**
   * The booking's one cancellation statement, in the quote's own words
   * (`freeCancellationCopy`, CO-01), from the stored policy snapshot; null
   * when no policy is stored (assisted orders) or the item is no longer live.
   */
  cancellationTerms?: string | null;
  cancellation: CancellationView;
}

export interface CustomerOrderStatus {
  reference: string;
  state: CustomerOrderState;
  tone: CustomerTone;
  /** One plain sentence: what is true now. */
  headline: string;
  /** One plain sentence: what happens next, or what the customer can do (a11y criterion 4). */
  nextStep: string;
  rail: "self_serve" | "assisted";
  currency: "INR" | "AED";
  /** Minor units of `currency`, as a string. */
  totalMinor: string;
  placedAt: string;
  updatedAt: string;
  steps: {
    payment: CustomerStep;
    booking: CustomerStep;
    tickets: CustomerStep;
    /** Null when no refund or release applies. */
    refund: CustomerStep | null;
  };
  deadlines: {
    /** The earliest item refund deadline still ahead, UTC ISO, or null. */
    refundUntilUtc: string | null;
    /**
     * TKT-8: the time by which, if the booking is still not confirmed, the
     * approved remedy (release or refund) runs automatically. Null when no
     * remedy is pending.
     */
    remedyAtUtc: string | null;
    /** What that remedy is, in customer words. */
    remedyKind: "release" | "refund" | null;
  };
  items: CustomerItemStatus[];
  /**
   * Whether this viewer may download the order's documents (the same access
   * decision that lists `documents`). Lets the page tell "voucher ready, confirm
   * it's you" apart from "file still being prepared" (CO-02). Says nothing new
   * about the order: an unauthorised viewer simply sees no documents.
   */
  canDownload?: boolean;
  /**
   * Whether this browser sees the order through something it can remove on
   * itself (a guest checkout session or a ticket-access cookie; not a signed-in
   * account): the page then offers "Remove access on this browser" (batch 3).
   */
  canRemoveBrowserAccess?: boolean;
  /** Suggested client refresh interval while the state can still change on its own; null when it will not. */
  pollAfterMs: number | null;
}

/* ---------------------------------------------------------------------------
 * HTTP contracts (all responses `private, no-store`, `no-referrer`)
 * ------------------------------------------------------------------------ */

/**
 * GET /api/orders/[reference]/status → 200 CustomerOrderStatus.
 * Anyone who may not see the order gets the same 404 `{ error: { code: "NOT_FOUND" } }`.
 *
 * Who may see an order (order-access.service.ts):
 *  - the signed-in customer whose `orders.customer_id` it is (never a phone match, TKT-4);
 *  - the guest session that created the order's quote (the same browser after the gateway's return);
 *  - a live ticket-access grant for this order (`view_status` or `download_tickets`), from the
 *    `/t` exchange or a recovery challenge. One browser may hold grants for several orders.
 */
export const ORDER_STATUS_PATH = (reference: string) => `/api/orders/${encodeURIComponent(reference)}/status`;

/**
 * POST /api/orders/[reference]/cancellation `{ orderItemId, kind: "cancel" | "exception" }`
 * → 202 `{ status: CancellationRequestStatus }`, 409 `{ error: { code: "NOT_ELIGIBLE", reason } }`, or the uniform 404.
 * Same-origin JSON. Idempotent per order item: a repeat returns the open request.
 */
export const ORDER_CANCELLATION_PATH = (reference: string) => `/api/orders/${encodeURIComponent(reference)}/cancellation`;

/**
 * POST /api/recovery/start `{ reference, channel: "phone" | "email", contact }` → 200 `{ challengeId }` always.
 * A code is sent only when the contact matches the order's bound, verified contact
 * (`order_contact_verifications` with an `order_id`); otherwise a decoy id and nothing is sent.
 *
 * POST /api/recovery/verify `{ challengeId, code }` → 200 `{ reference }` and a ticket-access grant
 * for that order added to the browser; every failure is the same 400 `{ error: { code: "CODE_INVALID" } }`.
 * Rate limits fail closed (per IP, per reference, per contact, global).
 */
export const RECOVERY_START_PATH = "/api/recovery/start";
export const RECOVERY_VERIFY_PATH = "/api/recovery/verify";

/**
 * POST /api/tickets/exchange `{ token }` → 200 `{ ok, purpose, expiresAt, reference }` (B5 adds `reference`).
 * The `/t` page posts the URL-fragment token only after a deliberate click.
 */
export const TICKET_EXCHANGE_PATH = "/api/tickets/exchange";
/** POST, same-origin, no body: "Remove access on this browser" (checkout redesign batch 3). Always `{ ok: true }`. */
export const TICKET_REMOVE_ACCESS_PATH = "/api/tickets/remove-access";

/* ---------------------------------------------------------------------------
 * Private customer routes (sitemap, robots, headers, analytics)
 * ------------------------------------------------------------------------ */

/**
 * Pages that show or lead to one customer's order. Every response on these
 * paths carries `Cache-Control: private, no-store`, `Referrer-Policy:
 * no-referrer` and `X-Robots-Tag: noindex, nofollow`; they are absent from
 * the sitemap, disallowed in robots, and excluded from GA4, PageView and
 * attribution landing capture (PRV-4, TKT-5).
 *
 * A path matches when it equals a prefix or starts with `prefix + "/"`.
 */
export const PRIVATE_CUSTOMER_ROUTE_PREFIXES: readonly string[] = Object.freeze([
  "/t",
  "/booking",
  "/manage-booking",
  "/voucher",
  "/api/orders",
  "/api/recovery",
  "/api/tickets",
]);

export function isPrivateCustomerPath(pathname: string): boolean {
  return PRIVATE_CUSTOMER_ROUTE_PREFIXES.some((p) => pathname === p || pathname.startsWith(`${p}/`));
}

/* ---------------------------------------------------------------------------
 * Time display (a11y criterion 4, TKT-8): Asia/Dubai plus UTC, exact
 * ------------------------------------------------------------------------ */

const DUBAI = "Asia/Dubai";

function parts(d: Date, timeZone: string): Record<string, string> {
  const out: Record<string, string> = {};
  const f = new Intl.DateTimeFormat("en-GB", { timeZone, weekday: "short", day: "numeric", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit", hourCycle: "h23" });
  for (const p of f.formatToParts(d)) if (p.type !== "literal") out[p.type] = p.value;
  return out;
}

/**
 * e.g. "Sat 7 Nov 2026, 18:00 Dubai time (14:00 UTC)"; the UTC part names its
 * own day when it differs ("Sun 8 Nov 2026, 02:30 Dubai time (22:30 UTC, 7 Nov)").
 * Deterministic: en-GB names, 24-hour clock.
 */
export function formatDubaiAndUtc(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  const a = parts(d, DUBAI);
  const u = parts(d, "UTC");
  const utcDay = a.day === u.day && a.month === u.month ? "" : `, ${u.day} ${u.month}`;
  return `${a.weekday} ${a.day} ${a.month} ${a.year}, ${a.hour}:${a.minute} Dubai time (${u.hour}:${u.minute} UTC${utcDay})`;
}

/** Machine-readable value for a `<time dateTime>` attribute. */
export function isoForTimeElement(iso: string): string {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? "" : d.toISOString();
}

/** "PDF, 1.2 MB" for a download's accessible name (a11y criterion 5). */
export function describeFile(contentType: string | null, byteSize: number | null): string {
  const type = contentType === "application/pdf" ? "PDF" : contentType ? contentType.split("/").pop()!.toUpperCase() : "File";
  if (byteSize === null || byteSize < 0) return type;
  if (byteSize < 1024) return `${type}, ${byteSize} bytes`;
  if (byteSize < 1024 * 1024) return `${type}, ${Math.round(byteSize / 1024)} KB`;
  return `${type}, ${(byteSize / (1024 * 1024)).toFixed(1)} MB`;
}

/**
 * The one remedy sentence (TKT-8; checkout redesign CO-05), shared by the
 * projection's next step and the status page's Deadline box so they never
 * disagree. True for a released hold and a refund alike. `by` is the
 * formatted remedy time, "then" when the time is shown beside it, or null
 * when none is known.
 */
export function remedySentence(by: string | null, multi: boolean): string {
  if (multi) {
    return by
      ? `If the operator hasn't confirmed an activity by ${by}, you get its amount back automatically.`
      : "If the operator can't confirm an activity, you get its amount back automatically.";
  }
  return by
    ? `If the operator hasn't confirmed your booking by ${by}, you get the full amount back automatically, as a released hold or a refund.`
    : "If the operator can't confirm your booking, you get the full amount back automatically, as a released hold or a refund.";
}
