import { describe, expect, it, vi } from "vitest";
import {
  assessReadiness,
  createReadinessService,
  demotedForTrigger,
  fromCatalogReadiness,
  pageStartMinutes,
  policyTextAgrees,
  policyWithinSupplier,
  PRICING_SETTING_KEYS,
  READINESS_RULES_VERSION,
  slotTimesAgree,
  statedPolicyHours,
  unitRestricted,
  type EligibilityRow,
  type MappingReadiness,
  type ReadinessDeps,
  type ReadinessProduct,
} from "../readiness.service";
import { activitySchema } from "../../schemas/activity.schema";
import { activities } from "@/lib/data/activities";
import { ADULT, CHILD, fakeMargin, instantDoc, mapping, policyText, product, PRODUCT_ID } from "./_b2-fakes";
import type { UnitDefinition } from "../../quotes/contracts";

/**
 * Readiness rules and re-evaluation (doc 22 §22.1 item 3; PRD-4, PRD-11,
 * TKT-7). Pure: fakes for products, mappings, margin and the eligibility
 * store. The DB-backed trigger tests are in activity.service.test.ts and
 * import.service.test.ts.
 */

const ready = { releaseEnabled: true, margin: fakeMargin() };

async function reasonsFor(p: ReadinessProduct | null, mappings: MappingReadiness[] | null = [mapping()], over: Partial<Parameters<typeof assessReadiness>[0]> = {}) {
  const r = await assessReadiness({ product: p, mappings, ...ready, ...over });
  return r;
}

