/**
 * TravelDesk TEST probe: why the charged amount differs from the quoted net on
 * some offers (doc 22 §32.25; pickup offers 166 and 45 first).
 *
 *   PROBE_MODE=read (default)  GET only: balance, the offer list with prices,
 *       tour details and raw availability for the probed offers, their pickup
 *       hotels. Records which offers carry a net with fractional dirhams.
 *   PROBE_MODE=book  one-adult reservations (reserve only, never confirm),
 *       each read back and cancelled straight away. PROBE_PLAN is a list of
 *       `offerId@YYYY-MM-DD[@hotelId][=send]` entries, where `send` is the
 *       totalCost sent: `net` (default: the listed net, as quoted before the
 *       whole-dirham fix) or `quote` (the engine's `quoteSlot` on the fresh
 *       rows and the offer as the catalogue sync stores it). Every offer in
 *       the plan must be listed in PROBE_OFFERS (offerId:tourId).
 *       At most PROBE_MAX_BOOKINGS (default 6) reservations per run.
 *
 *   node --env-file=<TravelDesk TEST env file> node_modules/tsx/dist/cli.mjs scripts/traveldesk-pickup-price-probe.ts
 *
 * Safety:
 *  - TRAVELDESK_ENV=test and the test host only; bookings are enabled in this
 *    process only, and only in book mode. No database is opened.
 *  - One adult, guest "OUTLY Sandbox Test", remarks marking a test, no phone,
 *    no email. Every reservation is cancelled; anything left open is printed.
 *  - References start OUTPX-, never the engine's OUTTD-: the probe bypasses
 *    the engine, so an OUTTD- reference would show in every reconciliation
 *    as `unknown_to_outly` (the 4 Nov 2026 run did: eight cancelled holds).
 *  - Results (raw supplier amounts included) go to
 *    .traveldesk-probe/pickup-<timestamp>/ (git-ignored), never the key,
 *    voucher links, ticket codes or PII.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { z } from "zod";
import { uuidv7 } from "../src/server/lib/ids";
import { bookingFrom, bookingWire, buildBookingRequest, cancellationWire } from "../src/server/suppliers/traveldesk/traveldesk.booking";
import { availabilityFrom, availabilityWire, netTotalMinor, tourDetailFrom, tourDetailsWire } from "../src/server/suppliers/traveldesk/traveldesk.codec";
import { chargedFrom, withinChargeTolerance } from "../src/server/suppliers/traveldesk/traveldesk.confirmation";
import { traveldeskConfigFrom, traveldeskConfigProblems, type TravelDeskConfig } from "../src/server/suppliers/traveldesk/traveldesk.config";
import { isTravelDeskApiError, TravelDeskHttp, type TravelDeskCallEvent } from "../src/server/suppliers/traveldesk/traveldesk.http";
import { parseStoredOffer, parseStoredPolicy } from "../src/server/suppliers/traveldesk/traveldesk.offer-terms";
import { quoteSlot, slotRefOf } from "../src/server/suppliers/traveldesk/traveldesk.quote";

function fail(message: string): never {
  console.error(`traveldesk-pickup-price-probe: ${message}`);
  process.exit(2);
}

if (process.env.DATABASE_URL) fail("this probe opens no database: run it without .env.test.local");
const MODE = process.env.PROBE_MODE ?? "read";
if (MODE !== "read" && MODE !== "book") fail("PROBE_MODE must be read or book");

const env = {
  APP_ENV: "development" as const,
  SUPPLIER_ADAPTER_TRAVELDESK: process.env.SUPPLIER_ADAPTER_TRAVELDESK as "mock" | "live" | undefined,
  TRAVELDESK_ENV: process.env.TRAVELDESK_ENV as "test" | "production" | undefined,
  TRAVELDESK_API_BASE_URL: process.env.TRAVELDESK_API_BASE_URL?.trim() || undefined,
  TRAVELDESK_API_KEY: process.env.TRAVELDESK_API_KEY?.trim() || undefined,
  TRAVELDESK_TIMEOUT_MS: Number(process.env.TRAVELDESK_TIMEOUT_MS ?? 150_000),
  TRAVELDESK_READ_TIMEOUT_MS: Number(process.env.TRAVELDESK_READ_TIMEOUT_MS ?? 30_000),
  TRAVELDESK_BOOKINGS_ENABLED: MODE === "book",
};
if (env.SUPPLIER_ADAPTER_TRAVELDESK !== "live") fail("the TravelDesk env file must set SUPPLIER_ADAPTER_TRAVELDESK=live");
if (env.TRAVELDESK_ENV !== "test") fail("TRAVELDESK_ENV=test only");
const problems = traveldeskConfigProblems(env);
if (problems.length) fail(`configuration refused:\n  - ${problems.join("\n  - ")}`);
const config = traveldeskConfigFrom(env) as TravelDeskConfig;
if (config.environment !== "test" || config.host !== "testapi.traveldesk.me") fail("refusing: not the test environment");

const OFFERS = (process.env.PROBE_OFFERS ?? "166:23,45:11")
  .split(",")
  .map((s) => s.trim().split(":").map(Number))
  .map(([offerId, tourId]) => ({ offerId, tourId }));
const tourOf = new Map(OFFERS.map((o) => [o.offerId, o.tourId]));
const MAX_BOOKINGS = Number(process.env.PROBE_MAX_BOOKINGS ?? 6);
const RUN = uuidv7().slice(-6).toUpperCase();
const outDir = path.join(".traveldesk-probe", `pickup-${new Date().toISOString().replace(/[:.]/g, "-")}`);
const json = (v: unknown) => JSON.stringify(v, (_k, x) => (typeof x === "bigint" ? x.toString() : x), 2);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const anyJson = z.unknown();

const calls: (TravelDeskCallEvent & { at: string })[] = [];
const out: Record<string, unknown> = { run: RUN, mode: MODE };
const http = new TravelDeskHttp(config, { onEvent: (e) => calls.push({ ...e, at: new Date().toISOString() }), maxConcurrent: 1 });

function dubaiDate(offsetDays: number): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Dubai", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date(Date.now() + offsetDays * 86_400_000));
}
function errorSummary(e: unknown) {
  if (isTravelDeskApiError(e)) return { kind: e.kind, status: e.status, reason: e.reason ?? null, fieldErrors: e.fieldErrors?.map((f) => f.fieldName) ?? null };
  return { kind: "internal", message: e instanceof Error ? e.message.slice(0, 300) : "error" };
}
async function get(label: string, p: string, q: Record<string, string | number | boolean | number[] | undefined>) {
  await sleep(400);
  try {
    return await http.getJson(label, p, p, q, anyJson);
  } catch (e) {
    return { error: errorSummary(e) };
  }
}
/** Drop guest data and any secret-bearing field from a raw booking answer. */
function scrub(v: unknown): unknown {
  if (!v || typeof v !== "object") return v;
  const drop = /guid|ticket|download|url|link|phone|email|guestname|voucher|staffagent|paidto|roomnumber/i;
  return Object.fromEntries(Object.entries(v as Record<string, unknown>).filter(([k]) => !drop.test(k)));
}
const balance = async () => get("balance", "/balance", { CurrencyCode: "AED" });

