import { ticketValidityCopy } from "@/lib/utils";
import { describe, expect, it } from "vitest";
import {
  canonicalJson,
  canonicalRequest,
  checkUnits,
  createQuoteService,
  couponVersionOf,
  customerFreeCancellationUntil,
  MIN_PAYMENT_WINDOW_MS,
  quoteFingerprint,
  slotStartMinutes,
  storedLineJson,
  toPublicQuote,
  type QuoteDeps,
  type QuoteStore,
  type StoredQuote,
} from "../quote.service";
import { assessReadiness, READINESS_RULES_VERSION, type MappingReadiness, type ReadinessProduct } from "../readiness.service";
import { isAppError } from "../../lib/errors";
import { MAX_INSTANT_ITEMS_PER_ORDER, MULTI_INSTANT_ITEM_POLICY, QUOTE_TTL_MS, SAME_DAY_INSTANT_POLICY, type QuoteLineRequest, type QuoteRequest, type QuoteSnapshot, type SupplierQuoteResult } from "../../quotes/contracts";
import { ADULT, CHILD, fakeMargin, instantDoc, MAPPING_ID, mapping, POLICY, product, PRODUCT_ID } from "./_b2-fakes";
import type { ReadinessTrigger } from "../readiness.service";
import type { Activity } from "@/lib/types";
import { coupons } from "@/lib/pricing";
import { freeCancellationCopy } from "@/lib/utils";
import { instantOrderCapVerdict } from "../../payments/exposure-limits";

/**
 * Server quotes (doc 22 §22.1 item 4; PRD-1, PRD-5, PRD-13, PRD-18). Fakes for
 * readiness inputs, the supplier check, margin and the quote store; the real
 * readiness rules run (`assessReadiness`). Synthetic prices and nets only.
 */

const NOW = new Date("2026-11-01T08:00:00Z"); // 12:00 in Dubai
const TOMORROW = "2026-11-02";
const GUEST: QuoteSnapshot["owner"] = { kind: "guest", guestSessionId: "0190a000-0000-7000-8000-0000000000e1" };
const CUSTOMER: QuoteSnapshot["owner"] = { kind: "customer", customerId: "0190a000-0000-7000-8000-0000000000c2" };
const OTHER_ID = "0190a000-0000-7000-8000-000000000009";

const okSupplier = (over: Partial<Extract<SupplierQuoteResult, { ok: true }>> = {}): SupplierQuoteResult => ({
  ok: true,
  slotRef: "slot-0900",
  netAedMinor: 30_000n,
  netUsdMinor: null,
  checkedAt: NOW.toISOString(),
  capacity: "limited",
  seatsLeft: 8,
  cutoffUtc: "2026-11-02T03:00:00Z",
  issuesTicketsAtConfirm: "yes",
  supplierFreeCancellationUntilUtc: null,
  ticketValidUntil: null,
  ...over,
});

function line(over: Partial<QuoteLineRequest> = {}): QuoteLineRequest {
  return { productId: PRODUCT_ID, variantId: "shared", serviceDate: TOMORROW, slotRef: "slot-0900", units: { adult: 2, child: 1 }, addonIds: [], pickup: null, ...over };
}
function request(over: Partial<QuoteRequest> = {}): QuoteRequest {
  return { lines: [line()], currency: "AED", couponCode: null, ...over };
}

/** What JSONB hands back: object keys reordered (shorter first, then bytewise), numbers re-parsed. */
function jsonbRoundTrip(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(jsonbRoundTrip);
  if (v && typeof v === "object") {
    const keys = Object.keys(v).sort((a, b) => a.length - b.length || (a < b ? -1 : a > b ? 1 : 0));
    return Object.fromEntries(keys.map((k) => [k, jsonbRoundTrip((v as Record<string, unknown>)[k])]));
  }
  return v;
}

function memoryStore() {
  const rows: Array<StoredQuote & { snapshot: QuoteSnapshot }> = [];
  let raceOnce = false;
  const store: QuoteStore & { rows: typeof rows; race(): void } = {
    rows,
    race: () => void (raceOnce = true),
    async findActiveByFingerprint(fp) {
      return rows.filter((r) => r.fingerprint === fp && r.status === "active");
    },
    async replace({ expire, supersede, quote, request: req }) {
      if (raceOnce) {
        raceOnce = false;
        return false;
      }
      for (const r of rows) {
        if (expire.includes(r.id) && r.status === "active") r.status = "expired";
        if (supersede.includes(r.id) && r.status === "active") r.status = "superseded";
      }
      rows.push({ id: quote.quoteId, fingerprint: quote.fingerprint, owner: quote.owner, request: jsonbRoundTrip(req), status: "active", expiresAt: new Date(quote.expiresAt), snapshot: quote });
      return true;
    },
  };
  return store;
}

interface World {
  products: Map<string, ReadinessProduct>;
  mappings: Map<string, MappingReadiness[]>;
  supplier: (input: unknown) => SupplierQuoteResult | Promise<SupplierQuoteResult>;
  supplierCalls: unknown[];
  reevaluated: Array<[string, ReadinessTrigger]>;
  release: boolean;
  dbDown: boolean;
  margin: ReturnType<typeof fakeMargin>;
  store: ReturnType<typeof memoryStore>;
  now: Date;
  firstBooking: boolean;
  wired: boolean;
  /** `payments.exposure_limits.maxInstantOrderAedMinor` (0: not set) and the current FX rate (null: none usable). */
  cap: number;
  fx: string | null;
  capReads: number;
  capDown: boolean;
}

function world(over: Partial<World> = {}): World & { svc: ReturnType<typeof createQuoteService> } {
  const w: World = {
    products: new Map([[PRODUCT_ID, product()]]),
    mappings: new Map([[PRODUCT_ID, [mapping()]]]),
    supplier: () => okSupplier(),
    supplierCalls: [],
    reevaluated: [],
    release: true,
    dbDown: false,
    margin: fakeMargin(),
    store: memoryStore(),
    now: NOW,
    firstBooking: true,
    wired: true,
    cap: 1_000_000_000,
    fx: "25.00",
    capReads: 0,
    capDown: false,
    ...over,
  };
  const deps: QuoteDeps = {
    readiness: {
      async assess(productId) {
        if (w.dbDown) throw new Error("connect ECONNREFUSED");
        const a = await assessReadiness({ product: w.products.get(productId) ?? null, mappings: w.mappings.get(productId) ?? null, releaseEnabled: w.release, margin: w.margin });
        return { ...a, result: { productId, requested: a.requested, effective: a.effective, reasons: a.reasons, readinessVersion: READINESS_RULES_VERSION, evaluatedAt: w.now.toISOString() } };
      },
      async reevaluate(productId, trigger) {
        w.reevaluated.push([productId, trigger]);
        return null;
      },
    },
    supplierQuote: w.wired
      ? {
          async quote(input) {
            w.supplierCalls.push(input);
            return w.supplier(input);
          },
        }
      : null,
    margin: w.margin,
    store: w.store,
    isFirstBooking: async (owner) => owner.kind === "customer" && w.firstBooking,
    async instantOrderCap() {
      w.capReads++;
      if (w.capDown) throw new Error("connect ECONNREFUSED");
      return { capAedMinor: w.cap, inrPerAed: w.fx };
    },
    now: () => w.now,
  };
  return Object.assign(w, { svc: createQuoteService(deps) });
}