describe("assessReadiness: the rules", () => {
  it("the fixture document is valid content", () => {
    expect(activitySchema.safeParse(instantDoc()).success).toBe(true);
  });

  it("instant only when requested instant and nothing is in the way", async () => {
    const r = await reasonsFor(product());
    expect(r).toMatchObject({ requested: "instant", effective: "instant", reasons: [] });
  });

  it("requested inquiry stays inquiry even when every fact is ready", async () => {
    const r = await reasonsFor(product({ fulfilmentMode: "inquiry" }));
    expect(r).toMatchObject({ requested: "inquiry", effective: "inquiry", reasons: [] });
  });

  it("never reads the content copy of the mode (PRD-11)", async () => {
    const r = await reasonsFor(product({ fulfilmentMode: "inquiry" }, instantDoc({ fulfilmentMode: "instant" })));
    expect(r.effective).toBe("inquiry");
  });

  it.each<[string, () => Promise<{ reasons: string[]; effective: string }>, string]>([
    ["release switch off", () => reasonsFor(product(), [mapping()], { releaseEnabled: false }), "release_switch_off"],
    ["draft", () => reasonsFor(product({ status: "draft" })), "not_published"],
    ["deleted", () => reasonsFor(product({ deletedAt: new Date() })), "not_published"],
    ["no product", () => reasonsFor(null), "not_published"],
    ["invalid stored content (PRD-13)", () => reasonsFor(product({}, { broken: true } as never)), "not_published"],
    ["editorial confirmation manual", () => reasonsFor(product({}, instantDoc({ confirmation: "manual" }))), "editorial_confirmation_not_instant"],
    ["add-ons nobody books", () => reasonsFor(product({}, instantDoc({ addOns: [{ id: "photo", name: "Photo", description: "", price: { inr: 1, aed: 1 }, perPerson: false, category: "photo" }] }))), "safety_fact_unknown"],
    ["no variants at all", () => reasonsFor(product({}, instantDoc({ variants: [] }))), "units_missing"],
    ["variant without units (old document)", () => reasonsFor(product({}, instantDoc({ variants: [{ ...instantDoc().variants[0], units: undefined }] }))), "units_missing"],
    ["supplier seam not wired", () => reasonsFor(product(), null), "variant_without_mapping"],
    ["variant added without a mapping", () => reasonsFor(product({}, instantDoc({ variants: [...instantDoc().variants, { ...instantDoc().variants[0], id: "private", name: "Private" }] }))), "variant_without_mapping"],
    ["variant id renamed", () => reasonsFor(product({}, instantDoc({ variants: [{ ...instantDoc().variants[0], id: "shared-v2" }] }))), "variant_without_mapping"],
    ["mapping never approved", () => reasonsFor(product(), [mapping({ state: "unapproved", approvedOfferHash: null })]), "variant_without_mapping"],
    ["mapping revoked (inactive)", () => reasonsFor(product(), [mapping({ state: "inactive" })]), "mapping_inactive"],
    ["upstream changed after approval", () => reasonsFor(product(), [mapping({ state: "changed_upstream" })]), "mapping_changed_upstream"],
    ["upstream gone", () => reasonsFor(product(), [mapping({ state: "missing_upstream" })]), "mapping_missing_upstream"],
    ["adapter cannot book", () => reasonsFor(product(), [mapping({ capabilityReady: false })]), "capability_not_ready"],
    ["slot rules unknown", () => reasonsFor(product(), [mapping({ slotRulesKnown: false })]), "slot_rules_unknown"],
    ["page start time not the supplier's", () => reasonsFor(product({}, instantDoc({ timeSlots: ["10:00"] }))), "slot_times_mismatch"],
    ["page lists a start the supplier lacks", () => reasonsFor(product({}, instantDoc({ timeSlots: ["09:00", "21:00"] }))), "slot_times_mismatch"],
    ["supplier has a start the page lacks", () => reasonsFor(product(), [mapping({ slotStartMinutes: [540, 1260] })]), "slot_times_mismatch"],
    ["page without start times", () => reasonsFor(product({}, instantDoc({ timeSlots: [] }))), "slot_times_mismatch"],
    ["page time that is not HH:mm", () => reasonsFor(product({}, instantDoc({ timeSlots: ["9 am"] }))), "slot_times_mismatch"],
    ["supplier starts unknown", () => reasonsFor(product(), [mapping({ slotStartMinutes: undefined, anyTimeSlots: undefined })]), "slot_times_mismatch"],
    ["any-time offer (guest-chosen time not supported yet)", () => reasonsFor(product(), [mapping({ anyTimeSlots: true })]), "slot_any_time_unsupported"],
    ["unit not offered by the supplier", () => reasonsFor(product(), [mapping({ supplierUnits: ["adult"] })]), "unit_not_mapped"],
    ["supplier catalogue older than the staleness limit (doc 29 Batch 1b)", () => reasonsFor(product(), [mapping({ catalogueFresh: false })]), "catalogue_stale"],
    ["price lowered below the margin floor", () => reasonsFor(product({}, instantDoc({ variants: [{ ...instantDoc().variants[0], units: [{ ...ADULT, price: { inr: 2600, aed: 104 } }] }] }))), "margin_below_floor"],
    ["supplier net unknown", () => reasonsFor(product(), [mapping({ netAedMinorByUnit: null })]), "margin_below_floor"],
    ["per-trip supplier cost not sold through any unit", () => reasonsFor(product(), [mapping({ supplierUnits: ["adult", "child", "trip"], netAedMinorByUnit: { adult: 10_000n, child: 8_000n, trip: 50_000n } })]), "unit_not_mapped"],
    ["no INR exchange input", () => reasonsFor(product(), [mapping()], { margin: fakeMargin({ fxMissing: true }) }), "margin_below_floor"],
    ["no margin policy", () => reasonsFor(product(), [mapping()], { margin: fakeMargin({ policy: null }) }), "margin_below_floor"],
    ["free cancellation while tickets issue at confirm (TKT-7)", () => reasonsFor(product({}, instantDoc({ freeCancellationHours: 24 }))), "policy_exceeds_supplier"],
    ["pickup in content, offer not known to collect (CR-B2-4)", () => reasonsFor(product({}, instantDoc({ pickupIncluded: true })), [mapping({ pickupOffered: null })]), "safety_fact_unknown"],
    ["pickup in content, direct-reporting offer", () => reasonsFor(product({}, instantDoc({ pickupIncluded: true })), [mapping({ pickupOffered: false })]), "safety_fact_unknown"],
    ["offer collects from hotels, content has no pickup", () => reasonsFor(product(), [mapping({ pickupOffered: true })]), "safety_fact_unknown"],
    ["unit price differs from the page price (CR-B2-11)", () => reasonsFor(product({}, instantDoc({ price: { ...instantDoc().price, adult: { inr: 5200, aed: 200 } } }))), "unit_price_mismatch"],
    ["variant delta not reflected in the unit price", () => reasonsFor(product({}, instantDoc({ variants: [{ ...instantDoc().variants[0], delta: { inr: 500, aed: 20 } }] }))), "unit_price_mismatch"],
    ["a unit the page cannot show (resident rate)", () => reasonsFor(product({}, instantDoc({ variants: [{ ...instantDoc().variants[0], units: [ADULT, { ...ADULT, unitId: "resident", residency: "uae_resident" }] }] }))), "unit_price_mismatch"],
  ])("%s → %s", async (_name, run, reason) => {
    const r = await run();
    expect(r.reasons).toContain(reason);
    expect(r.effective).toBe("inquiry");
  });

  it("pickup agrees: content with pickup and an offer that collects is instant; unknown pickup facts pass only without pickup", async () => {
    expect((await reasonsFor(product({}, instantDoc({ pickupIncluded: true })), [mapping({ pickupOffered: true })])).effective).toBe("instant");
    expect((await reasonsFor(product(), [mapping({ pickupOffered: undefined })])).effective).toBe("instant");
  });

  it("page start times equal to the supplier's stored starts pass, in any order (doc 29 Batch 0)", async () => {
    const two = await reasonsFor(product({}, instantDoc({ timeSlots: ["21:00", "09:00"] })), [mapping({ slotStartMinutes: [540, 1260] })]);
    expect(two).toMatchObject({ effective: "instant", reasons: [] });
    expect(slotTimesAgree(["09:00", "09:00"], { slotStartMinutes: [540], anyTimeSlots: false })).toBe("ok");
    expect(slotTimesAgree(["09:00"], { slotStartMinutes: [540], anyTimeSlots: true })).toBe("slot_any_time_unsupported");
    expect(slotTimesAgree(["09:00"], { slotStartMinutes: [], anyTimeSlots: false })).toBe("slot_times_mismatch");
    expect(pageStartMinutes("21:30")).toBe(1290);
    expect(pageStartMinutes("24:00")).toBeNull();
    expect(pageStartMinutes("Flexible")).toBeNull();
  });

  it("the assessment carries the product version it read", async () => {
    expect((await reasonsFor(product({ version: 7 }))).productVersion).toBe(7);
    expect((await reasonsFor(product())).productVersion).toBeNull();
  });

  it("a sold-out variant needs no mapping; a product-level mapping serves a single active variant", async () => {
    const doc = instantDoc({ variants: [instantDoc().variants[0], { ...instantDoc().variants[0], id: "sunset", soldOut: true }] });
    expect((await reasonsFor(product({}, doc), [mapping({ variantId: null })])).effective).toBe("instant");
  });

  it("a product-level mapping does not cover two active variants", async () => {
    const doc = instantDoc({ variants: [instantDoc().variants[0], { ...instantDoc().variants[0], id: "sunset" }] });
    expect((await reasonsFor(product({}, doc), [mapping({ variantId: null })])).reasons).toEqual(["variant_without_mapping"]);
  });

  it("lists each reason once, in rule order", async () => {
    const r = await reasonsFor(product({ status: "draft" }, instantDoc({ confirmation: "manual" })), [mapping({ state: "inactive" }), mapping({ variantId: "x" })], { releaseEnabled: false });
    expect(r.reasons).toEqual(["release_switch_off", "not_published", "editorial_confirmation_not_instant", "mapping_inactive"]);
  });

  it("every fixture product is inquiry today (switch off, no units, no mappings)", async () => {
    for (const a of activities) {
      const r = await assessReadiness({ product: { id: a.id, status: "published", deletedAt: null, fulfilmentMode: "instant", content: a }, mappings: null, releaseEnabled: false, margin: fakeMargin() });
      expect(r.effective).toBe("inquiry");
    }
  });
});

