import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import choiceFixture from "./fixtures/traveldesk/capability-fixed-slot-choice.json";
import listedChoiceFixture from "./fixtures/traveldesk/capability-listed-starts-choice.json";
import listedSingleFixture from "./fixtures/traveldesk/capability-listed-start-single.json";
import ticketFixture from "./fixtures/traveldesk/capability-ticket-open-dated.json";
import extFixedSingle from "./fixtures/traveldesk/capability-external-fixed-slot-single.json";
import extListedSingle from "./fixtures/traveldesk/capability-external-listed-start-single.json";
import extListedChoice from "./fixtures/traveldesk/capability-external-listed-starts-choice.json";
import extListedSinglePickup from "./fixtures/traveldesk/capability-external-listed-start-single-pickup.json";
import extListedChoicePickup from "./fixtures/traveldesk/capability-external-listed-starts-choice-pickup.json";
import tourFixture from "./fixtures/traveldesk/tour-5.json";
import { storedOffer, storedSlot } from "./fixtures/traveldesk-terms";
import { tourDetailFrom, tourDetailsWire, type TravelDeskOffer } from "../traveldesk/traveldesk.codec";
import {
  bookingKindSellable,
  capabilityVerdict,
  classKeyOf,
  deriveCapabilities,
  EXTERNAL_CLASS_KEYS,
  INQUIRY_CLASS,
  legacyLiveBookGate,
  LISTED_START_CLASS_KEYS,
  listedStartsSellable,
  neverEnabledReason,
  parseClassKey,
  SEEDED_CLASS_KEYS,
  TICKET_CLASS_KEYS,
  UNKNOWN_CLASS,
  type CapabilityFlagState,
  type DerivedCapability,
} from "../traveldesk/traveldesk.capability";

/**
 * Capability derivation, class keys and the gate (doc 29 §3.1, §3.3, Batch 1a).
 *
 *  - a derivation table per dimension, and every unknown shape failing closed;
 *  - parity over the whole 22 November catalogue (`29a-offer-coverage-ledger.csv`,
 *    317 offers, structure only, no prices): the derived class matches the
 *    ledger's, and with the seeded flags the new gate passes exactly the 16
 *    offers the ledger assigns to Batch 0, a subset of what the old single
 *    `live_book` gate passed;
 *  - one sanitised contract fixture per composed key present in Batch 0.
 * Pure: no database.
 */

type Json = Record<string, unknown>;

const SINGLE = "live.fixed_slot_single.self.internal.per_person";
const CHOICE = "live.fixed_slot_choice.self.internal.per_person";
const SEEDED_FLAGS = new Map<string, CapabilityFlagState>(SEEDED_CLASS_KEYS.map((k) => [k, { enabled: true, requiresOfferEvidence: false }]));
const HASH = "a".repeat(64);

/** What the sync stores: the codec's offer with bigints as decimal strings (supplier-catalog.service.ts `toJson`). */
function asStored(o: TravelDeskOffer): Json {
  return JSON.parse(JSON.stringify(o, (_k, v) => (typeof v === "bigint" ? v.toString() : v))) as Json;
}

function price(adult: string, child: string, trip: string) {
  return { periodId: 1, dateStart: "2026-01-01", dateEnd: null, price: { currency: "AED", perAdultMinor: adult, perChildMinor: child, perTripMinor: trip } };
}

describe("deriveCapabilities: one dimension at a time", () => {
  it("the default synthetic offer is the fixed single-start Dhow shape", () => {
    const c = deriveCapabilities(storedOffer());
    expect(c.dimensions).toEqual({ fulfilment: "live", timeShape: "fixed_slot_single", arrival: "self", route: "internal", pricingUnit: "per_person" });
    expect(c.classKey).toBe(SINGLE);
    expect(c.reviewReasons).toEqual([]);
    expect(c.raw).toMatchObject({ bookingTypeRaw: 1, slotCount: 1, distinctStarts: 1, perPersonPriced: true, perUnitPriced: false });
  });

  it.each([
    ["one start", [storedSlot()], "fixed_slot_single"],
    ["one start under two slot ids", [storedSlot(), storedSlot({ timeSlotId: 12 })], "fixed_slot_single"],
    ["two starts", [storedSlot(), storedSlot({ timeSlotId: 12, startMinutes: 1140 })], "fixed_slot_choice"],
    ["any time, one listed start", [storedSlot({ isAnyTime: true })], "listed_start_single"],
    ["any time, several listed starts", [storedSlot({ isAnyTime: true }), storedSlot({ isAnyTime: true, startMinutes: 600 })], "listed_starts_customer_selected"],
    ["no slot metadata", [], "date_only_no_slot_metadata"],
  ])("time shape: %s", (_name, timeSlots, shape) => {
    expect(deriveCapabilities(storedOffer({ timeSlots })).dimensions.timeShape).toBe(shape);
  });

  it("arrival, route and pricing", () => {
    expect(deriveCapabilities(storedOffer({ isDirectReporting: false })).classKey).toBe("live.fixed_slot_single.pickup_required.internal.per_person");
    expect(deriveCapabilities(storedOffer({ isExternal: true, timeSlots: [storedSlot({ isExternal: true })] })).classKey).toBe("live.fixed_slot_single.self.external.per_person");
    expect(deriveCapabilities(storedOffer({ pricingPeriods: [price("0", "0", "50000")] })).dimensions.pricingUnit).toBe("per_unit");
    expect(deriveCapabilities(storedOffer({ pricingPeriods: [price("10000", "0", "50000")] })).dimensions.pricingUnit).toBe("mixed_person_plus_unit");
    // Child-only pricing is still per person; a non-AED period (price null) is ignored.
    expect(deriveCapabilities(storedOffer({ pricingPeriods: [price("0", "6000", "0"), { periodId: 2, dateStart: null, dateEnd: null, price: null }] })).dimensions.pricingUnit).toBe("per_person");
    // privateType alone does not decide the unit; the price basis does (as the ledger).
    expect(deriveCapabilities(storedOffer({ privateType: "private", tripUnit: "Car" })).dimensions.pricingUnit).toBe("per_person");
  });

  it("ticket and on-request offers", () => {
    expect(deriveCapabilities(storedOffer({ bookingKind: "ticket_only", bookingTypeRaw: 2, timeSlots: [] })).classKey).toBe("ticket.open_dated.self.internal.per_person");
    expect(deriveCapabilities(storedOffer({ bookingKind: "on_request", bookingTypeRaw: 0 })).classKey).toBe(INQUIRY_CLASS);
  });

  it("a slot unit count of 1 is neutral; any other value keeps the class but waits for review (Q7)", () => {
    expect(deriveCapabilities(storedOffer({ timeSlots: [storedSlot({ numberOfUnits: 1 })] })).reviewReasons).toEqual([]);
    const ten = deriveCapabilities(storedOffer({ timeSlots: [storedSlot({ numberOfUnits: 10 })] }));
    expect(ten.classKey).toBe(SINGLE);
    expect(ten.reviewReasons).toEqual(["slot_units_unexplained"]);
    expect(ten.raw.numberOfUnits).toEqual([10]);
    // An unreadable count (kept as 0 by the codec, review R10) waits for review too.
    expect(deriveCapabilities(storedOffer({ timeSlots: [storedSlot({ numberOfUnits: 0 })] })).reviewReasons).toEqual(["slot_units_unexplained"]);
  });
});

