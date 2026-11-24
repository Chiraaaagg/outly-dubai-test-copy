import { describe, expect, it, vi } from "vitest";
import type { SupplierQuoteInput } from "../../quotes/contracts";
import { admitRead, readLimits } from "../../suppliers/read-budget";
import { offerTermsHash, slotHoursOf } from "../../suppliers/traveldesk/traveldesk.offer-terms";
import { pickupHotels, row, SERVICE_DATE, storedOffer, storedSlot, storedTour, ticketStock } from "../../suppliers/__tests__/fixtures/traveldesk-terms";

/**
 * supplierQuoteService (SUP-14): what the service checks before it reads
 * TravelDesk, and that every quote is a fresh, budgeted read. The database
 * module is replaced and the dependencies are injected, so nothing here opens
 * a connection or a socket. Synthetic payloads and prices only.
 */

vi.mock("../../lib/db", () => ({ prisma: {}, TX_OPTIONS: {} }));
const fakeEnv = vi.hoisted(() => ({ value: {} as Record<string, unknown> }));
vi.mock("../../lib/env", () => ({ env: () => fakeEnv.value }));

const { createSupplierQuoteService, PICKUP_HOTELS_TTL_MS, supplierCheckAccountId } = await import("../supplier-quote.service");
type Deps = Parameters<typeof createSupplierQuoteService>[0];
type Context = NonNullable<Awaited<ReturnType<Deps["load"]>>>;

const NOW = new Date("2026-11-01T08:00:00Z");
const HASH = offerTermsHash(storedOffer(), storedTour())!;
/** An offer whose one slot stores no end, so the booked end is start plus `hours` (review 85 A1). */
const DERIVED = (hours: number) => storedOffer({ durationHours: hours, timeSlots: [storedSlot({ endMinutes: null })] });

function context(over: Partial<Context["mapping"]> = {}, rest: Partial<Omit<Context, "mapping">> = {}): Context {
  return {
    mapping: {
      id: "m-1",
      isActive: true,
      environment: "test",
      adapter: "traveldesk",
      supplierCode: "traveldesk",
      externalRef: { tourId: 3001, offerId: 501, bookingKind: "live_book", isExternal: false },
      approvedOfferHash: HASH,
      approvedSlotHours: slotHoursOf(rest.offer?.payload ?? storedOffer()),
      ...over,
    },
    offer: { payload: storedOffer(), removed: false },
    tour: { payload: storedTour(), removed: false },
    ...rest,
  };
}

function harness(
  ctx: Context | null,
  opts: { configured?: boolean; token?: boolean; fail?: boolean; hotelsFail?: boolean; hotels?: () => ReturnType<typeof pickupHotels>; rows?: () => ReturnType<typeof row>[] } = {},
) {
  const calls: string[] = [];
  const clock = { now: NOW };
  const source = {
    async getAvailability(offerId: number, from: string, to: string, o: { isExternal: boolean }) {
      calls.push(`availability:${offerId}:${from}:${to}:${o.isExternal}`);
      if (opts.fail) throw new Error("timeout");
      return { rows: opts.rows ? opts.rows() : [row()] };
    },
    async getTicketStock(offerId: number) {
      calls.push(`tickets:${offerId}`);
      return ticketStock();
    },
    async listPickupHotels(offerId: number) {
      calls.push(`hotels:${offerId}`);
      if (opts.hotelsFail) throw new Error("timeout");
      return (opts.hotels ?? pickupHotels)();
    },
  };
  const tokens: string[] = [];
  const svc = createSupplierQuoteService({
    load: async () => ctx,
    source: (environment) => (opts.configured === false ? null : { source, accountId: `acct-${environment}` }),
    takeQuoteReadToken: async (code, environment, account) => {
      tokens.push(`${code}:${environment}:${account}`);
      return opts.token !== false;
    },
    now: () => clock.now,
  });
  return { svc, calls, tokens, clock };
}

/** A mapping whose approved offer collects from hotels (not direct reporting). */
function collecting(): Context {
  const offer = storedOffer({ isDirectReporting: false });
  return context({ approvedOfferHash: offerTermsHash(offer, storedTour()) }, { offer: { payload: offer, removed: false } });
}