describe("traveller restrictions the page does not state (CR-B2-10)", () => {
  const withUnits = (units: UnitDefinition[]) => product({}, instantDoc({ variants: [{ ...instantDoc().variants[0], units }] }));

  it.each<[string, UnitDefinition]>([
    ["UAE residents only", { ...ADULT, residency: "uae_resident" }],
    ["non-residents only", { ...CHILD, residency: "non_resident" }],
    ["a minimum height", { ...CHILD, heightMinCm: 110 }],
    ["a maximum height", { ...ADULT, heightMaxCm: 195 }],
    ["adults from 18, the page says 12+", { ...ADULT, ageMin: 18 }],
    ["adults up to 59", { ...ADULT, ageMax: 59 }],
    ["children from 4, the page says 3–11", { ...CHILD, ageMin: 4 }],
    ["children up to 10", { ...CHILD, ageMax: 10 }],
  ])("%s → safety_fact_unknown", async (_n, unit) => {
    expect(unitRestricted(unit)).toBe(true);
    const r = await reasonsFor(withUnits([ADULT, CHILD].map((u) => (u.unitId === unit.unitId ? unit : u))));
    expect(r.reasons).toContain("safety_fact_unknown");
    expect(r.effective).toBe("inquiry");
  });

  it("units that cover the page's own pax-type ages, with no residency or height bound, pass", async () => {
    expect(unitRestricted(ADULT)).toBe(false);
    expect(unitRestricted(CHILD)).toBe(false);
    expect(unitRestricted({ ...CHILD, ageMin: 2, ageMax: 12 })).toBe(false);
    expect(unitRestricted({ ...ADULT, ageMin: null })).toBe(false);
    expect(unitRestricted({ ...ADULT, unitId: "infant", ageMin: 0, ageMax: 2 })).toBe(false);
    expect(unitRestricted({ ...ADULT, unitId: "infant", ageMin: null, ageMax: 1 })).toBe(true);
    expect(unitRestricted({ ...ADULT, unitId: "senior", ageMin: 65 })).toBe(true);
    expect(unitRestricted({ ...ADULT, unitId: "resident" })).toBe(true);
    expect((await reasonsFor(withUnits([ADULT, { ...CHILD, ageMin: 2, ageMax: 12 }]))).effective).toBe("instant");
  });
});