async function readMode() {
  out.balance = await balance();
  const offers = (await get("offers.list", "/offers", { IncludePrices: true, CountryId: 50 })) as unknown;
  if (Array.isArray(offers)) {
    // Every offer whose current AED price has fractional dirhams, with the fields that might explain a rounding.
    out.fractionalOffers = offers.flatMap((o: { id: number; tourId: number; prices?: Record<string, unknown>[] | null }) =>
      (o.prices ?? [])
        .filter((p) => [p.pricePerAdult, p.pricePerChild, p.pricePerTrip].some((x) => typeof x === "number" && Math.round(x * 100) % 100 !== 0))
        .map((p) => ({ offerId: o.id, tourId: o.tourId, ...p })),
    );
    out.offerCount = offers.length;
  } else out.offers = offers;
  const from = dubaiDate(6);
  const to = dubaiDate(19);
  for (const { offerId, tourId } of OFFERS) {
    const tour = (await get("tours.get", `/tours/${tourId}`, { CurrencyCode: "AED" })) as { offers?: Record<string, unknown>[] };
    const offer = tour.offers?.find((o) => o.id === offerId) ?? null;
    const slim = offer ? Object.fromEntries(Object.entries(offer).filter(([k]) => !["description"].includes(k))) : tour;
    out[`offer_${offerId}`] = slim;
    out[`availability_${offerId}`] = await get("availability.byoffer", "/availability/byoffer", { Id: offerId, From: from, To: to, CurrencyCode: "AED" });
    const hotels = (await get("hotels.foroffer", "/hotels/foroffer", { OfferId: offerId })) as unknown;
    out[`hotels_${offerId}`] = Array.isArray(hotels)
      ? { count: hotels.length, keys: Object.keys(hotels[0] ?? {}), sample: hotels.slice(0, 400) }
      : hotels;
  }
}

