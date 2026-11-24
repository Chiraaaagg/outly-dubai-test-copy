import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createMarginService,
  FX_INR_PER_AED_SETTING_KEY,
  MARGIN_COST_INPUTS_SETTING_KEY,
  toContractMarginService,
} from "../margin.service";
import { MARGIN_POLICY_SETTING_KEY, type MarginPolicy } from "../../quotes/contracts";
import { log } from "../../lib/logger";

/**
 * Margin service (PAY-10, PAY-11). Pure: settings are an in-memory map handed
 * to the factory and the clock is fixed. Every rate, fee and amount here is
 * synthetic.
 */

vi.mock("../../repositories/settings.repo", () => ({ settingsRepo: { get: vi.fn(async () => { throw new Error("tests pass their own settings"); }) } }));

const NOW = new Date("2030-01-10T12:00:00.000Z");
const POLICY: MarginPolicy = { version: 1, floorBps: 1500, effectiveFrom: "2030-01-01T00:00:00.000Z" };
const FX = { version: 3, inrPerAed: "25.00", source: "synthetic test input", recordedAt: "2030-01-09T00:00:00.000Z", expiresAt: "2030-01-11T00:00:00.000Z" };
/** An explicit "no variable costs" row: the owner confirmed it, so it is not a default. */
const NO_COSTS = { version: 4, source: "synthetic owner confirmation", recordedAt: "2030-01-09T00:00:00.000Z", lines: [] };

/** Settings as given, plus the explicit no-costs row unless the test sets or removes that key. */
function service(settings: Record<string, unknown>, now = NOW) {
  const all: Record<string, unknown> = { [MARGIN_COST_INPUTS_SETTING_KEY]: NO_COSTS, ...settings };
  return createMarginService({ readSetting: async (key) => (key in all && all[key] !== undefined ? all[key] : null), now: () => now });
}

async function refusedWith(p: Promise<unknown>, code: string) {
  await expect(p).rejects.toMatchObject({ code });
}

describe("marginService.currentPolicy", () => {
  it("returns the versioned policy from settings", async () => {
    await expect(service({ [MARGIN_POLICY_SETTING_KEY]: POLICY }).currentPolicy()).resolves.toEqual(POLICY);
  });

  it("refuses when the row is missing, malformed or not yet effective; there is no code fallback", async () => {
    await refusedWith(service({}).currentPolicy(), "NOT_CONFIGURED");
    for (const bad of [{ ...POLICY, floorBps: 10_001 }, { ...POLICY, version: 0 }, { ...POLICY, floorBps: 15.5 }, { floorBps: 1500 }, "1500", { ...POLICY, effectiveFrom: "soon" }]) {
      await refusedWith(service({ [MARGIN_POLICY_SETTING_KEY]: bad }).currentPolicy(), "NOT_CONFIGURED");
    }
    await refusedWith(service({ [MARGIN_POLICY_SETTING_KEY]: { ...POLICY, effectiveFrom: "2030-02-01T00:00:00.000Z" } }).currentPolicy(), "NOT_CONFIGURED");
  });
});

describe("marginService.evaluate — AED lines", () => {
  const svc = service({});

  it("passes at the floor and refuses one minor unit below it", async () => {
    await expect(svc.evaluate({ chargedMinor: 10_000n, currency: "AED", supplierNetAedMinor: 8_500n, policy: POLICY })).resolves.toEqual({
      ok: true,
      snapshot: { policyVersion: 1, floorBps: 1500, grossMarginBps: 1500, costLines: [], fx: null, costInputs: { version: 4, source: NO_COSTS.source } },
    });
    await expect(svc.evaluate({ chargedMinor: 10_000n, currency: "AED", supplierNetAedMinor: 8_501n, policy: POLICY })).resolves.toEqual({
      ok: false,
      reason: "margin_below_floor",
    });
  });

  it("a zero charge never passes", async () => {
    await expect(svc.evaluate({ chargedMinor: 0n, currency: "AED", supplierNetAedMinor: 0n, policy: POLICY })).resolves.toMatchObject({ ok: false, reason: "margin_below_floor" });
  });

  it("refuses a malformed policy object handed in by the caller", async () => {
    await refusedWith(svc.evaluate({ chargedMinor: 10_000n, currency: "AED", supplierNetAedMinor: 0n, policy: { ...POLICY, floorBps: -1 } }), "NOT_CONFIGURED");
  });

  it("a later policy version does not change a snapshot already taken", async () => {
    const first = await svc.evaluate({ chargedMinor: 10_000n, currency: "AED", supplierNetAedMinor: 8_000n, policy: POLICY });
    const frozen = JSON.stringify(first, (_k, v) => (typeof v === "bigint" ? v.toString() : v));
    const second = await svc.evaluate({ chargedMinor: 10_000n, currency: "AED", supplierNetAedMinor: 8_000n, policy: { version: 2, floorBps: 2500, effectiveFrom: "2030-01-05T00:00:00.000Z" } });
    expect(second).toEqual({ ok: false, reason: "margin_below_floor" });
    expect(JSON.stringify(first, (_k, v) => (typeof v === "bigint" ? v.toString() : v))).toBe(frozen);
    expect(first).toMatchObject({ ok: true, snapshot: { policyVersion: 1, floorBps: 1500, grossMarginBps: 2000 } });
  });
});