async function refusal(w: ReturnType<typeof world>, req: unknown, owner = GUEST) {
  const r = await w.svc.create(owner, req as QuoteRequest);
  if (r.ok) throw new Error("expected a refusal");
  return r.lines;
}

describe("quote: the happy path", () => {
  it("prices from typed units in the transaction currency, snapshots supplier, margin and policy, persists ≤ 10 minutes", async () => {
    const w = world();
    const q = await w.svc.create(GUEST, request());
    expect(q.ok).toBe(true);
    if (!q.ok) return;
    // 2 × AED 200 + 1 × AED 160, in fils.
    expect(q.totalMinor).toBe(56_000n);
    expect(q.currency).toBe("AED");
    expect(q.couponCode).toBeNull();
    expect(q.lines[0]).toMatchObject({
      productId: PRODUCT_ID,
      mappingId: MAPPING_ID,
      approvedOfferHash: "a".repeat(64),
      supplierEnvironment: "test",
      readinessRulesVersion: READINESS_RULES_VERSION,
      unitDefinitions: [ADULT, CHILD],
      pickup: null,
      slotRef: "slot-0900",
      chargedMinor: 56_000n,
      discountAllocMinor: 0n,
      taxAllocMinor: 0n,
      supplierNetAedMinor: 30_000n,
      margin: { policyVersion: POLICY.version, floorBps: POLICY.floorBps },
      freeCancellationUntilUtc: null,
      nonRefundableAfterConfirm: true,
    });
    expect(Date.parse(q.expiresAt) - NOW.getTime()).toBe(QUOTE_TTL_MS);
    expect(w.store.rows).toHaveLength(1);
    expect(w.supplierCalls).toEqual([{ mappingId: MAPPING_ID, serviceDate: TOMORROW, slotRef: "slot-0900", supplierUnits: { adult: 2, child: 1 }, pickup: null }]);
  });

  it("INR uses the authored INR prices, never a conversion", async () => {
    const q = await world().svc.create(GUEST, request({ currency: "INR" }));
    expect(q.ok && q.totalMinor).toBe(1_400_000n); // 2 × ₹5,000 + ₹4,000
  });
});

describe("quote: tampering is recomputed or refused (PRD-1, PRD-5)", () => {
  it("the request carries no price, mode or policy: extra fields are rejected outright", async () => {
    const w = world();
    for (const extra of [{ total: 1 }, { fulfilmentMode: "instant" }, { freeCancellationHours: 720 }]) {
      await expect(w.svc.create(GUEST, { ...request(), lines: [{ ...line(), ...extra }] } as unknown as QuoteRequest)).rejects.toMatchObject({ code: "VALIDATION_FAILED" });
    }
  });

  it.each<[string, Partial<QuoteLineRequest>, string]>([
    ["unknown variant", { variantId: "vip" }, "unknown_variant"],
    ["unknown unit", { units: { adult: 1, senior: 1 } }, "unknown_unit"],
    ["over the unit maximum", { units: { adult: 11 } }, "unit_rule_failed"],
    ["no seat at all", { units: { adult: 0 } }, "unit_rule_failed"],
    ["an add-on on an instant line", { addonIds: ["photo"] }, "unknown_addon"],
    ["no slot for a slotted product", { slotRef: null }, "invalid_slot"],
  ])("%s → %s", async (_n, over, reason) => {
    expect(await refusal(world(), request({ lines: [line(over)] }))).toEqual([{ index: 0, reason }]);
  });

  it("a sold-out variant is unknown to the quote", async () => {
    const doc = instantDoc({ variants: [instantDoc().variants[0], { ...instantDoc().variants[0], id: "sunset", soldOut: true }] });
    const w = world({ products: new Map([[PRODUCT_ID, product({}, doc)]]) });
    expect(await refusal(w, request({ lines: [line({ variantId: "sunset" })] }))).toEqual([{ index: 0, reason: "unknown_variant" }]);
  });

  it("unit rules: min quantity is enforced", () => {
    expect(checkUnits([{ ...ADULT, minQty: 2 }, CHILD], { adult: 1 })).toBe("unit_rule_failed");
    expect(checkUnits([{ ...ADULT, minQty: 2 }, CHILD], { adult: 2 })).toBeNull();
  });
});

