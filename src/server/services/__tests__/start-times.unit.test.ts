import { describe, expect, it, vi } from "vitest";
import { addDays } from "@/lib/utils";
import type { SupplierQuoteInput } from "../../quotes/contracts";
import { admitRead, READ_BUDGET, type ReadClass, type ReadWindow } from "../../suppliers/read-budget";
import { offerTermsHash } from "../../suppliers/traveldesk/traveldesk.offer-terms";
import { row, SERVICE_DATE, storedOffer, storedSlot, storedTour } from "../../suppliers/__tests__/fixtures/traveldesk-terms";
import { mapping, instantDoc, product, PRODUCT_ID, fakeMargin } from "./_b2-fakes";

/**
 * Doc 29 Batch 2: the public start-times read. The supplier side
 * (`supplierQuoteService.startTimes`: approval checks, the browse budget, the
 * one-minute cache keyed by offer, date, environment and account) and the
 * product side (`createStartTimesService`: only an instant product whose
 * offer sells as listed starts asks the supplier). The database module is
 * replaced; nothing here opens a connection or a socket. Synthetic data only.
 */

vi.mock("../../lib/db", () => ({ prisma: {}, TX_OPTIONS: {} }));
vi.mock("../../lib/env", () => ({ env: () => ({}) }));

const { createSupplierQuoteService, START_TIMES_TTL_MS, START_TIMES_STALE_MS } = await import("../supplier-quote.service");
const { createStartTimesService } = await import("../start-times.service");
const { assessReadiness, READINESS_RULES_VERSION } = await import("../readiness.service");
type Deps = Parameters<typeof createSupplierQuoteService>[0];
type Context = NonNullable<Awaited<ReturnType<Deps["load"]>>>;

const NOW = new Date("2026-11-01T08:00:00Z");
const LISTED = storedOffer({
  timeSlots: [600, 780, 960].map((startMinutes) => storedSlot({ timeSlotId: 31, startMinutes, endMinutes: startMinutes + 60, isAnyTime: true, minimumAdvancedBookingHours: 8 })),
});
const listedRow = (date: string, startMinutes: number, over: Parameters<typeof row>[0] = {}) => row({ date, timeSlotId: 31, startMinutes, endMinutes: startMinutes + 60, ...over });

function context(offer: Record<string, unknown> = LISTED): Context {
  return {
    mapping: {
      id: "m-1",
      isActive: true,
      environment: "test",
      adapter: "traveldesk",
      supplierCode: "traveldesk",
      externalRef: { tourId: 3001, offerId: 501, bookingKind: "live_book", isExternal: false },
      approvedOfferHash: offerTermsHash(offer, storedTour())!,
    },
    offer: { payload: offer, removed: false },
    tour: { payload: storedTour(), removed: false },
  };
}

/** One shared read-budget window, as `takeClassReadToken` keeps it in `settings`, applied with the pure rule. */
function budget(limits = READ_BUDGET) {
  let window: ReadWindow = { used: 0, quoteUsed: 0 };
  const taken: ReadClass[] = [];
  const take = (cls: ReadClass) => async () => {
    const next = admitRead(window, cls, limits);
    if (!next) return false;
    window = next;
    taken.push(cls);
    return true;
  };
  return { take, taken, get window() { return window; }, set window(w: ReadWindow) { window = w; } };
}

function harness(ctx: Context | null = context(), opts: { fail?: boolean; browse?: boolean; rows?: (date: string) => ReturnType<typeof row>[] } = {}) {
  const calls: string[] = [];
  const clock = { ms: NOW.getTime() };
  const b = budget();
  const source = {
    async getAvailability(offerId: number, from: string) {
      calls.push(`availability:${offerId}:${from}`);
      if (opts.fail) throw new Error("timeout");
      return { rows: opts.rows ? opts.rows(from) : [listedRow(from, 600), listedRow(from, 780, { seatsLeft: 2 }), listedRow(from, 960, { seatsLeft: 0, price: { isBookable: false } })] };
    },
    async getTicketStock(): Promise<never> {
      throw new Error("not used");
    },
    async listPickupHotels() {
      return [];
    },
  };
  const svc = createSupplierQuoteService({
    load: async () => ctx,
    source: (environment) => ({ source, accountId: `acct-${environment}` }),
    takeQuoteReadToken: b.take("quote"),
    takeBrowseReadToken: opts.browse === false ? undefined : b.take("browse"),
    now: () => new Date(clock.ms),
    nowMs: () => clock.ms,
  });
  return { svc, calls, budget: b, clock };
}

