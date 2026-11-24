import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createStaff } from "../../__tests__/helpers/fixtures";
import { assertDisposableDb, assertDisposableDbLive } from "../../__tests__/helpers/target-guard";
import type { Actor } from "../../lib/actor";
import { log } from "../../lib/logger";
import { isAppError } from "../../lib/errors";
import { uuidv7 } from "../../lib/ids";
import { bookingControlKeyFor, GUARD_RELEASING_STATES, type PaymentEvidencePort } from "../../suppliers/booking-port";
import type { TravelDeskBooking } from "../../suppliers/traveldesk/traveldesk.booking";
import { TravelDeskBookingAdapter, type TravelDeskBookingTransport } from "../../suppliers/traveldesk/traveldesk.booking-adapter";
import { readLimits } from "../../suppliers/read-budget";
import { FUNDS_RECHECK_MAX_MS, FUNDS_RECHECK_MIN_MS } from "../../suppliers/wallet-funds";
import { TravelDeskApiError } from "../../suppliers/traveldesk/traveldesk.http";
import type { CreateIntentInput, EngineDeps } from "../supplier-booking.service";

/**
 * Booking engine against the LOCAL database with a scripted fake TravelDesk
 * behind the real TravelDesk adapter. Rows live under a run-scoped supplier
 * code (zz-td-<run>); jobs and leases are removed in afterAll, bookings and
 * events stay (events are append-only) and scripts/purge-test-rows.mjs keeps
 * the supplier row while it has bookings. Customer-intent tests also leave a
 * synthetic guest, combo, order and order item per test. Amounts are
 * synthetic.
 *
 * The test clock runs years ahead of the wall clock. Leases, job locks and
 * the read budget use the database clock, so the tests move those by SQL.
 *
 * Each test starts clean: afterEach closes every booking the test left open
 * and drops its jobs and leases, so a later watchdog cannot call a later
 * test's fake.
 *
 * The target guard refuses anything but the disposable test database.
 */

const enabled = Boolean(process.env.DATABASE_URL);
const RUN = uuidv7().slice(-8);
const CODE = `zz-td-${RUN}`;
const OFFER = 777_001;

type Step = "ok" | "lost" | "in_progress" | "still_reserved" | "external_failed" | "wrong_date" | TravelDeskApiError;

/**
 * Scripted TravelDesk: each mutation takes the next step from its queue
 * (default "ok"). It runs on the test clock: a reservation holds for 15
 * minutes, reads after its deadline show it timed out (status 8), and a
 * confirm after the deadline is refused. `getBooking` exists only so a test
 * can prove the engine never calls it (SUP-4).
 */
class FakeTravelDesk implements TravelDeskBookingTransport {
  calls: string[] = [];
  store = new Map<string, TravelDeskBooking>();
  steps: Record<"reserve" | "confirm" | "create" | "cancel", Step[]> = { reserve: [], confirm: [], create: [], cancel: [] };
  readFails = 0;
  /** Reads fail while the test clock is before this instant. */
  outageUntil: number | null = null;
  /** Spendable funds TravelDesk reports; balance reads are not recorded in `calls`. */
  fundsMinor: bigint | null = 10_000_000n;
  /** When set, the three raw wallet figures the balance read reports instead of a credit account built from `fundsMinor` (doc 29 §4.5). */
  wallet: { balanceMinor: bigint; creditFacilityMinor: bigint; payableBalanceMinor: bigint } | null = null;
  agencyId = 1;
  balanceReads = 0;
  /** Runs inside the balance read, i.e. after the job was claimed and just before the send. */
  onBalance: (() => Promise<void>) | null = null;
  /** Runs inside the cancel call, before it answers (a slow cancel). */
  onCancel: (() => Promise<void>) | null = null;
  chargeOverride: bigint | null = null;
  /** A reservation deadline this far after the send, instead of 15 minutes. */
  deadlineMs = 15 * 60_000;
  private seq = 50_000 + Math.floor(Math.random() * 1000);

  constructor(private readonly clock: () => Date) {}

  /** A booking that appears at TravelDesk without a call from us (a late or portal booking). */
  plant(body: Record<string, unknown>, status: number) {
    return this.make(body, status);
  }

  private make(body: Record<string, unknown>, status: number, inProgress = false): TravelDeskBooking {
    const id = String(this.seq++);
    const cost = this.chargeOverride ?? BigInt(Math.round(Number(body.totalCost) * 100));
    const b: TravelDeskBooking = {
      supplierBookingId: id,
      status,
      statusName: String(status),
      bookingReference: String(body.referenceNumber),
      serviceDate: String(body.date),
      offerId: Number(body.offerId),
      tourId: 1,
      bookingType: 1,
      timeSlotId: body.timeSlotId === undefined ? null : Number(body.timeSlotId),
      startMinutes: body.startTime === undefined ? null : Number(body.startTime),
      adults: Number(body.adults),
      children: Number(body.children),
      infants: Number(body.infants),
      totalCostMinor: cost,
      totalCostUsdMinor: 0n,
      paidFromBalanceMinor: cost,
      refundMinor: null,
      reservationDeadline: status === 7 ? new Date(this.clock().getTime() + this.deadlineMs).toISOString() : null,
      reservationTimeout: null,
      externalInProgress: inProgress,
      externalFailed: false,
      externalFailureMessage: null,
      voucherNotReady: false,
      hasTickets: false,
      creationState: null,
    };
    this.store.set(id, b);
    return b;
  }

  private step(op: keyof FakeTravelDesk["steps"]): Step {
    return this.steps[op].shift() ?? "ok";
  }

  async reserve(body: Record<string, unknown>) {
    this.calls.push("reserve");
    const s = this.step("reserve");
    if (s instanceof TravelDeskApiError) throw s;
    const b = this.make(body, 7);
    if (s === "lost") throw new TravelDeskApiError("timeout", "bookings.reserve");
    return b;
  }

  async create(body: Record<string, unknown>) {
    this.calls.push("create");
    const s = this.step("create");
    if (s instanceof TravelDeskApiError) throw s;
    // The sandbox answered one-step create with status 1 (drill D4).
    const b = this.make(body, 1, s === "in_progress");
    if (s === "lost") throw new TravelDeskApiError("timeout", "bookings.create");
    return b;
  }

  async confirm(id: string) {
    this.calls.push("confirm");
    const s = this.step("confirm");
    if (s instanceof TravelDeskApiError) throw s;
    if (s === "lost") throw new TravelDeskApiError("timeout", "bookings.confirm"); // never applied
    const held = this.expire(this.store.get(id)!);
    if (held.status !== 7) throw new TravelDeskApiError("bad_request", "bookings.confirm", { status: 400, reason: "The reservation is no longer active" });
    if (s === "still_reserved") return held;
    const b = {
      ...held,
      status: 1,
      reservationDeadline: null,
      externalInProgress: s === "in_progress",
      externalFailed: s === "external_failed",
      serviceDate: s === "wrong_date" ? "2026-11-11" : held.serviceDate,
    };
    this.store.set(id, b);
    return b;
  }

  async cancel(id: string) {
    this.calls.push("cancel");
    if (this.onCancel) await this.onCancel();
    const s = this.step("cancel");
    if (s instanceof TravelDeskApiError) throw s;
    this.store.set(id, { ...this.store.get(id)!, status: 4, refundMinor: this.store.get(id)!.paidFromBalanceMinor });
    if (s === "lost") throw new TravelDeskApiError("timeout", "bookings.cancel");
    return { isSuccess: true, message: null };
  }

  /** A reservation past its deadline has timed out. */
  private expire(b: TravelDeskBooking) {
    if (b.status !== 7 || !b.reservationDeadline || this.clock().getTime() <= Date.parse(b.reservationDeadline)) return b;
    const out = { ...b, status: 8 };
    this.store.set(b.supplierBookingId, out);
    return out;
  }

  private readFault(op: string) {
    if (this.outageUntil !== null && this.clock().getTime() < this.outageUntil) throw new TravelDeskApiError("server", op, { status: 503 });
    if (this.readFails > 0) {
      this.readFails--;
      throw new TravelDeskApiError("server", op, { status: 503 });
    }
  }

  async getBalance() {
    this.balanceReads++;
    if (this.onBalance) await this.onBalance();
    if (this.fundsMinor === null) throw new TravelDeskApiError("server", "balance", { status: 503 });
    if (this.wallet) return { agencyId: this.agencyId, currencyRequested: "AED" as const, ...this.wallet };
    return { agencyId: this.agencyId, currencyRequested: "AED" as const, balanceMinor: 0n, creditFacilityMinor: this.fundsMinor, payableBalanceMinor: this.fundsMinor };
  }

  /** Get-by-id may issue tickets (SUP-4): recorded so tests can prove it is never called. */
  async getBooking(id: string) {
    this.calls.push("get");
    return this.store.get(id)!;
  }

  async getReservation(id: string) {
    this.calls.push("getReservation");
    this.readFault("bookings.reservation");
    const b = this.store.get(id);
    if (!b) throw new TravelDeskApiError("not_found", "bookings.reservation", { status: 404 });
    const r = this.expire(b);
    if (r.status !== 7) throw new TravelDeskApiError("bad_request", "bookings.reservation", { status: 400 });
    return r;
  }

  async listBookingsPage(q: { from: string; to: string; offerId?: number }, page: number, onPage = 100) {
    this.calls.push("list");
    this.readFault("bookings.list");
    const all = [...this.store.values()].map((b) => this.expire(b)).filter((b) => b.serviceDate! >= q.from && b.serviceDate! <= q.to && (!q.offerId || b.offerId === q.offerId));
    return { rows: all.slice((page - 1) * onPage, page * onPage), totalCount: all.length };
  }
}