describe("quote: eligibility from the database, never the cart (PRD-1, PRD-13)", () => {
  it("an inquiry product, whatever the cart claimed, is requires_inquiry", async () => {
    const w = world({ products: new Map([[PRODUCT_ID, product({ fulfilmentMode: "inquiry" })]]) });
    expect(await refusal(w, request())).toEqual([{ index: 0, reason: "requires_inquiry" }]);
    expect(w.supplierCalls).toEqual([]);
    expect(w.store.rows).toEqual([]);
  });

  it("mixed cart: the inquiry line is refused, so the whole cart goes to inquiry; no supplier read, no quote", async () => {
    const w = world({ products: new Map([[PRODUCT_ID, product()], [OTHER_ID, product({ id: OTHER_ID, fulfilmentMode: "inquiry" })]]) });
    expect(await refusal(w, request({ lines: [line(), line({ productId: OTHER_ID })] }))).toEqual([{ index: 1, reason: "requires_inquiry" }]);
    expect(w.supplierCalls).toEqual([]);
    expect(w.store.rows).toEqual([]);
  });

  it("owner question 1 (3 Nov 2026): an all-instant cart is one quote with one line per activity", async () => {
    expect(MULTI_INSTANT_ITEM_POLICY).toBe("allow");
    const w = world({ products: new Map([[PRODUCT_ID, product()], [OTHER_ID, product({ id: OTHER_ID })]]), mappings: new Map([[PRODUCT_ID, [mapping()]], [OTHER_ID, [mapping()]]]) });
    const q = await w.svc.create(GUEST, request({ lines: [line(), line({ productId: OTHER_ID }), line({ serviceDate: "2026-11-03" })] }));
    expect(q.ok).toBe(true);
    if (!q.ok) return;
    expect(q.lines.map((l) => [l.index, l.productId, l.serviceDate])).toEqual([
      [0, PRODUCT_ID, TOMORROW],
      [1, OTHER_ID, TOMORROW],
      [2, PRODUCT_ID, "2026-11-03"],
    ]);
    // The quote total is exactly the sum of the lines' payable amounts.
    expect(q.totalMinor).toBe(q.lines.reduce((s, l) => s + l.chargedMinor - l.discountAllocMinor + l.taxAllocMinor, 0n));
    expect(q.totalMinor).toBe(3n * 56_000n);
    expect(w.supplierCalls).toHaveLength(3);
    expect(w.store.rows).toHaveLength(1);
  });

  it("a coupon on a multi-line quote is split across the lines exactly", async () => {
    const w = world({ products: new Map([[PRODUCT_ID, product()], [OTHER_ID, product({ id: OTHER_ID })]]), mappings: new Map([[PRODUCT_ID, [mapping()]], [OTHER_ID, [mapping()]]]) });
    const q = await w.svc.create(CUSTOMER, request({ currency: "INR", lines: [line(), line({ productId: OTHER_ID })], couponCode: "FIRSTTRIP" }));
    expect(q.ok).toBe(true);
    if (!q.ok) return;
    const discount = q.lines.reduce((s, l) => s + l.discountAllocMinor, 0n);
    // 10% of ₹28,000 is capped at ₹2,000; the two shares add up to it exactly.
    expect(discount).toBe(200_000n);
    expect(q.lines.every((l) => l.discountAllocMinor > 0n)).toBe(true);
    expect(q.totalMinor).toBe(2n * 1_400_000n - discount);
  });

  it("a product reverted to inquiry after the cart was built is refused at quote time", async () => {
    const w = world();
    expect((await w.svc.create(GUEST, request())).ok).toBe(true);
    w.mappings.set(PRODUCT_ID, [mapping({ state: "inactive" })]);
    expect(await refusal(w, request())).toEqual([{ index: 0, reason: "requires_inquiry" }]);
  });

  it("unpublished, deleted or unknown products are not_published", async () => {
    for (const p of [product({ status: "draft" }), product({ deletedAt: NOW })]) {
      expect(await refusal(world({ products: new Map([[PRODUCT_ID, p]]) }), request())).toEqual([{ index: 0, reason: "not_published" }]);
    }
    expect(await refusal(world({ products: new Map() }), request())).toEqual([{ index: 0, reason: "not_published" }]);
  });

  it("invalid stored content is refused, never priced from a fixture (PRD-13)", async () => {
    const w = world({ products: new Map([[PRODUCT_ID, product({}, { slug: "x" } as unknown as Activity)]]) });
    expect(await refusal(w, request())).toEqual([{ index: 0, reason: "not_published" }]);
  });

  it("the release switch off refuses every line", async () => {
    expect(await refusal(world({ release: false }), request())).toEqual([{ index: 0, reason: "requires_inquiry" }]);
  });

  it("database down: a retryable 503 and nothing persisted", async () => {
    const w = world({ dbDown: true });
    const err = await w.svc.create(GUEST, request()).catch((e: unknown) => e);
    expect(isAppError(err) && err.status).toBe(503);
    expect(w.store.rows).toEqual([]);
  });

  it("supplier seam not wired: supplier_unavailable, no quote", async () => {
    expect(await refusal(world({ wired: false }), request())).toEqual([{ index: 0, reason: "supplier_unavailable" }]);
  });
});

describe("quote: dates, cutoffs and supply (PRD-18)", () => {
  it("a date before Dubai today is past_cutoff; Dubai today is quoted like any day (owner question 3)", async () => {
    expect(SAME_DAY_INSTANT_POLICY).toBe("allow");
    // 21:30 UTC on 1 Nov is already 2 Nov in Dubai.
    const late = new Date("2026-11-01T21:30:00Z");
    expect(await refusal(world({ now: late }), request({ lines: [line({ serviceDate: "2026-11-01" })] }))).toEqual([{ index: 0, reason: "past_cutoff" }]);
    const w = world({ now: late });
    const q = await w.svc.create(GUEST, request({ lines: [line({ serviceDate: TOMORROW })] }));
    expect(q.ok).toBe(true);
    // The quote never outlives the slot's cutoff.
    expect(q.ok && Date.parse(q.expiresAt)).toBeLessThanOrEqual(Date.parse("2026-11-02T03:00:00Z"));
  });

  it("same day: the slot's own cutoff still applies (MIN_PAYMENT_WINDOW_MS before it)", async () => {
    // Dubai today is 1 Nov at NOW; the supplier's cutoff is under the payment window away.
    const cutoff = new Date(NOW.getTime() + MIN_PAYMENT_WINDOW_MS - 1).toISOString();
    const w = world({ supplier: () => okSupplier({ cutoffUtc: cutoff }) });
    expect(await refusal(w, request({ lines: [line({ serviceDate: "2026-11-01" })] }))).toEqual([{ index: 0, reason: "past_cutoff" }]);
    expect(w.supplierCalls).toHaveLength(1);
    // With the window left, the same slot is quoted, and the quote ends at the cutoff.
    const at = new Date(NOW.getTime() + MIN_PAYMENT_WINDOW_MS + 60_000).toISOString();
    const q = await world({ supplier: () => okSupplier({ cutoffUtc: at }) }).svc.create(GUEST, request({ lines: [line({ serviceDate: "2026-11-01" })] }));
    expect(q.ok && q.expiresAt).toBe(at);
  });

  it("supplier cutoff already passed", async () => {
    const w = world({ supplier: () => okSupplier({ cutoffUtc: "2026-11-01T07:59:00Z" }) });
    expect(await refusal(w, request())).toEqual([{ index: 0, reason: "past_cutoff" }]);
  });

  it.each([
    ["closed", "closed"],
    ["sold_out", "sold_out"],
    ["invalid_slot", "invalid_slot"],
    ["past_cutoff", "past_cutoff"],
    ["on_request", "requires_inquiry"],
    ["availability_unknown", "availability_unknown"],
    ["supplier_unavailable", "supplier_unavailable"],
    ["unit_rule_failed", "unit_rule_failed"],
    ["pickup_unavailable", "pickup_unavailable"],
  ] as const)("supplier says %s → %s", async (supplierReason, reason) => {
    const w = world({ supplier: () => ({ ok: false, reason: supplierReason }) });
    expect(await refusal(w, request())).toEqual([{ index: 0, reason }]);
  });

  it("fewer seats left than seat-consuming units is sold_out (last seat)", async () => {
    expect(await refusal(world({ supplier: () => okSupplier({ seatsLeft: 2 }) }), request())).toEqual([{ index: 0, reason: "sold_out" }]);
    expect((await world({ supplier: () => okSupplier({ seatsLeft: 3 }) }).svc.create(GUEST, request())).ok).toBe(true);
  });

  it("a supplier call that throws is supplier_unavailable", async () => {
    const w = world({ supplier: () => Promise.reject(new Error("timeout")) });
    expect(await refusal(w, request())).toEqual([{ index: 0, reason: "supplier_unavailable" }]);
  });
});

