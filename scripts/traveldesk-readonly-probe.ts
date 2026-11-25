/**
 * TravelDesk READ-ONLY probe (docs/backend/21, Stage 1).
 *
 * Two targets:
 *  - default: the TEST environment (`npm run traveldesk:probe`, key in
 *    .env.traveldesk.local).
 *  - `--production-readonly`: PRODUCTION catalogue data, run locally only
 *    (`npm run traveldesk:probe:production`, key in
 *    .env.traveldesk.production.local). Approved 27 Oct 2026 for catalogue,
 *    availability and price calls ONLY: it skips balance, the booking list and
 *    every negative or currency probe, and it can never send a mutation.
 *
 * What it does: GET requests only — balance, categories, tours, tour details,
 * offers, sampled availability / ticket stock / pickup hotels, a booking-list
 * summary, and a few deliberate negative probes (unknown tour, missing or
 * unsupported CurrencyCode, an invalid key). It never calls reserve, confirm,
 * create or cancel; the HTTP client has no method that could.
 *
 * Safety:
 *  - Refuses to run unless SUPPLIER_ADAPTER_TRAVELDESK=live, TRAVELDESK_ENV=test,
 *    the base URL is the test host, and TRAVELDESK_BOOKINGS_ENABLED is not true.
 *  - The key is read from the environment only and is never printed or written.
 *  - Booking-list results are reduced to counts and field names. Guest data,
 *    Guids, ticket codes and document URLs are never written to disk.
 *  - Output goes to .traveldesk-probe/<timestamp>/ (git-ignored).
 *
 * Run (key in .env.traveldesk.local, see docs/backend/impl/traveldesk.md):
 *   npm run traveldesk:probe
 * Optional: PROBE_MAX_TOURS (default 400), PROBE_SPACING_MS (default 600).
 */
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { z } from "zod";
import { TravelDeskReadClient } from "../src/server/suppliers/traveldesk/traveldesk.client";
import type { TravelDeskOffer, TravelDeskTourDetail } from "../src/server/suppliers/traveldesk/traveldesk.codec";
import {
  traveldeskConfigFrom,
  traveldeskConfigProblems,
  traveldeskProductionReadOnlyConfigFrom,
  type TravelDeskConfig,
} from "../src/server/suppliers/traveldesk/traveldesk.config";
import { isTravelDeskApiError, TravelDeskHttp, type TravelDeskCallEvent } from "../src/server/suppliers/traveldesk/traveldesk.http";
import { assertNoDatabaseTarget } from "./lib/target-guard";

const env = {
  APP_ENV: "development" as const,
  SUPPLIER_ADAPTER_TRAVELDESK: process.env.SUPPLIER_ADAPTER_TRAVELDESK as "mock" | "live" | undefined,
  TRAVELDESK_ENV: process.env.TRAVELDESK_ENV as "test" | "production" | undefined,
  TRAVELDESK_API_BASE_URL: process.env.TRAVELDESK_API_BASE_URL?.trim() || undefined,
  TRAVELDESK_API_KEY: process.env.TRAVELDESK_API_KEY?.trim() || undefined,
  TRAVELDESK_TIMEOUT_MS: Number(process.env.TRAVELDESK_TIMEOUT_MS ?? 150_000),
  TRAVELDESK_READ_TIMEOUT_MS: Number(process.env.TRAVELDESK_READ_TIMEOUT_MS ?? 30_000),
  TRAVELDESK_BOOKINGS_ENABLED: process.env.TRAVELDESK_BOOKINGS_ENABLED === "true",
};

function fail(message: string): never {
  console.error(`traveldesk-probe: ${message}`);
  process.exit(2);
}

const PRODUCTION = process.argv.includes("--production-readonly");

try {
  // Target guard (scripts/lib/target-guard.ts): the probe never opens a database, so none may be configured.
  assertNoDatabaseTarget();
} catch (e) {
  fail(e instanceof Error ? e.message : String(e));
}