describe("deriveCapabilities: unknown values and shapes fail closed", () => {
  it.each([
    ["an unreadable payload", { not: "an offer" }, "payload_unreadable"],
    ["null", null, "payload_unreadable"],
    ["a missing field", (() => { const { isDirectCollection: _x, ...rest } = storedOffer(); return rest; })(), "payload_unreadable"],
    ["an unknown booking type", storedOffer({ bookingKind: "unknown", bookingTypeRaw: 7 }), "booking_type_unknown"],
    ["kind and raw type that disagree", storedOffer({ bookingKind: "live_book", bookingTypeRaw: 2 }), "booking_type_unknown"],
    ["any-time mixed with fixed slots", storedOffer({ timeSlots: [storedSlot(), storedSlot({ timeSlotId: 12, isAnyTime: true })] }), "any_time_mixed_with_fixed"],
    ["an on-request slot on a live offer", storedOffer({ timeSlots: [storedSlot({ isOnRequest: true })] }), "slot_on_request"],
    ["a slot whose route disagrees with its offer", storedOffer({ isExternal: true, timeSlots: [storedSlot({ isExternal: false })] }), "slot_route_disagrees"],
    ["a ticket with slots (offer 1592's shape)", storedOffer({ bookingKind: "ticket_only", bookingTypeRaw: 2, timeSlots: [storedSlot({ startMinutes: 0 })] }), "ticket_with_slots"],
    ["direct collection", storedOffer({ isDirectCollection: true }), "direct_collection_unexplained"],
    ["an unknown private type", storedOffer({ privateType: "unknown" }), "private_type_unknown"],
    ["no AED price", storedOffer({ pricingPeriods: [] }), "no_aed_price"],
    ["an all-zero price", storedOffer({ pricingPeriods: [price("0", "0", "0")] }), "price_basis_unknown"],
  ])("%s → unknown", (_name, payload, reason) => {
    const c = deriveCapabilities(payload);
    expect(c.classKey).toBe(UNKNOWN_CLASS);
    expect(c.reviewReasons).toContain(reason);
    expect(capabilityVerdict(c, { enabled: true, requiresOfferEvidence: false }, [], HASH)).toMatchObject({ instant: false, reason: "class_unknown" });
  });

  it("new fields TravelDesk adds are ignored, never read as meaning", () => {
    expect(deriveCapabilities(storedOffer({ productType: 3, isAppendTransactionFeeB2b: true })).classKey).toBe(SINGLE);
  });
});

describe("class keys", () => {
  it("compose and parse back; unknown and inquiry are not composed keys", () => {
    const d = parseClassKey(CHOICE)!;
    expect(d).toEqual({ fulfilment: "live", timeShape: "fixed_slot_choice", arrival: "self", route: "internal", pricingUnit: "per_person" });
    expect(classKeyOf(d)).toBe(CHOICE);
    for (const bad of [UNKNOWN_CLASS, INQUIRY_CLASS, "live.fixed_slot_single.self.internal", "live.unknown.self.internal.per_person", "ticket.fixed_slot_single.self.internal.per_person", "live.open_dated.self.internal.per_person", "live.fixed_slot_single.boat.internal.per_person"]) {
      expect(parseClassKey(bad), bad).toBeNull();
    }
  });

  it("per-unit, date-only, other ticket, unknown and inquiry keys can never be switched on (owner decisions 6 and 7; Batch 5 builds one ticket key)", () => {
    expect(neverEnabledReason("live.listed_starts_customer_selected.self.internal.per_unit")).toBe("private_units_inquiry");
    expect(neverEnabledReason("live.fixed_slot_single.pickup_required.internal.mixed_person_plus_unit")).toBe("private_units_inquiry");
    expect(neverEnabledReason("live.date_only_no_slot_metadata.self.internal.per_person")).toBe("date_only_inquiry");
    // Batch 5: the one open-dated, self-arrival, internal, per-person ticket key may be switched on (by approval, with evidence); no other ticket key.
    expect(neverEnabledReason("ticket.open_dated.self.internal.per_person")).toBeNull();
    expect(neverEnabledReason("ticket.open_dated.self.external.per_person")).toBe("ticket_booking_refused");
    expect(neverEnabledReason("ticket.open_dated.pickup_required.internal.per_person")).toBe("ticket_booking_refused");
    expect(neverEnabledReason("ticket.open_dated.self.internal.per_unit")).toBe("private_units_inquiry");
    expect(neverEnabledReason(UNKNOWN_CLASS)).toBe("not_a_class");
    expect(neverEnabledReason(INQUIRY_CLASS)).toBe("not_a_class");
    for (const k of SEEDED_CLASS_KEYS) expect(neverEnabledReason(k)).toBeNull();
    expect(neverEnabledReason("live.fixed_slot_single.pickup_required.internal.per_person")).toBeNull();
  });

  it("the seeded keys are exactly the two proven fixed-start, self-arrival, internal, per-person keys", () => {
    expect([...SEEDED_CLASS_KEYS].sort()).toEqual([CHOICE, SINGLE]);
  });
});