describe("quote: money", () => {
  it("margin breach on the fresh supplier net refuses the line", async () => {
    const w = world({ supplier: () => okSupplier({ netAedMinor: 50_000n }) });
    expect(await refusal(w, request())).toEqual([{ index: 0, reason: "margin_below_floor" }]);
    expect(w.store.rows).toEqual([]);
  });

  it("margin penny boundary: exactly the floor passes, one fils more net fails", async () => {
    // AED 560.00 charged; 15% floor → net may be at most AED 476.00.
    expect((await world({ supplier: () => okSupplier({ netAedMinor: 47_600n }) }).svc.create(GUEST, request())).ok).toBe(true);
    expect(await refusal(world({ supplier: () => okSupplier({ netAedMinor: 47_601n }) }), request())).toEqual([{ index: 0, reason: "margin_below_floor" }]);
  });

  it("a coupon applies in the quote currency and the margin is checked after the discount", async () => {
    const w = world();
    const q = await w.svc.create(CUSTOMER, request({ currency: "INR", couponCode: "firsttrip" }));
    expect(q.ok && q.totalMinor).toBe(1_400_000n - 140_000n);
    expect(q.ok && q.lines[0].discountAllocMinor).toBe(140_000n);
    expect(w.margin.evaluated.at(-1)).toMatchObject({ chargedMinor: 1_260_000n, currency: "INR" });
  });

  it("a coupon with no authored value in the quote currency refuses the line, never converts", async () => {
    const w = world();
    expect(await refusal(w, request({ couponCode: "FIRSTTRIP" }), CUSTOMER)).toEqual([{ index: 0, reason: "coupon_not_available_in_currency" }]);
    expect(w.store.rows).toEqual([]);
  });

  it("a coupon with an authored AED value applies in AED (synthetic figures)", async () => {
    coupons.push({ code: "TESTAED", label: "test", kind: "fixed", value: 1, minOrderINR: 1, note: "", authored: { AED: { minOrder: 100, off: 56 } } });
    try {
      const q = await world().svc.create(GUEST, request({ couponCode: "testaed" }));
      expect(q.ok && q.totalMinor).toBe(56_000n - 5_600n);
    } finally {
      coupons.pop();
    }
  });

  it("an unknown coupon, or a first-booking coupon for a guest, is a field error, not a silent full price", async () => {
    await expect(world().svc.create(GUEST, request({ couponCode: "NOPE" }))).rejects.toMatchObject({ code: "VALIDATION_FAILED" });
    await expect(world().svc.create(GUEST, request({ currency: "INR", couponCode: "FIRSTTRIP" }))).rejects.toMatchObject({ code: "VALIDATION_FAILED" });
  });

  it("policy-version snapshot stability: a later policy change never rewrites a stored quote", async () => {
    const w = world();
    const first = await w.svc.create(GUEST, request());
    const stored = JSON.stringify(w.store.rows[0].snapshot, (_k, v) => (typeof v === "bigint" ? v.toString() : v));
    w.margin = fakeMargin({ policy: { ...POLICY, version: 4, floorBps: 1000 } });
    const w2 = world({ store: w.store, margin: w.margin });
    const second = await w2.svc.create(GUEST, request());
    expect(first.ok && first.lines[0].margin.policyVersion).toBe(3);
    expect(second.ok && second.lines[0].margin.policyVersion).toBe(4);
    expect(JSON.stringify(w.store.rows[0].snapshot, (_k, v) => (typeof v === "bigint" ? v.toString() : v))).toBe(stored);
  });
});

