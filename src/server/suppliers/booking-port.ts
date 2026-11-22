/**
 * Booking-engine contracts frozen for B1a (doc 22 §24.2, first slice).
 *
 * This file is owned by the lead: change it only between batches. It is a
 * vocabulary, not a service, so it must not import "server-only", env, db or
 * the logger. The rest of §24.2 (the full SupplierBookingAdapter, quote and
 * capability types) is frozen at the start of B1 proper.
 */

import type { TicketEvidence } from "../documents/contracts";

/* ---------------------------------------------------------------------------
 * Duplicate guard
 * ------------------------------------------------------------------------ */

/**
 * The only states that release `sb_one_live_per_order_item`, so that another
 * attempt for the same order item becomes possible. Each one may be entered
 * only on the evidence named here (doc 22 §22.1 item 1a, SUP-3):
 *  - `not_created`: the request was never sent (local refusal or busy lane).
 *  - `rejected`: a documented definite rejection, never an undocumented 4xx.
 *  - `expired`: the supplier itself reports the hold timed out.
 *  - `cancelled`: a reread shows the supplier's cancelled status.
 * Every uncertain outcome uses a blocking state instead.
 */
export const GUARD_RELEASING_STATES = ["not_created", "rejected", "expired", "cancelled"] as const;

/** Blocking states added in B1a. They keep the order item locked against a second attempt. */
export const B1A_BLOCKING_STATES = [
  /** Reserved, waiting for provider-verified capture before any confirm (PAY-1). */
  "awaiting_payment",
  /** Request sent, nothing found by lookup yet; not proof that nothing was created. */
  "not_found_unresolved",
  /** Cancel answered or timed out, but the cancelled status is not yet confirmed by a reread. */
  "cancel_unverified",
] as const;

/* ---------------------------------------------------------------------------
 * Operator controls
 * ------------------------------------------------------------------------ */

/**
 * What a control blocks. `new_sales` stops intake, reserve and create, and lets
 * confirms of existing holds proceed inside their deadline. `all_writes` is the
 * emergency stop that also blocks confirm (holds then expire and remedies run).
 * Cancel, lookup, polling, the watchdog and recovery are never blocked (SUP-2).
 */
export type ControlScope = "new_sales" | "all_writes";

/** Settings key for one supplier account in one environment (SUP-10, SEC-9). */
export function bookingControlKeyFor(supplierCode: string, environment: "test" | "production", accountId: string): string {
  return `supplier_bookings.${supplierCode}.${environment}.${accountId}`;
}

/* ---------------------------------------------------------------------------
 * Confirmation evidence
 * ------------------------------------------------------------------------ */

/** What Outly asked for: the immutable identity a supplier answer must match exactly (SUP-1). */
export interface ExpectedBooking {
  clientRef: string;
  offerExternalId: string;
  tourExternalId: string;
  /** Literal service date, `YYYY-MM-DD`. */
  serviceDate: string;
  timeSlotId: string | null;
  startMinutes: number | null;
  adults: number;
  children: number;
  infants: number;
  expectedNetMinor: bigint;
}

/**
 * A supplier answer reduced to what the confirmation predicate reads. Every
 * field the supplier may omit is nullable here: absent means unknown, never
 * false or zero.
 */
export interface ConfirmationSnapshot {
  rawStatus: number;
  bookingReference: string | null;
  offerExternalId: string | null;
  tourExternalId: string | null;
  serviceDate: string | null;
  timeSlotId: string | null;
  startMinutes: number | null;
  adults: number | null;
  children: number | null;
  infants: number | null;
  /** The amount the supplier says it charged; null when it did not say. */
  chargedNetMinor: bigint | null;
  externalInProgress: boolean | null;
  externalFailed: boolean | null;
}

/** Why a snapshot did not count as confirmed. Any reason keeps the duplicate guard. */
export type ConfirmationFailure =
  | "status_not_final"
  | "flag_missing"
  | "external_pending"
  | "external_failed"
  | "reference_mismatch"
  | "identity_mismatch"
  | "amount_missing"
  | "amount_mismatch";

export type ConfirmationVerdict = { confirmed: true } | { confirmed: false; reasons: ConfirmationFailure[] };

/* ---------------------------------------------------------------------------
 * Payment evidence (PAY-1)
 * ------------------------------------------------------------------------ */

/** Provider-verified capture for one order-item allocation. Never inferred from a browser or a manual record. */
export interface PaymentEvidence {
  orderItemId: string;
  paymentId: string;
  provider: string;
  providerPaymentId: string;
  currency: "INR" | "AED";
  capturedMinor: bigint;
  verifiedAt: Date;
}

/** The only way the supplier engine learns that money was captured. */
export interface PaymentEvidencePort {
  capturedFor(orderItemId: string): Promise<PaymentEvidence | null>;
}

/** B1a stub: no gateway exists yet, so no customer intent can ever be confirmed. */
export const noPaymentEvidence: PaymentEvidencePort = {
  async capturedFor() {
    return null;
  },
};

/* ===========================================================================
 * B1 contracts (doc 22 §24.2, frozen at the start of B1 proper)
 * ======================================================================== */

/* ---------------------------------------------------------------------------
 * Supplier booking adapter: what the engine may ask of any booking supplier
 * ------------------------------------------------------------------------ */

/** Normalised booking status; OCTO vocabulary reused internally, plus UNKNOWN. */
export type SupplierStatus = "ON_HOLD" | "CONFIRMED" | "PENDING" | "EXPIRED" | "CANCELLED" | "REJECTED" | "UNKNOWN";

