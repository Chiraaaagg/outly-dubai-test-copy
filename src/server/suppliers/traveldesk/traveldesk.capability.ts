import { z } from "zod";
import { slotEndMinutes } from "./traveldesk.offer-terms";

/**
 * Booking capability of one TravelDesk offer (doc 29 §3.1, §3.3; Batch 1a).
 *
 * `deriveCapabilities` reads a stored offer payload (what the catalogue sync
 * writes in `supplier_catalogue_items.payload`) and returns five independent
 * dimensions plus the composed `classKey`, e.g.
 * `live.fixed_slot_single.self.internal.per_person`. The vocabulary is the one
 * of the coverage ledger (`docs/backend/29a-offer-coverage-ledger.csv`).
 *
 * Fail closed: an unreadable payload, a raw value outside the known set, or a
 * shape the ledger never saw (mixed any-time and fixed slots, a slot whose
 * route disagrees with its offer, a ticket with slots, direct collection,
 * an on-request slot on a live offer, no AED price) makes the class
 * `unknown`, which can never be switched on. Facts that keep the class but
 * need a person's review (a slot unit count other than 1) go to
 * `reviewReasons`, which also refuse instant sale.
 *
 * `capabilityVerdict` is the gate: instant only when the class is a sale
 * class, nothing waits for review, the flag for that exact class key and
 * environment is on, and, where the flag asks for it, the offer has
 * evidence recorded for that key and its current terms.
 *
 * Pure: no env, db or logger.
 */

/** Bump when a rule below changes; stored with every derived row. It never turns a flag on. */
export const CAPABILITY_DERIVATION_VERSION = 1;

export const CAP_FULFILMENT = ["live", "ticket", "on_request", "unknown"] as const;
export const CAP_TIME_SHAPES = [
  "fixed_slot_single",
  "fixed_slot_choice",
  "listed_start_single",
  "listed_starts_customer_selected",
  "date_only_no_slot_metadata",
  "open_dated",
  "unknown",
] as const;
export const CAP_ARRIVALS = ["self", "pickup_required", "unknown"] as const;
export const CAP_ROUTES = ["internal", "external", "unknown"] as const;
export const CAP_PRICING = ["per_person", "per_unit", "mixed_person_plus_unit", "unknown"] as const;

export type CapFulfilment = (typeof CAP_FULFILMENT)[number];
export type CapTimeShape = (typeof CAP_TIME_SHAPES)[number];
export type CapArrival = (typeof CAP_ARRIVALS)[number];
export type CapRoute = (typeof CAP_ROUTES)[number];
export type CapPricing = (typeof CAP_PRICING)[number];

/** Class of an offer any dimension of which is unknown. Never sellable. */
export const UNKNOWN_CLASS = "unknown";
/** Class of an on-request offer: inquiry by nature, never instant. */
export const INQUIRY_CLASS = "inquiry_only";

/**
 * The two keys seeded on by migration 20261122120000 (doc 29 §3.3, the named
 * exception to the two-person rule): the classes the single `live_book` gate
 * already let through and that a sandbox drill proved end to end. Every other
 * key starts off.
 */
export const SEEDED_CLASS_KEYS: readonly string[] = Object.freeze([
  "live.fixed_slot_single.self.internal.per_person",
  "live.fixed_slot_choice.self.internal.per_person",
]);

/**
 * The two Batch 2 keys (doc 29 §3.3, §7.3): the guest picks one of the
 * supplier's listed start times ("any time" slots), self arrival, internal
 * route, per-person price. No migration seeds them: they have no flag row,
 * which reads as off, until an owner switches them on through the approval
 * path. Like every key outside `SEEDED_CLASS_KEYS` (Batch 3's rule in
 * `capabilityVerdict`), each offer then also needs evidence for that exact key
 * and its current terms, whatever its flag row says. Owner decision 6
 * (22 Nov 2026): listed starts only, never an arbitrary time.
 */
export const LISTED_START_CLASS_KEYS: readonly string[] = Object.freeze([
  "live.listed_start_single.self.internal.per_person",
  "live.listed_starts_customer_selected.self.internal.per_person",
]);