describe("quote: displayed policy against the fresh supplier facts (TKT-7, CR-B2-6)", () => {
  const LATER = "2026-11-05"; // 00:00 Dubai = 2026-11-04T20:00Z
  const refundable = (supplierUntil: string | null, tickets: "yes" | "no" | "unknown" = "no", slotRef = "17@18:00") =>
    world({
      products: new Map([[PRODUCT_ID, product({}, instantDoc({ freeCancellationHours: 24 }))]]),
      mappings: new Map([[PRODUCT_ID, [mapping({ issuesTicketsAtConfirm: "no", supplierFreeCancellationHours: 24 })]]]),
      supplier: () => okSupplier({ slotRef, cutoffUtc: null, issuesTicketsAtConfirm: tickets, supplierFreeCancellationUntilUtc: supplierUntil }),
    });
  const later = () => request({ lines: [line({ serviceDate: LATER, slotRef: "17@18:00" })] });

  it("our own deadline counts back from the slot start in Dubai; without a start time, from the day start", () => {
    expect(slotStartMinutes("17@18:00")).toBe(18 * 60);
    expect(slotStartMinutes("slot-0900")).toBeNull();
    expect(slotStartMinutes(null)).toBeNull();
    expect(customerFreeCancellationUntil(LATER, 24, 18 * 60)?.toISOString()).toBe("2026-11-04T14:00:00.000Z");
    expect(customerFreeCancellationUntil(LATER, 24)?.toISOString()).toBe("2026-11-03T20:00:00.000Z");
    expect(customerFreeCancellationUntil(LATER, 0)).toBeNull();
  });

  it("the snapshot deadline is the earlier of ours and the supplier's", async () => {
    // Supplier counts from midnight: its deadline (D-1 00:00 Dubai) is earlier than ours (D-1 18:00 Dubai).
    const q = await refundable("2026-11-03T20:00:00.000Z").svc.create(GUEST, later());
    expect(q.ok && q.lines[0]).toMatchObject({ freeCancellationUntilUtc: "2026-11-03T20:00:00.000Z", nonRefundableAfterConfirm: false });
    // Supplier more generous than us: ours stands.
    const r = await refundable("2026-11-04T16:00:00.000Z").svc.create(GUEST, later());
    expect(r.ok && r.lines[0]).toMatchObject({ freeCancellationUntilUtc: "2026-11-04T14:00:00.000Z", nonRefundableAfterConfirm: false });
  });

  it("the copy shown is the snapshot's own exact deadline, in Dubai time (CO-01), and the public line carries it", async () => {
    const q = toPublicQuote(await refundable("2026-11-03T20:00:00.000Z").svc.create(GUEST, later()));
    if (!q.ok) throw new Error("expected a quote");
    // 20:00 UTC on 3 Nov is 00:00 on 4 Nov in Dubai: the one statement the review step and the status page also show.
    const copy = "Free cancellation until Wed 4 Nov 2026, 00:00 Dubai time. After that, the booking is non-refundable.";
    expect(freeCancellationCopy(q.lines[0].freeCancellationUntilUtc)).toBe(copy);
    expect(q.lines[0].freeCancellationCopy).toBe(copy);
    expect(freeCancellationCopy(null)).toBe("This booking is non-refundable once confirmed.");
    const n = toPublicQuote(await world().svc.create(GUEST, request()));
    expect(n.ok && n.lines[0].freeCancellationCopy).toBe("This booking is non-refundable once confirmed.");
  });

  it("a supplier deadline earlier than the page's promise counted from the day start refuses the line and re-runs readiness (N1)", async () => {
    // Page: 24 hours. Earliest honest reading: 24 hours before 00:00 Dubai on 5 Nov = 2026-11-03T20:00Z.
    const tightened = refundable("2026-11-03T19:59:59.999Z");
    expect(await refusal(tightened, later())).toEqual([{ index: 0, reason: "policy_exceeds_supplier" }]);
    expect(tightened.reevaluated).toEqual([[PRODUCT_ID, "supplier_policy_changed"]]);
    expect(tightened.store.rows).toEqual([]);
    // A supplier now asking 72 hours instead of 24.
    const w72 = refundable("2026-11-01T20:00:00.000Z");
    expect(await refusal(w72, later())).toEqual([{ index: 0, reason: "policy_exceeds_supplier" }]);
    expect(w72.reevaluated).toEqual([[PRODUCT_ID, "supplier_policy_changed"]]);
    // Exactly at the day-start promise: only the midnight-to-slot gap is clamped, no re-run.
    const atPromise = refundable("2026-11-03T20:00:00.000Z");
    expect((await atPromise.svc.create(GUEST, later())).ok).toBe(true);
    expect(atPromise.reevaluated).toEqual([]);
  });

  it("a deadline already passed snapshots no free cancellation", async () => {
    const q = await refundable("2026-11-01T07:00:00.000Z").svc.create(GUEST, request({ lines: [line({ slotRef: "17@18:00" })] }));
    expect(q.ok && q.lines[0]).toMatchObject({ freeCancellationUntilUtc: null, nonRefundableAfterConfirm: true });
  });

  it("supplier deadline unknown, or tickets now issue at confirm → policy_exceeds_supplier, and readiness re-runs", async () => {
    const unknownDeadline = refundable(null);
    expect(await refusal(unknownDeadline, later())).toEqual([{ index: 0, reason: "policy_exceeds_supplier" }]);
    expect(unknownDeadline.reevaluated).toEqual([[PRODUCT_ID, "supplier_policy_changed"]]);
    expect(await refusal(refundable("2026-11-03T20:00:00.000Z", "unknown"), later())).toEqual([{ index: 0, reason: "policy_exceeds_supplier" }]);
  });
});

describe("quote: expiry (CR-B2-9)", () => {
  it("expires at the earlier of ten minutes and the supplier cutoff", async () => {
    const soon = new Date(NOW.getTime() + 7 * 60_000).toISOString();
    const q = await world({ supplier: () => okSupplier({ cutoffUtc: soon }) }).svc.create(GUEST, request());
    expect(q.ok && q.expiresAt).toBe(soon);
    const r = await world().svc.create(GUEST, request());
    expect(r.ok && Date.parse(r.expiresAt) - NOW.getTime()).toBe(QUOTE_TTL_MS);
  });

  it("less than MIN_PAYMENT_WINDOW_MS before the cutoff is past_cutoff; exactly the window passes", async () => {
    expect(MIN_PAYMENT_WINDOW_MS).toBe(5 * 60_000);
    const at = (ms: number) => world({ supplier: () => okSupplier({ cutoffUtc: new Date(NOW.getTime() + ms).toISOString() }) });
    const w = at(MIN_PAYMENT_WINDOW_MS - 1);
    expect(await refusal(w, request())).toEqual([{ index: 0, reason: "past_cutoff" }]);
    expect(w.store.rows).toEqual([]);
    const ok = await at(MIN_PAYMENT_WINDOW_MS).svc.create(GUEST, request());
    expect(ok.ok && Date.parse(ok.expiresAt) - NOW.getTime()).toBe(MIN_PAYMENT_WINDOW_MS);
  });
});

describe("quote: snapshot provenance (CR-B2-12)", () => {
  it("records the supplier account from the mapping facts", async () => {
    const q = await world({ mappings: new Map([[PRODUCT_ID, [mapping({ accountId: "synthetic-account-7" })]]]) }).svc.create(GUEST, request());
    expect(q.ok && q.lines[0].supplierAccountId).toBe("synthetic-account-7");
    const none = await world().svc.create(GUEST, request());
    expect(none.ok && none.lines[0].supplierAccountId).toBeNull();
  });

  it("records the version of the coupon terms applied, which changes with the terms", async () => {
    const none = await world().svc.create(GUEST, request());
    expect(none.ok && [none.couponVersion, none.lines[0].couponVersion]).toEqual([null, null]);
    const q = await world().svc.create(CUSTOMER, request({ currency: "INR", couponCode: "firsttrip" }));
    const firstTrip = coupons.find((c) => c.code === "FIRSTTRIP")!;
    expect(q.ok && q.couponVersion).toBe(couponVersionOf(firstTrip));
    expect(q.ok && q.lines[0].couponVersion).toBe(couponVersionOf(firstTrip));
    expect(couponVersionOf(firstTrip)).toMatch(/^[0-9a-f]{64}$/);
    expect(couponVersionOf({ ...firstTrip, value: 12 })).not.toBe(couponVersionOf(firstTrip));
  });
});

describe("quote: traveller restrictions (CR-B2-10)", () => {
  it("a residents-only unit keeps the product inquiry: no supplier read, no quote", async () => {
    const doc = instantDoc({ variants: [{ ...instantDoc().variants[0], units: [{ ...ADULT, residency: "uae_resident" }, CHILD] }] });
    const w = world({ products: new Map([[PRODUCT_ID, product({}, doc)]]) });
    expect(await refusal(w, request())).toEqual([{ index: 0, reason: "requires_inquiry" }]);
    expect(w.supplierCalls).toEqual([]);
  });
});

