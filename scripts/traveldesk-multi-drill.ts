/**
 * TravelDesk MULTI-item SANDBOX drill (doc 22 §27 A5, §32.15, §32.20).
 *
 * How a multi-item instant order behaves against the real TravelDesk TEST
 * API, on the LOCAL disposable database, through the real booking engine:
 *
 *   LAT   reserve latency in sequence: 2, then 3, then 5 one-adult holds,
 *         each reserved only once the one before it is held (as the saga
 *         does), on the cheapest live-book offers of the synced catalogue,
 *         5+ days out (inside every chosen offer's 100% window). Records each
 *         reserve's latency, the time to all reserved, and the margin to the
 *         earliest hold's capture point (confirm send-by − CAPTURE_BUDGET_MS)
 *         and to the last-reserve point (that − ITEM_RESERVE_BUDGET_MS).
 *         Each batch is cancelled before the next.
 *   E2E   the real multi-item saga: a 3-item AED card order through the
 *         checkout service, the inbox, `createPaymentSaga` and the real
 *         engine seam (`createEngineSagaApi`), with the FAKE card-hold
 *         gateway (never Stripe) and the real TravelDesk TEST supplier.
 *         Worker runs are scheduled-style (`paid_only`, 270 s budget, the
 *         configured mutation timeout), as /api/jobs/supplier-worker runs
 *         them; the saga is also advanced after each run, as the payments
 *         tick would. Proves: reserve all → one capture → confirm each →
 *         `fulfilled`, one TravelDesk booking per item, the per-item
 *         allocations. Then every booking is cancelled (operator cancel,
 *         manual run) inside the 100% window.
 *   FAIL  the same 3-item order with item 2's reserve failing definitely.
 *         TravelDesk answers a bad request with 400/422, which the engine
 *         treats as an unknown outcome by design (only 401/403 is a
 *         documented definite refusal, Q-B7), so the 403 is injected in the
 *         transport for item 2 only (the LATE-B pattern): nothing is sent to
 *         TravelDesk for it. Proves item 1's hold is released (status 4 or
 *         expired), item 3 is never started, and the payment is voided with
 *         nothing captured.
 *
 *   DRY   pre-flight of the order path with no supplier call: checkout, the
 *         fake authorization and the saga's first `startAttempt` on the real
 *         catalogue; then the saga's release closes the never-sent attempt
 *         `not_created` and the payment is voided. Run it before E2E.
 *
 *   DRILL_ONLY=LAT,E2E,FAIL (default: those three, in that order) | DRY
 *   DRILL_PLAN=1 prints the offers, dates and slots each part would use, and exits.
 *   DRILL_DAYS=6 the first service date, days from today (Dubai); at least 5.
 *   DRILL_OFFERS=166,62 only these candidate offers, in this order.
 *
 *   NODE_OPTIONS=--conditions=react-server node --env-file=.env.test.local \
 *     --env-file=<TravelDesk TEST env file> node_modules/tsx/dist/cli.mjs scripts/traveldesk-multi-drill.ts
 *
 * Safety (the same guards as scripts/traveldesk-named-drills.ts):
 *  - Disposable database only (target guard, static and live checks).
 *  - TRAVELDESK_ENV=test and the test host only; bookings enabled in this
 *    process only. The production key file is never read.
 *  - One adult per booking, guest "OUTLY Sandbox Test", remarks marking a
 *    test (added in the drill transport: the saga path sends none), no phone,
 *    no email to TravelDesk.
 *  - Payments use the in-memory fake card gateway only.
 *  - Every booking is cancelled at the end; what stays open is printed as
 *    OPEN ON TRAVELDESK TEST.
 *  - Results go to .traveldesk-probe/multi-<timestamp>/ (git-ignored),
 *    without the key, voucher links, ticket codes or PII.
 */
import { createHash, randomBytes } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import type { Prisma as P } from "@prisma/client";
import { uuidv7 } from "../src/server/lib/ids";
import { TravelDeskBookingClient, type TravelDeskBooking } from "../src/server/suppliers/traveldesk/traveldesk.booking";
import { TravelDeskBookingAdapter, type TravelDeskBookingTransport } from "../src/server/suppliers/traveldesk/traveldesk.booking-adapter";
import { TravelDeskReadClient } from "../src/server/suppliers/traveldesk/traveldesk.client";
import { traveldeskConfigFrom, traveldeskConfigProblems, type TravelDeskConfig } from "../src/server/suppliers/traveldesk/traveldesk.config";
import { isTravelDeskApiError, TravelDeskApiError, type TravelDeskCallEvent } from "../src/server/suppliers/traveldesk/traveldesk.http";
import { withinChargeTolerance } from "../src/server/suppliers/traveldesk/traveldesk.confirmation";
import { slotRefOf } from "../src/server/suppliers/traveldesk/traveldesk.quote";
import { assertDisposableDbLive, assertDisposableTarget } from "./lib/target-guard";

function fail(message: string): never {
  console.error(`traveldesk-multi-drill: ${message}`);
  process.exit(2);
}

const dbUrl = process.env.DATABASE_URL;
if (!dbUrl) fail("DATABASE_URL missing (.env.test.local)");
let dbHost = "";
try {
  dbHost = new URL(dbUrl).hostname;
} catch {
  fail("DATABASE_URL is not a URL");
}
if (!["localhost", "127.0.0.1", "::1", "[::1]"].includes(dbHost)) fail(`refusing: DATABASE_URL host "${dbHost}" is not local`);
try {
  assertDisposableTarget({ allowTravelDeskTestKey: true });
} catch (e) {
  fail(e instanceof Error ? e.message : String(e));
}

const env = {
  APP_ENV: "development" as const,
  SUPPLIER_ADAPTER_TRAVELDESK: process.env.SUPPLIER_ADAPTER_TRAVELDESK as "mock" | "live" | undefined,
  TRAVELDESK_ENV: process.env.TRAVELDESK_ENV as "test" | "production" | undefined,
  TRAVELDESK_API_BASE_URL: process.env.TRAVELDESK_API_BASE_URL?.trim() || undefined,
  TRAVELDESK_API_KEY: process.env.TRAVELDESK_API_KEY?.trim() || undefined,
  TRAVELDESK_TIMEOUT_MS: Number(process.env.TRAVELDESK_TIMEOUT_MS ?? 150_000),
  TRAVELDESK_READ_TIMEOUT_MS: Number(process.env.TRAVELDESK_READ_TIMEOUT_MS ?? 30_000),
  // Enabled for this process only, after every other check passed.
  TRAVELDESK_BOOKINGS_ENABLED: true,
};
if (env.SUPPLIER_ADAPTER_TRAVELDESK !== "live") fail("the TravelDesk env file must set SUPPLIER_ADAPTER_TRAVELDESK=live");
if (env.TRAVELDESK_ENV !== "test") fail("sandbox drills run against TRAVELDESK_ENV=test only");
const problems = traveldeskConfigProblems(env);
if (problems.length) fail(`configuration refused:\n  - ${problems.join("\n  - ")}`);
const config = traveldeskConfigFrom(env) as TravelDeskConfig;
if (config.environment !== "test" || config.host !== "testapi.traveldesk.me" || !config.bookingsEnabled) fail("refusing: not a test-environment booking configuration");