/**
 * Whether an offer may sell as a choice among its listed starts (Batch 2):
 * the capability gate allowed its exact class key (`gateAllows`), that key is
 * one of `LISTED_START_SELLABLE_KEYS` (Batch 2's two internal self-arrival
 * keys, and Batch 6's four external listed-start keys; an internal
 * listed-start key with pickup is never lifted here, even if its flag were
 * on, because no batch proved it), and
 * every stored slot is an "any time" slot whose end time is known: stored,
 * or start plus the offer's hours when none is stored (`slotEndMinutes`,
 * OpenAPI `TimeSlotPublicDto.endTime`), because the booking sends that end
 * (engine-saga.service.ts). Unknown slots or hours never pass.
 */
export function listedStartsSellable(
  gateAllows: boolean,
  classKey: string,
  slots: readonly { isAnyTime: boolean; startMinutes: number; endMinutes: number | null }[] | null | undefined,
  durationHours?: number | null,
): boolean {
  if (!gateAllows || !LISTED_START_SELLABLE_KEYS.includes(classKey) || !slots || slots.length === 0) return false;
  return slots.every((s) => s.isAnyTime && slotEndMinutes(s, durationHours) !== null);
}

/**
 * The keys Batch 3 builds (doc 29 §3.3, §7.3 Batch 3): fixed start, hotel
 * pickup, internal route, per person; 43 offers in the coverage ledger
 * (42 single start, 1 choice). They are **not seeded**: no flag row means
 * off, and switching one on goes through the approval path
 * (supplier-capability.service.ts) with per-offer evidence for that exact
 * key, which `capabilityVerdict` always asks of a key outside
 * `SEEDED_CLASS_KEYS`. Before any of them goes on: a sandbox booking carrying
 * a hotel id, then one supervised production pickup booking, each with its
 * own approval. Per-unit pickup keys stay inquiry (owner decision 7). The
 * listed-start pickup keys (Batch 2's time shape with pickup, e.g.
 * `live.listed_starts_customer_selected.pickup_required.internal.per_person`)
 * are not listed here: no internal per-person offer has that shape in the
 * ledger. They stay off like any key without a flag row.
 */
export const PICKUP_CLASS_KEYS: readonly string[] = Object.freeze([
  "live.fixed_slot_single.pickup_required.internal.per_person",
  "live.fixed_slot_choice.pickup_required.internal.per_person",
]);

/**
 * The five Batch 6 keys (doc 29 §3.3, §7.3 Batch 6, reduced scope of
 * 24 November 2026): the external-supplier route (`isExternal`: TravelDesk
 * books through a third party, confirmation may stay "in progress" for
 * minutes), per-person price only; 57 offers in the coverage ledger
 * (1 + 31 + 17 + 5 + 3). Batch 4 is skipped, so the three external per-unit
 * keys (22 offers) stay inquiry (`private_units_inquiry`, and the database
 * refuses an enabled per-unit flag). **Not seeded**: no flag row means off.
 * Switching one on goes through the approval path with per-offer evidence
 * for that exact key, which `capabilityVerdict` always asks of a key outside
 * `SEEDED_CLASS_KEYS`. The sandbox has no external offer, so the sandbox
 * drill is "not possible": the proof is one supervised production booking
 * per key, each approved by the owner on its own. Any other external key
 * (a time shape or arrival the ledger has no external offer for) stays
 * refused (`external_route_unproven`). The booking path for these keys is in
 * `src/server/suppliers/external-confirmation.ts`.
 */
export const EXTERNAL_CLASS_KEYS: readonly string[] = Object.freeze([
  "live.fixed_slot_single.self.external.per_person",
  "live.listed_start_single.self.external.per_person",
  "live.listed_starts_customer_selected.self.external.per_person",
  "live.listed_start_single.pickup_required.external.per_person",
  "live.listed_starts_customer_selected.pickup_required.external.per_person",
]);

/**
 * Review 89 B6-09 (doc 29 §9.4): the class keys of enabled flag rows on the
 * external route. Batch 6 leaves the readiness rules version unchanged on the
 * premise that no such row exists before its own switch-on; a row found here
 * means readiness must be re-run after the deploy (admin capabilities page).
 */
