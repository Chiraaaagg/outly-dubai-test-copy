import "server-only";
import { prisma } from "../lib/db";
import { SYSTEM_ACTOR } from "../lib/actor";
import { audit } from "../lib/audit";
import { env } from "../lib/env";
import { log } from "../lib/logger";
import { revalidateCatalog } from "../lib/catalog-cache";
import { activitySchema } from "../schemas/activity.schema";
import { FX_INR_PER_AED_SETTING_KEY, MARGIN_COST_INPUTS_SETTING_KEY, marginService } from "./margin.service";
import { ISSUED_TICKET_REFUND_POLICY, MARGIN_POLICY_SETTING_KEY } from "../quotes/contracts";
import type { MarginPolicy, MarginService, ReadinessReason, ReadinessResult, ReadinessService, UnitDefinition } from "../quotes/contracts";
import { PAGE_PAX_AGES, PAGE_PAX_TYPES, pageUnitPrice } from "@/lib/pricing";
import type { Activity, FulfilmentMode, Variant } from "@/lib/types";
import type { ProductMappingReadiness, VariantMappingState } from "./supplier-catalog.service";

/**
 * Readiness: the one evaluation that decides whether a product may sell
 * instantly (doc 22 §22.1 item 3; PRD-4, PRD-11, TKT-7). The same function
 * answers the activation flip, the storefront projection, the quote and the
 * worker send.
 *
 *  - Requested mode is `products.fulfilment_mode` (what an operator asked
 *    for). Effective mode is this evaluation's verdict, stored in
 *    `product_eligibility`. The `fulfilmentMode` copy inside `content` is
 *    never read here.
 *  - Effective is `instant` only when requested is `instant` and no reason
 *    applies. Anything unknown is a reason: the default is inquiry.
 *  - `evaluate` is a read. `reevaluate` also persists the verdict, writes a
 *    system audit row when the effective mode changes and invalidates the
 *    catalogue cache (PRD-19). Every product version write, mapping
 *    approve/revoke, sync and flip calls `reevaluate`.
 *
 * Rules (each produces one reason code):
 *  - release switch on (`INSTANT_RELEASE_ENABLED`);
 *  - product published and not deleted, with valid content (PRD-13);
 *  - editorial `confirmation` is `instant`;
 *  - no add-ons: add-on fulfilment is not part of the supplier booking, so
 *    an instant product with add-ons would promise something nobody books
 *    (`safety_fact_unknown`);
 *  - pickup agrees with the offer: content with pickup needs an offer known
 *    to collect from hotels, and an offer that collects from hotels needs
 *    content with pickup (`safety_fact_unknown`). The hotel itself is checked
 *    against the supplier's list at quote time;
 *  - every active (not sold-out) variant has typed units and a mapping of
 *    its own (a product-level mapping counts only for a single active
 *    variant), the mapping is approved and current, its adapter can book,
 *    its slot rules are known and every unit names a supplier unit the offer
 *    accepts;
 *  - page start times equal the supplier's (doc 29 Batch 0): the times the
 *    activity page offers (`timeSlots`, "HH:mm") are exactly the mapped
 *    offer's stored slot starts, as a set (`slot_times_mismatch`); a page
 *    time that does not parse, a page without times or an offer whose starts
 *    are unknown does not pass. An offer with an "any time" slot is
 *    `slot_any_time_unsupported`, unless it sells as a choice among its
 *    listed starts (doc 29 Batch 2 and Batch 6, `listedStartsSellable`: its exact
 *    listed-start class key is switched on and every slot has a known end:
 *    stored, or start plus the offer's hours, Batch 3b `slotEndMinutes`);
 *    then the same set equality applies to its listed starts. Never an
 *    arbitrary time. An open-dated ticket (doc 29 Batch 5,
 *    `openDatedSellable`: its ticket key switched on, with evidence) passes
 *    only with no page times and no stored slots, and only non-refundable.
 *    A date-only offer (doc 29 Batch 7, `dateOnlySellable`: its exact
 *    date-only key switched on, with evidence) passes only with no page
 *    times and no stored slots: the guest picks the date, and a time only
 *    when a fresh availability read lists several starts. TravelDesk has not
 *    confirmed this reading (Q5, `DATE_ONLY_Q5_UNCONFIRMED`), so the keys
 *    stay off until it does;
 *  - page price equals quote price: every unit is one of the page's pax
 *    types and its authored price equals the price the activity page shows
 *    for that type (`unit_price_mismatch`);
 *  - no traveller restriction the page does not state (CR-B2-10): a unit
 *    limited by residency, by height, or to ages narrower than its pax
 *    type's own definition (`PAGE_PAX_AGES`) is `safety_fact_unknown`.
 *    Nothing checks a traveller against such a unit until checkout collects
 *    traveller declarations (B5), so it cannot be sold instantly before then;
 *  - margin: every unit price meets the versioned floor against the
 *    approved supplier net, in AED and in INR. A floor that cannot be shown
 *    to be met (no net, no FX input, no policy) counts as below it;
 *  - displayed cancellation policy is no more generous than the supplier's
 *    verified refundability. Where tickets may issue at confirmation (`yes`
 *    or `unknown`), only "non-refundable once confirmed" (0 hours) passes
 *    (`ISSUED_TICKET_REFUND_POLICY`, TKT-7);
 *  - the free-text `cancellationPolicy` the page shows states the same hours
 *    as `freeCancellationHours` (`policyTextAgrees`, CR-B2-7), otherwise
 *    `safety_fact_unknown`;
 *  - the supplier catalogue is fresh (doc 29 Batch 1b): the mapped offer was
 *    last read by a sync within `CATALOGUE_STALE_AFTER_MS` (48 h), and the
 *    latest complete catalogue sync for the mapping's supplier and
 *    environment finished within it too, else `catalogue_stale`. Before any
 *    complete run is recorded, the offer's own last-seen time alone decides
 *    (`catalogueSyncedAt` in supplier-catalog.service.ts).
 *
 * Writes of the pricing settings the margin rule reads (margin policy, FX
 * input, cost inputs) re-run readiness for every product that is or asks to
 * be instant (`reevaluateAfterSetting`, CR-B2-8).
 *
 * Combos never reach this function: they are inquiry by rule (doc 22 §22.2).
 */

