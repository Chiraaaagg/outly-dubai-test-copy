import "server-only";
import { Prisma } from "@prisma/client";
import { prisma } from "../lib/db";
import { Errors, isAppError } from "../lib/errors";
import { sha256Hex } from "../lib/crypto";
import { uuidv7 } from "../lib/ids";
import { log } from "../lib/logger";
import { parseWith } from "../lib/http";
import { quoteRequestSchema } from "../schemas/quote.schemas";
import { marginService } from "./margin.service";
import { instantOrderCapVerdict, readInstantOrderCapInputs, type InstantOrderCapInputs } from "../payments/exposure-limits";
import { PICKUP_HOTEL_REF, supplierQuoteService } from "./supplier-quote.service";
import { activeVariants, mappingForVariant, READINESS_RULES_VERSION, readinessService, type MappingReadiness, type ReadinessServiceImpl } from "./readiness.service";
import {
  MAX_INSTANT_ITEMS_PER_ORDER,
  MULTI_INSTANT_ITEM_POLICY,
  QUOTE_TTL_MS,
  repeatsInstantLine,
  SAME_DAY_INSTANT_POLICY,
  type MarginService,
  type QuoteLineRequest,
  type QuoteLineSnapshot,
  type QuoteRefusal,
  type QuoteRefusalReason,
  type QuoteRequest,
  type QuoteResult,
  type QuoteService,
  type QuoteSnapshot,
  type ReadinessReason,
  type SupplierQuoteResult,
  type SupplierQuoteService,
  type UnitDefinition,
} from "../quotes/contracts";
import { authoredCouponValue, couponByCode, couponDiscountMinor, type Coupon } from "@/lib/pricing";
import { dubaiDayStartUtc, dubaiToday, freeCancellationCopy, TICKET_NON_REFUNDABLE_STATEMENT, ticketValidityCopy } from "@/lib/utils";
import type { Activity, Currency } from "@/lib/types";

/**
 * Server quotes (doc 22 §22.1 item 4; PRD-1, PRD-5, PRD-13, PRD-18).
 *
 * The only place an instant price is decided. Nothing in the request is
 * trusted beyond its shape: every line is recomputed from the database.
 *
 * Every local rule runs for every line before any supplier call, so a cart
 * that cannot be sold costs no supplier read (CR-B2-3):
 *
 *  1. Readiness, live (not the cached `product_eligibility` row): the product
 *     must be published, valid and effectively instant. Anything else is
 *     `requires_inquiry` (or `not_published`), so the client sends the whole
 *     cart to the inquiry path. Combos cannot be expressed in a quote line.
 *  2. Selection: the variant exists and is not sold out; every unit is one of
 *     the variant's typed units, within its min/max, at least one seat;
 *     instant lines take no add-ons (readiness already refuses products with
 *     add-ons); a product with time slots needs a slot. Pickup: a product or
 *     offer with pickup needs a hotel, and one without pickup takes none
 *     (`pickup_unavailable`).
 *  3. Owner policies: `SAME_DAY_INSTANT_POLICY` (now "allow": a service
 *     date equal to `dubaiToday()` is quoted like any other, its slot cutoff
 *     still applying in step 5) and `MULTI_INSTANT_ITEM_POLICY` (now "allow":
 *     several instant lines make one quote and one order). More than
 *     `MAX_INSTANT_ITEMS_PER_ORDER` lines, or two lines for the same variant,
 *     date and slot, refuse every line `multi_instant_inquiry`, so the cart
 *     goes to inquiry (multi-item, lead-approved 3 Nov 2026).
 *  4. Coupon: it applies only when it has an authored value in the
 *     transaction currency (otherwise every line is refused
 *     `coupon_not_available_in_currency`), in that currency's minor units.
 *  4a. Per-order instant cap (doc 22 §32.24, owner: 500 AED per order): the
 *     whole order total (every line, less the discount) against
 *     `payments.exposure_limits.maxInstantOrderAedMinor`, INR converted with
 *     the current FX row and rounded up (`instantOrderCapVerdict`, the rule
 *     checkout repeats). Over the cap, no cap set, or no usable FX row for an
 *     INR order: every line is refused `order_over_limit` (shown as
 *     `requires_inquiry`), before any supplier call.
 *  5. Supplier: one fresh, uncached check per line (`SupplierQuoteService`),
 *     which also checks the hotel against the supplier's list; then
 *     capacity, cutoff (at least `MIN_PAYMENT_WINDOW_MS` must be left before
 *     it) and the fresh refundability against the displayed policy (TKT-7).
 *     A supplier deadline earlier than the page's own promise refuses the
 *     line and re-runs readiness for the product.
 *  6. Money: charged = Σ unit price × quantity in the transaction currency
 *     (authored prices, never converted; readiness keeps them equal to the
 *     page price). `MarginService.allocate` splits the discount across lines;
 *     each line must meet the versioned margin floor after its share.
 *  7. Persist: one `quotes` row bound to the owner, expiring at the earlier
 *     of ten minutes and the first supplier cutoff, with a fingerprint over
 *     the canonical request and owner. An active quote with the same
 *     fingerprint is superseded when it carries the same owner and the same
 *     canonical request; anything else under that fingerprint is a 409.
 *     Expired rows are marked expired first and never conflict.
 *
 * A refusal lists every failing line with its first reason. No row is
 * written for a refusal. Nothing here takes payment or contacts a gateway.
 * The snapshot also records the supplier account each line was checked
 * against and the coupon terms applied (`QuoteRecord`, CR-B2-12).
 * The route returns only `toPublicQuote` of the result: supplier net, margin,
 * mapping, fingerprint and owner never leave the server (CR-B2-1).
 */

