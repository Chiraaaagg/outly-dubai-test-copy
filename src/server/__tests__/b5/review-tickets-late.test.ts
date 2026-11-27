import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { createHmac, randomBytes } from "node:crypto";
import type { Actor } from "../../lib/actor";
import { uuidv7 } from "../../lib/ids";
import { ROLE_PERMISSIONS } from "../../lib/permissions";
import { resetEnvCache } from "@/server/lib/env";
import type { ServableDocument } from "@/server/services/document.service";
import { apiRequest, assertDisposableDb, cleanupPeople, createCustomer, createStaff, dbEnabled, params, runId, syntheticPhone, type CustomerFixture, type StaffFixture } from "../helpers/fixtures";
import { db, forbidNetwork, publishedProduct } from "../security/_mercury-fixtures";
import { cleanupCustomerRows, guestSession, instantOrder, setupCustomerFixtures, type CustomerFixtures, type InstantOrder } from "./customer-fixtures";

/**
 * B5 review fixes in b7a8ea0 (doc 27 §2), on the disposable database:
 *
 *  - R-B5-8: a booking that holds tickets (stored codes, or a valid ticket
 *    document) is `tickets_issued` for cancellation, whatever the offer says.
 *    After a verified cancel its documents answer 404 to the customer and the
 *    guest, and staff still reach them. Owner decision (doc 22 §32.12): the
 *    guest's grants stay valid after the cancel, so the guest can follow the
 *    refund on the status page.
 *  - R-B5-16: a late-accepted booking may be cleared, with the dedicated
 *    reason only, once it is settled (guard-releasing, or confirmed with no
 *    other live attempt); never in recovering or holding states; the reason
 *    is refused on any other row. (The engine side, `applySupplierState`
 *    after the clear, is in supplier-booking.service.test.ts.)
 *
 * Every row is synthetic (customer-fixtures.ts). Document bytes come from a
 * mocked `documentService.readServable`; the document rows are real, so
 * ownership and visibility are resolved from the database.
 */

const run = runId();
const runOctet = (Number.parseInt(run.slice(-2), 16) % 200) + 20;
let ipSeq = 0;
const nextIp = () => `198.18.${runOctet}.${(ipSeq++ % 250) + 1}`;
const savedEnv = { ...process.env };
const EVIDENCE = `CALL-${run}-late`;
const PDF = new TextEncoder().encode("%PDF-1.7\n% zz synthetic ticket\n%%EOF\n");

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

type Prisma = Awaited<ReturnType<typeof db>>;