if (env.SUPPLIER_ADAPTER_TRAVELDESK !== "live") fail("set SUPPLIER_ADAPTER_TRAVELDESK=live in the probe's env file");
if (env.TRAVELDESK_BOOKINGS_ENABLED) fail("TRAVELDESK_BOOKINGS_ENABLED must be false for a read-only probe");
let config: TravelDeskConfig;
if (PRODUCTION) {
  if (env.TRAVELDESK_ENV !== "production") fail("--production-readonly needs TRAVELDESK_ENV=production (.env.traveldesk.production.local)");
  const r = traveldeskProductionReadOnlyConfigFrom(env);
  if ("problems" in r) fail(`configuration refused:\n  - ${r.problems.join("\n  - ")}`);
  config = r;
  if (config.host !== "api.traveldesk.me" || config.bookingsEnabled) fail("refusing: not a read-only production configuration");
  // Test and production keys are separate (HTML §Getting started). Refuse a production run
  // with the key that is configured for the test environment. Compared by hash; never printed.
  if (existsSync(".env.traveldesk.local")) {
    const testKey = /^TRAVELDESK_API_KEY=(.*)$/m.exec(readFileSync(".env.traveldesk.local", "utf8"))?.[1]?.trim();
    const sha = (v: string) => createHash("sha256").update(v).digest("hex");
    if (testKey && sha(testKey) === sha(config.apiKey)) {
      fail("the key in .env.traveldesk.production.local is the same as the TEST key in .env.traveldesk.local — paste the key from the dashboard's Production tab");
    }
  }
} else {
  if (env.TRAVELDESK_ENV !== "test") fail("without --production-readonly this probe only runs against TRAVELDESK_ENV=test");
  const problems = traveldeskConfigProblems(env);
  if (problems.length) fail(`configuration refused:\n  - ${problems.join("\n  - ")}`);
  config = traveldeskConfigFrom(env) as TravelDeskConfig;
  if (config.host !== "testapi.traveldesk.me") fail("refusing: not the test host");
}

const MAX_TOURS = Number(process.env.PROBE_MAX_TOURS ?? 400);
const SPACING_MS = Math.max(300, Number(process.env.PROBE_SPACING_MS ?? 600));
const stamp = new Date().toISOString().replace(/[:.]/g, "-");
const MAX_AVAILABILITY = Number(process.env.PROBE_MAX_AVAILABILITY ?? (PRODUCTION ? 20 : 8));
const outDir = path.resolve(".traveldesk-probe", `${PRODUCTION ? "production" : "test"}-${stamp}`);
mkdirSync(outDir, { recursive: true });

const events: TravelDeskCallEvent[] = [];
const onEvent = (e: TravelDeskCallEvent) => events.push(e);
const client = new TravelDeskReadClient(config, { onEvent, maxConcurrent: 1 });
const raw = new TravelDeskHttp(config, { onEvent, maxConcurrent: 1 });
const anyJson = z.unknown();

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const json = (v: unknown) => JSON.stringify(v, (_k, x) => (typeof x === "bigint" ? x.toString() : x), 2);
const save = (name: string, v: unknown) => writeFileSync(path.join(outDir, name), json(v));

interface Finding {
  questionId: string;
  check: string;
  result: string;
  evidence: string;
}
const findings: Finding[] = [];
const note = (questionId: string, check: string, result: string, evidence: string) => findings.push({ questionId, check, result, evidence });

function describeError(e: unknown) {
  if (isTravelDeskApiError(e)) return { kind: e.kind, status: e.status, reason: e.reason, fieldErrors: e.fieldErrors, issues: e.issues };
  return { kind: "local", message: e instanceof Error ? e.message : String(e) };
}

async function step<T>(label: string, fn: () => Promise<T>): Promise<{ ok: true; value: T } | { ok: false; error: ReturnType<typeof describeError> }> {
  await sleep(SPACING_MS);
  try {
    const value = await fn();
    console.log(`ok    ${label}`);
    return { ok: true, value };
  } catch (e) {
    const error = describeError(e);
    console.log(`FAIL  ${label}: ${error.kind}${"status" in error && error.status ? ` ${error.status}` : ""}`);
    return { ok: false, error };
  }
}

/** Today's calendar date in Dubai; tour dates are local dates. */
function dubaiDate(offsetDays: number): string {
  const d = new Date(Date.now() + offsetDays * 86_400_000);
  return new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Dubai", year: "numeric", month: "2-digit", day: "2-digit" }).format(d);
}

