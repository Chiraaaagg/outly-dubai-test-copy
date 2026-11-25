/**
 * TravelDesk SANDBOX booking drills (docs/backend/21 §10, §16; Stage 2).
 *
 * Runs the booking engine end to end against the TravelDesk TEST API and the
 * LOCAL database: real reserve / confirm / create / cancel calls, each one
 * followed by a cancel, so nothing is left open on the test account.
 *
 *   D1  reserve → confirm → cancel (inside the 100% refund window)
 *   D2  reserve → cancel (release a reservation)
 *   D3  reserve and hold, never confirm: the watchdog must see it time out
 *       (CX-1, about 17 minutes; opt-in with DRILL_ONLY=D3)
 *   D4  one-step create → cancel
 *   D5  reserve with a client timeout far below TravelDesk's response time, so
 *       the engine sees an unknown outcome and must recover it by lookup
 *       (never by resending); then cancel whatever it finds
 *
 * Safety:
 *  - Refuses any database but the disposable test instance (target guard,
 *    scripts/lib/target-guard.ts: static checks and the live marker check).
 *  - Refuses unless TRAVELDESK_ENV=test and the base URL is the test host. The
 *    production key file is never read. Bookings are enabled in THIS process
 *    only; the env files keep TRAVELDESK_BOOKINGS_ENABLED=false.
 *  - Guest name "OUTLY Sandbox Test", remarks mark the booking as a test, no
 *    phone, no email; one adult per booking.
 *  - Results go to .traveldesk-probe/drill-<timestamp>/ (git-ignored), without
 *    the key, voucher links or ticket codes.
 *
 *   npm run traveldesk:drill:test
 */
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { uuidv7 } from "../src/server/lib/ids";
import { TravelDeskBookingClient } from "../src/server/suppliers/traveldesk/traveldesk.booking";
import { TravelDeskBookingAdapter } from "../src/server/suppliers/traveldesk/traveldesk.booking-adapter";
import { TravelDeskReadClient } from "../src/server/suppliers/traveldesk/traveldesk.client";
import { traveldeskConfigFrom, traveldeskConfigProblems, type TravelDeskConfig } from "../src/server/suppliers/traveldesk/traveldesk.config";
import type { TravelDeskCallEvent } from "../src/server/suppliers/traveldesk/traveldesk.http";
import { assertDisposableDbLive, assertDisposableTarget } from "./lib/target-guard";

function fail(message: string): never {
  console.error(`traveldesk-sandbox-drill: ${message}`);
  process.exit(2);
}

const dbUrl = process.env.DATABASE_URL;
if (!dbUrl) fail("DATABASE_URL missing (.env.local)");
let dbHost = "";
try {
  dbHost = new URL(dbUrl).hostname;
} catch {
  fail("DATABASE_URL is not a URL");
}
if (!["localhost", "127.0.0.1", "::1", "[::1]"].includes(dbHost)) fail(`refusing: DATABASE_URL host "${dbHost}" is not local`);
try {
  // Shared target guard (scripts/lib/target-guard.ts): disposable database only; the TravelDesk TEST key is the one credential allowed.
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

const OFFER_ID = Number(process.env.DRILL_OFFER_ID ?? 62);
const ONLY = (process.env.DRILL_ONLY ?? "D1,D2,D4,D5").split(",");
const RUN = uuidv7().slice(-6).toUpperCase();
const outDir = path.join(".traveldesk-probe", `drill-${new Date().toISOString().replace(/[:.]/g, "-")}`);
const calls: TravelDeskCallEvent[] = [];

function dubaiDate(offsetDays: number): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Dubai",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date(Date.now() + offsetDays * 86_400_000));
}

const json = (v: unknown) => JSON.stringify(v, (_k, x) => (typeof x === "bigint" ? x.toString() : x), 2);