/** How the engine refers to a supplier booking. Date and offer let an adapter use a non-issuing list read. */
export interface SupplierRef {
  supplierBookingId: string;
  /** Literal service date, `YYYY-MM-DD`. */
  serviceDate: string;
  offerExternalId: string;
}

export interface SupplierSnapshot extends ConfirmationSnapshot {
  ref: string;
  status: SupplierStatus;
  /** Supplier hold expiry as a UTC instant, when the supplier gives one. */
  holdExpiresAtUtc: string | null;
  /** Whether admission codes have been issued; null when unknown. */
  ticketsIssued: boolean | null;
}

/**
 * `tickets` (B4, TKT-1): what a confirm or create answer said about admission
 * codes. It travels beside the snapshot, never inside it, because the
 * snapshot is stored as `lastResponse` and written to events. Absent means
 * the adapter does not parse ticket data.
 */
export type MutationOutcome =
  | { kind: "accepted"; snapshot: SupplierSnapshot; tickets?: TicketEvidence }
  | { kind: "rejected"; definite: true; code: string }
  /** `sent: false` means the request certainly never left Outly. */
  | { kind: "unknown"; sent: boolean; reason: string };

export type ReadOutcome = { kind: "found"; snapshot: SupplierSnapshot } | { kind: "not_found" } | { kind: "failed"; reason: string };

export type Tristate = "yes" | "no" | "unknown";

export interface BookingCapabilities {
  holds: false | { minutes: number };
  oneStep: boolean;
  clientRefLookup: "exact" | "list_scan" | "none";
  /** Milliseconds after which "not found" is final; null means never final. */
  notFoundFinalAfterMs: number | null;
  readIssuesTickets: Tristate;
  cancel: "full" | "none";
  documents: "pdf" | "codes" | "none";
}

/** Per-offer capability, from evidence; unknown is treated as yes for refund promises. */
export interface OfferCapabilities {
  issuesTicketsAtConfirm: Tristate;
}

export interface AttemptRequest {
  clientRef: string;
  expected: ExpectedBooking;
  /** Adapter-specific request body fields, already validated by the engine. */
  body: Record<string, unknown>;
}

export interface SupplierBookingAdapter {
  readonly supplierCode: string;
  readonly environment: "test" | "production";
  capabilities(): BookingCapabilities;
  /** The account the credentials act for; TravelDesk: `/balance` agencyId. */
  account(): Promise<{ accountId: string }>;
  hold?(a: AttemptRequest): Promise<MutationOutcome>;
  confirm?(ref: SupplierRef): Promise<MutationOutcome>;
  book?(a: AttemptRequest): Promise<MutationOutcome>;
  cancel?(ref: SupplierRef): Promise<MutationOutcome>;
  /** Must be side-effect free: never a read that can issue tickets (SUP-4). */
  readStatus(ref: SupplierRef): Promise<ReadOutcome>;
  findByClientRef(clientRef: string, hint: { serviceDate: string; offerExternalId: string }): Promise<{ matches: SupplierSnapshot[]; complete: boolean }>;
  /** Spendable funds: the lower of the candidates until Q-C1 is answered (SUP-10). */
  funds(): Promise<{ spendableMinor: bigint; currency: "AED"; accountId: string }>;
}

/* ---------------------------------------------------------------------------
 * Intent creation
 * ------------------------------------------------------------------------ */

/** How an order item came to exist. Only `instant_checkout` may ever create a supplier attempt (PRD-3). */
export type FulfilmentOrigin = "instant_checkout" | "assisted_conversion";

/**
 * Extra fields `createIntent(tx, input)` takes from B1 on. `quoteId` is null
 * until B2 builds quotes; from B2 a customer intent without a quote is refused.
 */
export interface IntentProvenance {
  fulfilmentOrigin: FulfilmentOrigin;
  quoteId: string | null;
}

/* ---------------------------------------------------------------------------
 * Privileged supplier operations (SEC-10, PRD-12)
 * ------------------------------------------------------------------------ */

/** Permissions added in B1. `suppliers.manage` stays as the mapping-review permission for existing grants. */
export const B1_PERMISSIONS = [
  "products.activate_instant",
  "suppliers.pause",
  "suppliers.resume",
  "suppliers.limits.raise",
  "suppliers.costs.view",
  "bookings.privileged_resolution",
  "payments.reconcile",
] as const;

/** Operations that need a recent second factor and, where marked, a second person. */
export type PrivilegedOperation =
  | "instant.activate"
  | "supplier.resume"
  | "supplier.limits.raise"
  | "booking.privileged_resolution"
  /** Switch a capability class flag on, or record per-offer enablement evidence (doc 29 §3.3, Batch 1a). */
  | "supplier.capability.enable";

/** Approval outcome: `pending` until a different staff member with the same permission approves. */
export type PrivilegedApproval =
  | { status: "applied"; approvalId: string }
  | { status: "pending"; approvalId: string; needs: "second_approver" }
  | { status: "refused"; reason: "step_up_required" | "same_person" | "expired" | "forbidden" };

/* ===========================================================================
 * B2 freeze: extensions B1 introduced as local types (doc 22 §32.3)
 * ======================================================================== */

/** `unknown` reason for a mutation answered by the supplier but not verified by a reread (SUP-13). */
export const ANSWERED_UNVERIFIED_REASON = "answered_unverified";

/** Optional: what the last HTTP call returned, used to measure supplier clock skew (SUP-21). */
export interface CallObserver {
  lastCall?(): { httpStatus: number | null; serverDate: string | null } | null;
}

/** Reconciliation reads a whole service-date window (SUP-12). */
export interface WindowLister {
  listWindow(q: { from: string; to: string }): Promise<{ snapshots: SupplierSnapshot[]; complete: boolean }>;
}