export const QUOTE_COUPON_UNKNOWN = "We don't recognise that code";

/**
 * The least time a customer must have between the quote and the earliest
 * supplier cutoff to pay before it (CR-B2-9). Provisional operating value,
 * five minutes; an ops parameter the owner may adjust once payment latencies
 * are measured (B3). A line with less time left is refused `past_cutoff`.
 */
export const MIN_PAYMENT_WINDOW_MS = 5 * 60_000;

/**
 * A stored line: the contract snapshot plus the supplier account the check
 * ran against and the version of the coupon whose share it carries
 * (CR-B2-12). Lines are the only JSON the `quotes` row keeps, so the coupon
 * version is recorded here as well as on the quote.
 */
export interface QuoteLineRecord extends QuoteLineSnapshot {
  /** From the mapping facts; null when the supplier side did not report one. */
  supplierAccountId: string | null;
  /** `couponVersionOf` the coupon applied; null without a coupon. */
  couponVersion: string | null;
}

/** A stored quote: the contract snapshot plus the version of the coupon terms applied (CR-B2-12). */
export interface QuoteRecord extends QuoteSnapshot {
  lines: QuoteLineRecord[];
  /** sha256 over the canonical coupon definition that priced the discount; null without a coupon. */
  couponVersion: string | null;
}

export interface StoredQuote {
  id: string;
  fingerprint: string;
  owner: QuoteSnapshot["owner"];
  request: unknown;
  status: string;
  expiresAt: Date;
}

export interface QuoteStore {
  /** Active quotes carrying this fingerprint, under any owner. */
  findActiveByFingerprint(fingerprint: string): Promise<StoredQuote[]>;
  /**
   * In one transaction: mark `expire` expired and `supersede` superseded (each
   * only while still active), then insert `quote`. Returns false when another
   * active quote with the same owner and fingerprint won the race.
   */
  replace(input: { expire: string[]; supersede: string[]; quote: QuoteRecord; request: QuoteRequest; now: Date }): Promise<boolean>;
}

export interface QuoteDeps {
  /** `reevaluate` runs when a fresh supplier policy no longer fits the page (N1); it never throws. */
  readiness: Pick<ReadinessServiceImpl, "assess" | "reevaluate">;
  /** null until the supplier seam is wired: every line is then `supplier_unavailable`. */
  supplierQuote: SupplierQuoteService | null;
  margin: MarginService;
  store: QuoteStore;
  /** Whether the owner may use a first-booking coupon. Guests cannot prove it. */
  isFirstBooking(owner: QuoteSnapshot["owner"]): Promise<boolean>;
  /** The per-order instant cap and the current INR-per-AED rate (exposure-limits.ts), read fresh. */
  instantOrderCap(now: Date): Promise<InstantOrderCapInputs>;
  now(): Date;
}

/* ---------------------------------------------------------------------------
 * Canonical form and fingerprint
 * ------------------------------------------------------------------------ */

function sortedRecord(r: Record<string, number>): Record<string, number> {
  return Object.fromEntries(Object.entries(r).filter(([, n]) => n > 0).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)));
}

/** Zero quantities dropped, unit keys and add-ons sorted, coupon upper-cased. Line order is kept: it is the cart's order. */
export function canonicalRequest(r: QuoteRequest): QuoteRequest {
  return {
    lines: r.lines.map((l) => ({
      productId: l.productId.toLowerCase(),
      variantId: l.variantId,
      serviceDate: l.serviceDate,
      slotRef: l.slotRef,
      units: sortedRecord(l.units),
      addonIds: [...new Set(l.addonIds)].sort(),
      pickup: l.pickup ? { hotelRef: l.pickup.hotelRef } : null,
    })),
    currency: r.currency,
    couponCode: r.couponCode ? r.couponCode.trim().toUpperCase() : null,
  };
}