/**
 * Version of the rule set above; stored with every verdict so a rules change can be re-run.
 * 6 (doc 29 Batch 1a): `capability_not_ready` also when the capability gate refuses the offer's
 * exact class key (supplier-catalog.service.ts `mappingReadinessFor`, suppliers/capability-gate.ts).
 * 7 (doc 29 Batch 1b): `catalogue_stale` when the catalogue is older than 48 h or of unknown age.
 * 8 (doc 29 Batch 1b, review R2): the age is the mapped offer's own last successful read, no later
 * than the latest complete run (which must have read at least one tour).
 * 9 (doc 29 Batch 2): an "any time" offer passes the time rule when it sells as listed starts.
 * 10 (doc 29 Batch 5): an open-dated ticket offer whose ticket key is switched on passes the time rule
 * with no page times and no stored slots, and only with a non-refundable page (0 hours).
 * 11 (doc 29 Batch 3b, TravelDesk OpenAPI `TimeSlotPublicDto.endTime`): a listed-start offer whose slot
 * has no stored end now passes `listedStartsSellable` when the end derives from the offer's hours
 * (start + numberOfHours x 60, not past midnight; `slotEndMinutes`). Bumped at the Batch 3b + 5 merge:
 * Batch 3b changed this fact without a bump, and Batch 5 had taken 10.
 * Not bumped by doc 29 Batch 6: `listedStartsSellable` now also lifts the four external listed-start keys,
 * but only when the gate allows them, and no such flag exists before the batch; switching one on re-runs
 * readiness for its mapped products (supplier-capability.service.ts). No stored verdict can differ, so a bump
 * would only send every instant product to inquiry until the next re-run.
 * Not bumped by doc 29 Batch 7, for the same reason: `dateOnlySellable` lifts `slot_rules_unknown` and the
 * time rule only for the two date-only keys, only when the gate allows them, and no such flag exists before it.
 * Not bumped by doc 30 N1: `inquiry_listing` applies only to products with an imported inquiry link, and no
 * such link exists before N1.
 */
export const READINESS_RULES_VERSION = 11;

/**
 * Per-mapping facts the readiness rules need, adapted from the supplier
 * side's `supplierCatalogService.mappingReadinessFor` (`fromCatalogReadiness`
 * below). Supplier units, nets per unit and refund hours are used when the
 * supplier side reports them; absent or malformed, they read as unknown,
 * which keeps the product inquiry.
 */
export interface MappingReadiness {
  mappingId: string;
  /** `product_supplier_mappings.variant_code`; null maps the whole product. */
  variantId: string | null;
  /** `ready` = active, approved (`approved_offer_hash` set) and matching the current upstream snapshot. */
  state: "ready" | "unapproved" | "inactive" | "changed_upstream" | "missing_upstream";
  approvedOfferHash: string | null;
  /** The adapter can hold and confirm this offer in this environment. */
  capabilityReady: boolean;
  slotRulesKnown: boolean;
  /** The supplier catalogue behind this mapping is within the staleness limit (doc 29 Batch 1b). */
  catalogueFresh: boolean;
  /** Supplier unit codes the offer accepts (TravelDesk: adult, child, infant, trip). */
  supplierUnits: string[];
  /** Approved supplier net per supplier unit, AED minor units; null when unknown. */
  netAedMinorByUnit: Record<string, bigint> | null;
  issuesTicketsAtConfirm: "yes" | "no" | "unknown";
  /** Hours before start the supplier refunds in full: 0 = never, null = unknown. */
  supplierFreeCancellationHours: number | null;
  /** The mapping's supplier environment; absent or null when not reported. */
  environment?: "test" | "production" | null;
  /** Whether the offer collects from hotels (not direct reporting); absent or null = unknown. */
  pickupOffered?: boolean | null;
  /** The supplier account a quote in this environment checks against; absent or null when not reported. */
  accountId?: string | null;
  /** The offer's stored slot starts, minutes after midnight; absent or null = unknown, which never passes. */
  slotStartMinutes?: number[] | null;
  /** Whether the offer has an "any time" slot; absent or null = unknown, which never passes. */
  anyTimeSlots?: boolean | null;
  /** Doc 29 Batch 2: the offer sells as a choice among its listed starts (flag on for its exact key). Absent or null = no. */
  listedStartsSellable?: boolean | null;
  /** Doc 29 Batch 5: the offer is an open-dated ticket sold instantly (flag on for the ticket key, with evidence). Absent or null = no. */
  openDatedSellable?: boolean | null;
  /** Doc 29 Batch 7: the offer lists no slot and sells as date only (flag on for its exact key, with evidence). Absent or null = no. */
  dateOnlySellable?: boolean | null;
}

