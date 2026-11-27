import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { assertDisposableDb, dbEnabled, runId } from "@/server/__tests__/helpers/fixtures";
import { assertDisposableDbLive } from "@/server/__tests__/helpers/target-guard";
import { IssuedTicketSet, type DocumentSource, type PdfFetchOutcome } from "@/server/documents/contracts";
import { MemoryDocumentStore } from "@/server/documents/memory-store";
import { checkedOut, deliver, harness, sagaState, type Harness } from "@/server/payments/__tests__/_b3-harness";
import { isServerOnlyEvent } from "@/lib/event-sources";
import { parseEventsBody } from "@/server/schemas/events.schemas";
import { carryConfirmedBooking, carrySupplier, carryTicket } from "./carry-fixtures";

/**
 * Server-only analytics from verified transitions (PRD-16, PRV-4,
 * CR-B3-12), against the disposable database with the B3 fake gateways and
 * fake engine:
 *
 *  - the saga records `payment_authorized`, `payment_captured` and
 *    `supplier_confirmed` from committed moves only, once per order (item);
 *  - the document service records `ticket_ready` once the item's tickets
 *    are issued; `order_partially_fulfilled` follows `partially_confirmed`;
 *  - props are allowlisted (no contact, code or amount), nothing is
 *    forwarded to Meta, GA4 or PostHog, and an analytics failure never
 *    stops the saga;
 *  - the public collector refuses every one of these names.
 */

const run = runId();
type Prisma = typeof import("@/server/lib/db").prisma;
let prisma: Prisma;
let analytics: typeof import("@/server/services/analytics.service");
let forwarders: typeof import("@/server/analytics/forwarders").forwarders;

const VERIFIED = ["payment_authorized", "payment_captured", "supplier_confirmed", "ticket_ready", "order_partially_fulfilled"] as const;

async function eventsOf(orderId: string) {
  const rows = await prisma.analyticsEvent.findMany({ where: { orderId, source: "server" }, orderBy: { receivedAt: "asc" } });
  return rows.filter((r) => (VERIFIED as readonly string[]).includes(r.name));
}

async function reserveAndConfirm(x: Harness, orderItemId: string) {
  x.engine.reserve(orderItemId);
  await x.saga.notifier.bookingChanged(orderItemId, "awaiting_payment");
  await x.saga.notifier.bookingChanged(orderItemId, x.engine.bookings.get(orderItemId)!.state);
}

