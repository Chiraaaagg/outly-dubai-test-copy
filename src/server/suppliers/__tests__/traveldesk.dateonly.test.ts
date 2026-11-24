import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import availabilityFixtures from "./fixtures/traveldesk/availability-date-only.json";
import dateOnlyPickupFixture from "./fixtures/traveldesk/capability-date-only-pickup.json";
import dateOnlySelfFixture from "./fixtures/traveldesk/capability-date-only-self.json";
import { storedOffer, storedTour } from "./fixtures/traveldesk-terms";
import { buildBookingRequest } from "../traveldesk/traveldesk.booking";
import { availabilityFrom, availabilityWire, tourDetailFrom, tourDetailsWire, type TravelDeskAvailabilityRow, type TravelDeskOffer } from "../traveldesk/traveldesk.codec";
import {
  bookingKindSellable,
  capabilityKeyNote,
  capabilityVerdict,
  DATE_ONLY_CLASS_KEYS,
  DATE_ONLY_Q5_UNCONFIRMED,
  dateOnlySellable,
  deriveCapabilities,
  EXTERNAL_CLASS_KEYS,
  legacyLiveBookGate,
  listedStartsSellable,
  LISTED_START_CLASS_KEYS,
  neverEnabledReason,
  PICKUP_CLASS_KEYS,
  SEEDED_CLASS_KEYS,
  TICKET_CLASS_KEYS,
  type CapabilityFlagState,
} from "../traveldesk/traveldesk.capability";
import { parseStoredOffer, parseStoredPolicy, type StoredOffer } from "../traveldesk/traveldesk.offer-terms";
import { dateOnlyBookingSlot, dateOnlyCutoffMs, dateOnlyStartsFrom, dateOnlyStartsOn, quoteSlot, type QuoteUnits } from "../traveldesk/traveldesk.quote";
import { row, SERVICE_DATE, storedSlot } from "./fixtures/traveldesk-terms";

/**
 * Doc 29 Batch 7: date-only offers (live book, no slot in the tour metadata),
 * built switched off while TravelDesk's answer to Q5 ("which slot id and
 * times should a booking send?") is outstanding. The reading taken is
 * TravelDesk's own documentation: copy `timeSlotId`, `startTime` and
 * `endTime` from a fresh availability row; several rows may share a slot id.
 *
 *  - the two keys, their note, and that every other date-only key stays refused;
 *  - one sanitised contract fixture per key (tour shape) and one availability
 *    fixture per case: one row, several starts, shared slot id, no row,
 *    unpriced, zero price, capacity sentinel, rows that disagree;
 *  - the quote copies exactly the row's values, and the booking request sends them;
 *  - coverage over the 22 November ledger: flags off changes nothing; on with
 *    evidence adds exactly the 24 Batch 7 offers; no other key is ever more
 *    permissive than before.
 * Pure: no database. Synthetic ids and prices only.
 */

type Json = Record<string, unknown>;

const SELF = "live.date_only_no_slot_metadata.self.internal.per_person";
const PICKUP = "live.date_only_no_slot_metadata.pickup_required.internal.per_person";
const HASH = "a".repeat(64);
const DATE = "2026-12-31";
const NOW = new Date("2026-11-01T08:00:00Z");
const PARTY: QuoteUnits = { adults: 2, children: 1, infants: 0 };
const policy = parseStoredPolicy(storedTour());

function asStored(o: TravelDeskOffer): Json {
  return JSON.parse(JSON.stringify(o, (_k, v) => (typeof v === "bigint" ? v.toString() : v))) as Json;
}

function dateOnlyOffer(over: Json = {}): StoredOffer {
  const o = parseStoredOffer(storedOffer({ timeSlots: [], durationHours: 3, ...over }));
  if (!o) throw new Error("fixture does not parse");
  return o;
}