export interface MappingReadinessSource {
  mappingReadinessFor(productId: string, opts?: { environment?: "test" | "production" }): Promise<MappingReadiness[]>;
}

export interface ReadinessProduct {
  id: string;
  status: string;
  deletedAt: Date | null;
  /** Requested mode: `products.fulfilment_mode`. */
  fulfilmentMode: FulfilmentMode;
  content: unknown;
  /** `products.version`; absent when the loader does not read it. */
  version?: number | null;
  /** Kind of the product's active TravelDesk import link (doc 30 §3.3), when it has one. */
  listingKind?: "instant" | "inquiry" | null;
}

export type ReadinessTrigger =
  | "editor_save"
  | "status_change"
  | "delete"
  | "restore"
  | "restore_version"
  | "import_apply"
  | "import_revert"
  | "mapping_approve"
  | "mapping_revoke"
  /** An administrator recorded whether the mapped offer issues tickets at confirmation. */
  | "ticket_evidence"
  | "sync"
  | "flip"
  /** A fresh supplier check found a refund policy the page no longer fits (quote N1). */
  | "supplier_policy_changed"
  /** A margin policy, FX input or cost-input setting was written (CR-B2-8). */
  | "pricing_settings_changed"
  /** A capability class flag was switched on or off (doc 29 §3.3). */
  | "capability_flag"
  /** Per-offer enablement evidence was recorded or revoked (doc 29 §3.3). */
  | "offer_evidence"
  /** A scheduled catalogue sync did not complete: the catalogue's age is re-checked (doc 29 Batch 1b). */
  | "catalogue_age"
  /** An administrator re-ran readiness from stored facts, without supplier calls (doc 29 §9.4). */
  | "admin_rerun";

/** Settings whose values the margin rule reads; writing one re-runs readiness (`reevaluateAfterSetting`). */
export const PRICING_SETTING_KEYS: readonly string[] = [MARGIN_POLICY_SETTING_KEY, FX_INR_PER_AED_SETTING_KEY, MARGIN_COST_INPUTS_SETTING_KEY];

/** Variants that can be booked: a sold-out variant needs no mapping. */
export function activeVariants(activity: Pick<Activity, "variants">): Variant[] {
  return activity.variants.filter((v) => !v.soldOut);
}

/** The mapping that books one variant, or null. A product-level mapping only serves a single-variant product. */
export function mappingForVariant(mappings: MappingReadiness[], variantId: string, activeCount: number): MappingReadiness | null {
  return mappings.find((m) => m.variantId === variantId) ?? (activeCount === 1 ? (mappings.find((m) => m.variantId === null) ?? null) : null);
}

/**
 * Whether the displayed policy fits the supplier's (TKT-7). `displayedHours`
 * is the content's `freeCancellationHours` (0 = non-refundable).
 */
export function policyWithinSupplier(displayedHours: number, m: Pick<MappingReadiness, "issuesTicketsAtConfirm" | "supplierFreeCancellationHours">): boolean {
  if (m.issuesTicketsAtConfirm !== "no") {
    // ISSUED_TICKET_REFUND_POLICY: tickets may already exist after confirmation, so only "non-refundable once confirmed" is honest.
    return ISSUED_TICKET_REFUND_POLICY === "non_refundable_after_confirm_only" && displayedHours === 0;
  }
  if (displayedHours === 0) return true;
  // The customer's deadline must fall at or before the supplier's: more hours before start is stricter.
  return m.supplierFreeCancellationHours !== null && m.supplierFreeCancellationHours > 0 && displayedHours >= m.supplierFreeCancellationHours;
}

/**
 * Pickup in content against the offer. Content that promises pickup needs an
 * offer known to collect; an offer known to collect needs a hotel, which
 * content without pickup never asks for. Unknown passes only for content
 * without pickup: the quote's supplier check then refuses a missing hotel.
 */
export function pickupAgrees(pickupIncluded: boolean, pickupOffered: boolean | null): boolean {
  return pickupIncluded ? pickupOffered === true : pickupOffered !== true;
}

/**
 * The page and the quote charge the same authored amount (CR-B2-11). The
 * activity page prices pax types from the price band plus the variant delta
 * (`pageUnitPrice`); the quote prices typed units. A unit is sellable
 * instantly only when it is one of those pax types and both prices agree in
 * both currencies.
 */
export function unitPriceShown(activity: Activity, variant: Variant, unit: UnitDefinition): boolean {
  const type = PAGE_PAX_TYPES.find((t) => t === unit.unitId);
  if (!type) return false;
  const shown = pageUnitPrice(activity, variant, type);
  return shown.inr === unit.price.inr && shown.aed === unit.price.aed;
}

