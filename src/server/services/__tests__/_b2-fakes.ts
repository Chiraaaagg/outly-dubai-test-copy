import { activities } from "@/lib/data/activities";
import type { Activity } from "@/lib/types";
import type { MarginPolicy, MarginService, UnitDefinition } from "../../quotes/contracts";
import type { MappingReadiness, ReadinessProduct } from "../readiness.service";

/**
 * Shared fakes for the B2 readiness and quote unit tests. No database, no
 * network, synthetic prices only (the supplier nets below are invented).
 */

export const PRODUCT_ID = "0190a000-0000-7000-8000-000000000001";
export const MAPPING_ID = "0190a000-0000-7000-8000-0000000000aa";

export const ADULT: UnitDefinition = {
  unitId: "adult",
  label: "Adult (12+)",
  per: "person",
  ageMin: 12,
  ageMax: null,
  residency: "any",
  heightMinCm: null,
  heightMaxCm: null,
  seatConsuming: true,
  minQty: 0,
  maxQty: 10,
  price: { inr: 5000, aed: 200 },
  supplierUnit: "adult",
};

export const CHILD: UnitDefinition = { ...ADULT, unitId: "child", label: "Child (3–11)", ageMin: 3, ageMax: 11, price: { inr: 4000, aed: 160 }, supplierUnit: "child" };

/** The policy text a page shows for `hours`, worded so readiness `policyTextAgrees` with it. */
export function policyText(hours: number): string {
  return hours === 0 ? "Non-refundable once confirmed." : `Free cancellation up to ${hours} hours before the start. After that, no refund.`;
}

/** A stored document that passes every content rule for instant. The policy text follows `freeCancellationHours` unless given. */
export function instantDoc(over: Partial<Activity> = {}): Activity {
  const base = activities[0];
  return {
    ...base,
    confirmation: "instant",
    fulfilmentMode: "inquiry", // the content copy is never read (PRD-11)
    addOns: [],
    freeCancellationHours: 0,
    cancellationPolicy: policyText(over.freeCancellationHours ?? 0),
    pickupIncluded: false,
    timeSlots: ["09:00"],
    // The page price equals the unit price for each pax type (readiness `unitPriceShown`).
    price: { ...base.price, adult: ADULT.price, child: CHILD.price },
    variants: [{ id: "shared", name: "Shared", blurb: "", delta: { inr: 0, aed: 0 }, highlights: [], isPrivate: false, units: [ADULT, CHILD] }],
    ...over,
  };
}

export function product(over: Partial<ReadinessProduct> = {}, doc: Activity = instantDoc()): ReadinessProduct {
  return { id: PRODUCT_ID, status: "published", deletedAt: null, fulfilmentMode: "instant", content: doc, ...over };
}

export function mapping(over: Partial<MappingReadiness> = {}): MappingReadiness {
  return {
    mappingId: MAPPING_ID,
    variantId: "shared",
    state: "ready",
    approvedOfferHash: "a".repeat(64),
    capabilityReady: true,
    slotRulesKnown: true,
    supplierUnits: ["adult", "child", "infant"],
    netAedMinorByUnit: { adult: 10_000n, child: 8_000n },
    issuesTicketsAtConfirm: "yes",
    supplierFreeCancellationHours: null,
    environment: "test",
    pickupOffered: false,
    // The page's "09:00" (instantDoc) is the offer's one stored start (doc 29 Batch 0 time-slot rule).
    slotStartMinutes: [540],
    anyTimeSlots: false,
    ...over,
  };
}

export const POLICY: MarginPolicy = { version: 3, floorBps: 1500, effectiveFrom: "2026-01-01T00:00:00Z" };

/**
 * Margin fake: gross margin on the charged amount with the AED net converted
 * at a synthetic 25 INR/AED; refuses below the floor. Allocation is largest
 * remainder like the real one.
 */
export function fakeMargin(opts: { policy?: MarginPolicy | null; fxMissing?: boolean } = {}): MarginService & { evaluated: unknown[] } {
  const evaluated: unknown[] = [];
  return {
    evaluated,
    async currentPolicy() {
      if (opts.policy === null) throw new Error("not configured");
      return opts.policy ?? POLICY;
    },
    async evaluate(input) {
      evaluated.push(input);
      if (input.currency === "INR" && opts.fxMissing) return { ok: false, reason: "fx_input_missing" };
      const net = input.currency === "INR" ? input.supplierNetAedMinor * 25n : input.supplierNetAedMinor;
      if (input.chargedMinor <= 0n) return { ok: false, reason: "margin_below_floor" };
      const bps = Number(((input.chargedMinor - net) * 10_000n) / input.chargedMinor);
      if (bps < input.policy.floorBps) return { ok: false, reason: "margin_below_floor" };
      return { ok: true, snapshot: { policyVersion: input.policy.version, floorBps: input.policy.floorBps, grossMarginBps: bps, costLines: [] } };
    },
    allocate(lines, discount, tax) {
      const total = lines.reduce((s, l) => s + l, 0n);
      const share = (amount: bigint) => {
        if (total === 0n) return lines.map(() => 0n);
        const raw = lines.map((l) => (amount * l) / total);
        let left = amount - raw.reduce((s, r) => s + r, 0n);
        for (let i = 0; left > 0n; i = (i + 1) % lines.length, left--) raw[i] += 1n;
        return raw;
      };
      const d = share(discount);
      const t = share(tax);
      return lines.map((_, i) => ({ discountAllocMinor: d[i], taxAllocMinor: t[i] }));
    },
  };
}
