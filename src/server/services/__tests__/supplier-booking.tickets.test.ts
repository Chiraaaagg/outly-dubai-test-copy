import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { assertDisposableDb, assertDisposableDbLive } from "../../__tests__/helpers/target-guard";
import { setKeyRingsForTests } from "../../lib/crypto";
import { uuidv7 } from "../../lib/ids";
import { IssuedTicketSet, type DocumentSource, type IssuedTicket, type TicketEvidence, type TicketReadOutcome } from "../../documents/contracts";
import { MemoryDocumentStore } from "../../documents/memory-store";
import { runBookingTick } from "../../jobs/booking-tick";
import type { PdfFetchOutcome } from "../../documents/contracts";
import type { AttemptRequest, MutationOutcome, PaymentEvidencePort, ReadOutcome, SupplierBookingAdapter, SupplierRef, SupplierSnapshot } from "../../suppliers/booking-port";
import type { CreateIntentInput, EngineDeps } from "../supplier-booking.service";

/**
 * The engine's ticket hook (doc 22 §23 B4; TKT-1, F47) against the LOCAL
 * database, with a fake booking adapter and a fake document source (no
 * TravelDesk, no network). Codes are synthetic strings. Rows live under a
 * run-scoped supplier code (zz-tk-<run>); bookings, documents and events stay
 * (events are append-only), jobs are removed.
 *
 * The target guard refuses anything but the disposable test database.
 */

vi.mock("../notification.service", () => ({ notificationService: { onTicketsReady: vi.fn(async () => null) } }));

const enabled = Boolean(process.env.DATABASE_URL);
const RUN = uuidv7().slice(-8);
const CODE = `zz-tk-${RUN}`;
const OFFER = 778_001;

function ticket(i: number, ticketFor: IssuedTicket["ticketFor"], code: string): IssuedTicket {
  return { unitIndex: i, ticketFor, ticketTypeId: "11", ticketTypeName: "Admission", displayType: 1, code, validUntil: null };
}

/**
 * A booking supplier that answers from memory. `confirmTickets` is what the
 * confirm answer carries beside the snapshot (the codec's `tickets`).
 */
class FakeBookingAdapter implements SupplierBookingAdapter {
  readonly supplierCode = CODE;
  readonly environment = "test" as const;
  calls: string[] = [];
  confirmTickets: TicketEvidence | undefined = undefined;
  createTickets: TicketEvidence | undefined = undefined;
  snapshots = new Map<string, SupplierSnapshot>();
  private seq = 90_000 + Math.floor(Math.random() * 1000);

  constructor(private readonly clock: () => Date) {}

  capabilities() {
    return { holds: { minutes: 15 }, oneStep: true, clientRefLookup: "exact" as const, notFoundFinalAfterMs: null, readIssuesTickets: "unknown" as const, cancel: "full" as const, documents: "codes" as const };
  }

  async account() {
    return { accountId: "default" };
  }

  async funds() {
    return { spendableMinor: 10_000_000n, currency: "AED" as const, accountId: "default" };
  }

  private make(a: AttemptRequest, status: "ON_HOLD" | "CONFIRMED"): SupplierSnapshot {
    const e = a.expected;
    const s: SupplierSnapshot = {
      ref: String(this.seq++),
      status,
      rawStatus: status === "ON_HOLD" ? 7 : 1,
      bookingReference: a.clientRef,
      offerExternalId: e.offerExternalId,
      tourExternalId: e.tourExternalId,
      serviceDate: e.serviceDate,
      timeSlotId: e.timeSlotId,
      startMinutes: e.startMinutes,
      adults: e.adults,
      children: e.children,
      infants: e.infants,
      chargedNetMinor: e.expectedNetMinor,
      externalInProgress: false,
      externalFailed: false,
      holdExpiresAtUtc: status === "ON_HOLD" ? new Date(this.clock().getTime() + 15 * 60_000).toISOString() : null,
      ticketsIssued: status === "CONFIRMED" ? true : null,
    };
    this.snapshots.set(s.ref, s);
    return s;
  }