/**
 * A traveller restriction the activity page does not show (CR-B2-10):
 * residency other than `any`, any height bound, or an age range narrower
 * than the unit's pax type as the page defines it (`PAGE_PAX_AGES`). A unit
 * that is not a page pax type counts as restricted.
 */
export function unitRestricted(unit: UnitDefinition): boolean {
  if (unit.residency !== "any" || unit.heightMinCm !== null || unit.heightMaxCm !== null) return true;
  const type = PAGE_PAX_TYPES.find((t) => t === unit.unitId);
  if (!type) return true;
  const page = PAGE_PAX_AGES[type];
  if (unit.ageMin !== null && unit.ageMin > (page.min ?? 0)) return true;
  if (unit.ageMax !== null && (page.max === null || unit.ageMax < page.max)) return true;
  return false;
}

/**
 * Durations a cancellation text states, in hours: digits followed by
 * "hour(s)", "hr(s)", "h" or "day(s)" (a day is 24 hours). Written-out
 * numbers ("one day") are not read.
 */
export function statedPolicyHours(text: string): number[] {
  return [...text.matchAll(/(\d{1,4})\s*(hours?|hrs?|h|days?)\b/gi)].map((m) => Number(m[1]) * (/^d/i.test(m[2]) ? 24 : 1));
}

/**
 * Whether the free-text policy the page shows agrees with
 * `freeCancellationHours` (CR-B2-7). Deliberately simple and strict:
 *  - hours > 0: the text states at least one duration and every duration it
 *    states equals the hours. A tiered text ("72 hours …, 50% within 24
 *    hours") does not pass; the quote records one full-refund deadline only;
 *  - 0 hours: the text states no duration and mentions no refund or
 *    cancellation at all, apart from a leading "Non-refundable" (the only
 *    honest wording under `ISSUED_TICKET_REFUND_POLICY`). "Fully refundable
 *    until the day before" or "Cancel anytime for a refund" with 0 hours is
 *    the CR-B2-7 case in other words, so it does not pass.
 */
export function policyTextAgrees(text: string, hours: number): boolean {
  const stated = statedPolicyHours(text);
  if (hours === 0) return stated.length === 0 && !/refund|cancel/i.test(text.replace(NON_REFUNDABLE_LEAD, ""));
  return stated.length > 0 && stated.every((h) => h === hours);
}

/** A page start time, "HH:mm" on the 24-hour clock, as minutes after midnight; null for anything else ("Flexible", "9 pm"). */
export function pageStartMinutes(time: string): number | null {
  const m = /^([01]\d|2[0-3]):([0-5]\d)$/.exec(time.trim());
  return m ? Number(m[1]) * 60 + Number(m[2]) : null;
}

/**
 * Whether the page's start times are the mapped offer's (doc 29 Batch 0).
 * Exact set equality with the stored slot starts; never more permissive:
 * an unparseable page time, no page time or unknown supplier starts refuse,
 * and so does an "any time" slot unless the offer sells as listed starts
 * (Batch 2), whose listed starts must then equal the page's times.
 */
export function slotTimesAgree(
  pageTimes: readonly string[],
  m: Pick<MappingReadiness, "slotStartMinutes" | "anyTimeSlots" | "listedStartsSellable" | "openDatedSellable" | "dateOnlySellable">,
): "ok" | "slot_times_mismatch" | "slot_any_time_unsupported" {
  // Batch 5: an open-dated ticket has no start time. The page must offer none, and the offer must store none.
  // Batch 7: a date-only offer stores none either; its times, if any, come from a fresh availability read on the page.
  if (m.openDatedSellable === true || m.dateOnlySellable === true) {
    return pageTimes.length === 0 && Array.isArray(m.slotStartMinutes) && m.slotStartMinutes.length === 0 && m.anyTimeSlots === false ? "ok" : "slot_times_mismatch";
  }
  if (m.anyTimeSlots === null || m.anyTimeSlots === undefined) return "slot_times_mismatch";
  // Batch 2: "any time" sells only as one of the listed starts, below, and only with its flag on.
  if (m.anyTimeSlots === true && m.listedStartsSellable !== true) return "slot_any_time_unsupported";
  const supplier = m.slotStartMinutes;
  if (!supplier || supplier.length === 0) return "slot_times_mismatch";
  const page = pageTimes.map(pageStartMinutes);
  if (page.length === 0 || page.some((p) => p === null)) return "slot_times_mismatch";
  const pageSet = new Set(page as number[]);
  const supplierSet = new Set(supplier);
  if (pageSet.size !== supplierSet.size) return "slot_times_mismatch";
  for (const p of pageSet) if (!supplierSet.has(p)) return "slot_times_mismatch";
  return "ok";
}

/** The one refund word a 0-hour text may carry, and only as its opening. */
const NON_REFUNDABLE_LEAD = /^\s*non[-\s]?refundable\b/i;

