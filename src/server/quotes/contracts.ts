/**
 * B2 contracts: readiness, typed units, server quotes and order-bound contact
 * verification (doc 22 §23 B2, §22.1 items 3–4).
 *
 * Owned by the lead; change only between batches. A vocabulary, not a
 * service: no "server-only", env, db or logger imports.
 */

import type { Currency, Money } from "@/lib/types";

/* ---------------------------------------------------------------------------
 * Policies that wait for an owner answer (doc 22 §29). Each default is the
 * conservative one: the affected cart or product stays an unpaid inquiry.
 * ------------------------------------------------------------------------ */

/**
 * Question 1, answered by the owner on 3 November 2026 (doc 22 §32.16): a cart
 * whose activities are all instant-eligible books instantly, as one order. A
 * mixed cart still goes to inquiry as a whole. Multi-item, lead-approved 3 Nov 2026.
 */
export const MULTI_INSTANT_ITEM_POLICY: "inquiry" | "allow" = "allow";
/**
 * Hard cap on instant items in one order (lead design, 3 November 2026). A cart
 * with more goes to inquiry. The per-quote line ceiling (`QUOTE_MAX_LINES`)
 * still applies first. Multi-item, lead-approved 3 Nov 2026.
 */
export const MAX_INSTANT_ITEMS_PER_ORDER = 5;

/**
 * The one key that makes two instant lines "the same line": product, variant,
 * Dubai date and slot. The quote service sends a cart that repeats a key to
 * inquiry; checkout refuses a stored quote that does. Multi-item,
 * lead-approved 3 Nov 2026.
 */
export function instantLineKey(l: { productId: string; variantId: string; serviceDate: string; slotRef: string | null }): string {
  return `${l.productId}|${l.variantId}|${l.serviceDate}|${l.slotRef ?? ""}`;
}

/** Whether two of these lines share `instantLineKey`. */
export function repeatsInstantLine(lines: ReadonlyArray<Parameters<typeof instantLineKey>[0]>): boolean {
  return new Set(lines.map(instantLineKey)).size !== lines.length;
}
/**
 * Question 3, answered by the owner on 3 November 2026 (doc 22 §32.16): a
 * same-day slot is bookable instantly when the supplier offers it. Its cutoff
 * (`MIN_PAYMENT_WINDOW_MS` before the supplier's) and readiness still apply.
 * Multi-item, lead-approved 3 Nov 2026.
 */
export const SAME_DAY_INSTANT_POLICY: "inquiry" | "allow" = "allow";
/**
 * Question 4: when tickets may issue at confirmation (yes or unknown), a product
 * may be instant only if its displayed policy is "non-refundable once
 * confirmed". A more generous displayed policy keeps it inquiry.
 */
export const ISSUED_TICKET_REFUND_POLICY: "non_refundable_after_confirm_only" = "non_refundable_after_confirm_only";

/** A quote lives at most ten minutes (Part I §7). */
export const QUOTE_TTL_MS = 10 * 60_000;

/* ---------------------------------------------------------------------------
 * Typed units (PRD-7). Stored per variant in product content; optional for
 * inquiry products, required for instant ones. Prices are authored major units
 * like the rest of the content; the quote converts them exactly.
 * ------------------------------------------------------------------------ */

export interface UnitDefinition {
  unitId: string;
  label: string;
  /** `person` counts guests; `booking` is one per booking (a private car, a table). */
  per: "person" | "booking";
  /** Inclusive age range in whole years on the service date; null means no limit. */
  ageMin: number | null;
  ageMax: number | null;
  residency: "any" | "uae_resident" | "non_resident";
  heightMinCm: number | null;
  heightMaxCm: number | null;
  /** Whether the unit takes a seat in supplier capacity. */
  seatConsuming: boolean;
  minQty: number;
  maxQty: number;
  /** Authored selling price; never derived from supplier net or another currency. */
  price: Money;
  /** The supplier's unit this maps to (TravelDesk: adult, child, infant, trip). */
  supplierUnit: string;
}

/* ---------------------------------------------------------------------------
 * Readiness (one function for activation, storefront, quote and worker send)
 * ------------------------------------------------------------------------ */