describe("capabilityVerdict", () => {
  const single = deriveCapabilities(storedOffer());
  const pickup = deriveCapabilities(storedOffer({ isDirectReporting: false }));
  const evidence = (over: Partial<{ classKey: string; offerTermsHash: string; revokedAt: Date | null }> = {}) => ({ classKey: pickup.classKey, offerTermsHash: HASH, revokedAt: null, ...over });

  it("a seeded key needs no evidence; no row or an off row refuses", () => {
    expect(capabilityVerdict(single, SEEDED_FLAGS.get(SINGLE)!, [], null)).toEqual({ instant: true, classKey: SINGLE });
    expect(capabilityVerdict(single, null, [], HASH)).toMatchObject({ instant: false, reason: "flag_off" });
    expect(capabilityVerdict(single, { enabled: false, requiresOfferEvidence: false }, [], HASH)).toMatchObject({ instant: false, reason: "flag_off" });
  });

  it("an evidence-requiring key needs active evidence for that key and the current terms", () => {
    const on = { enabled: true, requiresOfferEvidence: true };
    expect(capabilityVerdict(pickup, on, [], HASH)).toMatchObject({ instant: false, reason: "offer_evidence_missing" });
    expect(capabilityVerdict(pickup, on, [evidence()], HASH)).toEqual({ instant: true, classKey: pickup.classKey });
    // Lapses when the terms change, when revoked, when recorded for another key, and when the terms are unknown.
    expect(capabilityVerdict(pickup, on, [evidence({ offerTermsHash: "b".repeat(64) })], HASH)).toMatchObject({ reason: "offer_evidence_missing" });
    expect(capabilityVerdict(pickup, on, [evidence({ revokedAt: new Date() })], HASH)).toMatchObject({ reason: "offer_evidence_missing" });
    expect(capabilityVerdict(pickup, on, [evidence({ classKey: SINGLE })], HASH)).toMatchObject({ reason: "offer_evidence_missing" });
    expect(capabilityVerdict(pickup, on, [evidence()], null)).toMatchObject({ reason: "offer_evidence_missing" });
  });

  it("a never-sellable class is refused even if a flag row says on; review reasons refuse too", () => {
    const perUnit = deriveCapabilities(storedOffer({ pricingPeriods: [price("0", "0", "50000")] }));
    expect(capabilityVerdict(perUnit, { enabled: true, requiresOfferEvidence: false }, [], HASH)).toMatchObject({ instant: false, reason: "class_not_sellable" });
    const inquiry = deriveCapabilities(storedOffer({ bookingKind: "on_request", bookingTypeRaw: 0 }));
    expect(capabilityVerdict(inquiry, { enabled: true, requiresOfferEvidence: false }, [], HASH)).toMatchObject({ instant: false, reason: "class_not_sellable" });
    const units = deriveCapabilities(storedOffer({ timeSlots: [storedSlot({ numberOfUnits: 10 })] }));
    expect(capabilityVerdict(units, SEEDED_FLAGS.get(SINGLE)!, [], HASH)).toMatchObject({ instant: false, reason: "review_required" });
  });
});

/* ---------------------------------------------------------------------------
 * Parity over the 22 November catalogue (doc 29 §2.5 ledger)
 * ------------------------------------------------------------------------ */

/** Minimal CSV reader: quoted fields may hold commas; no embedded newlines in this file. */
function parseCsv(text: string): Record<string, string>[] {
  const lines = text.split(/\r?\n/).filter((l) => l.length > 0);
  const split = (line: string) => {
    const out: string[] = [];
    let cur = "";
    let quoted = false;
    for (let i = 0; i < line.length; i++) {
      const ch = line[i];
      if (quoted) {
        if (ch === '"' && line[i + 1] === '"') {
          cur += '"';
          i++;
        } else if (ch === '"') quoted = false;
        else cur += ch;
      } else if (ch === '"') quoted = true;
      else if (ch === ",") {
        out.push(cur);
        cur = "";
      } else cur += ch;
    }
    out.push(cur);
    return out;
  };
  const [head, ...rows] = lines.map(split);
  return rows.map((r) => Object.fromEntries(head.map((h, i) => [h, r[i] ?? ""])));
}

// The ledger lives in the private docs folder, which the public test copy does not export: there the parity block is skipped.
const LEDGER_PATH = path.resolve(import.meta.dirname, "../../../../docs/backend/29a-offer-coverage-ledger.csv");
const HAS_LEDGER = existsSync(LEDGER_PATH);
const LEDGER = HAS_LEDGER ? parseCsv(readFileSync(LEDGER_PATH, "utf8")) : [];

/**
 * A stored offer with the ledger row's structure: the raw flags it records,
 * its slot statistics and which price component is non-zero (synthetic
 * amounts; the ledger holds no prices).
 */
function offerFromLedger(r: Record<string, string>): Json {
  const bool = (k: string) => r[k] === "true";
  const n = Number(r.slotCount || 0);
  const starts = Number(r.slotDistinctStarts || 0);
  const units = [r.slotNumberOfUnitsMin, r.slotNumberOfUnitsMax].filter((u) => u !== "").map(Number);
  const timeSlots = Array.from({ length: n }, (_, i) => ({
    timeSlotId: i + 1,
    name: null,
    // The first `starts` slots carry distinct starts; any further slot repeats the first start.
    startMinutes: i < starts ? 360 + i * 30 : 360,
    endMinutes: null,
    daysOffered: 0,
    isAnyTime: bool("slotAllIsAnyTime") || (bool("slotAnyIsAnyTime") && i === 0),
    isOnRequest: bool("slotAnyIsOnRequest") && i === 0,
    minimumAdvancedBookingHours: null,
    isExternal: bool("slotAnyIsExternal"),
    ...(units.length && i === 0 ? { numberOfUnits: units[0] } : {}),
    ...(units.length > 1 && i === n - 1 && n > 1 ? { numberOfUnits: units[1] } : {}),
  }));
  const any = bool("priceBasisPerAdult") || bool("priceBasisPerChild") || bool("priceBasisPerUnit");
  return storedOffer({
    offerId: Number(r.offerId),
    tourId: Number(r.tourId),
    bookingKind: r.bookingKind,
    bookingTypeRaw: Number(r.bookingTypeRaw),
    isExternal: bool("offerIsExternal"),
    isDirectReporting: bool("isDirectReporting"),
    isDirectCollection: bool("isDirectCollection"),
    privateType: r.privateTypeRaw === "0" ? "sharing" : r.privateTypeRaw === "1" ? "private" : "unknown",
    tripUnit: r.tripUnitNormalised || null,
    timeSlots,
    pricingPeriods: any ? [price(bool("priceBasisPerAdult") ? "10000" : "0", bool("priceBasisPerChild") ? "6000" : "0", bool("priceBasisPerUnit") ? "50000" : "0")] : [],
  });
}

/** Offers where this code deliberately disagrees with the ledger, each failing closed. */
const LEDGER_EXCEPTIONS: Record<string, string> = {
  // External TicketOnly offer with one slot at 00:00 (doc 29 §2.4 last row): "must stay blocked". The ledger names a key; this code says unknown.
  "1592": UNKNOWN_CLASS,
};

