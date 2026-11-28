import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Effective eligibility read (PRD-11 stub). Pure: the database module is
 * replaced, so nothing here opens a connection.
 */

const state = vi.hoisted(() => ({
  row: null as { effectiveMode: string; readinessVersion?: number } | null,
  fail: false,
  queries: [] as unknown[],
}));

vi.mock("@/server/lib/db", () => ({
  prisma: {
    productEligibility: {
      findUnique: vi.fn(async (args: unknown) => {
        state.queries.push(args);
        if (state.fail) throw new Error("connection refused");
        return state.row;
      }),
    },
  },
}));
vi.mock("@/server/lib/logger", () => ({ log: { warn: vi.fn(), error: vi.fn(), info: vi.fn(), debug: vi.fn() } }));

const { effectiveModeFor, effectiveModeFrom, renderedModeFor, storefrontGate } = await import("../catalog/eligibility");
const { gateSnapshot } = await import("../catalog/server");
const { READINESS_RULES_VERSION } = await import("@/server/services/readiness.service");
const { resetEnvCache } = await import("@/server/lib/env");

beforeEach(() => {
  vi.stubEnv("INSTANT_RELEASE_ENABLED", "true");
  resetEnvCache();
  state.row = null;
  state.fail = false;
  state.queries = [];
});

afterEach(() => {
  vi.unstubAllEnvs();
  resetEnvCache();
});

const V = READINESS_RULES_VERSION;
const ON = { releaseEnabled: true, rulesVersion: V };

describe("effectiveModeFor", () => {
  it("a product with no eligibility row is inquiry", async () => {
    expect(await effectiveModeFor("product-1")).toBe("inquiry");
    expect(state.queries).toEqual([{ where: { productId: "product-1" }, select: { effectiveMode: true, readinessVersion: true } }]);
  });

  it("an evaluated row under the current rules decides", async () => {
    state.row = { effectiveMode: "instant", readinessVersion: V };
    expect(await effectiveModeFor("product-1")).toBe("instant");
    state.row = { effectiveMode: "inquiry", readinessVersion: V };
    expect(await effectiveModeFor("product-1")).toBe("inquiry");
  });

  it("the release switch is read live: off is inquiry at once, without a re-evaluation (CR-B2-8)", async () => {
    state.row = { effectiveMode: "instant", readinessVersion: V };
    vi.stubEnv("INSTANT_RELEASE_ENABLED", "false");
    resetEnvCache();
    expect(storefrontGate().releaseEnabled).toBe(false);
    expect(await effectiveModeFor("product-1")).toBe("inquiry");
  });

  it("a failed read is inquiry", async () => {
    state.fail = true;
    expect(await effectiveModeFor("product-1")).toBe("inquiry");
  });
});

describe("effectiveModeFrom", () => {
  it("only an explicit instant under the current rules and the switch on is instant", () => {
    expect(effectiveModeFrom(null, ON)).toBe("inquiry");
    expect(effectiveModeFrom(undefined, ON)).toBe("inquiry");
    expect(effectiveModeFrom({ effectiveMode: "inquiry", readinessVersion: V }, ON)).toBe("inquiry");
    expect(effectiveModeFrom({ effectiveMode: "INSTANT", readinessVersion: V }, ON)).toBe("inquiry");
    expect(effectiveModeFrom({ effectiveMode: "instant", readinessVersion: V }, ON)).toBe("instant");
    expect(effectiveModeFrom({ effectiveMode: "instant", readinessVersion: V - 1 }, ON)).toBe("inquiry");
    expect(effectiveModeFrom({ effectiveMode: "instant" }, ON)).toBe("inquiry");
    expect(effectiveModeFrom({ effectiveMode: "instant", readinessVersion: V }, { ...ON, releaseEnabled: false })).toBe("inquiry");
  });

  it("a cached catalogue snapshot is turned to inquiry when the switch is off", () => {
    const snap = { activities: [{ slug: "a", fulfilmentMode: "instant" }, { slug: "b", fulfilmentMode: "inquiry" }], categories: [], generatedAt: "", source: "db" } as never;
    expect(gateSnapshot(snap, true)).toBe(snap);
    expect(gateSnapshot(snap, false).activities.map((a) => a.fulfilmentMode)).toEqual(["inquiry", "inquiry"]);
  });
});

describe("renderedModeFor (N6)", () => {
  it("a cached instant product renders inquiry once the live row says so", async () => {
    state.row = { effectiveMode: "inquiry", readinessVersion: V };
    expect(await renderedModeFor({ fulfilmentMode: "instant", productId: "product-1" })).toBe("inquiry");
    state.row = { effectiveMode: "instant", readinessVersion: V };
    expect(await renderedModeFor({ fulfilmentMode: "instant", productId: "product-1" })).toBe("instant");
  });

  it("a cached inquiry product or one without a database row never reads and never renders instant", async () => {
    state.row = { effectiveMode: "instant", readinessVersion: V };
    expect(await renderedModeFor({ fulfilmentMode: "inquiry", productId: "product-1" })).toBe("inquiry");
    expect(await renderedModeFor({ fulfilmentMode: "instant" })).toBe("inquiry");
    expect(state.queries).toEqual([]);
  });

  it("a failed live read renders inquiry", async () => {
    state.fail = true;
    expect(await renderedModeFor({ fulfilmentMode: "instant", productId: "product-1" })).toBe("inquiry");
  });
});
