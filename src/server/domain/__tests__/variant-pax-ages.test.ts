import { describe, expect, it } from "vitest";
import { variantPaxAgesOf } from "../variant-pax-ages";
import { PAGE_PAX_AGES } from "@/lib/pax-ages";

/**
 * The supplier age check's read of raw content (doc 30 N4, review 102
 * N4-03, N4-10). Pure: synthetic content documents.
 */

const unit = (unitId: string, ageMin: number | null, ageMax: number | null) => ({
  unitId,
  label: unitId,
  per: "person",
  ageMin,
  ageMax,
  residency: "any",
  heightMinCm: null,
  heightMaxCm: null,
  seatConsuming: true,
  minQty: 0,
  maxQty: 10,
  price: { inr: 1000, aed: 40 },
  supplierUnit: unitId,
});

const content = (units: unknown) => ({ variants: [{ id: "shared", units }, { id: "other", units: [unit("adult", null, null)] }] });

describe("variantPaxAgesOf", () => {
  it("a whole-product mapping without variants reads the page's bands", () => {
    expect(variantPaxAgesOf(content([unit("child", 3, 7)]), null)).toEqual(PAGE_PAX_AGES);
  });

  it("an unknown variant, missing variants or non-object content read the page's bands", () => {
    expect(variantPaxAgesOf(content([unit("child", 3, 7)]), "gone")).toEqual(PAGE_PAX_AGES);
    expect(variantPaxAgesOf({}, "shared")).toEqual(PAGE_PAX_AGES);
    expect(variantPaxAgesOf(null, "shared")).toEqual(PAGE_PAX_AGES);
    expect(variantPaxAgesOf({ variants: "x" }, "shared")).toEqual(PAGE_PAX_AGES);
    expect(variantPaxAgesOf({ variants: [null, 3, { id: "shared" }] }, "shared")).toEqual(PAGE_PAX_AGES);
  });

  it("units that do not parse read the page's bands (readiness refuses the document itself)", () => {
    expect(variantPaxAgesOf(content([{ ...unit("child", 3, 7), ageMax: "seven" }]), "shared")).toEqual(PAGE_PAX_AGES);
    expect(variantPaxAgesOf(content([{ ...unit("child", 3, 7), extra: true }]), "shared")).toEqual(PAGE_PAX_AGES);
    expect(variantPaxAgesOf(content("units"), "shared")).toEqual(PAGE_PAX_AGES);
  });

  it("a variant's own narrower ages are read for that variant only", () => {
    const doc = content([unit("adult", 8, null), unit("child", 3, 7), unit("infant", null, 1)]);
    expect(variantPaxAgesOf(doc, "shared")).toEqual({
      adult: { min: 8, max: null },
      child: { min: 2, max: 7 },
      infant: { min: null, max: 1 },
      senior: { min: 60, max: null },
    });
    expect(variantPaxAgesOf(doc, "other")).toEqual(PAGE_PAX_AGES);
  });

  it("ages that leave no child age read the page's bands here; readiness refuses the variant", () => {
    expect(variantPaxAgesOf(content([unit("child", null, 2), unit("infant", null, 2)]), "shared")).toEqual(PAGE_PAX_AGES);
  });
});