describe("cancellation text against freeCancellationHours (CR-B2-7)", () => {
  it("reads digit durations in hours and days", () => {
    expect(statedPolicyHours("Free cancellation up to 48 hours before; 2 days for groups; 24h; 12 hrs")).toEqual([48, 48, 24, 12]);
    expect(statedPolicyHours("Non-refundable once confirmed.")).toEqual([]);
  });

  it.each<[string, string, number, boolean]>([
    ["the fixture wording", policyText(24), 24, true],
    ["the same hours as days", "Free cancellation up to 1 day before.", 24, true],
    ["different hours", "Free cancellation up to 48 hours before.", 24, false],
    ["a tiered policy", "Free cancellation up to 72 hours before. Inside 72 hours 50% is retained; inside 24 hours no refund.", 72, false],
    ["no stated hours for a refundable product", "Free cancellation.", 24, false],
    ["non-refundable", policyText(0), 0, true],
    ["hours stated for a non-refundable product", "Free cancellation up to 24 hours before.", 0, false],
    ["a refund promised without hours for a non-refundable product", "Full refund if the weather turns.", 0, false],
    // CR-B2-7 residual: refund promises in other words with 0 hours.
    ["fully refundable with 0 hours", "Fully refundable until the day before your visit.", 0, false],
    ["refundable with 0 hours", "Refundable up to the day before.", 0, false],
    ["a partial refund with 0 hours", "50% refund if cancelled.", 0, false],
    ["cancel anytime with 0 hours", "Cancel anytime for a refund.", 0, false],
    ["non-refundable then a refund promise", "Non-refundable once confirmed. Fully refundable before that.", 0, false],
    ["a refund word only in the opening non-refundable", "Non-refundable once your ticket is issued.", 0, true],
    ["no refund wording at all", "Tickets are issued at once.", 0, true],
  ])("%s → %s", (_n, text, hours, ok) => {
    expect(policyTextAgrees(text, hours)).toBe(ok);
  });

  it("a page whose text disagrees with its hours is safety_fact_unknown", async () => {
    const r = await reasonsFor(product({}, instantDoc({ cancellationPolicy: "Free cancellation up to 24 hours before your start time." })));
    expect(r.reasons).toEqual(["safety_fact_unknown"]);
    expect(r.effective).toBe("inquiry");
  });
});

describe("policyWithinSupplier (TKT-7, ISSUED_TICKET_REFUND_POLICY)", () => {
  it.each<[number, MappingReadiness["issuesTicketsAtConfirm"], number | null, boolean]>([
    [0, "yes", null, true],
    [0, "unknown", 48, true],
    [24, "yes", 48, false],
    [24, "unknown", 48, false],
    [0, "no", null, true],
    [24, "no", null, false],
    [24, "no", 0, false],
    [24, "no", 24, true],
    [48, "no", 24, true],
    [12, "no", 24, false],
  ])("displayed %ih, tickets %s, supplier %sh → %s", (hours, tickets, supplierHours, ok) => {
    expect(policyWithinSupplier(hours, { issuesTicketsAtConfirm: tickets, supplierFreeCancellationHours: supplierHours })).toBe(ok);
  });
});

/* ---------------------------------------------------------------------------
 * Service: persistence, audit, cache invalidation
 * ------------------------------------------------------------------------ */

function harness(opts: { products?: ReadinessProduct[]; mappings?: MappingReadiness[] | null; rows?: Map<string, EligibilityRow>; release?: boolean; failLoad?: boolean; candidates?: string[] | "fail" } = {}) {
  const rows = opts.rows ?? new Map<string, EligibilityRow>();
  let products = opts.products ?? [product()];
  const calls = { writes: [] as unknown[], audits: [] as unknown[], invalidations: 0, mappingReads: 0 };
  const deps: ReadinessDeps = {
    async loadProducts(ids) {
      if (opts.failLoad) throw new Error("database unreachable");
      return products.filter((p) => ids.includes(p.id));
    },
    async mappingSource() {
      if (opts.mappings === null) return null;
      return {
        async mappingReadinessFor() {
          calls.mappingReads++;
          return opts.mappings ?? [mapping()];
        },
      };
    },
    releaseEnabled: () => opts.release ?? true,
    margin: () => fakeMargin(),
    async readEligibility(ids) {
      return new Map([...rows].filter(([id]) => ids.includes(id)));
    },
    async listInstantCandidates() {
      if (opts.candidates === "fail") throw new Error("database unreachable");
      return opts.candidates ?? products.map((p) => p.id);
    },
    async writeEligibility(productId, row) {
      calls.writes.push({ productId, ...row });
      rows.set(productId, { effectiveMode: row.effectiveMode, reasons: row.reasons });
    },
    async auditChange(productId, before, after, trigger) {
      calls.audits.push({ productId, before, after, trigger });
    },
    invalidateCatalog: () => void calls.invalidations++,
    now: () => new Date("2026-11-01T08:00:00Z"),
  };
  const svc = createReadinessService(deps);
  return { svc, rows, calls, setProducts: (p: ReadinessProduct[]) => void (products = p) };
}

