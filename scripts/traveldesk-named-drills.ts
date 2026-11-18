/**
 * TravelDesk named SANDBOX drills (doc 22 §27 A5, §32.15; doc 21 §10.1).
 *
 * The drills the first A5 run left open, each against the TravelDesk TEST API
 * and the LOCAL disposable database, through the real booking engine:
 *
 *   CAD   confirm after deadline: hold a reservation, then let a confirm job
 *         run past the engine's send-by (deadline − 5 min); the engine must
 *         refuse. After TravelDesk's own deadline one raw confirm (outside the
 *         engine) records what TravelDesk answers. Runs together with D3.
 *   D3    hold expiry (CX-1): reserve, never confirm; the watchdog must see
 *         status 7 → 8. Balance read before, during and after.
 *   LATE  late acceptance after a client abort (the D5 pattern):
 *         LATE-A: the engine recovers the aborted reserve by lookup;
 *         LATE-B: a fault injected in the transport reports the aborted
 *         reserve as never sent, so the engine itself closes it
 *         `not_created`; reconciliation must find the booking, flag
 *         `late_acceptance` and re-block it. (Only the engine writes the
 *         row, SUP-20.)
 *         Both: one reserve sent, one booking at TravelDesk per reference.
 *   PAGE  list pagination under insertion: list with small pages (when the
 *         sandbox honours them) while new drill bookings are inserted
 *         between page reads; lookups and reconciliation must neither miss
 *         a booking that existed before the listing nor count one twice.
 *   CX6   deadline calculation: a slot booking on a date where the 100%
 *         window is still open when counted from the slot start but already
 *         closed when counted from the date's midnight; the cancel answer
 *         shows which reference TravelDesk uses (observation only).
 *   CX4   cancel refused: a booking past its 100% window by either
 *         reference; the cancel must be refused and the engine must say
 *         `cancel_refused`. Uses test credit irreversibly when refused.
 *         DRILL_CX4_BOOKING_ID=<engine booking id> re-runs the cancel on a
 *         confirmed booking an earlier drill left past its window (no new
 *         booking, no new credit).
 *   DOC   document retrieval (ticket issuing, last): cheapest LiveBook offer,
 *         one booking; get-by-id with tickets, then the tickets PDF; then a
 *         cancel (Q-T1: does a ticket read block cancel?).
 *   CX5   issued tickets (ticket issuing, last): the TicketOnly offer, one
 *         booking; read its tickets, then try the cancel.
 *
 *   DRILL_ONLY=CAD,D3 | LATE | PAGE | CX6 | CX4 | DOC,CX5 (with DRILL_ALLOW_TICKETS=1)
 *   DRILL_PLAN=1 prints the offer, date and price each selected drill would use, and exits.
 *
 *   DRILL_ONLY=CX6 npm run traveldesk:drills:named:test
 *
 * Safety (same guards as scripts/traveldesk-sandbox-drill.ts):
 *  - Disposable database only (target guard, static and live checks).
 *  - TRAVELDESK_ENV=test and the test host only; bookings enabled in this
 *    process only. The production key file is never read.
 *  - One adult, guest "OUTLY Sandbox Test", remarks marking a test, no phone,
 *    no email.
 *  - Every booking is cancelled at the end where TravelDesk allows it; what
 *    stays open is printed as LEFT OPEN.
 *  - Results go to .traveldesk-probe/named-<timestamp>/ (git-ignored),
 *    without the key, voucher links, ticket codes or PII: ticket answers are
 *    recorded as kind and count, a PDF as size, type and magic bytes.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { z } from "zod";
import { uuidv7 } from "../src/server/lib/ids";
import { bookingFrom, bookingListWire, TravelDeskBookingClient, type TravelDeskBooking } from "../src/server/suppliers/traveldesk/traveldesk.booking";
import { TravelDeskBookingAdapter, type TravelDeskBookingTransport } from "../src/server/suppliers/traveldesk/traveldesk.booking-adapter";
import { TravelDeskReadClient } from "../src/server/suppliers/traveldesk/traveldesk.client";
import { traveldeskConfigFrom, traveldeskConfigProblems, type TravelDeskConfig } from "../src/server/suppliers/traveldesk/traveldesk.config";
import { TravelDeskDocumentSource } from "../src/server/suppliers/traveldesk/traveldesk.documents";
import { isTravelDeskApiError, TravelDeskApiError, TravelDeskHttp, type TravelDeskCallEvent } from "../src/server/suppliers/traveldesk/traveldesk.http";
import type { TicketEvidence } from "../src/server/documents/contracts";
import { validatePdf } from "../src/server/documents/pdf";
import { assertDisposableDbLive, assertDisposableTarget } from "./lib/target-guard";

function fail(message: string): never {
  console.error(`traveldesk-named-drills: ${message}`);
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

const KNOWN = ["CAD", "D3", "LATE", "PAGE", "CX6", "CX4", "DOC", "CX5"];
const TICKET_DRILLS = ["DOC", "CX5"];
const ONLY = (process.env.DRILL_ONLY ?? "").split(",").map((s) => s.trim()).filter(Boolean);
if (!ONLY.length) fail(`set DRILL_ONLY to one or more of ${KNOWN.join(", ")}`);
for (const d of ONLY) if (!KNOWN.includes(d)) fail(`unknown drill ${d}`);
const PLAN = process.env.DRILL_PLAN === "1";
if (!PLAN && ONLY.some((d) => TICKET_DRILLS.includes(d)) && process.env.DRILL_ALLOW_TICKETS !== "1") fail("DOC and CX5 may issue tickets and use test credit irreversibly: set DRILL_ALLOW_TICKETS=1 (A5: run last, cheapest offer, one booking each)");

const LIVE_OFFER = Number(process.env.DRILL_OFFER_ID ?? 62);
const LIVE_TOUR = Number(process.env.DRILL_TOUR_ID ?? 5);
const TICKET_OFFER = Number(process.env.DRILL_TICKET_OFFER_ID ?? 1166);
const TICKET_TOUR = Number(process.env.DRILL_TICKET_TOUR_ID ?? 142);
const RUN = uuidv7().slice(-6).toUpperCase();
const outDir = path.join(".traveldesk-probe", `named-${new Date().toISOString().replace(/[:.]/g, "-")}`);
const DUBAI_OFFSET_MS = 4 * 3_600_000; // Asia/Dubai, no DST

function dubaiDate(offsetDays: number): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Dubai", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date(Date.now() + offsetDays * 86_400_000));
}
/** Midnight of a calendar date in Dubai, as a UTC instant. */
const dubaiMidnight = (date: string) => Date.parse(`${date}T00:00:00Z`) - DUBAI_OFFSET_MS;
const iso = (ms: number) => new Date(ms).toISOString();
const sleep = (ms: number) => new Promise((res) => setTimeout(res, Math.max(0, ms)));
const json = (v: unknown) => JSON.stringify(v, (_k, x) => (typeof x === "bigint" ? x.toString() : x), 2);