const KNOWN = ["DRY", "LAT", "E2E", "FAIL"];
const ONLY = (process.env.DRILL_ONLY ?? "LAT,E2E,FAIL").split(",").map((s) => s.trim()).filter(Boolean);
for (const d of ONLY) if (!KNOWN.includes(d)) fail(`unknown part ${d}`);
const PLAN = process.env.DRILL_PLAN === "1";
const FIRST_DAY = Number(process.env.DRILL_DAYS ?? 6);
if (!Number.isInteger(FIRST_DAY) || FIRST_DAY < 5) fail("DRILL_DAYS must be an integer of at least 5 (inside the full-refund window)");
const DAYS = [0, 1, 2, 3, 4].map((d) => FIRST_DAY + d);
const LAT_SIZES = (process.env.DRILL_LAT_SIZES ?? "2,3,5").split(",").map(Number);
const RUN = uuidv7().slice(-6).toUpperCase();
const outDir = path.join(".traveldesk-probe", `multi-${new Date().toISOString().replace(/[:.]/g, "-")}`);
const GUEST = "OUTLY Sandbox Test";
const REMARKS = "OUTLY integration sandbox test - automated, will be cancelled. Please ignore.";
/** The scheduled worker's budget (/api/jobs/supplier-worker: maxDuration 300 s − 30 s). */
const WORKER_BUDGET_MS = 270_000;

function dubaiDate(offsetDays: number): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Dubai", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date(Date.now() + offsetDays * 86_400_000));
}
const iso = (ms: number) => new Date(ms).toISOString();
const sleep = (ms: number) => new Promise((res) => setTimeout(res, Math.max(0, ms)));
const json = (v: unknown) => JSON.stringify(v, (_k, x) => (typeof x === "bigint" ? x.toString() : x), 2);
const stats = (xs: number[]) => {
  const s = [...xs].sort((a, b) => a - b);
  const median = s.length ? (s.length % 2 ? s[(s.length - 1) / 2] : (s[s.length / 2 - 1] + s[s.length / 2]) / 2) : null;
  return { n: s.length, min: s[0] ?? null, median, max: s[s.length - 1] ?? null };
};

let current = "setup";
const calls: (TravelDeskCallEvent & { part: string; at: string })[] = [];
const observations: { part: string; at: string; what: string; data: unknown }[] = [];
function observe(what: string, data: unknown) {
  observations.push({ part: current, at: new Date().toISOString(), what, data });
  console.log(`  [${current}] ${what}: ${json(data).replace(/\s+/g, " ").slice(0, 400)}`);
}
function errorSummary(e: unknown) {
  if (isTravelDeskApiError(e)) return { kind: e.kind, status: e.status, reason: e.reason ?? null, fieldErrors: e.fieldErrors?.map((f) => f.fieldName) ?? null };
  return { kind: "internal", message: e instanceof Error ? e.message.slice(0, 200) : "error" };
}