function canonicalValue(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(canonicalValue);
  if (typeof v === "bigint") return v.toString();
  if (typeof v === "number") return Object.is(v, -0) ? 0 : v;
  if (v && typeof v === "object") {
    const o = v as Record<string, unknown>;
    return Object.fromEntries(
      Object.keys(o)
        .sort()
        .map((k) => [k, canonicalValue(o[k])]),
    );
  }
  return v;
}

/**
 * JSON with object keys sorted at every level and numbers in one form, so a
 * value read back from JSONB (which reorders keys) compares equal to the one
 * written (CR-B2-2).
 */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(canonicalValue(value));
}

function ownerKey(owner: QuoteSnapshot["owner"]): string {
  return owner.kind === "customer" ? `customer:${owner.customerId}` : `guest:${owner.guestSessionId}`;
}

export function quoteFingerprint(owner: QuoteSnapshot["owner"], canonical: QuoteRequest): string {
  return sha256Hex(canonicalJson({ owner: ownerKey(owner), request: canonical }));
}

/* ---------------------------------------------------------------------------
 * Line rules
 * ------------------------------------------------------------------------ */

function refusalForReadiness(reasons: ReadinessReason[]): QuoteRefusalReason {
  if (reasons.includes("not_published")) return "not_published";
  return "requires_inquiry";
}

/** A requested quantity; only the request's own keys count (a unit id such as `constructor` reads 0). */
function qty(requested: Record<string, number>, unitId: string): number {
  return Object.hasOwn(requested, unitId) ? requested[unitId] : 0;
}

/**
 * Unit rules a request can be checked against now: known units, min/max and
 * at least one seat. Age, residency and height are facts about each
 * traveller, and the quote has no traveller details: they are checked by the
 * traveller details step (B5) against the `unitDefinitions` the snapshot
 * keeps. Until then readiness sells instantly only units that are the page's
 * own pax types at the page's price (`unitPriceShown`) and carry no
 * restriction beyond that pax type's own definition (`unitRestricted`).
 */
export function checkUnits(units: UnitDefinition[], requested: Record<string, number>): QuoteRefusalReason | null {
  const byId = new Map(units.map((u) => [u.unitId, u]));
  for (const id of Object.keys(requested)) if (!byId.has(id)) return "unknown_unit";
  let seats = 0;
  for (const u of units) {
    const n = qty(requested, u.unitId);
    if (n < u.minQty || n > u.maxQty) return "unit_rule_failed";
    if (u.seatConsuming) seats += n;
  }
  return seats >= 1 ? null : "unit_rule_failed";
}

/** Supplier unit counts for the check (several Outly units can map to one supplier unit). */
export function supplierUnitsFor(units: UnitDefinition[], requested: Record<string, number>): Record<string, number> {
  const out: Record<string, number> = {};
  for (const u of units) {
    const n = qty(requested, u.unitId);
    if (n > 0) out[u.supplierUnit] = (Object.hasOwn(out, u.supplierUnit) ? out[u.supplierUnit] : 0) + n;
  }
  return out;
}

export function chargedMinorFor(units: UnitDefinition[], requested: Record<string, number>, currency: Currency): bigint {
  let total = 0n;
  for (const u of units) {
    const n = qty(requested, u.unitId);
    total += BigInt(currency === "INR" ? u.price.inr : u.price.aed) * 100n * BigInt(n);
  }
  return total;
}

function supplierRefusal(r: Extract<SupplierQuoteResult, { ok: false }>["reason"]): QuoteRefusalReason {
  return r === "on_request" ? "requires_inquiry" : r;
}

/** Start of a supplier slot in minutes after Dubai midnight, from the supplier's `<timeSlotId>@HH:mm` reference; null when it has none. */
export function slotStartMinutes(slotRef: string | null): number | null {
  const m = slotRef ? /@([01]\d|2[0-3]):([0-5]\d)$/.exec(slotRef) : null;
  return m ? Number(m[1]) * 60 + Number(m[2]) : null;
}

/**
 * The customer's own deadline: `hours` before the slot starts in Dubai. A
 * line without a known start time counts from the start of the service day,
 * the earliest it can begin.
 */
export function customerFreeCancellationUntil(serviceDate: string, hours: number, startMinutes: number | null = null): Date | null {
  if (hours <= 0) return null;
  return new Date(dubaiDayStartUtc(serviceDate).getTime() + (startMinutes ?? 0) * 60_000 - hours * 3600_000);
}