  async hold(a: AttemptRequest): Promise<MutationOutcome> {
    this.calls.push("hold");
    return { kind: "accepted", snapshot: this.make(a, "ON_HOLD") };
  }

  async book(a: AttemptRequest): Promise<MutationOutcome> {
    this.calls.push("book");
    return { kind: "accepted", snapshot: this.make(a, "CONFIRMED"), tickets: this.createTickets };
  }

  /** When set, the confirm goes through at the supplier but its answer is lost (outcome unknown; recovery reads it). */
  loseConfirmAnswer = false;

  async confirm(ref: SupplierRef): Promise<MutationOutcome> {
    this.calls.push("confirm");
    const held = this.snapshots.get(ref.supplierBookingId)!;
    const s: SupplierSnapshot = { ...held, status: "CONFIRMED", rawStatus: 1, holdExpiresAtUtc: null, ticketsIssued: true };
    this.snapshots.set(s.ref, s);
    if (this.loseConfirmAnswer) return { kind: "unknown", sent: true, reason: "timeout" };
    return { kind: "accepted", snapshot: s, tickets: this.confirmTickets };
  }

  async cancel(): Promise<MutationOutcome> {
    return { kind: "unknown", sent: false, reason: "not_in_test" };
  }

  async readStatus(ref: SupplierRef): Promise<ReadOutcome> {
    this.calls.push("readStatus");
    const s = this.snapshots.get(ref.supplierBookingId);
    return s ? { kind: "found", snapshot: s } : { kind: "not_found" };
  }

  async findByClientRef(clientRef: string) {
    return { matches: [...this.snapshots.values()].filter((s) => s.bookingReference === clientRef), complete: true };
  }
}

class FakeDocumentSource implements DocumentSource {
  readonly supplierCode = CODE;
  documentReadIssuesTickets: "yes" | "no" | "unknown" = "unknown";
  reads: string[] = [];
  answer: ((id: string) => TicketReadOutcome) | null = null;
  async readTickets(id: string): Promise<TicketReadOutcome> {
    this.reads.push(id);
    return this.answer ? this.answer(id) : { kind: "not_found" };
  }
  async fetchTicketsPdf() {
    return { kind: "not_ready" as const };
  }
  voucherFetches: string[] = [];
  voucher: (() => PdfFetchOutcome) | null = null;
  async fetchVoucherPdf(id: string) {
    this.voucherFetches.push(id);
    return this.voucher ? this.voucher() : { kind: "not_ready" as const };
  }
}

function pdfBytes(): Uint8Array {
  return Buffer.from(
    "%PDF-1.7\n1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n2 0 obj\n<< /Type /Pages /Kids [] /Count 0 >>\nendobj\ntrailer\n<< /Root 1 0 R >>\n%%EOF\n",
    "latin1",
  );
}