export function externalFlagsEnabled(flags: readonly { classKey: string; enabled: boolean }[]): string[] {
  return flags.filter((f) => f.enabled && f.classKey.split(".")[3] === "external").map((f) => f.classKey).sort();
}

/**
 * Keys that may sell as a choice among their listed starts
 * (`listedStartsSellable`): Batch 2's two internal self-arrival keys and the
 * four listed-start keys of Batch 6 (external route, self arrival or pickup).
 */
export const LISTED_START_SELLABLE_KEYS: readonly string[] = Object.freeze([
  ...LISTED_START_CLASS_KEYS,
  ...EXTERNAL_CLASS_KEYS.filter((k) => k.split(".")[1].startsWith("listed_start")),
]);

/**
 * The two Batch 7 keys (doc 29 §3.3, §7.3 Batch 7): a live-book offer whose
 * tour metadata lists no time slot at all ("date only"), internal route,
 * per-person price, with self arrival (22 offers in the coverage ledger) or
 * hotel pickup (2). **Not seeded**: no flag row means off. Switching one on
 * goes through the approval path with per-offer evidence for that exact key,
 * which `capabilityVerdict` asks of every key outside `SEEDED_CLASS_KEYS`.
 *
 * Built switched off on the safe reading of TravelDesk's own documentation
 * while our question Q5 ("which slot id and times should a booking send?")
 * is unanswered: the booking sends `timeSlotId`, `startTime` and `endTime`
 * copied from a fresh availability row for that offer and date
 * (`dateOnlyStartsFrom`, `quoteSlot`), never values we make up. See
 * `DATE_ONLY_Q5_UNCONFIRMED`: the flags stay off until TravelDesk answers
 * and one supervised booking proves each key. Any other date-only key
 * (external route, per unit) stays refused (`date_only_inquiry`).
 */
export const DATE_ONLY_CLASS_KEYS: readonly string[] = Object.freeze([
  "live.date_only_no_slot_metadata.self.internal.per_person",
  "live.date_only_no_slot_metadata.pickup_required.internal.per_person",
]);

/**
 * Readiness note for the Batch 7 keys, shown beside them on the admin
 * capability screen (`capabilityKeyNote`). TravelDesk has not answered Q5,
 * so the time values a date-only booking sends rest on our reading of their
 * documentation, not on their confirmation.
 */
export const DATE_ONLY_Q5_UNCONFIRMED =
  "TravelDesk has not confirmed which slot id and times a date-only booking sends (question Q5). Keep this class off until TravelDesk answers and one supervised booking proves this exact key.";

/**
 * The code lock on the Batch 7 keys (owner decision d, 24 Nov 2026; review
 * 92 B7-03). While false, neither date-only key can be switched on in
 * production, and the capability gate refuses them there even if a flag row
 * says on (`environmentRefusal`). The test environment stays switchable for
 * a sandbox drill. Only a deploy lifts it: set it true in the change that
 * records TravelDesk's answer to Q5 and the supervised production booking.
 */
export const DATE_ONLY_Q5_CONFIRMED: boolean = false;

/**
 * Why a class key may not be switched on, or sell, in `environment` in this
 * build, or null: `date_only_q5_pending` for the two Batch 7 keys in
 * production while `DATE_ONLY_Q5_CONFIRMED` is false. Read by the enable
 * path (supplier-capability.service.ts) and by the gate (capability-gate.ts).
 */
export function environmentRefusal(classKey: string, environment: string, q5Confirmed: boolean = DATE_ONLY_Q5_CONFIRMED): "date_only_q5_pending" | null {
  return !q5Confirmed && environment === "production" && DATE_ONLY_CLASS_KEYS.includes(classKey) ? "date_only_q5_pending" : null;
}

/**
 * Whether readiness keeps `slot_rules_unknown` for a stored offer (review 92
 * B7-04): the offer cannot be read, or it is a live-book offer without slots
 * and is not sold as date only (`dateOnlySellable`: the gate allows its exact
 * Batch 7 key). Every other offer is unaffected.
 */