/**
 * The full-refund deadline the snapshot records and the customer is shown
 * (CR-B2-6): the earlier of our own deadline and the supplier's, so Outly
 * never promises a refund the supplier would not give. null when there is
 * none, or when it has already passed.
 *
 * Both deadlines count back from the activity start (doc 29 §8.7: TravelDesk
 * counts its window from the activity start, and the owner made ours the
 * same; conflict C12 reversed). A supplier deadline earlier than the page's
 * promise is a tightened policy and refuses the line before this runs
 * (`supplierPolicyTightened`, N1).
 */
export function freeCancellationDeadline(input: { serviceDate: string; hours: number; startMinutes: number | null; supplierUntilUtc: string; now: Date }): Date | null {
  const ours = customerFreeCancellationUntil(input.serviceDate, input.hours, input.startMinutes);
  if (!ours) return null;
  const until = Math.min(ours.getTime(), Date.parse(input.supplierUntilUtc));
  return until > input.now.getTime() ? new Date(until) : null;
}

/**
 * Whether the supplier's fresh full-refund deadline is earlier than the
 * page's "up to N hours" before the activity starts (N1; doc 29 §8.7). The
 * start is the quoted slot's; without one, the start of the service day, the
 * earliest the activity can begin.
 */
export function supplierPolicyTightened(serviceDate: string, hours: number, supplierUntilUtc: string, startMinutes: number | null = null): boolean {
  const promise = customerFreeCancellationUntil(serviceDate, hours, startMinutes);
  return promise !== null && Date.parse(supplierUntilUtc) < promise.getTime();
}

/** sha256 over the coupon definition as applied: a change to its terms is a new version (CR-B2-12). */
export function couponVersionOf(coupon: Coupon): string {
  return sha256Hex(canonicalJson(coupon));
}

/** A line that passed every local rule; nothing about it came from the supplier yet. */
interface LocalLine {
  index: number;
  line: QuoteLineRequest;
  activity: Activity;
  productVersion: number | null;
  units: UnitDefinition[];
  mapping: MappingReadiness & { approvedOfferHash: string };
  chargedMinor: bigint;
}

interface CheckedLine extends LocalLine {
  supplier: Extract<SupplierQuoteResult, { ok: true }>;
  freeCancellationUntilUtc: string | null;
  nonRefundableAfterConfirm: boolean;
}

/* ---------------------------------------------------------------------------
 * Public projection (CR-B2-1)
 * ------------------------------------------------------------------------ */

export interface PublicQuoteLine {
  index: number;
  productId: string;
  variantId: string;
  serviceDate: string;
  slotRef: string | null;
  units: Record<string, number>;
  addonIds: string[];
  /** Minor units of `currency`, as decimal strings. */
  chargedMinor: string;
  discountAllocMinor: string;
  taxAllocMinor: string;
  freeCancellationUntilUtc: string | null;
  /** The exact refund line to show before payment: the deadline in Dubai time and in UTC (`freeCancellationCopy`). */
  freeCancellationCopy: string;
  nonRefundableAfterConfirm: boolean;
  /** TicketOnly: last day the ticket can be used, and the line that says so; null for other bookings. */
  ticketValidUntil: string | null;
  ticketValidityCopy: string | null;
  /** Doc 29 Batch 5: an open-dated ticket; `freeCancellationCopy` then says the tickets are non-refundable once issued. */
  openDatedTicket: boolean;
}

export type PublicQuoteResult =
  | { ok: true; quoteId: string; expiresAt: string; currency: Currency; totalMinor: string; lines: PublicQuoteLine[] }
  | { ok: false; lines: Array<{ index: number; reason: QuoteRefusalReason }> };

/** Reasons that would tell a caller where the margin floor or the supplier's terms sit; the public sees `requires_inquiry`. */
const PRIVATE_REASONS: ReadonlySet<QuoteRefusalReason> = new Set(["margin_below_floor", "policy_exceeds_supplier", "order_over_limit"]);

/**
 * The only shape `/api/quotes` returns: an allowlist, field by field. Supplier
 * net, margin, cost and FX lines, mapping id, offer hash, unit definitions,
 * fingerprint and owner stay in the stored snapshot.
 */