describe.skipIf(!enabled)("supplierBookingService (local DB, fake TravelDesk)", () => {
  let prisma: typeof import("../../lib/db").prisma;
  let svc: typeof import("../supplier-booking.service").supplierBookingService;
  let engine: typeof import("../supplier-booking.service");
  let supplierId: string;
  let clock = Date.parse("2030-01-06T08:00:00Z");
  const now = () => new Date(clock);
  let n = 0;

  function base() {
    n++;
    return {
      environment: "test" as const,
      idempotencyKey: `t-${RUN}-${n}`,
      bookingKind: "live_book" as const,
      tourId: 1,
      offerId: OFFER,
      serviceDate: "2026-11-10",
      slot: { timeSlotId: 9, startMinutes: 1260, endMinutes: 1365 },
      adults: 2,
      children: 0,
      guestName: "OUTLY Engine Test",
      expectedNetMinor: 24000n,
      expectedNetUsdMinor: 6600n,
    };
  }

  /** A sandbox drill intent (no order item). */
  function intent(over: Record<string, unknown> = {}): CreateIntentInput {
    return { ...base(), drill: true, ...over } as CreateIntentInput;
  }

  /** A customer intent for an order item sold through instant checkout. */
  function forOrder(ids: { orderId: string; orderItemId: string }, over: Record<string, unknown> = {}): CreateIntentInput {
    return { ...base(), ...ids, fulfilmentOrigin: "instant_checkout", quoteId: null, ...over } as CreateIntentInput;
  }

  function create(i: CreateIntentInput, opts: Record<string, unknown> = {}) {
    return svc.createIntent(null, i, { supplierCode: CODE, now, ...opts });
  }

  function adapterFor(td: FakeTravelDesk) {
    return new TravelDeskBookingAdapter(td, { environment: "test", now });
  }

  function deps(td: FakeTravelDesk, over: Partial<EngineDeps> = {}): EngineDeps {
    return { adapter: adapterFor(td), environment: "test", supplierCode: CODE, mutationTimeoutMs: 1_000, now, readLimits: readLimits(1_000_000), ...over };
  }

  /** Run jobs, advancing the clock between rounds, until nothing is due within `maxMs`. */
  async function drain(td: FakeTravelDesk, maxMs = 120_000, stepMs = 31_000, over: Partial<EngineDeps> = {}) {
    const outcomes: string[] = [];
    const end = clock + maxMs;
    while (clock <= end) {
      const r = await svc.runDueJobs(deps(td, over), { budgetMs: 60_000 });
      outcomes.push(...r.processed.map((p) => `${p.kind}:${p.outcome}`));
      if (r.processed.length === 0) clock += stepMs;
    }
    return outcomes;
  }

  async function booking(id: string) {
    return prisma.supplierBooking.findUniqueOrThrow({ where: { id } });
  }

  async function events(id: string) {
    return prisma.supplierBookingEvent.findMany({ where: { supplierBookingId: id }, orderBy: { at: "asc" } });
  }

  /** A mutation lease on the test account, held by someone else on the database clock. */
  async function holdLease(holder: string, seconds: number) {
    await prisma.$executeRaw`
      INSERT INTO supplier_account_leases (supplier_id, environment, account_id, holder, lease_until)
      VALUES (${supplierId}::uuid, 'test', 'default', ${holder}, now() + make_interval(secs => ${seconds}::double precision))
      ON CONFLICT (supplier_id, environment, account_id) DO UPDATE SET holder = EXCLUDED.holder, lease_until = EXCLUDED.lease_until`;
  }

  async function releaseLeases() {
    await prisma.supplierAccountLease.deleteMany({ where: { supplierId } });
  }

  /** Synthetic guest, combo, order and order item, for intents that belong to a customer order. */
  async function orderItem(origin: "instant_checkout" | "assisted_conversion" = "instant_checkout") {
    const tag = `zz-td-${RUN}-${++n}`;
    const guest = await prisma.guest.create({ data: { id: uuidv7(), phoneE164: "+910000000000", fullName: "test-engine" } });
    const combo = await prisma.combo.create({ data: { id: uuidv7(), slug: tag, name: "test-engine", confirmation: "manual" } });
    const order = await prisma.order.create({
      data: {
        id: uuidv7(),
        reference: `OUT-TEST${Math.floor(Math.random() * 1e9)}`,
        rail: "assisted",
        guestId: guest.id,
        currency: "INR",
        subtotalInr: 1000n,
        subtotalAed: 45n,
        totalInr: 1000n,
        totalAed: 45n,
        leadName: "test-engine",
        leadPhone: "+910000000000",
      },
    });
    const item = await prisma.orderItem.create({
      data: {
        id: uuidv7(),
        orderId: order.id,
        comboId: combo.id,
        titleSnapshot: "test-engine",
        tierSnapshot: "C",
        slugSnapshot: tag,
        kindSnapshot: "combo",
        confirmationSnapshot: "manual",
        fulfilmentModeSnapshot: "inquiry",
        fulfilmentOrigin: origin,
        freeCancellationHoursSnapshot: 24,
        durationMinutesSnapshot: 60,
        serviceDate: new Date("2026-11-10"),
        pax: { adult: 2, child: 0, infant: 0 },
        unitInr: 1000n,
        unitAed: 45n,
        totalInr: 1000n,
        totalAed: 45n,
      },
    });
    return { orderId: order.id, orderItemId: item.id };
  }

  /** A second attempt for the same order item, with a fresh key. */
  async function secondAttempt(ids: { orderId: string; orderItemId: string }) {
    return create(forOrder(ids)).catch((e) => e);
  }

  function code(e: unknown) {
    return isAppError(e) ? e.code : String(e);
  }

  function isConflict(e: unknown) {
    return code(e) === "CONFLICT";
  }

  beforeAll(async () => {
    assertDisposableDb();
    ({ prisma } = await import("../../lib/db"));
    await assertDisposableDbLive(prisma);
    engine = await import("../supplier-booking.service");
    svc = engine.supplierBookingService;
    supplierId = uuidv7();
    await prisma.supplier.create({ data: { id: supplierId, code: CODE, name: "TravelDesk (engine test)", source: "api", adapter: "traveldesk" } });
    // Customer intents pass the capability gate (doc 29 Batch 1a): the stored offer is in a seeded class.
    const { storedOffer, storedSlot } = await import("../../suppliers/__tests__/fixtures/traveldesk-terms");
    await prisma.supplierCatalogueItem.create({
      data: {
        id: uuidv7(),
        supplierId,
        environment: "test",
        kind: "offer",
        externalId: String(OFFER),
        parentExternalId: "1",
        name: "engine test offer",
        bookingKind: "live_book",
        payload: storedOffer({ offerId: OFFER, tourId: 1, timeSlots: [storedSlot({ timeSlotId: 9, startMinutes: 1260, endMinutes: 1365 })] }) as never,
        payloadHash: "x",
      },
    });
  });

  afterEach(async () => {
    if (!prisma) return;
    // Close whatever this test left open, so its watchdogs and recovery never run in a later test.
    await prisma.supplierBooking.updateMany({
      where: { supplierId, closedAt: null },
      data: { state: "manual_review", closedAt: new Date(), errorCode: "test_retired" },
    });
    const ids = (await prisma.supplierBooking.findMany({ where: { supplierId }, select: { id: true } })).map((b) => b.id);
    await prisma.supplierJob.deleteMany({ where: { supplierBookingId: { in: ids } } });
    await releaseLeases();
    // The outage breaker's count is per test: failures one test provokes must never pause a later one.
    await prisma.setting.deleteMany({ where: { key: { startsWith: `supplier_outage.${CODE}.` } } });
  });

  afterAll(async () => {
    if (!prisma) return;
    const ids = (await prisma.supplierBooking.findMany({ where: { supplierId }, select: { id: true } })).map((b) => b.id);
    await prisma.supplierJob.deleteMany({ where: { supplierBookingId: { in: ids } } });
    await releaseLeases();
    await prisma.setting.deleteMany({ where: { key: { startsWith: `supplier_budget.${CODE}.` } } });
    // The synthetic order items stay (bookings reference them) but go back to the column default, so the
    // B1 migration test's "every kept row has the safe default" still holds on this shared database.
    await prisma.orderItem.updateMany({ where: { slugSnapshot: { startsWith: "zz-td-" } }, data: { fulfilmentOrigin: "assisted_conversion" } });
    // The saga tests' draft products have empty content: soft-delete them (mappings and bookings keep their
    // references) so catalogue export/import tests on this shared database never see them.
    await prisma.product.updateMany({ where: { slug: { startsWith: `zz-test-${RUN}-saga-` } }, data: { deletedAt: new Date() } });
    await prisma.$disconnect();
  });

  /* -------------------------------------------------------------------------
   * Intake (SUP-8, SUP-9, SUP-16, SUP-20, PRD-3)
   * ---------------------------------------------------------------------- */

  it("createIntent is idempotent on the same request, refuses a changed one, and derives the client reference (SUP-9)", async () => {
    const i = intent();
    const a = await create(i);
    const b = await create(i);
    expect(b.id).toBe(a.id);
    expect(await prisma.supplierJob.count({ where: { supplierBookingId: a.id } })).toBe(1);
    expect(a.clientRef).toMatch(/^OUTTD-[0-9A-F]{20}$/);
    expect(a.requestHash).toMatch(/^[0-9a-f]{64}$/);
    expect(a.accountId).toBe("default");
    const stored = a.requestPayload as Record<string, unknown>;
    expect(stored.guestName).toBe("[stored separately]");
    expect(stored).toMatchObject({ referenceNumber: a.clientRef, totalCost: 240, cashCollect: 0, timeSlotId: 9 });
    expect(stored).not.toHaveProperty("payByBalance");

    // Same key, a different request (one more adult): a conflict, never the old row.
    expect(code(await create({ ...i, adults: 3 }).catch((e) => e))).toBe("CONFLICT");
    expect(code(await create({ ...i, guestName: "Someone Else" }).catch((e) => e))).toBe("CONFLICT");
    // The caller never chooses the reference, and only a drill books without an order item.
    expect(code(await create({ ...intent(), clientRef: "OUT-MINE-1" } as never).catch((e) => e))).toBe("VALIDATION_FAILED");
    expect(code(await create({ ...intent(), drill: undefined } as never).catch((e) => e))).toBe("VALIDATION_FAILED");
    await drain(new FakeTravelDesk(now), 0); // leave nothing queued for later tests
  });

  it("an order item must come from instant checkout, in the request and in the database (PRD-3, SUP-16)", async () => {
    const assisted = await orderItem("assisted_conversion");
    // An inquiry converted by an agent never creates a supplier row, whatever the caller claims.
    expect(code(await create(forOrder(assisted)).catch((e) => e))).toBe("CONFLICT");
    expect(await prisma.supplierBooking.count({ where: { orderItemId: assisted.orderItemId } })).toBe(0);
    const ids = await orderItem();
    expect(code(await create(forOrder(ids, { fulfilmentOrigin: "assisted_conversion" })).catch((e) => e))).toBe("VALIDATION_FAILED");
    expect(code(await create(forOrder(ids, { quoteId: undefined })).catch((e) => e))).toBe("VALIDATION_FAILED");
    // Doc 29 Batch 5: a customer ticket names no slot and no hotel; without them, a ticket kind over a live offer is a conflict.
    expect(code(await create(forOrder(ids, { bookingKind: "ticket_only" })).catch((e) => e))).toBe("VALIDATION_FAILED");
    expect(code(await create(forOrder(ids, { bookingKind: "ticket_only", slot: null, hotelId: 42 })).catch((e) => e))).toBe("VALIDATION_FAILED");
    expect(code(await create(forOrder(ids, { bookingKind: "ticket_only", slot: null })).catch((e) => e))).toBe("CONFLICT");
    expect(await prisma.supplierBooking.count({ where: { orderItemId: ids.orderItemId } })).toBe(0);
    expect(code(await create(forOrder(ids, { mode: "one_step" })).catch((e) => e))).toBe("VALIDATION_FAILED");
    expect(code(await create(forOrder(ids, { drill: true })).catch((e) => e))).toBe("VALIDATION_FAILED");
    const ok = await create(forOrder(ids));
    expect(ok).toMatchObject({ afterReserve: "await_payment", orderId: ids.orderId, attempt: 1 });
  });

  it("a customer intent reads the capability gate: an offer whose class is not switched on, or that is not stored, is refused before anything is written (doc 29 Batch 1a)", async () => {
    const { storedOffer, storedSlot } = await import("../../suppliers/__tests__/fixtures/traveldesk-terms");
    const pickup = OFFER + 1;
    await prisma.supplierCatalogueItem.upsert({
      where: { supplierId_environment_kind_externalId: { supplierId, environment: "test", kind: "offer", externalId: String(pickup) } },
      create: {
        id: uuidv7(),
        supplierId,
        environment: "test",
        kind: "offer",
        externalId: String(pickup),
        parentExternalId: "1",
        name: "engine test pickup offer",
        bookingKind: "live_book",
        payload: storedOffer({ offerId: pickup, tourId: 1, isDirectReporting: false, timeSlots: [storedSlot({ timeSlotId: 9, startMinutes: 1260, endMinutes: 1365 })] }) as never,
        payloadHash: "x",
      },
      update: {},
    });
    const reasonOf = (e: unknown) => (isAppError(e) ? (e.details as { reason?: string } | undefined)?.reason : String(e));
    // Pickup classes are off until Batch 3.
    const ids = await orderItem();
    const refused = await create(forOrder(ids, { offerId: pickup })).catch((e) => e);
    expect(code(refused)).toBe("CONFLICT");
    expect(reasonOf(refused)).toBe("flag_off");
    // An offer the catalogue has never stored has no knowable class.
    const unknown = await create(forOrder(ids, { offerId: OFFER + 2 })).catch((e) => e);
    expect(reasonOf(unknown)).toBe("class_unknown");
    expect(await prisma.supplierBooking.count({ where: { orderItemId: ids.orderItemId } })).toBe(0);
    // A sandbox drill is not a sale: the gate does not apply to it.
    const drill = await create(intent({ offerId: pickup }));
    expect(drill.state).toBe("queued");
    await drain(new FakeTravelDesk(now), 0);
  });

  it("createIntent joins the caller's transaction: a rollback leaves no booking and no job (SUP-8)", async () => {
    const ids = await orderItem();
    let bookingId = "";
    const err = await prisma
      .$transaction(async (tx) => {
        bookingId = (await svc.createIntent(tx, forOrder(ids), { supplierCode: CODE, now })).id;
        throw new Error("payment write failed");
      })
      .catch((e) => e);
    expect(String(err)).toContain("payment write failed");
    expect(await prisma.supplierBooking.count({ where: { orderItemId: ids.orderItemId } })).toBe(0);
    expect(await prisma.supplierJob.count({ where: { supplierBookingId: bookingId } })).toBe(0);
  });

  /* -------------------------------------------------------------------------
   * The happy paths, SUP-4 and SEC-11
   * ---------------------------------------------------------------------- */

  it("two-step: reserve then confirm, events written before each call, allowlisted and never by get-by-id", async () => {
    const td = new FakeTravelDesk(now);
    const b = await create(intent());
    await drain(td, 0);
    const done = await booking(b.id);
    expect(done.state).toBe("confirmed");
    expect(td.calls).toEqual(["reserve", "confirm"]);
    expect(done.chargedNetMinor).toBe(24000n);
    expect(done.closedAt).not.toBeNull();
    const evs = await events(b.id);
    const kinds = evs.map((e) => `${e.kind}:${e.operation ?? e.toState ?? ""}`);
    expect(kinds.indexOf("request_sent:bookings.reserve")).toBeLessThan(kinds.indexOf("response:bookings.reserve"));
    expect(kinds).toContain("state_change:confirmed");
    // SEC-11: only allowlisted codes and counts in event details.
    for (const e of evs) for (const v of Object.values(e.detail as Record<string, unknown>)) if (typeof v === "string") expect(v).toMatch(/^[A-Za-z0-9_.:-]{1,80}$/);
  });

  it("no status read before the document step uses get-by-id (SUP-4)", async () => {
    const td = new FakeTravelDesk(now);
    td.steps.reserve.push("lost");
    td.steps.confirm.push("in_progress");
    const b = await create(intent());
    await drain(td, 3 * 60_000);
    const id = (await booking(b.id)).supplierBookingId!;
    td.store.set(id, { ...td.store.get(id)!, externalInProgress: false });
    await drain(td, 2 * 60_000, 16_000);
    expect((await booking(b.id)).state).toBe("confirmed");
    await svc.requestCancel(b.id, { now });
    await drain(td, 0);
    expect((await booking(b.id)).state).toBe("cancelled");
    expect(td.calls).toContain("list");
    expect(td.calls).not.toContain("get");
  });

  it("one-step create, then an operator cancel verified by a list read", async () => {
    const td = new FakeTravelDesk(now);
    const b = await create(intent({ mode: "one_step" }));
    await drain(td, 0);
    expect((await booking(b.id)).state).toBe("confirmed");
    await svc.requestCancel(b.id, { now });
    await drain(td, 0);
    expect(await booking(b.id)).toMatchObject({ state: "cancelled", supplierStatusCode: 4 });
    expect(td.calls).toEqual(["create", "cancel", "list"]);
  });

  it("a reserve that timed out but was created is found by reference and never resent", async () => {
    const td = new FakeTravelDesk(now);
    td.steps.reserve.push("lost");
    const b = await create(intent());
    await svc.runDueJobs(deps(td), { budgetMs: 60_000 });
    expect((await booking(b.id)).state).toBe("outcome_unknown");
    await drain(td);
    expect((await booking(b.id)).state).toBe("confirmed");
    expect(td.calls.filter((c) => c === "reserve")).toHaveLength(1);
    expect(td.calls).toContain("list");
  });

  it("a lost reserve that is not found stays blocking as not_found_unresolved; a reservation found at minute 20 continues the attempt", async () => {
    const td = new FakeTravelDesk(now);
    td.steps.reserve.push(new TravelDeskApiError("network", "bookings.reserve"));
    const ids = await orderItem();
    const t0 = clock;
    const b = await create(forOrder(ids));
    await svc.runDueJobs(deps(td), { budgetMs: 60_000 });
    clock += 31_000;
    await svc.runDueJobs(deps(td), { budgetMs: 60_000 });
    expect((await booking(b.id)).state).toBe("outcome_unknown");
    expect(isConflict(await secondAttempt(ids))).toBe(true);
    await drain(td, 10 * 60_000, 60_000);
    expect((await booking(b.id)).state).toBe("outcome_unknown"); // a late reservation could still be on hold
    await drain(td, t0 + 19 * 60_000 - clock, 60_000);
    const unresolved = await booking(b.id);
    expect(unresolved).toMatchObject({ state: "not_found_unresolved", errorCode: "not_found_after_recovery", closedAt: null });
    expect(unresolved.attentionRequiredAt).not.toBeNull();
    expect(unresolved.recoverySearches).toBeGreaterThanOrEqual(2);
    expect(GUARD_RELEASING_STATES as readonly string[]).not.toContain(unresolved.state);
    expect(isConflict(await secondAttempt(ids))).toBe(true);
    expect(await prisma.supplierJob.findUnique({ where: { dedupeKey: `recover:${b.id}` } })).toMatchObject({ status: "queued" });

    // Minute 20: TravelDesk shows the reservation after all.
    clock = t0 + 20 * 60_000;
    td.plant({ ...(b.requestPayload as Record<string, unknown>), guestName: b.guestName }, 7);
    await drain(td, 10 * 60_000, 60_000);
    const found = await booking(b.id);
    expect(found.state).toBe("awaiting_payment");
    expect(found.supplierBookingId).not.toBeNull();
    // Recovery settled it: the attention flag is cleared, but the hold is never trusted past the original send plus 15 minutes.
    expect(found.attentionRequiredAt).toBeNull();
    expect(found.reservationDeadline!.getTime()).toBeLessThanOrEqual(t0 + 15 * 60_000);
    expect(td.calls.filter((c) => c === "reserve")).toHaveLength(1);
    expect(td.calls).not.toContain("confirm");
    expect(isConflict(await secondAttempt(ids))).toBe(true);
  });

  it("two bookings carrying the same reference go to manual review", async () => {
    const td = new FakeTravelDesk(now);
    td.steps.reserve.push("lost");
    const b = await create(intent());
    await svc.runDueJobs(deps(td), { budgetMs: 60_000 });
    td.store.set("99", { ...[...td.store.values()].at(-1)!, supplierBookingId: "99" });
    await drain(td);
    const after = await booking(b.id);
    expect(after).toMatchObject({ state: "manual_review", errorCode: "ambiguous_recovery" });
    expect(after.attentionRequiredAt).not.toBeNull();
  });

  it.each([
    ["400", new TravelDeskApiError("bad_request", "bookings.reserve", { status: 400, reason: "Bad date" })],
    ["422", new TravelDeskApiError("validation", "bookings.reserve", { status: 422, fieldErrors: [{ fieldName: "Date", errorMessage: "too late" }] })],
    ["429", new TravelDeskApiError("rate_limited", "bookings.reserve", { status: 429 })],
  ])("an undocumented %s after the reserve was sent is an unknown outcome, never a rejection", async (_code, err) => {
    const td = new FakeTravelDesk(now);
    td.steps.reserve.push(err);
    const b = await create(intent());
    await drain(td);
    const done = await booking(b.id);
    expect(done).toMatchObject({ state: "outcome_unknown", errorCode: err.kind });
    expect(GUARD_RELEASING_STATES as readonly string[]).not.toContain(done.state);
    expect(td.calls.filter((c) => c === "reserve")).toHaveLength(1);
    expect(td.calls).toContain("list");
  });

  it("a documented auth refusal (401/403) is a rejection", async () => {
    const td = new FakeTravelDesk(now);
    td.steps.reserve.push(new TravelDeskApiError("auth", "bookings.reserve", { status: 403 }));
    const b = await create(intent());
    await drain(td);
    expect(await booking(b.id)).toMatchObject({ state: "rejected", errorCode: "auth" });
    expect(td.calls).toEqual(["reserve"]);
  });

  it("an unknown confirm that still shows a reservation is held for a human and runs out on its own (Q-B6, SUP-5)", async () => {
    const td = new FakeTravelDesk(now);
    td.steps.confirm.push("lost");
    const b = await create(intent());
    await drain(td);
    const held = await booking(b.id);
    expect(held).toMatchObject({ state: "reserved", errorCode: "confirm_unknown_still_reserved", closedAt: null });
    expect(held.attentionRequiredAt).not.toBeNull();
    await drain(td, 20 * 60_000, 60_000);
    expect((await booking(b.id)).state).toBe("expired");
    expect(td.calls.filter((c) => c === "confirm")).toHaveLength(1);
  });

  it("a confirm answer for the wrong date is not confirmed: a human is told and it is re-read, never resent", async () => {
    const td = new FakeTravelDesk(now);
    td.steps.confirm.push("wrong_date");
    const b = await create(intent());
    await drain(td, 0);
    const held = await booking(b.id);
    expect(held).toMatchObject({ state: "outcome_unknown", errorCode: "unconfirmed_snapshot", errorMessage: "identity_mismatch", closedAt: null });
    expect(held.attentionRequiredAt).not.toBeNull();
    await drain(td, 120_000);
    expect((await booking(b.id)).state).toBe("outcome_unknown");
    // TravelDesk corrects the record; the next re-read confirms.
    const id = held.supplierBookingId!;
    td.store.set(id, { ...td.store.get(id)!, serviceDate: "2026-11-10" });
    await drain(td, 30 * 60_000, 60_000);
    expect((await booking(b.id)).state).toBe("confirmed");
    expect(td.calls.filter((c) => c === "confirm")).toHaveLength(1);
    expect(td.calls).not.toContain("get");
  });

  it("status 0 (New) confirms when every other check passes (Q-B3, TravelDesk: 0 and 1 are successful)", async () => {
    const td = new FakeTravelDesk(now);
    const realConfirm = td.confirm.bind(td);
    td.confirm = async (x: string) => ({ ...(await realConfirm(x)), status: 0 });
    const b = await create(intent());
    await drain(td, 0);
    expect(await booking(b.id)).toMatchObject({ state: "confirmed", supplierStatusCode: 0, errorCode: null });
  });

  it("status 0 for the wrong date is not confirmed", async () => {
    const td = new FakeTravelDesk(now);
    td.steps.confirm.push("wrong_date");
    const realConfirm = td.confirm.bind(td);
    td.confirm = async (x: string) => ({ ...(await realConfirm(x)), status: 0 });
    const b = await create(intent());
    await drain(td, 0);
    const held = await booking(b.id);
    expect(held).toMatchObject({ state: "outcome_unknown", errorCode: "unconfirmed_snapshot", errorMessage: "identity_mismatch" });
    expect(held.attentionRequiredAt).not.toBeNull();
  });

  it("status 0 while external confirmation is in progress waits, it does not confirm", async () => {
    const td = new FakeTravelDesk(now);
    td.steps.confirm.push("in_progress");
    const realConfirm = td.confirm.bind(td);
    td.confirm = async (x: string) => ({ ...(await realConfirm(x)), status: 0 });
    const b = await create(intent());
    await drain(td, 0);
    expect((await booking(b.id)).state).toBe("awaiting_external");
  });

  it("an answer without the external flags is not confirmed", async () => {
    const td = new FakeTravelDesk(now);
    const b = await create(intent());
    await svc.runDueJobs(deps(td), { budgetMs: 60_000, maxJobs: 1 });
    const id = (await booking(b.id)).supplierBookingId!;
    const realConfirm = td.confirm.bind(td);
    td.confirm = async (x: string) => ({ ...(await realConfirm(x)), externalInProgress: null, externalFailed: null });
    await drain(td, 0);
    expect(await booking(b.id)).toMatchObject({ state: "outcome_unknown", errorCode: "unconfirmed_snapshot", errorMessage: "flag_missing" });
    expect(td.store.get(id)!.status).toBe(1);
  });

  it("external confirmation is polled until done", async () => {
    const td = new FakeTravelDesk(now);
    td.steps.confirm.push("in_progress");
    const b = await create(intent());
    await drain(td, 0);
    expect((await booking(b.id)).state).toBe("awaiting_external");
    const id = (await booking(b.id)).supplierBookingId!;
    clock += 16_000;
    await svc.runDueJobs(deps(td), { budgetMs: 60_000 });
    expect((await booking(b.id)).pollCount).toBe(1);
    td.store.set(id, { ...td.store.get(id)!, externalInProgress: false });
    await drain(td, 60_000, 16_000);
    expect((await booking(b.id)).state).toBe("confirmed");
  });

  it("a slow external confirmation backs off and tells a human after 30 minutes, without leaving its state (SUP-17)", async () => {
    const td = new FakeTravelDesk(now);
    td.steps.confirm.push("in_progress");
    const b = await create(intent());
    await drain(td, 0);
    await drain(td, 40 * 60_000, 15_000);
    const slow = await booking(b.id);
    expect(slow).toMatchObject({ state: "awaiting_external", errorCode: "external_confirmation_slow", closedAt: null });
    expect(slow.attentionRequiredAt).not.toBeNull();
    // Fewer than one read per 15 s over 40 minutes (160): the interval grows.
    expect(slow.pollCount).toBeLessThan(40);
    expect(slow.pollCount).toBeGreaterThan(5);
  });

  it("a reservation whose charged amount differs is held for a human, never confirmed, and runs out on its own", async () => {
    const td = new FakeTravelDesk(now);
    td.chargeOverride = 25000n;
    const b = await create(intent());
    await drain(td, 0);
    const held = await booking(b.id);
    expect(held).toMatchObject({ state: "reserved", errorCode: "charged_amount_mismatch" });
    expect(held.attentionRequiredAt).not.toBeNull();
    await drain(td, 20 * 60_000, 60_000);
    expect((await booking(b.id)).state).toBe("expired");
    expect(td.calls).not.toContain("confirm");
  });

  it("caps the reservation deadline at the send plus the hold length when TravelDesk's deadline is later (CR-9)", async () => {
    const td = new FakeTravelDesk(now);
    td.deadlineMs = 4 * 3600_000;
    const sent = clock;
    const b = await create(intent({ afterReserve: "hold" }));
    await drain(td, 0);
    expect((await booking(b.id)).reservationDeadline!.getTime()).toBe(sent + 15 * 60_000);
  });

  /* -------------------------------------------------------------------------
   * Cancellation (SUP-13)
   * ---------------------------------------------------------------------- */

  it("a policy refusal is cancel_refused, with no supplier text stored in events", async () => {
    const td = new FakeTravelDesk(now);
    const b = await create(intent());
    await drain(td, 0);
    td.steps.cancel.push(new TravelDeskApiError("bad_request", "bookings.cancel", { status: 400, reason: "Cancellation is not allowed" }));
    await svc.requestCancel(b.id, { now });
    await drain(td, 0);
    expect(await booking(b.id)).toMatchObject({ state: "cancel_refused", errorCode: "cancel_refused" });
    expect(JSON.stringify((await events(b.id)).map((e) => e.detail))).not.toContain("not allowed");
    expect(code(await svc.requestCancel(b.id, { now }).catch((e) => e))).toBe("CONFLICT");
  });

  it("a 200 whose re-read fails, a 400 'not found' and a 400 policy answer end in three different states (SUP-13)", async () => {
    const cases: [Step | "reread_fails", string, string][] = [
      ["reread_fails", "cancel_unverified", "cancel_reread_failed"],
      [new TravelDeskApiError("bad_request", "bookings.cancel", { status: 400, reason: "Not found" }), "outcome_unknown", "cancel_not_found"],
      [new TravelDeskApiError("bad_request", "bookings.cancel", { status: 400, reason: "Cancellation is not allowed" }), "cancel_refused", "cancel_refused"],
    ];
    for (const [step, state, errorCode] of cases) {
      const td = new FakeTravelDesk(now);
      const b = await create(intent());
      await drain(td, 0);
      if (step === "reread_fails") td.readFails = 1;
      else td.steps.cancel.push(step);
      await svc.requestCancel(b.id, { now });
      await svc.runDueJobs(deps(td), { budgetMs: 60_000 });
      const after = await booking(b.id);
      expect(after).toMatchObject({ state, errorCode });
      if (state === "outcome_unknown") expect(after.attentionRequiredAt).not.toBeNull();
    }
  });

  it("a 400 'already cancelled' is verified by a re-read, never taken as a policy refusal (CR-B1-4)", async () => {
    const already = () => new TravelDeskApiError("bad_request", "bookings.cancel", { status: 400, reason: "Booking already cancelled" });
    // TravelDesk shows it cancelled: recorded as cancelled, and the order item is free.
    const td = new FakeTravelDesk(now);
    const b = await create(intent());
    await drain(td, 0);
    const sid = (await booking(b.id)).supplierBookingId!;
    td.store.set(sid, { ...td.store.get(sid)!, status: 4 });
    td.steps.cancel.push(already());
    await svc.requestCancel(b.id, { now });
    await svc.runDueJobs(deps(td), { budgetMs: 60_000 });
    expect((await booking(b.id)).state).toBe("cancelled");
    // TravelDesk still shows it live: unverified and blocking, not cancel_refused.
    const live = new FakeTravelDesk(now);
    const c = await create(intent());
    await drain(live, 0);
    live.steps.cancel.push(already());
    await svc.requestCancel(c.id, { now });
    await svc.runDueJobs(deps(live), { budgetMs: 60_000 });
    expect(await booking(c.id)).toMatchObject({ state: "cancel_unverified", errorCode: "cancel_not_reflected" });
    // A 400 that only mentions cancelling is an incident with attention, not a refusal.
    const invalid = new FakeTravelDesk(now);
    const d = await create(intent());
    await drain(invalid, 0);
    invalid.steps.cancel.push(new TravelDeskApiError("bad_request", "bookings.cancel", { status: 400, reason: "Invalid cancel request" }));
    await svc.requestCancel(d.id, { now });
    await svc.runDueJobs(deps(invalid), { budgetMs: 60_000 });
    const incident = await booking(d.id);
    expect(incident).toMatchObject({ state: "outcome_unknown", errorCode: "cancel_invalid" });
    expect(incident.attentionRequiredAt).not.toBeNull();
  });

  it("afterReserve=cancel reserves and releases (sandbox drill mode)", async () => {
    const td = new FakeTravelDesk(now);
    const b = await create(intent({ afterReserve: "cancel" }));
    await drain(td, 0);
    expect((await booking(b.id)).state).toBe("cancelled");
    expect(td.calls).toEqual(["reserve", "cancel", "list"]);
  });

  it("an unknown cancel that did take is recorded as cancelled", async () => {
    const td = new FakeTravelDesk(now);
    td.steps.cancel.push("lost");
    const b = await create(intent());
    await drain(td, 0);
    await svc.requestCancel(b.id, { now });
    await drain(td);
    expect((await booking(b.id)).state).toBe("cancelled");
    expect(td.calls.filter((c) => c === "cancel")).toHaveLength(1);
  });

  it("a cancel answered 200 whose re-reads fail stays cancel_unverified and keeps the order item until TravelDesk shows it cancelled", async () => {
    const td = new FakeTravelDesk(now);
    const ids = await orderItem();
    const b = await create(forOrder(ids));
    await drain(td, 0);
    expect((await booking(b.id)).state).toBe("awaiting_payment");
    td.readFails = 1_000;
    await svc.requestCancel(b.id, { now });
    await drain(td, 0);
    expect(await booking(b.id)).toMatchObject({ state: "cancel_unverified", closedAt: null });
    expect(isConflict(await secondAttempt(ids))).toBe(true);
    await drain(td, 5 * 60_000, 60_000);
    expect((await booking(b.id)).state).toBe("cancel_unverified"); // re-reads keep failing; still locked
    expect(isConflict(await secondAttempt(ids))).toBe(true);
    td.readFails = 0;
    await drain(td, 30 * 60_000, 60_000);
    const done = await booking(b.id);
    expect(done.state).toBe("cancelled");
    expect(done.supplierStatusCode).toBe(4);
    expect(td.calls.filter((c) => c === "cancel")).toHaveLength(1);
    // Only now, on TravelDesk's cancelled status, may a new attempt be made.
    const next = await create(forOrder(ids));
    expect(next.orderItemId).toBe(ids.orderItemId);
    expect(next.attempt).toBe(2);
  });

  it("a cancel requested while a confirm is in flight waits and then runs", async () => {
    const td = new FakeTravelDesk(now);
    const b = await create(intent({ afterReserve: "hold" }));
    await drain(td, 0);
    await svc.requestCancel(b.id, { now });
    await prisma.supplierBooking.update({ where: { id: b.id }, data: { state: "confirming" } });
    const r = await svc.runDueJobs(deps(td), { budgetMs: 60_000 });
    expect(r.processed.map((p) => p.outcome)).toContain("cancel_pending");
    await prisma.supplierBooking.update({ where: { id: b.id }, data: { state: "confirmed" } });
    await drain(td, 60_000, 16_000);
    expect((await booking(b.id)).state).toBe("cancelled");
  });

  /* -------------------------------------------------------------------------
   * Leases, workers and crashes (SUP-8, SUP-11)
   * ---------------------------------------------------------------------- */

  it("a held account lease defers the mutation without calling TravelDesk", async () => {
    const td = new FakeTravelDesk(now);
    await holdLease("someone-else", 60);
    const b = await create(intent());
    const r = await svc.runDueJobs(deps(td), { budgetMs: 60_000 });
    expect(r.processed.map((p) => p.outcome)).toEqual(["lease_busy"]);
    expect(td.calls).toEqual([]);
    expect(await prisma.supplierJob.findUniqueOrThrow({ where: { dedupeKey: `reserve:${b.id}` } })).toMatchObject({ status: "queued" });
    await holdLease("someone-else", -1); // the other holder's lease ran out
    clock += 16_000;
    await drain(td, 0);
    expect((await booking(b.id)).state).toBe("confirmed");
  });

  it("two workers at once still send one reserve", async () => {
    const td = new FakeTravelDesk(now);
    const b = await create(intent());
    await Promise.all([svc.runDueJobs(deps(td, { holder: "w1" }), { budgetMs: 60_000 }), svc.runDueJobs(deps(td, { holder: "w2" }), { budgetMs: 60_000 })]);
    await drain(td, 0);
    expect(td.calls.filter((c) => c === "reserve")).toHaveLength(1);
    expect((await booking(b.id)).state).toBe("confirmed");
  });

  it("two workers whose clocks differ by 90 s still send one reserve: the lease runs on the database clock (SUP-11)", async () => {
    const td = new FakeTravelDesk(now);
    const b = await create(intent({ afterReserve: "hold" }));
    const ahead = () => new Date(clock + 90_000);
    // The worker ahead holds the lease for the whole call, whatever the other one's clock says.
    let release: () => void = () => {};
    const gate = new Promise<void>((r) => (release = r));
    const realReserve = td.reserve.bind(td);
    td.reserve = async (body) => {
      await gate;
      return realReserve(body);
    };
    const w1 = svc.runDueJobs(deps(td, { holder: "skew-ahead", now: ahead }), { budgetMs: 60_000, maxJobs: 1 });
    await new Promise((r) => setTimeout(r, 300));
    clock += 120_000; // the other worker's clock now reads past any app-clock lease the first one could have set
    const w2 = svc.runDueJobs(deps(td, { holder: "skew-behind" }), { budgetMs: 60_000, maxJobs: 1 });
    setTimeout(release, 500);
    await Promise.all([w1, w2]);
    expect(td.calls.filter((c) => c === "reserve")).toHaveLength(1);
    expect((await booking(b.id)).state).toBe("reserved");
  });

  it("a worker whose clock runs slow cannot send a confirm the database clock says is too late (CR-B1-6)", async () => {
    const td = new FakeTravelDesk(now);
    // A 4-minute hold: by the reserving worker's clock it is already inside the 5-minute confirm budget.
    td.deadlineMs = 4 * 60_000;
    const b = await create(intent());
    await svc.runDueJobs(deps(td), { budgetMs: 60_000, maxJobs: 1 });
    expect((await booking(b.id)).state).toBe("reserved");
    const sent = (await events(b.id)).find((e) => e.kind === "request_sent" && e.operation === "bookings.reserve")!;
    expect(typeof (sent.detail as { dbSkewMs?: unknown }).dbSkewMs).toBe("number");
    // A second worker two minutes slow thinks there is time; its own checks pass. The database clock does not.
    await prisma.supplierJob.update({ where: { dedupeKey: `confirm:${b.id}` }, data: { runAfter: new Date(clock - 10 * 60_000) } });
    const slow = () => new Date(clock - 120_000);
    const r = await svc.runDueJobs(deps(td, { now: slow }), { budgetMs: 60_000, maxJobs: 1 });
    expect(r.processed.map((p) => p.outcome)).toEqual(["deadline_too_close"]);
    const held = await booking(b.id);
    expect(held).toMatchObject({ state: "reserved", errorCode: "confirm_deadline_too_close" });
    expect(held.attentionRequiredAt).not.toBeNull();
    expect((await events(b.id)).some((e) => e.kind === "attention" && (e.detail as { via?: string }).via === "db_clock")).toBe(true);
    expect(td.calls).toEqual(["reserve"]);
  });

  it("a held mutation lease is kept alive while a slow cancel and its re-read run (CR-B1-7)", async () => {
    const td = new FakeTravelDesk(now);
    const b = await create(intent());
    await drain(td, 0);
    const beats: (Date | null)[] = [];
    const lease = async () => (await prisma.supplierAccountLease.findFirstOrThrow({ where: { supplierId } })).heartbeatAt;
    td.onCancel = async () => {
      beats.push(await lease());
      await new Promise((r) => setTimeout(r, 400));
      beats.push(await lease());
    };
    await svc.requestCancel(b.id, { now });
    await svc.runDueJobs(deps(td, { leaseHeartbeatMs: 50 }), { budgetMs: 60_000 });
    expect((await booking(b.id)).state).toBe("cancelled");
    expect(beats[0]).not.toBeNull();
    expect(beats[1]!.getTime()).toBeGreaterThan(beats[0]!.getTime());
  });

  it("a worker lost mid-call is swept to outcome_unknown and recovered, not resent", async () => {
    const td = new FakeTravelDesk(now);
    const b = await create(intent());
    // A worker that sent the reserve and died: booking in reserving, job running with an expired lock.
    await prisma.supplierBooking.update({ where: { id: b.id }, data: { state: "reserving", requestSentAt: new Date(clock) } });
    await prisma.supplierJob.update({ where: { dedupeKey: `reserve:${b.id}` }, data: { status: "running", lockedBy: "dead-worker", lockedUntil: new Date(Date.now() - 1_000) } });
    await td.reserve({ ...(b.requestPayload as Record<string, unknown>), referenceNumber: b.clientRef, guestName: b.guestName });
    td.calls = [];
    clock += 62_000;
    await drain(td);
    expect((await booking(b.id)).state).toBe("confirmed");
    expect(td.calls).not.toContain("reserve");
    expect(td.calls).toContain("list");
  });

  it("the sweep leaves a sending booking alone while a mutation lease on its account is live (SUP-11)", async () => {
    const td = new FakeTravelDesk(now);
    const b = await create(intent());
    await prisma.supplierBooking.update({ where: { id: b.id }, data: { state: "reserving", requestSentAt: new Date(clock - 10 * 60_000) } });
    await prisma.supplierJob.deleteMany({ where: { supplierBookingId: b.id } });
    await holdLease("slow-worker", 60);
    await svc.runDueJobs(deps(td), { budgetMs: 60_000 });
    expect((await booking(b.id)).state).toBe("reserving");
    await releaseLeases();
    await svc.runDueJobs(deps(td), { budgetMs: 60_000, maxJobs: 0 });
    expect(await booking(b.id)).toMatchObject({ state: "outcome_unknown", errorCode: "worker_lost" });
  });

  it("a database fault after the send leaves the booking for the sweep, which recovers it without a resend (SUP-8)", async () => {
    const td = new FakeTravelDesk(now);
    const b = await create(intent());
    const real = svc.applySupplierState;
    svc.applySupplierState = async () => {
      svc.applySupplierState = real;
      throw new Error("connection reset");
    };
    const r = await svc.runDueJobs(deps(td), { budgetMs: 60_000, maxJobs: 1 });
    expect(r.processed[0].outcome).toContain("connection reset");
    expect((await booking(b.id)).state).toBe("reserving");
    expect(await prisma.supplierJob.findUniqueOrThrow({ where: { dedupeKey: `reserve:${b.id}` } })).toMatchObject({ status: "failed" });
    expect((await events(b.id)).some((e) => e.kind === "alert")).toBe(true);
    clock += 62_000;
    await drain(td);
    expect((await booking(b.id)).state).toBe("confirmed");
    expect(td.calls.filter((c) => c === "reserve")).toHaveLength(1);
  });

  it("a worker only claims jobs of its own environment", async () => {
    const td = new FakeTravelDesk(now);
    const b = await create(intent());
    const r = await svc.runDueJobs(deps(td, { environment: "production", accountId: "777" }), { budgetMs: 60_000 });
    expect(r.processed).toEqual([]);
    expect((await booking(b.id)).state).toBe("queued");
    await drain(td, 0);
  });

  /* -------------------------------------------------------------------------
   * Recovery that never stops (SUP-5) and the shared lane (SUP-6)
   * ---------------------------------------------------------------------- */

  it("a ten-minute read outage raises a dead-letter alert but recovery goes on and ends without a human (SUP-5)", async () => {
    const td = new FakeTravelDesk(now);
    td.steps.reserve.push("lost");
    const b = await create(intent());
    await svc.runDueJobs(deps(td), { budgetMs: 60_000, maxJobs: 1 });
    td.outageUntil = clock + 10 * 60_000;
    await drain(td, 10 * 60_000, 30_000);
    const during = await booking(b.id);
    expect(during.state).toBe("outcome_unknown");
    expect(during.closedAt).toBeNull();
    const job = await prisma.supplierJob.findUniqueOrThrow({ where: { dedupeKey: `recover:${b.id}` } });
    expect(job.status).toBe("queued");
    expect((await events(b.id)).some((e) => e.kind === "dead_letter")).toBe(true);
    await drain(td, 40 * 60_000, 60_000);
    // The hold lapsed during the outage; the watchdog's read records it. No human step was needed.
    expect(["confirmed", "expired"]).toContain((await booking(b.id)).state);
    expect(td.calls.filter((c) => c === "reserve")).toHaveLength(1);
  });

  it("a read job's error count starts again after progress (SUP-5)", async () => {
    const td = new FakeTravelDesk(now);
    td.steps.confirm.push("in_progress");
    const b = await create(intent());
    await drain(td, 0);
    for (let round = 0; round < 3; round++) {
      td.readFails = 3;
      await drain(td, 10 * 60_000, 30_000);
    }
    const job = await prisma.supplierJob.findUniqueOrThrow({ where: { dedupeKey: `poll:${b.id}` } });
    expect(job.attempts).toBe(0);
    expect((await events(b.id)).some((e) => e.kind === "dead_letter")).toBe(false);
  });

  it("a read never runs beside another worker's mutation on the account, and that is not an error (SUP-6)", async () => {
    const td = new FakeTravelDesk(now);
    td.steps.reserve.push("lost");
    const b = await create(intent());
    await svc.runDueJobs(deps(td), { budgetMs: 60_000, maxJobs: 1 });
    td.calls = [];
    await holdLease("other-worker", 60);
    clock += 31_000;
    const r = await svc.runDueJobs(deps(td), { budgetMs: 60_000, maxJobs: 1 });
    expect(r.processed.map((p) => p.outcome)).toEqual(["lane_busy"]);
    expect(td.calls).toEqual([]);
    expect(await prisma.supplierJob.findUniqueOrThrow({ where: { dedupeKey: `recover:${b.id}` } })).toMatchObject({ status: "queued", attempts: 0 });
    await releaseLeases();
    await drain(td);
    expect((await booking(b.id)).state).toBe("confirmed");
  });

  it("reads come out of one per-account budget; a spent budget waits without counting an error (SUP-6)", async () => {
    const td = new FakeTravelDesk(now);
    td.steps.reserve.push(new TravelDeskApiError("network", "bookings.reserve"), new TravelDeskApiError("network", "bookings.reserve"));
    const a = await create(intent());
    const b = await create(intent());
    await svc.runDueJobs(deps(td), { budgetMs: 60_000, maxJobs: 2 });
    await prisma.setting.deleteMany({ where: { key: engine.requestBudgetKey(CODE, "test", "default") } });
    clock += 31_000;
    const r = await svc.runDueJobs(deps(td, { readLimits: readLimits(1) }), { budgetMs: 60_000, maxJobs: 2 });
    expect(r.processed.map((p) => p.outcome).sort()).toEqual(["read_budget", "searching"]);
    for (const id of [a.id, b.id]) expect((await prisma.supplierJob.findUniqueOrThrow({ where: { dedupeKey: `recover:${id}` } })).attempts).toBe(0);
  });

  it("quote reads use only their share of the window; engine reads keep their reserve (CR-B2-3)", async () => {
    const account = `quote-share-${RUN}`;
    const key = engine.requestBudgetKey(CODE, "test", account);
    await prisma.setting.deleteMany({ where: { key } });
    const quote = () => engine.takeQuoteReadToken(CODE, "test", account, { limits: readLimits(8, 0.25) });
    const read = () => engine.takeReadToken(CODE, "test", account, readLimits(8, 0.25));
    // Quotes exhausted: the third is refused, and the engine still gets all six of its reserve.
    expect([await quote(), await quote(), await quote()]).toEqual([true, true, false]);
    for (let i = 0; i < 6; i++) expect(await read()).toBe(true);
    expect(await read()).toBe(false);
    expect(await quote()).toBe(false);
    expect((await prisma.setting.findUniqueOrThrow({ where: { key } })).value).toMatchObject({ used: 8, quoteUsed: 2 });
    // Engine first: it may take the whole window, which then refuses quotes too.
    await prisma.setting.deleteMany({ where: { key } });
    for (let i = 0; i < 8; i++) expect(await read()).toBe(true);
    expect(await quote()).toBe(false);
    // A row from before the quote class counts no quote reads; an expired window starts afresh for either class.
    await prisma.setting.update({ where: { key }, data: { value: { windowStart: new Date(Date.now() - 120_000).toISOString(), used: 8 } } });
    expect(await quote()).toBe(true);
    expect((await prisma.setting.findUniqueOrThrow({ where: { key } })).value).toMatchObject({ used: 1, quoteUsed: 1 });
    // Many concurrent quotes never take more than their cap.
    await prisma.setting.deleteMany({ where: { key } });
    const results = await Promise.all(Array.from({ length: 10 }, quote));
    expect(results.filter(Boolean)).toHaveLength(2);
    for (let i = 0; i < 6; i++) expect(await read()).toBe(true);
    await prisma.setting.deleteMany({ where: { key } });
  });

  it("a browse flood leaves quote and engine reads unaffected (doc 29 §6.3, Batch 2)", async () => {
    const account = `browse-share-${RUN}`;
    const key = engine.requestBudgetKey(CODE, "test", account);
    await prisma.setting.deleteMany({ where: { key } });
    // 20 reads a window, a customer share of 8: 5 quote, 3 browse carved out of it, 12 engine reserve.
    const limits = readLimits(20, 0.4, 0.15);
    expect(limits).toEqual({ perMinute: 20, quoteCap: 5, browseCap: 3, engineReserve: 12 });
    const browse = () => engine.takeBrowseReadToken(CODE, "test", account, { limits });
    const quote = () => engine.takeQuoteReadToken(CODE, "test", account, { limits });
    const read = () => engine.takeReadToken(CODE, "test", account, limits);
    // A concurrent flood takes only the browse share.
    const flood = await Promise.all(Array.from({ length: 25 }, browse));
    expect(flood.filter(Boolean)).toHaveLength(3);
    // Quotes then get their whole share, and the engine its whole reserve.
    for (let i = 0; i < 5; i++) expect(await quote()).toBe(true);
    expect(await quote()).toBe(false);
    for (let i = 0; i < 12; i++) expect(await read()).toBe(true);
    expect(await read()).toBe(false);
    expect((await prisma.setting.findUniqueOrThrow({ where: { key } })).value).toMatchObject({ used: 20, quoteUsed: 5, browseUsed: 3 });
    // Browse never takes a read the quotes' unused share still needs: engine 14 used, 6 left, 5 for quotes.
    await prisma.setting.deleteMany({ where: { key } });
    for (let i = 0; i < 14; i++) expect(await read()).toBe(true);
    expect(await browse()).toBe(true);
    expect(await browse()).toBe(false);
    for (let i = 0; i < 5; i++) expect(await quote()).toBe(true);
    // A row from before the browse class counts no browse reads.
    await prisma.setting.update({ where: { key }, data: { value: { windowStart: new Date().toISOString(), used: 2, quoteUsed: 0 } } });
    expect(await browse()).toBe(true);
    expect((await prisma.setting.findUniqueOrThrow({ where: { key } })).value).toMatchObject({ used: 3, browseUsed: 1 });
    // Limits without a browse cap refuse browse.
    await prisma.setting.deleteMany({ where: { key } });
    expect(await engine.takeBrowseReadToken(CODE, "test", account, { limits: readLimits(20, 0.25) })).toBe(false);
    await prisma.setting.deleteMany({ where: { key } });
  });

  /* -------------------------------------------------------------------------
   * Ordering and admission (SUP-7), and what a run may send (SEC-8)
   * ---------------------------------------------------------------------- */

  it("a confirm near its deadline is claimed before five queued reserves (SUP-7)", async () => {
    const td = new FakeTravelDesk(now);
    const held = await create(intent());
    await svc.runDueJobs(deps(td), { budgetMs: 60_000, maxJobs: 1 });
    expect((await booking(held.id)).state).toBe("reserved");
    for (let i = 0; i < 5; i++) await create(intent());
    const r = await svc.runDueJobs(deps(td), { budgetMs: 60_000, maxJobs: 1 });
    expect(r.processed.map((p) => p.kind)).toEqual(["confirm"]);
    expect((await booking(held.id)).state).toBe("confirmed");
    await drain(td, 0);
  });

  it("a new reservation waits while queued confirms would not fit before their deadlines (SUP-7)", async () => {
    const td = new FakeTravelDesk(now);
    const held = await create(intent());
    await svc.runDueJobs(deps(td), { budgetMs: 60_000, maxJobs: 1 });
    // Its confirm is queued with a send deadline, but not due yet.
    await prisma.supplierJob.update({ where: { dedupeKey: `confirm:${held.id}` }, data: { runAfter: new Date(clock + 3600_000) } });
    const next = await create(intent());
    const r = await svc.runDueJobs(deps(td, { mutationP95Ms: 10 * 60_000 }), { budgetMs: 60_000, maxJobs: 1 });
    expect(r.processed.map((p) => p.outcome)).toEqual(["admission_deferred"]);
    expect((await booking(next.id)).state).toBe("queued");
    expect(td.calls.filter((c) => c === "reserve")).toHaveLength(1);
  });

  it("a confirm re-queued because the lease is busy keeps its send deadline (CR-B1-5, SUP-7)", async () => {
    const td = new FakeTravelDesk(now);
    const held = await create(intent());
    await svc.runDueJobs(deps(td), { budgetMs: 60_000, maxJobs: 1 });
    const job = () => prisma.supplierJob.findUniqueOrThrow({ where: { dedupeKey: `confirm:${held.id}` } });
    const deadline = (await job()).deadlineAt;
    expect(deadline).not.toBeNull();
    await holdLease("busy-worker", 60);
    const r = await svc.runDueJobs(deps(td), { budgetMs: 60_000, maxJobs: 1 });
    expect(r.processed.map((p) => p.outcome)).toEqual(["lease_busy"]);
    expect(await job()).toMatchObject({ status: "queued", deadlineAt: deadline });
    await releaseLeases();
  });

  it("a budget too short for a mutation still runs read jobs (SUP-7)", async () => {
    const td = new FakeTravelDesk(now);
    td.steps.reserve.push("lost");
    const lost = await create(intent());
    await svc.runDueJobs(deps(td), { budgetMs: 60_000, maxJobs: 1 });
    const waiting = await create(intent());
    clock += 31_000;
    const r = await svc.runDueJobs(deps(td), { budgetMs: 20_000 });
    expect(r.processed.map((p) => p.kind)).toContain("recover");
    expect(r.processed.map((p) => p.kind)).not.toContain("reserve");
    expect((await booking(waiting.id)).state).toBe("queued");
    expect((await booking(lost.id)).state).not.toBe("queued");
  });

  it("a run without mutations (the scheduled cron) recovers but never sends (SEC-8)", async () => {
    const td = new FakeTravelDesk(now);
    td.steps.reserve.push("lost");
    const lost = await create(intent());
    await svc.runDueJobs(deps(td), { budgetMs: 60_000, maxJobs: 1 });
    const fresh = await create(intent());
    td.calls = [];
    await drain(td, 3 * 60_000, 31_000, { mutations: false });
    expect(td.calls.some((c) => ["reserve", "confirm", "create", "cancel"].includes(c))).toBe(false);
    expect((await events(fresh.id)).some((e) => e.kind === "request_sent")).toBe(false);
    expect((await booking(fresh.id)).state).toBe("queued");
    expect((await booking(lost.id)).state).toBe("reserved"); // found by recovery; its confirm waits for a mutation run
  });

  /* -------------------------------------------------------------------------
   * Account pin (SUP-10) and clock skew (SUP-21)
   * ---------------------------------------------------------------------- */

  it("a key that answers for another agency refuses every mutation, while reads go on (SUP-10)", async () => {
    const td = new FakeTravelDesk(now);
    td.agencyId = 4242;
    const pinned = { accountId: "4242" };
    const ok = await create(intent({ afterReserve: "hold" }), pinned);
    expect(ok.accountId).toBe("4242");
    await drain(td, 0, 31_000, pinned);
    expect((await booking(ok.id)).state).toBe("reserved");

    td.agencyId = 9999; // a key swap
    const b = await create(intent(), pinned);
    const r = await svc.runDueJobs(deps(td, pinned), { budgetMs: 60_000 });
    expect(r.processed.map((p) => p.outcome)).toContain("account_mismatch");
    const refused = await booking(b.id);
    expect(refused).toMatchObject({ state: "queued", errorCode: "account_mismatch" });
    expect(refused.attentionRequiredAt).not.toBeNull();
    expect(td.calls.filter((c) => c === "reserve")).toHaveLength(1);
    // The watchdog still reads the held reservation and records its end.
    await drain(td, 20 * 60_000, 60_000, pinned);
    expect((await booking(ok.id)).state).toBe("expired");
    expect(td.calls.filter((c) => c === "reserve")).toHaveLength(1);
    // A worker for another account never claims these rows.
    expect((await svc.runDueJobs(deps(td), { budgetMs: 60_000 })).processed).toEqual([]);
  });

  it("open rows of another account are reported once with attention, and never claimed (CR-B1-8)", async () => {
    const td = new FakeTravelDesk(now);
    td.agencyId = 5151;
    const pinned = { accountId: "5151" };
    const b = await create(intent(), pinned);
    const job = await prisma.supplierJob.findUniqueOrThrow({ where: { dedupeKey: `reserve:${b.id}` } });
    const r = await svc.runDueJobs(deps(td), { budgetMs: 60_000 });
    expect(r.stranded.open).toBeGreaterThanOrEqual(1);
    expect(r.stranded.flagged).toBeGreaterThanOrEqual(1);
    expect(r.processed.map((p) => p.job)).not.toContain(job.id);
    const stranded = await booking(b.id);
    expect(stranded.state).toBe("queued");
    expect(stranded.attentionRequiredAt).not.toBeNull();
    const alerts = async () => (await events(b.id)).filter((e) => e.kind === "alert" && (e.detail as { reason?: string }).reason === "account_stranded");
    expect(await alerts()).toHaveLength(1);
    // Reported once, however often the other worker runs.
    await svc.runDueJobs(deps(td), { budgetMs: 60_000 });
    expect(await alerts()).toHaveLength(1);
    // A worker of the row's own account still runs it.
    await drain(td, 0, 31_000, pinned);
    expect((await booking(b.id)).state).not.toBe("queued");
  });

  it("the read budget counts list pages, not jobs; a cut listing is no search and no error (CR-B1-9)", async () => {
    const td = new FakeTravelDesk(now);
    td.steps.reserve.push(new TravelDeskApiError("network", "bookings.reserve"));
    const b = await create(intent());
    await svc.runDueJobs(deps(td), { budgetMs: 60_000, maxJobs: 1 });
    expect((await booking(b.id)).state).toBe("outcome_unknown");
    // Three other agencies' bookings on the same date and offer: three pages of one row each.
    for (let i = 0; i < 3; i++) td.plant({ ...(b.requestPayload as Record<string, unknown>), referenceNumber: `OTHER-${RUN}-${i}` }, 7);
    const paged = new TravelDeskBookingAdapter(td, { environment: "test", now, onPage: 1 });
    await prisma.setting.deleteMany({ where: { key: engine.requestBudgetKey(CODE, "test", "default") } });
    td.calls = [];
    clock += 31_000;
    const r = await svc.runDueJobs(deps(td, { adapter: paged, readLimits: readLimits(2) }), { budgetMs: 60_000, maxJobs: 1 });
    // The job's token pays for page 1, page 2 takes the second token, page 3 and the re-read are refused.
    expect(r.processed.map((p) => p.outcome)).toEqual(["searching:list_incomplete"]);
    expect(td.calls.filter((c) => c === "list")).toHaveLength(2);
    const after = await booking(b.id);
    expect(after).toMatchObject({ state: "outcome_unknown", recoverySearches: 0 });
    expect((await prisma.supplierJob.findUniqueOrThrow({ where: { dedupeKey: `recover:${b.id}` } })).attempts).toBe(0);
    // With budget, the same search completes and counts.
    clock += 31_000;
    await svc.runDueJobs(deps(td, { adapter: paged }), { budgetMs: 60_000, maxJobs: 1 });
    expect((await booking(b.id)).recoverySearches).toBe(1);
    await drain(td, 20 * 60_000, 60_000);
  });

  it("records the supplier's clock skew on mutation responses (SUP-21)", async () => {
    const td = new FakeTravelDesk(now);
    const adapter = adapterFor(td);
    adapter.lastCall = () => ({ httpStatus: 201, serverDate: new Date(clock + 7_000).toUTCString() });
    const b = await create(intent({ afterReserve: "hold" }));
    await svc.runDueJobs(deps(td, { adapter }), { budgetMs: 60_000, maxJobs: 1 });
    const res = (await events(b.id)).find((e) => e.kind === "response" && e.operation === "bookings.reserve")!;
    expect(res.httpStatus).toBe(201);
    expect((res.detail as { skewMs: number }).skewMs).toBeGreaterThanOrEqual(6_000);
  });

  /* -------------------------------------------------------------------------
   * Customer intents (PAY-1)
   * ---------------------------------------------------------------------- */

  describe("customer intents wait for captured payment (PAY-1)", () => {
    function port(paid: Set<string>, onRead?: () => void): PaymentEvidencePort {
      return {
        async capturedFor(orderItemId) {
          onRead?.();
          if (!paid.has(orderItemId)) return null;
          return { orderItemId, paymentId: uuidv7(), provider: "test", providerPaymentId: "pay_test", currency: "AED", capturedMinor: 30_000n, verifiedAt: now() };
        },
      };
    }

    it("refuses a confirm-after-reserve booking for an order item", async () => {
      const ids = await orderItem();
      expect(code(await create(forOrder(ids, { afterReserve: "confirm" })).catch((e) => e))).toBe("VALIDATION_FAILED");
    });

    it("with the stub port a customer booking is never confirmed; the hold lapses and the watchdog records it", async () => {
      const td = new FakeTravelDesk(now);
      const ids = await orderItem();
      const b = await create(forOrder(ids));
      await drain(td, 0);
      expect((await booking(b.id)).state).toBe("awaiting_payment");
      expect(isConflict(await secondAttempt(ids))).toBe(true);
      expect(await svc.confirmIfPaid(b.id, { now })).toBe("no_payment_evidence");
      await drain(td, 20 * 60_000, 60_000);
      expect((await booking(b.id)).state).toBe("expired");
      expect(td.calls).not.toContain("confirm");
    });

    it("confirms only on evidence, re-read right before the send", async () => {
      const td = new FakeTravelDesk(now);
      const paid = new Set<string>();
      const payments = port(paid);
      const ids = await orderItem();
      const b = await create(forOrder(ids));
      await drain(td, 0, 31_000, { payments });
      expect((await booking(b.id)).state).toBe("awaiting_payment");

      // Evidence seen when the confirm was queued but gone at send time: nothing is sent.
      paid.add(ids.orderItemId);
      expect(await svc.confirmIfPaid(b.id, { payments, now })).toBe("confirm_queued");
      paid.delete(ids.orderItemId);
      expect(await drain(td, 0, 31_000, { payments })).toContain("confirm:awaiting_payment");
      expect(td.calls).toEqual(["reserve"]);

      paid.add(ids.orderItemId);
      await svc.confirmIfPaid(b.id, { payments, now });
      await drain(td, 0, 31_000, { payments });
      expect((await booking(b.id)).state).toBe("confirmed");
      expect(td.calls).toEqual(["reserve", "confirm"]);
      const sent = await prisma.supplierBookingEvent.findFirst({ where: { supplierBookingId: b.id, kind: "request_sent", operation: "bookings.confirm" } });
      expect(sent?.detail).toMatchObject({ provider: "test" });

      // Evidence already there when the reservation lands: the confirm follows at once.
      const td2 = new FakeTravelDesk(now);
      const ids2 = await orderItem();
      paid.add(ids2.orderItemId);
      const c = await create(forOrder(ids2));
      await drain(td2, 0, 31_000, { payments });
      expect((await booking(c.id)).state).toBe("confirmed");
      expect(td2.calls).toEqual(["reserve", "confirm"]);
    });

    it("the deadline is checked again right before the send, after the evidence read (CR-8)", async () => {
      const td = new FakeTravelDesk(now);
      const paid = new Set<string>();
      const ids = await orderItem();
      const b = await create(forOrder(ids));
      await drain(td, 0, 31_000, { payments: port(paid) });
      const held = await booking(b.id);
      paid.add(ids.orderItemId);
      await svc.confirmIfPaid(b.id, { payments: port(paid), now });
      // A slow evidence read: by the time it answers, too little of the hold is left.
      const slow = port(paid, () => {
        clock = held.reservationDeadline!.getTime() - 60_000;
      });
      expect(await drain(td, 0, 31_000, { payments: slow })).toContain("confirm:deadline_too_close");
      expect(td.calls).not.toContain("confirm");
      expect(await booking(b.id)).toMatchObject({ state: "awaiting_payment", errorCode: "confirm_deadline_too_close" });
    });

    it("a customer booking TravelDesk shows as final without captured payment is never confirmed; it stays blocking and is re-read", async () => {
      const td = new FakeTravelDesk(now);
      const paid = new Set<string>();
      const payments = port(paid);
      const ids = await orderItem();
      const b = await create(forOrder(ids));
      await drain(td, 0, 31_000, { payments });
      const held = await booking(b.id);
      expect(held.state).toBe("awaiting_payment");
      // Confirmed outside the engine (an agent in the TravelDesk portal, say): final, flags clear, our identity and amount.
      const sid = held.supplierBookingId!;
      td.store.set(sid, { ...td.store.get(sid)!, status: 5, reservationDeadline: null });
      await drain(td, 20 * 60_000, 60_000, { payments });
      const after = await booking(b.id);
      expect(after).toMatchObject({ state: "outcome_unknown", errorCode: "supplier_final_without_payment", closedAt: null });
      expect(after.attentionRequiredAt).not.toBeNull();
      expect(td.calls).not.toContain("confirm");
      const ev = await prisma.supplierBookingEvent.findFirst({ where: { supplierBookingId: b.id, kind: "supplier_final_without_payment" }, orderBy: { at: "asc" } });
      expect(ev?.detail).toEqual({ via: "watchdog", supplierStatus: "CONFIRMED" });
      expect(isConflict(await secondAttempt(ids))).toBe(true);
      expect(await prisma.supplierJob.findUnique({ where: { dedupeKey: `recover:${b.id}` } })).toMatchObject({ status: "queued" });

      // Recovery keeps re-reading; once capture is recorded a re-read may confirm it. No confirm is ever sent.
      paid.add(ids.orderItemId);
      await drain(td, 60 * 60_000, 60_000, { payments });
      expect((await booking(b.id)).state).toBe("confirmed");
      expect(td.calls).not.toContain("confirm");
    });

    it("an order id without its order item is refused at intake, and only an order waits for payment", async () => {
      const ids = await orderItem();
      expect(code(await create(intent({ orderId: ids.orderId })).catch((e) => e))).toBe("VALIDATION_FAILED");
      expect(code(await create(intent({ orderId: ids.orderId, afterReserve: "confirm" })).catch((e) => e))).toBe("VALIDATION_FAILED");
      expect(code(await create(intent({ afterReserve: "await_payment" })).catch((e) => e))).toBe("VALIDATION_FAILED");
    });

    it("a row linked to an order is a customer booking whatever else it says: never auto-confirmed, never one-step created", async () => {
      const td = new FakeTravelDesk(now);
      // Its order item went away (FK SET NULL) and the row says confirm, as a pre-B1a row might.
      const a = await create(forOrder(await orderItem()));
      await prisma.supplierBooking.update({ where: { id: a.id }, data: { orderItemId: null, afterReserve: "confirm" } });
      await drain(td, 0);
      expect((await booking(a.id)).state).toBe("awaiting_payment");
      expect(td.calls).toEqual(["reserve"]);

      // A queued one-step row for an order item written without intake: the create is never sent.
      const c = await create(forOrder(await orderItem()));
      await prisma.supplierBooking.update({ where: { id: c.id }, data: { mode: "one_step" } });
      await prisma.supplierJob.deleteMany({ where: { supplierBookingId: c.id } });
      clock += 3 * 60_000;
      await drain(td, 0);
      expect(await booking(c.id)).toMatchObject({ state: "not_created", errorCode: "create_needs_payment" });
      expect(td.calls).toEqual(["reserve"]);
    });
  });

  it("a booking left without a job (crash after a state change) is picked up by the sweep", async () => {
    const td = new FakeTravelDesk(now);
    const i = intent();
    const b = await create(i);
    await prisma.supplierJob.deleteMany({ where: { supplierBookingId: b.id } });
    // Same key and request again: the queued row gets its job back.
    await create(i);
    expect(await prisma.supplierJob.count({ where: { supplierBookingId: b.id, status: "queued" } })).toBe(1);
    await drain(td, 0);
    // Now lose the confirm job of a reserved booking.
    const c = await create(intent({ afterReserve: "hold" }));
    await drain(td, 0);
    await prisma.supplierBooking.update({ where: { id: c.id }, data: { afterReserve: "confirm" } });
    await prisma.supplierJob.deleteMany({ where: { supplierBookingId: c.id } });
    clock += 3 * 60_000;
    await drain(td, 0);
    expect((await booking(b.id)).state).toBe("confirmed");
    expect((await booking(c.id)).state).toBe("confirmed");
  });

  it("concurrent intents with one key return one booking", async () => {
    const i = intent();
    const [a, b] = await Promise.all([create(i), create(i)]);
    expect(a.id).toBe(b.id);
    await drain(new FakeTravelDesk(now), 0);
  });

  it("a cancelled or expired answer that is not about our booking never releases the order item", async () => {
    const td = new FakeTravelDesk(now);
    const ids = await orderItem();
    const b = await create(forOrder(ids));
    await drain(td, 0);
    const held = await booking(b.id);
    expect(held.state).toBe("awaiting_payment");
    // Reading our id returns someone else's timed-out booking (key or agency swap, id reuse).
    const sid = held.supplierBookingId!;
    td.store.set(sid, { ...td.store.get(sid)!, status: 8, bookingReference: "AGENT-OTHER" });
    await drain(td, 20 * 60_000, 60_000);
    const after = await booking(b.id);
    expect(after).toMatchObject({ state: "manual_review", errorCode: "supplier_identity_mismatch", supplierBookingId: sid });
    expect(after.attentionRequiredAt).not.toBeNull();
    expect(after.supplierStatusCode).toBe(7); // the foreign answer is not stored
    expect(isConflict(await secondAttempt(ids))).toBe(true);
  });

  /* -------------------------------------------------------------------------
   * Operator controls (SUP-2, SUP-10, SEC-10, CR-10)
   * ---------------------------------------------------------------------- */

  describe("operator controls", () => {
    const key = () => bookingControlKeyFor(CODE, "test", "default");
    const legacyKey = () => `supplier_bookings.${CODE}`;
    async function setControl(value: Record<string, unknown> | string) {
      await prisma.setting.upsert({ where: { key: key() }, create: { key: key(), value: value as never }, update: { value: value as never } });
    }
    afterAll(async () => {
      await prisma.setting.deleteMany({ where: { key: { in: [key(), legacyKey(), bookingControlKeyFor(CODE, "production", "default"), bookingControlKeyFor(CODE, "production", "777")] } } });
    });

    it("a new-sales pause refuses intents and holds reserves, while recovery and the confirm of a found reservation go on", async () => {
      const td = new FakeTravelDesk(now);
      td.steps.reserve.push("lost");
      const lost = await create(intent());
      await svc.runDueJobs(deps(td), { budgetMs: 60_000, maxJobs: 1 });
      expect((await booking(lost.id)).state).toBe("outcome_unknown");
      const waiting = await create(intent());

      await setControl({ paused: true, reason: "drill" });
      expect(isConflict(await create(intent()).catch((e) => e))).toBe(true);
      td.calls = [];
      await drain(td, 60_000);
      expect(td.calls).not.toContain("reserve");
      expect(td.calls).toContain("list"); // recovery of the lost reserve went on
      // The recovered reservation is confirmed inside its deadline: a pause never strands a hold (SUP-2).
      expect(td.calls).toContain("confirm");
      expect((await booking(lost.id)).state).toBe("confirmed");
      expect((await booking(waiting.id)).state).toBe("queued");

      await setControl({ paused: false });
      clock += 61_000;
      await drain(td, 60_000);
      expect((await booking(waiting.id)).state).toBe("confirmed");
    });

    it("a new-sales pause during a reservation still confirms inside the deadline", async () => {
      const td = new FakeTravelDesk(now);
      const b = await create(intent());
      await svc.runDueJobs(deps(td), { budgetMs: 60_000, maxJobs: 1 });
      expect((await booking(b.id)).state).toBe("reserved");
      await setControl({ paused: true, scope: "new_sales" });
      await drain(td, 0);
      expect((await booking(b.id)).state).toBe("confirmed");
      expect(td.calls).toEqual(["reserve", "confirm"]);
      await setControl({});
    });

    it("all_writes during a reservation sends no confirm; the watchdog records the expiry", async () => {
      const td = new FakeTravelDesk(now);
      const b = await create(intent());
      await svc.runDueJobs(deps(td), { budgetMs: 60_000, maxJobs: 1 });
      expect((await booking(b.id)).state).toBe("reserved");
      expect(await prisma.supplierJob.findUnique({ where: { dedupeKey: `watchdog:${b.id}` } })).toMatchObject({ status: "queued" });
      await setControl({ paused: true, scope: "all_writes", reason: "emergency" });
      await drain(td, 20 * 60_000, 60_000);
      expect((await booking(b.id)).state).toBe("expired");
      expect(td.calls).not.toContain("confirm");
      // Resuming after the deadline never sends the held confirm.
      await setControl({});
      clock += 61_000;
      await drain(td, 0);
      expect(td.calls).not.toContain("confirm");
      expect((await booking(b.id)).state).toBe("expired");
    });

    it("a recovered reservation with 30 s left is not confirmed", async () => {
      const td = new FakeTravelDesk(now);
      td.steps.reserve.push("lost");
      const b = await create(intent());
      await svc.runDueJobs(deps(td), { budgetMs: 60_000, maxJobs: 1 });
      expect((await booking(b.id)).state).toBe("outcome_unknown");
      // Recovery runs 31 s from now; leave it 30 s before the stored deadline.
      const [id] = [...td.store.keys()];
      td.store.set(id, { ...td.store.get(id)!, reservationDeadline: new Date(clock + 61_000).toISOString() });
      clock += 31_000;
      await drain(td, 0);
      const held = await booking(b.id);
      expect(held).toMatchObject({ state: "reserved", errorCode: "confirm_deadline_too_close" });
      expect(held.attentionRequiredAt).not.toBeNull();
      await drain(td, 5 * 60_000, 30_000);
      expect((await booking(b.id)).state).toBe("expired");
      expect(td.calls).not.toContain("confirm");
    });

    it("a missing production row counts as paused, production needs a pinned account, and the legacy row is read in test only", async () => {
      expect(isConflict(await create(intent({ environment: "production" }), { accountId: "777" }).catch((e) => e))).toBe(true);
      expect(isConflict(await create(intent({ environment: "production" })).catch((e) => e))).toBe(true);
      await prisma.setting.deleteMany({ where: { key: key() } });
      await prisma.setting.create({ data: { key: legacyKey(), value: { paused: true, reason: "legacy" } } });
      expect(isConflict(await create(intent()).catch((e) => e))).toBe(true);
      await setControl({});
      const ok = await create(intent());
      expect(ok.state).toBe("queued");
      await prisma.setting.delete({ where: { key: legacyKey() } });
    });

    it("a pause set after the job was claimed still stops the send", async () => {
      const td = new FakeTravelDesk(now);
      td.onBalance = async () => {
        await setControl({ paused: true });
        td.onBalance = null;
      };
      const b = await create(intent());
      const r = await svc.runDueJobs(deps(td), { budgetMs: 60_000 });
      expect(r.processed.map((p) => p.outcome)).toContain("paused");
      expect(td.calls).toEqual([]);
      expect((await booking(b.id)).state).toBe("queued");
      await setControl({});
      clock += 61_000;
      await drain(td, 0);
      expect((await booking(b.id)).state).toBe("confirmed");
    });

    it("cancels still run while paused", async () => {
      const td = new FakeTravelDesk(now);
      const b = await create(intent());
      await drain(td, 0);
      await setControl({ paused: true });
      await svc.requestCancel(b.id, { now });
      await drain(td, 0);
      expect((await booking(b.id)).state).toBe("cancelled");
      await setControl({});
    });

    it("a cap lowered after intake still applies at send time, as never sent (CR-10)", async () => {
      const td = new FakeTravelDesk(now);
      const b = await create(intent());
      await setControl({ maxBookingNetMinor: 20_000 });
      await drain(td, 0);
      expect(await booking(b.id)).toMatchObject({ state: "not_created", errorCode: "booking_cap" });
      expect(td.calls).toEqual([]);
      await setControl({});
    });

    it("tightening needs suppliers.pause only; loosening needs an applied approval for exactly that change, used once (SEC-10, PRD-12)", async () => {
      const { privilegedPayloadHash } = await import("../approval.service");
      const a = await createStaff(RUN, "ctl-a", ["admin"]);
      const b2 = await createStaff(RUN, "ctl-b", ["admin"]);
      const admin: Actor = { type: "admin", id: a.id, roles: ["admin"], permissions: new Set(["*"]) };
      const other: Actor = { type: "admin", id: b2.id, roles: ["admin"], permissions: new Set(["*"]) };
      const ops: Actor = { type: "admin", id: uuidv7(), roles: ["ops"], permissions: new Set(["suppliers.pause"]) };
      const content: Actor = { type: "admin", id: uuidv7(), roles: ["content"], permissions: new Set(["products.edit"]) };
      const on = { supplierCode: CODE, environment: "test" as const };
      await setControl({});

      expect(code(await svc.setControl(content, { paused: true }, "pause for drill", on).catch((e) => e))).toBe("FORBIDDEN");
      expect(code(await svc.setControl(ops, { paused: true }, "x", on).catch((e) => e))).toBe("VALIDATION_FAILED");
      expect(await svc.setControl(ops, { paused: true, reason: "supplier outage" }, "TravelDesk outage drill", on)).toMatchObject({ paused: true, scope: "new_sales" });
      expect((await prisma.auditLog.findFirst({ where: { actorId: ops.id, action: "supplier_bookings.pause" } }))?.reason).toBe("TravelDesk outage drill");
      expect(await svc.setControl(ops, { paused: true, scope: "all_writes", reason: "emergency" }, "emergency stop drill", on)).toMatchObject({ scope: "all_writes" });
      expect(await svc.setControl(ops, { maxBookingNetMinor: 300_000, minFundsAfterMinor: 0 }, "lower the cap for review", on)).toMatchObject({ paused: true, maxBookingNetMinor: 300_000 });
      // Loosening without an approval: refused, even for an admin.
      for (const [who, change] of [
        [ops, { paused: false }],
        [admin, { paused: false }],
        [admin, { paused: true, scope: "new_sales" }],
        [ops, { maxBookingNetMinor: 400_000, minFundsAfterMinor: 0 }],
      ] as const) {
        expect(code(await svc.setControl(who, change, "loosen without approval", on).catch((e) => e))).toBe("FORBIDDEN");
      }
      expect(await svc.controlChangeNeeds({ paused: false }, on)).toBe("supplier.resume");
      expect(await svc.controlChangeNeeds({ maxBookingNetMinor: 400_000, minFundsAfterMinor: 0 }, on)).toBe("supplier.limits.raise");
      expect(await svc.controlChangeNeeds({ paused: true, scope: "all_writes" }, on)).toBeNull();

      async function approval(change: Record<string, unknown>, opts: { op?: "supplier.resume" | "supplier.limits.raise"; env?: "test" | "production"; appliedAgoMs?: number; approvedBy?: string } = {}) {
        const op = opts.op ?? "supplier.resume";
        const permission = op === "supplier.resume" ? "suppliers.resume" : "suppliers.limits.raise";
        const environment = opts.env ?? "test";
        const { before } = await svc.controlRequest(change as never, { ...on, environment });
        const payload = engine.controlApprovalPayload(CODE, environment, "default", change as never, before);
        const at = new Date(Date.now() - (opts.appliedAgoMs ?? 0));
        const row = await prisma.privilegedApproval.create({
          data: {
            id: uuidv7(),
            operation: op,
            permission,
            payload: payload as never,
            payloadHash: privilegedPayloadHash(op, permission, environment, payload),
            environment,
            status: "applied",
            requestedBy: a.id,
            approvedBy: opts.approvedBy ?? null,
            approvedAt: opts.approvedBy ? at : null,
            requestedAt: at,
            appliedAt: at,
            expiresAt: new Date(at.getTime() + 30 * 60_000),
          },
        });
        return row.id;
      }

      const resume = await approval({ paused: false });
      // The approval is for one exact change.
      expect(isConflict(await svc.setControl(admin, { paused: true, scope: "new_sales" }, "clear the stop only", { ...on, approvalId: resume }).catch((e) => e))).toBe(true);
      // Someone who neither asked nor approved cannot use it.
      expect(code(await svc.setControl(other, { paused: false }, "resume after outage", { ...on, approvalId: resume }).catch((e) => e))).toBe("FORBIDDEN");
      expect(await svc.setControl(admin, { paused: false }, "resume after outage drill", { ...on, approvalId: resume })).toMatchObject({ paused: false });
      // Once only.
      await svc.setControl(ops, { paused: true }, "pause again for the drill", on);
      expect(isConflict(await svc.setControl(admin, { paused: false }, "resume again", { ...on, approvalId: resume }).catch((e) => e))).toBe(true);
      // Not after its time.
      const stale = await approval({ paused: false }, { appliedAgoMs: 31 * 60_000 });
      expect(isConflict(await svc.setControl(admin, { paused: false }, "resume late", { ...on, approvalId: stale }).catch((e) => e))).toBe(true);
      // A limit raise needs its own operation.
      const raise = await approval({ maxBookingNetMinor: 400_000, minFundsAfterMinor: 0 }, { op: "supplier.limits.raise" });
      expect(await svc.setControl(admin, { maxBookingNetMinor: 400_000, minFundsAfterMinor: 0 }, "raise the cap after review", { ...on, approvalId: raise })).toMatchObject({ maxBookingNetMinor: 400_000 });

      // Production: the database refuses an applied row without a second person.
      expect(await approval({ paused: false }, { env: "production" }).then(() => "stored", () => "refused")).toBe("refused");
      const prodOn = { ...on, environment: "production" as const };
      await svc.setControl(ops, { paused: true }, "production stays paused", prodOn);
      const dual = await approval({ paused: false }, { env: "production", approvedBy: b2.id });
      expect(await svc.applyApprovedControl(other, dual, "second approver applies the resume")).toMatchObject({ paused: false });
      // The test controls never touched production, and the reverse.
      expect((await engine.bookingControl(CODE, "test")).paused).toBe(true);
      await setControl({});
      await prisma.setting.deleteMany({ where: { key: bookingControlKeyFor(CODE, "production", "default") } });
    });

    it("an approval is bound to the controls it was asked against: a newer emergency stop or lower cap withdraws it (CR-B1-1, CR-B1-11)", async () => {
      const { OPERATION_PERMISSION, privilegedPayloadHash } = await import("../approval.service");
      const a = await createStaff(RUN, "stale-a", ["admin"]);
      const b2 = await createStaff(RUN, "stale-b", ["admin"]);
      const admin: Actor = { type: "admin", id: a.id, roles: ["admin"], permissions: new Set(["*"]) };
      const other: Actor = { type: "admin", id: b2.id, roles: ["admin"], permissions: new Set(["*"]) };
      const ops: Actor = { type: "admin", id: uuidv7(), roles: ["ops"], permissions: new Set(["suppliers.pause"]) };
      const on = { supplierCode: CODE, environment: "test" as const };
      const prodOn = { ...on, environment: "production" as const };
      await setControl({ paused: true, scope: "new_sales", maxBookingNetMinor: 300_000 });

      /** An approval asked for now, against the controls as they are now. */
      async function asked(change: Record<string, unknown>, op: "supplier.resume" | "supplier.limits.raise", environment: "test" | "production" = "test", status: "applied" | "pending" = "applied") {
        const { needs, before } = await svc.controlRequest(change as never, { ...on, environment });
        expect(needs).toBe(op);
        const permission = OPERATION_PERMISSION[op];
        const payload = engine.controlApprovalPayload(CODE, environment, "default", change as never, before);
        const at = new Date();
        const second = status === "applied" && environment === "production";
        const row = await prisma.privilegedApproval.create({
          data: {
            id: uuidv7(),
            operation: op,
            permission,
            payload: payload as never,
            payloadHash: privilegedPayloadHash(op, permission, environment, payload),
            environment,
            status,
            requestedBy: a.id,
            approvedBy: second ? b2.id : null,
            approvedAt: second ? at : null,
            requestedAt: at,
            appliedAt: status === "applied" ? at : null,
            expiresAt: new Date(at.getTime() + 30 * 60_000),
          },
        });
        return row.id;
      }
      const approvalRow = (id: string) => prisma.privilegedApproval.findUniqueOrThrow({ where: { id } });

      // A resume asked against a new-sales pause; an emergency stop follows; the late approval is withdrawn.
      const resume = await asked({ paused: false }, "supplier.resume");
      await svc.setControl(ops, { paused: true, scope: "all_writes", reason: "incident" }, "emergency stop during the incident", on);
      const refused = await svc.setControl(admin, { paused: false }, "resume asked before the stop", { ...on, approvalId: resume }).catch((e) => e);
      expect(isConflict(refused)).toBe(true);
      expect(isAppError(refused) && refused.details?.reason).toBe("control_changed");
      expect(await engine.bookingControl(CODE, "test")).toMatchObject({ paused: true, scope: "all_writes" });
      expect(await approvalRow(resume)).toMatchObject({ status: "expired", appliedAt: null });
      expect(await prisma.auditLog.count({ where: { entityId: resume, action: "privileged.withdrawn" } })).toBe(1);
      expect(isConflict(await svc.setControl(admin, { paused: false }, "try the withdrawn one again", { ...on, approvalId: resume }).catch((e) => e))).toBe(true);
      expect((await engine.bookingControl(CODE, "test")).scope).toBe("all_writes");

      // A cap raise asked at 300 000; the cap is lowered to 100 000 meanwhile; the raise never overwrites it.
      const raise = await asked({ maxBookingNetMinor: 400_000, minFundsAfterMinor: 0 }, "supplier.limits.raise");
      await svc.setControl(ops, { maxBookingNetMinor: 100_000, minFundsAfterMinor: 0 }, "lower the cap after review", on);
      expect(isConflict(await svc.setControl(admin, { maxBookingNetMinor: 400_000, minFundsAfterMinor: 0 }, "raise asked before the cut", { ...on, approvalId: raise }).catch((e) => e))).toBe(true);
      expect((await engine.bookingControl(CODE, "test")).maxBookingNetMinor).toBe(100_000);

      // Controls unchanged since the request: the approval applies.
      const fresh = await asked({ maxBookingNetMinor: 200_000, minFundsAfterMinor: 0 }, "supplier.limits.raise");
      expect(await svc.setControl(admin, { maxBookingNetMinor: 200_000, minFundsAfterMinor: 0 }, "raise against current controls", { ...on, approvalId: fresh })).toMatchObject({ maxBookingNetMinor: 200_000 });

      // Production, the second approver's check: fine while unchanged, withdrawn once the controls moved.
      await svc.setControl(ops, { paused: true }, "production stays paused", prodOn);
      const pending = await asked({ paused: false }, "supplier.resume", "production", "pending");
      expect(await svc.checkControlApproval(other, pending)).toMatchObject({ operation: "supplier.resume", environment: "production" });
      await svc.setControl(ops, { paused: true, scope: "all_writes" }, "production emergency stop drill", prodOn);
      expect(isConflict(await svc.checkControlApproval(other, pending).catch((e) => e))).toBe(true);
      expect((await approvalRow(pending)).status).toBe("expired");
      // An applied production approval asked before the stop cannot clear it either.
      await setControl({});
      const prodKey = bookingControlKeyFor(CODE, "production", "default");
      await prisma.setting.update({ where: { key: prodKey }, data: { value: { paused: true, scope: "new_sales" } } });
      const dual = await asked({ paused: false }, "supplier.resume", "production");
      await svc.setControl(ops, { paused: true, scope: "all_writes" }, "production stop after the approval", prodOn);
      expect(isConflict(await svc.applyApprovedControl(other, dual, "second approver applies late").catch((e) => e))).toBe(true);
      expect(await engine.bookingControl(CODE, "production")).toMatchObject({ paused: true, scope: "all_writes" });

      // CR-B1-11: only a supplier control approval, from someone who may also apply it.
      const instantPayload = { productId: uuidv7() };
      const instant = await prisma.privilegedApproval.create({
        data: {
          id: uuidv7(),
          operation: "instant.activate",
          permission: "products.activate_instant",
          payload: instantPayload,
          payloadHash: privilegedPayloadHash("instant.activate", "products.activate_instant", "production", instantPayload),
          environment: "production",
          status: "pending",
          requestedBy: a.id,
          requestedAt: new Date(),
          expiresAt: new Date(Date.now() + 30 * 60_000),
        },
      });
      expect(isConflict(await svc.checkControlApproval(other, instant.id).catch((e) => e))).toBe(true);
      expect((await approvalRow(instant.id)).status).toBe("pending");
      await prisma.setting.update({ where: { key: prodKey }, data: { value: { paused: true, scope: "new_sales" } } });
      const another = await asked({ paused: false }, "supplier.resume", "production", "pending");
      const resumeOnly: Actor = { type: "admin", id: b2.id, roles: ["x"], permissions: new Set(["suppliers.resume"]) };
      expect(code(await svc.checkControlApproval(resumeOnly, another).catch((e) => e))).toBe("FORBIDDEN");
      const pauseOnly: Actor = { type: "admin", id: b2.id, roles: ["x"], permissions: new Set(["suppliers.pause"]) };
      expect(code(await svc.checkControlApproval(pauseOnly, another).catch((e) => e))).toBe("FORBIDDEN");
      await prisma.setting.deleteMany({ where: { key: prodKey } });
    });

    it("an unreadable control row is an emergency stop: intents are refused and confirm is held", async () => {
      for (const bad of ["not an object", { paused: true, scope: "all_writes", maxBookingNetMinor: 0 }, { paused: true, scope: "no_such_scope" }]) {
        await setControl(bad);
        expect(isConflict(await create(intent()).catch((e) => e))).toBe(true);
        const c = await engine.bookingControl(CODE, "test");
        expect(c).toMatchObject({ paused: true, scope: "all_writes" });
        expect(engine.heldKinds(c)).toContain("confirm");
      }
      // A reservation's confirm is held while the row is invalid.
      await setControl({});
      const td = new FakeTravelDesk(now);
      const b = await create(intent());
      await svc.runDueJobs(deps(td), { budgetMs: 60_000, maxJobs: 1 });
      expect((await booking(b.id)).state).toBe("reserved");
      await setControl({ paused: true, scope: "all_writes", maxBookingNetMinor: 0 });
      await drain(td, 60_000);
      expect(td.calls).toEqual(["reserve"]);
      expect((await booking(b.id)).state).toBe("reserved");
      await setControl({ paused: false });
    });

    it("refuses a booking above the per-booking cap", async () => {
      await setControl({ maxBookingNetMinor: 20_000 });
      expect(isConflict(await create(intent()).catch((e) => e))).toBe(true);
      await setControl({});
    });

    it("refuses before sending when funds would fall below the floor (as never sent), and waits when the funds cannot be read", async () => {
      const td = new FakeTravelDesk(now);
      await setControl({ minFundsAfterMinor: 100_000 });
      td.fundsMinor = 110_000n; // 110 000 − 24 000 < 100 000
      const low = await create(intent());
      await drain(td, 0);
      expect(await booking(low.id)).toMatchObject({ state: "not_created", errorCode: "balance_floor" });
      expect(td.calls).toEqual([]);

      td.fundsMinor = null;
      const b = await create(intent());
      const r = await svc.runDueJobs(deps(td), { budgetMs: 60_000 });
      expect(r.processed.map((p) => p.outcome)).toContain("balance_unavailable");
      expect((await booking(b.id)).state).toBe("queued");
      td.fundsMinor = 10_000_000n;
      clock += 61_000;
      await drain(td, 0);
      expect((await booking(b.id)).state).toBe("confirmed");
      await setControl({});
    });
  });

  /* -------------------------------------------------------------------------
   * Wallet funds (doc 29 §4.5, defect D1)
   * ---------------------------------------------------------------------- */

  describe("wallet funds (doc 29 §4.5, D1)", () => {
    const prodKey = () => bookingControlKeyFor(CODE, "production", "777");
    afterAll(async () => {
      await prisma.setting.deleteMany({ where: { key: prodKey() } });
    });

    async function walletEvents(id: string, kind: string) {
      return (await events(id)).filter((e) => e.kind === kind).map((e) => e.detail as Record<string, unknown>);
    }

    /** A second order item on the same order, for multi-item running totals. */
    async function itemOn(orderId: string) {
      const first = await prisma.orderItem.findFirstOrThrow({ where: { orderId } });
      const item = await prisma.orderItem.create({
        data: {
          id: uuidv7(),
          orderId,
          comboId: first.comboId,
          titleSnapshot: "test-engine",
          tierSnapshot: "C",
          slugSnapshot: first.slugSnapshot,
          kindSnapshot: "combo",
          confirmationSnapshot: "manual",
          fulfilmentModeSnapshot: "inquiry",
          fulfilmentOrigin: "instant_checkout",
          freeCancellationHoursSnapshot: 24,
          durationMinutesSnapshot: 60,
          serviceDate: new Date("2026-11-10"),
          pax: { adult: 2, child: 0, infant: 0 },
          unitInr: 1000n,
          unitAed: 45n,
          totalInr: 1000n,
          totalAed: 45n,
        },
      });
      return { orderId, orderItemId: item.id };
    }

    it("a prepaid wallet with a negative balance books what was paid in, and the read is recorded", async () => {
      const td = new FakeTravelDesk(now);
      // The production shape of 22 November, scaled: balance −400.00, no credit, payable 400.00.
      td.wallet = { balanceMinor: -40_000n, creditFacilityMinor: 0n, payableBalanceMinor: 40_000n };
      const b = await create(intent());
      await drain(td, 0);
      expect((await booking(b.id)).state).toBe("confirmed");
      expect(await walletEvents(b.id, "funds_check")).toEqual([{ fundsMinor: 40_000, runningMinor: null }]);
      // Test environment: the direction guard does not run.
      expect(await walletEvents(b.id, "wallet_direction")).toEqual([]);
    });

    it("figures that do not add up are refused before sending, alert once, and wait for a later read", async () => {
      const td = new FakeTravelDesk(now);
      td.wallet = { balanceMinor: -40_000n, creditFacilityMinor: 0n, payableBalanceMinor: 30_000n };
      const b = await create(intent());
      const r = await svc.runDueJobs(deps(td), { budgetMs: 60_000 });
      expect(r.processed.map((p) => p.outcome)).toContain("funds_unverified:funds_mismatch");
      expect(td.calls).toEqual([]);
      const held = await booking(b.id);
      expect(held).toMatchObject({ state: "queued", errorCode: "funds_unverified" });
      expect(held.attentionRequiredAt).not.toBeNull();
      clock += 61_000;
      await svc.runDueJobs(deps(td), { budgetMs: 60_000 });
      expect((await walletEvents(b.id, "alert")).filter((d) => d.reason === "funds_unverified")).toEqual([{ reason: "funds_unverified", code: "funds_mismatch", jobKind: "reserve" }]);

      td.wallet = { balanceMinor: 1_000n, creditFacilityMinor: 0n, payableBalanceMinor: -1_000n };
      // After the alert the re-check backs off (review R6): the wait grows with the time since the alert.
      clock += 70_000;
      const neg = await svc.runDueJobs(deps(td), { budgetMs: 60_000 });
      expect(neg.processed.map((p) => p.outcome)).toContain("funds_unverified:funds_negative");
      expect(td.calls).toEqual([]);
      const next = await prisma.supplierJob.findFirstOrThrow({ where: { supplierBookingId: b.id, kind: "reserve", status: "queued" } });
      expect(next.runAfter.getTime() - clock).toBeGreaterThan(FUNDS_RECHECK_MIN_MS);
      expect(next.runAfter.getTime() - clock).toBeLessThanOrEqual(FUNDS_RECHECK_MAX_MS);

      td.wallet = { balanceMinor: -40_000n, creditFacilityMinor: 0n, payableBalanceMinor: 40_000n };
      clock += FUNDS_RECHECK_MAX_MS;
      await drain(td, 0);
      expect((await booking(b.id)).state).toBe("confirmed");
    });

    it("a multi-item order checks a further item against the running total, so two items cannot spend one wallet", async () => {
      const td = new FakeTravelDesk(now);
      // 400.00 in the wallet; each item costs 240.00. The fake never shows the first hold, so only the running total can stop item two.
      td.fundsMinor = 40_000n;
      const one = await orderItem();
      const two = await itemOn(one.orderId);
      const a = await create(forOrder(one));
      const b = await create(forOrder(two));
      await drain(td, 0);
      const states = [await booking(a.id), await booking(b.id)];
      expect(td.calls.filter((c) => c === "reserve")).toHaveLength(1);
      const refused = states.find((s) => s.state === "not_created");
      const held = states.find((s) => s.state !== "not_created");
      expect(refused).toMatchObject({ errorCode: "balance_floor" });
      expect(held?.reservedAt).not.toBeNull();
      expect(await walletEvents(refused!.id, "funds_check")).toEqual([{ fundsMinor: 40_000, runningMinor: 16_000 }]);
    });

    it("a read of an attempt refused at the floor never anchors the running total: after a top-up the retry books (review R2)", async () => {
      const td = new FakeTravelDesk(now);
      // 100.00 in the wallet, the item costs 240.00: refused at the floor, nothing sent.
      td.fundsMinor = 10_000n;
      const ids = await orderItem();
      const first = await create(forOrder(ids));
      await drain(td, 0);
      expect(await booking(first.id)).toMatchObject({ state: "not_created", errorCode: "balance_floor" });
      expect(await walletEvents(first.id, "funds_check")).toEqual([{ fundsMinor: 10_000, runningMinor: null }]);
      expect(td.calls).toEqual([]);
      // Topped up to 400.00: a new attempt for the same item checks the current read only.
      td.fundsMinor = 40_000n;
      const retry = await create(forOrder(ids));
      await drain(td, 0);
      const again = await booking(retry.id);
      expect(again.state).not.toBe("not_created");
      expect(again.reservedAt).not.toBeNull();
      expect(await walletEvents(retry.id, "funds_check")).toEqual([{ fundsMinor: 40_000, runningMinor: null }]);
    });

    it("a multi-item order: a dead sibling's low read does not block a further item after a top-up, a live sibling still counts (review R2)", async () => {
      const td = new FakeTravelDesk(now);
      td.fundsMinor = 10_000n;
      const one = await orderItem();
      const two = await itemOn(one.orderId);
      const three = await itemOn(one.orderId);
      const a = await create(forOrder(one));
      await drain(td, 0);
      expect(await booking(a.id)).toMatchObject({ state: "not_created", errorCode: "balance_floor" });
      // Top-up to 600.00. Item two books: the dead attempt of item one is not an anchor.
      td.fundsMinor = 60_000n;
      const b = await create(forOrder(two));
      await drain(td, 0);
      expect((await booking(b.id)).reservedAt).not.toBeNull();
      expect(await walletEvents(b.id, "funds_check")).toEqual([{ fundsMinor: 60_000, runningMinor: null }]);
      // Item three: the fake never shows item two's hold, so only the running total from item two's read (600 − 240) holds it.
      const c = await create(forOrder(three));
      await drain(td, 0);
      expect(await walletEvents(c.id, "funds_check")).toEqual([{ fundsMinor: 60_000, runningMinor: 36_000 }]);
      expect((await booking(c.id)).reservedAt).not.toBeNull();
    });

    it("the admin overview shows the pinned production row the write action changes, not the default one (D2)", async () => {
      const admin: Actor = { type: "admin", id: uuidv7(), roles: ["admin"], permissions: new Set(["suppliers.manage"]) };
      await prisma.setting.upsert({ where: { key: prodKey() }, create: { key: prodKey(), value: { paused: true, scope: "all_writes", reason: "pinned row" } }, update: { value: { paused: true, scope: "all_writes", reason: "pinned row" } } });
      const pinned = await svc.overview(admin, { supplierCode: CODE, accounts: { test: "default", production: "777" } });
      expect(pinned.controls.production).toMatchObject({ paused: true, scope: "all_writes", reason: "pinned row" });
      const none = await svc.overview(admin, { supplierCode: CODE, accounts: { test: "default", production: null } });
      expect(none.controls.production).toMatchObject({ paused: true });
      expect(none.controls.production.reason).toContain("TRAVELDESK_AGENCY_ID");
      await prisma.setting.deleteMany({ where: { key: prodKey() } });
    });

    describe("direction guard (production)", () => {
      const prepaid = { balanceMinor: -40_000n, creditFacilityMinor: 0n, payableMinor: 40_000n };
      async function guarded(after: { balanceMinor: bigint; creditFacilityMinor: bigint; payableBalanceMinor: bigint }, chargedNetMinor = 24_000n, outcome = "reserved") {
        await prisma.setting.upsert({ where: { key: prodKey() }, create: { key: prodKey(), value: { paused: false } }, update: { value: { paused: false } } });
        const td = new FakeTravelDesk(now);
        td.agencyId = 777;
        td.wallet = after;
        const row = await create(intent());
        await drain(new FakeTravelDesk(now), 0);
        const b = { ...(await booking(row.id)), environment: "production" as const, accountId: "777" };
        await svc.walletDirectionGuard(b, { spendableMinor: 40_000n, wallet: prepaid }, { chargedNetMinor }, deps(td, { environment: "production", accountId: "777" }), outcome);
        const control = (await prisma.setting.findUniqueOrThrow({ where: { key: prodKey() } })).value as Record<string, unknown>;
        return { id: row.id, control, reads: td.balanceReads, direction: await walletEvents(row.id, "wallet_direction"), alerts: await walletEvents(row.id, "alert") };
      }

      it.each(["cancelled", "expired", "unknown_status", "manual_review", "unconfirmed", "final_without_payment", "lost_race", "apply_failed"])(
        "an accepted answer kept as %s moved no money: no read, no pause, recorded not_applicable (review R1)",
        async (outcome) => {
          // The read would be flat (a pause if checked).
          const r = await guarded({ balanceMinor: -40_000n, creditFacilityMinor: 0n, payableBalanceMinor: 40_000n }, 24_000n, outcome);
          expect(r.direction).toEqual([{ verdict: "not_applicable", outcome }]);
          expect(r.reads).toBe(0);
          expect(r.control).toMatchObject({ paused: false });
          expect(r.alerts).toEqual([]);
        },
      );

      it.each(["reserved", "awaiting_payment", "confirmed", "awaiting_external"])("an accepted answer kept as %s debits the wallet and is checked", async (outcome) => {
        const r = await guarded({ balanceMinor: -16_000n, creditFacilityMinor: 0n, payableBalanceMinor: 16_000n }, 24_000n, outcome);
        expect(r.reads).toBe(1);
        expect(r.direction[0]).toMatchObject({ verdict: "consistent" });
      });

      it("funds lower by the cost, or by more (staff booking on the portal meanwhile), never pause", async () => {
        const fell = await guarded({ balanceMinor: -16_000n, creditFacilityMinor: 0n, payableBalanceMinor: 16_000n });
        expect(fell.direction).toEqual([{ verdict: "consistent", fundsMinor: 16_000, deltaMinor: -24_000, expectedMinor: 24_000 }]);
        expect(fell.control).toMatchObject({ paused: false });
        expect(fell.alerts).toEqual([]);
        const portal = await guarded({ balanceMinor: -1_000n, creditFacilityMinor: 0n, payableBalanceMinor: 1_000n });
        expect(portal.direction[0]).toMatchObject({ verdict: "consistent" });
        expect(portal.control).toMatchObject({ paused: false });
      });

      it("funds that did not move stop all writes, audited, with an alert", async () => {
        const flat = await guarded({ balanceMinor: -40_000n, creditFacilityMinor: 0n, payableBalanceMinor: 40_000n });
        expect(flat.direction[0]).toMatchObject({ verdict: "flat" });
        expect(flat.control).toMatchObject({ paused: true, scope: "all_writes", reason: "wallet_direction_auto" });
        expect(flat.alerts).toContainEqual({ reason: "wallet_direction_auto", verdict: "flat" });
        const audits = await prisma.auditLog.count({ where: { action: "supplier_bookings.pause", reason: "wallet_direction_auto" } });
        expect(audits).toBeGreaterThan(0);
      });

      it("funds that rose by the cost (a wrong sign convention) stop all writes", async () => {
        const inverted = await guarded({ balanceMinor: -64_000n, creditFacilityMinor: 0n, payableBalanceMinor: 64_000n });
        expect(inverted.direction[0]).toMatchObject({ verdict: "inverted" });
        expect(inverted.control).toMatchObject({ paused: true, scope: "all_writes", reason: "wallet_direction_auto" });
      });

      it("a rise of another size (a top-up, a portal cancellation) only alerts", async () => {
        const topUp = await guarded({ balanceMinor: -540_000n, creditFacilityMinor: 0n, payableBalanceMinor: 540_000n });
        expect(topUp.direction[0]).toMatchObject({ verdict: "rose_unexplained" });
        expect(topUp.control).toMatchObject({ paused: false });
        expect(topUp.alerts).toEqual([{ reason: "wallet_direction_unclear", verdict: "rose_unexplained" }]);
      });

      it("a booking in the test environment is never checked", async () => {
        const td = new FakeTravelDesk(now);
        const row = await create(intent());
        await svc.walletDirectionGuard(await booking(row.id), { spendableMinor: 40_000n, wallet: prepaid }, { chargedNetMinor: 24_000n }, deps(td), "reserved");
        expect(await walletEvents(row.id, "wallet_direction")).toEqual([]);
        await drain(td, 0);
      });
    });
  });

  /* -------------------------------------------------------------------------
   * Reconciliation (SUP-12)
   * ---------------------------------------------------------------------- */

  describe("reconciliation", () => {
    /** Earlier tests' rows look closed long ago, so each reconciliation sees only its own. */
    async function onlyRecent() {
      await prisma.supplierBooking.updateMany({ where: { supplierId }, data: { closedAt: new Date(Date.now() - 30 * 86_400_000), attentionRequiredAt: null } });
    }
    afterEach(async () => {
      await prisma.setting.deleteMany({ where: { key: `supplier_reconcile.${CODE}.test` } });
    });

    function reconcile(td: FakeTravelDesk) {
      return svc.reconcile({ adapter: adapterFor(td), environment: "test", supplierCode: CODE, now, readLimits: readLimits(1_000_000) });
    }

    it("reports differences, and changes nothing it has no evidence for", async () => {
      await onlyRecent();
      const td = new FakeTravelDesk(now);
      const ok = await create(intent());
      const drifted = await create(intent());
      const gone = await create(intent());
      const review = await create(intent());
      await drain(td, 0);
      const okRow = await booking(ok.id);
      td.store.set((await booking(drifted.id)).supplierBookingId!, { ...td.store.get((await booking(drifted.id)).supplierBookingId!)!, status: 4 }); // cancelled at TravelDesk, not by us
      td.store.delete((await booking(gone.id)).supplierBookingId!);
      // A row waiting for a human that TravelDesk shows confirmed (SUP-5).
      await prisma.supplierBooking.update({ where: { id: review.id }, data: { state: "manual_review", attentionRequiredAt: now() } });
      // A TravelDesk booking with our prefix but no row here, and one an agent made in the portal.
      const base = td.store.get(okRow.supplierBookingId!)!;
      td.store.set("90001", { ...base, supplierBookingId: "90001", bookingReference: `OUTTD-ORPHAN${RUN}` });
      td.store.set("90002", { ...base, supplierBookingId: "90002", bookingReference: "AGENT-123" });

      const r = await reconcile(td);
      const kinds = (k: string) => r.issues.filter((i) => i.kind === k).map((i) => i.bookingId ?? i.supplierBookingId);
      expect(kinds("status_mismatch")).toContain(drifted.id);
      expect(kinds("missing_at_supplier")).toContain(gone.id);
      expect(kinds("uncertain_state")).toContain(review.id);
      expect(kinds("unknown_to_outly")).toEqual(["90001"]);
      expect(r.issues.map((i) => i.bookingId)).not.toContain(ok.id);
      expect(r).toMatchObject({ listComplete: true, truncated: false, skipped: null, reblocked: 0, skippedClosed: 0 });
      expect(r.otherBookings).toBeGreaterThanOrEqual(1);
      expect((await booking(drifted.id)).state).toBe("confirmed"); // report only
      const stored = await prisma.setting.findUniqueOrThrow({ where: { key: `supplier_reconcile.${CODE}.test` } });
      expect((stored.value as { ranAt: string }).ranAt).toBe(now().toISOString());
    });

    it("a booking closed as never created that TravelDesk shows live is re-blocked at once, with an alert (late acceptance)", async () => {
      await onlyRecent();
      const td = new FakeTravelDesk(now);
      td.steps.reserve.push(new TravelDeskApiError("refused", "bookings.reserve"));
      const ids = await orderItem();
      const b = await create(forOrder(ids));
      await drain(td, 0);
      expect((await booking(b.id)).state).toBe("not_created");
      // TravelDesk created it after all.
      td.plant({ ...(b.requestPayload as Record<string, unknown>), guestName: b.guestName }, 7);
      const r = await reconcile(td);
      expect(r.issues.filter((i) => i.kind === "found_by_reference").map((i) => i.bookingId)).toEqual([b.id]);
      expect(r.reblocked).toBe(1);
      const reblocked = await booking(b.id);
      expect(reblocked).toMatchObject({ state: "outcome_unknown", errorCode: "late_acceptance", closedAt: null });
      expect(reblocked.attentionRequiredAt).not.toBeNull();
      expect((await events(b.id)).some((e) => e.kind === "alert" && (e.detail as { reason?: string }).reason === "late_acceptance")).toBe(true);
      expect(isConflict(await secondAttempt(ids))).toBe(true);
      // Recovery takes it from there; still no payment, so no confirm. A human still has to clear it (CR-B1-10).
      await drain(td, 0);
      expect((await booking(b.id)).state).toBe("awaiting_payment");
      expect((await booking(b.id)).attentionRequiredAt).not.toBeNull();
      expect(td.calls).not.toContain("confirm");
    });

    it("a late acceptance after a new attempt went live raises a liability alert and leaves both rows as they are (SUP-20)", async () => {
      await onlyRecent();
      const td = new FakeTravelDesk(now);
      td.steps.reserve.push(new TravelDeskApiError("refused", "bookings.reserve"));
      const ids = await orderItem();
      const first = await create(forOrder(ids));
      await drain(td, 0);
      const second = await create(forOrder(ids));
      await drain(td, 0);
      expect((await booking(second.id)).state).toBe("awaiting_payment");
      td.plant({ ...(first.requestPayload as Record<string, unknown>), guestName: first.guestName }, 7);
      const r = await reconcile(td);
      expect(r.reblocked).toBe(0);
      expect(await booking(first.id)).toMatchObject({ state: "not_created", errorCode: "late_acceptance_duplicate" });
      expect((await booking(first.id)).attentionRequiredAt).not.toBeNull();
      expect((await booking(second.id)).state).toBe("awaiting_payment");
      expect((await events(first.id)).some((e) => e.kind === "alert" && (e.detail as { reason?: string }).reason === "late_acceptance_duplicate")).toBe(true);
      // R-B5-16 (lead decision): a duplicate left not_created is never settled; the supplier may hold a real booking.
      expect(await svc.lateAcceptanceSettled(first.id)).toBe(false);
      const flag = (await booking(first.id)).attentionRequiredAt!;
      const opts = { orderId: ids.orderId, expectedAttentionAt: flag, actorId: null, reasonCode: "late_acceptance_resolved", approvalId: uuidv7(), lateAcceptanceResolved: true };
      expect(await prisma.$transaction((tx) => svc.clearAttention(tx, first.id, opts))).toBe("late_accepted");
      expect((await booking(first.id)).attentionRequiredAt).toEqual(flag);
    });

    it("an expired customer booking TravelDesk later shows confirmed is re-blocked, so no second attempt goes live (CR-B1-2)", async () => {
      await onlyRecent();
      const td = new FakeTravelDesk(now);
      const ids = await orderItem();
      const b = await create(forOrder(ids));
      await drain(td, 0);
      expect((await booking(b.id)).state).toBe("awaiting_payment");
      await drain(td, 20 * 60_000, 60_000);
      expect((await booking(b.id)).state).toBe("expired");
      // TravelDesk completed a confirm late (Q-B7).
      const sid = (await booking(b.id)).supplierBookingId!;
      td.store.set(sid, { ...td.store.get(sid)!, status: 1, reservationDeadline: null });
      const r = await reconcile(td);
      expect(r.issues.filter((i) => i.kind === "found_by_reference").map((i) => i.bookingId)).toEqual([b.id]);
      expect(r.issues.filter((i) => i.kind === "status_mismatch").map((i) => i.bookingId)).not.toContain(b.id);
      expect(r.reblocked).toBe(1);
      const reblocked = await booking(b.id);
      expect(reblocked).toMatchObject({ state: "outcome_unknown", errorCode: "late_acceptance", closedAt: null });
      expect(reblocked.attentionRequiredAt).not.toBeNull();
      expect((await events(b.id)).some((e) => e.kind === "alert" && (e.detail as { reason?: string }).reason === "late_acceptance")).toBe(true);
      expect(isConflict(await secondAttempt(ids))).toBe(true);
    });

    it("a cancelled booking TravelDesk later shows live is re-blocked and stays with a human after recovery (CR-B1-2, CR-B1-10)", async () => {
      await onlyRecent();
      const td = new FakeTravelDesk(now);
      const b = await create(intent({ afterReserve: "cancel" }));
      await drain(td, 0);
      expect((await booking(b.id)).state).toBe("cancelled");
      const sid = (await booking(b.id)).supplierBookingId!;
      td.store.set(sid, { ...td.store.get(sid)!, status: 1, reservationDeadline: null });
      const r = await reconcile(td);
      expect(r.reblocked).toBe(1);
      expect((await booking(b.id)).state).toBe("outcome_unknown");
      await drain(td, 0);
      const after = await booking(b.id);
      expect(after.state).toBe("confirmed");
      expect(after.attentionRequiredAt).not.toBeNull();
      expect(td.calls.filter((c) => c === "cancel")).toHaveLength(1);
    });

    it("R-B5-16: a settled late acceptance cleared with late_acceptance_resolved is no longer held by applySupplierState", async () => {
      await onlyRecent();
      const td = new FakeTravelDesk(now);
      const b = await create(intent({ afterReserve: "cancel" }));
      await drain(td, 0);
      const sid = (await booking(b.id)).supplierBookingId!;
      td.store.set(sid, { ...td.store.get(sid)!, status: 1, reservationDeadline: null });
      expect((await reconcile(td)).reblocked).toBe(1);
      await drain(td, 0);
      const held = await booking(b.id);
      // Recovery found it live after our cancel and flagged it with its own code; the flag is the CR-B1-10 hold.
      expect(held).toMatchObject({ state: "confirmed", errorCode: "cancel_unknown_not_cancelled" });
      expect(held.attentionRequiredAt).not.toBeNull();
      expect(await svc.lateAcceptanceSettled(b.id)).toBe(true);

      const engineDeps = { ...deps(td), now, holder: `zz-r16-${RUN}`, mutationTimeoutMs: 1_000 };
      const ref = { supplierBookingId: sid, serviceDate: held.serviceDate.toISOString().slice(0, 10), offerExternalId: held.offerExternalId };
      const read = async () => {
        const r = await adapterFor(td).readStatus(ref);
        if (r.kind !== "found") throw new Error(`read ${r.kind}`);
        return r.snapshot;
      };
      // Before the clear, a clean answer keeps the CR-B1-10 hold.
      expect(await svc.applySupplierState(held, await read(), engineDeps, "poll")).toBe("confirmed");
      const still = await booking(b.id);
      expect(still).toMatchObject({ errorCode: "cancel_unknown_not_cancelled" });
      expect(still.attentionRequiredAt).toEqual(held.attentionRequiredAt);

      // A human clears it with the dedicated reason (a drill has no order: the engine's clear then matches order_id IS NULL).
      const clearOpts = { orderId: null as unknown as string, expectedAttentionAt: still.attentionRequiredAt!, actorId: null, reasonCode: "late_acceptance_resolved", approvalId: uuidv7() };
      // Without the dedicated reason it stays held.
      expect(await prisma.$transaction((tx) => svc.clearAttention(tx, b.id, clearOpts))).toBe("late_accepted");
      expect(await prisma.$transaction((tx) => svc.clearAttention(tx, b.id, { ...clearOpts, lateAcceptanceResolved: true }))).toBe("cleared");
      expect((await booking(b.id)).attentionRequiredAt).toBeNull();

      // The next clean answer no longer holds it: no flag comes back and the hold's error code is cleared; it queues nothing.
      const queued = () => prisma.supplierJob.findMany({ where: { supplierBookingId: b.id, status: "queued" }, select: { id: true }, orderBy: { id: "asc" } });
      const jobsBefore = await queued();
      expect(await svc.applySupplierState(await booking(b.id), await read(), engineDeps, "poll")).toBe("confirmed");
      const after = await booking(b.id);
      expect(after).toMatchObject({ state: "confirmed", errorCode: null, attentionRequiredAt: null });
      expect(await queued()).toEqual(jobsBefore);
    });

    it("R-B5-16: a late-accepted booking is settled once a supplier read shows it cancelled, not before", async () => {
      await onlyRecent();
      const td = new FakeTravelDesk(now);
      const b = await create(intent({ afterReserve: "cancel" }));
      await drain(td, 0);
      expect((await booking(b.id)).state).toBe("cancelled");
      const sid = (await booking(b.id)).supplierBookingId!;
      // Our own cancel happened before the late acceptance: it is not evidence afterwards.
      td.store.set(sid, { ...td.store.get(sid)!, status: 1, reservationDeadline: null });
      expect((await reconcile(td)).reblocked).toBe(1);
      expect((await booking(b.id)).state).toBe("outcome_unknown");
      expect(await svc.lateAcceptanceSettled(b.id)).toBe(false);
      // The operator cancels it after all; recovery reads that.
      td.store.set(sid, { ...td.store.get(sid)!, status: 4 });
      await drain(td, 0);
      const ended = await booking(b.id);
      expect(ended.state).toBe("cancelled");
      expect(ended.attentionRequiredAt).not.toBeNull();
      expect(await svc.lateAcceptanceSettled(b.id)).toBe(true);
      const event = (await events(b.id)).filter((e) => e.kind === "state_change" && e.toState === "cancelled").at(-1);
      expect(event).toMatchObject({ fromState: "outcome_unknown", detail: { supplierStatus: "CANCELLED" } });
    });

    it("a drill closed as never created and re-blocked is not confirmed automatically once found (CR-B1-10)", async () => {
      await onlyRecent();
      const td = new FakeTravelDesk(now);
      td.steps.reserve.push(new TravelDeskApiError("refused", "bookings.reserve"));
      const b = await create(intent());
      await drain(td, 0);
      expect((await booking(b.id)).state).toBe("not_created");
      td.plant({ ...(b.requestPayload as Record<string, unknown>), guestName: b.guestName }, 7);
      expect((await reconcile(td)).reblocked).toBe(1);
      await drain(td, 0);
      const found = await booking(b.id);
      expect(found).toMatchObject({ state: "reserved", errorCode: "late_acceptance" });
      expect(found.attentionRequiredAt).not.toBeNull();
      expect(td.calls).not.toContain("confirm");
      expect(await prisma.supplierJob.count({ where: { supplierBookingId: b.id, kind: "confirm", status: "queued" } })).toBe(0);
    });

    it("rows closed before the window are still checked for late acceptance; the rest are counted, not dropped (CR-B1-2)", async () => {
      await onlyRecent();
      const td = new FakeTravelDesk(now);
      td.steps.reserve.push(new TravelDeskApiError("refused", "bookings.reserve"));
      const ids = await orderItem();
      const lost = await create(forOrder(ids));
      await drain(td, 0);
      expect((await booking(lost.id)).state).toBe("not_created");
      const done = await create(intent());
      // An open row keeps the window on these service dates.
      const anchor = await create(intent({ afterReserve: "hold" }));
      await drain(td, 0);
      expect((await booking(done.id)).state).toBe("confirmed");
      expect((await booking(anchor.id)).state).toBe("reserved");
      // Both closed 15 days ago, outside the 14-day window; TravelDesk then shows the never-created one on hold.
      await prisma.supplierBooking.updateMany({ where: { id: { in: [lost.id, done.id] } }, data: { closedAt: new Date(Date.now() - 15 * 86_400_000) } });
      td.plant({ ...(lost.requestPayload as Record<string, unknown>), guestName: lost.guestName }, 7);
      const r = await reconcile(td);
      expect(r.issues.filter((i) => i.kind === "found_by_reference").map((i) => i.bookingId)).toEqual([lost.id]);
      expect(r.issues.filter((i) => i.kind === "unknown_to_outly")).toEqual([]);
      expect(r.reblocked).toBe(1);
      expect(r.skippedClosed).toBe(1);
      expect(await booking(lost.id)).toMatchObject({ state: "outcome_unknown", errorCode: "late_acceptance" });
      expect(isConflict(await secondAttempt(ids))).toBe(true);
      // A wider window compares the old confirmed row in full instead.
      const wide = await svc.reconcile({ adapter: adapterFor(td), environment: "test", supplierCode: CODE, now, readLimits: readLimits(1_000_000) }, { recentClosedMs: 30 * 86_400_000 });
      expect(wide.skippedClosed).toBe(0);
    });

    it("says when it cut the issue list, and never runs while a mutation lease is held", async () => {
      await onlyRecent();
      const td = new FakeTravelDesk(now);
      const b = await create(intent({ afterReserve: "hold" }));
      await drain(td, 0);
      const base = td.store.get((await booking(b.id)).supplierBookingId!)!;
      for (let i = 0; i < 105; i++) td.store.set(String(80_000 + i), { ...base, supplierBookingId: String(80_000 + i), bookingReference: `OUTTD-ORPHAN${RUN}${i}` });
      const r = await reconcile(td);
      expect(r.issues).toHaveLength(100);
      expect(r.issuesTotal).toBeGreaterThanOrEqual(105);
      expect(r.truncated).toBe(true);

      await holdLease("busy-worker", 60);
      td.calls = [];
      const skipped = await reconcile(td);
      expect(skipped.skipped).toBe("mutation_in_flight");
      expect(td.calls).toEqual([]);
    });
  });

  /* -------------------------------------------------------------------------
   * B3: supplier wallet book, saga notifier, saga API, scheduled paid confirms
   * ---------------------------------------------------------------------- */

  describe("B3 engine seams for the payment saga", () => {
    function port(paid: Set<string>): PaymentEvidencePort {
      return {
        async capturedFor(orderItemId) {
          if (!paid.has(orderItemId)) return null;
          return { orderItemId, paymentId: uuidv7(), provider: "test", providerPaymentId: "pay_test", currency: "AED", capturedMinor: 30_000n, verifiedAt: now() };
        },
      };
    }

    function walletOf(bookingId: string) {
      return prisma.ledgerEntry.findMany({ where: { book: "supplier_wallet", supplierBookingId: bookingId }, orderBy: [{ createdAt: "asc" }, { id: "asc" }] });
    }

    // Saga and payment rows written below; removed in afterAll so no saga tick of another suite ever sees them.
    const sagaRows: string[] = [];
    const paymentRows: string[] = [];
    afterAll(async () => {
      await prisma.paymentSaga.deleteMany({ where: { id: { in: sagaRows } } });
      await prisma.payment.deleteMany({ where: { id: { in: paymentRows } } });
    });

    /**
     * A provider-verified payment bound to the item by its payment saga. The
     * default is a capture-first INR payment of the whole order (1000 paise, as
     * `orderItem()` writes it), which is confirm evidence in a saga state that
     * still intends to confirm. Synthetic provider names and amounts.
     */
    async function paidSaga(ids: { orderId: string; orderItemId: string }, opts: { state: string; attention?: boolean; payment?: Record<string, unknown> }) {
      const paymentId = uuidv7();
      await prisma.payment.create({
        data: {
          id: paymentId,
          orderId: ids.orderId,
          gateway: "fake-inr-pacb",
          gatewayPaymentId: `fp_${paymentId}`,
          source: "gateway_verified",
          provider: "fake-inr-pacb",
          providerAccountId: "fake-account-1",
          environment: "test",
          rail: "inr_pacb",
          status: "captured",
          currency: "INR",
          amountMinor: 1000n,
          capturedMinor: 1000n,
          capturedAt: now(),
          threeDs: "not_applicable",
          risk: "normal",
          ...opts.payment,
        } as never,
      });
      paymentRows.push(paymentId);
      const sagaId = uuidv7();
      await prisma.paymentSaga.create({
        data: { id: sagaId, orderId: ids.orderId, orderItemId: ids.orderItemId, paymentId, rail: "inr_pacb", state: opts.state, attentionRequiredAt: opts.attention ? now() : null },
      });
      sagaRows.push(sagaId);
      return { sagaId, paymentId };
    }

    async function dbNow() {
      const [row] = await prisma.$queryRaw<{ t: Date }[]>`SELECT now() AS t`;
      return row.t;
    }

    function confirmsSentFor(bookingId: string) {
      return prisma.supplierBookingEvent.count({ where: { supplierBookingId: bookingId, kind: "request_sent", operation: "bookings.confirm" } });
    }

    it("the supplier wallet book records the charge at reserve and the refund on a verified cancel, from supplier figures only (PAY-10)", async () => {
      const td = new FakeTravelDesk(now);
      const b = await create(intent());
      await drain(td, 0);
      expect((await booking(b.id)).state).toBe("confirmed");
      // Reserve debits (planned conservatively, doc 22 §28.1); the confirm repeats the same figure, so nothing more is written.
      expect((await walletOf(b.id)).map((e) => [e.kind, e.amountMinor])).toEqual([["charged", -24_000n]]);
      const [charge] = await walletOf(b.id);
      expect(charge).toMatchObject({ currency: "AED", orderId: null, paymentId: null });
      expect(charge.evidenceRef).toMatch(new RegExp(`^${CODE}\\.test\\.default:booking:\\d+:status:7$`));

      await svc.requestCancel(b.id, { now });
      await drain(td, 0);
      expect((await booking(b.id)).state).toBe("cancelled");
      expect((await walletOf(b.id)).map((e) => [e.kind, e.amountMinor])).toEqual([
        ["charged", -24_000n],
        ["refunded", 24_000n],
      ]);
    });

    it("a supplier charge that differs is recorded as an adjustment; an expiry without a refund figure writes no refund", async () => {
      const td = new FakeTravelDesk(now);
      td.chargeOverride = 24_100n;
      const b = await create(intent({ afterReserve: "hold" }));
      await drain(td, 0);
      // The book follows the supplier's figure, not the expected net; the amount check holds the booking for a human.
      expect((await walletOf(b.id)).map((e) => [e.kind, e.amountMinor])).toEqual([["charged", -24_100n]]);
      await drain(td, 20 * 60_000, 60_000);
      expect((await booking(b.id)).state).toBe("expired");
      expect((await walletOf(b.id)).map((e) => e.kind)).toEqual(["charged"]);
    });

    it("the saga notifier hears every committed state change of an order-item attempt, and a failing one changes nothing", async () => {
      const td = new FakeTravelDesk(now);
      const seen: [string, string][] = [];
      const saga = { bookingChanged: async (orderItemId: string, state: string) => void seen.push([orderItemId, state]) };
      const ids = await orderItem();
      const b = await create(forOrder(ids));
      await drain(td, 0, 31_000, { saga });
      expect((await booking(b.id)).state).toBe("awaiting_payment");
      expect(seen).toEqual([
        [ids.orderItemId, "reserving"],
        [ids.orderItemId, "awaiting_payment"],
      ]);

      // Drills have no order item: nobody is told.
      seen.length = 0;
      await create(intent({ afterReserve: "hold" }));
      await drain(new FakeTravelDesk(now), 0, 31_000, { saga });
      expect(seen).toEqual([]);

      const failing = { bookingChanged: async () => Promise.reject(new Error("saga down")) };
      const ids2 = await orderItem();
      const c = await create(forOrder(ids2));
      await drain(new FakeTravelDesk(now), 0, 31_000, { saga: failing });
      expect((await booking(c.id)).state).toBe("awaiting_payment");
    });

    it("confirmIfPaid refuses once the deadline gate would; releaseHold cancels an unused hold and no confirm follows it", async () => {
      const td = new FakeTravelDesk(now);
      const paid = new Set<string>();
      const payments = port(paid);
      const ids = await orderItem();
      const b = await create(forOrder(ids));
      await drain(td, 0, 31_000, { payments });
      const held = await booking(b.id);
      paid.add(ids.orderItemId);
      const saved = clock;
      clock = held.reservationDeadline!.getTime() - 60_000;
      expect(await svc.confirmIfPaid(b.id, { payments, now, mutationTimeoutMs: 1_000 })).toBe("deadline_too_close");
      clock = saved;

      // Paid and queued, then released before the worker ran: the release wins and no confirm is ever sent.
      expect(await svc.confirmIfPaid(b.id, { payments, now, mutationTimeoutMs: 1_000 })).toBe("confirm_queued");
      expect(await svc.releaseHold(b.id, "payment_refunded", { now })).toBe("queued");
      expect(await svc.confirmIfPaid(b.id, { payments, now, mutationTimeoutMs: 1_000 })).toBe("released");
      await drain(td, 0, 31_000, { payments });
      expect((await booking(b.id)).state).toBe("cancelled");
      expect(td.calls).toContain("cancel");
      expect(td.calls).not.toContain("confirm");
      expect(await prisma.supplierBookingEvent.count({ where: { supplierBookingId: b.id, kind: "release_requested" } })).toBe(1);
      expect(await svc.releaseHold(b.id, "payment_refunded", { now })).toBe("not_applicable");
      // The guard is released only by the verified cancel: a new attempt is possible now.
      expect(isConflict(await secondAttempt(ids))).toBe(false);
    });

    it("review 86 B5-01: a released hold the supplier refuses to cancel lapses at its deadline; the expiry read releases it, with no person and no second cancel", async () => {
      const refusals = [
        new TravelDeskApiError("bad_request", "bookings.cancel", { status: 400, reason: "Cancellation is not allowed" }), // a policy answer
        new TravelDeskApiError("bad_request", "bookings.cancel", { status: 400, reason: "Not found" }), // any other refusal
      ];
      for (const refusal of refusals) {
        const td = new FakeTravelDesk(now);
        const seen: string[] = [];
        const saga = { bookingChanged: async (_orderItemId: string, state: string) => void seen.push(state) };
        const ids = await orderItem();
        const b = await create(forOrder(ids));
        await drain(td, 0, 31_000, { saga });
        expect((await booking(b.id)).state).toBe("awaiting_payment");

        td.steps.cancel.push(refusal);
        expect(await svc.releaseHold(b.id, "checkout_abandoned", { now, saga })).toBe("queued");
        await drain(td, 0, 31_000, { saga });
        // Not cancel_refused and no attention: the hold is back in its state, waiting to lapse (release_requested blocks any confirm).
        const held = await booking(b.id);
        expect(held).toMatchObject({ state: "awaiting_payment", errorCode: "release_cancel_refused_hold_lapses", attentionRequiredAt: null });
        expect(seen).not.toContain("cancel_refused");
        expect(td.calls.filter((c) => c === "cancel")).toHaveLength(1);

        // The saga asking again queues a cancel, which sends nothing more.
        expect(await svc.releaseHold(b.id, "checkout_abandoned", { now, saga })).toBe("queued");
        await drain(td, 0, 31_000, { saga });
        expect(td.calls.filter((c) => c === "cancel")).toHaveLength(1);

        // After the deadline (sent + reservationTimeout, UTC) the watchdog reads status 8: expired, and the saga is told.
        await drain(td, 20 * 60_000, 60_000, { saga });
        expect(await booking(b.id)).toMatchObject({ state: "expired", attentionRequiredAt: null });
        expect(seen).toContain("expired");
        expect(td.calls).not.toContain("confirm");
        // The guard is released by the expiry read: a new attempt is possible.
        expect(isConflict(await secondAttempt(ids))).toBe(false);
      }
    });

    it("releaseHold closes a never-sent attempt at once and is refused after a confirm was sent", async () => {
      const seen: string[] = [];
      const saga = { bookingChanged: async (_i: string, state: string) => void seen.push(state) };
      const ids = await orderItem();
      const queued = await create(forOrder(ids));
      expect(await svc.releaseHold(queued.id, "checkout_abandoned", { now, saga })).toBe("queued");
      expect(await booking(queued.id)).toMatchObject({ state: "not_created", errorCode: "released_before_send" });
      expect(seen).toEqual(["not_created"]);
      const td = new FakeTravelDesk(now);
      await drain(td, 0);
      expect(td.calls).toEqual([]);

      const paid = new Set<string>();
      const ids2 = await orderItem();
      paid.add(ids2.orderItemId);
      const c = await create(forOrder(ids2));
      await drain(td, 0, 31_000, { payments: port(paid) });
      expect((await booking(c.id)).state).toBe("confirmed");
      expect(await svc.releaseHold(c.id, "too_late", { now })).toBe("not_applicable");
      expect(await prisma.supplierBookingEvent.count({ where: { supplierBookingId: c.id, kind: "release_requested" } })).toBe(0);
    });

    it("the scheduled run (paid_only) sends only the paid confirms of order-item attempts, never a drill's (B3, SEC-8)", async () => {
      const td = new FakeTravelDesk(now);
      const paid = new Set<string>();
      const payments = port(paid);
      // A customer hold, not paid yet.
      const ids = await orderItem();
      const c = await create(forOrder(ids));
      await svc.runDueJobs(deps(td, { payments }), { budgetMs: 60_000, maxJobs: 1 });
      expect((await booking(c.id)).state).toBe("awaiting_payment");
      // A drill reserved with its confirm queued, and a new intent waiting to reserve.
      const drill = await create(intent());
      await svc.runDueJobs(deps(td), { budgetMs: 60_000, maxJobs: 1 });
      expect((await booking(drill.id)).state).toBe("reserved");
      expect(await prisma.supplierJob.findUnique({ where: { dedupeKey: `confirm:${drill.id}` } })).toMatchObject({ status: "queued" });
      const fresh = await create(intent({ afterReserve: "hold" }));
      // Now the customer pays: its confirm is queued.
      paid.add(ids.orderItemId);
      expect(await svc.confirmIfPaid(c.id, { payments, now, mutationTimeoutMs: 1_000 })).toBe("confirm_queued");

      td.calls = [];
      const r = await svc.runDueJobs(deps(td, { payments, mutations: "paid_only" }), { budgetMs: 60_000 });
      expect(r.processed.filter((p) => p.kind === "confirm").map((p) => p.outcome)).toEqual(["confirmed"]);
      expect(r.processed.some((p) => p.kind === "reserve" || p.kind === "create" || p.kind === "cancel")).toBe(false);
      expect(td.calls.filter((x) => x !== "list" && x !== "getReservation")).toEqual(["confirm"]);
      expect((await booking(c.id)).state).toBe("confirmed");
      expect((await booking(drill.id)).state).toBe("reserved");
      expect((await booking(fresh.id)).state).toBe("queued");
    });

    it("confirmSendBy is the send gate's own rule: the reservation deadline less the confirm budget, on the database clock (CR-B3 P2)", async () => {
      const { createEngineSagaApi } = await import("../engine-saga.service");
      const api = createEngineSagaApi({ config: () => ({ environment: "test", agencyId: null, mutationTimeoutMs: 1_000 }), payments: port(new Set()), supplierCode: CODE, now });
      const td = new FakeTravelDesk(now);
      const ids = await orderItem();
      const b = await create(forOrder(ids));
      // Not reserved yet: no deadline, so no confirm may be sent.
      expect(await api.confirmSendBy(b.id)).toBeNull();
      await drain(td, 0);
      const held = await booking(b.id);
      expect(held.state).toBe("awaiting_payment");
      const sent = (await events(b.id)).find((e) => e.kind === "request_sent" && e.operation === "bookings.reserve")!;
      const skew = (sent.detail as { dbSkewMs: number }).dbSkewMs;
      // The test clock runs years ahead: the instant is moved onto the database clock by the reserving worker's skew.
      const at = await api.confirmSendBy(b.id);
      expect(Date.parse(at!)).toBe(held.reservationDeadline!.getTime() - 5 * 60_000 - skew);
      expect(Math.abs(Date.parse(at!) - (await dbNow()).getTime())).toBeLessThan(15 * 60_000);
      // A longer mutation timeout widens the budget to the timeout plus a minute.
      expect((await svc.confirmSendByFor(b.id, { mutationTimeoutMs: 600_000 }))!.getTime()).toBe(held.reservationDeadline!.getTime() - 660_000 - skew);

      // A 4-minute hold and a worker two minutes slow: its own clock says there is time, the shared rule does not.
      const td2 = new FakeTravelDesk(now);
      td2.deadlineMs = 4 * 60_000;
      const paid = new Set<string>();
      const ids2 = await orderItem();
      const c = await create(forOrder(ids2));
      await drain(td2, 0);
      paid.add(ids2.orderItemId);
      const slow = () => new Date(clock - 120_000);
      expect(Date.parse((await api.confirmSendBy(c.id))!)).toBeLessThan((await dbNow()).getTime());
      expect(await svc.confirmIfPaid(c.id, { payments: port(paid), now: slow, mutationTimeoutMs: 1_000 })).toBe("deadline_too_close");
      expect(await prisma.supplierJob.count({ where: { dedupeKey: `confirm:${c.id}` } })).toBe(0);
    });

    it("a release recorded after the confirm job's own checks still stops the send: the booking lock decides (CR-B3-1, release first)", async () => {
      const td = new FakeTravelDesk(now);
      const paid = new Set<string>();
      const payments = port(paid);
      const ids = await orderItem();
      const b = await create(forOrder(ids));
      await drain(td, 0, 31_000, { payments });
      paid.add(ids.orderItemId);
      expect(await svc.confirmIfPaid(b.id, { payments, now, mutationTimeoutMs: 1_000 })).toBe("confirm_queued");
      // The account read runs after the job's release, deadline and evidence checks, just before the send transaction.
      let released: string | null = null;
      td.onBalance = async () => {
        td.onBalance = null;
        released = await svc.releaseHold(b.id, "confirm_too_late", { now });
      };
      const r = await svc.runDueJobs(deps(td, { payments }), { budgetMs: 60_000, maxJobs: 1 });
      expect(released).toBe("queued");
      expect(r.processed.map((p) => `${p.kind}:${p.outcome}`)).toEqual(["confirm:released"]);
      expect(td.calls).not.toContain("confirm");
      expect(await confirmsSentFor(b.id)).toBe(0);
      // Once released, no confirm can be queued again either.
      expect(await svc.confirmIfPaid(b.id, { payments, now, mutationTimeoutMs: 1_000 })).toBe("released");
      await drain(td, 0, 31_000, { payments });
      expect((await booking(b.id)).state).toBe("cancelled");
      expect(td.calls).not.toContain("confirm");
    });

    it("a release asked for while the confirm's send transaction runs waits for it and is refused (CR-B3-1, confirm first)", async () => {
      const td = new FakeTravelDesk(now);
      const paid = new Set<string>();
      const payments = port(paid);
      const ids = await orderItem();
      const b = await create(forOrder(ids));
      await drain(td, 0, 31_000, { payments });
      paid.add(ids.orderItemId);
      expect(await svc.confirmIfPaid(b.id, { payments, now, mutationTimeoutMs: 1_000 })).toBe("confirm_queued");
      // The evidence read on the send transaction pauses there, holding the booking row lock.
      let resume!: () => void;
      const gate = new Promise<void>((r) => (resume = r));
      let entered!: () => void;
      const inside = new Promise<void>((r) => (entered = r));
      const paymentsInTx = () => ({
        async capturedFor(orderItemId: string) {
          entered();
          await gate;
          return payments.capturedFor(orderItemId);
        },
      });
      const run = svc.runDueJobs(deps(td, { payments, paymentsInTx }), { budgetMs: 60_000, maxJobs: 1 });
      await inside;
      let settled = false;
      const release = svc.releaseHold(b.id, "confirm_too_late", { now }).then((x) => {
        settled = true;
        return x;
      });
      await new Promise((r) => setTimeout(r, 300));
      expect(settled).toBe(false);
      resume();
      const r = await run;
      expect(await release).toBe("not_applicable");
      expect(r.processed.map((p) => `${p.kind}:${p.outcome}`)).toEqual(["confirm:confirmed"]);
      expect((await booking(b.id)).state).toBe("confirmed");
      expect(await confirmsSentFor(b.id)).toBe(1);
      expect(await prisma.supplierBookingEvent.count({ where: { supplierBookingId: b.id, kind: "release_requested" } })).toBe(0);
    });

    it("the evidence is re-read on the send transaction under the saga's rows: a saga move first stops the send, one after waits for it (CR-B3-1)", async () => {
      const { dbPaymentEvidence, paymentEvidenceFrom } = await import("../../payments/evidence");
      const real = { payments: dbPaymentEvidence, paymentsInTx: paymentEvidenceFrom };

      // The saga leaves the evidence state after the job's own evidence read, before the send transaction: nothing is sent.
      const td = new FakeTravelDesk(now);
      const ids = await orderItem();
      const { sagaId } = await paidSaga(ids, { state: "authorized" });
      const b = await create(forOrder(ids));
      await drain(td, 0, 31_000, real);
      expect((await booking(b.id)).state).toBe("awaiting_payment");
      await prisma.paymentSaga.update({ where: { id: sagaId }, data: { state: "confirm_pending" } });
      expect(await svc.confirmIfPaid(b.id, { ...real, now, mutationTimeoutMs: 1_000 })).toBe("confirm_queued");
      td.onBalance = async () => {
        td.onBalance = null;
        await prisma.paymentSaga.update({ where: { id: sagaId }, data: { state: "refund_pending" } });
      };
      const r = await svc.runDueJobs(deps(td, real), { budgetMs: 60_000, maxJobs: 1 });
      expect(r.processed.map((p) => `${p.kind}:${p.outcome}`)).toEqual(["confirm:awaiting_payment"]);
      expect(td.calls).not.toContain("confirm");
      expect(await confirmsSentFor(b.id)).toBe(0);
      expect(await svc.releaseHold(b.id, "payment_refunded", { now })).toBe("queued");
      await drain(td, 0, 31_000, real);
      expect((await booking(b.id)).state).toBe("cancelled");

      // The send transaction holds the saga row: a saga move begun meanwhile commits only after the send is recorded,
      // and the release it asks for next is refused.
      const td2 = new FakeTravelDesk(now);
      const ids2 = await orderItem();
      const second = await paidSaga(ids2, { state: "authorized" });
      const c = await create(forOrder(ids2));
      await drain(td2, 0, 31_000, real);
      // The liability is on record from the reserve (PAY-10): the supplier's charge and the supplier's booking id.
      const held = await booking(c.id);
      expect(held.supplierBookingId).toMatch(/\S/);
      const walletAtReserve = (await walletOf(c.id)).map((e) => [e.kind, e.amountMinor]);
      expect(walletAtReserve).toHaveLength(1);
      expect(walletAtReserve[0][0]).toBe("charged");
      expect(walletAtReserve[0][1] as bigint).toBeLessThan(0n);
      await prisma.paymentSaga.update({ where: { id: second.sagaId }, data: { state: "confirm_pending" } });
      expect(await svc.confirmIfPaid(c.id, { ...real, now, mutationTimeoutMs: 1_000 })).toBe("confirm_queued");
      let resume!: () => void;
      const gate = new Promise<void>((x) => (resume = x));
      let entered!: () => void;
      const inside = new Promise<void>((x) => (entered = x));
      const paused = (tx: Parameters<typeof paymentEvidenceFrom>[0]) => ({
        async capturedFor(orderItemId: string) {
          const ev = await paymentEvidenceFrom(tx).capturedFor(orderItemId);
          entered();
          await gate;
          return ev;
        },
      });
      const run = svc.runDueJobs(deps(td2, { payments: dbPaymentEvidence, paymentsInTx: paused }), { budgetMs: 60_000, maxJobs: 1 });
      await inside;
      let moved = false;
      const move = prisma.paymentSaga.update({ where: { id: second.sagaId }, data: { state: "refund_pending" } }).then(() => (moved = true));
      await new Promise((x) => setTimeout(x, 300));
      expect(moved).toBe(false);
      resume();
      // The confirm was sent on evidence. The saga move commits right after the send record, so by the time the
      // supplier's answer is applied the evidence is gone: the engine holds the booking blocking, with attention,
      // for a human (SUP-20), and the release the saga asks for next is refused.
      expect((await run).processed.map((p) => `${p.kind}:${p.outcome}`)).toEqual(["confirm:final_without_payment"]);
      await move;
      expect(td2.calls).toContain("confirm");
      expect(await confirmsSentFor(c.id)).toBe(1);
      const after = await booking(c.id);
      expect(after).toMatchObject({ state: "outcome_unknown", errorCode: "supplier_final_without_payment" });
      expect(after.attentionRequiredAt).not.toBeNull();
      expect(await svc.releaseHold(c.id, "payment_refunded", { now })).toBe("not_applicable");
      // Held for a human, the liability record is intact: the same supplier booking, and the reserve's charge with
      // nothing added or given back (holdForReread books no wallet entry).
      expect(after.supplierBookingId).toBe(held.supplierBookingId);
      expect(await prisma.supplierBookingEvent.count({ where: { supplierBookingId: c.id, kind: "supplier_final_without_payment" } })).toBe(1);
      expect((await walletOf(c.id)).map((e) => [e.kind, e.amountMinor])).toEqual(walletAtReserve);
    });

    it("the scheduled run sends an order-item reserve only while a verified payment backs it; drill reserves stay manual (CR-B3-5)", async () => {
      const td = new FakeTravelDesk(now);
      const scheduled = (over: Partial<EngineDeps> = {}) => svc.runDueJobs(deps(td, { mutations: "paid_only", ...over }), { budgetMs: 60_000 });
      const hold = (over: Record<string, unknown> = {}) => ({ status: "authorized", capturedMinor: 0n, capturedAt: null, rail: "aed_card", threeDs: "passed", authorizedAt: now(), authorizationExpiresAt: new Date(clock + 7 * 86_400_000), ...over });

      // Backed: a capture-first payment, and a card hold inside RESERVE_REQUIRES that has not expired.
      const upi = await orderItem();
      await paidSaga(upi, { state: "reserve_pending" });
      const captured = await create(forOrder(upi));
      const card = await orderItem();
      await paidSaga(card, { state: "reserve_pending", payment: hold() });
      const held = await create(forOrder(card));
      // Not backed: no saga, elevated risk, 3DS unknown, an expired hold, a partial capture, a manual row, a saga flagged for a human.
      const unbacked: string[] = [];
      unbacked.push((await create(forOrder(await orderItem()))).id);
      for (const [payment, attention] of [
        [hold({ risk: "elevated" }), false],
        [hold({ threeDs: "unknown" }), false],
        [hold({ authorizationExpiresAt: new Date(clock - 1_000) }), false],
        [{ capturedMinor: 500n }, false],
        [{ source: "manual", gateway: "manual", provider: null, providerAccountId: null, environment: null, rail: null, gatewayPaymentId: null }, false],
        [{}, true],
      ] as [Record<string, unknown>, boolean][]) {
        const ids = await orderItem();
        await paidSaga(ids, { state: "reserve_pending", attention, payment });
        unbacked.push((await create(forOrder(ids))).id);
      }
      const drill = await create(intent({ afterReserve: "hold" }));

      const r = await scheduled();
      expect(td.calls.filter((x) => x === "reserve")).toHaveLength(2);
      expect((await booking(captured.id)).state).toBe("awaiting_payment");
      expect((await booking(held.id)).state).toBe("awaiting_payment");
      expect(r.processed.filter((p) => p.outcome === "reserve_unbacked")).toHaveLength(unbacked.length);
      for (const id of unbacked) {
        expect((await booking(id)).state).toBe("queued");
        // The job waits for a later run; nothing was sent or closed.
        expect(await prisma.supplierJob.findUnique({ where: { dedupeKey: `reserve:${id}` } })).toMatchObject({ status: "queued" });
      }
      expect((await booking(drill.id)).state).toBe("queued");
      expect(await prisma.supplierJob.findUnique({ where: { dedupeKey: `reserve:${drill.id}` } })).toMatchObject({ status: "queued" });
    });

    it("a backed reserve on the scheduled run is still held by a new-sales pause and by admission control (CR-B3-5, SUP-7)", async () => {
      const td = new FakeTravelDesk(now);
      const key = bookingControlKeyFor(CODE, "test", "default");
      // A drill reserved by hand, its confirm queued with a send deadline but not due yet.
      const drill = await create(intent());
      await svc.runDueJobs(deps(td), { budgetMs: 60_000, maxJobs: 1 });
      expect((await booking(drill.id)).state).toBe("reserved");
      await prisma.supplierJob.update({ where: { dedupeKey: `confirm:${drill.id}` }, data: { runAfter: new Date(clock + 3600_000) } });
      td.calls = [];
      const ids = await orderItem();
      await paidSaga(ids, { state: "reserve_pending" });
      const b = await create(forOrder(ids));
      try {
        await prisma.setting.upsert({ where: { key }, create: { key, value: { paused: true, scope: "new_sales" } }, update: { value: { paused: true, scope: "new_sales" } } });
        await svc.runDueJobs(deps(td, { mutations: "paid_only" }), { budgetMs: 60_000 });
        expect(td.calls).not.toContain("reserve");
        expect((await booking(b.id)).state).toBe("queued");
      } finally {
        await prisma.setting.deleteMany({ where: { key } });
      }

      // Unpaused: the drill's queued confirm would not fit before its send deadline after one more reserve.
      const r = await svc.runDueJobs(deps(td, { mutations: "paid_only", mutationP95Ms: 10 * 60_000 }), { budgetMs: 60_000, maxJobs: 1 });
      expect(r.processed.map((p) => p.outcome)).toEqual(["admission_deferred"]);
      expect(td.calls).not.toContain("reserve");
      expect((await booking(b.id)).state).toBe("queued");
    });

    describe("the scheduled run sends a customer's supported cancellation, and no other cancel (B5, F38)", () => {
      const requestRows: string[] = [];
      afterAll(async () => {
        await prisma.cancellationRequest.deleteMany({ where: { id: { in: requestRows } } });
      });

      /** A customer booking confirmed on verified capture. Set up before any cancel is queued: a manual run claims cancels first. */
      async function confirmed(td: FakeTravelDesk) {
        const paid = new Set<string>();
        const payments = port(paid);
        const ids = await orderItem();
        const c = await create(forOrder(ids));
        await svc.runDueJobs(deps(td, { payments }), { budgetMs: 60_000, maxJobs: 1 });
        expect((await booking(c.id)).state).toBe("awaiting_payment");
        paid.add(ids.orderItemId);
        expect(await svc.confirmIfPaid(c.id, { payments, now, mutationTimeoutMs: 1_000 })).toBe("confirm_queued");
        await svc.runDueJobs(deps(td, { payments, mutations: "paid_only" }), { budgetMs: 60_000, maxJobs: 1 });
        expect((await booking(c.id)).state).toBe("confirmed");
        return { ...ids, bookingId: c.id };
      }

      /** A synthetic cancellation request row for the item (no money, no supplier figures). */
      async function cancellationRequest(ids: { orderId: string; orderItemId: string; bookingId: string }, kind: "supported" | "exception", status: string) {
        const id = uuidv7();
        const closed = ["refunded", "refused", "exception_closed"].includes(status);
        await prisma.cancellationRequest.create({
          data: { id, orderId: ids.orderId, orderItemId: ids.orderItemId, supplierBookingId: ids.bookingId, kind, status, requestedVia: "customer", closedAt: closed ? now() : null },
        });
        requestRows.push(id);
        return id;
      }

      const scheduled = (td: FakeTravelDesk) => svc.runDueJobs(deps(td, { mutations: "paid_only" }), { budgetMs: 60_000 });
      const cancelsSent = (id: string) => prisma.supplierBookingEvent.count({ where: { supplierBookingId: id, kind: "request_sent", operation: "bookings.cancel" } });

      it("without a request the cancel is not claimed, and a drill's cancel stays manual", async () => {
        const td = new FakeTravelDesk(now);
        const c = await confirmed(td);
        const drill = await create(intent({ afterReserve: "hold" }));
        await svc.runDueJobs(deps(td), { budgetMs: 60_000, maxJobs: 1 });
        expect((await booking(drill.id)).state).toBe("reserved");
        await svc.requestCancel(c.bookingId, { now });
        await svc.requestCancel(drill.id, { now });
        td.calls = [];

        const r = await scheduled(td);
        expect(td.calls).not.toContain("cancel");
        expect(r.processed.some((p) => p.kind === "cancel")).toBe(false);
        expect((await booking(c.bookingId)).state).toBe("confirmed");
        expect((await booking(drill.id)).state).toBe("reserved");
        expect(await cancelsSent(c.bookingId)).toBe(0);
        expect(await prisma.supplierJob.findUnique({ where: { dedupeKey: `cancel:${c.bookingId}` } })).toMatchObject({ status: "queued" });
        expect(await prisma.supplierJob.findUnique({ where: { dedupeKey: `cancel:${drill.id}` } })).toMatchObject({ status: "queued" });
      });

      it("an exception request or a closed supported request does not let it through", async () => {
        const td = new FakeTravelDesk(now);
        const exception = await confirmed(td);
        const closed = await confirmed(td);
        await cancellationRequest(exception, "exception", "exception_open");
        await cancellationRequest(closed, "supported", "refused");
        for (const c of [exception, closed]) await svc.requestCancel(c.bookingId, { now });
        td.calls = [];

        await scheduled(td);
        expect(td.calls).not.toContain("cancel");
        for (const c of [exception, closed]) {
          expect((await booking(c.bookingId)).state).toBe("confirmed");
          expect(await cancelsSent(c.bookingId)).toBe(0);
        }
      });

      it("an open supported request that names the attempt has its cancel sent and verified", async () => {
        const td = new FakeTravelDesk(now);
        const c = await confirmed(td);
        await cancellationRequest(c, "supported", "requested");
        await svc.requestCancel(c.bookingId, { now });
        td.calls = [];

        const r = await scheduled(td);
        expect(r.processed.filter((p) => p.kind === "cancel").map((p) => p.outcome)).toHaveLength(1);
        expect(td.calls.filter((x) => x === "cancel")).toHaveLength(1);
        expect(await cancelsSent(c.bookingId)).toBe(1);
        expect((await booking(c.bookingId)).state).toBe("cancelled");
      });

      it("the handler re-checks the request under the lease: a request closed after the claim stops the send", async () => {
        const td = new FakeTravelDesk(now);
        const c = await confirmed(td);
        await svc.requestCancel(c.bookingId, { now });
        td.calls = [];
        const outcome = await svc.runJob("cancel", c.bookingId, { ...deps(td, { mutations: "paid_only" }), holder: `h-${RUN}`, mutationTimeoutMs: 1_000, now } as never);
        expect(outcome).toBe("cancel_unrequested");
        expect(td.calls).not.toContain("cancel");
        expect((await booking(c.bookingId)).state).toBe("confirmed");
        expect(await prisma.supplierJob.findUnique({ where: { dedupeKey: `cancel:${c.bookingId}` } })).toMatchObject({ status: "queued" });
      });
    });

    it("engineSagaApi.startAttempt builds the intent from the order item and its quote line, idempotently, and refuses a line without the supplier's USD net", async () => {
      const { createEngineSagaApi } = await import("../engine-saga.service");
      const { createHash } = await import("node:crypto");
      const { storedOffer, storedSlot } = await import("../../suppliers/__tests__/fixtures/traveldesk-terms");
      const paid = new Set<string>();
      const api = createEngineSagaApi({ config: () => ({ environment: "test", agencyId: null, mutationTimeoutMs: 1_000 }), payments: port(paid), supplierCode: CODE, now });

      const any = await prisma.product.findFirstOrThrow({ select: { categorySlug: true } });
      const productId = uuidv7();
      await prisma.product.create({ data: { id: productId, slug: `zz-test-${RUN}-saga-${++n}`, title: "engine saga test", tier: "B", status: "draft", categorySlug: any.categorySlug, confirmation: "instant", content: {} } });
      const hash = "a".repeat(64);
      const mapping = await prisma.productSupplierMapping.create({
        data: {
          id: uuidv7(),
          productId,
          supplierId,
          externalRef: { tourId: 1, offerId: OFFER, bookingKind: "live_book", isExternal: false },
          supplierProductId: "1",
          supplierOfferId: String(OFFER),
          bookingKind: "live_book",
          environment: "test",
          syncStatus: "ok",
          approvedOfferHash: hash,
        },
      });
      await prisma.supplierCatalogueItem.upsert({
        where: { supplierId_environment_kind_externalId: { supplierId, environment: "test", kind: "offer", externalId: String(OFFER) } },
        create: {
          id: uuidv7(),
          supplierId,
          environment: "test",
          kind: "offer",
          externalId: String(OFFER),
          parentExternalId: "1",
          name: "engine saga offer",
          bookingKind: "live_book",
          payload: storedOffer({ offerId: OFFER, tourId: 1, timeSlots: [storedSlot({ timeSlotId: 9, startMinutes: 1260, endMinutes: 1365 })] }) as never,
          payloadHash: "x",
        },
        update: {},
      });

      async function sold(line: Record<string, unknown> = {}) {
        const ids = await orderItem("instant_checkout");
        const guest = uuidv7();
        await prisma.guestSession.create({ data: { id: guest, tokenHash: createHash("sha256").update(`zz-td-${guest}`).digest("hex"), expiresAt: new Date(Date.now() + 86_400_000) } });
        const quoteId = uuidv7();
        await prisma.quote.create({
          data: {
            id: quoteId,
            fingerprint: createHash("sha256").update(quoteId).digest("hex"),
            ownerKind: "guest",
            guestSessionId: guest,
            currency: "AED",
            totalMinor: 30_000n,
            lines: [
              {
                index: 0,
                mappingId: mapping.id,
                approvedOfferHash: hash,
                supplierEnvironment: "test",
                supplierAccountId: "default",
                serviceDate: "2026-11-10",
                slotRef: "9@21:00",
                units: { adult: 2 },
                unitDefinitions: [{ unitId: "adult", supplierUnit: "adult" }],
                pickup: null,
                supplierNetAedMinor: "24000",
                supplierNetUsdMinor: "6600",
                ...line,
              },
            ],
            request: {},
            status: "used",
            usedByOrderId: ids.orderId,
            createdAt: new Date(Date.now() - 1_000),
            expiresAt: new Date(Date.now() + 600_000),
          },
        });
        await prisma.orderItem.update({ where: { id: ids.orderItemId }, data: { quoteId, mappingId: mapping.id } });
        return { ...ids, quoteId };
      }

      const ids = await sold();
      const { supplierBookingId } = await prisma.$transaction((tx) => api.startAttempt(tx, ids));
      expect(await booking(supplierBookingId)).toMatchObject({
        orderId: ids.orderId,
        orderItemId: ids.orderItemId,
        mappingId: mapping.id,
        idempotencyKey: `order:${ids.orderId}:item:${ids.orderItemId}:try:1`,
        afterReserve: "await_payment",
        mode: "two_step",
        offerExternalId: String(OFFER),
        serviceDate: new Date("2026-11-10T00:00:00Z"),
        timeSlotId: "9",
        startMinutes: 1260,
        endMinutes: 1365,
        adults: 2,
        children: 0,
        infants: 0,
        expectedNetMinor: 24_000n,
        expectedNetUsdMinor: 6_600n,
        guestName: "test engine", // the order's "test-engine" in the Latin-letters form TravelDesk accepts
        state: "queued",
      });
      // A repeat returns the same attempt: the saga never makes a second one.
      expect((await prisma.$transaction((tx) => api.startAttempt(tx, ids))).supplierBookingId).toBe(supplierBookingId);

      // Through the API: not ready before the hold and the evidence, queued once paid, then confirmed; no release after.
      const td = new FakeTravelDesk(now);
      expect(await api.confirmIfPaid(supplierBookingId)).toBe("not_ready");
      await drain(td, 0, 31_000, { payments: port(paid) });
      expect(await api.confirmIfPaid(supplierBookingId)).toBe("not_ready");
      paid.add(ids.orderItemId);
      expect(await api.confirmIfPaid(supplierBookingId)).toBe("queued");
      await drain(td, 0, 31_000, { payments: port(paid) });
      expect((await booking(supplierBookingId)).state).toBe("confirmed");
      expect(await api.confirmIfPaid(supplierBookingId)).toBe("queued");
      expect(await api.releaseHold(supplierBookingId, "too_late")).toBe("not_applicable");

      const reason = async (line: Record<string, unknown>) => {
        const x = await sold(line);
        const e = await prisma.$transaction((tx) => api.startAttempt(tx, x)).catch((err) => err);
        return isAppError(e) ? (e.details as { reason?: string } | undefined)?.reason : String(e);
      };
      expect(await reason({ supplierNetUsdMinor: undefined })).toBe("supplier_usd_net_missing");
      expect(await reason({ slotRef: "21:00" })).toBe("slot_unknown");
      expect(await reason({ approvedOfferHash: "b".repeat(64) })).toBe("mapping_changed");
      expect(await reason({ supplierAccountId: "another-agency" })).toBe("supplier_account_changed");
    });

    describe("the scheduled run sends the payment saga's hold-release cancel (doc 22 §32.22, owner 4 Nov 2026)", () => {
      const key = bookingControlKeyFor(CODE, "test", "default");
      afterEach(async () => {
        await prisma.setting.deleteMany({ where: { key } });
      });
      const scheduled = (td: FakeTravelDesk, budgetMs = 60_000) => svc.runDueJobs(deps(td, { mutations: "paid_only" }), { budgetMs });
      const cancelsSent = (id: string) => prisma.supplierBookingEvent.count({ where: { supplierBookingId: id, kind: "request_sent", operation: "bookings.cancel" } });

      /** A customer hold reserved by a manual run, then released by the payment saga (an earlier item of a failed order). */
      async function released(td: FakeTravelDesk) {
        const ids = await orderItem();
        const b = await create(forOrder(ids));
        await svc.runDueJobs(deps(td), { budgetMs: 60_000, maxJobs: 1 });
        expect((await booking(b.id)).state).toBe("awaiting_payment");
        expect(await svc.releaseHold(b.id, "item_failed", { now })).toBe("queued");
        expect(await prisma.supplierJob.findUnique({ where: { dedupeKey: `cancel:${b.id}` } })).toMatchObject({ status: "queued" });
        td.calls = [];
        return { ...ids, bookingId: b.id };
      }

      it("sends the queued release cancel, and the hold ends cancelled on the supplier's re-read", async () => {
        const td = new FakeTravelDesk(now);
        const h = await released(td);
        const r = await scheduled(td);
        expect(r.processed.filter((p) => p.kind === "cancel").map((p) => p.outcome)).toEqual(["cancelled"]);
        expect(td.calls.filter((x) => x === "cancel" || x === "confirm" || x === "reserve")).toEqual(["cancel"]);
        expect(await cancelsSent(h.bookingId)).toBe(1);
        const after = await booking(h.bookingId);
        expect(after.state).toBe("cancelled");
        expect(td.store.get(after.supplierBookingId!)?.status).toBe(4);
        // The guard is released only by the verified cancel: a new attempt is possible now.
        expect(isConflict(await secondAttempt(h))).toBe(false);
      });

      it("still runs under a new-sales pause, and a busy lane only makes it wait", async () => {
        const td = new FakeTravelDesk(now);
        const h = await released(td);
        await prisma.setting.upsert({ where: { key }, create: { key, value: { paused: true, scope: "new_sales" } }, update: { value: { paused: true, scope: "new_sales" } } });
        await holdLease("another-worker", 60);
        const busy = await scheduled(td);
        expect(busy.processed.filter((p) => p.kind === "cancel").map((p) => p.outcome)).toEqual(["lease_busy"]);
        expect(td.calls).not.toContain("cancel");
        await releaseLeases();
        clock += 16_000;
        const r = await scheduled(td);
        expect(r.processed.filter((p) => p.kind === "cancel").map((p) => p.outcome)).toEqual(["cancelled"]);
        expect((await booking(h.bookingId)).state).toBe("cancelled");
        expect((await engine.bookingControl(CODE, "test", "default")).paused).toBe(true);
      });

      it("respects the mutation window: with less than a mutation timeout left in the budget it waits for the next run", async () => {
        const td = new FakeTravelDesk(now);
        const h = await released(td);
        // deps(): a 1 s mutation timeout, so a mutation needs 31 s of budget left.
        const late = await scheduled(td, 20_000);
        expect(late.processed.some((p) => p.kind === "cancel")).toBe(false);
        expect(td.calls).not.toContain("cancel");
        expect(await prisma.supplierJob.findUnique({ where: { dedupeKey: `cancel:${h.bookingId}` } })).toMatchObject({ status: "queued" });
        await scheduled(td);
        expect((await booking(h.bookingId)).state).toBe("cancelled");
      });

      it("never cancels a released attempt that became confirmed some other way, e.g. by recovery (review P3-6)", async () => {
        const td = new FakeTravelDesk(now);
        const paid = new Set<string>();
        const payments = port(paid);
        const ids = await orderItem();
        // The reserve's answer is lost (TravelDesk made the hold); the saga releases the attempt while it is unresolved.
        td.steps.reserve.push("lost");
        const b = await create(forOrder(ids));
        await svc.runDueJobs(deps(td), { budgetMs: 60_000, maxJobs: 1 });
        expect((await booking(b.id)).state).toBe("outcome_unknown");
        expect(await svc.releaseHold(b.id, "item_failed", { now })).toBe("queued");
        // At TravelDesk the booking went on to be confirmed (no confirm from Outly), and the item is paid.
        const atSupplier = [...td.store.values()].find((x) => x.bookingReference === b.clientRef)!;
        td.store.set(atSupplier.supplierBookingId, { ...atSupplier, status: 1, reservationDeadline: null });
        paid.add(ids.orderItemId);
        td.calls = [];
        // Scheduled runs only: the release cancel waits while recovery looks the booking up, which finds it confirmed.
        await drain(td, 120_000, 31_000, { payments, mutations: "paid_only" });
        expect((await booking(b.id)).state).toBe("confirmed");
        expect(td.calls).not.toContain("cancel");
        expect(await cancelsSent(b.id)).toBe(0);
        // Not claimed by a scheduled run either way, and the handler refuses it.
        const r = await scheduled(td);
        expect(r.processed.some((p) => p.kind === "cancel")).toBe(false);
        expect(await svc.releaseCancelDue(await booking(b.id))).toBe(false);
      });

      it("never runs for an attempt whose confirm was sent, nor for a drill's release", async () => {
        const td = new FakeTravelDesk(now);
        const paid = new Set<string>();
        const payments = port(paid);
        const ids = await orderItem();
        const c = await create(forOrder(ids));
        await svc.runDueJobs(deps(td, { payments }), { budgetMs: 60_000, maxJobs: 1 });
        paid.add(ids.orderItemId);
        expect(await svc.confirmIfPaid(c.id, { payments, now, mutationTimeoutMs: 1_000 })).toBe("confirm_queued");
        await svc.runDueJobs(deps(td, { payments, mutations: "paid_only" }), { budgetMs: 60_000, maxJobs: 1 });
        expect((await booking(c.id)).state).toBe("confirmed");
        // A drill's hold released the same way stays manual (no order item).
        const drill = await create(intent({ afterReserve: "hold" }));
        await svc.runDueJobs(deps(td), { budgetMs: 60_000, maxJobs: 1 });
        expect((await booking(drill.id)).state).toBe("reserved");
        expect(await svc.releaseHold(drill.id, "drill_release", { now })).toBe("queued");
        // releaseHold refuses after a confirm; a release marker written some other way must still not let a cancel through.
        expect(await svc.releaseHold(c.id, "too_late", { now })).toBe("not_applicable");
        await prisma.supplierBookingEvent.create({ data: { id: uuidv7(), supplierBookingId: c.id, kind: "release_requested", actor: "system", detail: { reason: "test_marker" } } });
        await svc.requestCancel(c.id, { now });
        td.calls = [];

        const r = await scheduled(td);
        expect(r.processed.some((p) => p.kind === "cancel")).toBe(false);
        expect(td.calls).not.toContain("cancel");
        expect(await cancelsSent(c.id)).toBe(0);
        expect((await booking(c.id)).state).toBe("confirmed");
        expect((await booking(drill.id)).state).toBe("reserved");
        // The handler re-checks under the lease, whatever the claim did.
        expect(await svc.runJob("cancel", c.id, { ...deps(td, { mutations: "paid_only" }), holder: `h-${RUN}`, mutationTimeoutMs: 1_000, now } as never)).toBe("cancel_unrequested");
        expect(td.calls).not.toContain("cancel");
      });
    });
  });

  /* -------------------------------------------------------------------------
   * Outage circuit breaker (doc 22 §32.22 finding 1, owner 4 Nov 2026)
   * ---------------------------------------------------------------------- */

  describe("outage circuit breaker (doc 22 §32.22)", () => {
    const key = () => bookingControlKeyFor(CODE, "test", "default");
    const counterKey = () => engine.outageCounterKey(CODE, "test", "default");
    const scope = () => ({ supplierCode: CODE, supplierId, environment: "test" as const, accountId: "default" });
    const outage = { kind: "unknown", sent: true, reason: "server" } as const;
    /** An operator's control row with the defaults: not paused. */
    async function open() {
      await prisma.setting.upsert({ where: { key: key() }, create: { key: key(), value: {} as never }, update: { value: {} as never } });
    }
    afterEach(async () => {
      vi.restoreAllMocks();
      await prisma.setting.deleteMany({ where: { key: { in: [key(), counterKey()] } } });
    });
    const control = () => engine.bookingControl(CODE, "test", "default");
    /** The failure instants the breaker keeps (at most three). */
    async function fails(): Promise<string[]> {
      const row = await prisma.setting.findUnique({ where: { key: counterKey() } });
      return ((row?.value ?? {}) as { fails?: string[] }).fails ?? [];
    }
    const count = async () => (await fails()).length;
    /** Move every kept failure `ms` into the past (the window runs on the database clock). */
    async function age(ms: number) {
      const row = await prisma.setting.findUniqueOrThrow({ where: { key: counterKey() } });
      const v = row.value as { fails: string[] };
      await prisma.setting.update({ where: { key: counterKey() }, data: { value: { ...v, fails: v.fails.map((x) => new Date(Date.parse(x) - ms).toISOString()) } } });
    }
    // Audit rows are append-only: each test counts only the automatic pauses written after it started.
    const allAutoPauses = () => prisma.auditLog.findMany({ where: { entityType: "supplier", entityId: supplierId, action: "supplier_bookings.pause", reason: engine.OUTAGE_PAUSE_REASON }, orderBy: { id: "asc" } });
    let before = 0;
    beforeEach(async () => {
      before = (await allAutoPauses()).length;
    });
    const autoPauses = async () => (await allAutoPauses()).slice(before);
    const server = () => new TravelDeskApiError("server", "bookings.reserve", { status: 503 });
    // What traveldesk.http.ts makes of a 400 carrying a JSON-wrapped IIS "HTTP Error 502.5" page.
    const page = () => new TravelDeskApiError("server", "bookings.reserve", { status: 400, serverErrorPage: true });
    const network = () => new TravelDeskApiError("network", "bookings.reserve");

    /** Drill reserves, one per step, sent in one manual run; each answered by its step. */
    async function reserves(td: FakeTravelDesk, steps: Step[]) {
      td.steps.reserve.push(...steps);
      const ids: string[] = [];
      for (let i = 0; i < steps.length; i++) ids.push((await create(intent({ afterReserve: "hold" }))).id);
      const r = await svc.runDueJobs(deps(td), { budgetMs: 60_000 });
      return { ids, outcomes: r.processed.filter((p) => p.kind === "reserve").map((p) => p.outcome) };
    }

    it("three outage answers in a row (5xx, a wrapped 502.5 page, a connection failure) pause new sales, with an audit row, an alert and an error event", async () => {
      await open();
      const errors = vi.spyOn(log, "error");
      const td = new FakeTravelDesk(now);
      const { ids, outcomes } = await reserves(td, [server(), page(), network()]);
      expect(outcomes).toEqual(["outcome_unknown", "outcome_unknown", "outcome_unknown"]);
      expect((await booking(ids[1])).errorCode).toBe("server_error_page");
      expect(await control()).toMatchObject({ paused: true, scope: "new_sales", reason: "supplier_outage_auto" });
      const audits = await autoPauses();
      expect(audits).toHaveLength(1);
      expect(audits[0]).toMatchObject({ actorType: "system", actorId: null });
      expect(audits[0].after).toMatchObject({ paused: true, scope: "new_sales", trigger: { failures: 3, lastReason: "network" } });
      const alerts = (await events(ids[2])).filter((e) => e.kind === "alert");
      expect(alerts.map((e) => e.detail)).toEqual([{ reason: "supplier_outage_auto", code: "network", errors: 3 }]);
      expect(errors).toHaveBeenCalledWith("supplier.outage_paused", { supplierCode: CODE, environment: "test", account: "default", failures: 3, reason: "supplier_outage_auto", lastReason: "network" });
    });

    it("two outage answers do not pause", async () => {
      await open();
      const td = new FakeTravelDesk(now);
      await reserves(td, [server(), page()]);
      expect(await count()).toBe(2);
      expect((await control()).paused).toBe(false);
      expect(await autoPauses()).toHaveLength(0);
    });

    it("a success does not reset the record: a partial outage (reserves failing, release cancels working) still trips (review P2-2)", async () => {
      await open();
      const td = new FakeTravelDesk(now);
      // Three customer holds reserved before the outage; each is released in turn as an order fails.
      const holds: string[] = [];
      for (let i = 0; i < 3; i++) holds.push((await create(forOrder(await orderItem()))).id);
      await svc.runDueJobs(deps(td), { budgetMs: 60_000 });
      for (const id of holds) expect((await booking(id)).state).toBe("awaiting_payment");
      for (let i = 0; i < 3; i++) {
        expect((await control()).paused).toBe(false);
        // A reserve answered with the wrapped 502.5 page, then a release cancel answered 200 and verified.
        expect((await reserves(td, [page()])).outcomes).toEqual(["outcome_unknown"]);
        expect(await svc.releaseHold(holds[i], "item_failed", { now })).toBe("queued");
        const r = await svc.runDueJobs(deps(td, { mutations: "paid_only" }), { budgetMs: 60_000 });
        expect(r.processed.filter((p) => p.kind === "cancel").map((p) => p.outcome)).toEqual(["cancelled"]);
      }
      expect(await control()).toMatchObject({ paused: true, reason: "supplier_outage_auto" });
      expect(await count()).toBe(3);
      // A plain success afterwards leaves the record as it is.
      expect(await engine.noteMutationHealth(scope(), { kind: "accepted" } as never, null)).toBe("ignored");
      expect(await count()).toBe(3);
    });

    it("definite rejections (401, 403), a 422 HotelId and a plain 400 are answers, not outages: they never count", async () => {
      await open();
      const td = new FakeTravelDesk(now);
      await reserves(td, [server(), server()]);
      const { ids, outcomes } = await reserves(td, [
        new TravelDeskApiError("auth", "bookings.reserve", { status: 401 }),
        new TravelDeskApiError("auth", "bookings.reserve", { status: 403 }),
        new TravelDeskApiError("validation", "bookings.reserve", { status: 422, fieldErrors: [{ fieldName: "HotelId", errorMessage: "required" }] }),
        new TravelDeskApiError("bad_request", "bookings.reserve", { status: 400, reason: "Offer is not bookable" }),
      ]);
      expect(outcomes).toEqual(["rejected:auth", "rejected:auth", "outcome_unknown", "outcome_unknown"]);
      expect((await booking(ids[2])).errorCode).toBe("validation");
      expect(await count()).toBe(2);
      expect((await control()).paused).toBe(false);
      await reserves(td, [server()]);
      expect((await control()).paused).toBe(true);
    });

    it("a sliding window: failures at 0, 8, 12 and 14 minutes trip on the fourth (8, 12 and 14 are within ten minutes) (review P2-1)", async () => {
      await open();
      const note = () => engine.noteMutationHealth(scope(), outage, null);
      expect(await note()).toBe("counted"); // t = 0
      await age(8 * 60_000);
      expect(await note()).toBe("counted"); // t = 8
      await age(4 * 60_000);
      expect(await note()).toBe("counted"); // t = 12: the oldest of three is 12 minutes old
      expect((await control()).paused).toBe(false);
      await age(2 * 60_000);
      expect(await note()).toBe("tripped"); // t = 14: the last three span 6 minutes
      expect(await count()).toBe(3);
      expect(await control()).toMatchObject({ paused: true, reason: "supplier_outage_auto" });
    });

    it("a low-traffic outage, one failure every four minutes, trips on the third", async () => {
      await open();
      const note = () => engine.noteMutationHealth(scope(), outage, null);
      expect(await note()).toBe("counted");
      await age(4 * 60_000);
      expect(await note()).toBe("counted");
      await age(4 * 60_000);
      expect(await note()).toBe("tripped");
    });

    it("the automatic pause clears the last operator's name from the control row (review P3-5)", async () => {
      const staff = await createStaff(RUN, "brk-ops", ["admin"]);
      await prisma.setting.upsert({ where: { key: key() }, create: { key: key(), value: {} as never, updatedBy: staff.id }, update: { value: {} as never, updatedBy: staff.id } });
      for (let i = 0; i < 3; i++) await engine.noteMutationHealth(scope(), outage, null);
      const row = await prisma.setting.findUniqueOrThrow({ where: { key: key() } });
      expect((row.value as { paused: boolean }).paused).toBe(true);
      expect(row.updatedBy).toBeNull();
    });

    it("the pause holds new reserves and intake, never cancels, confirms of existing holds or recovery; checkout sends new orders to inquiry", async () => {
      await open();
      const td = new FakeTravelDesk(now);
      const paid = new Set<string>();
      const payments: PaymentEvidencePort = {
        async capturedFor(orderItemId) {
          return paid.has(orderItemId) ? { orderItemId, paymentId: uuidv7(), provider: "test", providerPaymentId: "pay_test", currency: "AED", capturedMinor: 30_000n, verifiedAt: now() } : null;
        },
      };
      // Before the outage: a hold to release, a hold to confirm, a reserve whose answer was lost, and a reserve not sent yet.
      const toRelease = await orderItem();
      const r1 = await create(forOrder(toRelease));
      const toConfirm = await orderItem();
      const c1 = await create(forOrder(toConfirm));
      await svc.runDueJobs(deps(td, { payments }), { budgetMs: 60_000 });
      expect((await booking(r1.id)).state).toBe("awaiting_payment");
      expect((await booking(c1.id)).state).toBe("awaiting_payment");
      const { ids } = await reserves(td, ["lost"]);
      expect((await booking(ids[0])).state).toBe("outcome_unknown");
      const waiting = await create(intent({ afterReserve: "hold" }));
      // The outage: two more failures elsewhere on the account (the lost reserve was the first).
      for (const _ of [1, 2]) await engine.noteMutationHealth(scope(), outage, null);
      expect(await control()).toMatchObject({ paused: true, scope: "new_sales", reason: "supplier_outage_auto" });

      // Intake is refused; checkout's gate reads the same control and its refusal reaches the browser as inquiry.
      expect(isConflict(await create(intent()).catch((e) => e))).toBe(true);
      const { publicRefusal } = await import("../../../app/api/checkout/handler");
      expect((await control()).paused && publicRefusal("sales_paused")).toBe("requires_inquiry");

      expect(await svc.releaseHold(r1.id, "item_failed", { now })).toBe("queued");
      paid.add(toConfirm.orderItemId);
      expect(await svc.confirmIfPaid(c1.id, { payments, now, mutationTimeoutMs: 1_000 })).toBe("confirm_queued");
      td.calls = [];
      await drain(td, 60_000, 31_000, { payments });
      expect(td.calls).not.toContain("reserve");
      expect((await booking(waiting.id)).state).toBe("queued");
      expect((await booking(r1.id)).state).toBe("cancelled");
      expect((await booking(c1.id)).state).toBe("confirmed");
      // Recovery found the lost reserve (the fake had made it) and settled it: never resent.
      expect((await booking(ids[0])).state).toBe("reserved");
      expect((await events(ids[0])).some((e) => e.kind === "recovery_search")).toBe(true);
      expect((await control()).paused).toBe(true);
    });

    it("concurrent failures on several instances pause exactly once", async () => {
      await open();
      const notes = await Promise.all(Array.from({ length: 6 }, () => engine.noteMutationHealth(scope(), outage, null)));
      expect(notes.filter((x) => x === "tripped")).toHaveLength(1);
      expect(notes.filter((x) => x === "counted")).toHaveLength(5);
      expect(await count()).toBe(3);
      expect(await autoPauses()).toHaveLength(1);
      expect(await control()).toMatchObject({ paused: true, reason: "supplier_outage_auto" });
    });

    it("never loosens a control and never auto-resumes; the privileged resume clears the pause and the count", async () => {
      // A missing row is not written (in production it already means paused).
      for (let i = 0; i < 3; i++) await engine.noteMutationHealth(scope(), outage, null);
      expect(await prisma.setting.findUnique({ where: { key: key() } })).toBeNull();
      await prisma.setting.deleteMany({ where: { key: counterKey() } });
      // An emergency stop stays an emergency stop.
      await prisma.setting.upsert({ where: { key: key() }, create: { key: key(), value: { paused: true, scope: "all_writes", reason: "operator" } }, update: { value: { paused: true, scope: "all_writes", reason: "operator" } } });
      for (let i = 0; i < 3; i++) await engine.noteMutationHealth(scope(), outage, null);
      expect(await control()).toMatchObject({ paused: true, scope: "all_writes", reason: "operator" });
      expect(await autoPauses()).toHaveLength(0);
      await prisma.setting.deleteMany({ where: { key: counterKey() } });

      await open();
      for (let i = 0; i < 3; i++) await engine.noteMutationHealth(scope(), outage, null);
      expect((await control()).paused).toBe(true);
      // A healthy answer neither resets the record nor resumes anything.
      expect(await engine.noteMutationHealth(scope(), { kind: "accepted" } as never, null)).toBe("ignored");
      expect(await count()).toBe(3);
      expect(await control()).toMatchObject({ paused: true, reason: "supplier_outage_auto" });

      // Resume is the existing privileged path: an applied approval for exactly this change.
      const { privilegedPayloadHash } = await import("../approval.service");
      const staff = await createStaff(RUN, "brk-admin", ["admin"]);
      const admin: Actor = { type: "admin", id: staff.id, roles: ["admin"], permissions: new Set(["*"]) };
      const on = { supplierCode: CODE, environment: "test" as const };
      expect(code(await svc.setControl(admin, { paused: false }, "resume after the outage", on).catch((e) => e))).toBe("FORBIDDEN");
      for (let i = 0; i < 2; i++) await engine.noteMutationHealth(scope(), outage, null);
      const { before } = await svc.controlRequest({ paused: false }, on);
      const payload = engine.controlApprovalPayload(CODE, "test", "default", { paused: false }, before);
      const at = new Date();
      const approval = await prisma.privilegedApproval.create({
        data: {
          id: uuidv7(),
          operation: "supplier.resume",
          permission: "suppliers.resume",
          payload: payload as never,
          payloadHash: privilegedPayloadHash("supplier.resume", "suppliers.resume", "test", payload),
          environment: "test",
          status: "applied",
          requestedBy: staff.id,
          requestedAt: at,
          appliedAt: at,
          expiresAt: new Date(at.getTime() + 30 * 60_000),
        },
      });
      expect(await svc.setControl(admin, { paused: false }, "resume after the outage", { ...on, approvalId: approval.id })).toMatchObject({ paused: false });
      expect(await count()).toBe(0);
      // A single failure after the resume does not pause again.
      expect(await engine.noteMutationHealth(scope(), outage, null)).toBe("counted");
      expect((await control()).paused).toBe(false);
    });
  });
});