async function main() {
  const { prisma } = await import("../src/server/lib/db");
  await assertDisposableDbLive(prisma, { allowTravelDeskTestKey: true });
  const { supplierBookingService: svc, bookingAccountId } = await import("../src/server/services/supplier-booking.service");
  const { createEngineSagaApi } = await import("../src/server/services/engine-saga.service");
  const { createPaymentSaga, dbBookingStateReader, CAPTURE_BUDGET_MS, ITEM_RESERVE_BUDGET_MS } = await import("../src/server/payments/saga");
  const { createPaymentInbox } = await import("../src/server/payments/inbox");
  const { createGatewayRegistry } = await import("../src/server/payments/registry");
  const { createCheckoutService } = await import("../src/server/payments/checkout.service");
  const { paymentEvidenceFrom } = await import("../src/server/payments/evidence");
  const { FakeAedCardGateway } = await import("../src/server/payments/fake-gateways");
  const { itemPayableMinor } = await import("../src/server/services/order.service");
  const { contactHash, normaliseContact } = await import("../src/server/services/contact-verification.service");
  mkdirSync(outDir, { recursive: true });

  const accountId = bookingAccountId("test", config.agencyId ?? null);
  if (!accountId) fail("no supplier account for the test environment");
  const adapters: TravelDeskBookingAdapter[] = [];
  const onEvent = (e: TravelDeskCallEvent) => {
    calls.push({ ...e, part: current, at: new Date().toISOString() });
    for (const a of adapters) a.noteCall(e);
  };
  const read = new TravelDeskReadClient(config, { onEvent });
  /**
   * Diagnostics only: an error answered as an HTML page (the HTTP layer keeps only its first characters, the
   * doctype) is recorded by its title and headings, tags stripped, at most 300 characters. Never a body of a
   * successful answer, never request data.
   */
  const diagnosingFetch: typeof fetch = async (input, init) => {
    const res = await fetch(input, init);
    if (res.status >= 400) {
      const text = await res.clone().text();
      const html = /<html/i.test(text);
      const pick = html ? [...text.matchAll(/<(title|h1|h2|h3|fieldset)[^>]*>([\s\S]*?)<\/\1>/gi)].map((m) => m[2].replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim()).filter(Boolean) : [];
      observe("http.error_page", { status: res.status, contentType: res.headers.get("content-type"), html, bytes: text.length, text: pick.join(" | ").slice(0, 400) });
    }
    return res;
  };
  const client = new TravelDeskBookingClient(config, { onEvent, fetch: diagnosingFetch });

  /** Reserve bodies whose item must fail definitely (FAIL): the order item's client reference. */
  const failRefs = new Set<string>();
  /**
   * The client with test remarks added to every reserve (the saga path sends none), the field names of
   * each reserve body recorded (never values: proof that no phone or email goes out), every mutation's
   * answer and error recorded, and FAIL's injected definite refusal. Nothing else changes.
   */
  function drillTransport(c: TravelDeskBookingClient): TravelDeskBookingTransport {
    async function rec<R>(op: string, fn: () => Promise<R>): Promise<R> {
      try {
        const r = await fn();
        if (r && typeof r === "object" && "supplierBookingId" in r) {
          const b = r as unknown as TravelDeskBooking;
          observe(`${op}.answer`, { id: b.supplierBookingId, status: b.status, reservationTimeout: b.reservationTimeout, reservationDeadline: b.reservationDeadline });
        } else if (op === "cancel") observe("cancel.answer", r);
        return r;
      } catch (e) {
        observe(`${op}.error`, errorSummary(e));
        throw e;
      }
    }
    return {
      reserve: (body) =>
        rec("reserve", async () => {
          const b = body as Record<string, unknown>;
          const withRemarks: Record<string, unknown> = { ...b, remarks: typeof b.remarks === "string" && b.remarks ? b.remarks : REMARKS };
          observe("reserve.body_fields", { fields: Object.keys(withRemarks).sort(), guestName: withRemarks.guestName === GUEST, adults: withRemarks.adults, children: withRemarks.children, infants: withRemarks.infants });
          if (failRefs.has(String(b.referenceNumber))) {
            observe("fault_injected", { as: "403 auth (documented definite refusal)", sentToTravelDesk: false });
            throw new TravelDeskApiError("auth", "bookings.reserve", { status: 403 });
          }
          return c.reserve(withRemarks);
        }),
      confirm: (id) => rec("confirm", () => c.confirm(id)),
      create: (b) => rec("create", () => c.create({ ...b, remarks: REMARKS })),
      cancel: (id) => rec("cancel", () => c.cancel(id)),
      getReservation: (id) => c.getReservation(id),
      listBookingsPage: (q, p, n) => c.listBookingsPage(q, p, n),
      getBalance: () => c.getBalance(),
    };
  }
  const adapter = new TravelDeskBookingAdapter(drillTransport(client), { environment: "test" });
  adapters.push(adapter);

  const supplier = await prisma.supplier.findUnique({ where: { code: "traveldesk" } });
  if (!supplier) fail('no local supplier row "traveldesk" — run the local catalogue sync first');

  /* ----------------------------------------------------- offers and slots */
  type Policy = { moreThanHours: number; refundPercent: number }[];
  const tours = await prisma.supplierCatalogueItem.findMany({ where: { supplierId: supplier.id, environment: "test", kind: "tour", removedAt: null } });
  const fullRefundHours = new Map<string, number | null>();
  for (const t of tours) {
    const policy = ((t.payload as { cancellationPolicy?: Policy } | null)?.cancellationPolicy ?? []).filter((p) => p.refundPercent >= 100);
    fullRefundHours.set(t.externalId, policy.length ? Math.max(...policy.map((p) => p.moreThanHours)) : null);
  }
  type StoredPrice = { price?: { perAdultMinor?: string; isBookable?: boolean } };
  const offerRows = await prisma.supplierCatalogueItem.findMany({ where: { supplierId: supplier.id, environment: "test", kind: "offer", bookingKind: "live_book", removedAt: null } });
  /** Sharing per-adult live-book offers whose tour has a 100% tier that the first date is inside (with a day to spare), cheapest stored per-adult net first. */
  const candidates = offerRows
    .map((o) => {
      const p = o.payload as { offerId: number; tourId: number; privateType?: string; minPax?: number; isExternal?: boolean; isDirectReporting?: boolean; pricingPeriods?: StoredPrice[] };
      const nets = (p.pricingPeriods ?? []).map((x) => BigInt(x.price?.perAdultMinor ?? "0")).filter((n) => n > 0n);
      const cheapest = nets.length ? nets.reduce((a, b) => (a < b ? a : b)) : null;
      return { offerId: p.offerId, tourId: p.tourId, sharing: p.privateType === "sharing", minPax: p.minPax ?? 1, isExternal: p.isExternal === true, directReporting: p.isDirectReporting === true, cheapest, fullRefundHours: fullRefundHours.get(String(p.tourId)) ?? null };
    })
    .filter((o) => o.sharing && o.minPax <= 1 && !o.isExternal && o.cheapest !== null && o.fullRefundHours !== null && o.fullRefundHours + 24 <= FIRST_DAY * 24)
    .sort((a, b) => (a.cheapest! < b.cheapest! ? -1 : a.cheapest! > b.cheapest! ? 1 : a.offerId - b.offerId));
  // DRILL_OFFERS=166,62 keeps only these offers, in this order (e.g. when one offer's booking backend is down).
  const pinned = (process.env.DRILL_OFFERS ?? "").split(",").map((x) => Number(x.trim())).filter((x) => x > 0);
  if (pinned.length) candidates.splice(0, candidates.length, ...pinned.flatMap((id) => candidates.filter((c) => c.offerId === id)));
  // Offers TravelDesk TEST has charged off the requested total before (charged ≠ expected net beyond the shared ±1 fil):
  // the engine holds every such reservation for a human (SUP-1/SUP-24), so a saga drill on them measures that, not the
  // saga. Left out unless pinned; the finding is reported (drill of 4 Nov 2026: offers 166 and 45, pickup offers).
  if (!pinned.length) {
    const priorCharges = await prisma.supplierBooking.findMany({ where: { supplierId: supplier.id, environment: "test", chargedNetMinor: { not: null } }, select: { offerExternalId: true, chargedNetMinor: true, expectedNetMinor: true } });
    const offCharge = new Set(priorCharges.filter((b) => !withinChargeTolerance(b.chargedNetMinor!, b.expectedNetMinor)).map((b) => Number(b.offerExternalId)));
    if (offCharge.size) {
      observe("excluded.charged_off_quote", { offerIds: [...offCharge].sort((a, b) => a - b) });
      candidates.splice(0, candidates.length, ...candidates.filter((c) => !offCharge.has(c.offerId)));
    }
  }
  if (!candidates.length) fail("no sharing live-book offer with a 100% tier in the synced catalogue");

  type Row = Awaited<ReturnType<typeof read.getAvailability>>["rows"][number] & { price: NonNullable<Awaited<ReturnType<typeof read.getAvailability>>["rows"][number]["price"]> };
  type Slot = { offerId: number; tourId: number; date: string; row: Row; hotelId: number | null };
  /**
   * The pickup hotel an offer needs: none when the guest reports directly; otherwise the lowest hotel id
   * TravelDesk lists for the offer (TravelDesk answers 422 HotelId without one). One read per offer.
   */
  const hotels = new Map<number, number | null | "none">();
  async function hotelFor(c: (typeof candidates)[number]): Promise<number | null | "none"> {
    if (c.directReporting) return null;
    if (!hotels.has(c.offerId)) {
      try {
        const list = await read.listPickupHotels(c.offerId);
        hotels.set(c.offerId, list.length ? Math.min(...list.map((h) => h.hotelId)) : "none");
      } catch (e) {
        observe("hotels.error", { offerId: c.offerId, ...errorSummary(e) });
        hotels.set(c.offerId, "none");
      }
    }
    return hotels.get(c.offerId)!;
  }
  /** One availability read per offer over every drill date (engine lane, no hammering). */
  const availability = new Map<number, Row[]>();
  async function rowsOf(offerId: number): Promise<Row[]> {
    if (!availability.has(offerId)) {
      try {
        const a = await read.getAvailability(offerId, dubaiDate(DAYS[0]), dubaiDate(DAYS[DAYS.length - 1]), { isExternal: false });
        availability.set(offerId, a.rows.filter((r): r is Row => r.seatsLeft > 2 && Boolean(r.price?.isBookable) && (r.price?.perAdultMinor ?? 0n) > 0n));
      } catch (e) {
        observe("availability.error", { offerId, ...errorSummary(e) });
        availability.set(offerId, []);
      }
    }
    return availability.get(offerId)!;
  }
  /** `n` slots on the cheapest offers, one per (offer, date): offers first, then dates, as a cart of different activities would. */
  async function slots(n: number): Promise<Slot[]> {
    const out: Slot[] = [];
    for (const date of DAYS.map(dubaiDate)) {
      for (const c of candidates) {
        if (out.length >= n) return out;
        const row = (await rowsOf(c.offerId)).filter((r) => r.date === date).sort((a, b) => (a.price.perAdultMinor < b.price.perAdultMinor ? -1 : 1))[0];
        if (!row) continue;
        const hotelId = await hotelFor(c);
        if (hotelId !== "none") out.push({ offerId: c.offerId, tourId: c.tourId, date, row, hotelId });
      }
    }
    if (out.length < n) throw new Error(`only ${out.length} bookable (offer, date) slots found for ${n} items`);
    return out;
  }
  const slotView = (s: Slot) => ({ offerId: s.offerId, tourId: s.tourId, date: s.date, slot: slotRefOf(s.row.timeSlotId, s.row.startMinutes), pickupHotelId: s.hotelId, perAdultMinor: s.row.price.perAdultMinor });

  /* ---------------------------------------------------------- engine runs */
  type DrillBooking = { name: string; id: string; part: string };
  const booked: DrillBooking[] = [];
  const payments = paymentEvidenceFrom(prisma);
  // The order's saga, set once wired; the engine tells it after every committed change of an order-item attempt.
  let sagaRef: ReturnType<typeof createPaymentSaga> | null = null;
  const notifier = { bookingChanged: async (i: string, s: string) => (sagaRef ? sagaRef.notifier.bookingChanged(i, s) : undefined) };
  const workerDeps = (mutations: true | "paid_only", a = adapter) => ({
    adapter: a,
    environment: "test" as const,
    supplierCode: "traveldesk",
    accountId,
    mutationTimeoutMs: config.mutationTimeoutMs,
    holder: `multi-${RUN}`,
    mutations,
    payments,
    paymentsInTx: paymentEvidenceFrom,
    saga: notifier,
  });
  async function work(label: string, mutations: true | "paid_only", maxJobs?: number) {
    const r = await svc.runDueJobs(workerDeps(mutations), { budgetMs: WORKER_BUDGET_MS, maxJobs });
    for (const p of r.processed) console.log(`  [${label}] ${p.kind}: ${p.outcome}`);
    return r.processed;
  }
  const stateOf = async (id: string) => (await prisma.supplierBooking.findUniqueOrThrow({ where: { id } })).state;
  /** Manual runs until these bookings have no job due in the next 45 s. */
  async function runUntilQuiet(label: string, ids: string[], maxMs: number) {
    const end = Date.now() + maxMs;
    while (Date.now() < end) {
      const processed = await work(label, true);
      const due = await prisma.supplierJob.count({ where: { supplierBookingId: { in: ids }, status: { in: ["queued", "running"] }, runAfter: { lte: new Date(Date.now() + 45_000) } } });
      if (due === 0) return true;
      if (processed.length === 0) await sleep(5_000);
    }
    return false;
  }
  async function cancelAndSettle(ids: string[], label: string) {
    for (const id of ids) {
      const b = await prisma.supplierBooking.findUniqueOrThrow({ where: { id } });
      if (["reserved", "awaiting_payment", "confirmed", "awaiting_external"].includes(b.state)) await svc.requestCancel(id).catch((e) => observe("requestCancel.refused", { id, message: String(e) }));
    }
    await runUntilQuiet(label, ids, 6 * 60_000);
  }
  async function eventsOf(id: string) {
    return prisma.supplierBookingEvent.findMany({ where: { supplierBookingId: id }, orderBy: { at: "asc" } });
  }
  /** The reserve's own timings from the engine's events: request sent, response duration, HTTP status. */
  async function reserveTiming(id: string) {
    const ev = await eventsOf(id);
    const sent = ev.find((e) => e.kind === "request_sent" && e.operation === "bookings.reserve");
    const resp = ev.find((e) => e.kind === "response" && e.operation === "bookings.reserve");
    return { sentAt: sent?.at ?? null, responseMs: resp?.durationMs ?? null, httpStatus: resp?.httpStatus ?? null };
  }
  async function bookingResult(d: DrillBooking) {
    const b = await prisma.supplierBooking.findUniqueOrThrow({ where: { id: d.id } });
    const events = await eventsOf(d.id);
    return {
      name: d.name,
      part: d.part,
      clientRef: b.clientRef,
      orderItemId: b.orderItemId,
      state: b.state,
      supplierBookingId: b.supplierBookingId,
      supplierStatusCode: b.supplierStatusCode,
      serviceDate: b.serviceDate,
      offerExternalId: b.offerExternalId,
      expectedNetMinor: b.expectedNetMinor,
      chargedNetMinor: b.chargedNetMinor,
      refundMinor: b.refundMinor,
      errorCode: b.errorCode,
      attentionRequiredAt: b.attentionRequiredAt,
      reservationDeadline: b.reservationDeadline,
      reservedAt: b.reservedAt,
      confirmedAt: b.confirmedAt,
      cancelledAt: b.cancelledAt,
      closedAt: b.closedAt,
      events: events.map((e) => ({ at: e.at, kind: e.kind, operation: e.operation, httpStatus: e.httpStatus, durationMs: e.durationMs, from: e.fromState, to: e.toState, detail: e.detail })),
    };
  }
  const verdicts: { part: string; result: "pass" | "fail" | "observed" | "skipped"; summary: string }[] = [];
  const verdict = (result: "pass" | "fail" | "observed" | "skipped", summary: string) => {
    verdicts.push({ part: current, result, summary });
    console.log(`  [${current}] ${result.toUpperCase()}: ${summary}`);
  };
  const measures: Record<string, unknown> = {};
  async function writeOut(extra: Record<string, unknown> = {}) {
    const results = [];
    for (const d of booked) results.push(await bookingResult(d));
    writeFileSync(path.join(outDir, "results.json"), json({ run: RUN, only: ONLY, days: DAYS, config: { mutationTimeoutMs: config.mutationTimeoutMs, CAPTURE_BUDGET_MS, ITEM_RESERVE_BUDGET_MS, WORKER_BUDGET_MS }, verdicts, measures, observations, results, calls, ...extra }));
  }
  async function balance(label: string) {
    const b = await read.getBalance();
    const v = { balance: b.balanceMinor, credit: b.creditFacilityMinor, payable: b.payableBalanceMinor };
    observe(`balance.${label}`, v);
    return v;
  }

  /* ---------------------------------------------------------------- plan */
  if (PLAN) {
    current = "plan";
    observe("candidates", candidates.map((c) => ({ offerId: c.offerId, tourId: c.tourId, fullRefundHours: c.fullRefundHours })));
    if (ONLY.includes("LAT")) observe("LAT", (await slots(Math.max(...LAT_SIZES))).map(slotView));
    if (ONLY.includes("E2E") || ONLY.includes("FAIL")) observe("E2E/FAIL", (await slots(3)).map(slotView));
    await prisma.$disconnect();
    return;
  }

  /* --------------------------------------------- the order path (fakes) */
  const now = () => new Date();
  const aed = new FakeAedCardGateway({ now });
  /** This order's own calls on the shared fake gateway (its keys end with the payment id): the gateway serves every part. */
  const callsFor = (op: "capture" | "void", paymentId: string) => aed.callsOf(op).filter((args) => String(args[args.length - 1]).endsWith(paymentId));
  const gateways = createGatewayRegistry([aed], { production: false });
  const engineApi = createEngineSagaApi({ config: () => ({ environment: "test", agencyId: config.agencyId ?? null, mutationTimeoutMs: config.mutationTimeoutMs }), payments, saga: notifier, supplierCode: "traveldesk", now });
  const saga = createPaymentSaga({ gateways, engine: engineApi, bookings: dbBookingStateReader, now });
  sagaRef = saga;
  const inbox = createPaymentInbox({ gateways, saga, now });
  const checkout = createCheckoutService({
    gateways,
    releaseEnabled: () => true,
    readiness: { evaluate: async (productId) => ({ productId, requested: "instant", effective: "instant", reasons: [], readinessVersion: 3, evaluatedAt: now().toISOString() }) },
    salesOpen: async () => true,
    admission: async () => true,
    exposureLimits: async () => ({ maxUncapturedHolds: 1_000_000, maxRiskyPaymentsPer15Min: 1_000_000, outlyFundedWindowDays: 30, outlyFundedCapMinor: { INR: 1_000_000_000, AED: 1_000_000_000 }, maxInstantOrderAedMinor: 1_000_000_000 }),
    // AED orders only: no FX row is read.
    fxInrPerAed: async () => null,
    now,
  });
  const products: string[] = [];
  const mappings: string[] = [];
  const PHONE = "+971501234567"; // synthetic; local verification only, never sent to TravelDesk

  /**
   * An active AED quote whose lines are mapped to real TravelDesk TEST offers (one adult, the exact slot,
   * the live net), with synthetic charged amounts (fake gateway): line i charges 11_000 + i × 1_000 fils,
   * less 1_500 discount, plus 500 tax, so the allocations are 10_000, 11_000, 12_000.
   */
  async function quoteFor(label: string, chosen: Slot[]) {
    const t = now();
    const guest = await prisma.guestSession.create({ data: { id: uuidv7(), tokenHash: createHash("sha256").update(randomBytes(16)).digest("hex"), expiresAt: new Date(t.getTime() + 86_400_000) } });
    const lines: Record<string, unknown>[] = [];
    let total = 0n;
    for (const [i, s] of chosen.entries()) {
      const product = await prisma.product.create({
        data: {
          id: uuidv7(),
          slug: `zz-multi-${RUN}-${label.toLowerCase()}-${i + 1}`,
          title: `zz-multi sandbox item ${i + 1}`,
          tier: "A",
          categorySlug: "zz-multi",
          confirmation: "instant",
          status: "draft",
          fulfilmentMode: "instant",
          durationMinutes: 120,
          content: { variants: [{ id: "v1", name: "Standard" }], freeCancellationHours: 0 },
        },
      });
      products.push(product.id);
      const hash = createHash("sha256").update(`zz-multi:${RUN}:${s.offerId}`).digest("hex");
      const mapping = await prisma.productSupplierMapping.create({
        data: {
          id: uuidv7(),
          productId: product.id,
          supplierId: supplier!.id,
          externalRef: { tourId: s.tourId, offerId: s.offerId, bookingKind: "live_book", isExternal: false },
          supplierProductId: String(s.tourId),
          supplierOfferId: String(s.offerId),
          bookingKind: "live_book",
          environment: "test",
          syncStatus: "ok",
          approvedOfferHash: hash,
        },
      });
      mappings.push(mapping.id);
      const charged = 11_000n + BigInt(i) * 1_000n;
      total += charged - 1_500n + 500n;
      lines.push({
        index: i,
        productId: product.id,
        productVersion: 1,
        variantId: "v1",
        mappingId: mapping.id,
        approvedOfferHash: hash,
        supplierEnvironment: "test",
        readinessRulesVersion: 3,
        serviceDate: s.date,
        slotRef: slotRefOf(s.row.timeSlotId, s.row.startMinutes),
        units: { adult: 1 },
        unitDefinitions: [{ unitId: "adult", label: "Adult", per: "person", ageMin: null, ageMax: null, residency: "any", heightMinCm: null, heightMaxCm: null, seatConsuming: true, minQty: 1, maxQty: 9, price: { inr: 1, aed: 1 }, supplierUnit: "adult" }],
        addonIds: [],
        pickup: s.hotelId ? { hotelRef: String(s.hotelId) } : null,
        chargedMinor: charged.toString(),
        discountAllocMinor: "1500",
        taxAllocMinor: "500",
        supplierNetAedMinor: s.row.price.perAdultMinor.toString(),
        supplierNetUsdMinor: s.row.price.perAdultUsdMinor.toString(),
        supplierCheckedAt: t.toISOString(),
        margin: { policyVersion: 1, floorBps: 1500, grossMarginBps: 3000, costLines: [] },
        freeCancellationUntilUtc: null,
        nonRefundableAfterConfirm: true,
        supplierAccountId: null,
        couponVersion: null,
      });
    }
    const quoteId = uuidv7();
    await prisma.quote.create({
      data: {
        id: quoteId,
        fingerprint: createHash("sha256").update(quoteId).digest("hex"),
        ownerKind: "guest",
        guestSessionId: guest.id,
        currency: "AED",
        totalMinor: total,
        lines: lines as unknown as P.InputJsonValue,
        request: { lines: [], currency: "AED", couponCode: null },
        status: "active",
        createdAt: t,
        expiresAt: new Date(t.getTime() + 20 * 60_000),
      },
    });
    const v = await prisma.orderContactVerification.create({ data: { id: uuidv7(), quoteId, channel: "phone", contactHash: contactHash(normaliseContact("phone", PHONE)!), method: "otp_sms", verifiedAt: t } });
    return { quoteId, verificationId: v.id, guestSessionId: guest.id, totalMinor: total };
  }

  /** Checkout, pay on the fake hosted page, deliver `payment.authorized` through the inbox: the saga starts item 1. */
  async function soldAndAuthorized(label: string, chosen: Slot[]) {
    const q = await quoteFor(label, chosen);
    const r = await checkout.start({
      owner: { kind: "guest", guestSessionId: q.guestSessionId },
      quoteId: q.quoteId,
      verificationId: q.verificationId,
      method: "card",
      traveller: { fullName: GUEST, phoneE164: PHONE, email: null },
      returnUrl: "http://localhost:3000/checkout/return",
      ip: null,
    });
    if (!r.ok) throw new Error(`${label}: checkout refused: ${r.reason}`);
    const s = await prisma.paymentSaga.findUniqueOrThrow({ where: { orderId: r.orderId }, include: { payment: true } });
    const items = await prisma.orderItem.findMany({ where: { orderId: r.orderId }, orderBy: { quoteLineIndex: "asc" } });
    const pid = aed.pay(s.payment!.providerOrderId!);
    const w = aed.webhook("payment.authorized", pid);
    const t0 = Date.now();
    const got = await inbox.receive(aed.provider, w.raw, w.headers);
    if (got.result === "stored") await inbox.processOne(got.id);
    observe("authorized", { orderId: r.orderId, sagaId: s.id, items: items.length, totalMinor: q.totalMinor, sagaState: (await prisma.paymentSaga.findUniqueOrThrow({ where: { id: s.id } })).state });
    return { orderId: r.orderId, sagaId: s.id, paymentId: s.paymentId!, pid, itemIds: items.map((i) => i.id), t0 };
  }

  async function itemBookings(itemIds: string[]) {
    const out: ({ id: string; state: string; supplierBookingId: string | null; clientRef: string } | null)[] = [];
    for (const id of itemIds) {
      const b = await prisma.supplierBooking.findFirst({ where: { orderItemId: id }, orderBy: [{ attempt: "desc" }, { createdAt: "desc" }] });
      out.push(b ? { id: b.id, state: b.state, supplierBookingId: b.supplierBookingId, clientRef: b.clientRef } : null);
    }
    return out;
  }
  function track(label: string, itemIds: string[], bs: Awaited<ReturnType<typeof itemBookings>>) {
    for (const [i, b] of bs.entries()) if (b && !booked.some((x) => x.id === b.id)) booked.push({ name: `${label}-item${i + 1}`, id: b.id, part: current });
    void itemIds;
  }

  /** Scheduled-style worker runs, the saga advanced after each (the payments tick), until `done` or the time runs out. */
  async function drive(label: string, o: Awaited<ReturnType<typeof soldAndAuthorized>>, done: (state: string) => boolean, maxMs: number, mutations: true | "paid_only" = "paid_only") {
    const end = Date.now() + maxMs;
    const seen: { at: string; saga: string; items: string[] }[] = [];
    let last = "";
    while (Date.now() < end) {
      const processed = await work(label, mutations);
      await saga.advance(o.sagaId);
      const s = (await prisma.paymentSaga.findUniqueOrThrow({ where: { id: o.sagaId } })).state;
      const bs = await itemBookings(o.itemIds);
      track(label, o.itemIds, bs);
      const key = `${s}|${bs.map((b) => b?.state ?? "-").join(",")}`;
      if (key !== last) {
        seen.push({ at: new Date().toISOString(), saga: s, items: bs.map((b) => b?.state ?? "-") });
        observe("progress", { saga: s, items: bs.map((b) => b?.state ?? "-") });
        last = key;
      }
      if (done(s)) return { state: s, seen };
      if (processed.length === 0) await sleep(5_000);
    }
    return { state: (await prisma.paymentSaga.findUniqueOrThrow({ where: { id: o.sagaId } })).state, seen };
  }

  current = "setup";
  const balanceStart = await balance("start");
  let failure: unknown = null;

  try {
    /* ------------------------------------------------- LAT: reserve latency */
    if (ONLY.includes("LAT")) {
      current = "LAT";
      const all: number[] = [];
      const allHttp: number[] = [];
      const batches: Record<string, unknown>[] = [];
      for (const n of LAT_SIZES) {
        const chosen = await slots(n);
        const ids: string[] = [];
        const items: Record<string, unknown>[] = [];
        const tStart = Date.now();
        for (const [i, s] of chosen.entries()) {
          const t0 = Date.now();
          const b = await svc.createIntent(
            null,
            {
              environment: "test",
              bookingKind: "live_book",
              tourId: s.tourId,
              offerId: s.offerId,
              serviceDate: s.date,
              slot: { timeSlotId: s.row.timeSlotId, startMinutes: s.row.startMinutes, endMinutes: s.row.endMinutes },
              adults: 1,
              children: 0,
              infants: 0,
              hotelId: s.hotelId,
              guestName: GUEST,
              remarks: REMARKS,
              expectedNetMinor: s.row.price.perAdultMinor,
              expectedNetUsdMinor: s.row.price.perAdultUsdMinor,
              idempotencyKey: `multi-${RUN}-LAT${n}-${i + 1}`,
              drill: true,
              mode: "two_step",
              afterReserve: "hold",
            },
            { supplierCode: "traveldesk", accountId },
          );
          ids.push(b.id);
          booked.push({ name: `LAT${n}-${i + 1}`, id: b.id, part: "LAT" });
          // The next item is started only once this one is held (or failed), as the saga does.
          for (let k = 0; k < 10 && ["queued", "reserving"].includes(await stateOf(b.id)); k++) {
            const p = await work(`LAT${n} #${i + 1}`, true, 3);
            if (!p.length) await sleep(2_000);
          }
          const t1 = Date.now();
          const r = await prisma.supplierBooking.findUniqueOrThrow({ where: { id: b.id } });
          const timing = await reserveTiming(b.id);
          items.push({ i: i + 1, ...slotView(s), state: r.state, supplierBookingId: r.supplierBookingId, intentToHeldMs: t1 - t0, reserveHttpMs: timing.responseMs, httpStatus: timing.httpStatus, sentAt: timing.sentAt, reservationDeadline: r.reservationDeadline });
          if (r.state !== "reserved") throw new Error(`LAT${n} item ${i + 1} ended ${r.state} (${r.errorCode})`);
          all.push(t1 - t0);
          if (timing.responseMs !== null) allHttp.push(timing.responseMs);
        }
        const tAll = Date.now();
        const rows = await prisma.supplierBooking.findMany({ where: { id: { in: ids } } });
        const first = rows.find((x) => x.id === ids[0])!;
        const earliestDeadline = Math.min(...rows.map((x) => x.reservationDeadline?.getTime() ?? Infinity));
        const sendBy = (await svc.confirmSendByFor(first.id, { mutationTimeoutMs: config.mutationTimeoutMs }))?.getTime() ?? null;
        const captureBy = sendBy === null ? null : sendBy - CAPTURE_BUDGET_MS;
        const lastReserveBy = captureBy === null ? null : captureBy - ITEM_RESERVE_BUDGET_MS;
        const lastSent = (items[items.length - 1].sentAt as Date | null)?.getTime() ?? null;
        const batch = {
          n,
          items,
          timeToAllReservedMs: tAll - tStart,
          firstSentAt: items[0].sentAt,
          earliestDeadline: iso(earliestDeadline),
          holdMinutesFromFirstSend: items[0].sentAt ? (earliestDeadline - (items[0].sentAt as Date).getTime()) / 60_000 : null,
          confirmSendBy: sendBy === null ? null : iso(sendBy),
          captureBy: captureBy === null ? null : iso(captureBy),
          marginToCaptureByMs: captureBy === null ? null : captureBy - tAll,
          lastReserveBy: lastReserveBy === null ? null : iso(lastReserveBy),
          lastReserveSentBeforeLastReserveByMs: lastReserveBy === null || lastSent === null ? null : lastReserveBy - lastSent,
          perReserveIntentToHeldMs: stats(items.map((x) => x.intentToHeldMs as number)),
          perReserveHttpMs: stats(items.map((x) => x.reserveHttpMs as number).filter((x) => typeof x === "number")),
        };
        batches.push(batch);
        observe(`batch${n}`, { timeToAllReservedMs: batch.timeToAllReservedMs, marginToCaptureByMs: batch.marginToCaptureByMs, holdMinutes: batch.holdMinutesFromFirstSend, perReserve: batch.perReserveIntentToHeldMs, http: batch.perReserveHttpMs });
        await cancelAndSettle(ids, `LAT${n} cancel`);
        const states = await Promise.all(ids.map(stateOf));
        if (states.some((s) => s !== "cancelled")) observe("cancel.not_all", { states });
      }
      measures.LAT = { batches, perReserveIntentToHeldMs: stats(all), perReserveHttpMs: stats(allHttp) };
      const five = batches.find((b) => b.n === 5) as { marginToCaptureByMs: number | null; lastReserveSentBeforeLastReserveByMs: number | null } | undefined;
      verdict("observed", `per reserve (intent → held) ${json(stats(all)).replace(/\s+/g, " ")} ms; ${five ? `5 items: margin to capture-by ${five.marginToCaptureByMs} ms, last reserve sent ${five.lastReserveSentBeforeLastReserveByMs} ms before the last-reserve point` : "no 5-item batch"}`);
      await writeOut();
    }

    /* ----------------------------------- DRY: order path, no supplier call */
    if (ONLY.includes("DRY")) {
      current = "DRY";
      const chosen = await slots(3);
      observe("plan", chosen.map(slotView));
      const o = await soldAndAuthorized("DRY", chosen);
      const first = await prisma.supplierBooking.findFirstOrThrow({ where: { orderItemId: o.itemIds[0] } });
      const payload = first.requestPayload as Record<string, unknown>;
      observe("attempt", { state: first.state, afterReserve: first.afterReserve, idempotencyKey: first.idempotencyKey.replace(/[0-9a-f-]{36}/g, "<id>"), fields: Object.keys(payload).sort(), hotelId: payload.hotelId ?? null, guestName: first.guestName === GUEST });
      // Never sent: the release closes it `not_created` at once, and the saga voids.
      await engineApi.releaseHold(first.id, "drill_dry_run");
      await saga.advance(o.sagaId);
      const sg = await prisma.paymentSaga.findUniqueOrThrow({ where: { id: o.sagaId }, include: { payment: true } });
      const states = await itemBookings(o.itemIds);
      const reserveCalls = calls.filter((c) => c.operation === "bookings.reserve").length;
      observe("after_release", { saga: sg.state, payment: sg.payment?.status, items: states.map((b) => b?.state ?? "-"), reservePosts: reserveCalls });
      verdict(sg.state === "released" && sg.payment?.status === "voided" && states[0]?.state === "not_created" && reserveCalls === 0 ? "pass" : "fail", `order path wired: item 1 attempt ${first.state} (await_payment); released before any send → ${states[0]?.state}; saga ${sg.state}; payment ${sg.payment?.status}; no TravelDesk mutation`);
      await writeOut();
    }

    /* ---------------------------------------------- E2E: the real saga, 3 items */
    if (ONLY.includes("E2E")) {
      current = "E2E";
      const chosen = await slots(3);
      observe("plan", chosen.map(slotView));
      const o = await soldAndAuthorized("E2E", chosen);
      const r = await drive("E2E", o, (s) => ["fulfilled", "refunded", "released", "failed", "attention"].includes(s), 12 * 60_000);
      const s = await prisma.paymentSaga.findUniqueOrThrow({ where: { id: o.sagaId }, include: { payment: true } });
      const order = await prisma.order.findUniqueOrThrow({ where: { id: o.orderId } });
      const items = await prisma.orderItem.findMany({ where: { orderId: o.orderId }, orderBy: { quoteLineIndex: "asc" } });
      const bs = await itemBookings(o.itemIds);
      track("E2E", o.itemIds, bs);
      const perItem = [];
      for (const [i, b] of bs.entries()) {
        if (!b) {
          perItem.push({ i: i + 1, booking: null });
          continue;
        }
        const row = await prisma.supplierBooking.findUniqueOrThrow({ where: { id: b.id } });
        const ev = await eventsOf(b.id);
        const found = await adapter.findByClientRef(row.clientRef, { serviceDate: row.serviceDate.toISOString().slice(0, 10), offerExternalId: row.offerExternalId });
        perItem.push({
          i: i + 1,
          allocationMinor: itemPayableMinor(items[i]),
          itemStatus: items[i].status,
          state: row.state,
          // A reservation the engine holds for a human (e.g. charged_amount_mismatch) is never confirmed automatically.
          heldForHuman: row.attentionRequiredAt !== null,
          errorCode: row.errorCode,
          supplierBookingId: row.supplierBookingId,
          supplierStatusCode: row.supplierStatusCode,
          reserveSent: ev.filter((e) => e.kind === "request_sent" && e.operation === "bookings.reserve").length,
          confirmSent: ev.filter((e) => e.kind === "request_sent" && e.operation === "bookings.confirm").length,
          reserveSentAt: ev.find((e) => e.kind === "request_sent" && e.operation === "bookings.reserve")?.at ?? null,
          reservedAt: row.reservedAt,
          confirmSentAt: ev.find((e) => e.kind === "request_sent" && e.operation === "bookings.confirm")?.at ?? null,
          confirmedAt: row.confirmedAt,
          reservationDeadline: row.reservationDeadline,
          matchesAtTravelDesk: found.matches.length,
          listComplete: found.complete,
        });
      }
      const allocSum = perItem.reduce((a, x) => a + ((x as { allocationMinor?: bigint | null }).allocationMinor ?? 0n), 0n);
      const ledger = await prisma.ledgerEntry.findMany({ where: { paymentId: o.paymentId, book: "customer_money" } });
      const refunds = await prisma.refund.count({ where: { paymentId: o.paymentId } });
      const captures = callsFor("capture", o.paymentId);
      const firstSent = Math.min(...perItem.map((x) => ((x as { reserveSentAt?: Date | null }).reserveSentAt ?? new Date(8.64e15)).getTime()));
      const lastReserved = Math.max(...perItem.map((x) => ((x as { reservedAt?: Date | null }).reservedAt ?? new Date(0)).getTime()));
      const earliestDeadline = Math.min(...perItem.map((x) => ((x as { reservationDeadline?: Date | null }).reservationDeadline ?? new Date(8.64e15)).getTime()));
      const capturedAt = s.payment?.capturedAt?.getTime() ?? null;
      const timeline = {
        authorizedToFirstReserveSentMs: firstSent - o.t0,
        firstReserveSentToAllReservedMs: lastReserved - firstSent,
        allReservedToCaptureMs: capturedAt === null ? null : capturedAt - lastReserved,
        captureBeforeEarliestDeadlineMs: capturedAt === null ? null : earliestDeadline - capturedAt,
        reserveOrder: [...perItem].sort((a, b) => ((a as { reserveSentAt?: Date }).reserveSentAt?.getTime() ?? 0) - ((b as { reserveSentAt?: Date }).reserveSentAt?.getTime() ?? 0)).map((x) => x.i),
        sagaSeen: r.seen,
      };
      measures.E2E = { perItem, allocSum, paymentAmount: s.payment?.amountMinor, captured: s.payment?.capturedMinor, captureCalls: captures.length, voids: callsFor("void", o.paymentId).length, refunds, ledger: ledger.map((l) => ({ kind: l.kind, amountMinor: l.amountMinor })), orderStatus: order.status, sagaState: s.state, timeline };
      observe("result", measures.E2E);
      const ok =
        s.state === "fulfilled" &&
        order.status === "confirmed" &&
        perItem.every((x) => (x as { state?: string }).state === "confirmed" && (x as { reserveSent?: number }).reserveSent === 1 && (x as { confirmSent?: number }).confirmSent === 1 && (x as { matchesAtTravelDesk?: number }).matchesAtTravelDesk === 1) &&
        new Set(perItem.map((x) => (x as { supplierBookingId?: string }).supplierBookingId)).size === perItem.length &&
        allocSum === s.payment?.amountMinor &&
        s.payment?.capturedMinor === s.payment?.amountMinor &&
        captures.length === 1 &&
        refunds === 0 &&
        json(timeline.reserveOrder) === json([1, 2, 3]);
      const held = perItem.filter((x) => (x as { heldForHuman?: boolean }).heldForHuman).map((x) => `item ${x.i}: ${(x as { errorCode?: string | null }).errorCode ?? "attention"}`);
      verdict(ok ? "pass" : "fail", ok ? `saga fulfilled; reserves sent in item order; one capture of the whole amount (allocations ${perItem.map((x) => (x as { allocationMinor?: bigint }).allocationMinor).join(" + ")} = ${allocSum}); 3 TravelDesk bookings, one per item, each confirmed once; no refund` : `see measures.E2E (${s.state}${held.length ? `; held for a human by the engine: ${held.join(", ")}` : ""})`);
      await writeOut();
      // Cancel every booking inside the 100% window (operator cancel, manual run).
      await cancelAndSettle(bs.flatMap((b) => (b ? [b.id] : [])), "E2E cancel");
      const after = await itemBookings(o.itemIds);
      observe("cancelled", after.map((b) => b?.state ?? "-"));
      if (after.some((b) => b && b.state !== "cancelled")) verdict("fail", `not every E2E booking cancelled: ${after.map((b) => b?.state).join(", ")}`);
      await writeOut();
    }

    /* ------------------------------------- FAIL: item 2 of 3 refused at reserve */
    if (ONLY.includes("FAIL")) {
      current = "FAIL";
      const chosen = await slots(3);
      observe("plan", chosen.map(slotView));
      const reservesBefore = calls.filter((c) => c.operation === "bookings.reserve").length;
      const o = await soldAndAuthorized("FAIL", chosen);
      // Item 2's reserve is refused definitely in the transport once its attempt exists (its client reference).
      const arm = async () => {
        const b = await prisma.supplierBooking.findFirst({ where: { orderItemId: o.itemIds[1] } });
        if (b) failRefs.add(b.clientRef);
      };
      const end = Date.now() + 8 * 60_000;
      let s = "";
      // Scheduled-style runs (paid_only): reserve item 1, then item 2 (refused), then the saga's release.
      while (Date.now() < end) {
        await arm();
        const processed = await work("FAIL", "paid_only", 1);
        await arm();
        await saga.advance(o.sagaId);
        s = (await prisma.paymentSaga.findUniqueOrThrow({ where: { id: o.sagaId } })).state;
        const bs = await itemBookings(o.itemIds);
        track("FAIL", o.itemIds, bs);
        observe("progress", { saga: s, items: bs.map((b) => b?.state ?? "-"), processed: processed.map((p) => `${p.kind}:${p.outcome}`) });
        if (!["authorized", "reserve_pending"].includes(s)) break;
        if (!processed.length) await sleep(5_000);
      }
      // The scheduled run sends the hold-release cancel itself (doc 22 §32.22, 4 Nov 2026); the manual drive after it only settles what is left.
      const paidOnly = await work("FAIL paid_only", "paid_only");
      const cancelJob = await prisma.supplierJob.findMany({ where: { supplierBookingId: { in: (await itemBookings(o.itemIds)).flatMap((b) => (b ? [b.id] : [])) }, kind: "cancel" }, select: { status: true } });
      // Every worker run so far was scheduled-style: any cancel sent for item 1 by now was sent by one.
      const first = (await itemBookings(o.itemIds))[0];
      const releaseSentByScheduled = first ? (await prisma.supplierBookingEvent.count({ where: { supplierBookingId: first.id, kind: "request_sent", operation: "bookings.cancel" } })) > 0 : false;
      observe("paid_only_after_release", { processed: paidOnly.map((p) => `${p.kind}:${p.outcome}`), cancelJobs: cancelJob.map((j) => j.status), releaseSentByScheduled });
      const r = await drive("FAIL manual", o, (st) => ["released", "failed", "refunded", "attention", "fulfilled"].includes(st), 8 * 60_000, true);
      const sg = await prisma.paymentSaga.findUniqueOrThrow({ where: { id: o.sagaId }, include: { payment: true } });
      const order = await prisma.order.findUniqueOrThrow({ where: { id: o.orderId } });
      const bs = await itemBookings(o.itemIds);
      track("FAIL", o.itemIds, bs);
      const item1 = bs[0] ? await prisma.supplierBooking.findUniqueOrThrow({ where: { id: bs[0].id } }) : null;
      const found1 = item1 ? await adapter.findByClientRef(item1.clientRef, { serviceDate: item1.serviceDate.toISOString().slice(0, 10), offerExternalId: item1.offerExternalId }) : null;
      const reservesSent = calls.filter((c) => c.operation === "bookings.reserve").length - reservesBefore;
      const remedies = await prisma.customerRemedy.findMany({ where: { orderId: o.orderId }, select: { kind: true, status: true, reason: true, amountMinor: true } });
      const result = {
        sagaState: sg.state,
        sagaSeen: r.seen,
        orderStatus: order.status,
        payment: { status: sg.payment?.status, capturedMinor: sg.payment?.capturedMinor, amountMinor: sg.payment?.amountMinor },
        // This order's calls only: the fake gateway is shared with E2E.
        gatewayCalls: { capture: callsFor("capture", o.paymentId).length, void: callsFor("void", o.paymentId).length },
        items: bs.map((b) => b?.state ?? "never started"),
        item1: item1 ? { state: item1.state, supplierStatusCode: item1.supplierStatusCode, atTravelDesk: found1?.matches.map((m) => ({ status: m.status, rawStatus: m.rawStatus })) } : null,
        reservePostsToTravelDesk: reservesSent,
        releaseSentByScheduled,
        remedies,
      };
      measures.FAIL = result;
      observe("result", result);
      const item1Released = item1 !== null && (item1.state === "cancelled" || item1.state === "expired") && [4, 8].includes(item1.supplierStatusCode ?? -1);
      const ok = sg.state === "released" && item1Released && bs[1]?.state === "rejected" && bs[2] === null && sg.payment?.status === "voided" && sg.payment?.capturedMinor === 0n && callsFor("capture", o.paymentId).length === 0 && callsFor("void", o.paymentId).length === 1 && reservesSent === 1 && releaseSentByScheduled;
      verdict(ok ? "pass" : "fail", ok ? `item 2 refused (injected 403, not sent); item 1's hold released by the scheduled run (engine ${item1!.state}, TravelDesk status ${item1!.supplierStatusCode}); item 3 never started; payment voided, nothing captured; one reserve POST reached TravelDesk` : `see measures.FAIL (${sg.state})`);
      await writeOut();
    }
  } catch (e) {
    failure = e;
    console.error(`part ${current} failed; cleaning up:`, e);
  }

  /* ------------------------------------------------ cleanup and reconciliation */
  current = "cleanup";
  await cancelAndSettle(
    booked.map((d) => d.id),
    "cleanup",
  );
  // The drill's products and mappings: soft-deleted and inactive, so no storefront or sync ever sees them.
  if (products.length) await prisma.product.updateMany({ where: { id: { in: products }, deletedAt: null }, data: { deletedAt: new Date() } });
  if (mappings.length) await prisma.productSupplierMapping.updateMany({ where: { id: { in: mappings } }, data: { isActive: false } });
  const reconcile = await svc.reconcile({ adapter, environment: "test", supplierCode: "traveldesk", accountId });
  const balanceEnd = await balance("end");
  const stillOpen: { name: string; id: string | null; state: string; supplierStatus: number | null }[] = [];
  for (const d of booked) {
    const b = await prisma.supplierBooking.findUniqueOrThrow({ where: { id: d.id } });
    if (!b.supplierBookingId) continue;
    const f = await adapter.findByClientRef(b.clientRef, { serviceDate: b.serviceDate.toISOString().slice(0, 10), offerExternalId: b.offerExternalId });
    for (const m of f.matches) if (m.status !== "CANCELLED" && m.status !== "EXPIRED") stillOpen.push({ name: d.name, id: m.ref, state: b.state, supplierStatus: m.rawStatus });
  }
  await writeOut({ balanceStart, balanceEnd, reconcile, stillOpen });
  console.log("\nverdicts:");
  for (const v of verdicts) console.log(`  ${v.part}: ${v.result.toUpperCase()} — ${v.summary}`);
  console.log(`balance / credit / payable start ${balanceStart.balance} / ${balanceStart.credit} / ${balanceStart.payable}, end ${balanceEnd.balance} / ${balanceEnd.credit} / ${balanceEnd.payable} (minor units)`);
  console.log(`reconciliation: ${reconcile.issues.length} difference(s); ${reconcile.supplierListed} listed, ${reconcile.ours} ours, ${reconcile.otherBookings} other, complete ${reconcile.listComplete}`);
  for (const i of reconcile.issues) console.log(`  ${i.kind}: ${i.reference} #${i.supplierBookingId} ours ${i.ours} theirs ${i.theirs}`);
  if (stillOpen.length) console.error(`OPEN ON TRAVELDESK TEST: ${stillOpen.map((s) => `${s.name} #${s.id} status ${s.supplierStatus} (engine ${s.state})`).join(", ")}`);
  console.log(`written: ${outDir}/results.json`);
  if (failure || verdicts.some((v) => v.result === "fail") || reconcile.issues.length || stillOpen.length) process.exitCode = 1;
  await prisma.$disconnect();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