describe.skipIf(!HAS_LEDGER)("parity over the 22 November 2026 catalogue (317 offers)", () => {
  it("the ledger is the one the plan counted", () => {
    expect(LEDGER).toHaveLength(317);
    expect(new Set(LEDGER.map((r) => r.offerId)).size).toBe(317);
    expect(LEDGER.filter((r) => r.planBatch === "B0")).toHaveLength(16);
  });

  it("every offer derives to the ledger's class key (one named exception, which fails closed)", () => {
    const mismatches = LEDGER.flatMap((r) => {
      const got = deriveCapabilities(offerFromLedger(r)).classKey;
      const want = LEDGER_EXCEPTIONS[r.offerId] ?? r.targetCapabilityClass;
      return got === want ? [] : [`${r.offerId}: ${got} ≠ ${want}`];
    });
    expect(mismatches).toEqual([]);
  });

  it("the ledger holds 28 class keys (26 composed sale keys, inquiry, the external ticket) and the derivation reproduces their offer counts", () => {
    const count = (keys: string[]) => keys.reduce((m, k) => m.set(k, (m.get(k) ?? 0) + 1), new Map<string, number>());
    const ledger = count(LEDGER.map((r) => LEDGER_EXCEPTIONS[r.offerId] ?? r.targetCapabilityClass));
    const derived = count(LEDGER.map((r) => deriveCapabilities(offerFromLedger(r)).classKey));
    expect(derived).toEqual(ledger);
    expect(new Set(LEDGER.map((r) => r.targetCapabilityClass)).size).toBe(28);
    expect(derived.get(SINGLE)).toBe(10);
    expect(derived.get(CHOICE)).toBe(6);
  });

  it("with the seeded flags the new gate is never more permissive than the old one, and identical on the 16 Batch 0 offers", () => {
    const widened: string[] = [];
    const passed: string[] = [];
    for (const r of LEDGER) {
      const payload = offerFromLedger(r);
      const cap = deriveCapabilities(payload);
      const verdict = capabilityVerdict(cap, SEEDED_FLAGS.get(cap.classKey) ?? null, [], HASH);
      if (verdict.instant && !legacyLiveBookGate(payload)) widened.push(r.offerId);
      if (verdict.instant) passed.push(r.offerId);
    }
    expect(widened).toEqual([]);
    const b0 = LEDGER.filter((r) => r.planBatch === "B0").map((r) => r.offerId);
    expect(passed.sort()).toEqual(b0.sort());
    for (const id of b0) expect(legacyLiveBookGate(offerFromLedger(LEDGER.find((r) => r.offerId === id)!))).toBe(true);
  });

  it("with every flag off nothing passes, and per-unit offers never pass even with their flag on", () => {
    for (const r of LEDGER) {
      const cap = deriveCapabilities(offerFromLedger(r));
      expect(capabilityVerdict(cap, null, [], HASH).instant).toBe(false);
      if (cap.dimensions.pricingUnit === "per_unit" || cap.dimensions.pricingUnit === "mixed_person_plus_unit") {
        expect(capabilityVerdict(cap, { enabled: true, requiresOfferEvidence: false }, [], HASH).instant).toBe(false);
      }
    }
  });
});

/* ---------------------------------------------------------------------------
 * Contract fixtures: one sanitised supplier shape per Batch 0 key
 * ------------------------------------------------------------------------ */

describe("contract fixtures per composed key present in Batch 0", () => {
  it.each([
    ["tour-5 (recorded TEST answer, trimmed)", tourFixture, SINGLE],
    ["fixed slot choice (synthetic)", choiceFixture, CHOICE],
  ])("%s parses with the production schema, derives %s, and passes the seeded gate", (_name, wire, key) => {
    const parsed = tourDetailsWire.safeParse(wire);
    expect(parsed.success).toBe(true);
    const detail = tourDetailFrom(parsed.data!);
    expect(detail.warnings).toEqual([]);
    const payload = asStored(detail.offers[0]);
    const cap = deriveCapabilities(payload);
    expect(cap.classKey).toBe(key);
    expect(cap.reviewReasons).toEqual([]);
    expect(capabilityVerdict(cap, SEEDED_FLAGS.get(key)!, [], null)).toEqual({ instant: true, classKey: key });
    expect(capabilityVerdict(cap, { enabled: false, requiresOfferEvidence: false }, [], null).instant).toBe(false);
  });

  it("the same fixture with a new booking type, a pickup flag or an any-time slot leaves the seeded keys", () => {
    const base = (choiceFixture as { offers: Json[] }).offers[0];
    const variant = (over: Json) => {
      const wire = { ...choiceFixture, offers: [{ ...base, ...over }] };
      return deriveCapabilities(asStored(tourDetailFrom(tourDetailsWire.parse(wire)).offers[0])).classKey;
    };
    expect(variant({ bookingType: 7 })).toBe(UNKNOWN_CLASS);
    expect(variant({ isDirectReporting: false })).toBe("live.fixed_slot_choice.pickup_required.internal.per_person");
    const slots = (base.timeSlots as Json[]).map((s) => ({ ...s, isAnyTime: true }));
    expect(variant({ timeSlots: slots })).toBe("live.listed_starts_customer_selected.self.internal.per_person");
  });
});

/* ---------------------------------------------------------------------------
 * Batch 2: the two listed-start keys (doc 29 §3.3, §7.3)
 * ------------------------------------------------------------------------ */

const LISTED_SINGLE = "live.listed_start_single.self.internal.per_person";
const LISTED_CHOICE = "live.listed_starts_customer_selected.self.internal.per_person";
const B2_FLAGS = new Map<string, CapabilityFlagState>([...SEEDED_FLAGS, ...LISTED_START_CLASS_KEYS.map((k) => [k, { enabled: true, requiresOfferEvidence: true }] as const)]);
/** Evidence for the offer's own listed-start key and current terms: what the approval path records per offer (non-seeded keys always need it). */
const listedEvidence = (classKey: string) => (LISTED_START_CLASS_KEYS.includes(classKey) ? [{ classKey, offerTermsHash: HASH, revokedAt: null }] : []);