/** The fixture's rows for one case, through the production wire schema and codec. */
function rowsOf(name: keyof typeof availabilityFixtures): { rows: TravelDeskAvailabilityRow[]; warnings: string[] } {
  const wire = availabilityFixtures[name];
  if (!Array.isArray(wire)) throw new Error(`no case ${name}`);
  return availabilityFrom(availabilityWire.parse(wire));
}

function quote(rows: TravelDeskAvailabilityRow[], over: { slotRef?: string | null; units?: QuoteUnits; now?: Date; offer?: StoredOffer } = {}) {
  return quoteSlot({
    offer: over.offer ?? dateOnlyOffer(),
    policy,
    serviceDate: DATE,
    slotRef: over.slotRef === undefined ? null : over.slotRef,
    units: over.units ?? PARTY,
    rows,
    now: over.now ?? NOW,
    issuesTicketsAtConfirm: "no",
  });
}

describe("Batch 7 date-only keys", () => {
  it("are exactly the two internal per-person keys of the plan, sellable in principle, never seeded, each with the Q5 note", () => {
    expect([...DATE_ONLY_CLASS_KEYS].sort()).toEqual([PICKUP, SELF]);
    for (const k of DATE_ONLY_CLASS_KEYS) {
      expect(neverEnabledReason(k), k).toBeNull();
      expect(SEEDED_CLASS_KEYS).not.toContain(k);
      expect(capabilityKeyNote(k)).toBe(DATE_ONLY_Q5_UNCONFIRMED);
    }
    expect(DATE_ONLY_Q5_UNCONFIRMED).toMatch(/Q5/);
    expect(DATE_ONLY_Q5_UNCONFIRMED).toMatch(/off until TravelDesk answers/);
    // No other key carries the note.
    for (const k of [...SEEDED_CLASS_KEYS, ...LISTED_START_CLASS_KEYS, ...PICKUP_CLASS_KEYS, ...EXTERNAL_CLASS_KEYS, ...TICKET_CLASS_KEYS]) expect(capabilityKeyNote(k), k).toBeNull();
  });

  it("every other date-only key stays refused: external route, per unit, mixed price", () => {
    expect(neverEnabledReason("live.date_only_no_slot_metadata.self.external.per_person")).toBe("date_only_inquiry");
    expect(neverEnabledReason("live.date_only_no_slot_metadata.pickup_required.external.per_person")).toBe("date_only_inquiry");
    expect(neverEnabledReason("live.date_only_no_slot_metadata.self.internal.per_unit")).toBe("private_units_inquiry");
    expect(neverEnabledReason("live.date_only_no_slot_metadata.pickup_required.internal.mixed_person_plus_unit")).toBe("private_units_inquiry");
  });

  it.each([
    ["direct reporting (synthetic)", dateOnlySelfFixture, SELF],
    ["hotel pickup (synthetic)", dateOnlyPickupFixture, PICKUP],
  ])("contract fixture %s parses with the production schema, derives %s, and is instant only with its flag on and evidence for it", (_name, wire, key) => {
    const parsed = tourDetailsWire.safeParse(wire);
    expect(parsed.success).toBe(true);
    const detail = tourDetailFrom(parsed.data!);
    expect(detail.warnings).toEqual([]);
    const payload = asStored(detail.offers[0]);
    const cap = deriveCapabilities(payload);
    expect(cap.classKey).toBe(key);
    expect(cap.reviewReasons).toEqual([]);
    const slots = (payload as { timeSlots: unknown[] }).timeSlots;
    expect(slots).toEqual([]);
    expect(capabilityVerdict(cap, null, [], HASH)).toMatchObject({ instant: false, reason: "flag_off" });
    // A flag row that claims no evidence is needed is not believed for a non-seeded key.
    expect(capabilityVerdict(cap, { enabled: true, requiresOfferEvidence: false }, [], HASH)).toMatchObject({ instant: false, reason: "offer_evidence_missing" });
    expect(capabilityVerdict(cap, { enabled: true, requiresOfferEvidence: true }, [{ classKey: key, offerTermsHash: "c".repeat(64), revokedAt: null }], HASH)).toMatchObject({ reason: "offer_evidence_missing" });
    expect(capabilityVerdict(cap, { enabled: true, requiresOfferEvidence: true }, [{ classKey: SELF === key ? PICKUP : SELF, offerTermsHash: HASH, revokedAt: null }], HASH)).toMatchObject({ reason: "offer_evidence_missing" });
    const v = capabilityVerdict(cap, { enabled: true, requiresOfferEvidence: true }, [{ classKey: key, offerTermsHash: HASH, revokedAt: null }], HASH);
    expect(v).toEqual({ instant: true, classKey: key });
    expect(bookingKindSellable("live_book", v)).toBe(true);
    expect(bookingKindSellable("ticket_only", v)).toBe(false);
    // Sells as date only exactly then; never as listed starts.
    expect(dateOnlySellable(v.instant, v.classKey, slots)).toBe(true);
    expect(dateOnlySellable(false, v.classKey, slots)).toBe(false);
    expect(listedStartsSellable(v.instant, v.classKey, slots as never, 3)).toBe(false);
  });

  it("dateOnlySellable is false for any other key, for an offer that lists slots, and for an unreadable offer", () => {
    expect(dateOnlySellable(true, SELF, [])).toBe(true);
    expect(dateOnlySellable(true, "live.date_only_no_slot_metadata.self.external.per_person", [])).toBe(false);
    expect(dateOnlySellable(true, SEEDED_CLASS_KEYS[0], [])).toBe(false);
    expect(dateOnlySellable(true, SELF, [storedSlot()])).toBe(false);
    expect(dateOnlySellable(true, SELF, null)).toBe(false);
    expect(dateOnlySellable(true, SELF, undefined)).toBe(false);
  });
});