async function main() {
  console.log(`TravelDesk read-only probe (${PRODUCTION ? "PRODUCTION catalogue, read-only" : "test"}) → ${config.baseUrl} (key: ${config.apiKey.length} chars, not shown)\n`);

  if (!PRODUCTION) {
    // Auth + base URL (Q-E1)
    const balance = await step("GET /balance", () => client.getBalance());
    save("balance.json", balance);
    note("Q-E1", "Base URL + spec path joined once", balance.ok ? "answered" : "failed", balance.ok ? "GET /balance 200 via documented base URL" : json(balance.error));
    note("Q-C1", "Balance fields", balance.ok ? "partial" : "failed", balance.ok ? "AgencyBalance parsed; currency of the balance itself still unstated" : json(balance.error));

    // Invalid key → 403 empty body expected (HTML §Errors)
    const badKey = new TravelDeskHttp({ ...config, apiKey: "invalid-key-outly-probe" }, { onEvent, maxConcurrent: 1 });
    const bad = await step("GET /balance with an invalid key", () => badKey.getJson("balance.badkey", "/balance", "/balance", { CurrencyCode: "AED" }, anyJson));
    note("Q-E2", "Invalid key response", "observed", json(bad.ok ? { unexpected: "200" } : bad.error));
  }

  const categories = await step("GET /tourscategories", () => client.listCategories());
  save("categories.json", categories);

  const tours = await step("GET /tours?CountryId=50", () => client.listTours());
  save("tours.json", tours);
  if (!tours.ok) {
    const rawTours = await step("GET /tours raw (diagnose)", () => raw.getJson("tours.raw", "/tours", "/tours", { CountryId: 50, CurrencyCode: "AED" }, anyJson));
    save("tours.raw.json", rawTours);
  }

  const offers = await step("GET /offers?IncludePrices=true", () => client.listOffers());
  save("offers.json", offers);
  const rawOffers = await step("GET /offers raw sample", () => raw.getJson("offers.raw", "/offers", "/offers", { IncludePrices: true, CountryId: 50 }, anyJson));
  if (rawOffers.ok && Array.isArray(rawOffers.value)) save("offers.raw.sample.json", rawOffers.value.slice(0, 5));

  // Tour details
  const details: TravelDeskTourDetail[] = [];
  const detailFailures: { tourId: number; error: unknown }[] = [];
  const tourIds = tours.ok ? tours.value.map((t) => t.tourId).slice(0, MAX_TOURS) : [];
  let rawSaved = 0;
  for (const id of tourIds) {
    const d = await step(`GET /tours/${id}`, () => client.getTour(id));
    if (d.ok) details.push(d.value);
    else {
      detailFailures.push({ tourId: id, error: d.error });
      if (rawSaved < 3) {
        const r = await step(`GET /tours/${id} raw (diagnose)`, () => raw.getJson("tours.get.raw", "/tours/{Id}", `/tours/${id}`, { CurrencyCode: "AED" }, anyJson));
        save(`tour-${id}.raw.json`, r);
        rawSaved++;
      }
    }
  }
  save("tour-details.json", details);
  save("tour-detail-failures.json", detailFailures);
  if (details[0]) {
    const r = await step(`GET /tours/${details[0].tourId} raw sample`, () =>
      raw.getJson("tours.get.raw", "/tours/{Id}", `/tours/${details[0].tourId}`, { CurrencyCode: "AED" }, anyJson),
    );
    save(`tour-${details[0].tourId}.raw.sample.json`, r);
  }

  if (!PRODUCTION) {
    const missing = await step("GET /tours/2147483000 (unknown id)", () => raw.getJson("tours.get.missing", "/tours/{Id}", "/tours/2147483000", { CurrencyCode: "AED" }, anyJson));
    note("Q-O3", "Unknown tour id", "observed", json(missing.ok ? { unexpected: "200" } : missing.error));
  }

  const allOffers: TravelDeskOffer[] = details.flatMap((t) => t.offers);
  const byKind = (kind: TravelDeskOffer["bookingKind"], external: boolean) => allOffers.filter((o) => o.bookingKind === kind && o.isExternal === external);
  const kindCounts = Object.fromEntries(
    (["on_request", "live_book", "ticket_only", "unknown"] as const).map((k) => [k, { internal: byKind(k, false).length, external: byKind(k, true).length }]),
  );
  note("Catalogue", "Offer booking kinds", "observed", json(kindCounts));

  // Availability samples (≤ 7-day windows)
  const from = dubaiDate(2);
  const to = dubaiDate(8);
  const quarter = Math.max(1, Math.floor(MAX_AVAILABILITY / 4));
  const sample = [
    ...byKind("live_book", false).slice(0, MAX_AVAILABILITY - 2 * quarter),
    ...byKind("live_book", true).slice(0, quarter),
    ...byKind("on_request", false).slice(0, quarter),
  ];
  const availability: Record<string, unknown> = {};
  for (const o of sample) {
    const a = await step(`GET /availability/byoffer Id=${o.offerId} ${from}..${to}`, () => client.getAvailability(o.offerId, from, to, { isExternal: o.isExternal }));
    availability[o.offerId] = a;
  }
  save("availability.json", availability);

  // Currency behaviour (Q-C7, documented conventions) — test only
  const probeOffer = PRODUCTION ? undefined : sample[0];
  if (probeOffer) {
    for (const [label, query] of [
      ["no CurrencyCode", { Id: probeOffer.offerId, From: from, To: from }],
      ["CurrencyCode=INR", { Id: probeOffer.offerId, From: from, To: from, CurrencyCode: "INR" }],
      ["CurrencyCode=XYZ", { Id: probeOffer.offerId, From: from, To: from, CurrencyCode: "XYZ" }],
    ] as const) {
      const r = await step(`GET /availability/byoffer ${label}`, () => raw.getJson("availability.currency", "/availability/byoffer", "/availability/byoffer", query, anyJson));
      const first = r.ok && Array.isArray(r.value) ? (r.value[0] as { price?: { currency?: unknown; pricePerAdult?: unknown; pricePerAdultUsd?: unknown } } | undefined) : undefined;
      note("Q-C7", `Availability ${label}`, "observed", json(r.ok ? { rows: Array.isArray(r.value) ? r.value.length : null, currency: first?.price?.currency, pricePerAdult: first?.price?.pricePerAdult, pricePerAdultUsd: first?.price?.pricePerAdultUsd } : r.error));
    }
  }

  // Ticket stock (TicketOnly)
  const tickets: Record<string, unknown> = {};
  for (const o of [...byKind("ticket_only", false), ...byKind("ticket_only", true)].slice(0, 5)) {
    tickets[o.offerId] = await step(`GET /tickets/byoffer Id=${o.offerId}`, () => client.getTicketStock(o.offerId));
  }
  save("tickets.json", tickets);
  const ticketOffer = PRODUCTION ? undefined : [...byKind("ticket_only", false), ...byKind("ticket_only", true)][0];
  if (ticketOffer) {
    const r = await step("GET /tickets/byoffer without CurrencyCode", () => raw.getJson("tickets.nocurrency", "/tickets/byoffer", "/tickets/byoffer", { Id: ticketOffer.offerId }, anyJson));
    const price = r.ok ? (r.value as { price?: { currency?: unknown; pricePerAdult?: unknown; pricePerAdultUsd?: unknown } }).price : undefined;
    note("Q-C7", "tickets/byoffer without CurrencyCode", "observed", json(r.ok ? { currency: price?.currency ?? null, pricePerAdult: price?.pricePerAdult, pricePerAdultUsd: price?.pricePerAdultUsd } : r.error));
  }

  // Pickup hotels
  const hotels: Record<string, unknown> = {};
  for (const o of allOffers.filter((x) => !x.isDirectReporting).slice(0, 3)) {
    hotels[o.offerId] = await step(`GET /hotels/foroffer OfferId=${o.offerId}`, () => client.listPickupHotels(o.offerId));
  }
  save("hotels.json", hotels);

  // Booking list — counts and field names only, never guest data (Q-B1, Q-B2). Test only:
  // production bookings hold real guest data and are outside the approved scope.
  const list = PRODUCTION ? null : await step("GET /bookings (summary only)", () =>
    raw.getJson("bookings.list", "/bookings", "/bookings", { From: dubaiDate(-60), To: dubaiDate(120), OnPage: 100 }, anyJson),
  );
  if (!list) {
    // skipped (production)
  } else if (list.ok) {
    const page = list.value as { totalCount?: unknown; data?: Record<string, unknown>[] };
    const rows = Array.isArray(page.data) ? page.data : [];
    const count = (k: string) => rows.reduce<Record<string, number>>((acc, r) => {
      const v = String(r[k]);
      acc[v] = (acc[v] ?? 0) + 1;
      return acc;
    }, {});
    const summary = {
      totalCount: page.totalCount,
      rowsOnPage: rows.length,
      statusCounts: count("status"),
      bookingTypeCounts: count("bookingType"),
      creationStateCounts: count("creationState"),
      fieldNames: rows[0] ? Object.keys(rows[0]).sort() : [],
      hasTicketsDetailsField: rows.some((r) => "ticketsDetails" in r),
    };
    save("bookings.summary.json", summary);
    note("Q-B2", "Booking list visibility", "partial", json(summary));
  } else note("Q-B2", "Booking list", "failed", json(list.error));

  save("events.json", events);
  save("findings.json", findings);
  const failures = events.filter((e) => e.outcome !== "ok").length;
  console.log(`\n${events.length} requests, ${failures} non-ok. Tours: ${tourIds.length}, details parsed: ${details.length}, offers: ${allOffers.length}.`);
  console.log(`Output: ${outDir}`);
}

main().catch((e) => {
  console.error(`traveldesk-probe: aborted (${e instanceof Error ? e.name : "error"})`);
  process.exit(1);
});