export function slotRulesUnknown(stored: { bookingKind: string; timeSlots: readonly unknown[] } | null, gateAllows: boolean, classKey: string): boolean {
  if (!stored) return true;
  return stored.bookingKind === "live_book" && stored.timeSlots.length === 0 && !dateOnlySellable(gateAllows, classKey, stored.timeSlots);
}

/** A standing note for a class key that an administrator must read before switching it on, or null. */
export function capabilityKeyNote(classKey: string): string | null {
  return DATE_ONLY_CLASS_KEYS.includes(classKey) ? DATE_ONLY_Q5_UNCONFIRMED : null;
}

/**
 * Whether an offer may sell as a date-only offer (Batch 7): the capability
 * gate allowed its exact class key (`gateAllows`: flag on, evidence for the
 * key and current terms), that key is one of `DATE_ONLY_CLASS_KEYS`, and the
 * stored offer really lists no slot. The time a booking sends then comes
 * from a fresh availability row only. Anything else is false, and readiness
 * keeps its `slot_rules_unknown` blocker for a live-book offer without slots.
 */
export function dateOnlySellable(gateAllows: boolean, classKey: string, slots: readonly unknown[] | null | undefined): boolean {
  return gateAllows && DATE_ONLY_CLASS_KEYS.includes(classKey) && Array.isArray(slots) && slots.length === 0;
}

/**
 * The one Batch 5 key (doc 29 §3.3, §7.3 Batch 5): an open-dated TicketOnly
 * offer, self arrival, internal route, per-person price; 54 offers in the
 * coverage ledger. Booked like a live offer, in two steps (reserve holds the
 * stock, confirm issues the codes; TEST drill, doc 22 §32.44), and the
 * confirm is only sent after captured payment, so the irreversible moment
 * comes after the money is taken. **Not seeded**: no flag row means off.
 * Switching it on goes through the approval path with per-offer evidence for
 * this exact key (`capabilityVerdict`), and needs TravelDesk's written
 * permission (Q11, Q13) and the owner's approval first. Every other ticket
 * key stays refused (`neverEnabledReason`): pickup tickets were never proven,
 * and the external ticket offer 1592 has a slot, so it derives `unknown`.
 */
export const TICKET_CLASS_KEYS: readonly string[] = Object.freeze(["ticket.open_dated.self.internal.per_person"]);

/**
 * Whether a booking of `bookingKind` may be sold for an offer whose gate
 * verdict is `verdict` (doc 29 Batch 5): the gate allowed the offer, and the
 * kind agrees with the class's fulfilment. A live-book offer needs a live
 * class; a TicketOnly offer needs one of `TICKET_CLASS_KEYS`. Readiness, the
 * saga intake and the engine intake all ask this, so a ticket offer is never
 * more sellable than its flag, and a mapping whose kind disagrees with its
 * stored offer is refused.
 */
export function bookingKindSellable(bookingKind: string, verdict: CapabilityVerdict): boolean {
  if (!verdict.instant) return false;
  if (bookingKind === "live_book") return parseClassKey(verdict.classKey)?.fulfilment === "live";
  if (bookingKind === "ticket_only") return TICKET_CLASS_KEYS.includes(verdict.classKey);
  return false;
}

export interface CapabilityDimensions {
  fulfilment: CapFulfilment;
  timeShape: CapTimeShape;
  arrival: CapArrival;
  route: CapRoute;
  pricingUnit: CapPricing;
}

/** The raw supplier values each dimension came from (provenance; no prices, only which component is non-zero). */
export interface CapabilityRawValues {
  bookingKind: string | null;
  bookingTypeRaw: number | null;
  offerIsExternal: boolean | null;
  slotIsExternal: boolean[];
  isDirectReporting: boolean | null;
  isDirectCollection: boolean | null;
  privateType: string | null;
  tripUnit: string | null;
  slotCount: number;
  distinctStarts: number;
  anyTimeSlots: number;
  onRequestSlots: number;
  numberOfUnits: number[];
  pricedPeriods: number;
  perPersonPriced: boolean;
  perUnitPriced: boolean;
}