const quoteInput: SupplierQuoteInput = { mappingId: "m-1", serviceDate: SERVICE_DATE, slotRef: "10:00", supplierUnits: { adult: 2 }, pickup: null };

describe("supplierQuoteService.startTimes (Batch 2)", () => {
  it("answers the listed starts with marks only, from one browse read, and reuses it for a minute per offer and date", async () => {
    const h = harness();
    const first = await h.svc.startTimes({ mappingId: "m-1", serviceDate: SERVICE_DATE });
    expect(first).toEqual({
      ok: true,
      checkedAt: NOW.toISOString(),
      stale: false,
      times: [
        { time: "10:00", status: "available" },
        { time: "13:00", status: "limited" },
        { time: "16:00", status: "sold_out" },
      ],
    });
    expect(JSON.stringify(first)).not.toMatch(/price|Minor|seats|501|3001/);
    await h.svc.startTimes({ mappingId: "m-1", serviceDate: SERVICE_DATE });
    expect(h.calls).toEqual([`availability:501:${SERVICE_DATE}`]);
    expect(h.budget.taken).toEqual(["browse"]);
    // Another date is another key.
    await h.svc.startTimes({ mappingId: "m-1", serviceDate: addDays(SERVICE_DATE, 1) });
    expect(h.calls).toHaveLength(2);
    // After the minute, a fresh read.
    h.clock.ms += START_TIMES_TTL_MS;
    await h.svc.startTimes({ mappingId: "m-1", serviceDate: SERVICE_DATE });
    expect(h.calls).toHaveLength(3);
    expect(h.budget.taken).toEqual(["browse", "browse", "browse"]);
  });

  it("never lists a start the offer does not list, even when a row names one", async () => {
    const h = harness(context(), { rows: (d) => [listedRow(d, 600), listedRow(d, 840)] });
    const r = await h.svc.startTimes({ mappingId: "m-1", serviceDate: SERVICE_DATE });
    expect(r.ok && r.times.map((t) => t.time)).toEqual(["10:00", "13:00", "16:00"]);
  });

  it("a fixed-slot offer is not_listed and reads nothing; an unapproved or removed offer is unknown", async () => {
    const fixed = harness(context(storedOffer()));
    expect(await fixed.svc.startTimes({ mappingId: "m-1", serviceDate: SERVICE_DATE })).toEqual({ ok: false, reason: "not_listed" });
    expect(fixed.calls).toEqual([]);
    const drifted = context();
    drifted.mapping.approvedOfferHash = "0".repeat(64);
    const h = harness(drifted);
    expect(await h.svc.startTimes({ mappingId: "m-1", serviceDate: SERVICE_DATE })).toEqual({ ok: false, reason: "availability_unknown" });
    expect(h.calls).toEqual([]);
    expect(await harness(null).svc.startTimes({ mappingId: "m-1", serviceDate: SERVICE_DATE })).toEqual({ ok: false, reason: "availability_unknown" });
  });

  it("without a browse budget taker it never calls the supplier", async () => {
    const h = harness(context(), { browse: false });
    expect(await h.svc.startTimes({ mappingId: "m-1", serviceDate: SERVICE_DATE })).toEqual({ ok: false, reason: "supplier_unavailable" });
    expect(h.calls).toEqual([]);
  });

  it("a refused refresh serves the last answer, labelled stale, within the stale window; then busy; a failing supplier is supplier_unavailable", async () => {
    const h = harness();
    await h.svc.startTimes({ mappingId: "m-1", serviceDate: SERVICE_DATE });
    h.clock.ms += START_TIMES_TTL_MS + 1;
    // The refresh is refused: the browse share of this window is spent.
    h.budget.window = { used: 0, quoteUsed: 0, browseUsed: READ_BUDGET.browseCap };
    const stale = await h.svc.startTimes({ mappingId: "m-1", serviceDate: SERVICE_DATE });
    expect(stale).toMatchObject({ ok: true, stale: true, checkedAt: NOW.toISOString() });
    h.clock.ms += START_TIMES_STALE_MS;
    expect(await h.svc.startTimes({ mappingId: "m-1", serviceDate: SERVICE_DATE })).toEqual({ ok: false, reason: "busy" });
    const down = harness(context(), { fail: true });
    expect(await down.svc.startTimes({ mappingId: "m-1", serviceDate: SERVICE_DATE })).toEqual({ ok: false, reason: "supplier_unavailable" });
  });

  it("browse-budget exhaustion falls back without blocking a quote: a flood of dates spends browse only, and the quote still reads", async () => {
    const h = harness();
    const answers = [];
    for (let i = 0; i < 40; i++) answers.push(await h.svc.startTimes({ mappingId: "m-1", serviceDate: addDays(SERVICE_DATE, i) }));
    expect(answers.filter((a) => a.ok)).toHaveLength(READ_BUDGET.browseCap!);
    expect(answers.slice(READ_BUDGET.browseCap!).every((a) => !a.ok && a.reason === "busy")).toBe(true);
    expect(h.budget.window).toMatchObject({ quoteUsed: 0, browseUsed: READ_BUDGET.browseCap });
    // The quote takes its own share and is answered from a fresh read.
    const q = await h.svc.quote(quoteInput);
    expect(q).toMatchObject({ ok: true, slotRef: "31@10:00" });
    expect(h.budget.taken.at(-1)).toBe("quote");
    // Every quote of the share is still available after the flood.
    let admitted = 1;
    for (let i = 0; i < 40; i++) if ((await h.svc.quote(quoteInput)).ok) admitted++;
    expect(admitted).toBe(READ_BUDGET.quoteCap);
  });

  it("stale slot: the page saw a start as open, it sold out since, and the quote refuses it as sold_out", async () => {
    let soldOut = false;
    const h = harness(context(), { rows: (d) => [listedRow(d, 600, soldOut ? { seatsLeft: 0, price: { isBookable: false } } : {})] });
    const page = await h.svc.startTimes({ mappingId: "m-1", serviceDate: SERVICE_DATE });
    expect(page.ok && page.times[0]).toEqual({ time: "10:00", status: "available" });
    soldOut = true;
    // The quote never uses the cached browse rows: it reads afresh and refuses.
    expect(await h.svc.quote(quoteInput)).toEqual({ ok: false, reason: "sold_out" });
    // The page's cached answer is unchanged until it expires; it was only ever indicative.
    const again = await h.svc.startTimes({ mappingId: "m-1", serviceDate: SERVICE_DATE });
    expect(again.ok && again.times[0].status).toBe("available");
  });

  it("the quote refuses a start outside the listed starts", async () => {
    const h = harness(context(), { rows: (d) => [listedRow(d, 600), listedRow(d, 840)] });
    expect(await h.svc.quote({ ...quoteInput, slotRef: "14:00" })).toEqual({ ok: false, reason: "invalid_slot" });
    expect(await h.svc.quote({ ...quoteInput, slotRef: "31@14:00" })).toEqual({ ok: false, reason: "invalid_slot" });
  });
});