describe("readiness service", () => {
  it("evaluate is a read: it returns the contract shape and writes nothing", async () => {
    const h = harness();
    const r = await h.svc.evaluate(PRODUCT_ID);
    expect(r).toEqual({ productId: PRODUCT_ID, requested: "instant", effective: "instant", reasons: [], readinessVersion: READINESS_RULES_VERSION, evaluatedAt: "2026-11-01T08:00:00.000Z" });
    expect(h.calls.writes).toEqual([]);
  });

  it("reevaluate persists the verdict, audits the change and invalidates the catalogue once", async () => {
    const h = harness();
    await h.svc.reevaluate(PRODUCT_ID, "flip");
    expect(h.rows.get(PRODUCT_ID)).toEqual({ effectiveMode: "instant", reasons: [] });
    expect(h.calls.audits).toEqual([{ productId: PRODUCT_ID, before: null, after: { effectiveMode: "instant", reasons: [] }, trigger: "flip" }]);
    expect(h.calls.invalidations).toBe(1);
    // Same verdict again: no write, no audit, no invalidation.
    await h.svc.reevaluate(PRODUCT_ID, "sync");
    expect(h.calls.writes).toHaveLength(1);
    expect(h.calls.invalidations).toBe(1);
  });

  it.each([
    ["editor_save", instantDoc({ confirmation: "manual" }), "editorial_confirmation_not_instant"],
    ["import_apply", instantDoc({ variants: [...instantDoc().variants, { ...instantDoc().variants[0], id: "new" }] }), "variant_without_mapping"],
    ["import_revert", instantDoc({ variants: [{ ...instantDoc().variants[0], units: undefined }] }), "units_missing"],
    ["restore_version", instantDoc({ freeCancellationHours: 48 }), "policy_exceeds_supplier"],
  ] as const)("trigger %s: a broken fact demotes an instant product, audited, cache invalidated", async (trigger, doc, reason) => {
    const h = harness({ rows: new Map([[PRODUCT_ID, { effectiveMode: "instant", reasons: [] }]]) });
    h.setProducts([product({}, doc)]);
    const r = await h.svc.reevaluate(PRODUCT_ID, trigger);
    expect(r?.effective).toBe("inquiry");
    expect(h.rows.get(PRODUCT_ID)?.reasons).toContain(reason);
    expect(h.calls.audits).toMatchObject([{ trigger, before: { effectiveMode: "instant" }, after: { effectiveMode: "inquiry" } }]);
    expect(h.calls.invalidations).toBe(1);
  });

  it.each([
    ["mapping_revoke", [mapping({ state: "inactive" })], "mapping_inactive"],
    ["sync", [mapping({ state: "changed_upstream" })], "mapping_changed_upstream"],
    ["mapping_approve", [mapping({ state: "unapproved", approvedOfferHash: null })], "variant_without_mapping"],
  ] as const)("supplier-side trigger %s re-reads the mapping and demotes", async (trigger, mappings, reason) => {
    const h = harness({ mappings: [...mappings], rows: new Map([[PRODUCT_ID, { effectiveMode: "instant", reasons: [] }]]) });
    await h.svc.reevaluate(PRODUCT_ID, trigger);
    expect(h.rows.get(PRODUCT_ID)).toEqual({ effectiveMode: "inquiry", reasons: [reason] });
    expect(h.calls.invalidations).toBe(1);
  });

  it("supplier_policy_changed demotes an instant verdict even when the stored facts still pass (N6)", async () => {
    const h = harness({ rows: new Map([[PRODUCT_ID, { effectiveMode: "instant", reasons: [] }]]) });
    const r = await h.svc.reevaluate(PRODUCT_ID, "supplier_policy_changed");
    expect(r).toMatchObject({ effective: "inquiry", reasons: ["policy_exceeds_supplier"] });
    expect(h.rows.get(PRODUCT_ID)).toEqual({ effectiveMode: "inquiry", reasons: ["policy_exceeds_supplier"] });
    expect(h.calls.audits).toMatchObject([{ trigger: "supplier_policy_changed", after: { effectiveMode: "inquiry" } }]);
    expect(h.calls.invalidations).toBe(1);
    // The next sync re-runs on fresh facts and restores it when they agree.
    await h.svc.reevaluate(PRODUCT_ID, "sync");
    expect(h.rows.get(PRODUCT_ID)).toEqual({ effectiveMode: "instant", reasons: [] });
  });

  it("supplier_policy_changed leaves an inquiry verdict and its reasons alone", () => {
    const base = { productId: PRODUCT_ID, requested: "instant" as const, readinessVersion: READINESS_RULES_VERSION, evaluatedAt: "2026-11-01T08:00:00.000Z" };
    const inquiry = { ...base, effective: "inquiry" as const, reasons: ["margin_below_floor" as const] };
    expect(demotedForTrigger(inquiry, "supplier_policy_changed")).toBe(inquiry);
    const instant = { ...base, effective: "instant" as const, reasons: [] };
    expect(demotedForTrigger(instant, "sync")).toBe(instant);
  });

  it("mapping approve promotes a requested-instant product once everything is ready", async () => {
    const h = harness({ rows: new Map([[PRODUCT_ID, { effectiveMode: "inquiry", reasons: ["variant_without_mapping"] }]]) });
    await h.svc.reevaluate(PRODUCT_ID, "mapping_approve");
    expect(h.rows.get(PRODUCT_ID)).toEqual({ effectiveMode: "instant", reasons: [] });
    expect(h.calls.audits).toHaveLength(1);
  });

  it("the release switch off keeps everything inquiry", async () => {
    const h = harness({ release: false });
    await h.svc.reevaluate(PRODUCT_ID, "flip");
    expect(h.rows.get(PRODUCT_ID)).toEqual({ effectiveMode: "inquiry", reasons: ["release_switch_off"] });
    expect(h.calls.audits).toEqual([]);
    expect(h.calls.invalidations).toBe(0);
  });

  it("a failing evaluation demotes to inquiry and never throws", async () => {
    const h = harness({ failLoad: true, rows: new Map([[PRODUCT_ID, { effectiveMode: "instant", reasons: [] }]]) });
    await expect(h.svc.reevaluate(PRODUCT_ID, "editor_save")).resolves.toBeNull();
    expect(h.rows.get(PRODUCT_ID)).toEqual({ effectiveMode: "inquiry", reasons: ["capability_not_ready"] });
    expect(h.calls.invalidations).toBe(1);
  });

  it("reevaluateMany skips requested-inquiry products with no instant verdict, and re-checks the rest", async () => {
    const other = { ...product({ id: "0190a000-0000-7000-8000-000000000002", fulfilmentMode: "inquiry" }) };
    const demoted = { ...product({ id: "0190a000-0000-7000-8000-000000000003", fulfilmentMode: "inquiry" }) };
    const h = harness({ products: [product(), other, demoted], rows: new Map([[demoted.id, { effectiveMode: "instant", reasons: [] }]]) });
    const spy = vi.spyOn(h.svc, "reevaluate");
    await h.svc.reevaluateMany([PRODUCT_ID, other.id, demoted.id, PRODUCT_ID], "import_apply");
    expect(spy.mock.calls.map((c) => c[0])).toEqual([PRODUCT_ID, demoted.id]);
    expect(h.rows.get(demoted.id)).toEqual({ effectiveMode: "inquiry", reasons: [] });
    expect(h.rows.has(other.id)).toBe(false);
  });
});