export type ReadinessReason =
  | "release_switch_off"
  | "not_published"
  | "combo"
  | "editorial_confirmation_not_instant"
  | "variant_without_mapping"
  | "mapping_inactive"
  | "mapping_changed_upstream"
  | "mapping_missing_upstream"
  | "units_missing"
  | "unit_not_mapped"
  | "slot_rules_unknown"
  /** The page's start times are not exactly the mapped offer's stored slot starts (doc 29 Batch 0). */
  | "slot_times_mismatch"
  /** The mapped offer has an "any time" slot: a guest-chosen time is not supported yet (doc 29 Batch 0, Batch 2). */
  | "slot_any_time_unsupported"
  | "safety_fact_unknown"
  | "unit_price_mismatch"
  | "margin_below_floor"
  | "policy_exceeds_supplier"
  | "capability_not_ready"
  /** The supplier catalogue the verdict reads is older than the staleness limit, or of unknown age (doc 29 Batch 1b). */
  | "catalogue_stale"
  /** An imported TravelDesk inquiry listing (doc 30 D4): never-instant options, so it never sells instant (review 106 N1-06). */
  | "inquiry_listing";

export interface ReadinessResult {
  productId: string;
  /** What the editor asked for. */
  requested: "instant" | "inquiry";
  /** What the storefront and checkout may offer. */
  effective: "instant" | "inquiry";
  reasons: ReadinessReason[];
  readinessVersion: number;
  evaluatedAt: string;
}

/* ---------------------------------------------------------------------------
 * Quotes
 * ------------------------------------------------------------------------ */

export interface QuoteLineRequest {
  productId: string;
  variantId: string;
  /** Literal service date in Asia/Dubai, `YYYY-MM-DD`. */
  serviceDate: string;
  slotRef: string | null;
  units: Record<string, number>;
  addonIds: string[];
  pickup: { hotelRef: string } | null;
  /**
   * The child and infant band edges the guest picker showed when the guests
   * were chosen (doc 30 N4, review 102 N4-01): the oldest child and the oldest
   * infant, whole years. Optional: carts written before N4 carry none and are
   * not checked. When given and no longer the variant's bands, the line is
   * refused `ages_changed`.
   */
  ages?: { childMax: number; infantMax: number };
}

export interface QuoteRequest {
  lines: QuoteLineRequest[];
  currency: Currency;
  couponCode: string | null;
}

export type QuoteRefusalReason =
  | "requires_inquiry"
  | "multi_instant_inquiry"
  | "same_day_inquiry_only"
  | "not_published"
  | "unknown_variant"
  | "unknown_unit"
  | "unit_rule_failed"
  /** Doc 30 N4 (review 102 N4-01): the option's child or infant ages changed after the guests were chosen against them. */
  | "ages_changed"
  | "unknown_addon"
  | "pickup_unavailable"
  | "coupon_not_available_in_currency"
  | "invalid_slot"
  | "past_cutoff"
  | "closed"
  | "sold_out"
  /** Doc 29 §3.5 (review 86 B5-03): the open-dated tickets in stock stop being valid before the visit date. */
  | "ticket_validity_ended"
  | "availability_unknown"
  | "margin_below_floor"
  | "policy_exceeds_supplier"
  | "supplier_unavailable"
  /** The whole order is over the per-order instant cap, or the cap cannot be checked (doc 22 §32.24). Private: shown as `requires_inquiry`. */
  | "order_over_limit";

export interface QuoteRefusal {
  ok: false;
  /** Per line, so the client can say which item needs a quick check. */
  lines: Array<{ index: number; reason: QuoteRefusalReason }>;
}

export interface MarginSnapshot {
  policyVersion: number;
  floorBps: number;
  grossMarginBps: number;
  /** Named cost lines used, minor units of the charged currency. Values come from approved inputs only. */
  costLines: Array<{ name: string; minor: bigint }>;
  /** The FX input used for an INR line (settings version, rate, source); null for AED lines. */
  fx?: { version: number; inrPerAed: string; source: string } | null;
  /** The recorded cost-input row used (version and source); absent rows refuse the quote, never count as zero. */
  costInputs?: { version: number; source: string };
}