export interface ReadinessInput {
  product: ReadinessProduct | null;
  /** null when the supplier seam is not available: every variant is then unmapped. */
  mappings: MappingReadiness[] | null;
  releaseEnabled: boolean;
  margin: MarginService | null;
}

export interface ReadinessAssessment {
  requested: FulfilmentMode;
  effective: FulfilmentMode;
  reasons: ReadinessReason[];
  /** Validated content, when it parsed. */
  activity: Activity | null;
  /** `products.version` of the content assessed, when known. */
  productVersion: number | null;
  mappings: MappingReadiness[];
}

async function unitMeetsFloor(margin: MarginService, policy: MarginPolicy, unit: UnitDefinition, netAedMinor: bigint): Promise<boolean> {
  for (const currency of ["AED", "INR"] as const) {
    const chargedMinor = BigInt(currency === "AED" ? unit.price.aed : unit.price.inr) * 100n;
    if (chargedMinor === 0n) {
      if (netAedMinor > 0n) return false;
      continue;
    }
    const r = await margin.evaluate({ chargedMinor, currency, supplierNetAedMinor: netAedMinor, policy });
    if (!r.ok) return false;
  }
  return true;
}

/** Every rule, in one pass. Reasons are listed once each, in rule order. */
export async function assessReadiness(input: ReadinessInput): Promise<ReadinessAssessment> {
  const reasons = new Set<ReadinessReason>();
  const product = input.product;
  const requested: FulfilmentMode = product?.fulfilmentMode === "instant" ? "instant" : "inquiry";
  const mappings = input.mappings ?? [];

  if (!input.releaseEnabled) reasons.add("release_switch_off");
  if (!product || product.deletedAt || product.status !== "published") reasons.add("not_published");

  const parsed = product ? activitySchema.safeParse(product.content) : null;
  const activity = parsed?.success ? (parsed.data as Activity) : null;
  const productVersion = product?.version ?? null;
  if (!activity) {
    reasons.add("not_published");
    return { requested, effective: "inquiry", reasons: [...reasons], activity: null, productVersion, mappings };
  }

  // Doc 30 D4: an imported inquiry listing holds only never-instant offers, whatever its document says.
  if (product?.listingKind === "inquiry") reasons.add("inquiry_listing");
  if (activity.confirmation !== "instant") reasons.add("editorial_confirmation_not_instant");
  if (activity.addOns.length > 0) reasons.add("safety_fact_unknown");
  if (!policyTextAgrees(activity.cancellationPolicy, activity.freeCancellationHours)) reasons.add("safety_fact_unknown");

  const variants = activeVariants(activity);
  if (variants.length === 0) reasons.add("units_missing");

  let policy: MarginPolicy | null = null;
  if (input.margin) {
    try {
      policy = await input.margin.currentPolicy();
    } catch {
      policy = null;
    }
  }

  for (const v of variants) {
    const units = v.units ?? [];
    if (units.length === 0) reasons.add("units_missing");
    const m = input.mappings ? mappingForVariant(mappings, v.id, variants.length) : null;
    if (!m) {
      reasons.add("variant_without_mapping");
      continue;
    }
    if (m.state === "unapproved" || !m.approvedOfferHash) reasons.add("variant_without_mapping");
    else if (m.state === "inactive") reasons.add("mapping_inactive");
    else if (m.state === "changed_upstream") reasons.add("mapping_changed_upstream");
    else if (m.state === "missing_upstream") reasons.add("mapping_missing_upstream");
    if (!m.capabilityReady) reasons.add("capability_not_ready");
    if (!m.slotRulesKnown) reasons.add("slot_rules_unknown");
    if (!m.catalogueFresh) reasons.add("catalogue_stale");
    const times = slotTimesAgree(activity.timeSlots, m);
    if (times !== "ok") reasons.add(times);
    if (!policyWithinSupplier(activity.freeCancellationHours, m)) reasons.add("policy_exceeds_supplier");
    // Batch 5: issued tickets can never be cancelled, so a ticket page offers no free cancellation, whatever evidence says.
    if (m.openDatedSellable === true && activity.freeCancellationHours !== 0) reasons.add("policy_exceeds_supplier");
    if (!pickupAgrees(activity.pickupIncluded, m.pickupOffered ?? null)) reasons.add("safety_fact_unknown");
    if (!units.every((u) => unitPriceShown(activity, v, u))) reasons.add("unit_price_mismatch");
    if (units.some(unitRestricted)) reasons.add("safety_fact_unknown");

    for (const unit of units) {
      if (!m.supplierUnits.includes(unit.supplierUnit)) {
        reasons.add("unit_not_mapped");
        continue;
      }
      const net = m.netAedMinorByUnit?.[unit.supplierUnit];
      if (!input.margin || !policy || net === undefined || net === null) {
        reasons.add("margin_below_floor");
        continue;
      }
      if (!(await unitMeetsFloor(input.margin, policy, unit, net))) reasons.add("margin_below_floor");
    }
    // Every supplier unit that carries a net cost must be sold through a content
    // unit. Otherwise a per-trip offer could be sold per adult (net 0) and the
    // margin check would pass on a cost it never sees.
    const soldUnits = new Set(units.map((u) => u.supplierUnit));
    for (const [supplierUnit, net] of Object.entries(m.netAedMinorByUnit ?? {})) {
      if (net !== null && net > 0n && !soldUnits.has(supplierUnit)) reasons.add("unit_not_mapped");
    }
  }

  const list = [...reasons];
  return { requested, effective: requested === "instant" && list.length === 0 ? "instant" : "inquiry", reasons: list, activity, productVersion, mappings };
}