describe("quote: local rules before any supplier call (CR-B2-3)", () => {
  it(`more than ${MAX_INSTANT_ITEMS_PER_ORDER} instant lines go to inquiry with zero supplier calls; ${MAX_INSTANT_ITEMS_PER_ORDER} are quoted`, async () => {
    expect(MAX_INSTANT_ITEMS_PER_ORDER).toBe(5);
    const dates = ["2026-11-02", "2026-11-03", "2026-11-04", "2026-11-05", "2026-11-06", "2026-11-07"];
    const w = world();
    const six = dates.map((d) => line({ serviceDate: d }));
    expect((await refusal(w, request({ lines: six }))).map((l) => l.reason)).toEqual(Array(6).fill("multi_instant_inquiry"));
    expect(w.supplierCalls).toEqual([]);
    const q = await w.svc.create(GUEST, request({ lines: six.slice(0, 5) }));
    expect(q.ok && q.lines.length).toBe(5);
  });

  it("two lines for the same variant, date and slot go to inquiry with zero supplier calls", async () => {
    const w = world();
    expect((await refusal(w, request({ lines: [line(), line({ units: { adult: 1 } })] }))).map((l) => l.reason)).toEqual(["multi_instant_inquiry", "multi_instant_inquiry"]);
    expect(w.supplierCalls).toEqual([]);
  });

  it.each<[string, Partial<QuoteLineRequest>]>([
    ["unknown variant", { variantId: "vip" }],
    ["unknown unit", { units: { adult: 1, senior: 1 } }],
    ["an add-on", { addonIds: ["photo"] }],
    ["a pickup the product does not offer", { pickup: { hotelRef: "h-1" } }],
  ])("%s: refused locally, no supplier call", async (_n, over) => {
    const w = world();
    await refusal(w, request({ lines: [line(over)] }));
    expect(w.supplierCalls).toEqual([]);
  });

  it("an unknown coupon or one without a value in the currency costs no supplier read", async () => {
    const w = world();
    await expect(w.svc.create(GUEST, request({ couponCode: "NOPE" }))).rejects.toMatchObject({ code: "VALIDATION_FAILED" });
    expect(await refusal(w, request({ couponCode: "FIRSTTRIP" }), CUSTOMER)).toEqual([{ index: 0, reason: "coupon_not_available_in_currency" }]);
    expect(w.supplierCalls).toEqual([]);
  });

  it("unit lookups ignore inherited properties (a unit id like `constructor` is just unknown)", () => {
    expect(checkUnits([ADULT], { constructor: 1 } as Record<string, number>)).toBe("unknown_unit");
    expect(checkUnits([{ ...ADULT, unitId: "constructor" }], {})).toBe("unit_rule_failed");
  });
});

describe("quote: pickup (CR-B2-4)", () => {
  const withPickup = (over: { pickupOffered?: boolean | null } = {}) =>
    world({
      products: new Map([[PRODUCT_ID, product({}, instantDoc({ pickupIncluded: true }))]]),
      mappings: new Map([[PRODUCT_ID, [mapping({ pickupOffered: true, ...over })]]]),
    });

  it("a product with pickup needs a hotel; the hotel goes to the supplier check and into the snapshot", async () => {
    const w = withPickup();
    expect(await refusal(w, request())).toEqual([{ index: 0, reason: "pickup_unavailable" }]);
    expect(w.supplierCalls).toEqual([]);
    const q = await w.svc.create(GUEST, request({ lines: [line({ pickup: { hotelRef: "hotel-42" } })] }));
    expect(q.ok && q.lines[0].pickup).toEqual({ hotelRef: "hotel-42" });
    expect(w.supplierCalls).toMatchObject([{ pickup: { hotelRef: "hotel-42" } }]);
  });

  it("a hotel not on the supplier's list is pickup_unavailable (supplier check)", async () => {
    const w = withPickup();
    w.supplier = () => ({ ok: false, reason: "pickup_unavailable" });
    expect(await refusal(w, request({ lines: [line({ pickup: { hotelRef: "asdf" } })] }))).toEqual([{ index: 0, reason: "pickup_unavailable" }]);
  });

  it("an offer that collects from hotels needs a hotel even when content forgot it; readiness already keeps that product inquiry", async () => {
    const w = world({ mappings: new Map([[PRODUCT_ID, [mapping({ pickupOffered: true })]]]) });
    expect(await refusal(w, request())).toEqual([{ index: 0, reason: "requires_inquiry" }]);
    expect(w.supplierCalls).toEqual([]);
  });

  it("without pickup, a supplied hotel is refused", async () => {
    expect(await refusal(world(), request({ lines: [line({ pickup: { hotelRef: "hotel-42" } })] }))).toEqual([{ index: 0, reason: "pickup_unavailable" }]);
  });
});

describe("quote: ticket validity (TicketOnly, Q-T2)", () => {
  it("states the last valid day from the supplier, and nothing for other bookings", () => {
    expect(ticketValidityCopy("2027-03-31")).toBe("Ticket valid until Wednesday, 31 March 2027.");
    expect(ticketValidityCopy("2027-02-30")).toBeNull();
    expect(ticketValidityCopy(null)).toBeNull();
    expect(ticketValidityCopy(undefined)).toBeNull();
    expect(ticketValidityCopy("31/03/2027")).toBeNull();
  });
});