describe("availability contract fixtures for a date-only offer", () => {
  it("parse with the production schema; an unpriced date is dropped by the codec as not on sale", () => {
    for (const name of Object.keys(availabilityFixtures).filter((k) => k !== "_comment") as (keyof typeof availabilityFixtures)[]) {
      expect(availabilityWire.safeParse(availabilityFixtures[name]).success, name).toBe(true);
    }
    const unpriced = rowsOf("unpriced");
    expect(unpriced.rows).toEqual([]);
    expect(unpriced.warnings).toHaveLength(1);
    expect(rowsOf("singleWholeDay").rows[0]).toMatchObject({ date: DATE, timeSlotId: 0, startMinutes: 0, endMinutes: 1439, seatsLeft: 40 });
  });

  it("dateOnlyStartsFrom groups rows by start, keeps rows sharing a slot id together, and refuses rows it cannot copy or that disagree", () => {
    expect(dateOnlyStartsFrom(DATE, rowsOf("singleWholeDay").rows)).toMatchObject([{ timeSlotId: 0, startMinutes: 0, endMinutes: 1439 }]);
    expect(dateOnlyStartsFrom(DATE, rowsOf("singleZeroEnd").rows)).toMatchObject([{ timeSlotId: 0, startMinutes: 0, endMinutes: 0 }]);
    const shared = dateOnlyStartsFrom(DATE, rowsOf("sharedSlotId").rows)!;
    expect(shared).toHaveLength(1);
    expect(shared[0].rows.map((r) => r.seatsLeft)).toEqual([2, 12]);
    expect(dateOnlyStartsFrom(DATE, rowsOf("severalStarts").rows)!.map((s) => [s.timeSlotId, s.startMinutes, s.endMinutes])).toEqual([
      [7, 1080, 1260],
      [8, 1200, 1380],
    ]);
    expect(dateOnlyStartsFrom(DATE, rowsOf("none").rows)).toEqual([]);
    expect(dateOnlyStartsFrom(DATE, rowsOf("conflictingSlotIds").rows)).toBeNull();
    expect(dateOnlyStartsFrom(DATE, rowsOf("conflictingEnds").rows)).toBeNull();
    expect(dateOnlyStartsFrom(DATE, rowsOf("endBeforeStart").rows)).toBeNull();
    // Rows for another date do not count.
    expect(dateOnlyStartsFrom("2027-01-01", rowsOf("singleWholeDay").rows)).toEqual([]);
    // A negative id or a start past the day cannot be copied.
    expect(dateOnlyStartsFrom(SERVICE_DATE, [row({ timeSlotId: -1, startMinutes: 0, endMinutes: 10 })])).toBeNull();
    expect(dateOnlyStartsFrom(SERVICE_DATE, [row({ timeSlotId: 0, startMinutes: 1440, endMinutes: 1440 })])).toBeNull();
  });
});