describe("readiness service: pricing settings and rules versions (CR-B2-8)", () => {
  it("a margin policy, FX or cost-input write re-runs readiness for every instant candidate", async () => {
    expect([...PRICING_SETTING_KEYS].sort()).toEqual(["pricing.fx_inr_per_aed", "pricing.margin_cost_inputs", "pricing.margin_policy"]);
    for (const key of PRICING_SETTING_KEYS) {
      const h = harness({ candidates: [PRODUCT_ID], rows: new Map([[PRODUCT_ID, { effectiveMode: "instant", reasons: [] }]]) });
      const spy = vi.spyOn(h.svc, "reevaluateMany");
      await h.svc.reevaluateAfterSetting(key);
      expect(spy).toHaveBeenCalledWith([PRODUCT_ID], "pricing_settings_changed");
    }
  });

  it("a margin setting that breaks the floor demotes, audited under the pricing trigger", async () => {
    const h = harness({ rows: new Map([[PRODUCT_ID, { effectiveMode: "instant", reasons: [], readinessVersion: READINESS_RULES_VERSION }]]) });
    h.setProducts([product({}, instantDoc({ variants: [{ ...instantDoc().variants[0], units: [{ ...ADULT, price: { inr: 2600, aed: 104 } }] }] }))]);
    await h.svc.reevaluateAfterSetting("pricing.margin_policy");
    expect(h.rows.get(PRODUCT_ID)?.reasons).toContain("margin_below_floor");
    expect(h.calls.audits).toMatchObject([{ trigger: "pricing_settings_changed", after: { effectiveMode: "inquiry" } }]);
  });

  it("a stale catalogue demotes a stored instant verdict to inquiry under the catalogue-age trigger; a fresh one keeps it (doc 29 Batch 1b)", async () => {
    const instantRow = () => new Map([[PRODUCT_ID, { effectiveMode: "instant" as const, reasons: [], readinessVersion: READINESS_RULES_VERSION }]]);
    const fresh = harness({ candidates: [PRODUCT_ID], rows: instantRow(), mappings: [mapping({ catalogueFresh: true })] });
    await fresh.svc.reevaluateInstantCandidates("catalogue_age");
    expect(fresh.calls.writes).toEqual([]);
    expect(fresh.rows.get(PRODUCT_ID)).toMatchObject({ effectiveMode: "instant" });

    const stale = harness({ candidates: [PRODUCT_ID], rows: instantRow(), mappings: [mapping({ catalogueFresh: false })] });
    await stale.svc.reevaluateInstantCandidates("catalogue_age");
    expect(stale.rows.get(PRODUCT_ID)).toEqual({ effectiveMode: "inquiry", reasons: ["catalogue_stale"] });
    expect(stale.calls.audits).toMatchObject([{ trigger: "catalogue_age", after: { effectiveMode: "inquiry", reasons: ["catalogue_stale"] } }]);
    await expect(harness({ candidates: "fail" }).svc.reevaluateInstantCandidates("catalogue_age")).resolves.toBeUndefined();
  });

  it("any other setting is a no-op; a failure to list candidates never throws", async () => {
    const h = harness();
    const spy = vi.spyOn(h.svc, "reevaluateMany");
    await h.svc.reevaluateAfterSetting("sla");
    expect(spy).not.toHaveBeenCalled();
    await expect(harness({ candidates: "fail" }).svc.reevaluateAfterSetting("pricing.fx_inr_per_aed")).resolves.toBeUndefined();
  });

  it("a verdict stored under an older rules version is rewritten even when unchanged", async () => {
    const h = harness({ rows: new Map([[PRODUCT_ID, { effectiveMode: "instant", reasons: [], readinessVersion: READINESS_RULES_VERSION - 1 }]]) });
    await h.svc.reevaluate(PRODUCT_ID, "sync");
    expect(h.calls.writes).toMatchObject([{ productId: PRODUCT_ID, effectiveMode: "instant", readinessVersion: READINESS_RULES_VERSION }]);
    expect(h.calls.audits).toEqual([]);
    await h.svc.reevaluate(PRODUCT_ID, "sync");
    expect(h.calls.writes).toHaveLength(1);
  });
});