describe("Batch 2 listed-start keys", () => {
  it("are exactly the two keys of the plan, sellable in principle, and seeded off", () => {
    expect([...LISTED_START_CLASS_KEYS].sort()).toEqual([LISTED_SINGLE, LISTED_CHOICE].sort());
    for (const k of LISTED_START_CLASS_KEYS) {
      expect(neverEnabledReason(k)).toBeNull();
      expect(SEEDED_CLASS_KEYS).not.toContain(k);
    }
  });

  it.each([
    ["one listed start (synthetic)", listedSingleFixture, LISTED_SINGLE],
    ["three listed starts on one repeated slot id (synthetic)", listedChoiceFixture, LISTED_CHOICE],
  ])("contract fixture %s parses with the production schema, derives %s, and is instant only with its own flag on", (_name, wire, key) => {
    const parsed = tourDetailsWire.safeParse(wire);
    expect(parsed.success).toBe(true);
    const detail = tourDetailFrom(parsed.data!);
    expect(detail.warnings).toEqual([]);
    const payload = asStored(detail.offers[0]);
    const cap = deriveCapabilities(payload);
    expect(cap.classKey).toBe(key);
    expect(cap.reviewReasons).toEqual([]);
    // Off by default: no flag row.
    expect(capabilityVerdict(cap, null, [], HASH)).toEqual({ instant: false, classKey: key, reason: "flag_off" });
    expect(capabilityVerdict(cap, SEEDED_FLAGS.get(key) ?? null, [], HASH).instant).toBe(false);
    // On, with evidence asked for: only evidence for this key and these terms counts.
    expect(capabilityVerdict(cap, { enabled: true, requiresOfferEvidence: true }, [], HASH).instant).toBe(false);
    expect(capabilityVerdict(cap, { enabled: true, requiresOfferEvidence: true }, [{ classKey: SINGLE, offerTermsHash: HASH, revokedAt: null }], HASH).instant).toBe(false);
    expect(capabilityVerdict(cap, { enabled: true, requiresOfferEvidence: true }, [{ classKey: key, offerTermsHash: HASH, revokedAt: null }], HASH)).toEqual({ instant: true, classKey: key });
    // Its slots are all "any time" with a stored end, so the offer may sell as listed starts once the gate allows it.
    const slots = (payload as { timeSlots: { isAnyTime: boolean; startMinutes: number; endMinutes: number | null }[] }).timeSlots;
    expect(listedStartsSellable(true, cap.classKey, slots)).toBe(true);
    expect(listedStartsSellable(false, cap.classKey, slots)).toBe(false);
  });

  it("need evidence for that exact key and current terms even if a flag row claims otherwise (the rule for every non-seeded key)", () => {
    for (const k of LISTED_START_CLASS_KEYS) {
      const cap: DerivedCapability = { version: 1, dimensions: parseClassKey(k)!, classKey: k, reviewReasons: [], raw: {} as DerivedCapability["raw"] };
      expect(capabilityVerdict(cap, { enabled: true, requiresOfferEvidence: false }, [], HASH)).toMatchObject({ instant: false, reason: "offer_evidence_missing" });
      expect(capabilityVerdict(cap, { enabled: true, requiresOfferEvidence: false }, [{ classKey: k, offerTermsHash: "d".repeat(64), revokedAt: null }], HASH)).toMatchObject({ instant: false });
      expect(capabilityVerdict(cap, { enabled: true, requiresOfferEvidence: false }, [{ classKey: k, offerTermsHash: HASH, revokedAt: null }], HASH)).toEqual({ instant: true, classKey: k });
    }
  });

  it("per-unit and mixed-price listed-start keys can never be switched on", () => {
    for (const shape of ["listed_start_single", "listed_starts_customer_selected"]) {
      for (const arrival of ["self", "pickup_required"]) {
        expect(neverEnabledReason(`live.${shape}.${arrival}.internal.per_unit`)).toBe("private_units_inquiry");
        expect(neverEnabledReason(`live.${shape}.${arrival}.internal.mixed_person_plus_unit`)).toBe("private_units_inquiry");
      }
    }
  });

  it("listed starts sell only when every slot is 'any time' with a stored end; fixed shapes and unknown slots never", () => {
    const anyTime = (end: number | null, start = 600) => ({ isAnyTime: true, startMinutes: start, endMinutes: end });
    const [single, choice] = LISTED_START_CLASS_KEYS;
    expect(listedStartsSellable(true, choice, [anyTime(660), anyTime(720)])).toBe(true);
    expect(listedStartsSellable(true, choice, [anyTime(660), anyTime(null)])).toBe(false);
    expect(listedStartsSellable(true, single, [{ isAnyTime: false, startMinutes: 600, endMinutes: 660 }])).toBe(false);
    expect(listedStartsSellable(true, "live.fixed_slot_choice.self.internal.per_person", [anyTime(660)])).toBe(false);
    expect(listedStartsSellable(true, single, [])).toBe(false);
    expect(listedStartsSellable(true, single, null)).toBe(false);
  });

  it("a slot with no stored end sells when the offer's hours give one (OpenAPI TimeSlotPublicDto.endTime), never without them", () => {
    const anyTime = (end: number | null, start = 600) => ({ isAnyTime: true, startMinutes: start, endMinutes: end });
    const [, choice] = LISTED_START_CLASS_KEYS;
    expect(listedStartsSellable(true, choice, [anyTime(660), anyTime(null)], 2)).toBe(true);
    for (const hours of [undefined, null, 0, -1]) expect(listedStartsSellable(true, choice, [anyTime(660), anyTime(null)], hours)).toBe(false);
    // A derived end at or past midnight is undocumented: unknown (review 85 A3).
    expect(listedStartsSellable(true, choice, [anyTime(null, 22 * 60)], 3)).toBe(false);
    expect(listedStartsSellable(true, choice, [anyTime(null, 22 * 60)], 2)).toBe(false);
    expect(listedStartsSellable(true, choice, [anyTime(null, 22 * 60)], 1)).toBe(true);
  });

  it("only the two Batch 2 keys and the four Batch 6 external keys lift the listed-start refusal: a flagged internal pickup key never does", () => {
    const anyTime = (end: number | null, start = 600) => ({ isAnyTime: true, startMinutes: start, endMinutes: end });
    for (const shape of ["listed_start_single", "listed_starts_customer_selected"]) {
      const key = `live.${shape}.pickup_required.internal.per_person`;
      expect(LISTED_START_CLASS_KEYS).not.toContain(key);
      // Even when the gate allowed the key (its flag on and evidence recorded), the start-time path stays shut.
      expect(listedStartsSellable(true, key, [anyTime(660), anyTime(720)])).toBe(false);
      // Batch 6: the external listed-start keys (self arrival and pickup) are lifted, only when the gate allows them.
      for (const ext of [`live.${shape}.self.external.per_person`, `live.${shape}.pickup_required.external.per_person`]) {
        expect(LISTED_START_CLASS_KEYS).not.toContain(ext);
        expect(listedStartsSellable(true, ext, [anyTime(660), anyTime(720)])).toBe(true);
        expect(listedStartsSellable(false, ext, [anyTime(660), anyTime(720)])).toBe(false);
      }
      // A per-unit external listed-start key never is (Batch 4 skipped).
      expect(listedStartsSellable(true, `live.${shape}.self.external.per_unit`, [anyTime(660), anyTime(720)])).toBe(false);
    }
  });

  it("a listed-start fixture with pickup, an external route or a per-trip price leaves the Batch 2 keys", () => {
    const base = (listedChoiceFixture as { offers: Json[] }).offers[0];
    const variant = (over: Json) => {
      const wire = { ...listedChoiceFixture, offers: [{ ...base, ...over }] };
      return deriveCapabilities(asStored(tourDetailFrom(tourDetailsWire.parse(wire)).offers[0])).classKey;
    };
    expect(variant({ isDirectReporting: false })).toBe("live.listed_starts_customer_selected.pickup_required.internal.per_person");
    expect(LISTED_START_CLASS_KEYS).not.toContain(variant({ isDirectReporting: false }));
    const slotsOff = (base.timeSlots as Json[]).map((t) => ({ ...t, isAnyTime: false }));
    expect(variant({ timeSlots: slotsOff })).toBe(CHOICE);
  });
});