describe.skipIf(!dbEnabled)("B5 carry-over: verified server analytics (PRD-16)", () => {
  beforeAll(async () => {
    assertDisposableDb();
    prisma = (await import("@/server/lib/db")).prisma;
    await assertDisposableDbLive(prisma);
    analytics = await import("@/server/services/analytics.service");
    forwarders = (await import("@/server/analytics/forwarders")).forwarders;
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  afterAll(async () => {
    if (!prisma) return;
    // Test products are hidden from every storefront query (as cleanupB3 does, for this run only).
    await prisma.$executeRawUnsafe(`UPDATE products SET deleted_at = now() WHERE slug LIKE $1 AND deleted_at IS NULL`, `zz-b3-${run}-%`);
  });

  function spyForwarders() {
    return vi.spyOn(forwarders, "forward");
  }

  describe("from the payment saga", () => {
    it("card hold: authorized, captured and confirmed are each recorded once, with allowlisted props and no forwarding", async () => {
      const fwd = spyForwarders();
      const x = await harness(prisma);
      const c = await checkedOut(x, run, "AED", "card");
      const pid = c.gw.pay(c.providerOrderId);
      await deliver(x, c.gw, "payment.authorized", pid);
      expect((await eventsOf(c.r.orderId)).map((e) => e.name)).toEqual(["payment_authorized"]);
      await reserveAndConfirm(x, c.orderItemId);
      expect((await sagaState(x, c.sagaId)).state).toBe("fulfilled");

      const rows = await eventsOf(c.r.orderId);
      expect(rows.map((e) => e.name)).toEqual(["payment_authorized", "payment_captured", "supplier_confirmed"]);
      const order = await prisma.order.findUniqueOrThrow({ where: { id: c.r.orderId } });
      for (const r of rows) {
        expect(r).toMatchObject({ source: "server", rail: "self_serve", valueMinor: null, currency: null, sessionId: null, anonId: null });
        expect(r.eventId).toBe(`${r.name}:${r.name === "supplier_confirmed" ? c.orderItemId : c.r.orderId}`);
      }
      expect(rows[0].props).toEqual({ order_reference: order.reference });
      expect(rows[2].props).toEqual({ order_reference: order.reference, order_item_id: c.orderItemId });
      expect(fwd.mock.calls.filter(([e]) => (VERIFIED as readonly string[]).includes(e.name))).toHaveLength(0);

      // Re-running the saga records nothing new.
      await x.saga.advance(c.sagaId);
      await x.saga.notifier.bookingChanged(c.orderItemId, "confirmed");
      expect(await eventsOf(c.r.orderId)).toHaveLength(3);
    });

    it("UPI capture-first: authorized and captured once each; nothing before the provider's read", async () => {
      const x = await harness(prisma);
      const c = await checkedOut(x, run, "INR", "upi");
      expect(await eventsOf(c.r.orderId)).toHaveLength(0);
      const pid = c.gw.pay(c.providerOrderId);
      await deliver(x, c.gw, "payment.captured", pid);
      expect((await eventsOf(c.r.orderId)).map((e) => e.name)).toEqual(["payment_authorized", "payment_captured"]);
      // The same webhook again is no new evidence and no new event.
      await deliver(x, c.gw, "payment.captured", pid);
      expect(await eventsOf(c.r.orderId)).toHaveLength(2);
    });

    it("reserve rejected: the authorization is recorded, no capture and no confirmation", async () => {
      const x = await harness(prisma);
      const c = await checkedOut(x, run, "AED", "card");
      const pid = c.gw.pay(c.providerOrderId);
      await deliver(x, c.gw, "payment.authorized", pid);
      x.engine.reserve(c.orderItemId, "rejected");
      await x.saga.notifier.bookingChanged(c.orderItemId, "rejected");
      expect((await sagaState(x, c.sagaId)).state).toBe("released");
      expect((await eventsOf(c.r.orderId)).map((e) => e.name)).toEqual(["payment_authorized"]);
    });

    it("an analytics failure never stops or undoes the saga", async () => {
      vi.spyOn(analytics.analyticsService, "emitVerified").mockRejectedValue(new Error("analytics down (test)"));
      vi.spyOn(prisma.analyticsEvent, "createMany").mockRejectedValue(new Error("analytics table down (test)"));
      const x = await harness(prisma);
      const c = await checkedOut(x, run, "AED", "card");
      const pid = c.gw.pay(c.providerOrderId);
      await deliver(x, c.gw, "payment.authorized", pid);
      await reserveAndConfirm(x, c.orderItemId);
      expect((await sagaState(x, c.sagaId)).state).toBe("fulfilled");
      expect(await prisma.order.findUniqueOrThrow({ where: { id: c.r.orderId } })).toMatchObject({ status: "confirmed" });
    });
  });

  describe("emitVerified and the partial-fulfilment event", () => {
    it("drops anything outside the allowlist, records once, and never throws", async () => {
      const fwd = spyForwarders();
      const { id: supplierId } = await carrySupplier(prisma, run);
      const b = await carryConfirmedBooking(prisma, run, supplierId);
      const r1 = await analytics.analyticsService.emitVerified({
        name: "ticket_ready",
        orderId: b.orderId!,
        orderItemId: b.orderItemId,
        props: { document_version: 3, lead_email: "guest@outlyy.test", ticket_code: "SECRET-CODE", value: 1234, total_minor: 1000, note: "free text with spaces" },
      });
      expect(r1).toBe("recorded");
      expect(await analytics.analyticsService.emitVerified({ name: "ticket_ready", orderId: b.orderId!, orderItemId: b.orderItemId })).toBe("duplicate");
      const [row] = await eventsOf(b.orderId!);
      const order = await prisma.order.findUniqueOrThrow({ where: { id: b.orderId! } });
      expect(row.props).toEqual({ order_reference: order.reference, order_item_id: b.orderItemId, document_version: 3 });
      expect(fwd).not.toHaveBeenCalled();
      await expect(analytics.analyticsService.emitVerified({ name: "payment_captured", orderId: "00000000-0000-7000-8000-000000000000" })).resolves.toBe("failed");
    });

    it("order_partially_fulfilled only when the order is partially_confirmed, once", async () => {
      const { id: supplierId } = await carrySupplier(prisma, run);
      const b = await carryConfirmedBooking(prisma, run, supplierId);
      expect(await analytics.analyticsService.emitIfPartiallyFulfilled(b.orderId!)).toBe("not_partial");
      await prisma.order.update({ where: { id: b.orderId! }, data: { status: "partially_confirmed" } });
      expect(await analytics.analyticsService.emitIfPartiallyFulfilled(b.orderId!)).toBe("recorded");
      expect(await analytics.analyticsService.emitIfPartiallyFulfilled(b.orderId!)).toBe("duplicate");
      const [row] = await eventsOf(b.orderId!);
      expect(row).toMatchObject({ name: "order_partially_fulfilled", eventId: `order_partially_fulfilled:${b.orderId}` });
      expect(row.props).toMatchObject({ item_count: 1, confirmed_item_count: 0 });
    });

    it("the existing emit path never forwards these names either", async () => {
      const fwd = spyForwarders();
      await analytics.analyticsService.emit({ name: "payment_captured", props: { order_reference: "OUT-TEST" } });
      expect(fwd).not.toHaveBeenCalled();
      await analytics.analyticsService.emit({ name: "inquiry_lost", props: {} });
      expect(fwd).toHaveBeenCalledTimes(1);
    });
  });

  describe("from the document service", () => {
    it("ticket_ready once the item's tickets are issued (codes and PDF valid), not again on a reissue", async () => {
      const { id: supplierId, code } = await carrySupplier(prisma, run);
      const b = await carryConfirmedBooking(prisma, run, supplierId);
      const { documentService } = await import("@/server/services/document.service");
      const pdf = Buffer.from(
        "%PDF-1.7\n1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n2 0 obj\n<< /Type /Pages /Kids [] /Count 0 >>\nendobj\ntrailer\n<< /Root 1 0 R >>\n%%EOF\n",
        "latin1",
      );
      const source: DocumentSource = {
        supplierCode: code,
        documentReadIssuesTickets: "unknown",
        async readTickets() {
          return { kind: "not_found" as const };
        },
        async fetchTicketsPdf(): Promise<PdfFetchOutcome> {
          return { kind: "ok", bytes: new Uint8Array(pdf), declaredType: "application/pdf" };
        },
        async fetchVoucherPdf(): Promise<PdfFetchOutcome> {
          return { kind: "ok", bytes: new Uint8Array(pdf), declaredType: "application/pdf" };
        },
      } as unknown as DocumentSource;
      const deps = { source, store: new MemoryDocumentStore(), now: () => new Date(), notifyTicketsReady: async () => null };

      const persist = (codes: string[]) => prisma.$transaction((tx) => documentService.persistIssuedTickets(tx, b, new IssuedTicketSet(codes.map((c, i) => carryTicket(i, c)), "confirm_response"), new Date()));
      await persist([`T-${run}-1`, `T-${run}-2`]);
      expect(await eventsOf(b.orderId!)).toHaveLength(0);
      await documentService.runDue(deps, { budgetMs: 30_000, max: 50 });
      let rows = await eventsOf(b.orderId!);
      expect(rows.map((r) => [r.name, r.eventId])).toEqual([["ticket_ready", `ticket_ready:${b.orderItemId}`]]);
      expect(rows[0].props).toMatchObject({ order_item_id: b.orderItemId, document_version: 1 });

      // A reissue stores a new PDF: still one ticket_ready for the item.
      await persist([`T-${run}-3`, `T-${run}-4`]);
      await documentService.runDue(deps, { budgetMs: 30_000, max: 50 });
      rows = await eventsOf(b.orderId!);
      expect(rows).toHaveLength(1);
      expect(await prisma.supplierDocument.count({ where: { supplierBookingId: b.id, kind: "voucher_pdf", status: "valid", version: 2 } })).toBe(1);
    });
  });

  it("the public collector refuses every verified name (and the server-only conversions)", () => {
    for (const name of [...VERIFIED, "booking_confirmed", "inquiry_won"]) {
      expect(isServerOnlyEvent(name), name).toBe(true);
      expect(Object.keys(analytics.VERIFIED_EVENT_PROPS).includes(name) || ["booking_confirmed", "inquiry_won"].includes(name)).toBe(true);
    }
    // The five new names are not even in the client taxonomy: the parser rejects them before the server-only filter.
    const parsed = parseEventsBody(VERIFIED.map((event, i) => ({ event, event_id: `ev-${i}-${run}` })));
    expect(parsed.events).toHaveLength(0);
    expect(parsed.rejected).toBe(VERIFIED.length);
  });
});