describe("date-only quote (quoteSlot with no stored slot)", () => {
  it("one row: the guest picks only the date; the result carries the row's own values and no slot reference", () => {
    const r = quote(rowsOf("singleWholeDay").rows);
    expect(r).toEqual({
      ok: true,
      slotRef: null,
      netAedMinor: 52_000n, // 2 × 200 + 1 × 120 AED (synthetic)
      netUsdMinor: 14_170n,
      checkedAt: NOW.toISOString(),
      capacity: "limited",
      seatsLeft: 40,
      // 00:00 Asia/Dubai on the service date: advance hours are slot metadata, which this offer has none of.
      cutoffUtc: "2026-12-30T20:00:00.000Z",
      issuesTicketsAtConfirm: "no",
      // 72 h before 00:00 Dubai on the service date: no start is shown, so the earliest one counts.
      supplierFreeCancellationUntilUtc: "2026-12-27T20:00:00.000Z",
      ticketValidUntil: null,
      availabilitySlot: { timeSlotId: 0, startMinutes: 0, endMinutes: 1439 },
    });
    expect(quote(rowsOf("singleZeroEnd").rows)).toMatchObject({ ok: true, slotRef: null, availabilitySlot: { timeSlotId: 0, startMinutes: 0, endMinutes: 0 } });
    // Naming the one start is accepted and names the row exactly.
    expect(quote(rowsOf("singleWholeDay").rows, { slotRef: "00:00" })).toMatchObject({ ok: true, slotRef: "0@00:00", availabilitySlot: { timeSlotId: 0, startMinutes: 0, endMinutes: 1439 } });
    expect(quote(rowsOf("singleWholeDay").rows, { slotRef: "18:00" })).toEqual({ ok: false, reason: "invalid_slot" });
  });

  it("several starts: a start must be chosen (Batch 2 behaviour), and the chosen row's values are carried", () => {
    const rows = rowsOf("severalStarts").rows;
    expect(quote(rows)).toEqual({ ok: false, reason: "invalid_slot" });
    expect(quote(rows, { slotRef: "18:00" })).toMatchObject({
      ok: true,
      slotRef: "7@18:00",
      availabilitySlot: { timeSlotId: 7, startMinutes: 1080, endMinutes: 1260 },
      // Counted from the chosen start, 18:00 Dubai.
      supplierFreeCancellationUntilUtc: "2026-12-28T14:00:00.000Z",
    });
    expect(quote(rows, { slotRef: "8@20:00" })).toMatchObject({ ok: true, slotRef: "8@20:00", seatsLeft: 3, availabilitySlot: { timeSlotId: 8, startMinutes: 1200, endMinutes: 1380 } });
    expect(quote(rows, { slotRef: "7@20:00" })).toEqual({ ok: false, reason: "invalid_slot" });
    expect(quote(rows, { slotRef: "19:00" })).toEqual({ ok: false, reason: "invalid_slot" });
    expect(quote(rows, { slotRef: "9 pm" })).toEqual({ ok: false, reason: "invalid_slot" });
    // Three seats left, four seated guests.
    expect(quote(rows, { slotRef: "20:00", units: { adults: 3, children: 1, infants: 0 } })).toEqual({ ok: false, reason: "sold_out" });
  });

  it("rows sharing one slot id: the first with enough seats", () => {
    expect(quote(rowsOf("sharedSlotId").rows)).toMatchObject({ ok: true, seatsLeft: 12, availabilitySlot: { timeSlotId: 0, startMinutes: 0, endMinutes: 1439 } });
    expect(quote(rowsOf("sharedSlotId").rows, { units: { adults: 1, children: 0, infants: 0 } })).toMatchObject({ ok: true, seatsLeft: 2 });
  });

  it("no row, an unpriced date, a zero price, a capacity sentinel or rows that disagree: not on sale, never a guess", () => {
    for (const name of ["none", "unpriced", "zeroPrice", "capacitySentinel", "conflictingSlotIds", "conflictingEnds", "endBeforeStart"] as const) {
      expect(quote(rowsOf(name).rows), name).toEqual({ ok: false, reason: "availability_unknown" });
    }
    // A per-trip price (vehicles, Q-C8) is unknown capacity too.
    const perTrip = dateOnlyOffer({ privateType: "private" });
    expect(quote(rowsOf("singleWholeDay").rows, { offer: perTrip })).toEqual({ ok: false, reason: "availability_unknown" });
    // A price dated another day is not this date's price.
    const other = rowsOf("singleWholeDay").rows.map((r) => ({ ...r, price: { ...r.price, date: "2026-12-30" } }));
    expect(quote(other)).toEqual({ ok: false, reason: "availability_unknown" });
  });

  it("sold out, closed and the service-day cut-off", () => {
    const base = rowsOf("singleWholeDay").rows;
    expect(quote(base.map((r) => ({ ...r, seatsLeft: 2 })))).toEqual({ ok: false, reason: "sold_out" });
    expect(quote(base.map((r) => ({ ...r, price: { ...r.price, isBookable: false } })))).toEqual({ ok: false, reason: "sold_out" });
    expect(quote(base.map((r) => ({ ...r, seatsLeft: 0 })))).toEqual({ ok: false, reason: "closed" });
    expect(dateOnlyCutoffMs(DATE)).toBe(Date.parse("2026-12-30T20:00:00Z"));
    expect(quote(base, { now: new Date("2026-12-30T19:59:59Z") })).toMatchObject({ ok: true });
    expect(quote(base, { now: new Date("2026-12-30T20:00:00Z") })).toEqual({ ok: false, reason: "past_cutoff" });
    expect(quote(base, { now: new Date("2026-12-31T06:00:00Z") })).toEqual({ ok: false, reason: "past_cutoff" });
    // Pax rules and the weekday mask still apply first.
    expect(quote(base, { units: { adults: 30, children: 0, infants: 0 } })).toEqual({ ok: false, reason: "unit_rule_failed" });
  });

  it("an offer that lists slots is quoted as before: no availability slot on its result", () => {
    const fixed = parseStoredOffer(storedOffer())!;
    const r = quoteSlot({ offer: fixed, policy, serviceDate: SERVICE_DATE, slotRef: "21:00", units: PARTY, rows: [row()], now: NOW, issuesTicketsAtConfirm: "no" });
    expect(r).toMatchObject({ ok: true, slotRef: "11@21:00" });
    expect(r).not.toHaveProperty("availabilitySlot");
    // And a date-only row (slot 0) against it is still refused: no stored rules.
    expect(quoteSlot({ offer: fixed, policy, serviceDate: SERVICE_DATE, slotRef: null, units: PARTY, rows: [row({ timeSlotId: 0, startMinutes: 0, endMinutes: 1439 })], now: NOW, issuesTicketsAtConfirm: "no" })).toMatchObject({ ok: false });
  });
});