export function toPublicQuote(result: QuoteResult): PublicQuoteResult {
  if (!result.ok) {
    return { ok: false, lines: result.lines.map((l) => ({ index: l.index, reason: PRIVATE_REASONS.has(l.reason) ? "requires_inquiry" : l.reason })) };
  }
  return {
    ok: true,
    quoteId: result.quoteId,
    expiresAt: result.expiresAt,
    currency: result.currency,
    totalMinor: result.totalMinor.toString(),
    lines: result.lines.map((l) => ({
      index: l.index,
      productId: l.productId,
      variantId: l.variantId,
      serviceDate: l.serviceDate,
      slotRef: l.slotRef,
      units: Object.fromEntries(Object.entries(l.units).map(([k, n]) => [k, n])),
      addonIds: [...l.addonIds],
      chargedMinor: l.chargedMinor.toString(),
      discountAllocMinor: l.discountAllocMinor.toString(),
      taxAllocMinor: l.taxAllocMinor.toString(),
      freeCancellationUntilUtc: l.freeCancellationUntilUtc,
      freeCancellationCopy: l.openDatedTicket === true ? TICKET_NON_REFUNDABLE_STATEMENT : freeCancellationCopy(l.freeCancellationUntilUtc),
      nonRefundableAfterConfirm: l.nonRefundableAfterConfirm,
      ticketValidUntil: l.ticketValidUntil ?? null,
      ticketValidityCopy: ticketValidityCopy(l.ticketValidUntil),
      openDatedTicket: l.openDatedTicket === true,
    })),
  };
}

/* ---------------------------------------------------------------------------
 * Service
 * ------------------------------------------------------------------------ */

export interface QuoteServiceImpl extends QuoteService {
  create(owner: QuoteSnapshot["owner"], request: QuoteRequest): Promise<QuoteRecord | QuoteRefusal>;
  /** For tests and the order path: the canonical form a quote's fingerprint covers. */
  fingerprintOf(owner: QuoteSnapshot["owner"], request: QuoteRequest): string;
}