export interface DerivedCapability {
  version: number;
  dimensions: CapabilityDimensions;
  classKey: string;
  /** Why a dimension is unknown, or what a person must review first. Empty when nothing is in the way. */
  reviewReasons: string[];
  raw: CapabilityRawValues;
}

const minor = z.union([z.bigint(), z.string().regex(/^-?\d+$/), z.number().int()]).transform((v) => BigInt(v));

/** The fields the derivation reads. Unknown fields are ignored; a missing one makes the payload unreadable. */
const sourceSchema = z.object({
  bookingKind: z.string(),
  bookingTypeRaw: z.number().int(),
  isExternal: z.boolean(),
  isDirectReporting: z.boolean(),
  isDirectCollection: z.boolean(),
  privateType: z.string(),
  tripUnit: z.string().nullable(),
  timeSlots: z.array(
    z.object({
      startMinutes: z.number().int(),
      isAnyTime: z.boolean(),
      isOnRequest: z.boolean(),
      isExternal: z.boolean(),
      numberOfUnits: z.number().int().nullable().optional(),
    }),
  ),
  pricingPeriods: z.array(z.object({ price: z.object({ perAdultMinor: minor, perChildMinor: minor, perTripMinor: minor }).passthrough().nullable() })),
});

const EMPTY_RAW: CapabilityRawValues = {
  bookingKind: null,
  bookingTypeRaw: null,
  offerIsExternal: null,
  slotIsExternal: [],
  isDirectReporting: null,
  isDirectCollection: null,
  privateType: null,
  tripUnit: null,
  slotCount: 0,
  distinctStarts: 0,
  anyTimeSlots: 0,
  onRequestSlots: 0,
  numberOfUnits: [],
  pricedPeriods: 0,
  perPersonPriced: false,
  perUnitPriced: false,
};

const UNKNOWN_DIMENSIONS: CapabilityDimensions = { fulfilment: "unknown", timeShape: "unknown", arrival: "unknown", route: "unknown", pricingUnit: "unknown" };

/** The composed key, or `unknown` / `inquiry_only`. */
export function classKeyOf(d: CapabilityDimensions): string {
  if (d.fulfilment === "on_request") return INQUIRY_CLASS;
  if (d.fulfilment === "unknown" || d.timeShape === "unknown" || d.arrival === "unknown" || d.route === "unknown" || d.pricingUnit === "unknown") return UNKNOWN_CLASS;
  return `${d.fulfilment}.${d.timeShape}.${d.arrival}.${d.route}.${d.pricingUnit}`;
}

/** The dimensions of a composed key, or null when it is not one (including `unknown` and `inquiry_only`). */
export function parseClassKey(key: string): CapabilityDimensions | null {
  const parts = key.split(".");
  if (parts.length !== 5) return null;
  const [fulfilment, timeShape, arrival, route, pricingUnit] = parts;
  const known =
    (fulfilment === "live" || fulfilment === "ticket") &&
    (CAP_TIME_SHAPES as readonly string[]).includes(timeShape) &&
    timeShape !== "unknown" &&
    (CAP_ARRIVALS as readonly string[]).includes(arrival) &&
    arrival !== "unknown" &&
    (CAP_ROUTES as readonly string[]).includes(route) &&
    route !== "unknown" &&
    (CAP_PRICING as readonly string[]).includes(pricingUnit) &&
    pricingUnit !== "unknown";
  if (!known) return null;
  // A ticket is open dated and a live offer never is.
  if ((fulfilment === "ticket") !== (timeShape === "open_dated")) return null;
  return { fulfilment, timeShape, arrival, route, pricingUnit } as CapabilityDimensions;
}