describe.skipIf(!dbEnabled)("B5 review fixes: stored tickets and late acceptance (R-B5-8, R-B5-16)", () => {
  let prisma: Prisma;
  let fx: CustomerFixtures;
  let A: CustomerFixture;
  let opsStaff: StaffFixture;
  let svc: typeof import("@/server/services/cancellation.service");
  let capability: typeof import("@/server/services/capability.service");
  let ops: typeof import("@/server/services/ops-queue.service").opsQueueService;
  const staff: Record<string, StaffFixture> = {};
  let secret = "";
  let clock = Date.UTC(2026, 10, 3, 9, 0, 0);
  const tick = () => new Date((clock += 90_000));
  const admin = (): Actor => ({ type: "admin", id: staff.a.id, roles: ["admin"], permissions: new Set(ROLE_PERMISSIONS.admin) });

  function order(label: string, over: Parameters<typeof instantOrder>[3] extends infer T ? Partial<T> : never = {}): Promise<InstantOrder> {
    return instantOrder(prisma, run, fx, { label, owner: { kind: "customer", customerId: A.id }, sagaState: "fulfilled", capturedMinor: 45_000n, bookingState: "confirmed", issuesTicketsAtConfirm: "no", ...over });
  }

  async function pdf(o: InstantOrder, status: "valid" | "pending" = "valid") {
    const id = uuidv7();
    await prisma.supplierDocument.create({
      data: {
        id,
        supplierBookingId: o.bookingId!,
        orderId: o.id,
        orderItemId: o.itemId,
        kind: "tickets_pdf",
        version: 1,
        status,
        source: "pdf_download",
        ...(status === "valid" ? { storageKey: `test/${randomBytes(16).toString("hex")}`, contentType: "application/pdf", byteSize: PDF.byteLength, sha256: randomBytes(32).toString("hex") } : {}),
        customerVisible: true,
      },
    });
    return id;
  }

  async function storedCodes(o: InstantOrder) {
    const documentId = uuidv7();
    await prisma.supplierDocument.create({
      data: { id: documentId, supplierBookingId: o.bookingId!, orderId: o.id, orderItemId: o.itemId, kind: "ticket_codes", version: 1, status: "pending", source: "confirm_response", customerVisible: false },
    });
    await prisma.supplierTicketCode.create({
      data: {
        id: uuidv7(),
        documentId,
        supplierBookingId: o.bookingId!,
        unitIndex: 0,
        ticketFor: "adult",
        codeCiphertext: `v2.ticket_codes.zz.${randomBytes(6).toString("hex")}.${randomBytes(6).toString("hex")}.${randomBytes(6).toString("hex")}`,
        codeKeyId: "zz",
        codeHash: randomBytes(32).toString("hex"),
      },
    });
  }

  async function grantCookie(orderId: string, purpose: "view_status" | "download_tickets") {
    const g = await capability.capabilityService.mint(prisma, { orderId, purpose, issuedFor: "status_notification", supersede: "after_sent" });
    const e = await capability.capabilityService.exchange(g.token);
    if (!e.ok) throw new Error("exchange refused");
    return { grantId: g.grantId, cookie: `outlyy_ticket_access=${capability.addAccessEntry(undefined, e.cookieValue)!.value}` };
  }

  async function download(id: string, cookie: string) {
    const { GET } = await import("@/app/api/tickets/documents/[id]/route");
    return GET(apiRequest(`/api/tickets/documents/${id}`, { cookie, headers: { "x-real-ip": nextIp() } }), params({ id }));
  }

  async function status(reference: string, cookie: string) {
    const { GET } = await import("@/app/api/orders/[reference]/status/route");
    return GET(apiRequest(`/api/orders/${reference}/status`, { cookie, headers: { "x-real-ip": nextIp() } }), params({ reference }));
  }

  beforeAll(async () => {
    assertDisposableDb();
    forbidNetwork();
    process.env.TRUST_PROXY_IP_HEADERS = "true";
    resetEnvCache();
    prisma = await db();
    svc = await import("@/server/services/cancellation.service");
    capability = await import("@/server/services/capability.service");
    ops = (await import("@/server/services/ops-queue.service")).opsQueueService;
    fx = await setupCustomerFixtures(prisma, run, await publishedProduct());
    A = await createCustomer(run, syntheticPhone(run, 81));
    opsStaff = await createStaff(run, "tl-ops", ["ops"]);
    staff.a = await createStaff(run, "tl-a", ["admin"]);
    const { encryptSecret, generateTotpSecret } = await import("@/server/lib/crypto");
    secret = generateTotpSecret();
    await prisma.adminUser.update({ where: { id: staff.a.id }, data: { totpSecretEncrypted: encryptSecret(secret) } });
    const { documentService } = await import("@/server/services/document.service");
    vi.spyOn(documentService, "readServable").mockImplementation(async (documentId: string): Promise<ServableDocument> => {
      const row = await prisma.supplierDocument.findUnique({ where: { id: documentId } });
      if (!row || !row.orderId || !row.orderItemId) return { kind: "unavailable", reason: "not_found" };
      return { kind: "ok", bytes: PDF, contentType: "application/pdf", document: { id: row.id, orderId: row.orderId, orderItemId: row.orderItemId, kind: row.kind, version: row.version } };
    });
    vi.spyOn(documentService, "listForOrder").mockImplementation(async () => []);
  });

  afterAll(async () => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    process.env = { ...savedEnv };
    resetEnvCache();
    if (!prisma) return;
    const approvals = await prisma.privilegedApproval.findMany({ where: { requestedBy: staff.a?.id }, select: { id: true } });
    await prisma.idempotencyKey.deleteMany({ where: { scope: "privileged_use", key: { in: approvals.map((x) => `privileged_use:${x.id}`) } } });
    await prisma.privilegedApproval.deleteMany({ where: { id: { in: approvals.map((x) => x.id) } } });
    if (staff.a) await prisma.idempotencyKey.deleteMany({ where: { scope: "admin_totp", key: { startsWith: `totp:${staff.a.id}:` } } });
    if (staff.a) await prisma.rateLimitBucket.deleteMany({ where: { key: `admin_totp:${staff.a.id}` } }).catch(() => {});
    if (fx) {
      const orderIds = fx.orders.map((o) => o.id);
      const bookingIds = (await prisma.supplierBooking.findMany({ where: { supplierId: fx.supplierId }, select: { id: true } })).map((b) => b.id);
      await prisma.supplierTicketCode.deleteMany({ where: { supplierBookingId: { in: bookingIds } } });
      await prisma.supplierDocument.deleteMany({ where: { orderId: { in: orderIds } } });
      // Bookings with append-only events (the alerts and operator actions above) stay, closed and out of every
      // queue, with their orders (as console-ops.test.ts does). Everything else goes.
      const pinned = new Set((await prisma.supplierBookingEvent.findMany({ where: { supplierBookingId: { in: bookingIds } }, select: { supplierBookingId: true } })).map((e) => e.supplierBookingId));
      if (pinned.size === 0) await cleanupCustomerRows(prisma, fx);
      else {
        await prisma.supplierBooking.updateMany({ where: { id: { in: [...pinned] } }, data: { state: "manual_review", closedAt: new Date(), attentionRequiredAt: null, errorCode: "test_retired" } });
        const kept = new Set((await prisma.supplierBooking.findMany({ where: { id: { in: [...pinned] } }, select: { orderId: true } })).map((b) => b.orderId));
        await prisma.cancellationRequest.deleteMany({ where: { orderId: { in: orderIds } } });
        await prisma.guestCapabilityGrant.deleteMany({ where: { orderId: { in: orderIds } } });
        await prisma.supplierJob.deleteMany({ where: { supplierBookingId: { in: bookingIds } } });
        await prisma.supplierBooking.deleteMany({ where: { id: { in: bookingIds.filter((id) => !pinned.has(id)) } } });
        const removable = fx.orders.filter((o) => !kept.has(o.id));
        const ids = removable.map((o) => o.id);
        await prisma.paymentSaga.deleteMany({ where: { orderId: { in: ids } } });
        await prisma.orderContactVerification.deleteMany({ where: { orderId: { in: ids } } });
        await prisma.payment.deleteMany({ where: { orderId: { in: ids } } });
        await prisma.orderItem.deleteMany({ where: { orderId: { in: ids } } });
        await prisma.quote.deleteMany({ where: { usedByOrderId: { in: ids } } });
        await prisma.order.deleteMany({ where: { id: { in: ids } } });
        await prisma.productSupplierMapping.deleteMany({ where: { id: { in: removable.map((o) => o.mappingId) } } });
        await prisma.guest.deleteMany({ where: { id: { in: fx.guests }, orders: { none: {} } } });
        await prisma.guestSession.deleteMany({ where: { id: { in: fx.guestSessions }, quotes: { none: {} } } }).catch(() => {});
      }
    }
    await cleanupPeople(run);
  });

  /* ----------------------------------------------------------------- R-B5-8 */

  describe("R-B5-8: stored tickets and a verified cancel", () => {
    it("a booking with a valid ticket document or stored codes is tickets_issued, even when the offer says no", async () => {
      const withPdf = await order("r8-pdf");
      await pdf(withPdf);
      const withCodes = await order("r8-codes");
      await storedCodes(withCodes);
      const pendingOnly = await order("r8-pending");
      await pdf(pendingOnly, "pending");
      const now = new Date();
      for (const [o, expected] of [
        [withPdf, "tickets_issued"],
        [withCodes, "tickets_issued"],
      ] as const) {
        const facts = (await svc.loadCancellationFacts(o.id)).get(o.itemId)!;
        expect(facts.issuesTicketsAtConfirm).toBe("no");
        expect(facts.ticketsStored).toBe(true);
        expect(svc.evaluateCancellation(facts, now)).toMatchObject({ kind: "not_eligible", reason: expected });
        const r = await svc.createCancellationService({ requestCancel: async () => {} }).request({ orderId: o.id, orderItemId: o.itemId, kind: "cancel", via: "customer" });
        expect(r).toEqual({ ok: false, reason: "not_eligible", ineligible: expected });
        expect(await prisma.cancellationRequest.count({ where: { orderItemId: o.itemId } })).toBe(0);
      }
      // A document still being fetched is not a ticket held.
      const facts = (await svc.loadCancellationFacts(pendingOnly.id)).get(pendingOnly.itemId)!;
      expect(facts.ticketsStored).toBe(false);
      expect(svc.evaluateCancellation(facts, now)).toMatchObject({ kind: "eligible", refundMinor: "45000" });
    });

    it("after a verified cancel the documents answer 404 to the customer and the guest, and 200 to staff; the guest's grants stay valid", async () => {
      const g = await guestSession(prisma, fx);
      const o = await order("r8-cancel", { owner: { kind: "guest", guestSessionId: g.id } });
      // The customer of record (who signs in later) owns it too.
      await prisma.order.update({ where: { id: o.id }, data: { customerId: A.id } });
      const docId = await pdf(o);
      const dl = await grantCookie(o.id, "download_tickets");
      const view = await grantCookie(o.id, "view_status");
      // Confirmed: the customer, a download grant and staff download (a guest session is not a ticket principal).
      for (const cookie of [A.cookie, dl.cookie, opsStaff.cookie]) expect((await download(docId, cookie)).status).toBe(200);

      await prisma.supplierBooking.update({ where: { id: o.bookingId! }, data: { state: "cancelled", cancelledAt: new Date(), closedAt: new Date() } });
      const notFound: string[] = [];
      for (const cookie of [A.cookie, dl.cookie]) {
        const res = await download(docId, cookie);
        expect(res.status).toBe(404);
        notFound.push(await res.text());
      }
      // The same 404 as an unknown document: nothing tells them it exists.
      const unknown = await download(uuidv7(), A.cookie);
      expect(unknown.status).toBe(404);
      expect(new Set([...notFound, await unknown.text()]).size).toBe(1);
      const staffRes = await download(docId, opsStaff.cookie);
      expect(staffRes.status).toBe(200);
      expect(staffRes.headers.get("content-type")).toBe("application/pdf");

      // Owner decision: the grants are not revoked; the guest still follows the order (and its refund).
      const grants = await prisma.guestCapabilityGrant.findMany({ where: { id: { in: [dl.grantId, view.grantId] } } });
      expect(grants.map((x) => x.revokedAt)).toEqual([null, null]);
      for (const cookie of [view.cookie, dl.cookie, g.cookie]) {
        const res = await status(o.reference, cookie);
        expect(res.status).toBe(200);
        expect((await res.json()).reference).toBe(o.reference);
      }
    });
  });

  /* ---------------------------------------------------------------- R-B5-16 */

  describe("R-B5-16: clearing a late-accepted booking (lead decision: settled only by a supplier read, or confirmed and alone)", () => {
    const ENDED: Record<string, string> = { cancelled: "CANCELLED", expired: "EXPIRED" };
    let owner: { kind: "guest"; guestSessionId: string };

    /**
     * A booking re-blocked after a late acceptance, in `state`, with its alert.
     * `reread`: a supplier read after the alert moved it to that end state (the
     * `state_change` event applySupplierState writes). Guest-owned: its rows stay
     * (append-only events), so it must not pin the customer fixture.
     */
    async function lateAccepted(label: string, state: string, opts: { reread?: boolean; reason?: string } = {}) {
      owner ??= { kind: "guest", guestSessionId: (await guestSession(prisma, fx)).id };
      const o = await order(label, { bookingState: state, owner });
      await prisma.supplierBooking.update({ where: { id: o.bookingId! }, data: { attentionRequiredAt: new Date(Date.UTC(2001, 0, 5)), errorCode: opts.reason ?? "late_acceptance" } });
      await prisma.supplierBookingEvent.create({ data: { id: uuidv7(), supplierBookingId: o.bookingId!, kind: "alert", detail: { reason: opts.reason ?? "late_acceptance", supplierStatus: "CONFIRMED" } } });
      if (opts.reread) {
        await prisma.supplierBookingEvent.create({
          data: { id: uuidv7(), supplierBookingId: o.bookingId!, kind: "state_change", fromState: "outcome_unknown", toState: state, detail: { via: "recovered", supplierStatus: ENDED[state] } },
        });
      }
      return o;
    }
    const clear = (bookingId: string, reasonCode: string) => {
      const at = tick();
      return ops.requestResolution(admin(), { action: "clear_attention", target: "supplier_booking", targetId: bookingId, reasonCode, evidence: EVIDENCE }, { environment: "test", totpCode: totpAt(secret, at), now: at });
    };
    const flagOf = async (id: string) => (await prisma.supplierBooking.findUniqueOrThrow({ where: { id } })).attentionRequiredAt;
    const engine = async () => (await import("@/server/services/supplier-booking.service")).supplierBookingService;
    const engineClear = async (o: InstantOrder, reasonCode: string, lateAcceptanceResolved: boolean) => {
      const svcEngine = await engine();
      const opts = { orderId: o.id, expectedAttentionAt: (await flagOf(o.bookingId!))!, actorId: staff.a.id, reasonCode, approvalId: uuidv7(), lateAcceptanceResolved };
      return prisma.$transaction((tx) => svcEngine.clearAttention(tx, o.bookingId!, opts));
    };

    it("allowed with late_acceptance_resolved when a supplier read shows it cancelled or expired, and when it is confirmed and the item's only live attempt", async () => {
      for (const [label, state, reread] of [
        ["r16-cancelled", "cancelled", true],
        ["r16-expired", "expired", true],
        ["r16-confirmed", "confirmed", false],
      ] as const) {
        const o = await lateAccepted(label, state, { reread });
        expect(await (await engine()).lateAcceptanceSettled(o.bookingId!), label).toBe(true);
        const r = await clear(o.bookingId!, "late_acceptance_resolved");
        expect(r.status, label).toBe("applied");
        expect(await flagOf(o.bookingId!), label).toBeNull();
        const event = await prisma.supplierBookingEvent.findFirst({ where: { supplierBookingId: o.bookingId!, kind: "operator_action" } });
        expect(event, label).toMatchObject({ actor: staff.a.id, detail: { via: "clear_attention", reason: "late_acceptance_resolved" } });
        expect((await prisma.supplierBooking.findUniqueOrThrow({ where: { id: o.bookingId! } })).state, label).toBe(state);
      }
    });

    it("refused when the end is Outly's own (no supplier read after the alert), in the request and in the engine", async () => {
      for (const state of ["cancelled", "expired"]) {
        const o = await lateAccepted(`r16-own-${state}`, state);
        expect(await (await engine()).lateAcceptanceSettled(o.bookingId!), state).toBe(false);
        expect(await clear(o.bookingId!, "late_acceptance_resolved"), state).toEqual({ status: "refused", reason: "late_acceptance_hold" });
        expect(await engineClear(o, "late_acceptance_resolved", true), state).toBe("late_accepted");
        expect(await flagOf(o.bookingId!), state).not.toBeNull();
      }
    });

    it("refused for a late-accepted duplicate left not_created while the item's next attempt is live: the supplier may hold a real booking", async () => {
      const o = await lateAccepted("r16-duplicate", "not_created", { reason: "late_acceptance_duplicate" });
      const first = await prisma.supplierBooking.findUniqueOrThrow({ where: { id: o.bookingId! } });
      const secondId = uuidv7();
      await prisma.supplierBooking.create({
        data: {
          ...first,
          id: secondId,
          idempotencyKey: `${first.idempotencyKey}:2`,
          clientRef: `ZZD${secondId.replace(/-/g, "").slice(-12)}`,
          state: "awaiting_payment",
          supplierBookingId: null,
          attentionRequiredAt: null,
          errorCode: null,
          closedAt: null,
          lastResponse: undefined,
          requestPayload: undefined,
        } as never,
      });
      expect(await (await engine()).lateAcceptanceSettled(o.bookingId!)).toBe(false);
      expect(await clear(o.bookingId!, "late_acceptance_resolved")).toEqual({ status: "refused", reason: "late_acceptance_hold" });
      expect(await engineClear(o, "late_acceptance_resolved", true)).toBe("late_accepted");
      // Still not settled once the next attempt has ended: not_created is never a supplier read.
      await prisma.supplierBooking.update({ where: { id: secondId }, data: { state: "expired", closedAt: new Date() } });
      expect(await (await engine()).lateAcceptanceSettled(o.bookingId!)).toBe(false);
      expect(await flagOf(o.bookingId!)).not.toBeNull();
    });

    it("refused without the dedicated reason, in the request and in the engine", async () => {
      const o = await lateAccepted("r16-plain", "cancelled", { reread: true });
      expect(await clear(o.bookingId!, "verified_with_operator")).toEqual({ status: "refused", reason: "late_acceptance_hold" });
      expect(await engineClear(o, "handled_offline", false)).toBe("late_accepted");
      expect(await flagOf(o.bookingId!)).not.toBeNull();
    });

    it("refused in recovering and holding states, even with the dedicated reason", async () => {
      for (const state of ["outcome_unknown", "not_found_unresolved", "cancel_unverified", "awaiting_payment", "reserved"]) {
        const o = await lateAccepted(`r16-${state.replace(/_/g, "")}`, state);
        expect(await (await engine()).lateAcceptanceSettled(o.bookingId!), state).toBe(false);
        expect(await clear(o.bookingId!, "late_acceptance_resolved"), state).toEqual({ status: "refused", reason: "holds_money_step" });
        // The engine refuses on its own, whatever a caller asks.
        expect(await engineClear(o, "late_acceptance_resolved", true), state).toBe("late_accepted");
        expect(await flagOf(o.bookingId!), state).not.toBeNull();
      }
    });

    it("a second live attempt for the item cannot exist beside a confirmed one (the case (b) guards)", async () => {
      const o = await lateAccepted("r16-dup", "confirmed");
      const b = await prisma.supplierBooking.findUniqueOrThrow({ where: { id: o.bookingId! } });
      await expect(
        prisma.supplierBooking.create({
          data: { ...b, id: uuidv7(), idempotencyKey: `${b.idempotencyKey}:2`, clientRef: `ZZD${uuidv7().replace(/-/g, "").slice(-12)}`, state: "awaiting_payment", supplierBookingId: null, attentionRequiredAt: null, lastResponse: undefined, requestPayload: undefined } as never,
        }),
      ).rejects.toThrow(/sb_one_live_per_order_item|Unique constraint/);
    });

    it("the dedicated reason is refused on any other row: a booking never late-accepted, and other targets", async () => {
      owner ??= { kind: "guest", guestSessionId: (await guestSession(prisma, fx)).id };
      const plain = await order("r16-notlate", { bookingState: "cancelled", owner });
      await prisma.supplierBooking.update({ where: { id: plain.bookingId! }, data: { attentionRequiredAt: new Date(Date.UTC(2001, 0, 6)) } });
      expect(await clear(plain.bookingId!, "late_acceptance_resolved")).toEqual({ status: "refused", reason: "reason_not_applicable" });
      expect(await engineClear(plain, "late_acceptance_resolved", true)).toBe("not_matched");
      expect(await flagOf(plain.bookingId!)).not.toBeNull();
      // The same booking clears with an ordinary reason.
      expect((await clear(plain.bookingId!, "handled_offline")).status).toBe("applied");

      const withRequest = await order("r16-request");
      const requestId = uuidv7();
      await prisma.cancellationRequest.create({ data: { id: requestId, orderId: withRequest.id, orderItemId: withRequest.itemId, kind: "exception", status: "exception_open", requestedVia: "customer", attentionRequiredAt: new Date() } });
      const at = tick();
      expect(
        await ops.requestResolution(admin(), { action: "clear_attention", target: "cancellation_request", targetId: requestId, reasonCode: "late_acceptance_resolved", evidence: EVIDENCE }, { environment: "test", totpCode: totpAt(secret, at), now: at }),
      ).toEqual({ status: "refused", reason: "reason_not_applicable" });
    });
  });
});