export function createQuoteService(deps: QuoteDeps): QuoteServiceImpl {
  /** A failing dependency (database, settings) is a retryable 503, never a quote. */
  async function guarded<T>(what: string, fn: () => Promise<T>): Promise<T> {
    try {
      return await fn();
    } catch (error) {
      if (isAppError(error)) throw error;
      log.error("quote.dependency_failed", { what, error });
      throw Errors.unavailable();
    }
  }

  /** Everything the database alone can decide. Makes no supplier call. */
  async function checkLocal(index: number, line: QuoteLineRequest, currency: Currency, now: Date): Promise<LocalLine | QuoteRefusalReason> {
    const assessed = await guarded("readiness", () => deps.readiness.assess(line.productId));
    if (assessed.effective !== "instant" || !assessed.activity) return refusalForReadiness(assessed.reasons);
    const activity = assessed.activity;

    const variants = activeVariants(activity);
    const variant = variants.find((v) => v.id === line.variantId);
    if (!variant) return "unknown_variant";
    const units = variant.units ?? [];
    const unitProblem = checkUnits(units, line.units);
    if (unitProblem) return unitProblem;
    if (line.addonIds.length) return "unknown_addon";
    if (activity.timeSlots.length > 0 && !line.slotRef) return "invalid_slot";

    const today = dubaiToday(now);
    if (line.serviceDate < today) return "past_cutoff";
    if (line.serviceDate === today && SAME_DAY_INSTANT_POLICY === "inquiry") return "same_day_inquiry_only";

    const mapping = mappingForVariant(assessed.mappings, variant.id, variants.length);
    if (!mapping || !mapping.approvedOfferHash) return "requires_inquiry";
    // Readiness keeps content and offer in agreement; this is the per-line half.
    const pickupRequired = activity.pickupIncluded || mapping.pickupOffered === true;
    if (pickupRequired !== Boolean(line.pickup)) return "pickup_unavailable";
    // Batch 3: a hotel is the numeric TravelDesk id from the offer's list, never a typed name.
    if (line.pickup && !PICKUP_HOTEL_REF.test(line.pickup.hotelRef)) return "pickup_unavailable";

    return {
      index,
      line,
      activity,
      productVersion: assessed.productVersion ?? null,
      units,
      mapping: { ...mapping, approvedOfferHash: mapping.approvedOfferHash },
      chargedMinor: chargedMinorFor(units, line.units, currency),
    };
  }

  async function checkSupplier(local: LocalLine, now: Date): Promise<CheckedLine | QuoteRefusalReason> {
    if (!deps.supplierQuote) return "supplier_unavailable";
    const { line, units } = local;
    let supplier: SupplierQuoteResult;
    try {
      supplier = await deps.supplierQuote.quote({
        mappingId: local.mapping.mappingId,
        serviceDate: line.serviceDate,
        slotRef: line.slotRef,
        supplierUnits: supplierUnitsFor(units, line.units),
        pickup: line.pickup,
      });
    } catch (error) {
      log.warn("quote.supplier_check_failed", { index: local.index, error });
      return "supplier_unavailable";
    }
    if (!supplier.ok) return supplierRefusal(supplier.reason);

    const seats = units.reduce((n, u) => n + (u.seatConsuming ? qty(line.units, u.unitId) : 0), 0);
    if (supplier.capacity !== "unlimited" && supplier.seatsLeft !== null && supplier.seatsLeft < seats) return "sold_out";
    if (supplier.capacity === "unknown" && supplier.seatsLeft === null) return "availability_unknown";
    // Too close to the cutoff to pay before it (CR-B2-9).
    if (supplier.cutoffUtc && Date.parse(supplier.cutoffUtc) - now.getTime() < MIN_PAYMENT_WINDOW_MS) return "past_cutoff";

    // TKT-7 with the fresh supplier facts, not only the approved snapshot.
    const hours = local.activity.freeCancellationHours;
    // Doc 29 Batch 5: issued tickets are never refundable, so a ticket line with a free-cancellation promise is refused.
    if (supplier.openDatedTicket === true && hours !== 0) {
      await deps.readiness.reevaluate(line.productId, "supplier_policy_changed");
      return "policy_exceeds_supplier";
    }
    let freeUntil: Date | null = null;
    if (hours > 0) {
      const supplierUntil = supplier.supplierFreeCancellationUntilUtc;
      if (supplier.issuesTicketsAtConfirm !== "no" || !supplierUntil || Number.isNaN(Date.parse(supplierUntil)) || supplierPolicyTightened(line.serviceDate, hours, supplierUntil, slotStartMinutes(supplier.slotRef))) {
        // The approved terms no longer hold: re-run the product's readiness (awaited, so a serverless
        // instance does not drop it after the response; it never throws).
        await deps.readiness.reevaluate(line.productId, "supplier_policy_changed");
        return "policy_exceeds_supplier";
      }
      freeUntil = freeCancellationDeadline({ serviceDate: line.serviceDate, hours, startMinutes: slotStartMinutes(supplier.slotRef), supplierUntilUtc: supplierUntil, now });
    }

    return {
      ...local,
      supplier,
      freeCancellationUntilUtc: freeUntil ? freeUntil.toISOString() : null,
      nonRefundableAfterConfirm: !freeUntil,
    };
  }

  /**
   * The coupon's discount in the quote currency, or a refusal when the coupon
   * has no authored value in that currency (it is never converted).
   */
  async function couponMinor(code: string | null, subtotalMinor: bigint, currency: Currency, owner: QuoteSnapshot["owner"]): Promise<{ discountMinor: bigint; version: string | null } | "coupon_not_available_in_currency"> {
    if (!code) return { discountMinor: 0n, version: null };
    const coupon = couponByCode(code);
    if (!coupon) throw Errors.validation({ couponCode: QUOTE_COUPON_UNKNOWN });
    if (!authoredCouponValue(coupon, currency)) return "coupon_not_available_in_currency";
    if (coupon.firstBookingOnly && !(await guarded("coupon", () => deps.isFirstBooking(owner)))) {
      throw Errors.validation({ couponCode: `${coupon.code} is for a first booking with a signed-in account` });
    }
    const r = couponDiscountMinor(coupon, subtotalMinor, currency);
    if (!r.ok) {
      if (r.reason === "not_available_in_currency") return "coupon_not_available_in_currency";
      throw Errors.validation({ couponCode: `${coupon.code} needs a larger order` });
    }
    return { discountMinor: r.discountMinor, version: couponVersionOf(coupon) };
  }

  function refused(lines: QuoteRefusal["lines"]): QuoteRefusal {
    const sorted = [...lines].sort((a, b) => a.index - b.index);
    // The public projection folds these into `requires_inquiry`; the real reason stays in the log.
    if (sorted.some((l) => PRIVATE_REASONS.has(l.reason))) log.info("quote.refused", { lines: sorted });
    return { ok: false, lines: sorted };
  }

  const service: QuoteServiceImpl = {
    fingerprintOf(owner, request) {
      return quoteFingerprint(owner, canonicalRequest(request));
    },

    async create(owner, rawRequest): Promise<QuoteRecord | QuoteRefusal> {
      const request = canonicalRequest(parseWith(quoteRequestSchema, rawRequest));
      const now = deps.now();

      // Local rules for every line first, so a mixed cart names the lines that need a quick check.
      const refusals: QuoteRefusal["lines"] = [];
      const locals: LocalLine[] = [];
      for (const [index, line] of request.lines.entries()) {
        const r = await checkLocal(index, line, request.currency, now);
        if (typeof r === "string") refusals.push({ index, reason: r });
        else locals.push(r);
      }
      if (request.lines.length > 1 && (MULTI_INSTANT_ITEM_POLICY === "inquiry" || request.lines.length > MAX_INSTANT_ITEMS_PER_ORDER || repeatsInstantLine(request.lines))) {
        for (const l of locals) refusals.push({ index: l.index, reason: "multi_instant_inquiry" });
      }
      if (refusals.length) return refused(refusals);

      const subtotal = locals.reduce((s, c) => s + c.chargedMinor, 0n);
      const coupon = await couponMinor(request.couponCode, subtotal, request.currency, owner);
      if (typeof coupon === "string") return refused(locals.map((c) => ({ index: c.index, reason: coupon })));
      const discount = coupon.discountMinor;

      // The per-order cap on the whole order (prices are all-in: no tax line), before any supplier call.
      const cap = await guarded("order_cap", () => deps.instantOrderCap(now));
      const verdict = instantOrderCapVerdict({ totalMinor: subtotal - discount, currency: request.currency, capAedMinor: cap.capAedMinor, inrPerAed: cap.inrPerAed });
      if (!verdict.ok) {
        log.info("quote.order_cap_refused", { cause: verdict.reason, currency: request.currency, lines: locals.length });
        return refused(locals.map((c) => ({ index: c.index, reason: "order_over_limit" })));
      }

      // Only now, with every local rule passed, the supplier is asked.
      const checked: CheckedLine[] = [];
      for (const local of locals) {
        const r = await checkSupplier(local, now);
        if (typeof r === "string") refusals.push({ index: local.index, reason: r });
        else checked.push(r);
      }
      if (refusals.length) return refused(refusals);

      const allocations = deps.margin.allocate(
        checked.map((c) => c.chargedMinor),
        discount,
        0n, // prices are all-in (src/lib/pricing.ts): there is no tax line to allocate
      );
      const policy = await guarded("margin_policy", () => deps.margin.currentPolicy());

      const lines: QuoteLineRecord[] = [];
      for (const [i, c] of checked.entries()) {
        const alloc = allocations[i];
        const m = await guarded("margin", () =>
          deps.margin.evaluate({ chargedMinor: c.chargedMinor - alloc.discountAllocMinor, currency: request.currency, supplierNetAedMinor: c.supplier.netAedMinor, policy }),
        );
        if (!m.ok) {
          refusals.push({ index: c.index, reason: "margin_below_floor" });
          continue;
        }
        lines.push({
          index: c.index,
          productId: c.line.productId,
          productVersion: c.productVersion,
          variantId: c.line.variantId,
          mappingId: c.mapping.mappingId,
          approvedOfferHash: c.mapping.approvedOfferHash,
          supplierEnvironment: c.mapping.environment ?? null,
          supplierAccountId: c.mapping.accountId ?? null,
          couponVersion: coupon.version,
          readinessRulesVersion: READINESS_RULES_VERSION,
          serviceDate: c.line.serviceDate,
          slotRef: c.supplier.slotRef ?? c.line.slotRef,
          units: c.line.units,
          unitDefinitions: c.units.filter((u) => qty(c.line.units, u.unitId) > 0),
          addonIds: [],
          pickup: c.line.pickup ? { hotelRef: c.line.pickup.hotelRef, hotelName: c.supplier.pickupHotelName ?? null } : null,
          chargedMinor: c.chargedMinor,
          discountAllocMinor: alloc.discountAllocMinor,
          taxAllocMinor: alloc.taxAllocMinor,
          supplierNetAedMinor: c.supplier.netAedMinor,
          // TravelDesk's own USD figure, never derived from AED; the engine's attempt needs it (SUP-24). Stored only.
          supplierNetUsdMinor: c.supplier.netUsdMinor ?? null,
          supplierCheckedAt: c.supplier.checkedAt,
          margin: m.snapshot,
          freeCancellationUntilUtc: c.freeCancellationUntilUtc,
          nonRefundableAfterConfirm: c.nonRefundableAfterConfirm,
          ticketValidUntil: c.supplier.ticketValidUntil ?? null,
          ...(c.supplier.openDatedTicket === true ? { openDatedTicket: true } : {}),
        });
      }
      if (refusals.length) return refused(refusals);

      // The earlier of ten minutes and the first supplier cutoff (CR-B2-9).
      const cutoffs = checked.flatMap((c) => (c.supplier.cutoffUtc ? [Date.parse(c.supplier.cutoffUtc)] : [])).filter((t) => !Number.isNaN(t));
      const expiresAt = Math.min(now.getTime() + QUOTE_TTL_MS, ...cutoffs);

      const fingerprint = quoteFingerprint(owner, request);
      const snapshot: QuoteRecord = {
        ok: true,
        quoteId: uuidv7(),
        fingerprint,
        owner,
        currency: request.currency,
        couponCode: request.couponCode,
        couponVersion: coupon.version,
        totalMinor: lines.reduce((s, l) => s + l.chargedMinor - l.discountAllocMinor + l.taxAllocMinor, 0n),
        lines,
        expiresAt: new Date(expiresAt).toISOString(),
      };

      const existing = await guarded("quote_read", () => deps.store.findActiveByFingerprint(fingerprint));
      const expire: string[] = [];
      const supersede: string[] = [];
      const content = canonicalJson(request);
      for (const q of existing) {
        // An expired row is closed whatever it holds; it never blocks a new quote.
        if (q.expiresAt.getTime() <= now.getTime()) {
          expire.push(q.id);
          continue;
        }
        const sameOwner = ownerKey(q.owner) === ownerKey(owner);
        const sameContent = canonicalJson(q.request) === content;
        if (!sameOwner || !sameContent) throw Errors.conflict("This quote conflicts with another one — start again from your trip", { reason: "fingerprint_conflict" });
        supersede.push(q.id);
      }
      const inserted = await guarded("quote_write", () => deps.store.replace({ expire, supersede, quote: snapshot, request, now }));
      if (!inserted) throw Errors.conflict("This quote is already being prepared — try again in a moment", { reason: "fingerprint_race" });
      return snapshot;
    },
  };
  return service;
}