describe("marginService.evaluate — INR lines and the FX input", () => {
  const line = (chargedMinor: bigint) => ({ chargedMinor, currency: "INR" as const, supplierNetAedMinor: 10_000n, policy: POLICY });

  it("converts the AED net at the recorded rate, rounding the cost up, and keeps the penny boundary", async () => {
    // AED 100.00 at 25.00 → ₹2,500.00 cost. Floor 15%: ₹2,941.18 passes, ₹2,941.17 does not.
    const svc = service({ [FX_INR_PER_AED_SETTING_KEY]: FX });
    await expect(svc.evaluate(line(294_118n))).resolves.toMatchObject({
      ok: true,
      snapshot: { policyVersion: 1, grossMarginBps: 1500, fx: { version: FX.version, inrPerAed: "25.00", source: FX.source } },
    });
    await expect(svc.evaluate(line(294_117n))).resolves.toEqual({ ok: false, reason: "margin_below_floor" });
    // One AED minor unit at 25.01 is 25.01 INR minor units, counted as 26: 31 − 26 = 5 → 1612 bps.
    const odd = service({ [FX_INR_PER_AED_SETTING_KEY]: { ...FX, inrPerAed: "25.01" } });
    const tiny = await odd.evaluate({ chargedMinor: 31n, currency: "INR", supplierNetAedMinor: 1n, policy: { ...POLICY, floorBps: 1600 } });
    expect(tiny).toMatchObject({ ok: true, snapshot: { grossMarginBps: 1612 } });
  });

  it("missing, malformed, expired or not-yet-recorded FX input refuses the line; no rate is invented", async () => {
    const cases: unknown[] = [
      undefined,
      { ...FX, inrPerAed: "25.001" },
      { ...FX, inrPerAed: 25 },
      { ...FX, source: "" },
      { ...FX, expiresAt: "2030-01-10T12:00:00.000Z" },
      { ...FX, recordedAt: "2030-01-10T12:00:01.000Z", expiresAt: "2030-01-12T00:00:00.000Z" },
      { ...FX, expiresAt: FX.recordedAt },
    ];
    for (const fx of cases) {
      const svc = service(fx === undefined ? {} : { [FX_INR_PER_AED_SETTING_KEY]: fx });
      await expect(svc.evaluate(line(1_000_000n)), JSON.stringify(fx)).resolves.toEqual({ ok: false, reason: "fx_input_missing" });
    }
  });

  it("an AED line never needs the FX input", async () => {
    await expect(service({}).evaluate({ chargedMinor: 10_000n, currency: "AED", supplierNetAedMinor: 1n, policy: POLICY })).resolves.toMatchObject({ ok: true });
  });
});

