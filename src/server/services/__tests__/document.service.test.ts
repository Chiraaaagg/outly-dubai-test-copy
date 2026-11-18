import { randomBytes } from "node:crypto";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { assertDisposableDb, assertDisposableDbLive } from "../../__tests__/helpers/target-guard";
import type { Actor } from "../../lib/actor";
import { isAppError } from "../../lib/errors";
import { uuidv7 } from "../../lib/ids";
import { IssuedTicketSet, OBJECT_KEY, type DocumentSource, type IssuedTicket, type PdfFetchOutcome, type TicketReadOutcome } from "../../documents/contracts";
import { MemoryDocumentStore } from "../../documents/memory-store";
import type { DocumentDeps } from "../document.service";

/**
 * Document service against the LOCAL database (doc 22 §23 B4; TKT-1, TKT-2,
 * TKT-3, SUP-4, SEC-13; F12, F13, F36, F47, F48), with a fake document source
 * and the in-memory store. Codes and PDFs are synthetic. Rows live under a
 * run-scoped supplier code (zz-doc-<run>); bookings and documents are kept
 * (purge-test-rows keeps the supplier while it has bookings), and waiting
 * document rows are retired after each test so a later test's job run never
 * reads them.
 *
 * The target guard refuses anything but the disposable test database.
 */

vi.mock("../notification.service", () => ({ notificationService: { onTicketsReady: vi.fn(async () => null) } }));

const enabled = Boolean(process.env.DATABASE_URL);
const RUN = uuidv7().slice(-8);
const CODE = `zz-doc-${RUN}`;
const OFFER = "779001";
const SERVICE_DATE = "2030-03-20";

function pdfBytes(catalogExtra = "", head = "%PDF-1.7\n"): Uint8Array {
  return Buffer.from(
    `${head}1 0 obj\n<< /Type /Catalog /Pages 2 0 R ${catalogExtra}>>\nendobj\n2 0 obj\n<< /Type /Pages /Kids [] /Count 0 >>\nendobj\ntrailer\n<< /Root 1 0 R >>\n%%EOF\n`,
    "latin1",
  );
}

function t(i: number, ticketFor: IssuedTicket["ticketFor"], code: string): IssuedTicket {
  return { unitIndex: i, ticketFor, ticketTypeId: null, ticketTypeName: null, displayType: null, code, validUntil: "2030-03-21T00:00:00Z" };
}

/** Scripted supplier document endpoints, per supplier booking id. Defaults: not found, not ready. */
class FakeSource implements DocumentSource {
  readonly supplierCode = CODE;
  documentReadIssuesTickets: "yes" | "no" | "unknown" = "unknown";
  reads: string[] = [];
  pdfFetches: string[] = [];
  voucherFetches: string[] = [];
  tickets = new Map<string, () => TicketReadOutcome>();
  pdfs = new Map<string, () => PdfFetchOutcome>();
  vouchers = new Map<string, () => PdfFetchOutcome>();
  /** Runs inside each PDF fetch, while the row is claimed. */
  duringPdfFetch: (() => Promise<void>) | null = null;
  async readTickets(id: string) {
    this.reads.push(id);
    return this.tickets.get(id)?.() ?? { kind: "not_found" as const };
  }
  async fetchTicketsPdf(id: string, opts: { maxBytes: number }) {
    this.pdfFetches.push(id);
    expect(opts.maxBytes).toBe(10 * 1024 * 1024);
    await this.duringPdfFetch?.();
    return this.pdfs.get(id)?.() ?? { kind: "not_ready" as const };
  }
  async fetchVoucherPdf(id: string, opts: { maxBytes: number }) {
    this.voucherFetches.push(id);
    expect(opts.maxBytes).toBe(10 * 1024 * 1024);
    await this.duringPdfFetch?.();
    return this.vouchers.get(id)?.() ?? { kind: "not_ready" as const };
  }
}

