import { describe, expect, it } from "vitest";
import { CLOSED_EXPOSURE_LIMITS, exposureLimitsSchema, instantOrderCapVerdict } from "../exposure-limits";
import { publicRefusal } from "@/app/api/checkout/handler";

/**
 * The per-order instant cap (doc 22 §32.24, owner: 500 AED per order) and the
 * exposure-limits row it lives in. Pure; synthetic amounts only.
 */

const OWNER_ROW = { maxUncapturedHolds: 3, maxRiskyPaymentsPer15Min: 5, outlyFundedWindowDays: 30, outlyFundedCapMinor: { INR: 0, AED: 0 }, maxInstantOrderAedMinor: 50_000 };

describe("payments.exposure_limits: maxInstantOrderAedMinor is required", () => {
  it("the owner's row parses, with the cap in AED fils", () => {
    expect(exposureLimitsSchema.parse(OWNER_ROW).maxInstantOrderAedMinor).toBe(50_000);
  });

  it.each<[string, unknown]>([
    ["no row at all", {}],
    ["a row without the cap", { maxUncapturedHolds: 3 }],
    ["a zero cap", { ...OWNER_ROW, maxInstantOrderAedMinor: 0 }],
    ["a negative cap", { ...OWNER_ROW, maxInstantOrderAedMinor: -1 }],
    ["a fractional cap", { ...OWNER_ROW, maxInstantOrderAedMinor: 500.5 }],
    ["a cap as a string", { ...OWNER_ROW, maxInstantOrderAedMinor: "50000" }],
  ])("%s does not parse (no silent default): checkout falls back to the closed limits", (_n, value) => {
    expect(exposureLimitsSchema.safeParse(value).success).toBe(false);
  });

  it("the closed limits refuse every order: the cap reads as not configured", () => {
    expect(instantOrderCapVerdict({ totalMinor: 1n, currency: "AED", capAedMinor: CLOSED_EXPOSURE_LIMITS.maxInstantOrderAedMinor, inrPerAed: null })).toEqual({
      ok: false,
      reason: "limit_not_configured",
      orderAedMinor: null,
    });
  });
});

describe("instantOrderCapVerdict", () => {
  const cap = 50_000;

  it("AED: at the cap passes, one fil over is refused", () => {
    expect(instantOrderCapVerdict({ totalMinor: 50_000n, currency: "AED", capAedMinor: cap, inrPerAed: null }).ok).toBe(true);
    expect(instantOrderCapVerdict({ totalMinor: 50_001n, currency: "AED", capAedMinor: cap, inrPerAed: null })).toMatchObject({ ok: false, reason: "order_over_limit" });
  });

  it("INR: converted at the FX rate, rounded up", () => {
    // ₹13,160 at 26.32 INR/AED is exactly AED 500.
    expect(instantOrderCapVerdict({ totalMinor: 1_316_000n, currency: "INR", capAedMinor: cap, inrPerAed: "26.32" })).toEqual({ ok: true, orderAedMinor: 50_000n });
    // One paisa more is 50_000.04 fils: rounded down it would sit on the cap; rounded up it is over.
    expect(instantOrderCapVerdict({ totalMinor: 1_316_001n, currency: "INR", capAedMinor: cap, inrPerAed: "26.32" })).toEqual({ ok: false, reason: "order_over_limit", orderAedMinor: 50_001n });
    // One paisa under is 49_999.96 fils, rounded up to the cap: passes.
    expect(instantOrderCapVerdict({ totalMinor: 1_315_999n, currency: "INR", capAedMinor: cap, inrPerAed: "26.32" })).toEqual({ ok: true, orderAedMinor: 50_000n });
    // One decimal place reads as two: 26.3 = 26.30, so ₹13,160 is 50_038.02 fils, rounded up.
    expect(instantOrderCapVerdict({ totalMinor: 1_316_000n, currency: "INR", capAedMinor: cap, inrPerAed: "26.3" })).toEqual({ ok: false, reason: "order_over_limit", orderAedMinor: 50_039n });
  });

  it.each([null, "", "0", "0.00", "-1.00", "26.321", "abc", "1e3"])("INR with no usable rate (%s) is fx_input_missing", (fx) => {
    expect(instantOrderCapVerdict({ totalMinor: 100n, currency: "INR", capAedMinor: cap, inrPerAed: fx })).toEqual({ ok: false, reason: "fx_input_missing", orderAedMinor: null });
  });

  it("AED never needs a rate", () => {
    expect(instantOrderCapVerdict({ totalMinor: 100n, currency: "AED", capAedMinor: cap, inrPerAed: "garbage" }).ok).toBe(true);
  });

  it.each([0, -5, 1.5, Number.NaN, Number.MAX_VALUE])("a cap of %s is limit_not_configured", (c) => {
    expect(instantOrderCapVerdict({ totalMinor: 1n, currency: "AED", capAedMinor: c, inrPerAed: null })).toMatchObject({ ok: false, reason: "limit_not_configured" });
  });

  it("checkout's refusals for the cap all fold into requires_inquiry for the browser", () => {
    for (const reason of ["order_over_limit", "fx_input_missing", "exposure_cap"]) expect(publicRefusal(reason)).toBe("requires_inquiry");
  });
});