describe("date-only start times for the page (Batch 2 marks reused)", () => {
  it("one start or none: no times (the guest picks only the date); several: the listed starts with marks", () => {
    const offer = dateOnlyOffer();
    expect(dateOnlyStartsOn(offer, DATE, rowsOf("singleWholeDay").rows, NOW)).toBeNull();
    expect(dateOnlyStartsOn(offer, DATE, rowsOf("sharedSlotId").rows, NOW)).toBeNull();
    expect(dateOnlyStartsOn(offer, DATE, rowsOf("none").rows, NOW)).toBeNull();
    expect(dateOnlyStartsOn(offer, DATE, rowsOf("conflictingSlotIds").rows, NOW)).toBeNull();
    expect(dateOnlyStartsOn(offer, DATE, rowsOf("severalStarts").rows, NOW)).toEqual([
      { time: "18:00", status: "available" },
      { time: "20:00", status: "limited" },
    ]);
  });

  it("a sentinel start reads unavailable (the quote refuses it); past the cut-off every start does; an offer with slots is not date only", () => {
    const offer = dateOnlyOffer();
    const rows = rowsOf("severalStarts").rows.map((r) => (r.startMinutes === 1080 ? { ...r, seatsLeft: 99_999 } : r));
    expect(dateOnlyStartsOn(offer, DATE, rows, NOW)).toEqual([
      { time: "18:00", status: "unavailable" },
      { time: "20:00", status: "limited" },
    ]);
    expect(dateOnlyStartsOn(offer, DATE, rowsOf("severalStarts").rows, new Date("2026-12-31T00:00:00Z"))).toEqual([
      { time: "18:00", status: "unavailable" },
      { time: "20:00", status: "unavailable" },
    ]);
    expect(dateOnlyStartsOn(parseStoredOffer(storedOffer())!, DATE, rowsOf("severalStarts").rows, NOW)).toBeNull();
  });
});

