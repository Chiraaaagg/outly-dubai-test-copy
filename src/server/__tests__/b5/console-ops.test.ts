import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createHmac } from "node:crypto";
import type { Actor } from "../../lib/actor";
import { uuidv7 } from "../../lib/ids";
import { ROLE_PERMISSIONS, type RoleCode } from "../../lib/permissions";
import { assertDisposableDb, cleanupPeople, createStaff, dbEnabled, runId, type StaffFixture } from "../helpers/fixtures";

/**
 * Operations console (doc 22 §23 B5): the queues, the order detail, the
 * ticket actions and the privileged resolution, on the disposable database.
 *
 * Every row is synthetic and tagged with this run (`zz-ops-<run>`): one order
 * per scenario (a payment saga is one per order), amounts and net figures
 * are made up, phones are in the fictional +91 99 range. Queue rows are
 * dated in 2001 so they sort before anything another suite left on the
 * shared database (queues are oldest first). Staff are `zz-sec-<run>-`
 * fixtures with a random TOTP secret that exists only for this run; codes
 * go through the services' clock seam. afterAll removes what can be removed;
 * append-only rows (audit, supplier booking events) stay, and the bookings
 * they pin are closed so they appear in no queue.
 */

const RUN = runId();
const TAG = `zz-ops-${RUN}`;
const NET_MINOR = 24_013n;
const NET_MESSAGE = `Expected net ${NET_MINOR} above cap 1`;
const EVIDENCE = `CALL-${RUN}-evidence`;

/** RFC 6238 code for `at`, as an authenticator app would show it (as in approval.service.test.ts). */
function totpAt(secretB32: string, at: Date): string {
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
  let bits = 0;
  let value = 0;
  const bytes: number[] = [];
  for (const ch of secretB32.replace(/=+$/, "")) {
    value = (value << 5) | alphabet.indexOf(ch);
    bits += 5;
    if (bits >= 8) {
      bytes.push((value >>> (bits - 8)) & 255);
      bits -= 8;
    }
  }
  const counter = Buffer.alloc(8);
  counter.writeBigUInt64BE(BigInt(Math.floor(at.getTime() / 30_000)));
  const h = createHmac("sha1", Buffer.from(bytes)).update(counter).digest();
  const o = h[h.length - 1] & 0x0f;
  const n = ((h[o] & 0x7f) << 24) | (h[o + 1] << 16) | (h[o + 2] << 8) | h[o + 3];
  return String(n % 1_000_000).padStart(6, "0");
}

function roleActor(role: RoleCode, id?: string): Actor {
  return { type: "admin", id: id ?? uuidv7(), roles: [role], permissions: new Set(ROLE_PERMISSIONS[role]) };
}

/** Every key anywhere in a value. */
function keysOf(value: unknown, out = new Set<string>()): Set<string> {
  if (Array.isArray(value)) for (const v of value) keysOf(v, out);
  else if (value !== null && typeof value === "object") {
    for (const [k, v] of Object.entries(value)) {
      out.add(k);
      keysOf(v, out);
    }
  }
  return out;
}

const COST_KEYS = /^(expectedNet|chargedNet|netCost|marginSnapshot|errorMessage)/;