const input: SupplierQuoteInput = { mappingId: "m-1", serviceDate: SERVICE_DATE, slotRef: "21:00", supplierUnits: { adult: 2, child: 1 }, pickup: null };

describe("supplierQuoteService.quote (SUP-14)", () => {
  it("reads the exact date afresh on every call, through the read budget, and answers from the joined rules", async () => {
    const h = harness(context());
    const first = await h.svc.quote(input);
    expect(first).toMatchObject({ ok: true, slotRef: "11@21:00", netAedMinor: 26_000n, netUsdMinor: 7_000n, capacity: "limited", issuesTicketsAtConfirm: "unknown" });
    await h.svc.quote(input);
    // No cache: two quotes, two supplier reads, two tokens.
    expect(h.calls).toEqual([`availability:501:${SERVICE_DATE}:${SERVICE_DATE}:false`, `availability:501:${SERVICE_DATE}:${SERVICE_DATE}:false`]);
    expect(h.tokens).toEqual(["traveldesk:test:acct-test", "traveldesk:test:acct-test"]);
  });

  it("refuses before any supplier read when the mapping is not what was approved", async () => {
    const cases: Array<[Context | null, string]> = [
      [null, "availability_unknown"],
      [context({ isActive: false }), "availability_unknown"],
      [context({ environment: null }), "availability_unknown"],
      [context({ adapter: "manual" }), "availability_unknown"],
      [context({ externalRef: { offerId: 501 } }), "availability_unknown"],
      [context({ approvedOfferHash: null }), "availability_unknown"],
      [context({ approvedOfferHash: "0".repeat(64) }), "availability_unknown"],
      [context({}, { offer: { payload: storedOffer({ childAge: 8 }), removed: false } }), "availability_unknown"], // drifted terms
      [context({}, { offer: { payload: storedOffer(), removed: true } }), "availability_unknown"],
      [context({}, { tour: null }), "availability_unknown"],
      // Review 85 A1: the hours a derived end follows changed since the approval (same hash, hours compared on their own).
      [context({ approvedOfferHash: offerTermsHash(DERIVED(3), storedTour()), approvedSlotHours: 2 }, { offer: { payload: DERIVED(3), removed: false } }), "availability_unknown"],
      [context({ externalRef: { tourId: 3001, offerId: 501, bookingKind: "on_request", isExternal: false } }), "on_request"],
      [context({ externalRef: { tourId: 3001, offerId: 501, bookingKind: "unknown", isExternal: false } }), "availability_unknown"],
    ];
    for (const [ctx, reason] of cases) {
      const h = harness(ctx);
      expect(await h.svc.quote(input)).toEqual({ ok: false, reason });
      expect(h.calls).toEqual([]);
      expect(h.tokens).toEqual([]);
    }
  });

  it("a derived-end offer quotes while its hours are the approved ones (review 85 A1)", async () => {
    // 21:00 plus 2 hours: the row names the same end (review 85 A2).
    const h = harness(context({ approvedOfferHash: offerTermsHash(DERIVED(2), storedTour()), approvedSlotHours: 2 }, { offer: { payload: DERIVED(2), removed: false } }), { rows: () => [row({ endMinutes: 1380 })] });
    expect(await h.svc.quote(input)).toMatchObject({ ok: true, slotRef: "11@21:00" });
  });

  it("refuses unknown units and a hotel for a direct-reporting offer before reading", async () => {
    const cases: Array<[SupplierQuoteInput, string]> = [
      [{ ...input, supplierUnits: { adult: 1, senior: 1 } }, "unit_rule_failed"],
      [{ ...input, supplierUnits: { adult: 1, trip: 2 } }, "unit_rule_failed"],
      [{ ...input, pickup: { hotelRef: "h-1" } }, "pickup_unavailable"],
    ];
    for (const [bad, reason] of cases) {
      const h = harness(context());
      expect(await h.svc.quote(bad)).toEqual({ ok: false, reason });
      expect(h.calls).toEqual([]);
    }
  });

  it("an offer that collects from hotels needs a hotel: none is pickup_unavailable before any read", async () => {
    const h = harness(collecting());
    expect(await h.svc.quote(input)).toEqual({ ok: false, reason: "pickup_unavailable" });
    expect(h.calls).toEqual([]);
    expect(h.tokens).toEqual([]);
  });

  it("checks the hotel against the offer's list (GET /hotels/foroffer); a hotel not on it is pickup_unavailable without a price read", async () => {
    for (const hotelRef of ["999", "44", "123456789"]) {
      const h = harness(collecting());
      expect(await h.svc.quote({ ...input, pickup: { hotelRef } })).toEqual({ ok: false, reason: "pickup_unavailable" });
      expect(h.calls).toEqual(["hotels:501"]);
      expect(h.tokens).toEqual(["traveldesk:test:acct-test"]);
    }
  });

  it("a malformed hotel ref (a typed name, padded, signed, decimal, too long) is refused before any read (Batch 3)", async () => {
    for (const hotelRef of ["asdf", "042", "42.0", "-42", "+42", " 42", "4 2", "0", "1234567890", "Example Marina Hotel"]) {
      const h = harness(collecting());
      expect(await h.svc.quote({ ...input, pickup: { hotelRef } })).toEqual({ ok: false, reason: "pickup_unavailable" });
      expect(h.calls).toEqual([]);
      expect(h.tokens).toEqual([]);
    }
  });

  it("a listed hotel comes back with its name on the supplier's list, for the order item snapshot (Batch 3)", async () => {
    const h = harness(collecting());
    expect(await h.svc.quote({ ...input, pickup: { hotelRef: "43" } })).toMatchObject({ ok: true, pickupHotelName: "Example Creek Hotel" });
    // Without a pickup the field is not set at all.
    const self = harness(context());
    expect(await self.svc.quote(input)).not.toHaveProperty("pickupHotelName");
  });

  it("the snapshot name gets the list's collapse and 120-character cap, so it matches what the customer saw (B3-L10)", async () => {
    const messy = () => pickupHotels().map((x) => (x.hotelId === 43 ? { ...x, name: `  Example \n  Creek   ${"Hotel ".repeat(40)}` } : x));
    const h = harness(collecting(), { hotels: messy });
    const r = await h.svc.quote({ ...input, pickup: { hotelRef: "43" } });
    expect(r.ok && r.pickupHotelName).toMatch(/^Example Creek Hotel Hotel/);
    expect(r.ok && r.pickupHotelName && r.pickupHotelName.length).toBe(120);
  });

  it("a listed hotel is quoted; the hotel list alone is reused for a short time, seats and price never", async () => {
    const h = harness(collecting());
    const picked = { ...input, pickup: { hotelRef: "42" } };
    expect(await h.svc.quote(picked)).toMatchObject({ ok: true, slotRef: "11@21:00" });
    expect(await h.svc.quote({ ...input, pickup: { hotelRef: "43" } })).toMatchObject({ ok: true });
    const availability = `availability:501:${SERVICE_DATE}:${SERVICE_DATE}:false`;
    expect(h.calls).toEqual(["hotels:501", availability, availability]);
    expect(h.tokens).toHaveLength(3);

    h.clock.now = new Date(NOW.getTime() + PICKUP_HOTELS_TTL_MS);
    expect(await h.svc.quote(picked)).toMatchObject({ ok: true });
    expect(h.calls.slice(3)).toEqual(["hotels:501", availability]);
  });

  it("a failed or unbudgeted hotel read is supplier_unavailable and is not remembered", async () => {
    const failing = harness(collecting(), { hotelsFail: true });
    const picked = { ...input, pickup: { hotelRef: "42" } };
    expect(await failing.svc.quote(picked)).toEqual({ ok: false, reason: "supplier_unavailable" });
    expect(await failing.svc.quote(picked)).toEqual({ ok: false, reason: "supplier_unavailable" });
    expect(failing.calls).toEqual(["hotels:501", "hotels:501"]);
    const spent = harness(collecting(), { token: false });
    expect(await spent.svc.quote(picked)).toEqual({ ok: false, reason: "supplier_unavailable" });
    expect(spent.calls).toEqual([]);
  });

  it("is supplier_unavailable when TravelDesk is not configured for the mapping's environment, the budget is spent, or the read fails", async () => {
    const off = harness(context(), { configured: false });
    expect(await off.svc.quote(input)).toEqual({ ok: false, reason: "supplier_unavailable" });
    const spent = harness(context(), { token: false });
    expect(await spent.svc.quote(input)).toEqual({ ok: false, reason: "supplier_unavailable" });
    expect(spent.calls).toEqual([]);
    const failing = harness(context(), { fail: true });
    expect(await failing.svc.quote(input)).toEqual({ ok: false, reason: "supplier_unavailable" });
  });

  it("draws on the quote share only: once it is spent quotes refuse without reading, and engine reads still have their reserve (CR-B2-3)", async () => {
    const limits = readLimits(8, 0.25);
    let window = { used: 0, quoteUsed: 0 };
    const take = (cls: "engine" | "quote") => {
      const next = admitRead(window, cls, limits);
      if (next) window = next;
      return next !== null;
    };
    const calls: string[] = [];
    const svc = createSupplierQuoteService({
      load: async () => context(),
      source: () => ({
        source: {
          async getAvailability() {
            calls.push("availability");
            return { rows: [row()] };
          },
          async getTicketStock() {
            calls.push("tickets");
            return ticketStock();
          },
          async listPickupHotels() {
            calls.push("hotels");
            return pickupHotels();
          },
        },
        accountId: "acct-test",
      }),
      takeQuoteReadToken: async () => take("quote"),
      now: () => NOW,
    });
    expect(await svc.quote(input)).toMatchObject({ ok: true });
    expect(await svc.quote(input)).toMatchObject({ ok: true });
    expect(await svc.quote(input)).toEqual({ ok: false, reason: "supplier_unavailable" });
    expect(calls).toEqual(["availability", "availability"]);
    expect(window).toEqual({ used: 2, quoteUsed: 2 });
    for (let i = 0; i < limits.engineReserve; i++) expect(take("engine")).toBe(true);
    expect(take("engine")).toBe(false);
  });

  it("TicketOnly reads the stock; ticket evidence on the mapping sets issuesTicketsAtConfirm", async () => {
    const ticketOffer = storedOffer({ offerId: 502, bookingKind: "ticket_only", bookingTypeRaw: 2, timeSlots: [] });
    const ctx = context(
      {
        externalRef: { tourId: 3001, offerId: 502, bookingKind: "ticket_only", isExternal: false, ticketEvidence: { issuesTicketsAtConfirm: "yes", source: "sandbox drill", recordedAt: "2026-10-31" } },
        approvedOfferHash: offerTermsHash(ticketOffer, storedTour()),
      },
      { offer: { payload: ticketOffer, removed: false } },
    );
    const h = harness(ctx);
    expect(await h.svc.quote({ ...input, slotRef: null })).toMatchObject({ ok: true, slotRef: null, issuesTicketsAtConfirm: "yes" });
    expect(h.calls).toEqual(["tickets:502"]);
  });

  it("names the account a quote checks against, for readiness to record; none when TravelDesk is not configured for the environment", () => {
    // Synthetic key; nothing here opens a connection.
    const live = { SUPPLIER_ADAPTER_TRAVELDESK: "live", TRAVELDESK_ENV: "test", TRAVELDESK_API_BASE_URL: "https://testapi.traveldesk.me/public/b2b/v1", TRAVELDESK_API_KEY: "synthetic-key" };
    fakeEnv.value = {};
    expect(supplierCheckAccountId("test")).toBeNull();
    fakeEnv.value = live;
    expect(supplierCheckAccountId("test")).toBe("default");
    expect(supplierCheckAccountId("production")).toBeNull();
    fakeEnv.value = { ...live, TRAVELDESK_AGENCY_ID: "7001" };
    expect(supplierCheckAccountId("test")).toBe("7001");
    fakeEnv.value = {};
  });
});