describe.skipIf(!enabled)("engine ticket hook (local DB, fake adapter)", () => {
  let prisma: typeof import("../../lib/db").prisma;
  let svc: typeof import("../supplier-booking.service").supplierBookingService;
  let docs: typeof import("../document.service").documentService;
  let logger: typeof import("../../lib/logger").log;
  let supplierId: string;
  let clock = Date.parse("2030-02-03T06:00:00Z");
  const now = () => new Date(clock);
  let n = 0;
  let logged: string[] = [];

  const paid = new Set<string>();
  const payments: PaymentEvidencePort = {
    async capturedFor(orderItemId) {
      if (!paid.has(orderItemId)) return null;
      return { orderItemId, paymentId: uuidv7(), provider: "test", providerPaymentId: "pay_test", currency: "AED", capturedMinor: 30_000n, verifiedAt: now() };
    },
  };

  function base() {
    n++;
    return {
      environment: "test" as const,
      idempotencyKey: `tk-${RUN}-${n}`,
      bookingKind: "live_book" as const,
      tourId: 1,
      offerId: OFFER,
      serviceDate: "2030-02-20",
      slot: { timeSlotId: 9, startMinutes: 600, endMinutes: 700 },
      adults: 2,
      children: 1,
      guestName: "OUTLY Ticket Test",
      expectedNetMinor: 24000n,
      expectedNetUsdMinor: 6600n,
    };
  }

  function deps(adapter: FakeBookingAdapter, over: Partial<EngineDeps> = {}): EngineDeps {
    return { adapter, environment: "test", supplierCode: CODE, mutationTimeoutMs: 1_000, now, payments, ...over };
  }

  async function orderItem() {
    const tag = `zz-tk-${RUN}-${++n}`;
    const guest = await prisma.guest.create({ data: { id: uuidv7(), phoneE164: "+910000000000", fullName: "test-tickets" } });
    const combo = await prisma.combo.create({ data: { id: uuidv7(), slug: tag, name: "test-tickets", confirmation: "manual" } });
    const order = await prisma.order.create({
      data: { id: uuidv7(), reference: `OUT-TEST${Math.floor(Math.random() * 1e9)}`, rail: "assisted", guestId: guest.id, currency: "INR", subtotalInr: 1000n, subtotalAed: 45n, totalInr: 1000n, totalAed: 45n, leadName: "test-tickets", leadPhone: "+910000000000" },
    });
    const item = await prisma.orderItem.create({
      data: {
        id: uuidv7(),
        orderId: order.id,
        comboId: combo.id,
        titleSnapshot: "test-tickets",
        tierSnapshot: "C",
        slugSnapshot: tag,
        kindSnapshot: "combo",
        confirmationSnapshot: "manual",
        fulfilmentModeSnapshot: "inquiry",
        fulfilmentOrigin: "instant_checkout",
        freeCancellationHoursSnapshot: 24,
        durationMinutesSnapshot: 60,
        serviceDate: new Date("2030-02-20"),
        pax: { adult: 2, child: 1, infant: 0 },
        unitInr: 1000n,
        unitAed: 45n,
        totalInr: 1000n,
        totalAed: 45n,
      },
    });
    return { orderId: order.id, orderItemId: item.id };
  }

  /** Reserve, then confirm on captured payment: the confirm answer carries `adapter.confirmTickets`. */
  async function confirmOrderBooking(adapter: FakeBookingAdapter) {
    const ids = await orderItem();
    const b = await svc.createIntent(null, { ...base(), ...ids, fulfilmentOrigin: "instant_checkout", quoteId: null } as CreateIntentInput, { supplierCode: CODE, now });
    await svc.runDueJobs(deps(adapter), { budgetMs: 60_000 });
    expect((await prisma.supplierBooking.findUniqueOrThrow({ where: { id: b.id } })).state).toBe("awaiting_payment");
    paid.add(ids.orderItemId);
    expect(await svc.confirmIfPaid(b.id, { payments, now })).toBe("confirm_queued");
    await svc.runDueJobs(deps(adapter), { budgetMs: 60_000 });
    return { ...ids, booking: await prisma.supplierBooking.findUniqueOrThrow({ where: { id: b.id } }) };
  }

  async function codesDocs(bookingId: string) {
    return prisma.supplierDocument.findMany({ where: { supplierBookingId: bookingId, kind: "ticket_codes" }, orderBy: { version: "asc" }, include: { codes: { orderBy: { unitIndex: "asc" } } } });
  }

  function expectNoCodeAnywhere(text: string, codes: string[]) {
    for (const c of codes) expect(text).not.toContain(c);
  }

  beforeAll(async () => {
    assertDisposableDb();
    ({ prisma } = await import("../../lib/db"));
    await assertDisposableDbLive(prisma);
    svc = (await import("../supplier-booking.service")).supplierBookingService;
    docs = (await import("../document.service")).documentService;
    logger = (await import("../../lib/logger")).log;
    supplierId = uuidv7();
    await prisma.supplier.create({ data: { id: supplierId, code: CODE, name: "Tickets (engine test)", source: "api", adapter: "traveldesk" } });
  });

  beforeEach(() => {
    logged = [];
    for (const level of ["info", "warn", "error"] as const) {
      vi.spyOn(logger, level).mockImplementation((...args: unknown[]) => {
        logged.push(JSON.stringify(args, (_k, v) => (typeof v === "bigint" ? v.toString() : v)));
      });
    }
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    setKeyRingsForTests(null);
    if (!prisma) return;
    const ids = (await prisma.supplierBooking.findMany({ where: { supplierId }, select: { id: true } })).map((b) => b.id);
    await prisma.supplierJob.deleteMany({ where: { supplierBookingId: { in: ids } } });
    await prisma.supplierAccountLease.deleteMany({ where: { supplierId } });
    clock += 60 * 60_000;
  });

  afterAll(async () => {
    if (!prisma) return;
    // Order items go back to the column default (the B1 migration test checks kept rows).
    await prisma.orderItem.updateMany({ where: { slugSnapshot: { startsWith: `zz-tk-${RUN}-` } }, data: { fulfilmentOrigin: "assisted_conversion" } });
    await prisma.$disconnect();
  });

  it("codes in the confirm answer persist encrypted in the confirming transaction; no code reaches lastResponse, events or logs (TKT-1)", async () => {
    const adapter = new FakeBookingAdapter(now);
    const codes = [`TK-${RUN}-A1`, `TK-${RUN}-A2`, `TK-${RUN}-C1`];
    adapter.confirmTickets = { kind: "issued", set: new IssuedTicketSet([ticket(0, "adult", codes[0]), ticket(1, "adult", codes[1]), ticket(2, "child", codes[2])], "confirm_response") };
    const { booking } = await confirmOrderBooking(adapter);
    expect(booking.state).toBe("confirmed");
    expect(adapter.calls).toEqual(["hold", "confirm"]);

    const [doc] = await codesDocs(booking.id);
    expect(doc).toMatchObject({ status: "valid", version: 1, source: "confirm_response", issuedEvidence: "confirm_response", unitsExpected: { adult: 2, child: 1, infant: 0 } });
    expect(doc.codes).toHaveLength(3);
    for (const [i, c] of doc.codes.entries()) {
      expect(c.codeCiphertext).toMatch(/^v2\.ticket_codes\./);
      expect(c.codeCiphertext).not.toContain(codes[i]);
      expect(c.codeCiphertext.startsWith(`v2.ticket_codes.${c.codeKeyId}.`)).toBe(true);
      expect(c.codeHash).toMatch(/^[0-9a-f]{64}$/);
    }
    // Same transaction: the document, its codes and the confirming state change were written by one transaction id.
    const confirmed = await prisma.supplierBookingEvent.findFirstOrThrow({ where: { supplierBookingId: booking.id, kind: "state_change", toState: "confirmed" } });
    const [xDoc] = await prisma.$queryRaw<{ x: string }[]>`SELECT xmin::text AS x FROM supplier_documents WHERE id = ${doc.id}::uuid`;
    const xCodes = await prisma.$queryRaw<{ x: string }[]>`SELECT DISTINCT xmin::text AS x FROM supplier_ticket_codes WHERE document_id = ${doc.id}::uuid`;
    const [xEvent] = await prisma.$queryRaw<{ x: string }[]>`SELECT xmin::text AS x FROM supplier_booking_events WHERE id = ${confirmed.id}::uuid`;
    expect(xCodes).toEqual([xDoc]);
    expect(xDoc.x).toBe(xEvent.x);
    // The PDF download follows automatically: a live booking's document is its voucher, which includes the tickets.
    expect(await prisma.supplierDocument.count({ where: { supplierBookingId: booking.id, kind: "voucher_pdf", status: "pending" } })).toBe(1);
    expect(await prisma.supplierDocument.count({ where: { supplierBookingId: booking.id, kind: "tickets_pdf" } })).toBe(0);

    const events = await prisma.supplierBookingEvent.findMany({ where: { supplierBookingId: booking.id } });
    expectNoCodeAnywhere(JSON.stringify(booking.lastResponse), codes);
    expect(Object.keys(booking.lastResponse as Record<string, unknown>)).not.toContain("tickets");
    expectNoCodeAnywhere(JSON.stringify(events.map((e) => e.detail)), codes);
    expectNoCodeAnywhere(logged.join("\n"), codes);
    expect(logged.join("\n")).toContain("tickets.persisted");
  });

  it("a failed persist rolls back with nothing half-written; the booking is confirmed and ticket-pending, and the job's read persists the codes (F47)", async () => {
    const adapter = new FakeBookingAdapter(now);
    const codes = [`TK-${RUN}-X1`, `TK-${RUN}-X2`, `TK-${RUN}-X3`];
    const set = new IssuedTicketSet([ticket(0, "adult", codes[0]), ticket(1, "adult", codes[1]), ticket(2, "child", codes[2])], "confirm_response");
    adapter.confirmTickets = { kind: "issued", set };
    setKeyRingsForTests({ ticket_codes: null }); // the codes key is unavailable: persist throws
    const { booking } = await confirmOrderBooking(adapter);
    setKeyRingsForTests(null);

    expect(booking.state).toBe("confirmed");
    const confirms = await prisma.supplierBookingEvent.count({ where: { supplierBookingId: booking.id, kind: "state_change", toState: "confirmed" } });
    expect(confirms).toBe(1);
    const [pending] = await codesDocs(booking.id);
    expect(pending).toMatchObject({ status: "pending", issuedEvidence: "confirm_response", attentionRequiredAt: null });
    expect(pending.codes).toEqual([]);
    expect(pending.nextFetchAt).not.toBeNull(); // automatic: issuance is evidenced
    expect(logged.join("\n")).toContain("tickets.persist_failed");

    // The document job reads once and keeps the codes.
    const source = new FakeDocumentSource();
    source.answer = (id) => ({
      kind: "found",
      identity: { supplierBookingId: id, bookingReference: booking.clientRef, serviceDate: "2030-02-20", offerExternalId: booking.offerExternalId },
      evidence: { kind: "issued", set: new IssuedTicketSet(set.tickets(), "document_read") },
    });
    const r = await docs.runDue({ source, store: null, now }, { budgetMs: 30_000, max: 10 });
    expect(source.reads).toEqual([booking.supplierBookingId]);
    expect(r.processed).toEqual([{ documentId: pending.id, kind: "ticket_codes", outcome: "persisted" }]);
    const [filled] = await codesDocs(booking.id);
    expect(filled).toMatchObject({ id: pending.id, status: "valid", source: "document_read" });
    expect(filled.codes).toHaveLength(3);
    expectNoCodeAnywhere(logged.join("\n"), codes);
  });

  it("malformed ticket data confirms the booking and leaves an automatic pending read", async () => {
    const adapter = new FakeBookingAdapter(now);
    adapter.confirmTickets = { kind: "malformed", source: "confirm_response", reason: "bad_shape" };
    const { booking } = await confirmOrderBooking(adapter);
    expect(booking.state).toBe("confirmed");
    const [pending] = await codesDocs(booking.id);
    expect(pending).toMatchObject({ status: "pending", issuedEvidence: "confirm_response" });
    expect(pending.nextFetchAt).not.toBeNull();
  });

  it("a live booking confirmed without codes waits for its voucher only: no codes row, no staff read, no document read (doc 22 §32.32, SUP-4)", async () => {
    const adapter = new FakeBookingAdapter(now);
    adapter.confirmTickets = { kind: "none" };
    const { booking } = await confirmOrderBooking(adapter);
    expect(await codesDocs(booking.id)).toEqual([]);
    const vouchers = await prisma.supplierDocument.findMany({ where: { supplierBookingId: booking.id, kind: "voucher_pdf" } });
    expect(vouchers.map((d) => d.status)).toEqual(["pending"]);
    expect(logged.join("\n")).not.toContain("ticket_read_needs_staff");

    const source = new FakeDocumentSource();
    clock += 10 * 60_000;
    await docs.runDue({ source, store: null, now }, { budgetMs: 30_000, max: 10 });
    expect(source.reads).not.toContain(booking.supplierBookingId);
    // The engine never used a document read either.
    expect(adapter.calls).not.toContain("readStatus");
  });

  it("an adapter that does not parse tickets is treated as no codes: the live booking waits for its voucher", async () => {
    const adapter = new FakeBookingAdapter(now);
    const { booking } = await confirmOrderBooking(adapter);
    expect(await codesDocs(booking.id)).toEqual([]);
    expect(await prisma.supplierDocument.count({ where: { supplierBookingId: booking.id, kind: "voucher_pdf", status: "pending" } })).toBe(1);
  });

  /* -------------------------------------------------------------------------
   * Documents right after a confirm (checkout redesign batch 4, CO-40)
   * ---------------------------------------------------------------------- */

  /** Reserve, then confirm on captured payment, with `afterConfirmed` on both runs. */
  async function confirmWithHook(adapter: FakeBookingAdapter, afterConfirmed: EngineDeps["afterConfirmed"], budgetMs = 120_000) {
    const ids = await orderItem();
    const b = await svc.createIntent(null, { ...base(), ...ids, fulfilmentOrigin: "instant_checkout", quoteId: null } as CreateIntentInput, { supplierCode: CODE, now });
    await svc.runDueJobs(deps(adapter, { afterConfirmed }), { budgetMs: 120_000 });
    paid.add(ids.orderItemId);
    expect(await svc.confirmIfPaid(b.id, { payments, now })).toBe("confirm_queued");
    const run = await svc.runDueJobs(deps(adapter, { afterConfirmed }), { budgetMs });
    return { ...ids, run, booking: await prisma.supplierBooking.findUniqueOrThrow({ where: { id: b.id } }) };
  }

  it("CO-40: the hook runs once per confirmed order-item booking, after the confirm committed, its job finished and its lease was released; a hook failure changes nothing", async () => {
    const adapter = new FakeBookingAdapter(now);
    adapter.confirmTickets = { kind: "none" };
    const { mutationInFlight } = await import("../supplier-booking.service");
    const seen: Array<{ state: string; leaseHeld: boolean; confirmJob: string | undefined }> = [];
    const hook = vi.fn(async (b: { id: string; supplierId: string; environment: "test" | "production"; accountId: string }) => {
      // Read on its own connection: only a committed confirm is visible here.
      const row = await prisma.supplierBooking.findUniqueOrThrow({ where: { id: b.id } });
      const job = await prisma.supplierJob.findFirst({ where: { supplierBookingId: b.id, kind: "confirm" }, orderBy: { createdAt: "desc" } });
      seen.push({ state: row.state, leaseHeld: await mutationInFlight(b.supplierId, b.environment, { accountId: b.accountId }), confirmJob: job?.status });
      throw new Error("synthetic hook failure");
    });
    const { booking, run } = await confirmWithHook(adapter, hook as never);
    expect(hook).toHaveBeenCalledTimes(1);
    expect((hook.mock.calls[0][0] as { id: string }).id).toBe(booking.id);
    expect(seen).toEqual([{ state: "confirmed", leaseHeld: false, confirmJob: "succeeded" }]);
    // The failure is reported and swallowed: the booking stays confirmed, the job succeeded, the voucher waits for the tick.
    expect(booking.state).toBe("confirmed");
    expect(run.processed.find((p) => p.kind === "confirm")?.outcome).not.toMatch(/^failed/);
    expect(await prisma.supplierDocument.count({ where: { supplierBookingId: booking.id, kind: "voucher_pdf", status: "pending" } })).toBe(1);
    expect(logged.join("\n")).toMatch(/document\.after_confirm.*failed/);
  });

  it("CO-40: with too little of the run left the hook is skipped (the tick picks the voucher up); a drill confirm never reaches it", async () => {
    const adapter = new FakeBookingAdapter(now);
    adapter.confirmTickets = { kind: "none" };
    const hook = vi.fn(async () => ({ claimed: 0 }));
    // 50 s: enough to send the confirm (mutation timeout + 30 s), short of AFTER_CONFIRM_MIN_REMAINING_MS.
    const { booking } = await confirmWithHook(adapter, hook, 50_000);
    expect(booking.state).toBe("confirmed");
    expect(hook).not.toHaveBeenCalled();
    expect(logged.join("\n")).toMatch(/document\.after_confirm.*out_of_time/);
    expect(await prisma.supplierDocument.count({ where: { supplierBookingId: booking.id, kind: "voucher_pdf", status: "pending" } })).toBe(1);

    const drill = await svc.createIntent(null, { ...base(), drill: true, mode: "one_step" } as CreateIntentInput, { supplierCode: CODE, now });
    await svc.runDueJobs(deps(adapter, { afterConfirmed: hook }), { budgetMs: 120_000 });
    expect((await prisma.supplierBooking.findUniqueOrThrow({ where: { id: drill.id } })).state).toBe("confirmed");
    expect(hook).not.toHaveBeenCalled();
  });

  it("CO-40 end to end: the worker run that confirms stores the voucher at once, through the document service; a second trigger is a no-op", async () => {
    const adapter = new FakeBookingAdapter(now);
    adapter.confirmTickets = { kind: "none" };
    const source = new FakeDocumentSource();
    source.voucher = () => ({ kind: "ok", bytes: pdfBytes(), declaredType: "application/pdf" });
    const store = new MemoryDocumentStore();
    const documents = { source, store, now };
    const hook = (b: { id: string }) => docs.runForBooking(documents, b.id, { budgetMs: 20_000, max: 2 });
    const { booking } = await confirmWithHook(adapter, hook);
    expect(source.voucherFetches).toEqual([booking.supplierBookingId]);
    // No booking read follows the confirm call: the immediate step downloads the voucher only.
    expect(source.reads).toEqual([]);
    const vouchers = await prisma.supplierDocument.findMany({ where: { supplierBookingId: booking.id, kind: "voucher_pdf" } });
    expect(vouchers.map((d) => [d.status, d.fetchAttempts])).toEqual([["valid", 1]]);
    expect((await docs.listForOrder(booking.orderId!))[0].fulfilment).toBe("issued");
    // Idempotent: nothing is due any more, so a repeat claims and fetches nothing.
    expect((await hook(booking)).claimed).toBe(0);
    expect(source.voucherFetches).toHaveLength(1);
  });

  it("review fix 2: the voucher step runs after the job loop, so it never delays the next job; each confirmed booking is handed over once", async () => {
    const adapter = new FakeBookingAdapter(now);
    adapter.confirmTickets = { kind: "none" };
    const hook = vi.fn(async (b: { id: string }) => {
      adapter.calls.push(`hook:${b.id}`);
      return { claimed: 0 };
    });
    // Two paid order items, each reserved, then both confirms queued for one worker run.
    const items = [await orderItem(), await orderItem()];
    const bookings = [];
    for (const ids of items) bookings.push(await svc.createIntent(null, { ...base(), ...ids, fulfilmentOrigin: "instant_checkout", quoteId: null } as CreateIntentInput, { supplierCode: CODE, now }));
    await svc.runDueJobs(deps(adapter, { afterConfirmed: hook }), { budgetMs: 120_000 });
    for (const [i, b] of bookings.entries()) {
      paid.add(items[i].orderItemId);
      expect(await svc.confirmIfPaid(b.id, { payments, now })).toBe("confirm_queued");
    }
    adapter.calls = [];
    await svc.runDueJobs(deps(adapter, { afterConfirmed: hook }), { budgetMs: 120_000 });
    // Both confirms first, back to back; only then the voucher step, once per booking.
    expect(adapter.calls.slice(0, 2)).toEqual(["confirm", "confirm"]);
    expect(adapter.calls.slice(2).sort()).toEqual(bookings.map((b) => `hook:${b.id}`).sort());
    expect(hook).toHaveBeenCalledTimes(2);
  });

  it("review fix 5: a booking confirmed by a recovery read (not by our confirm answer) is left to the documents tick", async () => {
    const adapter = new FakeBookingAdapter(now);
    adapter.confirmTickets = { kind: "none" };
    adapter.loseConfirmAnswer = true;
    const hook = vi.fn(async () => ({ claimed: 0 }));
    const { booking } = await confirmWithHook(adapter, hook);
    expect(booking.state).toBe("outcome_unknown");
    // Recovery reads the booking later and finds it confirmed.
    clock += 10 * 60_000;
    await svc.runDueJobs(deps(adapter, { afterConfirmed: hook }), { budgetMs: 120_000 });
    clock += 10 * 60_000;
    await svc.runDueJobs(deps(adapter, { afterConfirmed: hook }), { budgetMs: 120_000 });
    expect((await prisma.supplierBooking.findUniqueOrThrow({ where: { id: booking.id } })).state).toBe("confirmed");
    expect(hook).not.toHaveBeenCalled();
    expect(await prisma.supplierDocument.count({ where: { supplierBookingId: booking.id, kind: "voucher_pdf", status: "pending" } })).toBe(1);
  });

  it("review fix 1: the mutation window follows mutationBudgetMs from the run's own start, not the loop budget; without it a short budget stays read-only", async () => {
    const adapter = new FakeBookingAdapter(now);
    // Loop budget 20 s: below the mutation timeout (1 s here) + 30 s, so on its own no mutation may start.
    const shortRun = async () => {
      const ids = await orderItem();
      const b = await svc.createIntent(null, { ...base(), ...ids, fulfilmentOrigin: "instant_checkout", quoteId: null } as CreateIntentInput, { supplierCode: CODE, now });
      return b;
    };
    const a = await shortRun();
    await svc.runDueJobs(deps(adapter), { budgetMs: 20_000 });
    expect(adapter.calls).toEqual([]);
    expect((await prisma.supplierBooking.findUniqueOrThrow({ where: { id: a.id } })).state).toBe("queued");
    // The booking tick's case: the payments step used part of the run, but the worker's window is measured from its own start.
    await svc.runDueJobs(deps(adapter), { budgetMs: 20_000, mutationBudgetMs: 60_000 });
    expect(adapter.calls).toEqual(["hold"]);
    expect((await prisma.supplierBooking.findUniqueOrThrow({ where: { id: a.id } })).state).toBe("awaiting_payment");
  });

  it("two booking ticks at once: the job claim and the account lease hold, one reserve is sent", async () => {
    const adapter = new FakeBookingAdapter(now);
    const ids = await orderItem();
    const b = await svc.createIntent(null, { ...base(), ...ids, fulfilmentOrigin: "instant_checkout", quoteId: null } as CreateIntentInput, { supplierCode: CODE, now });
    const tick = () =>
      runBookingTick(
        { payments: async () => ({}), supplier: (budget) => svc.runDueJobs(deps(adapter), budget) },
        { budgetMs: 120_000, mutationWindowMs: 120_000, killMs: 150_000, paymentsCapMs: 45_000, mutationEndBeforeKillMs: 15_000, mutationStartMarginMs: 30_000 },
      );
    const [one, two] = await Promise.all([tick(), tick()]);
    expect(one.ok && two.ok).toBe(true);
    expect(adapter.calls.filter((c) => c === "hold")).toHaveLength(1);
    expect((await prisma.supplierBooking.findUniqueOrThrow({ where: { id: b.id } })).state).toBe("awaiting_payment");
    expect(await prisma.supplierBookingEvent.count({ where: { supplierBookingId: b.id, kind: "request_sent" } })).toBe(1);
  });

  it("a drill booking with codes gets no document rows", async () => {
    const adapter = new FakeBookingAdapter(now);
    adapter.createTickets = { kind: "issued", set: new IssuedTicketSet([ticket(0, "adult", `TK-${RUN}-D1`), ticket(1, "adult", `TK-${RUN}-D2`), ticket(2, "child", `TK-${RUN}-D3`)], "create_response") };
    const b = await svc.createIntent(null, { ...base(), drill: true, mode: "one_step" } as CreateIntentInput, { supplierCode: CODE, now });
    await svc.runDueJobs(deps(adapter), { budgetMs: 60_000 });
    const done = await prisma.supplierBooking.findUniqueOrThrow({ where: { id: b.id } });
    expect(done.state).toBe("confirmed");
    expect(adapter.calls).toEqual(["book"]);
    expect(await prisma.supplierDocument.count({ where: { supplierBookingId: b.id } })).toBe(0);
    expect(await prisma.supplierTicketCode.count({ where: { supplierBookingId: b.id } })).toBe(0);
    expectNoCodeAnywhere(JSON.stringify(done.lastResponse), [`TK-${RUN}-D1`]);
  });
});
