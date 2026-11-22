import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import choiceFixture from "./fixtures/traveldesk/capability-fixed-slot-choice.json";
import tourFixture from "./fixtures/traveldesk/tour-5.json";
import { storedOffer, storedSlot } from "./fixtures/traveldesk-terms";
import { tourDetailFrom, tourDetailsWire, type TravelDeskOffer } from "../traveldesk/traveldesk.codec";
import {
  capabilityVerdict,
  classKeyOf,
  deriveCapabilities,
  INQUIRY_CLASS,
  legacyLiveBookGate,
  neverEnabledReason,
  parseClassKey,
  SEEDED_CLASS_KEYS,
  UNKNOWN_CLASS,
  type CapabilityFlagState,
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

  it("per-unit, date-only, ticket, unknown and inquiry keys can never be switched on (owner decisions 6 and 7)", () => {
    expect(neverEnabledReason("live.listed_starts_customer_selected.self.internal.per_unit")).toBe("private_units_inquiry");
    expect(neverEnabledReason("live.fixed_slot_single.pickup_required.internal.mixed_person_plus_unit")).toBe("private_units_inquiry");
    expect(neverEnabledReason("live.date_only_no_slot_metadata.self.internal.per_person")).toBe("date_only_inquiry");
    expect(neverEnabledReason("ticket.open_dated.self.internal.per_person")).toBe("ticket_booking_refused");
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

const LEDGER = parseCsv(readFileSync(path.resolve(import.meta.dirname, "../../../../docs/backend/29a-offer-coverage-ledger.csv"), "utf8"));

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

describe("parity over the 22 November 2026 catalogue (317 offers)", () => {
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