describe("quote: the public projection (CR-B2-1)", () => {
  const FORBIDDEN = /supplier|margin|cost|fx|inrPerAed|mapping|offerHash|fingerprint|owner|guestSession|customerId|policyVersion|floorBps|unitDefinitions|readiness|environment|productVersion|checkedAt/i;
  const ALLOWED_TOP = ["ok", "quoteId", "expiresAt", "currency", "totalMinor", "lines"];
  const ALLOWED_LINE = ["index", "productId", "variantId", "serviceDate", "slotRef", "units", "addonIds", "chargedMinor", "discountAllocMinor", "taxAllocMinor", "freeCancellationUntilUtc", "freeCancellationCopy", "nonRefundableAfterConfirm", "ticketValidUntil", "ticketValidityCopy"];

  function keysOf(v: unknown, path = ""): string[] {
    if (Array.isArray(v)) return v.flatMap((x, i) => keysOf(x, `${path}[${i}]`));
    if (v && typeof v === "object") return Object.entries(v).flatMap(([k, x]) => [`${path}.${k}`, ...(path.endsWith("units") ? [] : keysOf(x, `${path}.${k}`))]);
    return [];
  }

  it("a quote carries only the allowlisted fields; supplier net, margin, mapping, fingerprint and owner stay on the server", async () => {
    const q = await world().svc.create(GUEST, request());
    const body = JSON.parse(JSON.stringify(toPublicQuote(q)));
    expect(Object.keys(body).sort()).toEqual([...ALLOWED_TOP].sort());
    for (const l of body.lines) expect(Object.keys(l).sort()).toEqual([...ALLOWED_LINE].sort());
    expect(keysOf(body).filter((k) => FORBIDDEN.test(k.split(".").at(-1)!))).toEqual([]);
    expect(body).toMatchObject({ ok: true, currency: "AED", totalMinor: "56000", lines: [{ chargedMinor: "56000", units: { adult: 2, child: 1 } }] });
    expect(JSON.stringify(body)).not.toContain("30000"); // the synthetic supplier net
  });

  it("a ticket's last valid day is stored and shown; a stored line without it (older quote) shows none", async () => {
    const w = world({ supplier: () => okSupplier({ ticketValidUntil: "2027-03-31" }) });
    const q = await w.svc.create(GUEST, request());
    expect(q.ok && q.lines[0].ticketValidUntil).toBe("2027-03-31");
    expect(toPublicQuote(q)).toMatchObject({ lines: [{ ticketValidUntil: "2027-03-31", ticketValidityCopy: "Ticket valid until Wednesday, 31 March 2027." }] });
    if (!q.ok) return;
    const legacy = { ...q, lines: q.lines.map(({ ticketValidUntil: _drop, ...rest }) => rest) };
    expect(toPublicQuote(legacy)).toMatchObject({ lines: [{ ticketValidUntil: null, ticketValidityCopy: null }] });
  });

  it("the supplier USD net is stored on the line for the engine and never reaches the public projection", async () => {
    const usd = 8_171n; // synthetic supplier USD net
    const w = world({ supplier: () => okSupplier({ netUsdMinor: usd }) });
    const q = await w.svc.create(GUEST, request());
    expect(q.ok).toBe(true);
    const stored = w.store.rows[0].snapshot.lines[0];
    expect(stored.supplierNetUsdMinor).toBe(usd);
    expect(storedLineJson(stored as Parameters<typeof storedLineJson>[0]).supplierNetUsdMinor).toBe("8171");
    const body = JSON.stringify(toPublicQuote(q));
    expect(body).not.toContain("supplierNetUsd");
    expect(body).not.toContain("8171");
  });

  it("a supplier answer without a USD net is stored as null, not derived from AED", async () => {
    const w = world();
    await w.svc.create(GUEST, request());
    const stored = w.store.rows[0].snapshot.lines[0];
    expect(stored.supplierNetUsdMinor).toBeNull();
    expect(storedLineJson(stored as Parameters<typeof storedLineJson>[0]).supplierNetUsdMinor).toBeNull();
  });

  it("a refusal carries only index and reason, and margin or supplier-terms reasons read as requires_inquiry", async () => {
    const r = toPublicQuote(await world({ supplier: () => okSupplier({ netAedMinor: 50_000n }) }).svc.create(GUEST, request()));
    expect(r).toEqual({ ok: false, lines: [{ index: 0, reason: "requires_inquiry" }] });
    expect(toPublicQuote({ ok: false, lines: [{ index: 1, reason: "policy_exceeds_supplier" }, { index: 0, reason: "sold_out" }] })).toEqual({
      ok: false,
      lines: [{ index: 1, reason: "requires_inquiry" }, { index: 0, reason: "sold_out" }],
    });
  });
});

describe("quote: fingerprint, replay and ownership", () => {
  it("canonical form ignores unit order, zero units and coupon case", () => {
    const a = canonicalRequest(request({ lines: [line({ units: { child: 1, adult: 2, infant: 0 } })], couponCode: " firsttrip " }));
    const b = canonicalRequest(request({ lines: [line({ units: { adult: 2, child: 1 } })], couponCode: "FIRSTTRIP" }));
    expect(quoteFingerprint(GUEST, a)).toBe(quoteFingerprint(GUEST, b));
    expect(quoteFingerprint(GUEST, a)).not.toBe(quoteFingerprint(CUSTOMER, a));
    expect(quoteFingerprint(GUEST, a)).toMatch(/^[0-9a-f]{64}$/);
  });

  it("canonical JSON: key order and number form do not matter", () => {
    expect(canonicalJson({ b: 1, a: { d: [1, { y: 2, x: -0 }], c: 2n } })).toBe(canonicalJson({ a: { c: "2", d: [1, { x: 0, y: 2 }] }, b: 1.0 }));
    expect(canonicalJson({ a: [1, 2] })).not.toBe(canonicalJson({ a: [2, 1] }));
  });

  it("the stored request comes back with JSONB's key order and still matches: a re-quote is not a 409 (CR-B2-2)", async () => {
    const w = world();
    await w.svc.create(GUEST, request({ lines: [line({ pickup: null })] }));
    expect(Object.keys((w.store.rows[0].request as { lines: object[] }).lines[0])[0]).toBe("units");
    const again = await w.svc.create(GUEST, request());
    expect(again.ok).toBe(true);
    expect(w.store.rows.map((r) => r.status)).toEqual(["superseded", "active"]);
  });

  it("an expired row is expired before any conflict check, whatever it holds", async () => {
    const w = world();
    await w.svc.create(GUEST, request());
    w.store.rows[0].request = { tampered: true };
    w.now = new Date(NOW.getTime() + QUOTE_TTL_MS + 1);
    expect((await w.svc.create(GUEST, request())).ok).toBe(true);
    expect(w.store.rows.map((r) => r.status)).toEqual(["expired", "active"]);
  });

  it("a replay by the same owner supersedes the active quote; an expired one is marked expired", async () => {
    const w = world();
    await w.svc.create(GUEST, request());
    await w.svc.create(GUEST, request());
    expect(w.store.rows.map((r) => r.status)).toEqual(["superseded", "active"]);
    w.now = new Date(NOW.getTime() + QUOTE_TTL_MS + 1);
    await w.svc.create(GUEST, request());
    expect(w.store.rows.map((r) => r.status)).toEqual(["superseded", "expired", "active"]);
  });

  it("the same fingerprint under another owner or with other content is a 409", async () => {
    const w = world();
    const q = await w.svc.create(GUEST, request());
    if (!q.ok) throw new Error("expected a quote");
    w.store.rows[0].owner = CUSTOMER;
    await expect(w.svc.create(GUEST, request())).rejects.toMatchObject({ status: 409 });
    w.store.rows[0].owner = GUEST;
    w.store.rows[0].request = { tampered: true };
    await expect(w.svc.create(GUEST, request())).rejects.toMatchObject({ status: 409 });
  });

  it("a concurrent insert of the same fingerprint is a 409, not a second quote", async () => {
    const w = world();
    w.store.race();
    await expect(w.svc.create(GUEST, request())).rejects.toMatchObject({ status: 409 });
    expect(w.store.rows).toEqual([]);
  });
});