describe.skipIf(!HAS_LEDGER)("Batch 2 coverage over the 22 November 2026 catalogue", () => {
  it("with the Batch 2 flags on as well, exactly the 16 Batch 0 offers plus the 2 Batch 2 offers pass, and never more than the old gate", () => {
    const passed: string[] = [];
    for (const r of LEDGER) {
      const payload = offerFromLedger(r);
      const cap = deriveCapabilities(payload);
      const v = capabilityVerdict(cap, B2_FLAGS.get(cap.classKey) ?? null, listedEvidence(cap.classKey), HASH);
      if (v.instant) {
        passed.push(r.offerId);
        expect(legacyLiveBookGate(payload)).toBe(true);
      }
    }
    const want = LEDGER.filter((r) => r.planBatch === "B0" || r.planBatch === "B2").map((r) => r.offerId);
    expect(want).toHaveLength(18);
    expect(passed.sort()).toEqual(want.sort());
  });

  it("no per-unit or mixed-price listed-start offer passes, even with every listed-start key on", () => {
    for (const r of LEDGER) {
      const cap = deriveCapabilities(offerFromLedger(r));
      if (cap.dimensions.timeShape !== "listed_start_single" && cap.dimensions.timeShape !== "listed_starts_customer_selected") continue;
      if (cap.dimensions.pricingUnit === "per_person") continue;
      expect(capabilityVerdict(cap, { enabled: true, requiresOfferEvidence: false }, [], HASH).instant).toBe(false);
    }
  });
});

/* ---------------------------------------------------------------------------
 * Batch 5: the one open-dated ticket key (doc 29 §3.3, §7.3)
 * ------------------------------------------------------------------------ */

const TICKET = "ticket.open_dated.self.internal.per_person";
const ticketEvidence = (classKey: string) => (classKey === TICKET ? [{ classKey, offerTermsHash: HASH, revokedAt: null }] : []);
/** Every composed ticket key the vocabulary allows, switched on without asking for evidence (a flag row that lies). */
const ALL_TICKET_KEYS = ["self", "pickup_required"].flatMap((arrival) => ["internal", "external"].flatMap((route) => ["per_person", "per_unit", "mixed_person_plus_unit"].map((unit) => `ticket.open_dated.${arrival}.${route}.${unit}`)));

describe("Batch 5 ticket key", () => {
  it("is exactly one key, open dated, self arrival, internal, per person; sellable in principle and never seeded", () => {
    expect([...TICKET_CLASS_KEYS]).toEqual([TICKET]);
    expect(parseClassKey(TICKET)).toEqual({ fulfilment: "ticket", timeShape: "open_dated", arrival: "self", route: "internal", pricingUnit: "per_person" });
    expect(neverEnabledReason(TICKET)).toBeNull();
    expect(SEEDED_CLASS_KEYS).not.toContain(TICKET);
    for (const k of ALL_TICKET_KEYS.filter((k) => k !== TICKET)) expect(neverEnabledReason(k), k).not.toBeNull();
  });

  it("contract fixture (synthetic) parses with the production schema, derives the ticket key, and is instant only with its flag on and evidence for it", () => {
    const parsed = tourDetailsWire.safeParse(ticketFixture);
    expect(parsed.success).toBe(true);
    const detail = tourDetailFrom(parsed.data!);
    expect(detail.warnings).toEqual([]);
    const cap = deriveCapabilities(asStored(detail.offers[0]));
    expect(cap.classKey).toBe(TICKET);
    expect(cap.reviewReasons).toEqual([]);
    expect(capabilityVerdict(cap, null, [], HASH)).toEqual({ instant: false, classKey: TICKET, reason: "flag_off" });
    expect(capabilityVerdict(cap, { enabled: false, requiresOfferEvidence: true }, ticketEvidence(TICKET), HASH).instant).toBe(false);
    // A flag row claiming no evidence is needed is not believed for a non-seeded key.
    expect(capabilityVerdict(cap, { enabled: true, requiresOfferEvidence: false }, [], HASH)).toMatchObject({ instant: false, reason: "offer_evidence_missing" });
    expect(capabilityVerdict(cap, { enabled: true, requiresOfferEvidence: true }, [{ classKey: SINGLE, offerTermsHash: HASH, revokedAt: null }], HASH).instant).toBe(false);
    expect(capabilityVerdict(cap, { enabled: true, requiresOfferEvidence: true }, [{ classKey: TICKET, offerTermsHash: "e".repeat(64), revokedAt: null }], HASH).instant).toBe(false);
    expect(capabilityVerdict(cap, { enabled: true, requiresOfferEvidence: true }, [{ classKey: TICKET, offerTermsHash: HASH, revokedAt: "2026-11-20T00:00:00Z" }], HASH).instant).toBe(false);
    expect(capabilityVerdict(cap, { enabled: true, requiresOfferEvidence: true }, ticketEvidence(TICKET), HASH)).toEqual({ instant: true, classKey: TICKET });
  });

  it("the same ticket fixture with a slot, hotel pickup or an external route leaves the ticket key and can never be switched on", () => {
    const base = (ticketFixture as { offers: Json[] }).offers[0];
    const variant = (over: Json) => deriveCapabilities(asStored(tourDetailFrom(tourDetailsWire.parse({ ...ticketFixture, offers: [{ ...base, ...over }] })).offers[0]));
    const slot = { id: 951, name: "Midnight", startTime: 0, endTime: 0, daysOffered: 0, isAnyTime: false, isOnRequest: false, minimumAdvancedBooking: 0, isExternal: false, offerId: 90051 };
    const withSlot = variant({ timeSlots: [slot] });
    expect(withSlot.classKey).toBe(UNKNOWN_CLASS);
    expect(withSlot.reviewReasons).toContain("ticket_with_slots");
    const pickup = variant({ isDirectReporting: false });
    expect(pickup.classKey).toBe("ticket.open_dated.pickup_required.internal.per_person");
    const external = variant({ isExternal: true });
    expect(external.classKey).toBe("ticket.open_dated.self.external.per_person");
    for (const cap of [withSlot, pickup, external]) {
      expect(capabilityVerdict(cap, { enabled: true, requiresOfferEvidence: true }, [{ classKey: cap.classKey, offerTermsHash: HASH, revokedAt: null }], HASH).instant).toBe(false);
    }
  });

  it("bookingKindSellable: the kind must agree with the class, and nothing passes a refused verdict", () => {
    const yes = (classKey: string) => ({ instant: true as const, classKey });
    expect(bookingKindSellable("live_book", yes(SINGLE))).toBe(true);
    expect(bookingKindSellable("ticket_only", yes(TICKET))).toBe(true);
    expect(bookingKindSellable("ticket_only", yes(SINGLE))).toBe(false);
    expect(bookingKindSellable("live_book", yes(TICKET))).toBe(false);
    expect(bookingKindSellable("ticket_only", yes("ticket.open_dated.self.external.per_person"))).toBe(false);
    expect(bookingKindSellable("on_request", yes(SINGLE))).toBe(false);
    expect(bookingKindSellable("unknown", yes(TICKET))).toBe(false);
    expect(bookingKindSellable("ticket_only", { instant: false, classKey: TICKET, reason: "flag_off" })).toBe(false);
    expect(bookingKindSellable("live_book", { instant: false, classKey: SINGLE, reason: "flag_off" })).toBe(false);
  });
});