describe("the booking sends exactly the availability row's values", () => {
  const request = (slot: ReturnType<typeof dateOnlyBookingSlot>) =>
    buildBookingRequest({ serviceDate: DATE, offerId: 97011, adults: 2, children: 1, infants: 0, guestName: "Synthetic Lead", clientRef: "OUT-TEST-1", totalCostMinor: 52_000n, totalCostUsdMinor: 14_170n, slot });

  it.each([
    ["one whole-day row", "singleWholeDay", null, { timeSlotId: 0, startTime: 0, endTime: 1439 }],
    ["one row ending 00:00", "singleZeroEnd", null, { timeSlotId: 0, startTime: 0, endTime: 0 }],
    ["rows sharing a slot id", "sharedSlotId", null, { timeSlotId: 0, startTime: 0, endTime: 1439 }],
    ["the chosen one of several starts", "severalStarts", "18:00", { timeSlotId: 7, startTime: 1080, endTime: 1260 }],
  ] as const)("%s", (_name, fixture, slotRef, sent) => {
    const q = quote(rowsOf(fixture).rows, { slotRef });
    if (!q.ok) throw new Error("expected a quote");
    const slot = dateOnlyBookingSlot({ slotRef: q.slotRef, availabilitySlot: q.availabilitySlot });
    expect(slot).toEqual({ timeSlotId: sent.timeSlotId, startMinutes: sent.startTime, endMinutes: sent.endTime });
    const body = request(slot);
    expect({ timeSlotId: body.timeSlotId, startTime: body.startTime, endTime: body.endTime }).toEqual(sent);
  });

  it("a line without the row, with a slot reference naming another row, or with values that cannot be sent is refused", () => {
    const a = { timeSlotId: 7, startMinutes: 1080, endMinutes: 1260 };
    expect(dateOnlyBookingSlot({ slotRef: null })).toBeNull();
    expect(dateOnlyBookingSlot({ slotRef: null, availabilitySlot: null })).toBeNull();
    expect(dateOnlyBookingSlot({ slotRef: "8@20:00", availabilitySlot: a })).toBeNull();
    expect(dateOnlyBookingSlot({ slotRef: "18:00", availabilitySlot: a })).toBeNull();
    expect(dateOnlyBookingSlot({ slotRef: "7@18:00", availabilitySlot: a })).toEqual(a);
    expect(dateOnlyBookingSlot({ slotRef: null, availabilitySlot: { timeSlotId: 0, startMinutes: 600, endMinutes: 60 } })).toBeNull();
    expect(dateOnlyBookingSlot({ slotRef: null, availabilitySlot: { timeSlotId: -1, startMinutes: 0, endMinutes: 1439 } })).toBeNull();
    expect(dateOnlyBookingSlot({ slotRef: null, availabilitySlot: { timeSlotId: 0, startMinutes: 0, endMinutes: 1440 } })).toBeNull();
  });
});