describe("quote: per-order instant cap (doc 22 §32.24, owner: 500 AED per order)", () => {
  const ORDER_CAP = "order_over_limit";

  it("AED: a total exactly at the cap is quoted; one fil over sends every line to inquiry before any supplier read", async () => {
    // 2 × AED 200 + 1 × AED 160 = 56_000 fils.
    const at = world({ cap: 56_000 });
    expect((await at.svc.create(GUEST, request())).ok).toBe(true);

    const over = world({ cap: 55_999 });
    const r = await over.svc.create(GUEST, request());
    expect(r).toEqual({ ok: false, lines: [{ index: 0, reason: ORDER_CAP }] });
    expect(over.supplierCalls).toEqual([]);
    expect(over.store.rows).toEqual([]);
    // The customer sees the inquiry path, never the cap.
    expect(toPublicQuote(r)).toEqual({ ok: false, lines: [{ index: 0, reason: "requires_inquiry" }] });
  });

  it("the owner's 500 AED: 50_000 fils passes, 50_001 does not", () => {
    expect(instantOrderCapVerdict({ totalMinor: 50_000n, currency: "AED", capAedMinor: 50_000, inrPerAed: null })).toEqual({ ok: true, orderAedMinor: 50_000n });
    expect(instantOrderCapVerdict({ totalMinor: 50_001n, currency: "AED", capAedMinor: 50_000, inrPerAed: null })).toEqual({ ok: false, reason: ORDER_CAP, orderAedMinor: 50_001n });
  });

  it("INR: converted with the current FX row; just under passes, just over is refused", async () => {
    // ₹14,000 = 1_400_000 paise. At 28.01 INR/AED: 49_982.15 fils (under 500 AED); at 27.99: 50_017.86 (over).
    expect((await world({ cap: 50_000, fx: "28.01" }).svc.create(GUEST, request({ currency: "INR" }))).ok).toBe(true);
    expect((await world({ cap: 50_000, fx: "28.00" }).svc.create(GUEST, request({ currency: "INR" }))).ok).toBe(true); // exactly 50_000
    const over = world({ cap: 50_000, fx: "27.99" });
    expect(await refusal(over, request({ currency: "INR" }))).toEqual([{ index: 0, reason: ORDER_CAP }]);
    expect(over.supplierCalls).toEqual([]);
  });

  it("INR rounds in the strict direction: a total a fraction of a fil over the cap is refused, not rounded down onto it", async () => {
    // 1_400_000 × 100 / 2799 = 50_017.86 fils: floor would sit exactly at a 50_017 cap.
    expect(await refusal(world({ cap: 50_017, fx: "27.99" }), request({ currency: "INR" }))).toEqual([{ index: 0, reason: ORDER_CAP }]);
    expect((await world({ cap: 50_018, fx: "27.99" }).svc.create(GUEST, request({ currency: "INR" }))).ok).toBe(true);
  });

  it("INR with no usable FX row (missing or expired) is refused; AED does not need one", async () => {
    const w = world({ cap: 1_000_000_000, fx: null });
    expect(await refusal(w, request({ currency: "INR" }))).toEqual([{ index: 0, reason: ORDER_CAP }]);
    expect(w.supplierCalls).toEqual([]);
    expect((await world({ fx: null }).svc.create(GUEST, request())).ok).toBe(true);
  });

  it("a missing cap setting fails closed in both currencies (no silent default)", async () => {
    for (const currency of ["AED", "INR"] as const) {
      const w = world({ cap: 0 });
      expect(await refusal(w, request({ currency }))).toEqual([{ index: 0, reason: ORDER_CAP }]);
      expect(w.supplierCalls).toEqual([]);
    }
  });

  it("a multi-item cart counts as one order: every line under the cap, the total over it, is refused as a whole", async () => {
    const w3 = () => world({ cap: 100_000 });
    const three = request({ lines: [line(), line({ serviceDate: "2026-11-03" }), line({ serviceDate: "2026-11-04" })] });
    // Each line is 56_000 fils, the order 168_000.
    const w = w3();
    expect((await refusal(w, three)).map((l) => l.reason)).toEqual([ORDER_CAP, ORDER_CAP, ORDER_CAP]);
    expect(w.supplierCalls).toEqual([]);
    const q = await world({ cap: 168_000 }).svc.create(GUEST, three);
    expect(q.ok && q.totalMinor).toBe(168_000n);
  });

  it("the cap applies to the order total after the discount", async () => {
    // Two INR lines, ₹28,000, less the ₹2,000 FIRSTTRIP cap = ₹26,000; at 26.00 INR/AED that is exactly 100_000 fils.
    const lines = [line(), line({ productId: OTHER_ID })];
    const products = new Map([[PRODUCT_ID, product()], [OTHER_ID, product({ id: OTHER_ID })]]);
    const mappings = new Map([[PRODUCT_ID, [mapping()]], [OTHER_ID, [mapping()]]]);
    const q = await world({ products, mappings, cap: 100_000, fx: "26.00" }).svc.create(CUSTOMER, request({ currency: "INR", lines, couponCode: "FIRSTTRIP" }));
    expect(q.ok && q.totalMinor).toBe(2_600_000n);
    expect(await refusal(world({ products, mappings, cap: 99_999, fx: "26.00" }), request({ currency: "INR", lines, couponCode: "FIRSTTRIP" }), CUSTOMER)).toEqual([
      { index: 0, reason: ORDER_CAP },
      { index: 1, reason: ORDER_CAP },
    ]);
  });

  it("the settings read failing is a retryable 503, never a quote", async () => {
    const w = world({ capDown: true });
    await expect(w.svc.create(GUEST, request())).rejects.toSatisfy((e: unknown) => isAppError(e) && e.status === 503);
    expect(w.store.rows).toEqual([]);
    expect(w.supplierCalls).toEqual([]);
  });

  it("quote and checkout agree: the quote refuses exactly when the shared rule (checkout's gate) refuses", async () => {
    const cases: Array<{ currency: "AED" | "INR"; cap: number; fx: string | null }> = [];
    for (const cap of [0, 49_982, 49_983, 50_000, 50_017, 50_018, 55_999, 56_000, 56_001]) {
      cases.push({ currency: "AED", cap, fx: null });
      for (const fx of ["28.01", "28.00", "27.99", null]) cases.push({ currency: "INR", cap, fx });
    }
    for (const c of cases) {
      const q = await world({ cap: c.cap, fx: c.fx }).svc.create(GUEST, request({ currency: c.currency }));
      const total = c.currency === "AED" ? 56_000n : 1_400_000n;
      const gate = instantOrderCapVerdict({ totalMinor: total, currency: c.currency, capAedMinor: c.cap, inrPerAed: c.fx });
      expect({ ...c, quoted: q.ok }).toEqual({ ...c, quoted: gate.ok });
    }
  });
});