describe.skipIf(!HAS_LEDGER)("Batch 5 coverage over the 22 November 2026 catalogue", () => {
  const verdictWith = (flags: Map<string, CapabilityFlagState>, evidence: (k: string) => { classKey: string; offerTermsHash: string; revokedAt: null }[]) =>
    LEDGER.map((r) => {
      const payload = offerFromLedger(r);
      const cap = deriveCapabilities(payload);
      const v = capabilityVerdict(cap, flags.get(cap.classKey) ?? null, evidence(cap.classKey), HASH);
      const kind = r.bookingKind;
      return { r, payload, cap, v, sellable: bookingKindSellable(kind, v) };
    });

  it("with the ticket flag off (no row), the gate and the kind check pass exactly the 16 Batch 0 offers, never more than the old gate", () => {
    const rows = verdictWith(SEEDED_FLAGS, () => []);
    const passed = rows.filter((x) => x.sellable).map((x) => x.r.offerId);
    for (const x of rows.filter((x) => x.sellable)) expect(legacyLiveBookGate(x.payload)).toBe(true);
    expect(passed.sort()).toEqual(LEDGER.filter((r) => r.planBatch === "B0").map((r) => r.offerId).sort());
    expect(rows.some((x) => x.sellable && x.cap.dimensions.fulfilment === "ticket")).toBe(false);
  });

  it("with the ticket flag on and per-offer evidence, exactly the 54 Batch 5 offers are added; offer 1592 never passes", () => {
    const flags = new Map<string, CapabilityFlagState>([...SEEDED_FLAGS, [TICKET, { enabled: true, requiresOfferEvidence: true }]]);
    const rows = verdictWith(flags, ticketEvidence);
    const tickets = rows.filter((x) => x.sellable && x.cap.classKey === TICKET).map((x) => x.r.offerId);
    const want = LEDGER.filter((r) => r.planBatch === "B5").map((r) => r.offerId);
    expect(want).toHaveLength(54);
    expect(tickets.sort()).toEqual(want.sort());
    expect(rows.filter((x) => x.sellable).length).toBe(16 + 54);
    expect(rows.find((x) => x.r.offerId === "1592")!.sellable).toBe(false);
    // The ticket offers sell only as TicketOnly, never under a live-book mapping.
    for (const x of rows.filter((x) => x.cap.classKey === TICKET)) expect(bookingKindSellable("live_book", x.v)).toBe(false);
  });

  it("with every ticket key switched on and evidence for each, still only the 54 internal self-arrival offers pass", () => {
    const flags = new Map<string, CapabilityFlagState>([...SEEDED_FLAGS, ...ALL_TICKET_KEYS.map((k) => [k, { enabled: true, requiresOfferEvidence: false }] as const)]);
    const rows = verdictWith(flags, (k) => [{ classKey: k, offerTermsHash: HASH, revokedAt: null }]);
    const tickets = rows.filter((x) => x.sellable && x.cap.dimensions.fulfilment === "ticket");
    expect(tickets).toHaveLength(54);
    expect(tickets.every((x) => x.cap.classKey === TICKET)).toBe(true);
    expect(rows.find((x) => x.r.offerId === "1592")!.v.instant).toBe(false);
  });
});

/* ---------------------------------------------------------------------------
 * Batch 6: the five per-person external keys (doc 29 §3.3, §7.3, reduced scope)
 * ------------------------------------------------------------------------ */

const B6_KEYS = [
  "live.fixed_slot_single.self.external.per_person",
  "live.listed_start_single.self.external.per_person",
  "live.listed_starts_customer_selected.self.external.per_person",
  "live.listed_start_single.pickup_required.external.per_person",
  "live.listed_starts_customer_selected.pickup_required.external.per_person",
];
const B6_FLAGS = new Map<string, CapabilityFlagState>([...SEEDED_FLAGS, ...B6_KEYS.map((k) => [k, { enabled: true, requiresOfferEvidence: true }] as const)]);
const b6Evidence = (classKey: string) => (B6_KEYS.includes(classKey) ? [{ classKey, offerTermsHash: HASH, revokedAt: null }] : []);