/* ---------------------------------------------------------------------------
 * Service
 * ------------------------------------------------------------------------ */

export interface EligibilityRow {
  effectiveMode: FulfilmentMode;
  reasons: ReadinessReason[];
  /** The rules version the stored verdict was made under; absent when the reader does not report it. */
  readinessVersion?: number;
}

export interface ReadinessDeps {
  loadProducts(ids: string[]): Promise<ReadinessProduct[]>;
  /** null when the supplier seam is not wired. */
  mappingSource(): Promise<MappingReadinessSource | null>;
  releaseEnabled(): boolean;
  margin(): MarginService | null;
  readEligibility(ids: string[]): Promise<Map<string, EligibilityRow>>;
  /** Products requested instant or with an instant verdict on record: the ones a pricing setting can change. */
  listInstantCandidates(): Promise<string[]>;
  writeEligibility(productId: string, row: EligibilityRow & { readinessVersion: number; evaluatedAt: Date }): Promise<void>;
  auditChange(productId: string, before: EligibilityRow | null, after: EligibilityRow, trigger: ReadinessTrigger): Promise<void>;
  invalidateCatalog(): void;
  now(): Date;
}

export interface ReadinessServiceImpl extends ReadinessService {
  /** `evaluate` plus the parsed content and mapping facts, for the quote path. */
  assess(productId: string, opts?: { environment?: "test" | "production" }): Promise<ReadinessAssessment & { result: ReadinessResult }>;
  /** Evaluate, persist, audit a change and invalidate the catalogue cache. Never throws: a failure demotes to inquiry. */
  reevaluate(productId: string, trigger: ReadinessTrigger): Promise<ReadinessResult | null>;
  reevaluateMany(productIds: string[], trigger: ReadinessTrigger): Promise<void>;
  /**
   * Call after writing a setting. For a pricing key (`PRICING_SETTING_KEYS`)
   * re-runs readiness for every instant candidate; any other key is a no-op.
   * Never throws: a failure to list candidates is logged.
   */
  reevaluateAfterSetting(key: string): Promise<void>;
  /**
   * Re-run readiness for every product that is or asks to be instant. Never
   * throws: a failure to list candidates is logged. Used when a scheduled
   * catalogue sync did not complete, so an ageing catalogue reaches the
   * storefront without waiting for the next sync (doc 29 Batch 1b).
   */
  reevaluateInstantCandidates(trigger: ReadinessTrigger): Promise<void>;
}

/**
 * N6: a quote that found the supplier's refund terms tighter than the page
 * re-runs readiness, but the rules read the stored, approved facts, which
 * still pass. Left alone, the product would stay instant (badge included)
 * until the next sync, with every quote refused. The trigger itself is the
 * evidence, so the verdict is demoted to inquiry with
 * `policy_exceeds_supplier`; the next sync or mapping approval re-runs
 * readiness on fresh facts and restores it when they agree again.
 */
export function demotedForTrigger(result: ReadinessResult, trigger: ReadinessTrigger): ReadinessResult {
  if (trigger !== "supplier_policy_changed" || result.effective !== "instant") return result;
  return { ...result, effective: "inquiry", reasons: [...new Set([...result.reasons, "policy_exceeds_supplier" as const])] };
}