export interface QuoteLineSnapshot {
  index: number;
  productId: string;
  /** `products.version` of the content priced; null when the row carries none. */
  productVersion: number | null;
  variantId: string;
  mappingId: string;
  /** The mapping revision: the offer terms the reviewer approved. */
  approvedOfferHash: string;
  /** The supplier environment the mapping and the check belong to. */
  supplierEnvironment: "test" | "production" | null;
  readinessRulesVersion: number;
  serviceDate: string;
  slotRef: string | null;
  units: Record<string, number>;
  /** The unit definitions priced, with their authored prices and restrictions. */
  unitDefinitions: UnitDefinition[];
  addonIds: string[];
  /**
   * The pickup the supplier check accepted, or null when the line has none.
   * `hotelName` is the name on the supplier's list at quote time (Batch 3),
   * kept as the order item's display snapshot; absent on older quotes.
   */
  pickup: { hotelRef: string; hotelName?: string | null } | null;
  chargedMinor: bigint;
  discountAllocMinor: bigint;
  taxAllocMinor: bigint;
  supplierNetAedMinor: bigint;
  /** The supplier's USD figure for the same net, when given; the booking request carries it (SUP-24). */
  supplierNetUsdMinor?: bigint | null;
  supplierCheckedAt: string;
  margin: MarginSnapshot;
  /** UTC instant until which the customer may cancel for a full refund, or null when none is offered. */
  freeCancellationUntilUtc: string | null;
  nonRefundableAfterConfirm: boolean;
  /** TicketOnly: last day the ticket can be used (Asia/Dubai, YYYY-MM-DD), when the supplier gives one. */
  ticketValidUntil?: string | null;
  /** Doc 29 Batch 5: the line is an open-dated ticket (non-refundable once issued); absent on other lines and older quotes. */
  openDatedTicket?: boolean;
  /** Doc 29 Batch 6: the line is booked through an external supplier (confirmation can take minutes); absent otherwise. */
  externalConfirmation?: boolean;
  /**
   * Doc 29 Batch 7: a date-only line. The availability row the supplier check accepted (`timeSlotId`,
   * start and end in minutes after Dubai midnight), which the booking sends exactly. Absent otherwise.
   */
  availabilitySlot?: { timeSlotId: number; startMinutes: number; endMinutes: number };
}

export interface QuoteSnapshot {
  ok: true;
  quoteId: string;
  /** sha256 over the canonical request and owner; a replay with different content is a conflict. */
  fingerprint: string;
  owner: { kind: "customer"; customerId: string } | { kind: "guest"; guestSessionId: string };
  currency: Currency;
  /** Canonical coupon code applied, or null. */
  couponCode: string | null;
  totalMinor: bigint;
  lines: QuoteLineSnapshot[];
  /** At most `QUOTE_TTL_MS` after creation, and never after the earliest supplier cutoff. */
  expiresAt: string;
}

export type QuoteResult = QuoteSnapshot | QuoteRefusal;

/* ---------------------------------------------------------------------------
 * Order-bound recovery contact (TKT-4)
 * ------------------------------------------------------------------------ */

/**
 * Proof that the person checking out controls one contact, bound to a quote
 * and then to the order. Verifying never creates a customer account; linking
 * to an account is a separate explicit step.
 */
export interface ContactVerification {
  verificationId: string;
  quoteId: string;
  channel: "phone" | "email";
  /** sha256 of the normalised contact; the contact itself lives on the order. */
  contactHash: string;
  method: "otp_sms" | "otp_whatsapp" | "email_code";
  verifiedAt: string;
}

/* ---------------------------------------------------------------------------
 * Margin policy (PAY-11). Versioned settings; never a code constant.
 * ------------------------------------------------------------------------ */

export interface MarginPolicy {
  version: number;
  /** Basis points of selling price after the named variable costs. Provisional 1,500. */
  floorBps: number;
  effectiveFrom: string;
}

export const MARGIN_POLICY_SETTING_KEY = "pricing.margin_policy";

/* ---------------------------------------------------------------------------
 * B2 service seams (frozen so the three B2 owners can work in parallel)
 * ------------------------------------------------------------------------ */