/**
 * Why a class key may never be switched on in this release, or null.
 *  - `not_a_class`: `unknown`, `inquiry_only` or not a composed key;
 *  - `private_units_inquiry`: per-unit or per person plus per unit pricing
 *    (owner decision 7, 22 Nov 2026: private units stay inquiry);
 *  - `date_only_inquiry`: no slot metadata, other than the two keys of
 *    Batch 7 (`DATE_ONLY_CLASS_KEYS`: internal, per person, self arrival or
 *    pickup), which are built switched off (owner decision 6: date-only stays
 *    inquiry until TravelDesk answers Q5);
 *  - `ticket_booking_refused`: a ticket class other than the one Batch 5
 *    builds (`TICKET_CLASS_KEYS`: open dated, self arrival, internal, per
 *    person). Pickup and external tickets were never proven;
 *  - `external_route_unproven`: a live external key other than the five of
 *    Batch 6 (`EXTERNAL_CLASS_KEYS`).
 * The database refuses an enabled per-unit flag as well (migration 20261122120000).
 */
export function neverEnabledReason(
  key: string,
): "not_a_class" | "private_units_inquiry" | "date_only_inquiry" | "ticket_booking_refused" | "external_route_unproven" | null {
  const d = parseClassKey(key);
  if (!d) return "not_a_class";
  if (d.pricingUnit === "per_unit" || d.pricingUnit === "mixed_person_plus_unit") return "private_units_inquiry";
  if (d.timeShape === "date_only_no_slot_metadata" && !DATE_ONLY_CLASS_KEYS.includes(key)) return "date_only_inquiry";
  if (d.fulfilment === "ticket" && !TICKET_CLASS_KEYS.includes(key)) return "ticket_booking_refused";
  if (d.route === "external" && d.fulfilment === "live" && !EXTERNAL_CLASS_KEYS.includes(key)) return "external_route_unproven";
  return null;
}

function fulfilmentOf(kind: string, raw: number): CapFulfilment {
  // Kind and raw value must agree (codec bookingKindFrom); anything else is a value we do not know.
  if (kind === "live_book" && raw === 1) return "live";
  if (kind === "ticket_only" && raw === 2) return "ticket";
  if (kind === "on_request" && raw === 0) return "on_request";
  return "unknown";
}

/** Derive the capability of a stored offer payload. Never throws. */
export function deriveCapabilities(payload: unknown): DerivedCapability {
  const parsed = sourceSchema.safeParse(payload);
  if (!parsed.success) {
    return { version: CAPABILITY_DERIVATION_VERSION, dimensions: UNKNOWN_DIMENSIONS, classKey: UNKNOWN_CLASS, reviewReasons: ["payload_unreadable"], raw: EMPTY_RAW };
  }
  const o = parsed.data;
  const reasons: string[] = [];
  const slots = o.timeSlots;
  const priced = o.pricingPeriods.flatMap((p) => (p.price ? [p.price] : []));
  const raw: CapabilityRawValues = {
    bookingKind: o.bookingKind,
    bookingTypeRaw: o.bookingTypeRaw,
    offerIsExternal: o.isExternal,
    slotIsExternal: [...new Set(slots.map((s) => s.isExternal))].sort(),
    isDirectReporting: o.isDirectReporting,
    isDirectCollection: o.isDirectCollection,
    privateType: o.privateType,
    tripUnit: o.tripUnit,
    slotCount: slots.length,
    distinctStarts: new Set(slots.map((s) => s.startMinutes)).size,
    anyTimeSlots: slots.filter((s) => s.isAnyTime).length,
    onRequestSlots: slots.filter((s) => s.isOnRequest).length,
    numberOfUnits: [...new Set(slots.flatMap((s) => (typeof s.numberOfUnits === "number" ? [s.numberOfUnits] : [])))].sort((a, b) => a - b),
    pricedPeriods: priced.length,
    perPersonPriced: priced.some((p) => p.perAdultMinor > 0n || p.perChildMinor > 0n),
    perUnitPriced: priced.some((p) => p.perTripMinor > 0n),
  };

  const fulfilment = fulfilmentOf(o.bookingKind, o.bookingTypeRaw);
  if (fulfilment === "unknown") reasons.push("booking_type_unknown");

  let timeShape: CapTimeShape = "unknown";
  if (fulfilment === "ticket") {
    if (raw.slotCount === 0) timeShape = "open_dated";
    else reasons.push("ticket_with_slots");
  } else if (fulfilment === "live") {
    if (raw.onRequestSlots > 0) reasons.push("slot_on_request");
    else if (raw.slotCount === 0) timeShape = "date_only_no_slot_metadata";
    else if (raw.anyTimeSlots === raw.slotCount) timeShape = raw.distinctStarts === 1 ? "listed_start_single" : "listed_starts_customer_selected";
    else if (raw.anyTimeSlots > 0) reasons.push("any_time_mixed_with_fixed");
    else timeShape = raw.distinctStarts === 1 ? "fixed_slot_single" : "fixed_slot_choice";
  }

  let arrival: CapArrival = "unknown";
  if (o.isDirectCollection) reasons.push("direct_collection_unexplained");
  else arrival = o.isDirectReporting ? "self" : "pickup_required";

  let route: CapRoute = "unknown";
  if (slots.some((s) => s.isExternal !== o.isExternal)) reasons.push("slot_route_disagrees");
  else route = o.isExternal ? "external" : "internal";

  let pricingUnit: CapPricing = "unknown";
  if (o.privateType !== "sharing" && o.privateType !== "private") reasons.push("private_type_unknown");
  else if (raw.pricedPeriods === 0) reasons.push("no_aed_price");
  else if (raw.perPersonPriced && raw.perUnitPriced) pricingUnit = "mixed_person_plus_unit";
  else if (raw.perPersonPriced) pricingUnit = "per_person";
  else if (raw.perUnitPriced) pricingUnit = "per_unit";
  else reasons.push("price_basis_unknown");

  // Kept in the class, but its meaning is unknown (Q7): a person reviews it first.
  if (raw.numberOfUnits.some((n) => n !== 1)) reasons.push("slot_units_unexplained");

  const dimensions: CapabilityDimensions = { fulfilment, timeShape, arrival, route, pricingUnit };
  return { version: CAPABILITY_DERIVATION_VERSION, dimensions, classKey: classKeyOf(dimensions), reviewReasons: reasons, raw };
}