export function createReadinessService(deps: ReadinessDeps): ReadinessServiceImpl {
  async function assessOne(product: ReadinessProduct | null, productId: string, environment?: "test" | "production") {
    const source = await deps.mappingSource();
    const mappings = source && product ? await source.mappingReadinessFor(productId, { environment }) : null;
    const assessment = await assessReadiness({ product, mappings, releaseEnabled: deps.releaseEnabled(), margin: deps.margin() });
    const result: ReadinessResult = {
      productId,
      requested: assessment.requested,
      effective: assessment.effective,
      reasons: assessment.reasons,
      readinessVersion: READINESS_RULES_VERSION,
      evaluatedAt: deps.now().toISOString(),
    };
    return { ...assessment, result };
  }

  async function persist(productId: string, before: EligibilityRow | null, after: EligibilityRow, trigger: ReadinessTrigger) {
    // A verdict stored under an older rules version is rewritten even when unchanged, or the storefront keeps reading it as stale.
    const current = before?.readinessVersion === undefined || before.readinessVersion === READINESS_RULES_VERSION;
    const same = before && current && before.effectiveMode === after.effectiveMode && JSON.stringify(before.reasons) === JSON.stringify(after.reasons);
    if (same) return;
    await deps.writeEligibility(productId, { ...after, readinessVersion: READINESS_RULES_VERSION, evaluatedAt: deps.now() });
    const wasMode = before?.effectiveMode ?? "inquiry";
    if (wasMode !== after.effectiveMode) {
      await deps.auditChange(productId, before, after, trigger);
      deps.invalidateCatalog();
    }
  }

  async function demote(productId: string, before: EligibilityRow | null, trigger: ReadinessTrigger, error: unknown) {
    log.error("readiness.evaluate_failed", { productId, trigger, error });
    try {
      await persist(productId, before, { effectiveMode: "inquiry", reasons: ["capability_not_ready"] }, trigger);
    } catch (writeError) {
      log.error("readiness.demote_failed", { productId, trigger, error: writeError });
    }
  }

  const service: ReadinessServiceImpl = {
    async evaluate(productId, opts) {
      return (await service.assess(productId, opts)).result;
    },

    async assess(productId, opts) {
      const [product] = await deps.loadProducts([productId]);
      return assessOne(product ?? null, productId, opts?.environment);
    },

    async reevaluate(productId, trigger) {
      let before: EligibilityRow | null = null;
      try {
        before = (await deps.readEligibility([productId])).get(productId) ?? null;
        const [product] = await deps.loadProducts([productId]);
        const { result: assessed } = await assessOne(product ?? null, productId);
        const result = demotedForTrigger(assessed, trigger);
        await persist(productId, before, { effectiveMode: result.effective, reasons: result.reasons }, trigger);
        return result;
      } catch (error) {
        await demote(productId, before, trigger, error);
        return null;
      }
    },

    async reevaluateMany(productIds, trigger) {
      const ids = [...new Set(productIds)];
      if (!ids.length) return;
      let products: ReadinessProduct[];
      let rows: Map<string, EligibilityRow>;
      try {
        [products, rows] = await Promise.all([deps.loadProducts(ids), deps.readEligibility(ids)]);
      } catch (error) {
        for (const id of ids) await demote(id, null, trigger, error);
        return;
      }
      const byId = new Map(products.map((p) => [p.id, p]));
      for (const id of ids) {
        const p = byId.get(id);
        const row = rows.get(id) ?? null;
        // Requested inquiry with no instant verdict on record: nothing the storefront shows can change, so skip
        // the supplier and margin reads (a 500-row import must not cost 1,500 round trips).
        if ((!p || p.fulfilmentMode !== "instant") && (!row || row.effectiveMode !== "instant")) continue;
        await service.reevaluate(id, trigger);
      }
    },

    async reevaluateAfterSetting(key) {
      if (!PRICING_SETTING_KEYS.includes(key)) return;
      await service.reevaluateInstantCandidates("pricing_settings_changed");
    },

    async reevaluateInstantCandidates(trigger) {
      let ids: string[];
      try {
        ids = await deps.listInstantCandidates();
      } catch (error) {
        log.error("readiness.candidates_failed", { trigger, error });
        return;
      }
      await service.reevaluateMany(ids, trigger);
    },
  };
  return service;
}

/* ---------------------------------------------------------------------------
 * Production wiring
 * ------------------------------------------------------------------------ */

/**
 * Facts the supplier side adds to a variant's mapping (`supplierUnits`,
 * `netAedMinorByUnit`, `supplierFreeCancellationHours`). Read defensively:
 * an absent or malformed fact is unknown, which keeps the product inquiry.
 */
function supplierUnitsOf(raw: unknown): string[] {
  return Array.isArray(raw) ? raw.filter((u): u is string => typeof u === "string" && u.length > 0) : [];
}

function minorOf(raw: unknown): bigint | null {
  if (typeof raw === "bigint") return raw >= 0n ? raw : null;
  if (typeof raw === "number") return Number.isSafeInteger(raw) && raw >= 0 ? BigInt(raw) : null;
  if (typeof raw === "string") return /^\d{1,15}$/.test(raw) ? BigInt(raw) : null;
  return null;
}

/** Per-unit nets; a unit whose net is not a whole non-negative minor amount is left out (unknown). */
function netsOf(raw: unknown): Record<string, bigint> | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const out: Record<string, bigint> = {};
  for (const [unit, value] of Object.entries(raw)) {
    const n = minorOf(value);
    if (n !== null) out[unit] = n;
  }
  return Object.keys(out).length ? out : null;
}

/** Stored slot starts: whole minutes within a day; anything else reads as unknown. */
function startsOf(raw: unknown): number[] | null {
  if (!Array.isArray(raw)) return null;
  return raw.every((x) => typeof x === "number" && Number.isInteger(x) && x >= 0 && x < 24 * 60) ? (raw as number[]) : null;
}

function hoursOf(raw: unknown): number | null {
  return typeof raw === "number" && Number.isFinite(raw) && raw >= 0 ? raw : null;
}

function stateOf(v: VariantMappingState): MappingReadiness["state"] {
  if (v.blockers.includes("mapping_inactive")) return "inactive";
  if (v.blockers.includes("mapping_missing_upstream")) return "missing_upstream";
  if (!v.mapping?.approvedOfferHash) return "unapproved";
  if (v.blockers.includes("mapping_changed_upstream")) return "changed_upstream";
  return "ready";
}

/**
 * The supplier catalogue's per-variant states as readiness facts. The
 * mapping's OWN variant code is kept (null for a whole-product mapping), so
 * the rule "a whole-product mapping serves only a single active variant"
 * stays here; one mapping listed under several variants is reported once.
 */