/* ---------------------------------------------------------------------------
 * Coverage over the 22 November catalogue (doc 29 §2.5 ledger)
 * ------------------------------------------------------------------------ */

/** Minimal CSV reader, as in traveldesk.capability.test.ts: quoted fields may hold commas; no embedded newlines. */
function parseCsv(text: string): Record<string, string>[] {
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
  const [head, ...rows] = text.split(/\r?\n/).filter((l) => l.length > 0).map(split);
  return rows.map((r) => Object.fromEntries(head.map((h, i) => [h, r[i] ?? ""])));
}

// The ledger lives in the private docs folder, which the public test copy does not export: there this block is skipped.
const LEDGER_PATH = path.resolve(import.meta.dirname, "../../../../docs/backend/29a-offer-coverage-ledger.csv");
const HAS_LEDGER = existsSync(LEDGER_PATH);
const LEDGER = HAS_LEDGER ? parseCsv(readFileSync(LEDGER_PATH, "utf8")) : [];

/** A stored offer with the ledger row's structure (the same construction as traveldesk.capability.test.ts; synthetic amounts). */
function offerFromLedger(r: Record<string, string>): Json {
  const bool = (k: string) => r[k] === "true";
  const n = Number(r.slotCount || 0);
  const starts = Number(r.slotDistinctStarts || 0);
  const units = [r.slotNumberOfUnitsMin, r.slotNumberOfUnitsMax].filter((u) => u !== "").map(Number);
  const timeSlots = Array.from({ length: n }, (_, i) => ({
    timeSlotId: i + 1,
    name: null,
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
  const price = (adult: string, child: string, trip: string) => ({ periodId: 1, dateStart: "2026-01-01", dateEnd: null, price: { currency: "AED", perAdultMinor: adult, perChildMinor: child, perTripMinor: trip } });
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

describe.skipIf(!HAS_LEDGER)("Batch 7 coverage over the 22 November 2026 catalogue", () => {
  const SEEDED = new Map<string, CapabilityFlagState>(SEEDED_CLASS_KEYS.map((k) => [k, { enabled: true, requiresOfferEvidence: false }]));
  const WITH_B7 = new Map<string, CapabilityFlagState>([...SEEDED, ...DATE_ONLY_CLASS_KEYS.map((k) => [k, { enabled: true, requiresOfferEvidence: true }] as const)]);
  const evidenceFor = (keys: readonly string[]) => (k: string) => (keys.includes(k) ? [{ classKey: k, offerTermsHash: HASH, revokedAt: null }] : []);
  const verdicts = (flags: Map<string, CapabilityFlagState>, evidence: (k: string) => { classKey: string; offerTermsHash: string; revokedAt: null }[]) =>
    LEDGER.map((r) => {
      const payload = offerFromLedger(r);
      const cap = deriveCapabilities(payload);
      const v = capabilityVerdict(cap, flags.get(cap.classKey) ?? null, evidence(cap.classKey), HASH);
      const slots = (payload as { timeSlots: unknown[] }).timeSlots;
      return { r, payload, cap, v, sellable: bookingKindSellable(r.bookingKind, v), dateOnly: dateOnlySellable(v.instant, v.classKey, slots) };
    });
  const b0 = () => LEDGER.filter((r) => r.planBatch === "B0").map((r) => r.offerId).sort();

  it("the ledger has 24 Batch 7 offers in 3 tours on the two keys (22 self arrival, 2 pickup), all live book with no slot", () => {
    const b7 = LEDGER.filter((r) => r.planBatch === "B7");
    expect(b7).toHaveLength(24);
    expect(new Set(b7.map((r) => r.tourId)).size).toBe(3);
    expect(b7.filter((r) => r.targetCapabilityClass === SELF)).toHaveLength(22);
    expect(b7.filter((r) => r.targetCapabilityClass === PICKUP)).toHaveLength(2);
    for (const r of b7) expect([r.bookingKind, r.slotCount]).toEqual(["live_book", "0"]);
    // Every date-only offer in the catalogue is a Batch 7 offer.
    expect(LEDGER.filter((r) => r.targetCapabilityClass.startsWith("live.date_only_no_slot_metadata.")).length).toBe(24);
  });

  it("with the Batch 7 flags off, coverage is unchanged: exactly the 16 Batch 0 offers, and no date-only offer sells as date only", () => {
    const all = verdicts(SEEDED, () => []);
    expect(all.filter((x) => x.sellable).map((x) => x.r.offerId).sort()).toEqual(b0());
    expect(all.some((x) => x.dateOnly)).toBe(false);
    // A flag on without evidence is still nothing.
    const noEvidence = verdicts(WITH_B7, () => []);
    expect(noEvidence.filter((x) => x.sellable).map((x) => x.r.offerId).sort()).toEqual(b0());
  });

  it("with the two flags on and per-offer evidence, exactly the 24 offers are added, never more than the old gate", () => {
    const all = verdicts(WITH_B7, evidenceFor(DATE_ONLY_CLASS_KEYS));
    const passed = all.filter((x) => x.sellable);
    for (const x of passed) expect(legacyLiveBookGate(x.payload)).toBe(true);
    const dated = all.filter((x) => x.dateOnly).map((x) => x.r.offerId).sort();
    expect(dated).toEqual(LEDGER.filter((r) => r.planBatch === "B7").map((r) => r.offerId).sort());
    expect(passed).toHaveLength(16 + 24);
    expect(passed.filter((x) => !x.dateOnly).map((x) => x.r.offerId).sort()).toEqual(b0());
  });

  it("parity: for every non-Batch-7 key the verdict with the Batch 7 flags on is the verdict without them", () => {
    const before = verdicts(SEEDED, () => []);
    const after = verdicts(WITH_B7, evidenceFor(DATE_ONLY_CLASS_KEYS));
    for (let i = 0; i < LEDGER.length; i++) {
      if (DATE_ONLY_CLASS_KEYS.includes(before[i].cap.classKey)) continue;
      expect(after[i].v, LEDGER[i].offerId).toEqual(before[i].v);
      expect(after[i].dateOnly).toBe(false);
    }
  });

  it("with every key in the ledger switched on and evidence for each, date-only offers sell as date only only on the two keys", () => {
    const keys = [...new Set(LEDGER.map((r) => r.targetCapabilityClass))];
    const flags = new Map<string, CapabilityFlagState>(keys.map((k) => [k, { enabled: true, requiresOfferEvidence: true }]));
    const all = verdicts(flags, evidenceFor(keys));
    for (const x of all.filter((y) => y.dateOnly)) expect(DATE_ONLY_CLASS_KEYS).toContain(x.cap.classKey);
    expect(all.filter((x) => x.dateOnly)).toHaveLength(24);
  });
});
