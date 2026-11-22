import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  capabilityVerdict,
  neverEnabledReason,
  parseClassKey,
  PICKUP_CLASS_KEYS,
  SEEDED_CLASS_KEYS,
  type DerivedCapability,
} from "../traveldesk/traveldesk.capability";

/**
 * The Batch 3 class keys (doc 29 §3.3, §7.3 Batch 3): fixed start, hotel
 * pickup, internal, per person. Composable and switchable through the
 * approval path, **off** until then (no seeded row), and never instant
 * without per-offer evidence for that exact key, whatever a flag row says.
 */

const HASH = "c".repeat(64);
const capOf = (classKey: string): DerivedCapability => ({
  version: 1,
  dimensions: parseClassKey(classKey)!,
  classKey,
  reviewReasons: [],
  raw: {} as DerivedCapability["raw"],
});

/** The ledger's target class per offer (docs/backend/29a-offer-coverage-ledger.csv; no quoted commas in that column's neighbours matter here). */
function ledgerClasses(): string[] {
  const text = readFileSync(join(process.cwd(), "docs/backend/29a-offer-coverage-ledger.csv"), "utf8").trim().split("\n");
  const header = text[0].split(",");
  const col = header.indexOf("targetCapabilityClass");
  return text.slice(1).map((line) => {
    // Quoted fields may hold commas: split respecting quotes.
    const cells: string[] = [];
    let cur = "";
    let q = false;
    for (const ch of line) {
      if (ch === '"') q = !q;
      else if (ch === "," && !q) {
        cells.push(cur);
        cur = "";
      } else cur += ch;
    }
    cells.push(cur);
    return cells[col];
  });
}

describe("Batch 3 pickup class keys", () => {
  it("are the two fixed-start, pickup, internal, per-person keys, composable and allowed to be switched on", () => {
    expect([...PICKUP_CLASS_KEYS]).toEqual(["live.fixed_slot_single.pickup_required.internal.per_person", "live.fixed_slot_choice.pickup_required.internal.per_person"]);
    for (const k of PICKUP_CLASS_KEYS) {
      expect(parseClassKey(k)).toMatchObject({ fulfilment: "live", arrival: "pickup_required", route: "internal", pricingUnit: "per_person" });
      expect(neverEnabledReason(k)).toBeNull();
    }
  });

  it("are not seeded: off until an approved flag change", () => {
    for (const k of PICKUP_CLASS_KEYS) {
      expect(SEEDED_CLASS_KEYS).not.toContain(k);
      expect(capabilityVerdict(capOf(k), null, [], HASH)).toEqual({ instant: false, classKey: k, reason: "flag_off" });
    }
    const seed = readFileSync(join(process.cwd(), "prisma/migrations/20261122120000_b1a_capability_flags/migration.sql"), "utf8");
    for (const k of PICKUP_CLASS_KEYS) expect(seed).not.toContain(k);
  });

  it("need evidence for that exact key and current terms even if a flag row claims otherwise; only the seeded keys may sell without", () => {
    for (const k of PICKUP_CLASS_KEYS) {
      const cap = capOf(k);
      expect(capabilityVerdict(cap, { enabled: true, requiresOfferEvidence: false }, [], HASH)).toMatchObject({ instant: false, reason: "offer_evidence_missing" });
      expect(capabilityVerdict(cap, { enabled: true, requiresOfferEvidence: true }, [{ classKey: k, offerTermsHash: "d".repeat(64), revokedAt: null }], HASH)).toMatchObject({ instant: false });
      expect(capabilityVerdict(cap, { enabled: true, requiresOfferEvidence: true }, [{ classKey: k, offerTermsHash: HASH, revokedAt: null }], HASH)).toEqual({ instant: true, classKey: k });
    }
    for (const k of SEEDED_CLASS_KEYS) expect(capabilityVerdict(capOf(k), { enabled: true, requiresOfferEvidence: false }, [], HASH)).toEqual({ instant: true, classKey: k });
  });

  it("per-unit pickup keys stay inquiry (owner decision 7)", () => {
    expect(neverEnabledReason("live.fixed_slot_single.pickup_required.internal.per_unit")).toBe("private_units_inquiry");
    expect(neverEnabledReason("live.fixed_slot_single.pickup_required.internal.mixed_person_plus_unit")).toBe("private_units_inquiry");
  });

  it("cover 43 offers of the coverage ledger (42 single start, 1 choice)", () => {
    const classes = ledgerClasses();
    expect(classes).toHaveLength(317);
    expect(classes.filter((c) => c === PICKUP_CLASS_KEYS[0])).toHaveLength(42);
    expect(classes.filter((c) => c === PICKUP_CLASS_KEYS[1])).toHaveLength(1);
  });
});