let current = "setup";
const calls: (TravelDeskCallEvent & { drill: string; at: string })[] = [];
const observations: { drill: string; at: string; what: string; data: unknown }[] = [];
function observe(what: string, data: unknown) {
  observations.push({ drill: current, at: new Date().toISOString(), what, data });
  console.log(`  [${current}] ${what}: ${json(data).replace(/\s+/g, " ").slice(0, 400)}`);
}

function errorSummary(e: unknown) {
  if (isTravelDeskApiError(e)) return { kind: e.kind, status: e.status, reason: e.reason ?? null, fieldErrors: e.fieldErrors?.map((f) => f.fieldName) ?? null, issues: e.issues ?? null };
  return { kind: "internal", message: e instanceof Error ? e.message.slice(0, 200) : "error" };
}
/** Ticket evidence as kind and count only: never a code. */
function ticketSummary(t: TicketEvidence) {
  if (t.kind === "issued") return { kind: "issued", count: t.set.count };
  if (t.kind === "malformed") return { kind: "malformed", reason: t.reason };
  return { kind: t.kind };
}

async function main() {
  const { prisma } = await import("../src/server/lib/db");
  await assertDisposableDbLive(prisma, { allowTravelDeskTestKey: true });
  const { supplierBookingService: svc } = await import("../src/server/services/supplier-booking.service");
  mkdirSync(outDir, { recursive: true });

  const adapters: TravelDeskBookingAdapter[] = [];
  const onEvent = (e: TravelDeskCallEvent) => {
    calls.push({ ...e, drill: current, at: new Date().toISOString() });
    for (const a of adapters) a.noteCall(e);
  };
  const read = new TravelDeskReadClient(config, { onEvent });
  const client = new TravelDeskBookingClient(config, { onEvent });
  // Raw reads for shape probes (reservation keys, page size). GET only; the same guards and host.
  const rawHttp = new TravelDeskHttp(config, { onEvent, maxConcurrent: 1 });
  const accountId = config.agencyId ?? undefined;

  /** The client with every mutation's error text and ticket answer recorded (kind and count only). */
  function recording(c: TravelDeskBookingClient): TravelDeskBookingTransport {
    async function rec<R>(op: string, fn: () => Promise<R>): Promise<R> {
      try {
        const r = await fn();
        if (r && typeof r === "object" && "tickets" in r) observe(`${op}.tickets`, ticketSummary((r as { tickets: TicketEvidence }).tickets));
        if (r && typeof r === "object" && "booking" in r) {
          const b = (r as { booking: TravelDeskBooking }).booking;
          observe(`${op}.answer`, { id: b.supplierBookingId, status: b.status, statusName: b.statusName, hasTickets: b.hasTickets });
        } else if (r && typeof r === "object" && "supplierBookingId" in r) {
          const b = r as unknown as TravelDeskBooking;
          observe(`${op}.answer`, { id: b.supplierBookingId, status: b.status, statusName: b.statusName, reservationTimeout: b.reservationTimeout, reservationDeadline: b.reservationDeadline });
        } else if (op === "cancel") observe("cancel.answer", r);
        return r;
      } catch (e) {
        observe(`${op}.error`, errorSummary(e));
        throw e;
      }
    }
    return {
      reserve: (b) => rec("reserve", () => c.reserve(b)),
      confirm: (id) => rec("confirm", () => c.confirm(id)),
      create: (b) => rec("create", () => c.create(b)),
      cancel: (id) => rec("cancel", () => c.cancel(id)),
      getReservation: (id) => c.getReservation(id),
      listBookingsPage: (q, p, n) => c.listBookingsPage(q, p, n),
      getBalance: () => c.getBalance(),
    };
  }
  function adapterFor(t: TravelDeskBookingTransport) {
    const a = new TravelDeskBookingAdapter(t, { environment: "test" });
    adapters.push(a);
    return a;
  }
  const transport = recording(client);
  const adapter = adapterFor(transport);

  const supplier = await prisma.supplier.findUnique({ where: { code: "traveldesk" } });
  if (!supplier) fail('no local supplier row "traveldesk" — run the local catalogue sync first');

  async function policyOf(tourId: number) {
    const tour = await prisma.supplierCatalogueItem.findFirst({ where: { supplierId: supplier!.id, environment: "test", kind: "tour", externalId: String(tourId) } });
    const policy = ((tour?.payload as { cancellationPolicy?: { moreThanHours: number; refundPercent: number }[] } | null)?.cancellationPolicy ?? []).slice();
    const full = policy.filter((p) => p.refundPercent >= 100).map((p) => p.moreThanHours);
    return { policy, fullRefundMoreThanHours: full.length ? Math.min(...full) : null };
  }

  async function balance(label: string) {
    const b = await read.getBalance();
    const v = { balance: b.balanceMinor, credit: b.creditFacilityMinor, payable: b.payableBalanceMinor };
    observe(`balance.${label}`, v);
    return v;
  }

  async function rowOn(offerId: number, date: string) {
    const avail = await read.getAvailability(offerId, date, date, { isExternal: false });
    const row = avail.rows.find((r) => r.seatsLeft > 2 && r.price?.isBookable && r.price.perAdultMinor > 0n);
    if (!row || !row.price) fail(`offer ${offerId}: no bookable slot with seats on ${date}`);
    return row;
  }

  type Row = Awaited<ReturnType<typeof rowOn>>;
  type DrillBooking = { name: string; id: string; drill: string };
  const booked: DrillBooking[] = [];
  const leftOpenOnPurpose: { name: string; id: string; why: string }[] = [];

  function liveBase(row: Row, offerId = LIVE_OFFER, tourId = LIVE_TOUR) {
    return {
      environment: "test" as const,
      bookingKind: "live_book" as const,
      tourId,
      offerId,
      serviceDate: row.date,
      slot: { timeSlotId: row.timeSlotId, startMinutes: row.startMinutes, endMinutes: row.endMinutes },
      adults: 1,
      children: 0,
      infants: 0,
      guestName: "OUTLY Sandbox Test",
      remarks: "OUTLY integration sandbox test - automated, will be cancelled. Please ignore.",
      expectedNetMinor: row.price.perAdultMinor,
      expectedNetUsdMinor: row.price.perAdultUsdMinor,
    };
  }

  async function start(name: string, base: ReturnType<typeof liveBase> | Record<string, unknown>, over: Record<string, unknown>) {
    const b = await svc.createIntent(
      null,
      { ...(base as ReturnType<typeof liveBase>), idempotencyKey: `named-${RUN}-${name}`, drill: true, ...over } as Parameters<typeof svc.createIntent>[1],
      { supplierCode: "traveldesk", accountId },
    );
    booked.push({ name, id: b.id, drill: current });
    observe("intent", { name, bookingId: b.id, clientRef: b.clientRef, serviceDate: base.serviceDate, offerId: base.offerId, ...over });
    return b;
  }

  const engineDeps = (a: TravelDeskBookingAdapter, mutationTimeoutMs = config.mutationTimeoutMs) => ({
    adapter: a,
    accountId,
    environment: "test" as const,
    supplierCode: "traveldesk",
    mutationTimeoutMs,
    holder: `named-${RUN}`,
  });

  async function runOnce(label: string, a = adapter, opts: { maxJobs?: number; mutationTimeoutMs?: number } = {}) {
    const r = await svc.runDueJobs(engineDeps(a, opts.mutationTimeoutMs), { budgetMs: 240_000, maxJobs: opts.maxJobs });
    for (const p of r.processed) console.log(`  [${label}] ${p.kind}: ${p.outcome}`);
    return r.processed;
  }

  const stateOf = async (id: string) => (await prisma.supplierBooking.findUniqueOrThrow({ where: { id } })).state;

  /** Run jobs until every booking has left `states`, or the time runs out. */
  async function runUntilLeft(label: string, ids: string[], states: string[], maxMs: number, a = adapter) {
    const end = Date.now() + maxMs;
    while (Date.now() < end) {
      const processed = await runOnce(label, a);
      const left = await prisma.supplierBooking.count({ where: { id: { in: ids }, state: { in: states as never } } });
      if (left === 0) return true;
      if (processed.length === 0) await sleep(5_000);
    }
    return false;
  }

  /** Run jobs until these bookings have no due-now job left (later watchdogs may stay queued). */
  async function runUntilQuiet(label: string, ids: string[], maxMs: number, a = adapter) {
    const end = Date.now() + maxMs;
    while (Date.now() < end) {
      const processed = await runOnce(label, a);
      const due = await prisma.supplierJob.count({ where: { supplierBookingId: { in: ids }, status: { in: ["queued", "running"] }, runAfter: { lte: new Date(Date.now() + 45_000) } } });
      if (due === 0) return true;
      if (processed.length === 0) await sleep(5_000);
    }
    return false;
  }

  async function requestSentCount(id: string, operation: string) {
    return prisma.supplierBookingEvent.count({ where: { supplierBookingId: id, kind: "request_sent", operation } });
  }

  async function cancelAndSettle(ids: string[], label: string) {
    for (const id of ids) {
      const b = await prisma.supplierBooking.findUniqueOrThrow({ where: { id } });
      if (["reserved", "awaiting_payment", "confirmed", "awaiting_external"].includes(b.state)) await svc.requestCancel(id).catch((e) => observe("requestCancel.refused", { id, message: String(e) }));
    }
    await runUntilQuiet(label, ids, 6 * 60_000);
  }

  async function bookingResult(d: DrillBooking) {
    const b = await prisma.supplierBooking.findUniqueOrThrow({ where: { id: d.id } });
    const events = await prisma.supplierBookingEvent.findMany({ where: { supplierBookingId: d.id }, orderBy: { at: "asc" } });
    return {
      name: d.name,
      drill: d.drill,
      clientRef: b.clientRef,
      state: b.state,
      supplierBookingId: b.supplierBookingId,
      supplierStatusCode: b.supplierStatusCode,
      serviceDate: b.serviceDate,
      offerExternalId: b.offerExternalId,
      expectedNetMinor: b.expectedNetMinor,
      chargedNetMinor: b.chargedNetMinor,
      refundMinor: b.refundMinor,
      errorCode: b.errorCode,
      errorMessage: b.errorMessage,
      attentionRequiredAt: b.attentionRequiredAt,
      reservationDeadline: b.reservationDeadline,
      reservedAt: b.reservedAt,
      confirmedAt: b.confirmedAt,
      cancelledAt: b.cancelledAt,
      closedAt: b.closedAt,
      lastResponse: b.lastResponse,
      events: events.map((e) => ({ at: e.at, kind: e.kind, operation: e.operation, httpStatus: e.httpStatus, durationMs: e.durationMs, from: e.fromState, to: e.toState, detail: e.detail })),
    };
  }

  const verdicts: { drill: string; result: "pass" | "fail" | "observed" | "skipped"; summary: string }[] = [];
  const verdict = (result: "pass" | "fail" | "observed" | "skipped", summary: string) => {
    verdicts.push({ drill: current, result, summary });
    console.log(`  [${current}] ${result.toUpperCase()}: ${summary}`);
  };

  async function writeOut(extra: Record<string, unknown> = {}) {
    const results = [];
    for (const d of booked) results.push(await bookingResult(d));
    writeFileSync(path.join(outDir, "results.json"), json({ run: RUN, only: ONLY, verdicts, leftOpenOnPurpose, observations, results, calls, ...extra }));
  }

  /* ------------------------------------------------------------------ plans */
  if (PLAN) {
    for (const d of ONLY) {
      current = d;
      if (d === "CX5") {
        const stock = await read.getTicketStock(TICKET_OFFER);
        observe("plan", { offerId: TICKET_OFFER, tourId: TICKET_TOUR, kind: "ticket_only", adultTicketsLeft: stock.adultTicketsLeft, validUntil: stock.validUntil, perAdultMinor: stock.price.perAdultMinor, policy: await policyOf(TICKET_TOUR) });
      } else {
        const date = d === "CX6" ? dubaiDate(Number(process.env.DRILL_CX6_DAYS ?? 3)) : d === "CX4" ? dubaiDate(Number(process.env.DRILL_CX4_DAYS ?? 2)) : dubaiDate(10);
        const row = await rowOn(LIVE_OFFER, date);
        observe("plan", { offerId: LIVE_OFFER, tourId: LIVE_TOUR, date, slot: row.timeSlotId, startMinutes: row.startMinutes, perAdultMinor: row.price.perAdultMinor, policy: await policyOf(LIVE_TOUR) });
      }
    }
    await prisma.$disconnect();
    return;
  }

  current = "setup";
  const balanceStart = await balance("start");
  let failure: unknown = null;

  try {
    /* -------------------------------------------------- CX6 deadline reference */
    if (ONLY.includes("CX6")) {
      current = "CX6";
      const { policy, fullRefundMoreThanHours: H } = await policyOf(LIVE_TOUR);
      if (H === null) throw new Error("CX6: the tour has no 100% tier");
      const date = dubaiDate(Number(process.env.DRILL_CX6_DAYS ?? 3));
      const row = await rowOn(LIVE_OFFER, date);
      const slotStart = dubaiMidnight(date) + row.startMinutes * 60_000;
      const cut = {
        slotStartDubai: slotStart - H * 3_600_000,
        slotStartAsUtc: Date.parse(`${date}T00:00:00Z`) + row.startMinutes * 60_000 - H * 3_600_000,
        midnightDubai: dubaiMidnight(date) - H * 3_600_000,
        midnightUtc: Date.parse(`${date}T00:00:00Z`) - H * 3_600_000,
      };
      const now = Date.now();
      observe("window", { date, slot: row.timeSlotId, startMinutes: row.startMinutes, policy, fullRefundMoreThanHours: H, now: iso(now), cutoffs: Object.fromEntries(Object.entries(cut).map(([k, v]) => [k, iso(v)])) });
      const discriminating = now > Math.max(cut.midnightDubai, cut.midnightUtc) && now < Math.min(cut.slotStartDubai, cut.slotStartAsUtc) - 10 * 60_000;
      if (!discriminating) {
        verdict("skipped", "now is not between the midnight cut-off and the slot-start cut-off (with 10 min margin); pick DRILL_CX6_DAYS so it is");
      } else {
        const b = await start("CX6", liveBase(row), { mode: "one_step" });
        await runUntilLeft("CX6 create", [b.id], ["queued", "reserving"], 6 * 60_000);
        await runUntilQuiet("CX6 settle", [b.id], 4 * 60_000);
        const st = await stateOf(b.id);
        if (st !== "confirmed") {
          verdict("fail", `create ended ${st}, not confirmed; no cancel attempted`);
        } else {
          const sentAt = Date.now();
          observe("cancel.sending", { at: iso(sentAt), hoursToSlotStartDubai: (slotStart - sentAt) / 3_600_000, hoursToMidnightDubai: (dubaiMidnight(date) - sentAt) / 3_600_000 });
          await svc.requestCancel(b.id);
          await runUntilQuiet("CX6 cancel", [b.id], 6 * 60_000);
          const after = await prisma.supplierBooking.findUniqueOrThrow({ where: { id: b.id } });
          if (after.state === "cancelled")
            verdict("observed", `cancel ACCEPTED ${((slotStart - sentAt) / 3_600_000).toFixed(2)} h before the slot start and ${((dubaiMidnight(date) - sentAt) / 3_600_000).toFixed(2)} h before the date's midnight (Dubai), with a ${H} h 100% tier: TravelDesk does not count from the date's midnight; consistent with the slot start`);
          else {
            verdict("observed", `cancel NOT accepted (${after.state}, ${after.errorCode}): TravelDesk counts from the date's midnight or earlier, not from the slot start`);
            leftOpenOnPurpose.push({ name: "CX6", id: after.supplierBookingId ?? "-", why: "cancel refused inside the slot-start window; serves as CX-4 evidence" });
          }
        }
      }
      await writeOut();
    }

    /* ------------------------------------------------------- CX4 cancel refused */
    if (ONLY.includes("CX4")) {
      current = "CX4";
      const { policy, fullRefundMoreThanHours: H } = await policyOf(LIVE_TOUR);
      if (H === null) throw new Error("CX4: the tour has no 100% tier");
      const date = dubaiDate(Number(process.env.DRILL_CX4_DAYS ?? 2));
      const row = await rowOn(LIVE_OFFER, date);
      const slotStart = dubaiMidnight(date) + row.startMinutes * 60_000;
      const now = Date.now();
      const latestCut = Math.max(slotStart, Date.parse(`${date}T00:00:00Z`) + row.startMinutes * 60_000) - H * 3_600_000;
      observe("window", { date, slot: row.timeSlotId, startMinutes: row.startMinutes, policy, fullRefundMoreThanHours: H, now: iso(now), latest100PercentCutoff: iso(latestCut) });
      // Re-run on a booking an earlier drill already left past its window (DRILL_CX4_BOOKING_ID, the engine's id), so no new credit is used.
      const reuse = process.env.DRILL_CX4_BOOKING_ID?.trim();
      const reused = reuse ? await prisma.supplierBooking.findUnique({ where: { id: reuse } }) : null;
      if (reuse && (!reused || reused.environment !== "test" || reused.state !== "confirmed" || !reused.supplierBookingId)) throw new Error(`CX4: booking ${reuse} is not a confirmed TEST booking`);
      if (reused) observe("reuse", { bookingId: reused.id, supplierBookingId: reused.supplierBookingId, serviceDate: reused.serviceDate, errorCode: reused.errorCode });
      if (!reused && now <= latestCut + 10 * 60_000) {
        verdict("skipped", "the date is still inside its 100% window by some reference; pick a nearer date");
      } else {
        let b: { id: string };
        if (reused) {
          b = reused;
          booked.push({ name: "CX4", id: reused.id, drill: "CX4" });
        } else {
          b = await start("CX4", liveBase(row), { mode: "one_step" });
          await runUntilLeft("CX4 create", [b.id], ["queued", "reserving"], 6 * 60_000);
          await runUntilQuiet("CX4 settle", [b.id], 4 * 60_000);
        }
        const st = await stateOf(b.id);
        if (st !== "confirmed") verdict("fail", `create ended ${st}, not confirmed; no cancel attempted`);
        else {
          await svc.requestCancel(b.id);
          await runUntilQuiet("CX4 cancel", [b.id], 6 * 60_000);
          const after = await prisma.supplierBooking.findUniqueOrThrow({ where: { id: b.id } });
          const cancelErr = observations.filter((o) => o.drill === "CX4" && o.what === "cancel.error").pop();
          if (after.state === "cancel_refused") {
            verdict("pass", `TravelDesk refused (${json(cancelErr?.data).replace(/\s+/g, " ")}); engine state cancel_refused`);
            leftOpenOnPurpose.push({ name: "CX4", id: after.supplierBookingId ?? "-", why: "cancel refused by TravelDesk (past the 100% window)" });
          } else if (after.state === "cancelled") verdict("observed", "TravelDesk ACCEPTED a cancel past the 100% window by either reference: the sandbox does not enforce the policy for this offer");
          else {
            verdict("fail", `engine ended ${after.state} (${after.errorCode}); TravelDesk said ${json(cancelErr?.data).replace(/\s+/g, " ")}`);
            leftOpenOnPurpose.push({ name: "CX4", id: after.supplierBookingId ?? "-", why: `engine ${after.state}` });
          }
        }
      }
      await writeOut();
    }

    /* --------------------------------------------- CAD + D3 (one 17-min wait) */
    if (ONLY.includes("CAD") || ONLY.includes("D3")) {
      current = "CAD";
      const date = dubaiDate(Number(process.env.DRILL_HOLD_DAYS ?? 6));
      const row = await rowOn(LIVE_OFFER, date);
      const holds: DrillBooking[] = [];
      const t0 = Date.now();
      for (const name of ["CAD", "D3"].filter((n) => ONLY.includes(n))) {
        current = name;
        const b = await start(name, liveBase(row), { mode: "two_step", afterReserve: "hold" });
        holds.push({ name, id: b.id, drill: name });
      }
      current = "CAD";
      await runUntilLeft("hold reserve", holds.map((h) => h.id), ["queued", "reserving"], 6 * 60_000);
      const bAfter = await balance("after_reserve");
      const rows = await Promise.all(holds.map((h) => prisma.supplierBooking.findUniqueOrThrow({ where: { id: h.id } })));
      for (const [i, r] of rows.entries()) {
        current = holds[i].name;
        const sent = await prisma.supplierBookingEvent.findFirst({ where: { supplierBookingId: r.id, kind: "request_sent" }, orderBy: { at: "asc" } });
        observe("reserved", { state: r.state, supplierBookingId: r.supplierBookingId, requestSentAt: sent?.at, reservationDeadline: r.reservationDeadline, deadlineMinusSentMin: sent && r.reservationDeadline ? (r.reservationDeadline.getTime() - sent.at.getTime()) / 60_000 : null });
        if (r.supplierBookingId) {
          // Shape probe on the reservation read (no ticket data): key names, timeout, raw deadline string, any policy field.
          const raw = (await rawHttp.getJson("bookings.reservation", "/bookings/reservation/{id}", `/bookings/reservation/${Number(r.supplierBookingId)}`, undefined, z.record(z.string(), z.unknown()))) as Record<string, unknown>;
          observe("reservation.raw", { keys: Object.keys(raw).sort(), status: raw.status, reservationTimeout: raw.reservationTimeout, reservationDeadline: raw.reservationDeadline, cancellationPolicy: raw.cancellationPolicy ?? null });
        }
      }
      current = "CAD";
      const cad = rows.find((_r, i) => holds[i].name === "CAD");
      const deadline = rows.find((r) => r.reservationDeadline)?.reservationDeadline?.getTime() ?? t0 + 15 * 60_000;
      /**
       * Queue a confirm job now, as a stalled worker or a late hook would leave one. Same row as the engine's
       * own enqueue (priority 20, send deadline = deadline − 5 min); `run_after` on this process's clock, like
       * the engine's claim compares it, so a database clock ahead of ours cannot hide the job.
       */
      async function lateConfirmJob(id: string, reservationDeadline: Date) {
        const runAfter = new Date(Date.now() - 1_000);
        await prisma.$executeRaw`
          INSERT INTO supplier_jobs (id, kind, supplier_booking_id, dedupe_key, run_after, status, deadline_at, priority, updated_at)
          VALUES (${uuidv7()}::uuid, 'confirm', ${id}::uuid, ${`confirm:${id}`}, ${runAfter}, 'queued', ${new Date(reservationDeadline.getTime() - 5 * 60_000)}::timestamptz, 20, now())
          ON CONFLICT (dedupe_key) DO UPDATE SET status = 'queued', run_after = ${runAfter}, attempts = 0, locked_by = NULL, locked_until = NULL, updated_at = now()`;
      }
      if (cad && cad.state === "reserved" && cad.reservationDeadline) {
        // A confirm job that runs late, as from a stalled worker or a late hook: past the engine's send-by, before TravelDesk's deadline.
        const at = cad.reservationDeadline.getTime() - 4 * 60_000;
        console.log(`  [CAD] waiting until ${iso(at)} (deadline − 4 min) to run a late confirm job`);
        await sleep(at - Date.now());
        await lateConfirmJob(cad.id, cad.reservationDeadline);
        const processed = await runOnce("CAD late confirm");
        const confirmsSent = await requestSentCount(cad.id, "bookings.confirm");
        const after = await prisma.supplierBooking.findUniqueOrThrow({ where: { id: cad.id } });
        observe("engine.late_confirm", { outcomes: processed.map((p) => `${p.kind}:${p.outcome}`), confirmRequestsSent: confirmsSent, state: after.state, errorCode: after.errorCode, attention: after.attentionRequiredAt !== null, msLeftAtRun: cad.reservationDeadline.getTime() - Date.now() });
        const engineRefused = confirmsSent === 0 && processed.some((p) => p.kind === "confirm" && p.outcome === "deadline_too_close");

        // Past TravelDesk's own deadline, one raw confirm outside the engine: what does TravelDesk answer?
        const rawAt = cad.reservationDeadline.getTime() + 20_000;
        console.log(`  [CAD] waiting until ${iso(rawAt)} (deadline + 20 s) for one raw confirm`);
        await sleep(rawAt - Date.now());
        let rawOutcome = "error";
        try {
          await transport.confirm(cad.supplierBookingId!);
          rawOutcome = "accepted";
        } catch {
          rawOutcome = "refused";
        }
        // A second engine attempt after the deadline: the engine must refuse again without sending.
        await lateConfirmJob(cad.id, cad.reservationDeadline);
        const processed2 = await svc.runDueJobs(engineDeps(adapter), { budgetMs: 240_000, maxJobs: 1 });
        const confirmsSent2 = await requestSentCount(cad.id, "bookings.confirm");
        observe("engine.after_deadline_confirm", { outcomes: processed2.processed.map((p) => `${p.kind}:${p.outcome}`), confirmRequestsSent: confirmsSent2 });
        if (engineRefused && confirmsSent2 === 0) verdict("pass", `engine refused the late confirm (deadline_too_close at deadline − 4 min; again after the deadline) and sent none; TravelDesk answered the raw confirm after its deadline: ${rawOutcome}`);
        else verdict("fail", `engine sent ${confirmsSent2} confirm(s) or did not refuse with deadline_too_close; raw confirm: ${rawOutcome}`);
      }
      // D3: let the watchdog see the hold end.
      current = "D3";
      const mid = Math.max(0, deadline - 60_000 - Date.now());
      if (mid > 0) {
        console.log(`  [D3] waiting until ${iso(deadline - 60_000)} (deadline − 1 min)`);
        await sleep(mid);
        await balance("deadline_minus_1min");
      }
      await runUntilLeft("hold expiry", holds.map((h) => h.id), ["reserved"], Math.max(0, deadline - Date.now()) + 6 * 60_000);
      await runUntilQuiet("hold expiry settle", holds.map((h) => h.id), 3 * 60_000);
      const bExpired = await balance("after_expiry");
      for (const h of holds) {
        current = h.name;
        const r = await prisma.supplierBooking.findUniqueOrThrow({ where: { id: h.id } });
        const polls = await prisma.supplierBookingEvent.findMany({ where: { supplierBookingId: h.id, kind: "poll" }, orderBy: { at: "asc" } });
        observe("final", { state: r.state, supplierStatusCode: r.supplierStatusCode, refundMinor: r.refundMinor, closedAt: r.closedAt, watchdogReads: polls.map((p) => ({ at: p.at, detail: p.detail })) });
        if (h.name === "D3") {
          if (r.state === "expired" && r.supplierStatusCode === 8)
            verdict("pass", `status 7 → 8 seen by the watchdog; engine expired; balance/credit/payable after reserve ${bAfter.balance}/${bAfter.credit}/${bAfter.payable}, after expiry ${bExpired.balance}/${bExpired.credit}/${bExpired.payable}`);
          else verdict("fail", `ended ${r.state} status ${r.supplierStatusCode}`);
        }
      }
      current = "CAD";
      await writeOut();
    }

    /* ------------------------------------------------- LATE (client abort) */
    if (ONLY.includes("LATE")) {
      current = "LATE";
      const date = dubaiDate(Number(process.env.DRILL_LATE_DAYS ?? 7));
      const row = await rowOn(LIVE_OFFER, date);
      const tinyMs = Number(process.env.DRILL_TINY_TIMEOUT_MS ?? 400);
      const impatientClient = new TravelDeskBookingClient({ ...config, mutationTimeoutMs: tinyMs }, { onEvent });
      const impatient = adapterFor(recording(impatientClient));
      // LATE-B fault injection, in the transport only: the abort is reported as "never sent" (`busy`), so the
      // engine itself closes the row `not_created` while TravelDesk may still accept it. Only the engine writes
      // the row (SUP-20); nothing is resent.
      const impatientLiar = recording(impatientClient);
      const lying = adapterFor({
        ...impatientLiar,
        reserve: async (body) => {
          try {
            return await impatientLiar.reserve(body);
          } catch (e) {
            if (isTravelDeskApiError(e) && e.kind === "timeout") {
              observe("fault_injected", { from: "timeout", reportedAs: "busy (not sent)" });
              throw new TravelDeskApiError("busy", "bookings.reserve", { message: "drill fault injection: a sent request reported as never sent" });
            }
            throw e;
          }
        },
      });
      const ids: Record<string, string> = {};
      for (const name of ["LATE-A", "LATE-B"]) {
        const b = await start(name, liveBase(row), { mode: "two_step", afterReserve: "hold" });
        ids[name] = b.id;
        // Only this reserve, through the impatient client.
        for (let i = 0; i < 5 && (await stateOf(b.id)) === "queued"; i++) await runOnce(`${name} send`, name === "LATE-B" ? lying : impatient, { maxJobs: 1, mutationTimeoutMs: tinyMs });
        const st = await prisma.supplierBooking.findUniqueOrThrow({ where: { id: b.id } });
        observe("after_abort", { name, state: st.state, errorCode: st.errorCode, closed: st.closedAt !== null, reserveRequestsSent: await requestSentCount(b.id, "bookings.reserve") });
      }
      // LATE-A: recovery by lookup.
      current = "LATE";
      await runUntilLeft("LATE-A recover", [ids["LATE-A"]], ["outcome_unknown", "queued", "reserving"], 6 * 60_000);
      // LATE-B: reconciliation must find it, flag it and re-block it.
      await sleep(5_000);
      const rec = await svc.reconcile({ adapter, environment: "test", supplierCode: "traveldesk", accountId });
      const bRow = await prisma.supplierBooking.findUniqueOrThrow({ where: { id: ids["LATE-B"] } });
      const alerts = await prisma.supplierBookingEvent.findMany({ where: { supplierBookingId: ids["LATE-B"], kind: "alert" } });
      observe("reconcile", { issues: rec.issues, reblocked: rec.reblocked, listComplete: rec.listComplete, skipped: rec.skipped ?? null, lateB: { state: bRow.state, errorCode: bRow.errorCode, attention: bRow.attentionRequiredAt !== null, alerts: alerts.map((a) => a.detail) } });
      await runUntilLeft("LATE-B recover", [ids["LATE-B"]], ["outcome_unknown"], 6 * 60_000);
      const checks: Record<string, unknown> = {};
      let ok = true;
      for (const name of ["LATE-A", "LATE-B"]) {
        const r = await prisma.supplierBooking.findUniqueOrThrow({ where: { id: ids[name] } });
        const found = await adapter.findByClientRef(r.clientRef, { serviceDate: date, offerExternalId: String(LIVE_OFFER) });
        const sent = await requestSentCount(r.id, "bookings.reserve");
        checks[name] = { state: r.state, errorCode: r.errorCode, attention: r.attentionRequiredAt !== null, supplierBookingId: r.supplierBookingId, reserveRequestsSent: sent, matchesAtTravelDesk: found.matches.length, listComplete: found.complete };
        if (sent !== 1 || found.matches.length > 1) ok = false;
      }
      observe("checks", checks);
      const lateBFlagged = alerts.some((a) => (a.detail as { reason?: string } | null)?.reason === "late_acceptance") && rec.reblocked >= 1;
      const a = checks["LATE-A"] as { state: string; matchesAtTravelDesk: number };
      const bb = checks["LATE-B"] as { state: string; attention: boolean; matchesAtTravelDesk: number };
      if (ok && a.state === "reserved" && lateBFlagged && bb.state === "reserved" && bb.attention)
        verdict("pass", "LATE-A recovered by lookup (reserved); LATE-B found by reconciliation, flagged late_acceptance, re-blocked and recovered with attention kept; one reserve sent and one TravelDesk booking per reference");
      else if (a.matchesAtTravelDesk === 0 && bb.matchesAtTravelDesk === 0) verdict("observed", "TravelDesk did not accept either aborted reserve: no late acceptance to find");
      else verdict("fail", `see checks: ${json(checks).replace(/\s+/g, " ")}`);
      await cancelAndSettle(Object.values(ids), "LATE cancel");
      await writeOut();
    }

    /* ------------------------------------------ PAGE (pagination + insertion) */
    if (ONLY.includes("PAGE")) {
      current = "PAGE";
      const date = dubaiDate(Number(process.env.DRILL_PAGE_DAYS ?? 8));
      const row = await rowOn(LIVE_OFFER, date);
      const SMALL = Number(process.env.DRILL_PAGE_SIZE ?? 2);
      const listQuery = (q: { from: string; to: string; offerId?: number }, page: number, onPage: number) => ({ Page: page, OnPage: onPage, From: q.from, To: q.to, OffersIds: q.offerId ? [q.offerId] : undefined });
      // Does TravelDesk honour a page below 100? (The client clamps to 100, after the spec, L392.)
      const probe = await rawHttp.getJson("bookings.list", "/bookings", "/bookings", listQuery({ from: dubaiDate(-7), to: dubaiDate(90) }, 1, SMALL), bookingListWire);
      const honoured = (probe.data ?? []).length <= SMALL && probe.totalCount > SMALL;
      observe("page_size_probe", { asked: SMALL, echoedOnPage: probe.onPage, rows: (probe.data ?? []).length, totalCount: probe.totalCount, honoured });

      const base: string[] = [];
      for (let i = 1; i <= 3; i++) base.push((await start(`PAGE-${i}`, liveBase(row), { mode: "two_step", afterReserve: "hold" })).id);
      await runUntilLeft("PAGE reserve", base, ["queued", "reserving"], 6 * 60_000);
      const inserted: string[] = [];
      let n = 0;
      async function insertOne() {
        n++;
        const b = await start(`PAGE-INS-${n}`, liveBase(row), { mode: "two_step", afterReserve: "hold" });
        inserted.push(b.id);
        await runUntilLeft(`PAGE insert ${n}`, [b.id], ["queued", "reserving"], 4 * 60_000);
        observe("inserted", { n, state: await stateOf(b.id), at: new Date().toISOString() });
      }
      // A transport whose list pages are small, with an insertion hook after page 1 of chosen passes.
      let pass = 0;
      let insertOnPasses = new Set<number>();
      const pageSize = honoured ? SMALL : 100;
      const pagesRead: { pass: number; page: number; rows: number; totalCount: number }[] = [];
      const small: TravelDeskBookingTransport = {
        ...transport,
        listBookingsPage: async (q, page) => {
          if (page === 1) pass++;
          const wire = await rawHttp.getJson("bookings.list", "/bookings", "/bookings", listQuery(q, page, pageSize), bookingListWire);
          const rows = (wire.data ?? []).map(bookingFrom);
          pagesRead.push({ pass, page, rows: rows.length, totalCount: wire.totalCount });
          if (page === 1 && insertOnPasses.has(pass)) await insertOne();
          return { rows, totalCount: wire.totalCount };
        },
      };
      const smallAdapter = adapterFor(small);
      const refsOf = async (ids: string[]) => (await prisma.supplierBooking.findMany({ where: { id: { in: ids } }, select: { id: true, clientRef: true } })).map((r) => r.clientRef);

      const scenarios: Record<string, unknown> = {};
      let ok = true;
      for (const [label, plan] of [
        ["insert during pass 1", [1]],
        ["insert during passes 1 and 2", [1, 2]],
      ] as const) {
        const before = await refsOf([...base, ...inserted]);
        pass = 0;
        pagesRead.length = 0;
        insertOnPasses = new Set(plan);
        const listing = await smallAdapter.listWindow({ from: date, to: date });
        insertOnPasses = new Set();
        const refs = listing.snapshots.map((s) => s.bookingReference ?? "");
        const ids = listing.snapshots.map((s) => s.ref);
        const missing = before.filter((r) => !refs.includes(r));
        const dupRefs = refs.filter((r, i) => r && refs.indexOf(r) !== i);
        const dupIds = ids.filter((r, i) => ids.indexOf(r) !== i);
        // Every booking that existed before the listing, looked up by reference with the same small pages.
        const lookups = [];
        for (const r of before) {
          const f = await smallAdapter.findByClientRef(r, { serviceDate: date, offerExternalId: String(LIVE_OFFER) });
          lookups.push({ ref: r.slice(-6), matches: f.matches.length, complete: f.complete });
        }
        scenarios[label] = { pages: [...pagesRead], listed: listing.snapshots.length, complete: listing.complete, missingThatExistedBefore: missing.length, duplicateRefs: dupRefs.length, duplicateIds: dupIds.length, lookups };
        if (dupRefs.length || dupIds.length) ok = false;
        if (listing.complete && missing.length) ok = false;
        if (lookups.some((l) => l.matches !== 1)) ok = false;
      }
      // Reconciliation over its full window with the same small pages, one insertion during its first pass.
      pass = 0;
      pagesRead.length = 0;
      insertOnPasses = new Set([1]);
      const rec = await svc.reconcile({ adapter: smallAdapter, environment: "test", supplierCode: "traveldesk", accountId });
      insertOnPasses = new Set();
      const uniqueIds = new Set<string>();
      scenarios["reconcile with insertion"] = { pages: pagesRead.length, supplierListed: rec.supplierListed, ours: rec.ours, other: rec.otherBookings, listComplete: rec.listComplete, issues: rec.issues, skipped: rec.skipped ?? null };
      // Count check: the same window read again now, with full pages and no insertion.
      const full = await client.listBookings({ from: rec.window.from, to: rec.window.to });
      for (const b of full) uniqueIds.add(b.supplierBookingId);
      (scenarios["reconcile with insertion"] as Record<string, unknown>).fullListNow = uniqueIds.size;
      if (rec.issues.length) ok = false;
      if (rec.supplierListed > uniqueIds.size) ok = false; // more than exist: a double count
      observe("scenarios", scenarios);
      if (!honoured) verdict(ok ? "observed" : "fail", `TravelDesk ignores OnPage below 100, so every list here is one page: insertion between page reads cannot be produced without 100+ bookings; single-page lookups and reconciliation with insertion were exact (${ok ? "no miss, no double count" : "see scenarios"})`);
      else verdict(ok ? "pass" : "fail", ok ? `pages of ${SMALL}: no booking that existed before a listing was missed when the listing said complete, none counted twice, every lookup found exactly one; reconciliation with an insertion: 0 issues` : "see scenarios");
      await cancelAndSettle([...base, ...inserted], "PAGE cancel");
      await writeOut();
    }

    /* ------------------------------------ DOC (ticket issuing; LiveBook, Q-T1) */
    if (ONLY.includes("DOC")) {
      current = "DOC";
      const date = dubaiDate(Number(process.env.DRILL_DOC_DAYS ?? 10));
      const row = await rowOn(LIVE_OFFER, date);
      console.log(`  [DOC] offer ${LIVE_OFFER} on ${date} slot ${row.timeSlotId}, net ${row.price.perAdultMinor} AED minor per adult, one adult`);
      const b = await start("DOC", liveBase(row), { mode: "one_step" });
      await runUntilLeft("DOC create", [b.id], ["queued", "reserving"], 6 * 60_000);
      await runUntilQuiet("DOC settle", [b.id], 4 * 60_000);
      const r = await prisma.supplierBooking.findUniqueOrThrow({ where: { id: b.id } });
      if (r.state !== "confirmed" || !r.supplierBookingId) verdict("fail", `create ended ${r.state}`);
      else {
        const docs = new TravelDeskDocumentSource(client);
        const t = await docs.readTickets(r.supplierBookingId);
        observe("document_read", t.kind === "found" ? { kind: "found", identityMatches: t.identity.supplierBookingId === r.supplierBookingId && t.identity.bookingReference === r.clientRef, evidence: ticketSummary(t.evidence) } : t);
        const pdf = await docs.fetchTicketsPdf(r.supplierBookingId, { maxBytes: 10 * 1024 * 1024 });
        observe("tickets_pdf", pdf.kind === "ok" ? { kind: "ok", bytes: pdf.bytes.byteLength, declaredType: pdf.declaredType, magic: Buffer.from(pdf.bytes.slice(0, 5)).toString("latin1").replace(/[^\x20-\x7e]/g, "."), isPdf: Buffer.from(pdf.bytes.slice(0, 4)).toString("latin1") === "%PDF", documentServiceVerdict: (() => { const v = validatePdf(pdf.bytes, { maxBytes: 10 * 1024 * 1024 }); return v.ok ? "ok" : v.reason; })() } : pdf);
        await svc.requestCancel(b.id);
        await runUntilQuiet("DOC cancel", [b.id], 6 * 60_000);
        const after = await prisma.supplierBooking.findUniqueOrThrow({ where: { id: b.id } });
        if (after.state === "cancelled") verdict("observed", `documents read (${t.kind}); cancel AFTER the ticket read and PDF download was accepted (status 4): on this LiveBook offer a ticket read does not block cancel`);
        else {
          verdict("observed", `cancel after the ticket read NOT accepted: engine ${after.state} (${after.errorCode})`);
          leftOpenOnPurpose.push({ name: "DOC", id: after.supplierBookingId ?? "-", why: "cancel refused after the document read" });
        }
      }
      await writeOut();
    }

    /* ----------------------------------------- CX5 (ticket issuing; TicketOnly) */
    if (ONLY.includes("CX5")) {
      current = "CX5";
      const stock = await read.getTicketStock(TICKET_OFFER);
      const date = dubaiDate(Number(process.env.DRILL_CX5_DAYS ?? 10));
      console.log(`  [CX5] TicketOnly offer ${TICKET_OFFER} on ${date}, net ${stock.price.perAdultMinor} AED minor per adult, ${stock.adultTicketsLeft} adult tickets left, one adult`);
      if (stock.adultTicketsLeft < 1 || !stock.price.isBookable || stock.price.perAdultMinor <= 0n) verdict("skipped", "no adult ticket in stock or not bookable");
      else {
        const base = {
          environment: "test" as const,
          bookingKind: "ticket_only" as const,
          tourId: TICKET_TOUR,
          offerId: TICKET_OFFER,
          serviceDate: date,
          slot: null,
          adults: 1,
          children: 0,
          infants: 0,
          guestName: "OUTLY Sandbox Test",
          remarks: "OUTLY integration sandbox test - automated, will be cancelled. Please ignore.",
          expectedNetMinor: stock.price.perAdultMinor,
          expectedNetUsdMinor: stock.price.perAdultUsdMinor,
        };
        const b = await start("CX5", base, { mode: "one_step" });
        await runUntilLeft("CX5 create", [b.id], ["queued", "reserving"], 6 * 60_000);
        await runUntilQuiet("CX5 settle", [b.id], 4 * 60_000);
        const r = await prisma.supplierBooking.findUniqueOrThrow({ where: { id: b.id } });
        observe("created", { state: r.state, errorCode: r.errorCode, supplierBookingId: r.supplierBookingId, supplierStatusCode: r.supplierStatusCode });
        if (!r.supplierBookingId) verdict("fail", `create ended ${r.state} without a TravelDesk id`);
        else {
          const docs = new TravelDeskDocumentSource(client);
          const t = await docs.readTickets(r.supplierBookingId);
          observe("document_read", t.kind === "found" ? { kind: "found", identityMatches: t.identity.supplierBookingId === r.supplierBookingId && t.identity.bookingReference === r.clientRef, evidence: ticketSummary(t.evidence) } : t);
          if (["confirmed", "reserved", "awaiting_external"].includes(r.state)) {
            await svc.requestCancel(b.id);
            await runUntilQuiet("CX5 cancel", [b.id], 6 * 60_000);
          }
          const after = await prisma.supplierBooking.findUniqueOrThrow({ where: { id: b.id } });
          const cancelErr = observations.filter((o) => o.drill === "CX5" && o.what === "cancel.error").pop();
          if (after.state === "cancelled") verdict("observed", "TicketOnly booking with tickets read was CANCELLED (status 4)");
          else {
            verdict(after.state === "cancel_refused" ? "pass" : "observed", `cancel after the ticket read: engine ${after.state} (${after.errorCode}); TravelDesk said ${json(cancelErr?.data ?? null).replace(/\s+/g, " ")}`);
            leftOpenOnPurpose.push({ name: "CX5", id: after.supplierBookingId ?? "-", why: "TicketOnly with issued tickets: not cancellable" });
          }
        }
      }
      await writeOut();
    }
  } catch (e) {
    failure = e;
    console.error(`drill ${current} failed; cleaning up:`, e);
  }

  /* ------------------------------------------------ cleanup and reconciliation */
  current = "cleanup";
  await cancelAndSettle(
    booked.map((d) => d.id),
    "cleanup",
  );
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
  for (const v of verdicts) console.log(`  ${v.drill}: ${v.result.toUpperCase()} — ${v.summary}`);
  console.log(`balance / credit / payable start ${balanceStart.balance} / ${balanceStart.credit} / ${balanceStart.payable}, end ${balanceEnd.balance} / ${balanceEnd.credit} / ${balanceEnd.payable} (minor units)`);
  console.log(`reconciliation: ${reconcile.issues.length} difference(s); ${reconcile.supplierListed} listed, ${reconcile.ours} ours, ${reconcile.otherBookings} other, complete ${reconcile.listComplete}`);
  for (const i of reconcile.issues) console.log(`  ${i.kind}: ${i.reference} #${i.supplierBookingId} ours ${i.ours} theirs ${i.theirs}`);
  if (stillOpen.length) console.error(`OPEN ON TRAVELDESK TEST: ${stillOpen.map((s) => `${s.name} #${s.id} status ${s.supplierStatus} (engine ${s.state})`).join(", ")}`);
  if (leftOpenOnPurpose.length) console.error(`left open by design: ${leftOpenOnPurpose.map((s) => `${s.name} #${s.id} (${s.why})`).join(", ")}`);
  console.log(`written: ${outDir}/results.json`);
  if (failure || verdicts.some((v) => v.result === "fail") || reconcile.issues.length) process.exitCode = 1;
  await prisma.$disconnect();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