/* ---------------------------------------------------------------------------
 * Production wiring
 * ------------------------------------------------------------------------ */

/** One line as the `quotes.lines` JSONB stores it: amounts as decimal strings. Exported for tests. */
export function storedLineJson(l: QuoteLineRecord) {
  return {
    ...l,
    chargedMinor: l.chargedMinor.toString(),
    discountAllocMinor: l.discountAllocMinor.toString(),
    taxAllocMinor: l.taxAllocMinor.toString(),
    supplierNetAedMinor: l.supplierNetAedMinor.toString(),
    supplierNetUsdMinor: l.supplierNetUsdMinor === undefined || l.supplierNetUsdMinor === null ? null : l.supplierNetUsdMinor.toString(),
    margin: { ...l.margin, costLines: l.margin.costLines.map((c) => ({ name: c.name, minor: c.minor.toString() })) },
  };
}

function ownerOf(row: { ownerKind: string; customerId: string | null; guestSessionId: string | null }): QuoteSnapshot["owner"] {
  return row.ownerKind === "customer" ? { kind: "customer", customerId: row.customerId ?? "" } : { kind: "guest", guestSessionId: row.guestSessionId ?? "" };
}

export const prismaQuoteStore: QuoteStore = {
  async findActiveByFingerprint(fingerprint) {
    const rows = await prisma.quote.findMany({
      where: { fingerprint, status: "active" },
      select: { id: true, fingerprint: true, ownerKind: true, customerId: true, guestSessionId: true, request: true, status: true, expiresAt: true },
    });
    return rows.map((r) => ({ id: r.id, fingerprint: r.fingerprint, owner: ownerOf(r), request: r.request, status: r.status, expiresAt: r.expiresAt }));
  },

  async replace({ expire, supersede, quote, request, now }) {
    try {
      await prisma.$transaction(async (tx) => {
        if (expire.length) await tx.quote.updateMany({ where: { id: { in: expire }, status: "active" }, data: { status: "expired" } });
        if (supersede.length) await tx.quote.updateMany({ where: { id: { in: supersede }, status: "active" }, data: { status: "superseded" } });
        await tx.quote.create({
          data: {
            id: quote.quoteId,
            fingerprint: quote.fingerprint,
            ownerKind: quote.owner.kind,
            customerId: quote.owner.kind === "customer" ? quote.owner.customerId : null,
            guestSessionId: quote.owner.kind === "guest" ? quote.owner.guestSessionId : null,
            currency: quote.currency,
            totalMinor: quote.totalMinor,
            lines: quote.lines.map(storedLineJson) as unknown as Prisma.InputJsonValue,
            request: request as unknown as Prisma.InputJsonValue,
            status: "active",
            createdAt: now,
            expiresAt: new Date(quote.expiresAt),
          },
        });
      });
      return true;
    } catch (error) {
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") return false;
      throw error;
    }
  },
};

export const quoteService = createQuoteService({
  readiness: readinessService,
  supplierQuote: supplierQuoteService,
  margin: marginService,
  store: prismaQuoteStore,
  async isFirstBooking(owner) {
    if (owner.kind !== "customer") return false;
    return (await prisma.order.count({ where: { customerId: owner.customerId } })) === 0;
  },
  instantOrderCap: readInstantOrderCapInputs,
  now: () => new Date(),
});
