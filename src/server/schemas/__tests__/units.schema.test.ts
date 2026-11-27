import { describe, expect, it } from "vitest";
import { activities } from "@/lib/data/activities";
import { activitySchema, unitDefinitionSchema } from "../activity.schema";
import type { UnitDefinition } from "../../quotes/contracts";

/** Typed units on variants (PRD-7). Optional: documents written before B2 parse unchanged. */

const unit: UnitDefinition = {
  unitId: "adult",
  label: "Adult",
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

const withUnits = (units: unknown[]) => ({ ...activities[0], variants: [{ id: "shared", name: "Shared", blurb: "", delta: { inr: 0, aed: 0 }, highlights: [], isPrivate: false, units }] });

describe("typed units", () => {
  it("old documents (no units anywhere) still parse, and units stay absent", () => {
    for (const a of activities) {
      const r = activitySchema.safeParse(a);
      expect(r.success).toBe(true);
      if (r.success) for (const v of r.data.variants) expect(v.units).toBeUndefined();
    }
  });

  it("a variant with units round-trips exactly", () => {
    const r = activitySchema.parse(withUnits([unit, { ...unit, unitId: "car", per: "booking", seatConsuming: false, supplierUnit: "trip", residency: "uae_resident", heightMaxCm: 190 }]));
    expect(r.variants[0].units?.[0]).toEqual(unit);
    expect(r.variants[0].units?.[1]).toMatchObject({ per: "booking", residency: "uae_resident", heightMaxCm: 190 });
  });

  it.each<[string, Partial<UnitDefinition> & Record<string, unknown>]>([
    ["min above max", { minQty: 5, maxQty: 2 }],
    ["age range inverted", { ageMin: 12, ageMax: 3 }],
    ["height range inverted", { heightMinCm: 150, heightMaxCm: 120 }],
    ["negative price", { price: { inr: -1, aed: 0 } }],
    ["unknown residency", { residency: "tourist" as never }],
    ["unknown key", { margin: 10 }],
    ["blank supplier unit", { supplierUnit: "" }],
  ])("refuses %s", (_name, over) => {
    expect(unitDefinitionSchema.safeParse({ ...unit, ...over }).success).toBe(false);
  });

  it("refuses duplicate unit ids within a variant", () => {
    const r = activitySchema.safeParse(withUnits([unit, unit]));
    expect(r.success).toBe(false);
    expect(r.error?.issues.some((i) => i.message === "Duplicate unit id")).toBe(true);
  });
});