describe("marginService.evaluate — named cost inputs", () => {
  const COSTS = {
    version: 1,
    source: "synthetic test input",
    recordedAt: "2030-01-09T00:00:00.000Z",
    lines: [
      { name: "gateway_fee", kind: "percent_of_charge", bps: 200 },
      { name: "fixed_handling", kind: "fixed_aed", aedMinor: "100" },
    ],
  };

  const AED_LINE = { chargedMinor: 10_000n, currency: "AED" as const, supplierNetAedMinor: 5_000n, policy: POLICY };

  it("absent ⇒ the line is refused; a missing row is never zero fees", async () => {
    await expect(service({ [MARGIN_COST_INPUTS_SETTING_KEY]: undefined }).evaluate(AED_LINE)).resolves.toEqual({ ok: false, reason: "cost_inputs_missing" });
    const inr = service({ [MARGIN_COST_INPUTS_SETTING_KEY]: undefined, [FX_INR_PER_AED_SETTING_KEY]: FX });
    await expect(inr.evaluate({ ...AED_LINE, currency: "INR", chargedMinor: 1_000_000n })).resolves.toEqual({ ok: false, reason: "cost_inputs_missing" });
  });

  it("an explicit, recorded empty row means no variable costs and is recorded on the snapshot", async () => {
    const r = await service({}).evaluate(AED_LINE);
    expect(r).toMatchObject({ ok: true, snapshot: { costLines: [], costInputs: { version: 4, source: NO_COSTS.source } } });
  });

  it("uses only the configured lines, by name, in the charged currency (costs rounded up)", async () => {
    const aed = await service({ [MARGIN_COST_INPUTS_SETTING_KEY]: COSTS }).evaluate({ chargedMinor: 10_001n, currency: "AED", supplierNetAedMinor: 5_000n, policy: POLICY });
    expect(aed).toEqual({
      ok: true,
      snapshot: {
        policyVersion: 1,
        floorBps: 1500,
        grossMarginBps: 4699,
        costLines: [{ name: "gateway_fee", minor: 201n }, { name: "fixed_handling", minor: 100n }],
        fx: null,
        costInputs: { version: 1, source: COSTS.source },
      },
    });
    const inr = await service({ [MARGIN_COST_INPUTS_SETTING_KEY]: COSTS, [FX_INR_PER_AED_SETTING_KEY]: FX }).evaluate({ chargedMinor: 500_000n, currency: "INR", supplierNetAedMinor: 10_000n, policy: POLICY });
    expect(inr).toMatchObject({ ok: true, snapshot: { costLines: [{ name: "gateway_fee", minor: 10_000n }, { name: "fixed_handling", minor: 2_500n }] } });
  });

  it("costs can push a line below the floor", async () => {
    const r = await service({ [MARGIN_COST_INPUTS_SETTING_KEY]: COSTS }).evaluate({ chargedMinor: 10_000n, currency: "AED", supplierNetAedMinor: 8_300n, policy: POLICY });
    expect(r).toEqual({ ok: false, reason: "margin_below_floor" });
  });

  it("a malformed, unsourced or not-yet-recorded cost row refuses the line instead of being ignored", async () => {
    const cases: unknown[] = [
      { ...COSTS, lines: [{ name: "fee", kind: "percent_of_charge", bps: 20_000 }] },
      { ...COSTS, lines: [{ name: "x", kind: "guess" }] },
      { lines: [] },
      { version: 1, source: "synthetic", lines: [] },
      { ...NO_COSTS, source: "" },
      { ...NO_COSTS, recordedAt: "soon" },
      { ...NO_COSTS, recordedAt: "2030-01-10T12:00:01.000Z" },
      { ...NO_COSTS, version: 0 },
      [],
      "none",
    ];
    for (const bad of cases) {
      await expect(service({ [MARGIN_COST_INPUTS_SETTING_KEY]: bad }).evaluate({ chargedMinor: 10_000n, currency: "AED", supplierNetAedMinor: 0n, policy: POLICY }), JSON.stringify(bad)).resolves.toEqual({
        ok: false,
        reason: "cost_inputs_missing",
      });
    }
  });

  it("the contract-facing service reports missing cost inputs as margin_below_floor until the contract lists the reason", async () => {
    const narrowed = toContractMarginService(service({ [MARGIN_COST_INPUTS_SETTING_KEY]: undefined }));
    await expect(narrowed.evaluate(AED_LINE)).resolves.toEqual({ ok: false, reason: "margin_below_floor" });
    await expect(toContractMarginService(service({})).evaluate({ ...AED_LINE, currency: "INR" })).resolves.toEqual({ ok: false, reason: "fx_input_missing" });
    await expect(toContractMarginService(service({})).evaluate(AED_LINE)).resolves.toMatchObject({ ok: true, snapshot: { costInputs: { version: 4 } } });
  });
});