export function fromCatalogReadiness(r: ProductMappingReadiness): MappingReadiness[] {
  const out = new Map<string, MappingReadiness>();
  for (const v of r.variants) {
    if (!v.mapping) continue;
    const facts = v.mapping;
    const extra = facts as unknown as Record<string, unknown>;
    const key = `${facts.mappingId}:${facts.variantCode ?? ""}`;
    if (out.has(key)) continue;
    out.set(key, {
      mappingId: facts.mappingId,
      variantId: facts.variantCode,
      state: stateOf(v),
      approvedOfferHash: facts.approvedOfferHash,
      capabilityReady: !v.blockers.includes("capability_not_ready"),
      slotRulesKnown: !v.blockers.includes("slot_rules_unknown"),
      catalogueFresh: !v.blockers.includes("catalogue_stale"),
      supplierUnits: supplierUnitsOf(extra.supplierUnits),
      netAedMinorByUnit: netsOf(extra.netAedMinorByUnit),
      issuesTicketsAtConfirm: facts.issuesTicketsAtConfirm,
      supplierFreeCancellationHours: hoursOf(extra.supplierFreeCancellationHours),
      environment: facts.environment,
      pickupOffered: typeof extra.isDirectReporting === "boolean" ? !extra.isDirectReporting : null,
      accountId: typeof extra.accountId === "string" && extra.accountId.length > 0 ? extra.accountId : null,
      slotStartMinutes: startsOf(extra.slotStartMinutes),
      anyTimeSlots: typeof extra.anyTimeSlots === "boolean" ? extra.anyTimeSlots : null,
      listedStartsSellable: extra.listedStartsSellable === true,
      openDatedSellable: extra.openDatedSellable === true,
      dateOnlySellable: extra.dateOnlySellable === true,
    });
  }
  return [...out.values()];
}

/**
 * The supplier catalogue seam. Loaded lazily so the supplier catalogue can
 * import this module for its re-evaluation hooks without a load-time cycle.
 * The environment is the deployment's TravelDesk environment; unset counts
 * as production, whose mappings are the strictest.
 */
async function supplierMappingSource(): Promise<MappingReadinessSource> {
  const { supplierCatalogService } = await import("./supplier-catalog.service");
  return {
    async mappingReadinessFor(productId, opts) {
      const environment = opts?.environment ?? env().TRAVELDESK_ENV ?? "production";
      return fromCatalogReadiness(await supplierCatalogService.mappingReadinessFor(productId, environment));
    },
  };
}

function asReasons(raw: unknown): ReadinessReason[] {
  return Array.isArray(raw) ? (raw.filter((r) => typeof r === "string") as ReadinessReason[]) : [];
}

/** Products requested instant or with an instant verdict on record: every product whose storefront mode readiness can change. */
export async function listInstantCandidates(): Promise<string[]> {
  const [requested, verdicts] = await Promise.all([
    prisma.product.findMany({ where: { fulfilmentMode: "instant" }, select: { id: true } }),
    prisma.productEligibility.findMany({ where: { effectiveMode: "instant" }, select: { productId: true } }),
  ]);
  return [...new Set([...requested.map((p) => p.id), ...verdicts.map((r) => r.productId)])];
}

export const readinessService = createReadinessService({
  async loadProducts(ids) {
    const rows = await prisma.product.findMany({ where: { id: { in: ids } }, select: { id: true, status: true, deletedAt: true, fulfilmentMode: true, content: true, version: true, listingLink: { select: { kind: true, deactivatedAt: true } } } });
    return rows.map(({ listingLink, ...p }) => ({ ...p, listingKind: listingLink && !listingLink.deactivatedAt ? (listingLink.kind === "inquiry" ? "inquiry" : "instant") : null }));
  },
  mappingSource: supplierMappingSource,
  releaseEnabled: () => env().INSTANT_RELEASE_ENABLED === true,
  margin: () => marginService,
  async readEligibility(ids) {
    const rows = await prisma.productEligibility.findMany({ where: { productId: { in: ids } }, select: { productId: true, effectiveMode: true, reasons: true, readinessVersion: true } });
    return new Map(rows.map((r) => [r.productId, { effectiveMode: r.effectiveMode, reasons: asReasons(r.reasons), readinessVersion: r.readinessVersion }]));
  },
  listInstantCandidates,
  async writeEligibility(productId, row) {
    const data = { effectiveMode: row.effectiveMode, reasons: row.reasons, readinessVersion: row.readinessVersion, evaluatedAt: row.evaluatedAt };
    await prisma.productEligibility.upsert({ where: { productId }, create: { productId, ...data }, update: data });
  },
  async auditChange(productId, before, after, trigger) {
    await audit(SYSTEM_ACTOR, "product.eligibility", { type: "product", id: productId }, {
      before: before ? { effectiveMode: before.effectiveMode, reasons: before.reasons } : { effectiveMode: "inquiry", reasons: [] },
      after: { effectiveMode: after.effectiveMode, reasons: after.reasons },
      reason: `readiness: ${trigger}`,
    });
  },
  invalidateCatalog: revalidateCatalog,
  now: () => new Date(),
});