async function main() {
  const { prisma } = await import("../src/server/lib/db");
  await assertDisposableDbLive(prisma, { allowTravelDeskTestKey: true });
  const { supplierBookingService: svc } = await import("../src/server/services/supplier-booking.service");
  mkdirSync(outDir, { recursive: true });
  const onEvent = (e: TravelDeskCallEvent) => calls.push(e);
  const read = new TravelDeskReadClient(config, { onEvent });
  const client = new TravelDeskBookingClient(config, { onEvent });
  const adapter = new TravelDeskBookingAdapter(client, { environment: "test" });
  const accountId = config.agencyId ?? undefined;

  const supplier = await prisma.supplier.findUnique({
    where: { code: "traveldesk" },
  });
  if (!supplier) fail('no local supplier row "traveldesk" — run npm run traveldesk:sync:local first');

  const balanceBefore = await read.getBalance();
  const from = dubaiDate(5);
  const avail = await read.getAvailability(OFFER_ID, from, dubaiDate(11), {
    isExternal: false,
  });
  const row = avail.rows.find((r) => r.seatsLeft > 2 && r.price?.isBookable && r.price.perAdultMinor > 0n);
  if (!row || !row.price) fail(`offer ${OFFER_ID}: no bookable date with seats between ${from} and ${dubaiDate(11)}`);
  console.log(`offer ${OFFER_ID} on ${row.date} slot ${row.timeSlotId} (${row.startMinutes}-${row.endMinutes}), ${row.seatsLeft} seats`);

  const base = {
    environment: "test" as const,
    bookingKind: "live_book" as const,
    // Stored for reference only; TravelDesk books by offer. Test offer 62 belongs to tour 5.
    tourId: Number(process.env.DRILL_TOUR_ID ?? 5),
    offerId: OFFER_ID,
    serviceDate: row.date,
    slot: row.timeSlotId
      ? {
          timeSlotId: row.timeSlotId,
          startMinutes: row.startMinutes ?? 0,
          endMinutes: row.endMinutes ?? 0,
        }
      : null,
    adults: 1,
    children: 0,
    infants: 0,
    guestName: "OUTLY Sandbox Test",
    remarks: "OUTLY integration sandbox test - automated, will be cancelled. Please ignore.",
    expectedNetMinor: row.price.perAdultMinor,
    expectedNetUsdMinor: row.price.perAdultUsdMinor,
  };

  const drills: { name: string; id: string; started: number }[] = [];
  async function start(name: string, over: Record<string, unknown>) {
    if (!ONLY.includes(name)) return;
    // The engine derives the client reference (SUP-9); drills are the only intents without an order item.
    const b = await svc.createIntent(
      null,
      {
        ...base,
        idempotencyKey: `drill-${RUN}-${name}`,
        drill: true,
        ...over,
      },
      { supplierCode: "traveldesk", accountId },
    );
    drills.push({ name, id: b.id, started: Date.now() });
  }

  async function runUntilIdle(label: string, deps: { adapter: TravelDeskBookingAdapter; mutationTimeoutMs: number }, maxMs: number) {
    const end = Date.now() + maxMs;
    while (Date.now() < end) {
      const r = await svc.runDueJobs(
        {
          adapter: deps.adapter,
          accountId,
          environment: "test",
          supplierCode: "traveldesk",
          mutationTimeoutMs: deps.mutationTimeoutMs,
          holder: `drill-${RUN}`,
        },
        { budgetMs: 240_000 },
      );
      for (const p of r.processed) console.log(`  [${label}] ${p.kind}: ${p.outcome}`);
      const open = await prisma.supplierBooking.count({
        where: { id: { in: drills.map((d) => d.id) }, closedAt: null },
      });
      const pending = await prisma.supplierJob.count({
        where: {
          supplierBookingId: { in: drills.map((d) => d.id) },
          status: { in: ["queued", "running"] },
        },
      });
      if (pending === 0) return open;
      if (r.processed.length === 0) await new Promise((res) => setTimeout(res, 5_000));
    }
    return -1;
  }

  let failure: unknown = null;
  try {
    // D1, D2, D4 with the normal client and timeout.
    await start("D1", { mode: "two_step", afterReserve: "confirm" });
    await start("D2", { mode: "two_step", afterReserve: "cancel" });
    await start("D4", { mode: "one_step" });
    await runUntilIdle("book", { adapter, mutationTimeoutMs: config.mutationTimeoutMs }, 8 * 60_000);
    for (const d of drills.filter((x) => x.name === "D1" || x.name === "D4")) {
      const b = await prisma.supplierBooking.findUniqueOrThrow({
        where: { id: d.id },
      });
      if (b.state === "confirmed" || b.state === "awaiting_external") await svc.requestCancel(d.id);
    }
    await runUntilIdle("cancel", { adapter, mutationTimeoutMs: config.mutationTimeoutMs }, 8 * 60_000);

    // D5: a client that gives up long before TravelDesk answers.
    if (ONLY.includes("D5")) {
      const tinyMs = Number(process.env.DRILL_TINY_TIMEOUT_MS ?? 400);
      const impatient = new TravelDeskBookingClient({ ...config, mutationTimeoutMs: tinyMs }, { onEvent });
      await start("D5", { mode: "two_step", afterReserve: "cancel" });
      // The impatient client sends the reserve; recovery and the cancel use the normal client.
      const first = await svc.runDueJobs(
        {
          adapter: new TravelDeskBookingAdapter(impatient, { environment: "test" }),
          accountId,
          environment: "test",
          supplierCode: "traveldesk",
          mutationTimeoutMs: tinyMs,
          holder: `drill-${RUN}`,
        },
        { budgetMs: 60_000, maxJobs: 1 },
      );
      for (const p of first.processed) console.log(`  [D5 send] ${p.kind}: ${p.outcome}`);
      await runUntilIdle("D5 recover", { adapter, mutationTimeoutMs: config.mutationTimeoutMs }, 10 * 60_000);
    }

    // D3: reserve and hold; the reservation must time out on its own (CX-1).
    if (ONLY.includes("D3")) {
      await start("D3", { mode: "two_step", afterReserve: "hold" });
      await runUntilIdle("D3 expiry", { adapter, mutationTimeoutMs: config.mutationTimeoutMs }, 22 * 60_000);
    }
  } catch (e) {
    failure = e;
    console.error("drill step failed; cleaning up:", e);
  }

  // Cleanup, whatever happened above: cancel anything still live, then check TravelDesk itself.
  for (const d of drills) {
    const b = await prisma.supplierBooking.findUniqueOrThrow({
      where: { id: d.id },
    });
    if (["reserved", "confirmed", "awaiting_external"].includes(b.state)) await svc.requestCancel(d.id).catch(() => undefined);
  }
  await runUntilIdle("cleanup", { adapter, mutationTimeoutMs: config.mutationTimeoutMs }, 5 * 60_000);

  // Q-B2: which drill bookings does the list show (reservations included?).
  const listed = await client.listBookings({
    from: row.date,
    to: row.date,
    offerId: OFFER_ID,
  });
  const refs = new Set((await prisma.supplierBooking.findMany({ where: { id: { in: drills.map((d) => d.id) } }, select: { clientRef: true } })).map((b) => b.clientRef));
  const ours = listed.filter((b) => b.bookingReference !== null && refs.has(b.bookingReference));
  const balanceAfter = await read.getBalance();
  // Reconciliation over the same account: every drill booking should agree with TravelDesk.
  const reconcile = await svc.reconcile({ adapter, environment: "test", supplierCode: "traveldesk", accountId });

  const results = [];
  for (const d of drills) {
    const b = await prisma.supplierBooking.findUniqueOrThrow({
      where: { id: d.id },
    });
    const events = await prisma.supplierBookingEvent.findMany({
      where: { supplierBookingId: d.id },
      orderBy: { at: "asc" },
    });
    results.push({
      drill: d.name,
      clientRef: b.clientRef,
      state: b.state,
      supplierBookingId: b.supplierBookingId,
      supplierStatusCode: b.supplierStatusCode,
      expectedNetMinor: b.expectedNetMinor,
      chargedNetMinor: b.chargedNetMinor,
      refundMinor: b.refundMinor,
      errorCode: b.errorCode,
      errorMessage: b.errorMessage,
      recoverySearches: b.recoverySearches,
      reservationDeadline: b.reservationDeadline,
      lastResponse: b.lastResponse,
      events: events.map((e) => ({
        at: e.at,
        kind: e.kind,
        operation: e.operation,
        httpStatus: e.httpStatus,
        durationMs: e.durationMs,
        from: e.fromState,
        to: e.toState,
        detail: e.detail,
      })),
    });
  }
  const summary = {
    run: RUN,
    offerId: OFFER_ID,
    date: row.date,
    slot: {
      timeSlotId: row.timeSlotId,
      start: row.startMinutes,
      end: row.endMinutes,
    },
    netAdultMinor: row.price.perAdultMinor,
    balanceBefore: { balance: balanceBefore.balanceMinor, credit: balanceBefore.creditFacilityMinor, payable: balanceBefore.payableBalanceMinor },
    balanceAfter: { balance: balanceAfter.balanceMinor, credit: balanceAfter.creditFacilityMinor, payable: balanceAfter.payableBalanceMinor },
    reconcile,
    listedDrillBookings: ours.map((b) => ({
      id: b.supplierBookingId,
      ref: b.bookingReference,
      status: b.status,
      statusName: b.statusName,
      refund: b.refundMinor,
    })),
    results,
    calls,
  };
  writeFileSync(path.join(outDir, "results.json"), json(summary));
  console.log("\nstate per drill:");
  for (const r of results)
    console.log(`  ${r.drill} ${r.clientRef}: ${r.state} (TravelDesk #${r.supplierBookingId ?? "-"} status ${r.supplierStatusCode ?? "-"}) ${r.errorCode ?? ""}`);
  console.log(`listed on ${row.date}: ${ours.length} of ${drills.length} drill bookings`);
  console.log(
    `balance / credit / payable before ${balanceBefore.balanceMinor} / ${balanceBefore.creditFacilityMinor} / ${balanceBefore.payableBalanceMinor}, after ${balanceAfter.balanceMinor} / ${balanceAfter.creditFacilityMinor} / ${balanceAfter.payableBalanceMinor} (minor units)`,
  );
  console.log(`reconciliation: ${reconcile.issues.length} difference(s); ${reconcile.supplierListed} listed, ${reconcile.ours} ours, ${reconcile.otherBookings} other`);
  for (const i of reconcile.issues) console.log(`  ${i.kind}: ${i.reference} #${i.supplierBookingId} ours ${i.ours} theirs ${i.theirs}`);
  console.log(`written: ${outDir}/results.json`);
  const leftOpen = ours.filter((b) => b.status !== 4 && b.status !== 8);
  const notClosed = results.filter((r) => !["cancelled", "expired", "not_created", "rejected"].includes(r.state));
  if (leftOpen.length)
    console.error(`LEFT OPEN ON TRAVELDESK TEST: ${leftOpen.map((b) => `#${b.supplierBookingId} ${b.bookingReference} status ${b.status}`).join(", ")} — cancel by hand`);
  if (notClosed.length) console.error(`drills not closed cleanly: ${notClosed.map((r) => `${r.drill}=${r.state}`).join(", ")}`);
  if (failure || leftOpen.length || notClosed.length || reconcile.issues.length) process.exitCode = 1;
  await prisma.$disconnect();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