describe("fromCatalogReadiness: the supplier catalogue's states as readiness facts", () => {
  const m = (over: Record<string, unknown> = {}) => ({
    mappingId: "m-1",
    variantCode: "shared",
    environment: "test" as const,
    isActive: true,
    syncStatus: "ok",
    lastSyncedAt: null,
    bookingKind: "live_book",
    tourExternalId: "1",
    offerExternalId: "2",
    approvedOfferHash: "h",
    currentOfferHash: "h",
    issuesTicketsAtConfirm: "no" as const,
    ...over,
  });
  const wrap = (variants: unknown[]) => fromCatalogReadiness({ productId: PRODUCT_ID, environment: "test", variants, evaluatedAt: "x" } as never);

  it("maps blockers to states and keeps the mapping's own variant code", () => {
    const out = wrap([
      { variantCode: "shared", mapping: m(), blockers: [] },
      { variantCode: "private", mapping: null, blockers: ["variant_without_mapping"] },
      { variantCode: "sunset", mapping: m({ mappingId: "m-2", variantCode: "sunset" }), blockers: ["mapping_changed_upstream", "capability_not_ready", "slot_rules_unknown"] },
      { variantCode: "x", mapping: m({ mappingId: "m-3", variantCode: "x", approvedOfferHash: null }), blockers: ["mapping_changed_upstream"] },
      { variantCode: "y", mapping: m({ mappingId: "m-4", variantCode: "y" }), blockers: ["mapping_inactive"] },
    ]);
    expect(out.map((o) => [o.mappingId, o.variantId, o.state, o.capabilityReady, o.slotRulesKnown])).toEqual([
      ["m-1", "shared", "ready", true, true],
      ["m-2", "sunset", "changed_upstream", false, false],
      ["m-3", "x", "unapproved", true, true],
      ["m-4", "y", "inactive", true, true],
    ]);
    // Not reported by the catalogue yet: unknown, so the product stays inquiry.
    expect(out[0]).toMatchObject({ supplierUnits: [], netAedMinorByUnit: null, supplierFreeCancellationHours: null, issuesTicketsAtConfirm: "no" });
  });

  it("uses supplier units, nets and refund hours when the catalogue reports them", async () => {
    const [out] = wrap([
      {
        variantCode: "shared",
        mapping: m({ supplierUnits: ["adult", "child"], netAedMinorByUnit: { adult: 10_000n, child: 8_000n }, supplierFreeCancellationHours: 24, slotStartMinutes: [540], anyTimeSlots: false }),
        blockers: [],
      },
    ]);
    expect(out).toMatchObject({ supplierUnits: ["adult", "child"], netAedMinorByUnit: { adult: 10_000n, child: 8_000n }, supplierFreeCancellationHours: 24 });
    const r = await assessReadiness({ product: product(), mappings: [{ ...out, issuesTicketsAtConfirm: "yes" }], releaseEnabled: true, margin: fakeMargin() });
    expect(r.reasons).toEqual([]);
  });

  it("a catalogue_stale blocker reads as a stale catalogue and keeps the product inquiry (doc 29 Batch 1b)", async () => {
    const [fresh, stale] = wrap([
      { variantCode: "a", mapping: m({ mappingId: "m-a", variantCode: "a" }), blockers: [] },
      { variantCode: "b", mapping: m({ mappingId: "m-b", variantCode: "b" }), blockers: ["catalogue_stale"] },
    ]);
    expect([fresh.catalogueFresh, stale.catalogueFresh]).toEqual([true, false]);
    expect(stale.state).toBe("ready");
    const r = await assessReadiness({ product: product(), mappings: [mapping({ catalogueFresh: stale.catalogueFresh })], releaseEnabled: true, margin: fakeMargin() });
    expect(r).toMatchObject({ effective: "inquiry", reasons: ["catalogue_stale"] });
  });

  it("reads the mapping environment and pickup from the offer's direct-reporting flag", () => {
    const [direct, pickup, unknown] = wrap([
      { variantCode: "a", mapping: m({ mappingId: "m-a", variantCode: "a", isDirectReporting: true }), blockers: [] },
      { variantCode: "b", mapping: m({ mappingId: "m-b", variantCode: "b", isDirectReporting: false }), blockers: [] },
      { variantCode: "c", mapping: m({ mappingId: "m-c", variantCode: "c", isDirectReporting: "yes" }), blockers: [] },
    ]);
    expect([direct.pickupOffered, pickup.pickupOffered, unknown.pickupOffered]).toEqual([false, true, null]);
    expect(direct.environment).toBe("test");
  });

  it("keeps the supplier account the quote checks against (CR-B2-12)", () => {
    const [withAccount, without] = wrap([
      { variantCode: "a", mapping: m({ mappingId: "m-a", variantCode: "a", accountId: "synthetic-account" }), blockers: [] },
      { variantCode: "b", mapping: m({ mappingId: "m-b", variantCode: "b", accountId: null }), blockers: [] },
    ]);
    expect([withAccount.accountId, without.accountId]).toEqual(["synthetic-account", null]);
  });

  it("malformed facts read as unknown and keep the product inquiry", async () => {
    const [out] = wrap([
      { variantCode: "shared", mapping: m({ supplierUnits: "adult", netAedMinorByUnit: { adult: -1n, child: 1.5 }, supplierFreeCancellationHours: -2 }), blockers: [] },
    ]);
    expect(out).toMatchObject({ supplierUnits: [], netAedMinorByUnit: null, supplierFreeCancellationHours: null });
    const [partial] = wrap([{ variantCode: "shared", mapping: m({ supplierUnits: ["adult", "child"], netAedMinorByUnit: { adult: 10_000n, child: "x" } }), blockers: [] }]);
    expect(partial.netAedMinorByUnit).toEqual({ adult: 10_000n });
    const r = await assessReadiness({ product: product(), mappings: [partial], releaseEnabled: true, margin: fakeMargin() });
    expect(r.effective).toBe("inquiry");
    expect(r.reasons).toContain("margin_below_floor");
  });

  it("a whole-product mapping listed under two variants is reported once, as product-level", async () => {
    const out = wrap([
      { variantCode: "a", mapping: m({ variantCode: null }), blockers: [] },
      { variantCode: "b", mapping: m({ variantCode: null }), blockers: [] },
    ]);
    expect(out).toHaveLength(1);
    expect(out[0].variantId).toBeNull();
    const doc = instantDoc({ variants: [{ ...instantDoc().variants[0], id: "a" }, { ...instantDoc().variants[0], id: "b" }] });
    expect((await assessReadiness({ product: product({}, doc), mappings: out, releaseEnabled: true, margin: fakeMargin() })).reasons).toContain("variant_without_mapping");
  });
});