describe("marginService settings warnings", () => {
  afterEach(() => vi.restoreAllMocks());

  const AED_LINE = { chargedMinor: 10_000n, currency: "AED" as const, supplierNetAedMinor: 5_000n, policy: POLICY };
  const INR_LINE = { ...AED_LINE, currency: "INR" as const, chargedMinor: 1_000_000n };

  /** A service over a settings map the test can change between calls. */
  function liveService(settings: Record<string, unknown>) {
    return createMarginService({ readSetting: async (key) => (settings[key] === undefined ? null : settings[key]), now: () => NOW });
  }

  it("warns once per state, not on every evaluate, and again when the state changes", async () => {
    const warn = vi.spyOn(log, "warn").mockImplementation(() => {});
    const settings: Record<string, unknown> = {};
    const svc = liveService(settings);

    for (let i = 0; i < 5; i++) await expect(svc.evaluate(AED_LINE)).resolves.toEqual({ ok: false, reason: "cost_inputs_missing" });
    expect(warn.mock.calls).toEqual([["margin.cost_inputs_missing", { key: MARGIN_COST_INPUTS_SETTING_KEY, version: "absent" }]]);

    settings[MARGIN_COST_INPUTS_SETTING_KEY] = { ...NO_COSTS, version: 5, source: "" };
    await svc.evaluate(AED_LINE);
    await svc.evaluate(AED_LINE);
    settings[MARGIN_COST_INPUTS_SETTING_KEY] = { ...NO_COSTS, version: 6, source: "" };
    await svc.evaluate(AED_LINE);
    await svc.evaluate(AED_LINE);
    expect(warn.mock.calls.slice(1)).toEqual([
      ["margin.cost_inputs_invalid", { key: MARGIN_COST_INPUTS_SETTING_KEY, version: "5" }],
      ["margin.cost_inputs_invalid", { key: MARGIN_COST_INPUTS_SETTING_KEY, version: "6" }],
    ]);

    // A usable row clears the state, so the same fault later warns again.
    settings[MARGIN_COST_INPUTS_SETTING_KEY] = NO_COSTS;
    await expect(svc.evaluate(AED_LINE)).resolves.toMatchObject({ ok: true });
    delete settings[MARGIN_COST_INPUTS_SETTING_KEY];
    await svc.evaluate(AED_LINE);
    await svc.evaluate(AED_LINE);
    expect(warn).toHaveBeenCalledTimes(4);
    expect(warn.mock.calls[3]).toEqual(["margin.cost_inputs_missing", { key: MARGIN_COST_INPUTS_SETTING_KEY, version: "absent" }]);
  });

  it("a malformed FX row warns once until it changes", async () => {
    const warn = vi.spyOn(log, "warn").mockImplementation(() => {});
    const settings: Record<string, unknown> = { [MARGIN_COST_INPUTS_SETTING_KEY]: NO_COSTS, [FX_INR_PER_AED_SETTING_KEY]: { ...FX, inrPerAed: "about 25" } };
    const svc = liveService(settings);

    for (let i = 0; i < 5; i++) await expect(svc.evaluate(INR_LINE)).resolves.toEqual({ ok: false, reason: "fx_input_missing" });
    settings[FX_INR_PER_AED_SETTING_KEY] = "25";
    await svc.evaluate(INR_LINE);
    await svc.evaluate(INR_LINE);
    expect(warn.mock.calls).toEqual([
      ["margin.fx_input_invalid", { key: FX_INR_PER_AED_SETTING_KEY, version: "3" }],
      ["margin.fx_input_invalid", { key: FX_INR_PER_AED_SETTING_KEY, version: "unversioned" }],
    ]);
  });
});

describe("marginService.allocate", () => {
  it("splits discount and tax exactly and preserves both sums", () => {
    const out = service({}).allocate([3_333n, 3_333n, 3_334n], 1_000n, 101n);
    expect(out.reduce((s, a) => s + a.discountAllocMinor, 0n)).toBe(1_000n);
    expect(out.reduce((s, a) => s + a.taxAllocMinor, 0n)).toBe(101n);
    expect(out).toHaveLength(3);
  });
});