/** Halyard: `src/server/services/supplier-quote.service.ts`. Fresh, uncached supplier check for one line. */
export type SupplierQuoteResult =
  | {
      ok: true;
      slotRef: string | null;
      netAedMinor: bigint;
      /** The supplier's USD figure for the same net, when it gives one (SUP-24). */
      netUsdMinor: bigint | null;
      checkedAt: string;
      capacity: "limited" | "unlimited" | "unknown";
      seatsLeft: number | null;
      /** Supplier cutoff for this slot as a UTC instant, when known. */
      cutoffUtc: string | null;
      issuesTicketsAtConfirm: "yes" | "no" | "unknown";
      /** Full-refund cancellation deadline the supplier allows, as a UTC instant, or null when none. */
      supplierFreeCancellationUntilUtc: string | null;
      /** TicketOnly: last day (Asia/Dubai, YYYY-MM-DD) the ticket can be used, when the supplier gives one; null otherwise. */
      ticketValidUntil: string | null;
      /** Doc 29 Batch 5: a TicketOnly quote (open dated, non-refundable once issued). Absent for slot bookings. */
      openDatedTicket?: true;
      /** With a pickup: the accepted hotel's name on the supplier's list, when it has one (Batch 3). */
      pickupHotelName?: string | null;
      /** Doc 29 Batch 6: the offer is booked through an external supplier, whose confirmation can take minutes. Absent otherwise. */
      externalConfirmation?: true;
      /**
       * Doc 29 Batch 7: a date-only offer (no slot metadata). The fresh availability row's own `timeSlotId`,
       * `startTime` and `endTime`, which the booking sends unchanged. Absent for every other offer.
       */
      availabilitySlot?: { timeSlotId: number; startMinutes: number; endMinutes: number };
      /**
       * Doc 29 Batch 7 (owner decision, 24 Nov 2026): the supplier gave no seat count (a `left` sentinel). The
       * party fits the offer's own maximum, and the supplier checks seats at reserve, before capture. With it,
       * `capacity: "unknown"` and `seatsLeft: null` are not a refusal. Absent otherwise.
       */
      seatsUnstated?: true;
    }
  | {
      ok: false;
      reason: "closed" | "sold_out" | "past_cutoff" | "invalid_slot" | "on_request" | "unit_rule_failed" | "pickup_unavailable" | "ticket_validity_ended" | "availability_unknown" | "supplier_unavailable";
    };

export interface SupplierQuoteInput {
  mappingId: string;
  serviceDate: string;
  slotRef: string | null;
  /** Doc 29 Batch 7: readiness says the mapping sells as date only (`dateOnlySellable`). Absent: an offer with no slot is refused. */
  dateOnly?: boolean;
  /** Supplier units and counts (from `UnitDefinition.supplierUnit`). */
  supplierUnits: Record<string, number>;
  pickup: { hotelRef: string } | null;
}

export interface SupplierQuoteService {
  quote(input: SupplierQuoteInput): Promise<SupplierQuoteResult>;
}

/** Ledger: `src/server/services/margin.service.ts`. */
export interface MarginService {
  currentPolicy(): Promise<MarginPolicy>;
  /** Margin for one line in the charged currency; refuses below the floor. FX input comes only from approved settings. */
  evaluate(input: { chargedMinor: bigint; currency: Currency; supplierNetAedMinor: bigint; policy: MarginPolicy }): Promise<
    { ok: true; snapshot: MarginSnapshot } | { ok: false; reason: "margin_below_floor" | "fx_input_missing" | "cost_inputs_missing" }
  >;
  /** Split an order-level discount and tax across lines exactly (largest remainder); sums are preserved. */
  allocate(linesMinor: bigint[], discountMinor: bigint, taxMinor: bigint): Array<{ discountAllocMinor: bigint; taxAllocMinor: bigint }>;
}

/** Ledger: `src/server/services/contact-verification.service.ts` and guest sessions. */
export interface ContactVerificationService {
  /** Sends a challenge to the contact for this quote; generic response, rate-limited; never creates a customer. */
  start(input: { quoteId: string; channel: "phone" | "email"; contact: string; owner: QuoteSnapshot["owner"]; ip: string | null }): Promise<{ challengeId: string }>;
  verify(input: { challengeId: string; code: string; owner: QuoteSnapshot["owner"]; ip: string | null }): Promise<ContactVerification | { refused: "invalid" | "expired" | "rate_limited" }>;
}

/** Juniper: `src/server/services/readiness.service.ts` and `quote.service.ts`. */
export interface ReadinessService {
  evaluate(productId: string, opts?: { environment?: "test" | "production" }): Promise<ReadinessResult>;
}
export interface QuoteService {
  create(owner: QuoteSnapshot["owner"], request: QuoteRequest): Promise<QuoteResult>;
}