describe.skipIf(!dbEnabled)("operations console (B5)", () => {
  let prisma: typeof import("../../lib/db").prisma;
  let svc: typeof import("../../services/ops-queue.service").opsQueueService;
  let ops: typeof import("../../services/ops-queue.service");
  let supplierId: string;
  let n = 0;
  const day = (d: number, minutes = 0) => new Date(Date.UTC(2001, 0, d, 0, minutes));
  const created = { orders: [] as string[], items: [] as string[], bookings: [] as string[], payments: [] as string[], sagas: [] as string[] };

  async function order(phone = `+9199${String(Math.floor(Math.random() * 1e8)).padStart(8, "0")}`) {
    const tag = `${TAG}-${++n}`;
    const guest = await prisma.guest.create({ data: { id: uuidv7(), phoneE164: phone, fullName: TAG } });
    const o = await prisma.order.create({
      data: {
        id: uuidv7(),
        guestId: guest.id,
        reference: `OUT-ZZ${RUN.toUpperCase()}${n}`,
        rail: "self_serve",
        currency: "INR",
        subtotalInr: 1000n,
        subtotalAed: 45n,
        totalInr: 1000n,
        totalAed: 45n,
        netCostAed: NET_MINOR,
        leadName: `Lead ${tag}`,
        leadPhone: phone,
        leadEmail: `${tag}@example.test`,
      },
    });
    created.orders.push(o.id);
    const combo = await prisma.combo.create({ data: { id: uuidv7(), slug: tag, name: TAG, confirmation: "manual" } });
    const item = await prisma.orderItem.create({
      data: {
        id: uuidv7(),
        orderId: o.id,
        comboId: combo.id,
        titleSnapshot: `Desert test ${tag}`,
        tierSnapshot: "C",
        slugSnapshot: tag,
        kindSnapshot: "combo",
        confirmationSnapshot: "instant",
        fulfilmentModeSnapshot: "inquiry",
        freeCancellationHoursSnapshot: 24,
        durationMinutesSnapshot: 60,
        serviceDate: new Date("2030-02-10"),
        pax: { adult: 2, child: 0, infant: 0 },
        unitInr: 1000n,
        unitAed: 45n,
        totalInr: 1000n,
        totalAed: 45n,
        netCostAed: NET_MINOR,
        marginSnapshot: { netAedMinor: NET_MINOR.toString() },
      },
    });
    created.items.push(item.id);
    return { orderId: o.id, orderItemId: item.id, reference: o.reference, phone, leadName: o.leadName, leadEmail: o.leadEmail! };
  }

  async function booking(ids: { orderId: string; orderItemId: string }, state: string, over: Record<string, unknown> = {}) {
    const id = uuidv7();
    await prisma.supplierBooking.create({
      data: {
        id,
        orderId: ids.orderId,
        orderItemId: ids.orderItemId,
        supplierId,
        environment: "test",
        idempotencyKey: `${TAG}-${id}`,
        clientRef: `ZZ${id.slice(-12)}`,
        bookingKind: "live_book",
        afterReserve: "await_payment",
        state: state as never,
        tourExternalId: "1",
        offerExternalId: "777001",
        serviceDate: new Date("2030-02-10"),
        adults: 2,
        guestName: `Guest ${TAG}`,
        expectedNetMinor: NET_MINOR,
        expectedNetUsdMinor: 6600n,
        errorCode: "booking_cap",
        errorMessage: NET_MESSAGE,
        supplierBookingId: "9100001",
        updatedAt: day(2),
        ...over,
      },
    });
    created.bookings.push(id);
    return id;
  }

  async function saga(ids: { orderId: string; orderItemId: string }, state: string, over: Record<string, unknown> = {}) {
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
        capturedAt: day(1),
        threeDs: "not_applicable",
        risk: "normal",
      } as never,
    });
    created.payments.push(paymentId);
    const id = uuidv7();
    await prisma.paymentSaga.create({ data: { id, orderId: ids.orderId, orderItemId: ids.orderItemId, paymentId, rail: "inr_pacb", state, createdAt: day(1), ...over } });
    created.sagas.push(id);
    return { sagaId: id, paymentId };
  }

  async function doc(bookingId: string, ids: { orderId: string; orderItemId: string }, status: string, over: Record<string, unknown> = {}) {
    const id = uuidv7();
    await prisma.supplierDocument.create({
      data: { id, supplierBookingId: bookingId, orderId: ids.orderId, orderItemId: ids.orderItemId, kind: "ticket_codes", version: 1, status, source: "document_read", createdAt: day(3), ...over },
    });
    return id;
  }

  async function cancellation(ids: { orderId: string; orderItemId: string }, kind: "supported" | "exception", status: string, over: Record<string, unknown> = {}) {
    const id = uuidv7();
    await prisma.cancellationRequest.create({
      data: { id, orderId: ids.orderId, orderItemId: ids.orderItemId, kind, status, requestedVia: "customer", updatedAt: day(4), closedAt: ["refunded", "refused", "exception_closed"].includes(status) ? day(4) : null, ...over },
    });
    return id;
  }

  // Scenarios, one order each.
  const s = {} as Record<string, { orderId: string; orderItemId: string; reference: string; phone: string; leadName: string; leadEmail: string; id: string; extra?: string }>;

  beforeAll(async () => {
    assertDisposableDb();
    ({ prisma } = await import("../../lib/db"));
    ops = await import("../../services/ops-queue.service");
    svc = ops.opsQueueService;
    supplierId = uuidv7();
    await prisma.supplier.create({ data: { id: supplierId, code: TAG, name: "TravelDesk (console test)", source: "api", adapter: "traveldesk" } });

    // (a) paid, not confirmed: a captured saga, and a booking awaiting payment whose capture is verified.
    let o = await order();
    s.paidSaga = { ...o, id: (await saga(o, "captured")).sagaId };
    o = await order();
    await saga(o, "reserved");
    s.paidBooking = { ...o, id: await booking(o, "awaiting_payment") };
    // (b) unknown outcome: a booking and a capture.
    o = await order();
    s.unknownBooking = { ...o, id: await booking(o, "outcome_unknown", { attentionRequiredAt: day(5) }) };
    o = await order();
    s.unknownCapture = { ...o, id: (await saga(o, "capture_unknown")).sagaId };
    // (c) missing ticket: a confirmed booking whose codes are still pending, with attention.
    o = await order();
    const confirmed = await booking(o, "confirmed", { confirmedAt: day(3) });
    s.missingTicket = { ...o, id: await doc(confirmed, o, "pending", { attentionRequiredAt: day(5, 1) }), extra: confirmed };
    // (d) a failed refund and an open exception request.
    o = await order();
    const p = await saga(o, "refund_pending");
    const refundId = uuidv7();
    await prisma.refund.create({ data: { id: refundId, paymentId: p.paymentId, orderItemId: o.orderItemId, provider: "fake-inr-pacb", idempotencyKey: `${TAG}-${refundId}`, amountMinor: 1000n, currency: "INR", status: "failed", reason: "customer_cancellation", updatedAt: day(4) } });
    s.failedRefund = { ...o, id: refundId };
    o = await order();
    s.exception = { ...o, id: await cancellation(o, "exception", "exception_open", { attentionRequiredAt: day(5, 2) }) };
    // (e) attention on a notification, and a booking whose flag holds a confirm.
    o = await order();
    const notificationId = uuidv7();
    await prisma.notification.create({
      data: { id: notificationId, event: "TICKETS_READY", channel: "whatsapp", recipient: o.phone, orderId: o.orderId, status: "failed", createdAt: day(5), attentionRequiredAt: day(5, 3) },
    });
    s.notification = { ...o, id: notificationId };
    o = await order();
    s.heldBooking = { ...o, id: await booking(o, "awaiting_payment", { attentionRequiredAt: day(5, 4) }) };
    // Clearable: a confirmed booking flagged for a human. Late-accepted: the same, with the reconcile's alert (R-B5-6).
    o = await order();
    s.clearable = { ...o, id: await booking(o, "confirmed", { confirmedAt: day(3), attentionRequiredAt: day(5, 5) }) };
    o = await order();
    s.lateAccepted = { ...o, id: await booking(o, "confirmed", { confirmedAt: day(3), attentionRequiredAt: day(5, 6), errorCode: "late_acceptance" }) };
    await prisma.supplierBookingEvent.create({ data: { id: uuidv7(), supplierBookingId: s.lateAccepted.id, kind: "alert", detail: { reason: "late_acceptance", supplierStatus: "CONFIRMED" } } });
  });

  afterAll(async () => {
    if (!prisma) return;
    const orders = { in: created.orders };
    await prisma.cancellationRequest.deleteMany({ where: { orderId: orders } });
    await prisma.customerRemedy.deleteMany({ where: { orderId: orders } });
    await prisma.refund.deleteMany({ where: { orderItemId: { in: created.items } } });
    await prisma.supplierDocument.deleteMany({ where: { orderId: orders } });
    await prisma.notification.deleteMany({ where: { orderId: orders } });
    await prisma.paymentSaga.deleteMany({ where: { id: { in: created.sagas } } });
    await prisma.payment.deleteMany({ where: { id: { in: created.payments } } });
    await prisma.supplierJob.deleteMany({ where: { supplierBookingId: { in: created.bookings } } });
    // Bookings with append-only events stay, closed, so they appear in no queue.
    const pinned = new Set((await prisma.supplierBookingEvent.findMany({ where: { supplierBookingId: { in: created.bookings } }, select: { supplierBookingId: true } })).map((e) => e.supplierBookingId));
    await prisma.supplierBooking.deleteMany({ where: { id: { in: created.bookings.filter((id) => !pinned.has(id)) } } });
    await prisma.supplierBooking.updateMany({ where: { id: { in: [...pinned] } }, data: { state: "manual_review", closedAt: new Date(), attentionRequiredAt: null, errorCode: "test_retired" } });
    const kept = new Set((await prisma.supplierBooking.findMany({ where: { id: { in: [...pinned] } }, select: { orderItemId: true } })).map((b) => b.orderItemId));
    await prisma.orderItem.deleteMany({ where: { id: { in: created.items.filter((id) => !kept.has(id)) } } });
    await prisma.order.deleteMany({ where: { id: orders, items: { none: {} } } });
    await prisma.guest.deleteMany({ where: { fullName: TAG, orders: { none: {} } } });
    await prisma.combo.deleteMany({ where: { name: TAG, orderItems: { none: {} } } });
    if ((await prisma.supplierBooking.count({ where: { supplierId } })) === 0) await prisma.supplier.delete({ where: { id: supplierId } });
    await prisma.$disconnect();
  });

  /* ---------------------------------------------------------------- queues */

  describe("queues and role matrix", () => {
    const page = { page: 1, pageSize: 25 };
    async function keys(actor: Actor, queue: (typeof import("../../services/ops-queue.service").QUEUES)[number]) {
      const r = await svc.list(actor, queue, page);
      return { r, keys: r.rows.map((x) => x.key) };
    }

    it("a role without orders.view_all sees no queue and no order", async () => {
      for (const role of ["content"] as RoleCode[]) {
        await expect(svc.list(roleActor(role), "attention")).rejects.toMatchObject({ code: "FORBIDDEN" });
        await expect(svc.counts(roleActor(role))).rejects.toMatchObject({ code: "FORBIDDEN" });
        await expect(svc.orderDetail(roleActor(role), s.paidSaga.reference)).rejects.toMatchObject({ code: "FORBIDDEN" });
      }
    });

    it("each queue holds its rows, oldest first, with the order link, item, date and state as text", async () => {
      const actor = roleActor("readonly");
      const a = await keys(actor, "paid_unconfirmed");
      expect(a.keys).toEqual(expect.arrayContaining([`payment_saga:${s.paidSaga.id}`, `supplier_booking:${s.paidBooking.id}`]));
      const row = a.r.rows.find((x) => x.key === `payment_saga:${s.paidSaga.id}`)!;
      expect(row).toMatchObject({
        orderReference: s.paidSaga.reference,
        itemTitle: expect.stringContaining(TAG),
        serviceDate: "2030-02-10",
        state: "captured",
        stateLabel: "Paid, booking not started",
        tone: "warning",
        href: `/admin/bookings/${s.paidSaga.reference}#item-${s.paidSaga.orderItemId}`,
      });
      // The awaiting-payment booking without a verified capture is not "paid".
      expect(a.keys).not.toContain(`supplier_booking:${s.heldBooking.id}`);

      const b = await keys(actor, "unknown_outcome");
      expect(b.keys).toEqual(expect.arrayContaining([`supplier_booking:${s.unknownBooking.id}`, `payment_saga:${s.unknownCapture.id}`]));
      const c = await keys(actor, "missing_ticket");
      expect(c.keys).toContain(`supplier_document:${s.missingTicket.id}`);
      const d = await keys(actor, "refunds");
      expect(d.keys).toEqual(expect.arrayContaining([`refund:${s.failedRefund.id}`, `cancellation_request:${s.exception.id}`]));
      const e = await keys(actor, "attention");
      expect(e.keys).toEqual(
        expect.arrayContaining([
          `supplier_booking:${s.unknownBooking.id}`,
          `supplier_document:${s.missingTicket.id}`,
          `cancellation_request:${s.exception.id}`,
          `notification:${s.notification.id}`,
          `supplier_booking:${s.heldBooking.id}`,
        ]),
      );
      const mine = e.r.rows.filter((x) => x.orderReference?.startsWith(`OUT-ZZ${RUN.toUpperCase()}`)).map((x) => x.since);
      expect([...mine].sort()).toEqual(mine);

      const counts = await svc.counts(actor);
      for (const q of ops.QUEUES) expect(counts[q]).toBeGreaterThan(0);
    });

    it("customer contact is masked without customers.view_pii and shown with it", async () => {
      const masked = (await svc.list(roleActor("readonly"), "paid_unconfirmed", page)).rows.find((x) => x.id === s.paidSaga.id)!;
      expect(masked.contact).toEqual({ name: null, phone: `+91 ••••• •${s.paidSaga.phone.slice(-4)}`, email: null, masked: true });
      const shown = (await svc.list(roleActor("ops"), "paid_unconfirmed", page)).rows.find((x) => x.id === s.paidSaga.id)!;
      expect(shown.contact).toEqual({ name: s.paidSaga.leadName, phone: s.paidSaga.phone, email: s.paidSaga.leadEmail, masked: false });
      // A queue row never carries a net figure or supplier text, whatever the role.
      const admin = await svc.list(roleActor("admin"), "unknown_outcome", page);
      expect([...keysOf(admin.rows)].filter((k) => COST_KEYS.test(k))).toEqual([]);
      expect(JSON.stringify(admin.rows)).not.toContain(NET_MINOR.toString());
    });

    it("pages are small and bounded", async () => {
      const r = await svc.list(roleActor("readonly"), "attention", { page: 1, pageSize: 2 });
      expect(r.rows).toHaveLength(2);
      expect(r.total).toBeGreaterThanOrEqual(5);
      expect((await svc.list(roleActor("readonly"), "attention", { page: 1, pageSize: 1000 })).pageSize).toBe(ops.QUEUE_MAX_PAGE_SIZE);
    });
  });

  /* ---------------------------------------------------------------- detail */

  describe("order detail: net costs and contact by role", () => {
    it("without suppliers.costs.view no net cost, margin, wallet or supplier error text is returned", async () => {
      for (const role of ["readonly", "ops", "agent", "agent_lead"] as RoleCode[]) {
        const d = (await svc.orderDetail(roleActor(role), s.unknownBooking.reference))!;
        expect(d.viewer.costs).toBe(false);
        expect([...keysOf(d)].filter((k) => COST_KEYS.test(k)), role).toEqual([]);
        expect(d.wallet).toBeNull();
        const text = JSON.stringify(d);
        expect(text).not.toContain(NET_MINOR.toString());
        expect(text).not.toContain(NET_MESSAGE);
        expect(d.bookings[0]).toMatchObject({ id: s.unknownBooking.id, state: "outcome_unknown", errorCode: "booking_cap" });
      }
    });

    it("with suppliers.costs.view the net figures, margin and wallet are there", async () => {
      for (const role of ["finance", "admin"] as RoleCode[]) {
        const d = (await svc.orderDetail(roleActor(role), s.unknownBooking.reference))!;
        expect(d.viewer.costs).toBe(true);
        expect(d.order).toMatchObject({ netCostAed: NET_MINOR.toString() });
        expect(d.items[0]).toMatchObject({ netCostAed: NET_MINOR.toString(), marginSnapshot: { netAedMinor: NET_MINOR.toString() } });
        expect(d.bookings[0]).toMatchObject({ expectedNetMinor: NET_MINOR.toString(), errorMessage: NET_MESSAGE });
        expect(d.wallet).toEqual([]);
      }
    });

    it("contact, guest name and message recipients are masked without customers.view_pii", async () => {
      const masked = (await svc.orderDetail(roleActor("readonly"), s.notification.reference))!;
      expect(masked.order.contact).toEqual({ name: null, phone: `+91 ••••• •${s.notification.phone.slice(-4)}`, email: null, masked: true });
      expect(masked.notifications[0].recipient).toBe(`+91 ••••• •${s.notification.phone.slice(-4)}`);
      const text = JSON.stringify(masked);
      for (const v of [s.notification.phone, s.notification.leadName, s.notification.leadEmail, `Guest ${TAG}`]) expect(text).not.toContain(v);
      expect([...keysOf(masked)]).not.toContain("guestName");

      const shown = (await svc.orderDetail(roleActor("ops"), s.unknownBooking.reference))!;
      expect(shown.order.contact).toMatchObject({ name: s.unknownBooking.leadName, phone: s.unknownBooking.phone, masked: false });
      expect(shown.bookings[0]).toMatchObject({ guestName: `Guest ${TAG}` });
    });

    it("an unknown reference is null, not an error", async () => {
      expect(await svc.orderDetail(roleActor("readonly"), `OUT-NOPE${RUN}`)).toBeNull();
    });
  });

  /* ------------------------------------------------------- ticket actions */

  describe("ticket actions (R-B4-5)", () => {
    it("requestRefetch needs tickets.resend, opens a new version and is audited by ids and the reason code", async () => {
      await expect(svc.requestRefetch(roleActor("agent"), s.missingTicket.id, "staff_check")).rejects.toMatchObject({ code: "FORBIDDEN" });
      const actor = roleActor("ops");
      // A failed tickets PDF, so the refetch opens a fresh pending version after it.
      const pdfId = await doc(s.missingTicket.extra!, s.missingTicket, "failed", { kind: "tickets_pdf", source: "pdf_download" });
      await svc.requestRefetch(actor, pdfId, "customer_reported");
      const versions = await prisma.supplierDocument.findMany({ where: { supplierBookingId: s.missingTicket.extra!, kind: "tickets_pdf" }, orderBy: { version: "asc" } });
      expect(versions.map((v) => [v.version, v.status])).toEqual([
        [1, "failed"],
        [2, "pending"],
      ]);
      const row = await prisma.auditLog.findFirst({ where: { action: "tickets.refetch_requested", entityId: pdfId }, orderBy: { createdAt: "desc" } });
      expect(row).toMatchObject({ actorId: actor.id, entityType: "supplier_document" });
      expect(row!.after).toEqual({ fields: [], ids: { documentId: pdfId }, codes: { reason: "customer_reported" } });
      await expect(svc.requestRefetch(actor, pdfId, "because" as never)).rejects.toMatchObject({ code: "VALIDATION_FAILED" });
    });

    it("deliberateRead needs tickets.resend; with the documents job's wiring and no live supplier it reads nothing, and says so", async () => {
      await expect(svc.deliberateRead(roleActor("agent"), s.missingTicket.extra!)).rejects.toMatchObject({ code: "FORBIDDEN" });
      const actor = roleActor("ops");
      // The default wiring is the documents job's: no TravelDesk source unless it is live and configured.
      expect(ops.documentDepsFromEnv().source).toBeNull();
      expect(await svc.deliberateRead(actor, s.missingTicket.extra!)).toEqual({ outcome: "no_source" });
      const row = await prisma.auditLog.findFirst({ where: { action: "tickets.deliberate_read_requested", entityId: s.missingTicket.extra! } });
      expect(row!.after).toEqual({ fields: [], ids: { supplierBookingId: s.missingTicket.extra! }, codes: { outcome: "no_source" } });
      // Only a confirmed booking is read.
      await expect(svc.deliberateRead(actor, s.unknownBooking.id)).rejects.toMatchObject({ code: "CONFLICT" });
    });
  });

  /* ------------------------------------------------- privileged resolution */

  describe("privileged resolution", () => {
    const secrets = new Map<string, string>();
    const staff: Record<string, StaffFixture> = {};
    let clock = Date.UTC(2026, 10, 2, 6, 0, 0);
    const tick = () => new Date((clock += 90_000));
    const admin = (label: string): Actor => ({ type: "admin", id: staff[label].id, roles: ["admin"], permissions: new Set(ROLE_PERMISSIONS.admin) });
    const code = (label: string, at: Date) => totpAt(secrets.get(label)!, at);
    const audits = (action: string, entityId: string) => prisma.auditLog.findMany({ where: { action, entityId }, orderBy: { createdAt: "asc" } });

    beforeAll(async () => {
      const { encryptSecret, generateTotpSecret } = await import("../../lib/crypto");
      for (const label of ["a", "b"]) {
        staff[label] = await createStaff(RUN, label, ["admin"]);
        const secret = generateTotpSecret();
        secrets.set(label, secret);
        await prisma.adminUser.update({ where: { id: staff[label].id }, data: { totpSecretEncrypted: encryptSecret(secret) } });
      }
      staff.ops = await createStaff(RUN, "ops", ["ops"]);
    });

    afterAll(async () => {
      if (!prisma) return;
      const ids = Object.values(staff).map((x) => x.id);
      const approvals = await prisma.privilegedApproval.findMany({ where: { OR: [{ requestedBy: { in: ids } }, { approvedBy: { in: ids } }] }, select: { id: true } });
      await prisma.idempotencyKey.deleteMany({ where: { scope: "privileged_use", key: { in: approvals.map((x) => `privileged_use:${x.id}`) } } });
      await prisma.privilegedApproval.deleteMany({ where: { id: { in: approvals.map((x) => x.id) } } });
      await prisma.rateLimitBucket.deleteMany({ where: { key: { in: ids.map((id) => `admin_totp:${id}`) } } }).catch(() => {});
      await prisma.idempotencyKey.deleteMany({ where: { scope: "admin_totp", OR: ids.map((id) => ({ key: { startsWith: `totp:${id}:` } })) } });
      await cleanupPeople(RUN);
    });

    const clearInput = (target: string, targetId: string) => ({ action: "clear_attention", target, targetId, reasonCode: "verified_with_operator", evidence: EVIDENCE });

    it("refused: a role without the permission, a wrong code, and a flag that holds a money step; each audited", async () => {
      const opsActor: Actor = { type: "admin", id: staff.ops.id, roles: ["ops"], permissions: new Set(ROLE_PERMISSIONS.ops) };
      expect(await svc.requestResolution(opsActor, clearInput("supplier_booking", s.clearable.id), { environment: "test", totpCode: "123456", now: tick() })).toEqual({
        status: "refused",
        reason: "forbidden",
      });
      const at = tick();
      const wrong = code("a", at) === "000000" ? "111111" : "000000";
      expect(await svc.requestResolution(admin("a"), clearInput("supplier_booking", s.clearable.id), { environment: "test", totpCode: wrong, now: at })).toEqual({
        status: "refused",
        reason: "step_up_required",
      });
      expect(await svc.requestResolution(admin("a"), clearInput("supplier_booking", s.heldBooking.id), { environment: "test", totpCode: code("a", tick()), now: tick() })).toEqual({
        status: "refused",
        reason: "holds_money_step",
      });
      expect(await svc.requestResolution(admin("a"), { action: "close_exception", targetId: s.exception.id, outcome: "refunded", evidence: EVIDENCE }, { environment: "test", totpCode: "123456" }).catch((e) => e.code)).toBe(
        "VALIDATION_FAILED",
      );

      const refusedBooking = await audits("booking.privileged_resolution.refused", s.clearable.id);
      expect(refusedBooking.map((r) => (r.after as { codes: { reason: string } }).codes.reason)).toEqual(["forbidden", "step_up_required"]);
      expect((await audits("booking.privileged_resolution.refused", s.heldBooking.id)).map((r) => (r.after as { codes: { reason: string } }).codes.reason)).toEqual(["holds_money_step"]);
      // Nothing changed.
      expect((await prisma.supplierBooking.findUniqueOrThrow({ where: { id: s.clearable.id } })).attentionRequiredAt).not.toBeNull();
      expect((await prisma.supplierBooking.findUniqueOrThrow({ where: { id: s.heldBooking.id } })).attentionRequiredAt).not.toBeNull();
    });

    it("applied (test environment): clears the one flag, records an operator event, and keeps the evidence only as a keyed hash", async () => {
      const at = tick();
      const r = await svc.requestResolution(admin("a"), clearInput("supplier_booking", s.clearable.id), { environment: "test", totpCode: code("a", at), now: at });
      expect(r.status).toBe("applied");
      const approvalId = (r as { approvalId: string }).approvalId;
      const b = await prisma.supplierBooking.findUniqueOrThrow({ where: { id: s.clearable.id } });
      expect(b.attentionRequiredAt).toBeNull();
      expect(b.state).toBe("confirmed");
      const event = await prisma.supplierBookingEvent.findFirst({ where: { supplierBookingId: s.clearable.id, kind: "operator_action" } });
      expect(event).toMatchObject({ actor: staff.a.id, fromState: "confirmed", toState: "confirmed", detail: { via: "clear_attention", reason: "verified_with_operator", approvalId } });

      const [applied] = await audits("booking.privileged_resolution.applied", s.clearable.id);
      const after = applied.after as { fields: string[]; ids: Record<string, string>; codes: Record<string, string>; hashes: Record<string, string> };
      expect(after.fields).toEqual(["attentionRequiredAt"]);
      expect(after.ids).toEqual({ orderId: s.clearable.orderId, approvalId });
      expect(after.codes).toEqual({ action: "clear_attention", reasonCode: "verified_with_operator" });
      expect(after.hashes.evidenceHash).toMatch(/^[0-9a-f]{64}$/);
      const approval = await prisma.privilegedApproval.findUniqueOrThrow({ where: { id: approvalId } });
      expect(after.hashes.payloadHash).toBe(approval.payloadHash);
      expect(Object.keys(approval.payload as object).sort()).toEqual(["action", "attentionAt", "evidenceHash", "orderId", "reasonCode", "target", "targetId"]);
      // The evidence text is nowhere: not in the approval payload, not in any audit row of this target.
      expect(JSON.stringify(approval.payload)).not.toContain(EVIDENCE);
      const all = await prisma.auditLog.findMany({ where: { OR: [{ entityId: s.clearable.id }, { entityId: approvalId }] } });
      expect(JSON.stringify(all, (_k, v) => (typeof v === "bigint" ? v.toString() : v))).not.toContain(EVIDENCE);
      // A second request now finds nothing to clear.
      expect(await svc.requestResolution(admin("a"), clearInput("supplier_booking", s.clearable.id), { environment: "test", totpCode: code("a", tick()), now: tick() })).toEqual({
        status: "refused",
        reason: "not_flagged",
      });
    });

    it("refused: the recovering states and a late-accepted booking keep their hold, in the request and in the engine (R-B5-6)", async () => {
      for (const id of [s.unknownBooking.id]) {
        expect(await svc.requestResolution(admin("a"), clearInput("supplier_booking", id), { environment: "test", totpCode: "123456", now: tick() })).toEqual({ status: "refused", reason: "holds_money_step" });
      }
      expect(await svc.requestResolution(admin("a"), clearInput("supplier_booking", s.lateAccepted.id), { environment: "test", totpCode: "123456", now: tick() })).toEqual({
        status: "refused",
        reason: "late_acceptance_hold",
      });
      expect((await audits("booking.privileged_resolution.refused", s.lateAccepted.id)).map((r) => (r.after as { codes: { reason: string } }).codes.reason)).toEqual(["late_acceptance_hold"]);
      // The engine refuses on its own too, whatever a caller asks.
      const b = await prisma.supplierBooking.findUniqueOrThrow({ where: { id: s.lateAccepted.id } });
      const engine = (await import("../../services/supplier-booking.service")).supplierBookingService;
      const opts = { orderId: s.lateAccepted.orderId, expectedAttentionAt: b.attentionRequiredAt!, actorId: staff.a.id, reasonCode: "handled_offline", approvalId: uuidv7() };
      expect(await prisma.$transaction((tx) => engine.clearAttention(tx, s.lateAccepted.id, opts))).toBe("late_accepted");
      const u = await prisma.supplierBooking.findUniqueOrThrow({ where: { id: s.unknownBooking.id } });
      expect(await prisma.$transaction((tx) => engine.clearAttention(tx, s.unknownBooking.id, { ...opts, orderId: s.unknownBooking.orderId, expectedAttentionAt: u.attentionRequiredAt! }))).toBe("not_matched");
      expect((await prisma.supplierBooking.findUniqueOrThrow({ where: { id: s.lateAccepted.id } })).attentionRequiredAt).not.toBeNull();
      expect((await prisma.supplierBooking.findUniqueOrThrow({ where: { id: s.unknownBooking.id } })).attentionRequiredAt).not.toBeNull();
    });

    it("pending (production): waits for a second approver; the requester cannot approve; a second admin's approval closes the exception request", async () => {
      const t1 = tick();
      const input = { action: "close_exception", targetId: s.exception.id, outcome: "handled_offline", evidence: EVIDENCE };
      const r = await svc.requestResolution(admin("a"), input, { environment: "production", totpCode: code("a", t1), now: t1 });
      expect(r.status).toBe("pending");
      const approvalId = (r as { approvalId: string }).approvalId;
      expect(await prisma.cancellationRequest.findUniqueOrThrow({ where: { id: s.exception.id } })).toMatchObject({ status: "exception_open", closedAt: null });
      expect((await audits("booking.privileged_resolution.pending", s.exception.id)).length).toBe(1);
      // The detail page lists it for a second approver.
      const d = (await svc.orderDetail(admin("b"), s.exception.reference, { now: t1 }))!;
      expect(d.pendingResolutions).toEqual([expect.objectContaining({ id: approvalId, action: "close_exception", target: "cancellation_request", targetId: s.exception.id, code: "handled_offline" })]);

      const t2 = tick();
      expect(await svc.approveResolution(admin("a"), approvalId, code("a", t2), { now: t2 })).toEqual({ status: "refused", reason: "same_person" });
      expect((await prisma.cancellationRequest.findUniqueOrThrow({ where: { id: s.exception.id } })).status).toBe("exception_open");

      const t3 = tick();
      expect(await svc.approveResolution(admin("b"), approvalId, code("b", t3), { now: t3 })).toEqual({ status: "applied", approvalId });
      expect(await prisma.cancellationRequest.findUniqueOrThrow({ where: { id: s.exception.id } })).toMatchObject({ status: "exception_closed", reasonCode: "handled_offline", attentionRequiredAt: null });
      const [applied] = await audits("booking.privileged_resolution.applied", s.exception.id);
      expect(applied.actorId).toBe(staff.b.id);
      expect((applied.after as { codes: Record<string, string> }).codes).toEqual({ action: "close_exception", outcome: "handled_offline" });
      // An approval is used once.
      await expect(svc.approveResolution(admin("b"), approvalId, code("b", tick()), { now: tick() })).rejects.toMatchObject({ code: "CONFLICT" });
    });

    it("an approval asked against an older flag is not applied once the row changed", async () => {
      const t1 = tick();
      const r = await svc.requestResolution(admin("a"), clearInput("notification", s.notification.id), { environment: "production", totpCode: code("a", t1), now: t1 });
      expect(r.status).toBe("pending");
      await prisma.notification.update({ where: { id: s.notification.id }, data: { attentionRequiredAt: day(6) } });
      const t2 = tick();
      await expect(svc.approveResolution(admin("b"), (r as { approvalId: string }).approvalId, code("b", t2), { now: t2 })).rejects.toMatchObject({ code: "CONFLICT" });
      expect((await prisma.notification.findUniqueOrThrow({ where: { id: s.notification.id } })).attentionRequiredAt).toEqual(day(6));
    });
  });
});