describe("doc 29 Batch 2: listed starts pass the time rule only with their flag on", () => {
  const listed = (over: Partial<MappingReadiness> = {}) => mapping({ anyTimeSlots: true, slotStartMinutes: [600, 780, 960], listedStartsSellable: true, ...over });
  const page = instantDoc({ timeSlots: ["10:00", "13:00", "16:00"] });

  it("an 'any time' offer sold as listed starts is instant when the page lists exactly those starts", async () => {
    expect(READINESS_RULES_VERSION).toBe(9);
    expect(await reasonsFor(product({}, page), [listed()])).toMatchObject({ effective: "instant", reasons: [] });
    expect(slotTimesAgree(["16:00", "10:00", "13:00"], listed())).toBe("ok");
  });

  it("without its flag (not sellable as listed starts) it stays slot_any_time_unsupported, as in Batch 0", async () => {
    for (const flag of [false, null, undefined]) {
      const r = await reasonsFor(product({}, page), [listed({ listedStartsSellable: flag })]);
      expect(r.effective).toBe("inquiry");
      expect(r.reasons).toContain("slot_any_time_unsupported");
    }
  });

  it("never an arbitrary time: page times must still equal the listed starts", async () => {
    expect(slotTimesAgree(["10:00", "13:00"], listed())).toBe("slot_times_mismatch");
    expect(slotTimesAgree(["10:00", "13:00", "16:00", "17:30"], listed())).toBe("slot_times_mismatch");
    expect(slotTimesAgree(["Any time"], listed())).toBe("slot_times_mismatch");
    expect(slotTimesAgree([], listed())).toBe("slot_times_mismatch");
    expect(slotTimesAgree(["10:00"], listed({ slotStartMinutes: null }))).toBe("slot_times_mismatch");
    expect((await reasonsFor(product({}, instantDoc({ timeSlots: ["10:00"] })), [listed()])).reasons).toContain("slot_times_mismatch");
  });

  it("an unknown any-time fact never passes, whatever the listed-start flag says", () => {
    expect(slotTimesAgree(["10:00"], { slotStartMinutes: [600], anyTimeSlots: null, listedStartsSellable: true })).toBe("slot_times_mismatch");
  });

  it("fromCatalogReadiness reads the catalogue's listedStartsSellable fact, and only an exact true counts", () => {
    const base = { mappingId: "m-1", variantCode: "shared", environment: "test", isActive: true, syncStatus: "ok", approvedOfferHash: "h", currentOfferHash: "h", issuesTicketsAtConfirm: "no", anyTimeSlots: true };
    const out = fromCatalogReadiness({
      productId: PRODUCT_ID,
      environment: "test",
      evaluatedAt: "x",
      variants: [
        { variantCode: "a", mapping: { ...base, mappingId: "m-a", variantCode: "a", listedStartsSellable: true }, blockers: [] },
        { variantCode: "b", mapping: { ...base, mappingId: "m-b", variantCode: "b", listedStartsSellable: "true" }, blockers: [] },
        { variantCode: "c", mapping: { ...base, mappingId: "m-c", variantCode: "c" }, blockers: [] },
      ],
    } as never);
    expect(out.map((o) => o.listedStartsSellable)).toEqual([true, false, false]);
  });
});