describe("createStartTimesService: only listed-start offers with their flag on ask the supplier", () => {
  const listedPage = instantDoc({ timeSlots: ["10:00", "13:00", "16:00"] });
  const listedMapping = mapping({ anyTimeSlots: true, slotStartMinutes: [600, 780, 960], listedStartsSellable: true });

  function svc(opts: { mappings?: ReturnType<typeof mapping>[]; doc?: ReturnType<typeof instantDoc>; requested?: "instant" | "inquiry"; reader?: "ok" | "busy" | "none"; throws?: boolean } = {}) {
    const asked: unknown[] = [];
    let assessed = 0;
    const clock = { ms: NOW.getTime() };
    const s = createStartTimesService({
      readiness: {
        async assess(productId) {
          assessed++;
          if (opts.throws) throw new Error("connect ECONNREFUSED");
          const a = await assessReadiness({ product: product({ fulfilmentMode: opts.requested ?? "instant" }, opts.doc ?? listedPage), mappings: opts.mappings ?? [listedMapping], releaseEnabled: true, margin: fakeMargin() });
          return { ...a, result: { productId, requested: a.requested, effective: a.effective, reasons: a.reasons, readinessVersion: READINESS_RULES_VERSION, evaluatedAt: NOW.toISOString() } };
        },
      },
      reader:
        opts.reader === "none"
          ? null
          : {
              async startTimes(input) {
                asked.push(input);
                return opts.reader === "busy" ? { ok: false, reason: "busy" } : { ok: true, checkedAt: NOW.toISOString(), stale: false, times: [{ time: "10:00", status: "available" }] };
              },
            },
      now: () => new Date(clock.ms),
      nowMs: () => clock.ms,
    });
    return { s, asked, clock, get assessed() { return assessed; } };
  }
  const q = { productId: PRODUCT_ID, variantId: "shared", serviceDate: "2026-11-05" };

  it("an instant product whose offer sells as listed starts gets the supplier's times", async () => {
    const h = svc();
    expect(await h.s.startTimes(q)).toEqual({ source: "supplier", checkedAt: NOW.toISOString(), stale: false, times: [{ time: "10:00", status: "available" }] });
    expect(h.asked).toEqual([{ mappingId: listedMapping.mappingId, serviceDate: "2026-11-05" }]);
  });

  it("flag off, a fixed-slot offer, an inquiry product or an unknown variant: stored times, no supplier read", async () => {
    for (const h of [
      svc({ mappings: [{ ...listedMapping, listedStartsSellable: false }] }),
      svc({ mappings: [mapping()], doc: instantDoc() }),
      svc({ requested: "inquiry" }),
    ]) {
      expect(await h.s.startTimes(q)).toEqual({ source: "stored", reason: "not_listed" });
      expect(h.asked).toEqual([]);
    }
    const h = svc();
    expect(await h.s.startTimes({ ...q, variantId: "private" })).toEqual({ source: "stored", reason: "not_listed" });
  });

  it("a spent browse budget, no reader, a past date or a readiness failure fall back to the stored times", async () => {
    expect(await svc({ reader: "busy" }).s.startTimes(q)).toEqual({ source: "stored", reason: "busy" });
    expect(await svc({ reader: "none" }).s.startTimes(q)).toEqual({ source: "stored", reason: "unavailable" });
    expect(await svc().s.startTimes({ ...q, serviceDate: "2026-10-31" })).toEqual({ source: "stored", reason: "unavailable" });
    expect(await svc({ throws: true }).s.startTimes(q)).toEqual({ source: "stored", reason: "unavailable" });
  });

  it("reuses the product's readiness verdict for 30 seconds", async () => {
    const h = svc();
    await h.s.startTimes(q);
    await h.s.startTimes({ ...q, serviceDate: "2026-11-06" });
    expect(h.assessed).toBe(1);
    h.clock.ms += 30_000;
    await h.s.startTimes(q);
    expect(h.assessed).toBe(2);
  });
});

describe("GET /api/catalog/start-times query", async () => {
  const { startTimesQuerySchema } = await import("../../schemas/start-times.schemas");
  it("takes the product id, the variant id and a real date, and nothing else", () => {
    const ok = { productId: PRODUCT_ID, variantId: "shared", date: "2026-11-05" };
    expect(startTimesQuerySchema.parse(ok)).toEqual(ok);
    for (const bad of [
      { ...ok, productId: "slug-not-id" },
      { ...ok, variantId: "Shared Boat" },
      { ...ok, date: "2026-02-30" },
      { ...ok, date: "5 Nov" },
      { ...ok, phone: "x" },
      { productId: PRODUCT_ID, date: "2026-11-05" },
    ]) {
      expect(startTimesQuerySchema.safeParse(bad).success).toBe(false);
    }
  });
});