describe.skipIf(!enabled)("documentService (local DB, fake source, memory store)", () => {
  let prisma: typeof import("../../lib/db").prisma;
  let svc: typeof import("../document.service").documentService;
  let mod: typeof import("../document.service");
  let storeMod: typeof import("../../documents/store");
  let logger: typeof import("../../lib/logger").log;
  let notifyMock: ReturnType<typeof vi.fn>;
  let supplierId: string;
  let clock = Date.parse("2030-03-01T06:00:00Z");
  const now = () => new Date(clock);
  let n = 0;
  let seq = 70_000 + Math.floor(Math.random() * 1000);
  let logged: string[] = [];
  let store: MemoryDocumentStore;
  let source: FakeSource;
  const notify = vi.fn(async () => null);

  function deps(over: Partial<DocumentDeps> = {}): DocumentDeps {
    return { source, store, now, notifyTicketsReady: notify, ...over };
  }

  async function orderItem() {
    const tag = `zz-doc-${RUN}-${++n}`;
    const guest = await prisma.guest.create({ data: { id: uuidv7(), phoneE164: "+910000000000", fullName: "test-docs" } });
    const combo = await prisma.combo.create({ data: { id: uuidv7(), slug: tag, name: "test-docs", confirmation: "manual" } });
    const order = await prisma.order.create({
      data: { id: uuidv7(), reference: `OUT-TEST${Math.floor(Math.random() * 1e9)}`, rail: "assisted", guestId: guest.id, currency: "INR", subtotalInr: 1000n, subtotalAed: 45n, totalInr: 1000n, totalAed: 45n, leadName: "test-docs", leadPhone: "+910000000000" },
    });
    const item = await prisma.orderItem.create({
      data: {
        id: uuidv7(),
        orderId: order.id,
        comboId: combo.id,
        titleSnapshot: "test-docs",
        tierSnapshot: "C",
        slugSnapshot: tag,
        kindSnapshot: "combo",
        confirmationSnapshot: "manual",
        fulfilmentModeSnapshot: "inquiry",
        freeCancellationHoursSnapshot: 24,
        durationMinutesSnapshot: 60,
        serviceDate: new Date(SERVICE_DATE),
        pax: { adult: 2 },
        unitInr: 1000n,
        unitAed: 45n,
        totalInr: 1000n,
        totalAed: 45n,
      },
    });
    return { orderId: order.id, orderItemId: item.id };
  }

  /** A confirmed order-item booking, written directly (the engine is covered by its own suite). */
  /** `kind` defaults to ticket_only, the tickets-PDF path; live bookings take the voucher path. */
  async function confirmed(opts: { adults?: number; children?: number; infants?: number; agoMs?: number; serviceDate?: string; startMinutes?: number; kind?: "live_book" | "ticket_only" } = {}) {
    const ids = await orderItem();
    const k = ++n;
    return prisma.supplierBooking.create({
      data: {
        id: uuidv7(),
        ...ids,
        supplierId,
        environment: "test",
        idempotencyKey: `doc-${RUN}-${k}`,
        clientRef: `OUTTD-DOC${RUN.toUpperCase()}${k}`,
        bookingKind: opts.kind ?? "ticket_only",
        afterReserve: "await_payment",
        state: "confirmed",
        tourExternalId: "1",
        offerExternalId: OFFER,
        serviceDate: new Date(opts.serviceDate ?? SERVICE_DATE),
        startMinutes: opts.startMinutes ?? 600,
        adults: opts.adults ?? 2,
        children: opts.children ?? 0,
        infants: opts.infants ?? 0,
        guestName: "test-docs",
        expectedNetMinor: 24000n,
        expectedNetUsdMinor: 6600n,
        supplierBookingId: String(seq++),
        confirmedAt: new Date(clock - (opts.agoMs ?? 0)),
        closedAt: new Date(clock - (opts.agoMs ?? 0)),
      },
    });
  }

  type Booking = Awaited<ReturnType<typeof confirmed>>;

  function identity(b: Booking, over: Record<string, unknown> = {}) {
    return { supplierBookingId: b.supplierBookingId!, bookingReference: b.clientRef, serviceDate: SERVICE_DATE, offerExternalId: OFFER, ...over };
  }

  function answer(b: Booking, tickets: IssuedTicket[], over: Record<string, unknown> = {}) {
    source.tickets.set(b.supplierBookingId!, () => ({ kind: "found", identity: identity(b, over), evidence: { kind: "issued", set: new IssuedTicketSet(tickets, "document_read") } }));
  }

  async function persist(b: Booking, tickets: IssuedTicket[], source: "confirm_response" | "document_read" = "confirm_response") {
    const r = await prisma.$transaction((tx) => svc.persistIssuedTickets(tx, b, new IssuedTicketSet(tickets, source), now()));
    mod.reportPersisted(b.id, r);
    return r;
  }

  async function docsOf(b: Booking, kind?: string) {
    return prisma.supplierDocument.findMany({ where: { supplierBookingId: b.id, ...(kind ? { kind } : {}) }, orderBy: [{ kind: "asc" }, { version: "asc" }], include: { codes: true } });
  }

  async function run(over: Partial<DocumentDeps> = {}) {
    return svc.runDue(deps(over), { budgetMs: 30_000, max: 50 });
  }

  function staff(permissions: string[]): Actor {
    return { type: "admin", roles: ["ops"], permissions: new Set(permissions) };
  }

  function codeOf(e: unknown) {
    return isAppError(e) ? e.code : String(e);
  }

  beforeAll(async () => {
    assertDisposableDb();
    ({ prisma } = await import("../../lib/db"));
    await assertDisposableDbLive(prisma);
    mod = await import("../document.service");
    svc = mod.documentService;
    storeMod = await import("../../documents/store");
    logger = (await import("../../lib/logger")).log;
    notifyMock = (await import("../notification.service")).notificationService.onTicketsReady as unknown as ReturnType<typeof vi.fn>;
    supplierId = uuidv7();
    await prisma.supplier.create({ data: { id: supplierId, code: CODE, name: "Documents (test)", source: "api", adapter: "traveldesk" } });
  });

  beforeEach(() => {
    store = new MemoryDocumentStore();
    storeMod.setDocumentStoreForTests(store);
    source = new FakeSource();
    notify.mockClear();
    logged = [];
    for (const level of ["info", "warn", "error"] as const) {
      vi.spyOn(logger, level).mockImplementation((...args: unknown[]) => {
        logged.push(JSON.stringify(args));
      });
    }
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    storeMod.setDocumentStoreForTests(undefined);
    if (!prisma) return;
    // Retire whatever this test left waiting, so a later job run never reads it.
    await prisma.supplierDocument.updateMany({ where: { supplierBooking: { supplierId }, status: { in: ["pending", "incomplete"] } }, data: { status: "failed", nextFetchAt: null, lockedUntil: null } });
    clock += 24 * 60 * 60_000;
  });

  afterAll(async () => {
    await prisma?.$disconnect();
  });

  /* -------------------------------------------------------------------------
   * Persisting codes (TKT-1, TKT-2)
   * ---------------------------------------------------------------------- */

  it("persists codes encrypted, treats an identical re-delivery as no change, and a reissue invalidates the old codes and PDF", async () => {
    const b = await confirmed();
    const first = [t(0, "adult", `C-${RUN}-1`), t(1, "adult", `C-${RUN}-2`)];
    const r1 = await persist(b, first);
    expect(r1).toMatchObject({ status: "valid", version: 1 });
    const [codes] = await docsOf(b, "ticket_codes");
    expect(codes.codes.map((c) => c.codeCiphertext).join()).not.toContain(`C-${RUN}`);
    expect(codes.codes.every((c) => c.codeCiphertext.startsWith(`v2.ticket_codes.${c.codeKeyId}.`))).toBe(true);
    expect(codes.codes[0].validUntil?.toISOString()).toBe("2030-03-21T00:00:00.000Z");

    // Same codes in another order, from a document read: nothing new.
    const again = await persist(b, [first[1], first[0]], "document_read");
    expect(again).toMatchObject({ documentId: r1.documentId, version: 1, status: "valid", unchanged: true });
    expect(await prisma.supplierDocument.count({ where: { supplierBookingId: b.id, kind: "ticket_codes" } })).toBe(1);

    // The PDF download was queued by the valid set; store it.
    const [pdfPending] = await docsOf(b, "tickets_pdf");
    expect(pdfPending).toMatchObject({ status: "pending", version: 1 });
    source.pdfs.set(b.supplierBookingId!, () => ({ kind: "ok", bytes: pdfBytes(), declaredType: "application/pdf" }));
    await run();
    const pdf1 = await prisma.supplierDocument.findUniqueOrThrow({ where: { id: pdfPending.id } });
    expect(pdf1).toMatchObject({ status: "valid", contentType: "application/pdf", byteSize: pdfBytes().length });
    expect(pdf1.storageKey).toMatch(OBJECT_KEY);
    expect(pdf1.storageKey).toMatch(/^test\/[0-9a-f]{32}$/);
    expect(notify).toHaveBeenCalledWith({ orderId: b.orderId, orderItemId: b.orderItemId, documentVersion: 1 });

    // A reissue: different codes.
    const r2 = await persist(b, [t(0, "adult", `C-${RUN}-3`), t(1, "adult", `C-${RUN}-4`)], "document_read");
    expect(r2).toMatchObject({ status: "valid", version: 2 });
    const all = await docsOf(b);
    const old = all.find((d) => d.id === r1.documentId)!;
    expect(old.status).toBe("superseded");
    expect(old.invalidatedAt).not.toBeNull();
    const oldPdf = all.find((d) => d.id === pdf1.id)!;
    expect(oldPdf.status).toBe("superseded");
    expect(store.has(pdf1.storageKey!)).toBe(true); // kept for retention, never served
    expect(await svc.readServable(pdf1.id, now())).toEqual({ kind: "unavailable", reason: "not_valid" });
    expect(all.filter((d) => d.kind === "tickets_pdf" && d.status === "pending")).toHaveLength(1);
    expect(logged.join("\n")).toContain("document.superseded");
    expect(logged.join("\n")).not.toContain(`C-${RUN}`);
  });

  it("an incomplete unit set is held with attention and refetched; unknown units never count (F48)", async () => {
    const b = await confirmed({ adults: 2, children: 1 });
    const r = await persist(b, [t(0, "adult", `I-${RUN}-1`), t(1, "adult", `I-${RUN}-2`), t(2, "unknown", `I-${RUN}-3`)]);
    expect(r.status).toBe("incomplete");
    const [inc] = await docsOf(b, "ticket_codes");
    expect(inc).toMatchObject({ status: "incomplete", unitsIssued: { adult: 2, child: 0, infant: 0, unknown: 1 }, unitsExpected: { adult: 2, child: 1, infant: 0 } });
    expect(inc.attentionRequiredAt).not.toBeNull();
    expect(inc.nextFetchAt?.getTime()).toBe(clock + 60_000);
    expect(await docsOf(b, "tickets_pdf")).toEqual([]);
    expect((await svc.listForOrder(b.orderId!)).find((i) => i.orderItemId === b.orderItemId)?.fulfilment).toBe("attention");

    // Not yet due: no read.
    answer(b, [t(0, "adult", `I-${RUN}-1`), t(1, "adult", `I-${RUN}-2`), t(2, "child", `I-${RUN}-4`), t(3, "unknown", `I-${RUN}-5`)]);
    await run();
    expect(source.reads).toEqual([]);
    clock += 60_000;
    const res = await run();
    expect(source.reads).toEqual([b.supplierBookingId]);
    expect(res.processed).toContainEqual({ documentId: inc.id, kind: "ticket_codes", outcome: "persisted" });
    const after = await docsOf(b, "ticket_codes");
    expect(after.map((d) => [d.version, d.status])).toEqual([
      [1, "superseded"],
      [2, "valid"],
    ]);
    expect(await prisma.supplierDocument.count({ where: { supplierBookingId: b.id, kind: "tickets_pdf", status: "pending" } })).toBe(1);
  });

  /* -------------------------------------------------------------------------
   * Pending tickets and the deliberate read (F47, SUP-4, Q-T1)
   * ---------------------------------------------------------------------- */

  it("without evidence the read is never automatic: attention at once, then one deliberate staff read, audited without codes", async () => {
    const b = await confirmed();
    const p1 = await svc.markTicketsPending(prisma, b, { reason: "no_codes", evidence: null }, now(), { source });
    expect(p1.automatic).toBe(false);
    const p2 = await svc.markTicketsPending(prisma, b, { reason: "no_codes", evidence: null }, now(), { source });
    expect(p2.documentId).toBe(p1.documentId);
    const [row] = await docsOf(b, "ticket_codes");
    expect(row).toMatchObject({ status: "pending", nextFetchAt: null, issuedEvidence: null });
    expect(row.attentionRequiredAt?.getTime()).toBe(clock);

    clock += 30 * 60_000;
    await run();
    expect(source.reads).toEqual([]);

    answer(b, [t(0, "adult", `D-${RUN}-1`), t(1, "adult", `D-${RUN}-2`)]);
    expect(codeOf(await svc.deliberateRead(staff(["tickets.view"]), b.id, deps()).catch((e) => e))).toBe("FORBIDDEN");
    expect(source.reads).toEqual([]);
    expect(await svc.deliberateRead(staff(["tickets.resend"]), b.id, deps())).toEqual({ outcome: "persisted" });
    expect(source.reads).toEqual([b.supplierBookingId]);
    expect((await docsOf(b, "ticket_codes"))[0]).toMatchObject({ id: p1.documentId, status: "valid" });
    const auditRow = await prisma.auditLog.findFirstOrThrow({ where: { entityId: b.id, action: "tickets.deliberate_read" } });
    expect(auditRow.after).toEqual({ documentId: p1.documentId, outcome: "persisted" });
    expect(JSON.stringify(auditRow, (_k, v) => (typeof v === "bigint" ? v.toString() : v))).not.toContain(`D-${RUN}`);
  });

  it("evidence, the offer's Q-T1 answer or a non-issuing document read each allow the automatic read", async () => {
    const evidenced = await confirmed();
    expect((await svc.markTicketsPending(prisma, evidenced, { reason: "persist_failed", evidence: "confirm_response" }, now())).automatic).toBe(true);

    const offerYes = await confirmed();
    expect((await svc.markTicketsPending(prisma, offerYes, { reason: "no_codes", evidence: null }, now(), { source, issuesTicketsAtConfirm: async () => "yes" })).automatic).toBe(true);

    // Evidence arriving later upgrades a waiting row.
    const upgraded = await confirmed();
    const before = await svc.markTicketsPending(prisma, upgraded, { reason: "no_codes", evidence: null }, now());
    const afterUp = await svc.markTicketsPending(prisma, upgraded, { reason: "malformed", evidence: "confirm_response" }, now());
    expect(afterUp).toEqual({ documentId: before.documentId, automatic: true, kind: "ticket_codes" });

    const noIssue = await confirmed();
    await svc.markTicketsPending(prisma, noIssue, { reason: "no_codes", evidence: null }, now());
    source.documentReadIssuesTickets = "no";
    await run();
    expect(source.reads).toEqual(expect.arrayContaining([evidenced.supplierBookingId, offerYes.supplierBookingId, upgraded.supplierBookingId, noIssue.supplierBookingId]));
    expect(source.reads).toHaveLength(4); // exactly one read per row per run
  });

  it("the sweep gives a confirmed booking with no codes row a pending one after the grace period (F47 detection)", async () => {
    const old = await confirmed({ agoMs: 2 * 60_000 });
    const fresh = await confirmed({ agoMs: 10_000 });
    const r = await run();
    expect(r.swept).toBeGreaterThanOrEqual(1);
    expect((await docsOf(old, "ticket_codes")).map((d) => d.status)).toEqual(["pending"]);
    expect(await docsOf(fresh, "ticket_codes")).toEqual([]);
    expect(source.reads).not.toContain(old.supplierBookingId); // no evidence, Q-T1 unknown
  });

  /* -------------------------------------------------------------------------
   * Wrong booking, backoff and the attempt bound (F13)
   * ---------------------------------------------------------------------- */

  it("a document for another booking is quarantined without its codes; retries back off on a bounded schedule and then fail to a human", async () => {
    const b = await confirmed();
    const { documentId } = await svc.markTicketsPending(prisma, b, { reason: "persist_failed", evidence: "confirm_response" }, now());
    answer(b, [t(0, "adult", `W-${RUN}-1`), t(1, "adult", `W-${RUN}-2`)], { bookingReference: "OUTTD-SOMEONEELSE" });
    const r = await run();
    expect(r.processed).toContainEqual({ documentId, kind: "ticket_codes", outcome: "wrong_booking" });
    const rows = await docsOf(b, "ticket_codes");
    const q = rows.find((d) => d.status === "quarantined")!;
    expect(q).toMatchObject({ quarantineReason: "wrong_booking", codes: [] });
    const waiting = rows.find((d) => d.id === documentId)!;
    expect(waiting).toMatchObject({ status: "pending", fetchAttempts: 1 });
    expect(waiting.attentionRequiredAt).not.toBeNull();
    expect(await prisma.supplierTicketCode.count({ where: { supplierBookingId: b.id } })).toBe(0);
    expect(logged.join("\n")).toContain("document.quarantined");

    source.tickets.delete(b.supplierBookingId!);
    const waits: number[] = [];
    let row = waiting;
    while (row.status === "pending") {
      waits.push((row.nextFetchAt!.getTime() - clock) / 60_000);
      clock = row.nextFetchAt!.getTime();
      await run();
      row = (await prisma.supplierDocument.findUniqueOrThrow({ where: { id: documentId }, include: { codes: true } })) as typeof row;
    }
    expect(waits).toEqual([1, 2, 5, 15, 30, 60, 60]);
    expect(row).toMatchObject({ status: "failed", fetchAttempts: 8, nextFetchAt: null });
    expect((await svc.listForOrder(b.orderId!)).find((i) => i.orderItemId === b.orderItemId)?.fulfilment).toBe("attention");
  });

  /* -------------------------------------------------------------------------
   * PDFs (F13, TKT-3) and the download path (SEC-13, F36)
   * ---------------------------------------------------------------------- */

  it.each([
    ["bad_magic", () => ({ kind: "ok" as const, bytes: pdfBytes("", "<html>\n"), declaredType: "application/pdf" })],
    ["active_content", () => ({ kind: "ok" as const, bytes: pdfBytes("/OpenAction << /S /J#61vaScript /JS (app.alert(1)) >>"), declaredType: "application/pdf" })],
    ["too_large", () => ({ kind: "too_large" as const })],
    ["too_large", () => ({ kind: "ok" as const, bytes: new Uint8Array(10 * 1024 * 1024 + 1), declaredType: "application/pdf" })],
  ])("a PDF failing with %s is quarantined, never stored and never served", async (reason, outcome) => {
    const b = await confirmed();
    await persist(b, [t(0, "adult", `P-${RUN}-1`), t(1, "adult", `P-${RUN}-2`)]);
    const [pending] = await docsOf(b, "tickets_pdf");
    source.pdfs.set(b.supplierBookingId!, outcome);
    const r = await run();
    expect(r.processed).toContainEqual({ documentId: pending.id, kind: "tickets_pdf", outcome: reason });
    const pdfs = await docsOf(b, "tickets_pdf");
    const q = pdfs.find((d) => d.status === "quarantined")!;
    expect(q).toMatchObject({ quarantineReason: reason, storageKey: null });
    expect(pdfs.find((d) => d.id === pending.id)).toMatchObject({ status: "pending", fetchAttempts: 1 });
    expect(store.keys()).toEqual([]);
    expect(await svc.readServable(q.id, now())).toEqual({ kind: "unavailable", reason: "not_valid" });
    expect(notify).not.toHaveBeenCalled();
    const items = await svc.listForOrder(b.orderId!);
    expect(items[0]).toMatchObject({ fulfilment: "attention" });
    expect(items[0].documents.map((d) => d.status)).toEqual(["pending"]);
  });

  it("without a store PDFs stay pending and nothing is downloaded", async () => {
    const b = await confirmed();
    await persist(b, [t(0, "adult", `S-${RUN}-1`), t(1, "adult", `S-${RUN}-2`)]);
    source.pdfs.set(b.supplierBookingId!, () => ({ kind: "ok", bytes: pdfBytes(), declaredType: null }));
    await run({ store: null });
    expect(source.pdfFetches).toEqual([]);
    expect((await docsOf(b, "tickets_pdf")).map((d) => d.status)).toEqual(["pending"]);
    storeMod.setDocumentStoreForTests(null);
    expect((await svc.listForOrder(b.orderId!))[0].fulfilment).toBe("ticket_pending");
  });

  it("serves a valid PDF; a lost or changed object is quarantined and refetched from the supplier (SEC-13, F36)", async () => {
    const b = await confirmed();
    await persist(b, [t(0, "adult", `R-${RUN}-1`), t(1, "adult", `R-${RUN}-2`)]);
    source.pdfs.set(b.supplierBookingId!, () => ({ kind: "ok", bytes: pdfBytes(), declaredType: "application/pdf" }));
    // Default notifier: the (mocked) notification service.
    await run({ notifyTicketsReady: undefined });
    expect(notifyMock).toHaveBeenCalledWith({ orderId: b.orderId, orderItemId: b.orderItemId, documentVersion: 1 });
    const [pdf] = await docsOf(b, "tickets_pdf");
    const served = await svc.readServable(pdf.id, now());
    expect(served).toMatchObject({ kind: "ok", contentType: "application/pdf", document: { id: pdf.id, orderId: b.orderId, orderItemId: b.orderItemId, kind: "tickets_pdf", version: 1 } });
    expect(Buffer.from((served as { bytes: Uint8Array }).bytes).equals(Buffer.from(pdfBytes()))).toBe(true);

    const items = await svc.listForOrder(b.orderId!);
    expect(items).toEqual([{ orderItemId: b.orderItemId, fulfilment: "issued", documents: [{ id: pdf.id, kind: "tickets_pdf", version: 1, status: "valid", contentType: "application/pdf", byteSize: pdfBytes().length, createdAt: pdf.createdAt.toISOString() }] }]);

    // The object is gone (Storage is not in database backups).
    store.corrupt(pdf.storageKey!, null);
    expect(await svc.readServable(pdf.id, now())).toEqual({ kind: "unavailable", reason: "refetching" });
    let rows = await docsOf(b, "tickets_pdf");
    expect(rows.find((d) => d.id === pdf.id)).toMatchObject({ status: "quarantined", quarantineReason: "object_missing" });
    const refetch = rows.find((d) => d.status === "pending")!;
    expect(refetch.nextFetchAt?.getTime()).toBe(clock);
    expect((await svc.listForOrder(b.orderId!))[0].fulfilment).toBe("attention");
    await run();
    const second = await prisma.supplierDocument.findUniqueOrThrow({ where: { id: refetch.id } });
    expect(second.status).toBe("valid");
    expect(second.storageKey).not.toBe(pdf.storageKey);
    expect((await svc.readServable(second.id, now())).kind).toBe("ok");

    // The object changed under its key: checksum mismatch.
    store.corrupt(second.storageKey!, pdfBytes("/Producer (tampered)"));
    expect(await svc.readServable(second.id, now())).toEqual({ kind: "unavailable", reason: "refetching" });
    rows = await docsOf(b, "tickets_pdf");
    expect(rows.find((d) => d.id === second.id)).toMatchObject({ status: "quarantined", quarantineReason: "checksum_mismatch" });
    expect(rows.filter((d) => d.status === "pending")).toHaveLength(1);

    // The audit finds the same without a download request.
    await run();
    const third = (await docsOf(b, "tickets_pdf")).find((d) => d.status === "valid")!;
    store.corrupt(third.storageKey!, null);
    const audit = await svc.auditStoredObjects({ store, now }, { max: 1000 });
    expect(audit.refetching).toBeGreaterThanOrEqual(1);
    expect((await prisma.supplierDocument.findUniqueOrThrow({ where: { id: third.id } })).quarantineReason).toBe("object_missing");

    storeMod.setDocumentStoreForTests(null);
    expect(await svc.readServable(third.id, now())).toEqual({ kind: "unavailable", reason: "not_valid" });
    expect(await svc.readServable(uuidv7(), now())).toEqual({ kind: "unavailable", reason: "not_found" });
    const codes = (await docsOf(b, "ticket_codes"))[0];
    expect(await svc.readServable(codes.id, now())).toEqual({ kind: "unavailable", reason: "not_found" });
  });

  it("readServable answers no_store when no store is configured", async () => {
    const b = await confirmed();
    await persist(b, [t(0, "adult", `N-${RUN}-1`), t(1, "adult", `N-${RUN}-2`)]);
    source.pdfs.set(b.supplierBookingId!, () => ({ kind: "ok", bytes: pdfBytes(), declaredType: null }));
    await run();
    const [pdf] = await docsOf(b, "tickets_pdf");
    storeMod.setDocumentStoreForTests(null);
    expect(await svc.readServable(pdf.id, now())).toEqual({ kind: "unavailable", reason: "no_store" });
  });

  it("requestRefetch queues a new version and keeps serving the valid one until it is replaced", async () => {
    const b = await confirmed();
    await persist(b, [t(0, "adult", `Q-${RUN}-1`), t(1, "adult", `Q-${RUN}-2`)]);
    source.pdfs.set(b.supplierBookingId!, () => ({ kind: "ok", bytes: pdfBytes(), declaredType: null }));
    await run();
    const [pdf] = await docsOf(b, "tickets_pdf");
    await svc.requestRefetch(pdf.id, "customer_report", now());
    expect((await svc.readServable(pdf.id, now())).kind).toBe("ok");
    await run();
    const rows = await docsOf(b, "tickets_pdf");
    expect(rows.map((d) => [d.version, d.status])).toEqual([
      [1, "superseded"],
      [2, "valid"],
    ]);
    // Codes: evidenced by the valid set, so the refetch read is automatic.
    const [codes] = await docsOf(b, "ticket_codes");
    await svc.requestRefetch(codes.id, "staff", now());
    answer(b, [t(0, "adult", `Q-${RUN}-1`), t(1, "adult", `Q-${RUN}-2`)]);
    const r = await run();
    expect(r.processed.filter((p) => p.kind === "ticket_codes").map((p) => p.outcome)).toEqual(["unchanged"]);
    expect((await docsOf(b, "ticket_codes")).map((d) => d.status)).toEqual(["valid", "superseded"]);
  });

  it("a claimed row stays locked past the old 120 s while its run works it, longer than budget plus the slowest row (R-B4-8)", async () => {
    const b = await confirmed();
    await persist(b, [t(0, "adult", `K-${RUN}-1`), t(1, "adult", `K-${RUN}-2`)]);
    const [pending] = await docsOf(b, "tickets_pdf");
    source.pdfs.set(b.supplierBookingId!, () => ({ kind: "ok", bytes: pdfBytes(), declaredType: null }));
    const t0 = clock;
    let lockedFor = 0;
    let second: Awaited<ReturnType<typeof run>> | null = null;
    source.duringPdfFetch = async () => {
      source.duringPdfFetch = null;
      lockedFor = (await prisma.supplierDocument.findUniqueOrThrow({ where: { id: pending.id } })).lockedUntil!.getTime() - t0;
      // A second run 150 s later, while the first still works the row: it must not claim it.
      clock = t0 + 150_000;
      second = await run();
    };
    const first = await run();
    expect(lockedFor).toBeGreaterThanOrEqual(mod.TICKET_TIMING.claimLockMs);
    expect(lockedFor).toBeGreaterThanOrEqual(30_000 + mod.TICKET_TIMING.rowAllowanceMs);
    expect(mod.TICKET_TIMING.claimLockMs).toBeGreaterThan(120_000);
    expect(second!.processed.map((p) => p.documentId)).not.toContain(pending.id);
    expect(source.pdfFetches).toEqual([b.supplierBookingId]);
    expect(first.processed).toContainEqual({ documentId: pending.id, kind: "tickets_pdf", outcome: "stored" });
    // A longer budget stretches the lock.
    const c = await confirmed();
    await persist(c, [t(0, "adult", `K-${RUN}-3`), t(1, "adult", `K-${RUN}-4`)]);
    const [pendingC] = await docsOf(c, "tickets_pdf");
    source.duringPdfFetch = async () => {
      source.duringPdfFetch = null;
      lockedFor = (await prisma.supplierDocument.findUniqueOrThrow({ where: { id: pendingC.id } })).lockedUntil!.getTime() - clock;
    };
    await svc.runDue(deps(), { budgetMs: 10 * 60_000, max: 50 });
    expect(lockedFor).toBe(10 * 60_000 + mod.TICKET_TIMING.rowAllowanceMs);
  });

  it("records the object key before the put, so a run killed before its commit leaves no orphan (R-B4-8)", async () => {
    const b = await confirmed();
    await persist(b, [t(0, "adult", `O-${RUN}-1`), t(1, "adult", `O-${RUN}-2`)]);
    const [pending] = await docsOf(b, "tickets_pdf");
    source.pdfs.set(b.supplierBookingId!, () => ({ kind: "ok", bytes: pdfBytes(), declaredType: null }));

    // What a run killed between put and commit leaves: an object, its key on the still-pending row.
    const killedKey = `test/${randomBytes(16).toString("hex")}`;
    await store.put(killedKey, pdfBytes(), "application/pdf");
    await prisma.supplierDocument.update({ where: { id: pending.id }, data: { storageKey: killedKey } });

    const put = store.put.bind(store);
    const keysAtPut: (string | null)[] = [];
    store.put = async (key, bytes, type) => {
      keysAtPut.push((await prisma.supplierDocument.findUniqueOrThrow({ where: { id: pending.id } })).storageKey);
      expect(keysAtPut.at(-1)).toBe(key);
      return put(key, bytes, type);
    };
    const r = await run();
    expect(r.processed).toContainEqual({ documentId: pending.id, kind: "tickets_pdf", outcome: "stored" });
    const row = await prisma.supplierDocument.findUniqueOrThrow({ where: { id: pending.id } });
    expect(row).toMatchObject({ status: "valid" });
    expect(keysAtPut).toEqual([row.storageKey]);
    expect(store.has(killedKey)).toBe(false); // the stale object was deleted first
    expect(store.keys()).toEqual([row.storageKey]);
  });

  it("a failed put deletes what may have landed and forgets the key; a failed delete keeps it recorded (R-B4-8)", async () => {
    const b = await confirmed();
    await persist(b, [t(0, "adult", `F-${RUN}-1`), t(1, "adult", `F-${RUN}-2`)]);
    const [pending] = await docsOf(b, "tickets_pdf");
    source.pdfs.set(b.supplierBookingId!, () => ({ kind: "ok", bytes: pdfBytes(), declaredType: null }));
    const put = store.put.bind(store);
    // The upload lands, then the call times out.
    store.put = async (key, bytes, type) => {
      await put(key, bytes, type);
      throw new Error("timed out");
    };
    expect((await run()).processed).toContainEqual({ documentId: pending.id, kind: "tickets_pdf", outcome: "store_error" });
    expect(store.keys()).toEqual([]);
    expect(await prisma.supplierDocument.findUniqueOrThrow({ where: { id: pending.id } })).toMatchObject({ status: "pending", storageKey: null, lockedUntil: null, fetchAttempts: 1 });

    // Now the delete fails too: the key stays on the row, and the next attempt deletes it before anything else.
    const del = store.delete.bind(store);
    store.delete = async () => {
      throw new Error("store down");
    };
    clock += 60_000;
    expect((await run()).processed).toContainEqual({ documentId: pending.id, kind: "tickets_pdf", outcome: "store_error" });
    const kept = (await prisma.supplierDocument.findUniqueOrThrow({ where: { id: pending.id } })).storageKey;
    expect(kept).toMatch(OBJECT_KEY);
    expect(store.keys()).toEqual([kept]);
    store.put = put;
    store.delete = del;
    clock += 2 * 60_000;
    expect((await run()).processed).toContainEqual({ documentId: pending.id, kind: "tickets_pdf", outcome: "stored" });
    const row = await prisma.supplierDocument.findUniqueOrThrow({ where: { id: pending.id } });
    expect(row.storageKey).not.toBe(kept);
    expect(store.keys()).toEqual([row.storageKey]);
  });

  it("requestRefetch and a failed object check leave a running job's lock alone and only move the due time (R-B4-12)", async () => {
    const b = await confirmed();
    await persist(b, [t(0, "adult", `M-${RUN}-1`), t(1, "adult", `M-${RUN}-2`)]);
    source.pdfs.set(b.supplierBookingId!, () => ({ kind: "ok", bytes: pdfBytes(), declaredType: null }));
    await run();
    const [pdf] = await docsOf(b, "tickets_pdf");
    await svc.requestRefetch(pdf.id, "customer_report", now());
    const waiting = (await docsOf(b, "tickets_pdf")).find((d) => d.status === "pending")!;
    // A running job holds the waiting row.
    const held = new Date(clock + 4 * 60_000);
    await prisma.supplierDocument.update({ where: { id: waiting.id }, data: { lockedUntil: held, nextFetchAt: new Date(clock + 60 * 60_000) } });

    clock += 60_000;
    await svc.requestRefetch(pdf.id, "customer_report", now());
    let row = await prisma.supplierDocument.findUniqueOrThrow({ where: { id: waiting.id } });
    expect(row.lockedUntil?.getTime()).toBe(held.getTime());
    expect(row.nextFetchAt?.getTime()).toBe(clock);

    clock += 60_000;
    store.corrupt(pdf.storageKey!, null);
    expect(await svc.readServable(pdf.id, now())).toEqual({ kind: "unavailable", reason: "refetching" });
    row = await prisma.supplierDocument.findUniqueOrThrow({ where: { id: waiting.id } });
    expect(row.lockedUntil?.getTime()).toBe(held.getTime());
    expect(row.nextFetchAt?.getTime()).toBe(clock);

    // While the lock holds, no run fetches the row again; after it lapses, one does.
    source.pdfFetches = [];
    await run();
    expect(source.pdfFetches).toEqual([]);
    clock = held.getTime();
    await run();
    expect(source.pdfFetches).toEqual([b.supplierBookingId]);
    expect((await prisma.supplierDocument.findUniqueOrThrow({ where: { id: waiting.id } })).status).toBe("valid");
  });

  it("the documents run audits a bounded random sample of this supplier's stored objects (SEC-13, R-B4-5)", async () => {
    const b = await confirmed();
    await persist(b, [t(0, "adult", `A-${RUN}-1`), t(1, "adult", `A-${RUN}-2`)]);
    source.pdfs.set(b.supplierBookingId!, () => ({ kind: "ok", bytes: pdfBytes(), declaredType: null }));
    const first = await run();
    expect(first.audited).toEqual({ checked: 0, refetching: 0 }); // no auditMax: no audit
    const [pdf] = await docsOf(b, "tickets_pdf");
    store.corrupt(pdf.storageKey!, null);
    // Earlier tests of this suite left valid PDFs whose objects lived in other stores: they count as missing too.
    const valid = await prisma.supplierDocument.count({ where: { kind: { in: ["tickets_pdf", "voucher_pdf"] }, status: "valid", supplierBooking: { supplierId } } });
    const r = await svc.runDue(deps({ source: null }), { budgetMs: 30_000, max: 50, supplierCode: CODE, auditMax: valid });
    expect(r.audited).toEqual({ checked: valid, refetching: valid });
    expect(await prisma.supplierDocument.findUniqueOrThrow({ where: { id: pdf.id } })).toMatchObject({ status: "quarantined", quarantineReason: "object_missing" });
    expect((await docsOf(b, "tickets_pdf")).filter((d) => d.status === "pending")).toHaveLength(1);

    // Bounded: a sample of one checks one, and nothing past the deadline.
    const c = await confirmed();
    await persist(c, [t(0, "adult", `A-${RUN}-3`), t(1, "adult", `A-${RUN}-4`)]);
    source.pdfs.set(c.supplierBookingId!, () => ({ kind: "ok", bytes: pdfBytes(), declaredType: null }));
    await run();
    expect((await svc.auditStoredObjects({ store, now }, { max: 1, sample: true, supplierCode: CODE })).checked).toBe(1);
    expect((await svc.auditStoredObjects({ store, now }, { max: 5, sample: true, supplierCode: CODE, deadline: Date.now() - 1 })).checked).toBe(0);
    expect((await svc.listForOrder(c.orderId!))[0].fulfilment).toBe("issued");
  });

  /* -------------------------------------------------------------------------
   * F12 thresholds and the customer view
   * ---------------------------------------------------------------------- */

  it("a missing ticket raises attention at 2 minutes and urgent at 5, or urgent at 2 when the activity starts soon (F12)", async () => {
    // Far from its start whatever the suite's clock (it advances a day per test).
    const far = await confirmed({ serviceDate: "2031-03-20" });
    const { documentId: farDoc } = await svc.markTicketsPending(prisma, far, { reason: "persist_failed", evidence: "confirm_response" }, now());
    // 5 hours before the activity (10:00 Dubai on the clock's date).
    const startDay = new Date(clock).toISOString().slice(0, 10);
    const startMinutes = Math.round((clock + 5 * 3_600_000 - Date.parse(`${startDay}T00:00:00Z`) + 4 * 3_600_000) / 60_000);
    const soon = await confirmed({ serviceDate: startDay, startMinutes });
    const { documentId: soonDoc } = await svc.markTicketsPending(prisma, soon, { reason: "persist_failed", evidence: "confirm_response" }, now());
    const attn = async (id: string) => (await prisma.supplierDocument.findUniqueOrThrow({ where: { id } })).attentionRequiredAt?.getTime() ?? null;
    const quiet = { source: null };
    const t0 = clock;

    clock = t0 + 60_000;
    await run(quiet);
    expect(await attn(farDoc)).toBeNull();
    expect(await attn(soonDoc)).toBeNull();

    clock = t0 + 3 * 60_000;
    logged = [];
    await svc.runDue(deps(quiet), { budgetMs: 30_000, max: 50, supplierCode: CODE });
    expect(await attn(farDoc)).toBe(clock);
    expect(await attn(soonDoc)).toBe(clock);
    expect(logged.filter((l) => l.includes(farDoc)).join()).toContain('"ticket_missing"');
    expect(logged.filter((l) => l.includes(soonDoc)).join()).toContain("ticket_missing_urgent");
    expect(logged.filter((l) => l.includes(farDoc)).join()).toContain('"ageMs":180000');

    clock = t0 + 4 * 60_000;
    logged = [];
    await svc.runDue(deps(quiet), { budgetMs: 30_000, max: 50, supplierCode: CODE });
    expect(logged.filter((l) => l.includes("document.attention"))).toEqual([]);

    clock = t0 + 6 * 60_000;
    await svc.runDue(deps(quiet), { budgetMs: 30_000, max: 50, supplierCode: CODE });
    expect(await attn(farDoc)).toBe(clock);
    expect(logged.filter((l) => l.includes(farDoc)).join()).toContain("ticket_missing_urgent");
    const urgentAt = clock;

    clock = t0 + 9 * 60_000;
    await svc.runDue(deps(quiet), { budgetMs: 30_000, max: 50, supplierCode: CODE });
    expect(await attn(farDoc)).toBe(urgentAt);
  });

  it("listForOrder shows not_applicable without a confirmed booking and never exposes keys, checksums or codes", async () => {
    const lone = await orderItem();
    expect(await svc.listForOrder(lone.orderId)).toEqual([{ orderItemId: lone.orderItemId, fulfilment: "not_applicable", documents: [] }]);

    const b = await confirmed();
    await persist(b, [t(0, "adult", `L-${RUN}-1`), t(1, "adult", `L-${RUN}-2`)]);
    let [item] = await svc.listForOrder(b.orderId!);
    expect(item.fulfilment).toBe("ticket_pending");
    source.pdfs.set(b.supplierBookingId!, () => ({ kind: "ok", bytes: pdfBytes(), declaredType: null }));
    await run();
    [item] = await svc.listForOrder(b.orderId!);
    expect(item.fulfilment).toBe("issued");
    const text = JSON.stringify(item);
    expect(text).not.toMatch(/storageKey|sha256|codeCiphertext|codeHash|test\/[0-9a-f]{32}/);
    expect(text).not.toContain(`L-${RUN}`);
    expect(Object.keys(item.documents[0]).sort()).toEqual(["byteSize", "contentType", "createdAt", "id", "kind", "status", "version"]);
  });

  it("a drill booking never gets document rows", async () => {
    const k = ++n;
    const drill = await prisma.supplierBooking.create({
      data: {
        id: uuidv7(), supplierId, environment: "test", idempotencyKey: `doc-${RUN}-drill-${k}`, clientRef: `OUTTD-DRILL${RUN.toUpperCase()}${k}`,
        bookingKind: "live_book", afterReserve: "cancel", state: "confirmed", tourExternalId: "1", offerExternalId: OFFER, serviceDate: new Date(SERVICE_DATE),
        adults: 2, guestName: "test-docs", expectedNetMinor: 1n, expectedNetUsdMinor: 1n, supplierBookingId: String(seq++), confirmedAt: new Date(clock - 3_600_000),
      },
    });
    await expect(prisma.$transaction((tx) => svc.persistIssuedTickets(tx, drill, new IssuedTicketSet([t(0, "adult", "x")], "confirm_response"), now()))).rejects.toThrow(/drill/);
    await run();
    expect(await prisma.supplierDocument.count({ where: { supplierBookingId: drill.id } })).toBe(0);
  });

  /* -------------------------------------------------------------------------
   * Live bookings: the voucher is the customer document (OpenAPI 2026-11-05)
   * ---------------------------------------------------------------------- */

  it("a live booking's codes queue the voucher, never a tickets PDF; the voucher alone completes it", async () => {
    const b = await confirmed({ kind: "live_book" });
    await persist(b, [t(0, "adult", `V-${RUN}-1`), t(1, "adult", `V-${RUN}-2`)]);
    expect(await docsOf(b, "tickets_pdf")).toEqual([]);
    expect((await docsOf(b, "voucher_pdf")).map((d) => d.status)).toEqual(["pending"]);
    source.vouchers.set(b.supplierBookingId!, () => ({ kind: "ok", bytes: pdfBytes(), declaredType: "application/pdf" }));
    await run();
    expect(source.voucherFetches).toEqual([b.supplierBookingId]);
    expect(source.pdfFetches).toEqual([]);
    expect((await docsOf(b, "voucher_pdf")).map((d) => d.status)).toEqual(["valid"]);
    expect((await svc.listForOrder(b.orderId!))[0].fulfilment).toBe("issued");
    expect(notify).toHaveBeenCalledTimes(1);

    // A reissue of the codes supersedes the voucher (it shows the old codes) and queues a new one.
    await persist(b, [t(0, "adult", `V-${RUN}-3`), t(1, "adult", `V-${RUN}-4`)]);
    expect((await docsOf(b, "voucher_pdf")).map((d) => d.status)).toEqual(["superseded", "pending"]);
  });

  it("a live booking whose offer issues no tickets gets only a voucher row, downloaded automatically, with no staff attention", async () => {
    const b = await confirmed({ kind: "live_book" });
    const r = await svc.markTicketsPending(prisma, b, { reason: "no_codes", evidence: null }, now(), { source, issuesTicketsAtConfirm: async () => "no" });
    expect(r).toMatchObject({ kind: "voucher_pdf", automatic: true });
    expect(await docsOf(b, "ticket_codes")).toEqual([]);
    // Idempotent.
    expect((await svc.markTicketsPending(prisma, b, { reason: "no_codes", evidence: null }, now(), { source, issuesTicketsAtConfirm: async () => "no" })).documentId).toBe(r.documentId);
    source.vouchers.set(b.supplierBookingId!, () => ({ kind: "ok", bytes: pdfBytes(), declaredType: null }));
    await run({ issuesTicketsAtConfirm: async () => "no" });
    expect(source.reads).not.toContain(b.supplierBookingId);
    expect((await docsOf(b)).map((d) => [d.kind, d.status])).toEqual([["voucher_pdf", "valid"]]);
    expect((await svc.listForOrder(b.orderId!))[0].fulfilment).toBe("issued");
    expect(logged.join("\n")).not.toContain("ticket_read_needs_staff");
  });

  it("a live booking whatever its ticket evidence gets no codes row unless codes were seen; staff can still force a read", async () => {
    // TravelDesk sends live bookings a voucher only, never codes (doc 22 §32.32).
    const b = await confirmed({ kind: "live_book" });
    const r = await svc.markTicketsPending(prisma, b, { reason: "no_codes", evidence: null }, now(), { source, issuesTicketsAtConfirm: async () => "unknown" });
    expect(r).toMatchObject({ kind: "voucher_pdf", automatic: true });
    expect((await docsOf(b)).map((d) => [d.kind, d.status])).toEqual([["voucher_pdf", "pending"]]);
    expect(logged.join("\n")).not.toContain("ticket_read_needs_staff");
    source.vouchers.set(b.supplierBookingId!, () => ({ kind: "ok", bytes: pdfBytes(), declaredType: null }));
    await run();
    expect(source.reads).not.toContain(b.supplierBookingId);
    expect((await svc.listForOrder(b.orderId!))[0].fulfilment).toBe("issued");

    // Malformed codes in a confirm answer are evidence: their codes row stays.
    const m = await confirmed({ kind: "live_book" });
    expect((await svc.markTicketsPending(prisma, m, { reason: "malformed", evidence: "confirm_response" }, now(), { source })).kind).toBe("ticket_codes");
    expect((await docsOf(m)).map((d) => d.kind)).toEqual(["ticket_codes", "voucher_pdf"]);

    // The deliberate staff read forces the codes row.
    const f = await confirmed({ kind: "live_book" });
    expect((await svc.markTicketsPending(prisma, f, { reason: "no_codes", evidence: null, force: true }, now(), { source })).kind).toBe("ticket_codes");
  });

  it("a code set short of the order holds a live booking back even with a valid voucher (TKT-2)", async () => {
    const b = await confirmed({ kind: "live_book", adults: 2 });
    await persist(b, [t(0, "adult", `V-${RUN}-5`)]);
    source.vouchers.set(b.supplierBookingId!, () => ({ kind: "ok", bytes: pdfBytes(), declaredType: null }));
    await run();
    expect((await docsOf(b, "voucher_pdf")).map((d) => d.status)).toEqual(["valid"]);
    expect((await svc.listForOrder(b.orderId!))[0].fulfilment).not.toBe("issued");
  });

  it("the sweep gives a live booking its voucher row once, and a TicketOnly booking its codes row (F47)", async () => {
    const live = await confirmed({ kind: "live_book", agoMs: 2 * 60_000 });
    const ticketOnly = await confirmed({ agoMs: 2 * 60_000 });
    await run({ issuesTicketsAtConfirm: async () => "no" });
    expect((await docsOf(live)).map((d) => d.kind)).toEqual(["voucher_pdf"]);
    expect((await docsOf(ticketOnly)).map((d) => d.kind)).toEqual(["ticket_codes"]);
    const again = await run({ issuesTicketsAtConfirm: async () => "no" });
    expect(again.swept).toBe(0);
  });

  it("a voucher that is not ready backs off; a non-PDF answer is quarantined as a voucher; staff can refetch a voucher", async () => {
    const b = await confirmed({ kind: "live_book" });
    await persist(b, [t(0, "adult", `V-${RUN}-6`), t(1, "adult", `V-${RUN}-7`)]);
    await run();
    expect((await docsOf(b, "voucher_pdf"))[0]).toMatchObject({ status: "pending", fetchAttempts: 1 });
    clock += 60 * 60_000;
    source.vouchers.set(b.supplierBookingId!, () => ({ kind: "ok", bytes: new TextEncoder().encode("Tickets are not available"), declaredType: "application/pdf" }));
    await run();
    expect((await docsOf(b, "voucher_pdf")).map((d) => d.status)).toEqual(["pending", "quarantined"]);
    clock += 60 * 60_000;
    source.vouchers.set(b.supplierBookingId!, () => ({ kind: "ok", bytes: pdfBytes(), declaredType: null }));
    await run();
    const valid = (await docsOf(b, "voucher_pdf")).find((d) => d.status === "valid")!;
    await svc.requestRefetch(valid.id, "customer_report", now());
    const pending = (await docsOf(b, "voucher_pdf")).filter((d) => d.status === "pending");
    expect(pending).toHaveLength(1);
    expect(pending[0].nextFetchAt).not.toBeNull();
  });
  /* -------------------------------------------------------------------------
   * Right after a confirm (checkout redesign batch 4, CO-40)
   * ---------------------------------------------------------------------- */

  async function liveWithVoucher() {
    const b = await confirmed({ kind: "live_book" });
    const r = await svc.markTicketsPending(prisma, b, { reason: "no_codes", evidence: null }, now(), { source, issuesTicketsAtConfirm: async () => "no" });
    expect(r.kind).toBe("voucher_pdf");
    return b;
  }

  const AFTER_CONFIRM = { budgetMs: 20_000, max: 2 };

  it("runForBooking claims only that booking's due PDF rows; another booking's voucher and any ticket-code read are left to the tick", async () => {
    const b = await liveWithVoucher();
    const other = await liveWithVoucher();
    const codesOnly = await confirmed();
    await svc.markTicketsPending(prisma, codesOnly, { reason: "malformed", evidence: "confirm_response" }, now(), { source });
    expect((await docsOf(codesOnly, "ticket_codes"))[0].nextFetchAt).not.toBeNull();
    source.vouchers.set(b.supplierBookingId!, () => ({ kind: "ok", bytes: pdfBytes(), declaredType: "application/pdf" }));
    source.vouchers.set(other.supplierBookingId!, () => ({ kind: "ok", bytes: pdfBytes(), declaredType: "application/pdf" }));

    const r = await svc.runForBooking(deps(), b.id, AFTER_CONFIRM);
    expect(r.claimed).toBe(1);
    expect(r.processed).toEqual([{ documentId: (await docsOf(b, "voucher_pdf"))[0].id, kind: "voucher_pdf", outcome: "stored" }]);
    expect(source.voucherFetches).toEqual([b.supplierBookingId]);
    expect((await docsOf(b, "voucher_pdf")).map((d) => d.status)).toEqual(["valid"]);
    expect(notify).toHaveBeenCalledTimes(1);
    // Untouched: the other booking's voucher, and the codes read (a booking get-by-id) of a booking just confirmed.
    expect((await docsOf(other, "voucher_pdf"))[0]).toMatchObject({ status: "pending", fetchAttempts: 0, lockedUntil: null });
    expect((await svc.runForBooking(deps(), codesOnly.id, AFTER_CONFIRM)).claimed).toBe(0);
    expect(source.reads).toEqual([]);

    // Idempotent: a second trigger finds nothing due and calls nobody.
    expect((await svc.runForBooking(deps(), b.id, AFTER_CONFIRM)).claimed).toBe(0);
    expect(source.voucherFetches).toHaveLength(1);
  });

  it("runForBooking on a voucher TravelDesk has not made yet (502, not_ready) backs off like the tick, and the tick stores it later", async () => {
    const b = await liveWithVoucher();
    // Default fake answer: not_ready (the source maps TravelDesk's 502 to it).
    const r = await svc.runForBooking(deps(), b.id, AFTER_CONFIRM);
    expect(r.processed.map((p) => p.outcome)).toEqual(["not_ready"]);
    const [waiting] = await docsOf(b, "voucher_pdf");
    expect(waiting).toMatchObject({ status: "pending", fetchAttempts: 1, lockedUntil: null });
    expect(waiting.nextFetchAt!.getTime()).toBe(clock + 60_000);
    // Not due again yet: neither a repeat trigger nor the tick fetches before the back-off.
    expect((await svc.runForBooking(deps(), b.id, AFTER_CONFIRM)).claimed).toBe(0);
    await run();
    expect(source.voucherFetches).toEqual([b.supplierBookingId]);
    clock += 60_000;
    source.vouchers.set(b.supplierBookingId!, () => ({ kind: "ok", bytes: pdfBytes(), declaredType: null }));
    await run();
    expect((await docsOf(b, "voucher_pdf"))[0]).toMatchObject({ status: "valid", fetchAttempts: 2 });
  });

  it("runForBooking: a source that throws leaves the row to the tick; without a store or a source it claims nothing", async () => {
    const b = await liveWithVoucher();
    source.vouchers.set(b.supplierBookingId!, () => {
      throw new Error("synthetic network failure");
    });
    const r = await svc.runForBooking(deps(), b.id, AFTER_CONFIRM);
    expect(r.processed.map((p) => p.outcome)).toEqual(["failed"]);
    expect((await docsOf(b, "voucher_pdf"))[0]).toMatchObject({ status: "pending", fetchAttempts: 1, lockedUntil: null });

    const c = await liveWithVoucher();
    expect((await svc.runForBooking(deps({ store: null }), c.id, AFTER_CONFIRM)).claimed).toBe(0);
    expect((await svc.runForBooking(deps({ source: null }), c.id, AFTER_CONFIRM)).claimed).toBe(0);
    expect((await docsOf(c, "voucher_pdf"))[0]).toMatchObject({ status: "pending", fetchAttempts: 0, lockedUntil: null });
  });
});
