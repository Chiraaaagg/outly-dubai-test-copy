import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resetEnvCache } from "../../lib/env";
import { activities } from "@/lib/data/activities";
import { combos } from "@/lib/data/combos";
import { toCartItem } from "@/lib/pricing";
import type { CartItem } from "@/lib/types";
import { isAppError } from "../../lib/errors";

/**
 * Inquiry pricing and the public modes read (PRD-5, PRD-13, PRD-25, PRD-26).
 * Pure: Prisma is replaced, so nothing here opens a connection. Inquiry
 * arithmetic is unchanged and pinned in src/lib/__tests__/pricing-preservation.test.ts.
 */

const state = vi.hoisted(() => ({
  products: [] as Array<Record<string, unknown>>,
  combos: [] as Array<Record<string, unknown>>,
  modesQuery: null as unknown,
}));

vi.mock("../../lib/db", () => ({
  prisma: {
    product: {
      findMany: vi.fn(async (args: { where: Record<string, unknown> }) => {
        if ("status" in args.where && !("slug" in args.where)) state.modesQuery = args;
        return state.products;
      }),
    },
    combo: { findMany: vi.fn(async () => state.combos) },
  },
}));

const { catalogService } = await import("../catalog.service");
const { READINESS_RULES_VERSION } = await import("../readiness.service");

const A = activities[0];
const C = combos[0];
const row = (over: Record<string, unknown> = {}) => ({ id: "p-1", slug: A.slug, fulfilmentMode: "inquiry", tier: A.tier, content: A, ...over });

function honest(): CartItem {
  return toCartItem(A, { date: "2026-12-01", time: A.timeSlots[0] ?? "Flexible", pax: { adult: 2, child: 0, infant: 0, senior: 0 }, variantId: A.variants[0]?.id });
}

beforeEach(() => {
  state.products = [row()];
  state.combos = [];
  state.modesQuery = null;
});

describe("priceCartItems: snapshots come from the server record (PRD-5)", () => {
  it("an honest cart: server facts, no mismatch", async () => {
    const [p] = await catalogService.priceCartItems([honest()]);
    expect(p.snapshot).toEqual({
      title: A.title,
      image: A.images[0],
      variantName: A.variants[0]?.name ?? null,
      confirmation: A.confirmation,
      freeCancellationHours: A.freeCancellationHours,
      durationMinutes: A.durationMinutes,
    });
    expect(p.snapshotMismatch).toEqual([]);
  });

  it("a tampered cart: every displayed fact is the server's and the difference is a signal", async () => {
    const forged: CartItem = { ...honest(), title: "FREE trip", image: "https://evil.example/x.png", variantName: "VIP", confirmation: "instant", freeCancellationHours: 720, durationMinutes: 1 };
    const [p] = await catalogService.priceCartItems([forged]);
    expect(p.snapshot.title).toBe(A.title);
    expect(p.snapshot.freeCancellationHours).toBe(A.freeCancellationHours);
    expect(p.cancellationPolicy).toEqual({ text: A.cancellationPolicy, freeCancellationHours: A.freeCancellationHours });
    expect(p.snapshotMismatch).toEqual(expect.arrayContaining(["title", "image", "variantName", "freeCancellationHours", "durationMinutes"]));
  });

  it("an unknown variant snapshots no variant name; inquiry pricing is unchanged (base price, PRD-7 owner question open)", async () => {
    const [p] = await catalogService.priceCartItems([{ ...honest(), variantId: "no-such-variant", variantName: "Ghost" }]);
    expect(p.snapshot.variantName).toBeNull();
    expect(p.snapshotMismatch).toContain("variantName");
    // Pinned: an unknown variant prices at the base adult price with no delta (the paid quote refuses it instead).
    expect(p.total).toEqual({ inr: A.price.adult.inr * 2, aed: A.price.adult.aed * 2 });
  });

  it("combo snapshots and cancellation hours come from the combo record, mode is inquiry (PRD-21)", async () => {
    state.combos = [{ id: "c-1", slug: C.slug, fulfilmentMode: "instant", tier: C.tier }];
    const item: CartItem = { ...honest(), kind: "combo", slug: C.slug, title: C.name, image: C.heroImage, variantId: undefined, variantName: undefined, freeCancellationHours: 48, durationMinutes: 0, confirmation: C.confirmation };
    const [p] = await catalogService.priceCartItems([item]);
    expect(p.fulfilmentMode).toBe("inquiry");
    expect(p.snapshot.freeCancellationHours).toBe(C.freeCancellationHours);
    expect(p.cancellationPolicy).toEqual({ text: C.cancellationPolicy, freeCancellationHours: C.freeCancellationHours });
  });
});

describe("priceCartItems: retired lines (PRD-26)", () => {
  it("names every unavailable line in one 422 instead of failing on the first", async () => {
    state.products = [row()];
    const gone1: CartItem = { ...honest(), slug: "retired-one" };
    const gone2: CartItem = { ...honest(), kind: "combo", slug: "retired-combo" };
    const err = await catalogService.priceCartItems([honest(), gone1, gone2]).catch((e: unknown) => e);
    expect(isAppError(err)).toBe(true);
    if (!isAppError(err)) return;
    expect(err.status).toBe(422);
    expect(err.details).toMatchObject({
      fields: { "items.1": "retired-one is no longer available", "items.2": "retired-combo is no longer available" },
      unavailable: [
        { index: 1, slug: "retired-one", kind: "activity" },
        { index: 2, slug: "retired-combo", kind: "combo" },
      ],
    });
  });
});

describe("priceCartItems: fixture fallback is inquiry-only and logged (PRD-13)", () => {
  it("invalid stored content prices from the fixture for an inquiry, never silently", async () => {
    state.products = [row({ content: { broken: true } })];
    const [p] = await catalogService.priceCartItems([honest()]);
    expect(p.snapshot.title).toBe(A.title);
  });
});

describe("fulfilmentModes: published only, effective mode (PRD-25, PRD-11)", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    resetEnvCache();
  });
  const products = () => [
    { slug: "live-instant", eligibility: { effectiveMode: "instant", readinessVersion: READINESS_RULES_VERSION } },
    { slug: "old-rules-instant", eligibility: { effectiveMode: "instant", readinessVersion: READINESS_RULES_VERSION - 1 } },
    { slug: "asked-instant-not-ready", eligibility: { effectiveMode: "inquiry", readinessVersion: READINESS_RULES_VERSION } },
    { slug: "never-evaluated", eligibility: null },
  ];

  it("asks for published, undeleted products and reports the eligibility verdict, not the column", async () => {
    vi.stubEnv("INSTANT_RELEASE_ENABLED", "true");
    resetEnvCache();
    state.products = products();
    state.combos = [{ slug: "a-combo" }];
    const modes = await catalogService.fulfilmentModes();
    expect(state.modesQuery).toMatchObject({ where: { deletedAt: null, status: "published" } });
    expect(modes).toEqual({ "live-instant": "instant", "old-rules-instant": "inquiry", "asked-instant-not-ready": "inquiry", "never-evaluated": "inquiry", "a-combo": "inquiry" });
  });

  it("the release switch off is inquiry at once, whatever the stored verdict (CR-B2-8)", async () => {
    vi.stubEnv("INSTANT_RELEASE_ENABLED", "false");
    resetEnvCache();
    state.products = products();
    state.combos = [];
    expect(Object.values(await catalogService.fulfilmentModes()).every((m) => m === "inquiry")).toBe(true);
  });
});