async function bookMode() {
  const plan = (process.env.PROBE_PLAN ?? "").split(",").map((s) => s.trim()).filter(Boolean);
  if (!plan.length) fail("PROBE_PLAN is empty");
  if (plan.length > MAX_BOOKINGS) fail(`PROBE_PLAN has ${plan.length} entries; at most ${MAX_BOOKINGS}`);
  out.balanceStart = await balance();
  const results: unknown[] = [];
  const open: string[] = [];
  for (const [i, entry] of plan.entries()) {
    const m = /^(\d+)@(\d{4}-\d{2}-\d{2})(?:@(\d+))?(?:=(net|quote))?$/.exec(entry);
    if (!m) fail(`bad plan entry ${entry}`);
    if (!tourOf.get(Number(m[1]))) fail(`offer ${m[1]} is not in PROBE_OFFERS (offerId:tourId)`);
    const offerId = Number(m[1]);
    const date = m[2];
    const hotelId = m[3] ? Number(m[3]) : null;
    const send = (m[4] ?? "net") as "net" | "quote";
    const r: Record<string, unknown> = { entry, offerId, date, hotelId, send };
    results.push(r);
    const raw = (await get("availability.byoffer", "/availability/byoffer", { Id: offerId, From: date, To: date, CurrencyCode: "AED" })) as unknown;
    r.availabilityRaw = raw;
    const parsed = availabilityWire.safeParse(raw);
    if (!parsed.success) {
      r.skipped = "availability unreadable";
      continue;
    }
    const rows = availabilityFrom(parsed.data).rows;
    const row = rows.find((x) => x.seatsLeft > 2 && x.price.isBookable && (x.price.perAdultMinor > 0n || x.price.perTripMinor > 0n));
    if (!row) {
      r.skipped = "no bookable row";
      continue;
    }
    const units = { adults: 1, children: 0, infants: 0 };
    const listNet = netTotalMinor(row.price, units);
    // The engine's own quote: the stored offer as the catalogue sync writes it, the fresh rows, quoteSlot.
    const tourRaw = await get("tours.get", `/tours/${tourOf.get(offerId)}`, { CurrencyCode: "AED" });
    const tourParsed = tourDetailsWire.safeParse(tourRaw);
    const detail = tourParsed.success ? tourDetailFrom(tourParsed.data) : null;
    const stored = detail ? parseStoredOffer(JSON.parse(json(detail.offers.find((o) => o.offerId === offerId) ?? null))) : null;
    const policy = detail ? parseStoredPolicy(JSON.parse(json(detail))) : null;
    const quote = stored
      ? quoteSlot({ offer: stored, policy, serviceDate: date, slotRef: slotRefOf(row.timeSlotId, row.startMinutes), units, rows, now: new Date(), issuesTicketsAtConfirm: "unknown" })
      : null;
    r.quote = quote;
    if (send === "quote" && !quote?.ok) {
      r.skipped = "no quote";
      continue;
    }
    const sent = send === "quote" && quote?.ok ? quote.netAedMinor : listNet;
    r.priceMinor = { perAdult: row.price.perAdultMinor, perTrip: row.price.perTripMinor, listNet, sent, roundedFields: row.price.roundedFields };
    const body = buildBookingRequest({
      serviceDate: date,
      offerId,
      adults: 1,
      children: 0,
      infants: 0,
      guestName: "OUTLY Sandbox Test",
      // Not the engine's OUTTD- prefix: reconciliation reports any OUTTD- booking without an engine row.
      clientRef: `OUTPX-${RUN}${i}`,
      totalCostMinor: sent,
      totalCostUsdMinor: row.price.perAdultUsdMinor + row.price.perTripUsdMinor,
      hotelId,
      slot: { timeSlotId: row.timeSlotId, startMinutes: row.startMinutes, endMinutes: row.endMinutes },
      remarks: "OUTLY integration sandbox test - automated, will be cancelled. Please ignore.",
    });
    r.bodySent = { ...body, guestName: "(test guest)" };
    let id: string | null = null;
    try {
      const reserved = await http.postJson("bookings.reserve", "/bookings/reserve", "/bookings/reserve", body, anyJson);
      r.reserveRaw = scrub(reserved);
      const b = bookingFrom(bookingWire.parse(reserved));
      id = b.supplierBookingId;
      open.push(id);
      r.charged = chargedFrom(b);
      r.chargedWithinToleranceOfSent = r.charged === null ? null : withinChargeTolerance(r.charged as bigint, sent);
      r.chargedWithinToleranceOfListNet = r.charged === null ? null : withinChargeTolerance(r.charged as bigint, listNet);
      r.chargedWithinToleranceOfQuote = r.charged === null || !quote?.ok ? null : withinChargeTolerance(r.charged as bigint, quote.netAedMinor);
    } catch (e) {
      r.reserveError = errorSummary(e);
      continue;
    }
    await sleep(800);
    r.reservationRaw = scrub(await get("bookings.reservation", `/bookings/reservation/${Number(id)}`, {}));
    try {
      r.cancelRaw = await http.postJson("bookings.cancel", "/bookings/cancel", "/bookings/cancel", { id: Number(id) }, cancellationWire);
      open.splice(open.indexOf(id), 1);
    } catch (e) {
      r.cancelError = errorSummary(e);
    }
    await sleep(800);
    const list = (await get("bookings.list", "/bookings", { Page: 1, OnPage: 100, From: date, To: date, OffersIds: [offerId] })) as { data?: { id: number }[] };
    r.afterCancelRaw = scrub(list.data?.find((x) => String(x.id) === id) ?? null);
  }
  out.results = results;
  out.leftOpen = open;
  out.balanceEnd = await balance();
  if (open.length) console.error(`OPEN ON TRAVELDESK TEST: ${open.join(", ")}`);
}

async function main() {
  mkdirSync(outDir, { recursive: true });
  try {
    if (MODE === "read") await readMode();
    else await bookMode();
  } finally {
    out.calls = calls.map((c) => ({ operation: c.operation, status: c.status, outcome: c.outcome, durationMs: c.durationMs, at: c.at }));
    writeFileSync(path.join(outDir, "results.json"), json(out));
    console.log(`results: ${outDir}/results.json`);
  }
}
main().catch((e) => {
  console.error(e);
  process.exit(1);
});