describe("Batch 6 external keys", () => {
  it("are exactly the five per-person external keys, sellable in principle and never seeded; the external per-unit keys stay inquiry", () => {
    expect([...EXTERNAL_CLASS_KEYS].sort()).toEqual([...B6_KEYS].sort());
    for (const k of B6_KEYS) {
      expect(parseClassKey(k)?.route).toBe("external");
      expect(neverEnabledReason(k), k).toBeNull();
      expect(SEEDED_CLASS_KEYS).not.toContain(k);
    }
    for (const shape of ["listed_start_single", "listed_starts_customer_selected", "fixed_slot_single"]) {
      for (const arrival of ["self", "pickup_required"]) {
        expect(neverEnabledReason(`live.${shape}.${arrival}.external.per_unit`)).toBe("private_units_inquiry");
        expect(neverEnabledReason(`live.${shape}.${arrival}.external.mixed_person_plus_unit`)).toBe("private_units_inquiry");
      }
    }
    // An external key no batch built (no ledger offer has it) stays refused.
    expect(neverEnabledReason("live.fixed_slot_choice.self.external.per_person")).toBe("external_route_unproven");
    expect(neverEnabledReason("live.fixed_slot_single.pickup_required.external.per_person")).toBe("external_route_unproven");
    expect(neverEnabledReason("live.date_only_no_slot_metadata.self.external.per_person")).toBe("date_only_inquiry");
  });

  it.each([
    ["fixed single start, self arrival (synthetic, negative advance)", extFixedSingle, B6_KEYS[0], false],
    ["one listed start, self arrival (synthetic)", extListedSingle, B6_KEYS[1], true],
    ["several listed starts, self arrival (synthetic, negative advance)", extListedChoice, B6_KEYS[2], true],
    ["one listed start, hotel pickup (synthetic)", extListedSinglePickup, B6_KEYS[3], true],
    ["several listed starts, hotel pickup (synthetic)", extListedChoicePickup, B6_KEYS[4], true],
  ])("contract fixture %s parses with the production schema, derives its key, and is instant only with its flag on and evidence for it", (_name, wire, key, listed) => {
    const parsed = tourDetailsWire.safeParse(wire);
    expect(parsed.success).toBe(true);
    const detail = tourDetailFrom(parsed.data!);
    expect(detail.warnings).toEqual([]);
    const payload = asStored(detail.offers[0]);
    const cap = deriveCapabilities(payload);
    expect(cap.classKey).toBe(key);
    expect(cap.reviewReasons).toEqual([]);
    expect(capabilityVerdict(cap, null, [], HASH)).toMatchObject({ instant: false, reason: "flag_off" });
    // The flag alone is not enough, even a flag row that claims no evidence is needed.
    expect(capabilityVerdict(cap, { enabled: true, requiresOfferEvidence: false }, [], HASH)).toMatchObject({ instant: false, reason: "offer_evidence_missing" });
    expect(capabilityVerdict(cap, { enabled: true, requiresOfferEvidence: true }, [{ classKey: key, offerTermsHash: "c".repeat(64), revokedAt: null }], HASH)).toMatchObject({ instant: false, reason: "offer_evidence_missing" });
    const v = capabilityVerdict(cap, { enabled: true, requiresOfferEvidence: true }, b6Evidence(key), HASH);
    expect(v).toEqual({ instant: true, classKey: key });
    expect(bookingKindSellable("live_book", v)).toBe(true);
    expect(bookingKindSellable("ticket_only", v)).toBe(false);
    const stored = payload as { timeSlots: { isAnyTime: boolean; startMinutes: number; endMinutes: number | null }[]; durationHours: number };
    expect(listedStartsSellable(v.instant, key, stored.timeSlots, stored.durationHours)).toBe(listed);
  });

  it("the same fixture with a per-trip price is a per-unit external key, and never instant whatever its flag says", () => {
    const base = (extListedSingle as { offers: Json[] }).offers[0];
    const periods = (base.pricingPeriods as Json[]).map((p) => ({ ...p, pricePerAdult: 0, pricePerChild: 0, pricePerTrip: 500, pricePerAdultUsd: 0, pricePerChildUsd: 0, pricePerTripUsd: 136.24 }));
    const detail = tourDetailFrom(tourDetailsWire.parse({ ...extListedSingle, offers: [{ ...base, privateType: 1, pricingPeriods: periods }] }));
    const cap = deriveCapabilities(asStored(detail.offers[0]));
    expect(cap.classKey).toBe("live.listed_start_single.self.external.per_unit");
    expect(capabilityVerdict(cap, { enabled: true, requiresOfferEvidence: false }, [{ classKey: cap.classKey, offerTermsHash: HASH, revokedAt: null }], HASH)).toMatchObject({ instant: false, reason: "class_not_sellable" });
  });
});

describe.skipIf(!HAS_LEDGER)("Batch 6 coverage over the 22 November 2026 catalogue", () => {
  const rows = (flags: Map<string, CapabilityFlagState>, evidence: (k: string) => { classKey: string; offerTermsHash: string; revokedAt: null }[]) =>
    LEDGER.map((r) => {
      const payload = offerFromLedger(r);
      const cap = deriveCapabilities(payload);
      const v = capabilityVerdict(cap, flags.get(cap.classKey) ?? null, evidence(cap.classKey), HASH);
      return { r, payload, cap, v, sellable: bookingKindSellable(r.bookingKind, v) };
    });

  it("the ledger has 57 Batch 6 offers on the five keys (1 + 31 + 17 + 5 + 3), and 22 external per-unit offers that stay inquiry", () => {
    const b6 = LEDGER.filter((r) => r.planBatch === "B6");
    const perPerson = b6.filter((r) => B6_KEYS.includes(r.targetCapabilityClass));
    expect(perPerson).toHaveLength(57);
    expect(B6_KEYS.map((k) => perPerson.filter((r) => r.targetCapabilityClass === k).length)).toEqual([1, 31, 17, 5, 3]);
    const perUnit = b6.filter((r) => r.targetCapabilityClass.endsWith(".external.per_unit"));
    expect(perUnit).toHaveLength(22);
    expect(b6.length).toBe(57 + 22);
  });

  it("with the Batch 6 flags off nothing external passes: exactly the 16 Batch 0 offers, as before", () => {
    const passed = rows(SEEDED_FLAGS, () => []).filter((x) => x.sellable);
    expect(passed.map((x) => x.r.offerId).sort()).toEqual(LEDGER.filter((r) => r.planBatch === "B0").map((r) => r.offerId).sort());
    expect(passed.some((x) => x.cap.dimensions.route === "external")).toBe(false);
  });

  it("with the five flags on and per-offer evidence, exactly the 57 offers are added, never more than the old gate, and no non-Batch-6 key gains", () => {
    const all = rows(B6_FLAGS, b6Evidence);
    const passed = all.filter((x) => x.sellable);
    for (const x of passed) expect(legacyLiveBookGate(x.payload)).toBe(true);
    const external = passed.filter((x) => x.cap.dimensions.route === "external").map((x) => x.r.offerId);
    const want = LEDGER.filter((r) => r.planBatch === "B6" && B6_KEYS.includes(r.targetCapabilityClass)).map((r) => r.offerId);
    expect(external.sort()).toEqual(want.sort());
    expect(passed).toHaveLength(16 + 57);
    // Everything else that passes is exactly what passed with the seeded flags alone.
    const other = passed.filter((x) => x.cap.dimensions.route !== "external").map((x) => x.r.offerId);
    expect(other.sort()).toEqual(LEDGER.filter((r) => r.planBatch === "B0").map((r) => r.offerId).sort());
  });

  it("with every external key switched on (per-unit and mixed included) and evidence for each, still only the 57 per-person offers pass; per-unit external stays refused", () => {
    const keys = new Set(LEDGER.map((r) => r.targetCapabilityClass).filter((k) => k.includes(".external.")));
    const flags = new Map<string, CapabilityFlagState>([...SEEDED_FLAGS, ...[...keys].map((k) => [k, { enabled: true, requiresOfferEvidence: false }] as const)]);
    const all = rows(flags, (k) => [{ classKey: k, offerTermsHash: HASH, revokedAt: null }]);
    const external = all.filter((x) => x.sellable && x.cap.dimensions.route === "external");
    expect(external).toHaveLength(57);
    expect(external.every((x) => B6_KEYS.includes(x.cap.classKey))).toBe(true);
    for (const x of all.filter((x) => x.cap.dimensions.route === "external" && x.cap.dimensions.pricingUnit !== "per_person")) expect(x.v.instant).toBe(false);
    expect(all.find((x) => x.r.offerId === "1592")!.v.instant).toBe(false);
  });
});