export type CapabilityRefusal = "class_unknown" | "class_not_sellable" | "review_required" | "flag_off" | "offer_evidence_missing";

export interface CapabilityFlagState {
  enabled: boolean;
  requiresOfferEvidence: boolean;
}

export interface OfferEvidenceState {
  classKey: string;
  offerTermsHash: string;
  revokedAt: Date | string | null;
}

export type CapabilityVerdict = { instant: true; classKey: string } | { instant: false; classKey: string; reason: CapabilityRefusal };

/**
 * The capability gate (doc 29 §3.1 rule 3, §3.3). `flag` is the row for the
 * capability's exact class key and the environment asked about, or null.
 * `currentTermsHash` is the offer terms hash the evidence must match; null
 * means unknown terms, so evidence can never match.
 */
export function capabilityVerdict(cap: DerivedCapability, flag: CapabilityFlagState | null, evidence: readonly OfferEvidenceState[], currentTermsHash: string | null): CapabilityVerdict {
  const classKey = cap.classKey;
  if (classKey === UNKNOWN_CLASS) return { instant: false, classKey, reason: "class_unknown" };
  if (neverEnabledReason(classKey)) return { instant: false, classKey, reason: "class_not_sellable" };
  if (cap.reviewReasons.length > 0) return { instant: false, classKey, reason: "review_required" };
  if (!flag || !flag.enabled) return { instant: false, classKey, reason: "flag_off" };
  // Only the two seeded keys may sell without per-offer evidence; a flag row that says otherwise for any other key is not believed.
  if (flag.requiresOfferEvidence || !SEEDED_CLASS_KEYS.includes(classKey)) {
    const has = currentTermsHash !== null && evidence.some((e) => e.revokedAt === null && e.classKey === classKey && e.offerTermsHash === currentTermsHash);
    if (!has) return { instant: false, classKey, reason: "offer_evidence_missing" };
  }
  return { instant: true, classKey };
}

/** The single gate this module replaces (supplier-catalog.service.ts before Batch 1a), for the parity tests. */
export function legacyLiveBookGate(payload: unknown): boolean {
  return (payload as { bookingKind?: unknown } | null)?.bookingKind === "live_book";
}
