import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { randomBytes } from "node:crypto";
import { apiRequest, assertDisposableDb, cleanupPeople, createCustomer, dbEnabled, params, runId, syntheticPhone, type CustomerFixture } from "../helpers/fixtures";
import { cleanupBusinessRows, db, forbidNetwork, publishedProduct } from "../security/_mercury-fixtures";
import { cleanupCustomerRows, guestSession, instantOrder, setupCustomerFixtures, type CustomerFixtures, type InstantOrder, type InstantOrderOptions } from "./customer-fixtures";
import { resetEnvCache } from "@/server/lib/env";
import { uuidv7 } from "@/server/lib/ids";
import type { OrderItemTickets, ServableDocument } from "@/server/services/document.service";

/**
 * Guest same-browser voucher download (checkout redesign batch 3, CO-02, and
 * its security review; docs/checkout-redesign-review/notes/batch3-design.md),
 * through the REAL `POST /api/checkout` route (checkout.service's repeat path
 * for a used quote: the fixtures write the order its first call would have
 * written, with a stored Stripe link), the real status, document, exchange,
 * recovery, cancellation and remove-access routes, and the disposable database:
 *
 *  - issued only to the guest session that made the order's quote, when the
 *    request names the order-bound verification; never from the reference;
 *  - valid for that order's documents only, never another order's;
 *  - fixed lifetime from the verification (GUEST_DOWNLOAD_GRANT_HOURS, 1–24);
 *    expired, revoked and switched-off grants stop at once and are never
 *    re-minted; its origin cannot be changed in the database;
 *  - rate-limited per grant, failing closed on a real store failure; audited;
 *  - cannot request a cancellation on its own; ends when the order is
 *    cancelled and refunded; "Remove access on this browser" revokes it;
 *  - never evicts an emailed-link or recovery entry from the cookie;
 *  - the emailed link, recovery and the signed-in owner work as before.
 *
 * Document bytes come from a mocked `documentService.readServable` and the
 * status page's document list from a mocked `listForOrder`; the document rows
 * are real, so ownership is resolved from the database.
 */

const run = runId();
let ipN = Number.parseInt(run.slice(-4), 16) % 50_000;
const nextIp = () => `198.19.${Math.floor(ipN / 250) % 250}.${(ipN++ % 250) + 1}`;
const savedEnv = { ...process.env };
const HOUR = 3600_000;
const PDF = new TextEncoder().encode("%PDF-1.7\n% zz synthetic voucher\n%%EOF\n");
const STRIPE_LINK = "https://checkout.stripe.com/c/pay/cs_test_zz";

type Prisma = Awaited<ReturnType<typeof db>>;
let prisma: Prisma;
let fx: CustomerFixtures;
let owner: CustomerFixture;
let capability: typeof import("@/server/services/capability.service");
let grantSvc: typeof import("@/server/services/checkout-download-grant.service");
const logged: string[] = [];

const checkoutRoute = () => import("@/app/api/checkout/route");
const statusRoute = () => import("@/app/api/orders/[reference]/status/route");
const docRoute = () => import("@/app/api/tickets/documents/[id]/route");
const exchangeRoute = () => import("@/app/api/tickets/exchange/route");
const removeRoute = () => import("@/app/api/tickets/remove-access/route");
const cancellationRoute = () => import("@/app/api/orders/[reference]/cancellation/route");
const recoveryStartRoute = () => import("@/app/api/recovery/start/route");
const recoveryVerifyRoute = () => import("@/app/api/recovery/verify/route");

function setEnv(name: string, value: string | undefined) {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
  resetEnvCache();
}
const setSwitch = (on: boolean) => setEnv("GUEST_DOWNLOAD_GRANT_ENABLED", on ? "true" : "false");

const cookies = (...parts: (string | null | undefined)[]) => parts.filter(Boolean).join("; ") || undefined;

function accessCookie(res: Response): string | null {
  const set = res.headers.getSetCookie().find((c) => c.startsWith("outlyy_ticket_access="));
  return set ? set.split(";")[0] : null;
}

async function status(reference: string, cookie?: string) {
  const { GET } = await statusRoute();
  return GET(apiRequest(`/api/orders/${reference}/status`, { cookie, headers: { "x-real-ip": nextIp() } }), params({ reference }));
}

async function download(id: string, cookie?: string) {
  const { GET } = await docRoute();
  return GET(apiRequest(`/api/tickets/documents/${id}`, { cookie, headers: { "x-real-ip": nextIp() } }), params({ id }));
}

async function exchange(token: string, cookie?: string) {
  const { POST } = await exchangeRoute();
  return POST(apiRequest("/api/tickets/exchange", { body: { token }, cookie, headers: { "x-real-ip": nextIp() } }), params({}));
}

/** An emailed link for the order, opened in this browser: its access cookie. */
async function emailedLink(orderId: string, cookie?: string) {
  const g = await capability.capabilityService.mint(prisma, { orderId, purpose: "download_tickets", issuedFor: "ticket_notification", supersede: "after_sent" });
  const res = await exchange(g.token, cookie);
  expect(res.status).toBe(200);
  return { grantId: g.grantId, cookie: accessCookie(res)! };
}

/** A voucher PDF row for the order's supplier booking. */
async function voucher(o: InstantOrder, kind: "voucher_pdf" | "tickets_pdf" = "voucher_pdf"): Promise<string> {
  const id = uuidv7();
  await prisma.supplierDocument.create({
    data: {
      id,
      supplierBookingId: o.bookingId!,
      orderId: o.id,
      orderItemId: o.itemId,
      kind,
      version: 1,
      status: "valid",
      source: "pdf_download",
      storageKey: `test/${randomBytes(16).toString("hex")}`,
      contentType: "application/pdf",
      byteSize: PDF.byteLength,
      sha256: randomBytes(32).toString("hex"),
      customerVisible: true,
    },
  });
  return id;
}

/**
 * Makes the fixture order look exactly like one `POST /api/checkout` has
 * already created: its quote's line as checkout.service stores it, and the
 * payment's stored Stripe link. A repeat call then takes checkout.service's
 * used-quote path, as the customer's "Return to payment" does.
 */
async function asCheckedOut(o: InstantOrder): Promise<void> {
  await prisma.quote.update({
    where: { id: o.quoteId },
    data: {
      lines: [
        {
          productId: fx.product.id,
          productVersion: null,
          variantId: "zz-variant",
          mappingId: o.mappingId,
          supplierEnvironment: "test",
          supplierAccountId: null,
          serviceDate: "2030-01-15",
          slotRef: null,
          units: { adult: 2 },
          unitDefinitions: [{ unitId: "adult", supplierUnit: "adult" }],
          chargedMinor: "45000",
          discountAllocMinor: "0",
          taxAllocMinor: "0",
          supplierNetAedMinor: "30000",
          margin: {},
          freeCancellationUntilUtc: "2030-01-14T06:00:00.000Z",
          nonRefundableAfterConfirm: false,
        },
      ],
      expiresAt: new Date(Date.now() + 10 * 60_000),
    },
  });
  await prisma.payment.update({ where: { id: o.paymentId }, data: { paymentLinkUrl: STRIPE_LINK } });
}

async function verificationIdOf(orderId: string): Promise<string | null> {
  return (await prisma.orderContactVerification.findFirst({ where: { orderId }, select: { id: true } }))?.id ?? null;
}

type GuestOrder = InstantOrder & { docId: string | null; verificationId: string | null };

/** A guest order made by `guestSessionId`, verified unless said otherwise, paid and confirmed with a voucher unless `unpaid`. */
async function guestOrder(label: string, guestSessionId: string, opts: { verified?: boolean; kind?: "voucher_pdf" | "tickets_pdf"; unpaid?: boolean; email?: string } = {}): Promise<GuestOrder> {
  const verified: InstantOrderOptions["verified"] =
    opts.verified === false ? undefined : opts.email ? { channel: "email", contact: opts.email } : { channel: "phone", contact: syntheticPhone(run, 30 + fx.orders.length) };
  const o = await instantOrder(prisma, run, fx, {
    label,
    owner: { kind: "guest", guestSessionId },
    ...(opts.unpaid
      ? { sagaState: "session_created", bookingState: "awaiting_payment" }
      : { sagaState: "fulfilled", capturedMinor: 45_000n, bookingState: "confirmed", issuesTicketsAtConfirm: "yes" as const }),
    ...(verified ? { verified } : {}),
  });
  await asCheckedOut(o);
  const docId = opts.unpaid ? null : await voucher(o, opts.kind);
  return { ...o, docId, verificationId: await verificationIdOf(o.id) };
}

/**
 * The real checkout route; `verificationId` defaults to the order-bound one (the id the browser paid with).
 * `null` sends a random id; `"absent"` leaves the field out.
 */
async function checkout(o: GuestOrder, cookie: string | undefined, verificationId: string | null | "absent" = o.verificationId) {
  const { POST } = await checkoutRoute();
  const body: Record<string, unknown> = {
    quoteId: o.quoteId,
    method: "card",
    traveller: { fullName: "Zz Synthetic Traveller", phoneE164: "+971500000001", email: null },
  };
  if (verificationId !== "absent") body.verificationId = verificationId ?? uuidv7();
  return POST(apiRequest("/api/checkout", { cookie, headers: { "x-real-ip": nextIp() }, body }), undefined as never);
}

async function checkoutGrantOf(orderId: string) {
  return prisma.guestCapabilityGrant.findFirst({ where: { orderId, issuedFor: "checkout" } });
}

describe.skipIf(!dbEnabled)("guest same-browser download grant (checkout redesign batch 3, CO-02)", () => {
  beforeAll(async () => {
    assertDisposableDb();
    forbidNetwork();
    process.env.TRUST_PROXY_IP_HEADERS = "true";
    process.env.INSTANT_RELEASE_ENABLED = "true";
    delete process.env.RESEND_API_KEY;
    delete process.env.GUEST_DOWNLOAD_GRANT_HOURS;
    setSwitch(true);
    prisma = await db();
    // Killed-run safety: a run stopped inside the store-failure test may have left the limiter table renamed.
    await prisma.$executeRawUnsafe(`
      DO $$
      BEGIN
        IF to_regclass('public.rate_limit_buckets_zz_off') IS NOT NULL AND to_regclass('public.rate_limit_buckets') IS NULL THEN
          ALTER TABLE "rate_limit_buckets_zz_off" RENAME TO "rate_limit_buckets";
        END IF;
      END $$;`);
    capability = await import("@/server/services/capability.service");
    grantSvc = await import("@/server/services/checkout-download-grant.service");
    fx = await setupCustomerFixtures(prisma, run, await publishedProduct());
    owner = await createCustomer(run, syntheticPhone(run, 29));

    const { documentService } = await import("@/server/services/document.service");
    vi.spyOn(documentService, "readServable").mockImplementation(async (documentId: string): Promise<ServableDocument> => {
      const row = await prisma.supplierDocument.findUnique({ where: { id: documentId } });
      if (!row || !row.orderId || !row.orderItemId) return { kind: "unavailable", reason: "not_found" };
      return { kind: "ok", bytes: PDF, contentType: "application/pdf", document: { id: row.id, orderId: row.orderId, orderItemId: row.orderItemId, kind: row.kind as "voucher_pdf", version: row.version } };
    });
    vi.spyOn(documentService, "listForOrder").mockImplementation(async (orderId: string): Promise<OrderItemTickets[]> => {
      const docs = await prisma.supplierDocument.findMany({ where: { orderId } });
      if (!docs.length) return [];
      return [
        {
          orderItemId: docs[0].orderItemId!,
          fulfilment: "issued",
          documents: docs.map((d) => ({ id: d.id, kind: d.kind as "voucher_pdf", version: d.version, status: "valid" as const, contentType: d.contentType, byteSize: d.byteSize, createdAt: d.createdAt.toISOString() })),
        },
      ];
    });
    const { log } = await import("@/server/lib/logger");
    for (const level of ["info", "warn", "error", "debug"] as const) {
      const original = log[level].bind(log);
      vi.spyOn(log, level).mockImplementation((msg: string, fields?: Record<string, unknown>) => {
        logged.push(JSON.stringify({ msg, fields }));
        original(msg, fields);
      });
    }
  });

  afterEach(() => {
    setSwitch(true);
    setEnv("GUEST_DOWNLOAD_GRANT_HOURS", undefined);
  });

  afterAll(async () => {
    vi.restoreAllMocks();
    process.env = { ...savedEnv };
    resetEnvCache();
    if (!prisma) return;
    await cleanupCustomerRows(prisma, fx);
    await cleanupBusinessRows(run);
    await cleanupPeople(run);
  });

  it("through the real checkout route: the browser that made the quote and holds its verification gets a 24-hour grant and downloads", async () => {
    const g = await guestSession(prisma, fx);
    const o = await guestOrder("same-tab", g.id);

    // Before: the quote's guest session sees the order but cannot download (as before batch 3).
    const before = await (await status(o.reference, g.cookie)).json();
    expect(before.canDownload).toBe(false);
    expect(before.canRemoveBrowserAccess).toBe(true);
    expect((await download(o.docId!, g.cookie)).status).toBe(404);

    const res = await checkout(o, g.cookie);
    expect(res.status).toBe(201);
    expect(await res.json()).toEqual({ orderReference: o.reference, redirectUrl: STRIPE_LINK });
    const set = res.headers.getSetCookie().find((c) => c.startsWith("outlyy_ticket_access="))!;
    expect(set).toMatch(/HttpOnly/i);
    expect(set).toMatch(/SameSite=Strict/i);
    expect(set).toMatch(/Path=\//);
    const access = accessCookie(res)!;
    expect(access).not.toContain(o.id);
    expect(access).not.toContain(o.reference);
    // A checkout entry is marked (inside its signature) so the cookie can evict it first.
    expect(access.split("=")[1]).toMatch(/^c1\./);

    const grant = (await checkoutGrantOf(o.id))!;
    expect(grant).toMatchObject({ purpose: "download_tickets", issuedFor: "checkout", revokedAt: null, exchangeCount: 0, tokenCiphertext: null });
    const verification = await prisma.orderContactVerification.findFirstOrThrow({ where: { orderId: o.id } });
    expect(grant.expiresAt.getTime()).toBe(verification.verifiedAt.getTime() + 24 * HOUR);

    const after = await (await status(o.reference, cookies(g.cookie, access))).json();
    expect(after.canDownload).toBe(true);
    expect(after.items[0].tickets.documents.map((d: { href: string }) => d.href)).toEqual([`/api/tickets/documents/${o.docId}`]);

    const dl = await download(o.docId!, access);
    expect(dl.status).toBe(200);
    expect(dl.headers.get("content-disposition")).toBe(`attachment; filename="OUTLYY-voucher-${o.reference}.pdf"; filename*=UTF-8''OUTLYY-voucher-${o.reference}.pdf`);
    expect(new Uint8Array(await dl.arrayBuffer())).toEqual(PDF);

    // "Return to payment" again: the same grant, the same fixed expiry, never a second grant.
    const again = await checkout(o, cookies(g.cookie, access));
    expect(accessCookie(again)).toContain(grant.id);
    expect(await prisma.guestCapabilityGrant.count({ where: { orderId: o.id, issuedFor: "checkout" } })).toBe(1);
    expect((await checkoutGrantOf(o.id))!.expiresAt.getTime()).toBe(grant.expiresAt.getTime());
  });

  it("the repeat checkout path gives no grant for a wrong or absent verification id; the redirect is unchanged", async () => {
    const g = await guestSession(prisma, fx);
    const o = await guestOrder("wrong-verification", g.id);
    const wrong = await checkout(o, g.cookie, uuidv7());
    expect(wrong.status).toBe(201);
    expect(await wrong.json()).toEqual({ orderReference: o.reference, redirectUrl: STRIPE_LINK });
    expect(accessCookie(wrong)).toBeNull();
    // Absent: the request itself is refused before anything runs.
    const absent = await checkout(o, g.cookie, "absent");
    expect(absent.status).toBe(422);
    expect(accessCookie(absent)).toBeNull();
    expect(await checkoutGrantOf(o.id)).toBeNull();
    // Another order's verification id is wrong too.
    const other = await guestOrder("wrong-verification-other", g.id);
    expect(accessCookie(await checkout(o, g.cookie, other.verificationId))).toBeNull();
    expect(await checkoutGrantOf(o.id)).toBeNull();
    // An existing grant is not re-signed for a wrong id either.
    expect(accessCookie(await checkout(o, g.cookie))).not.toBeNull();
    expect(accessCookie(await checkout(o, g.cookie, uuidv7()))).toBeNull();
  });

  it("a TicketOnly booking's tickets are saved as OUTLYY-tickets-<ref>.pdf", async () => {
    const g = await guestSession(prisma, fx);
    const o = await guestOrder("ticket-only", g.id, { kind: "tickets_pdf" });
    const access = accessCookie(await checkout(o, g.cookie))!;
    const dl = await download(o.docId!, access);
    expect(dl.status).toBe(200);
    expect(dl.headers.get("content-disposition")).toContain(`filename="OUTLYY-tickets-${o.reference}.pdf"`);
  });

  it("minted before payment it opens nothing; once paid and the voucher is stored, the same grant downloads", async () => {
    const g = await guestSession(prisma, fx);
    const o = await guestOrder("before-payment", g.id, { unpaid: true });
    const access = accessCookie(await checkout(o, g.cookie))!;
    const unpaid = await (await status(o.reference, cookies(g.cookie, access))).json();
    expect(unpaid.state).toBe("awaiting_payment");
    expect(unpaid.items[0].tickets.documents).toEqual([]);

    // Stripe confirms, the operator confirms, the voucher is stored.
    await prisma.payment.update({ where: { id: o.paymentId }, data: { status: "captured", capturedMinor: 45_000n, capturedAt: new Date() } });
    await prisma.paymentSaga.update({ where: { id: o.sagaId }, data: { state: "fulfilled" } });
    await prisma.supplierBooking.update({ where: { id: o.bookingId! }, data: { state: "confirmed", confirmedAt: new Date() } });
    await prisma.order.update({ where: { id: o.id }, data: { status: "confirmed", paidAt: new Date(), confirmedAt: new Date() } });
    const docId = await voucher(o);
    const paid = await (await status(o.reference, cookies(g.cookie, access))).json();
    expect(paid.canDownload).toBe(true);
    expect(paid.items[0].tickets.documents.map((d: { id: string }) => d.id)).toEqual([docId]);
    expect((await download(docId, access)).status).toBe(200);
  });

  it("only the quote's guest session gets one: another browser, an expired session, an unverified order and the reference alone get nothing", async () => {
    const g = await guestSession(prisma, fx);
    const other = await guestSession(prisma, fx);
    const o = await guestOrder("owner-only", g.id);

    // Another browser checking out "this" order: refused by checkout.service (not its quote), nothing minted.
    expect(accessCookie(await checkout(o, other.cookie))).toBeNull();
    expect(await grantSvc.checkoutDownloadGrant.issue({ orderId: o.id, guestSessionId: other.id, verificationId: o.verificationId!, existingCookie: undefined })).toBeNull();
    expect(await checkoutGrantOf(o.id)).toBeNull();
    expect((await checkout(o, undefined)).status).toBe(409);
    // The reference alone: the uniform 404.
    expect((await status(o.reference)).status).toBe(404);
    expect((await status(o.reference, other.cookie)).status).toBe(404);
    expect((await download(o.docId!)).status).toBe(404);
    expect((await download(o.docId!, other.cookie)).status).toBe(404);

    // The quote's own session, once expired, gets nothing.
    const expired = await guestSession(prisma, fx);
    const late = await guestOrder("expired-session", expired.id);
    await prisma.guestSession.update({ where: { id: expired.id }, data: { expiresAt: new Date(Date.now() - 1000) } });
    expect(await grantSvc.checkoutDownloadGrant.issue({ orderId: late.id, guestSessionId: expired.id, verificationId: late.verificationId!, existingCookie: undefined })).toBeNull();

    // No order-bound verification: none.
    const unverified = await guestOrder("unverified", g.id, { verified: false });
    expect(accessCookie(await checkout(unverified, g.cookie, null))).toBeNull();
    expect(await checkoutGrantOf(unverified.id)).toBeNull();

    // A customer-owned order is never issued one through a guest session.
    const mine = await instantOrder(prisma, run, fx, { label: "customer-owned", owner: { kind: "customer", customerId: owner.id }, sagaState: "fulfilled", capturedMinor: 45_000n, bookingState: "confirmed", verified: { channel: "phone", contact: owner.phoneE164 } });
    expect(await grantSvc.checkoutDownloadGrant.issue({ orderId: mine.id, guestSessionId: g.id, verificationId: (await verificationIdOf(mine.id))!, existingCookie: undefined })).toBeNull();
  });

  it("is valid for its own order's documents only; a grant from order A never opens order B in the same browser", async () => {
    const g = await guestSession(prisma, fx);
    const a = await guestOrder("leak-a", g.id);
    const b = await guestOrder("leak-b", g.id);
    const accessA = accessCookie(await checkout(a, g.cookie))!;

    const bStatus = await (await status(b.reference, cookies(g.cookie, accessA))).json();
    expect(bStatus.canDownload).toBe(false);
    expect((await download(b.docId!, cookies(g.cookie, accessA))).status).toBe(404);
    expect((await download(a.docId!, cookies(g.cookie, accessA))).status).toBe(200);

    const both = accessCookie(await checkout(b, cookies(g.cookie, accessA)))!;
    expect(both.split("=")[1].split("~")).toHaveLength(2);
    expect((await download(a.docId!, both)).status).toBe(200);
    expect((await download(b.docId!, both)).status).toBe(200);

    // A forged entry (B's grant id under A's signature) is refused, as is relabelling a checkout entry as v1.
    const gB = (await checkoutGrantOf(b.id))!;
    const [name, value] = accessA.split("=");
    const parts = value.split(".");
    expect((await download(b.docId!, `${name}=${[parts[0], gB.id, parts[2], parts[3]].join(".")}`)).status).toBe(404);
    expect((await download(a.docId!, `${name}=${["v1", parts[1], parts[2], parts[3]].join(".")}`)).status).toBe(404);
  });

  it("lifetime: GUEST_DOWNLOAD_GRANT_HOURS, bounded 1–24, from the verification; expired is 404 and never re-minted", async () => {
    const g = await guestSession(prisma, fx);
    const lifetime = async (hours: string | undefined) => {
      setEnv("GUEST_DOWNLOAD_GRANT_HOURS", hours);
      const o = await guestOrder(`hours-${hours ?? "default"}`, g.id);
      expect(await grantSvc.checkoutDownloadGrant.issue({ orderId: o.id, guestSessionId: g.id, verificationId: o.verificationId!, existingCookie: undefined })).not.toBeNull();
      const verifiedAt = (await prisma.orderContactVerification.findFirstOrThrow({ where: { orderId: o.id } })).verifiedAt;
      return ((await checkoutGrantOf(o.id))!.expiresAt.getTime() - verifiedAt.getTime()) / HOUR;
    };
    expect(await lifetime(undefined)).toBe(24);
    expect(await lifetime("2")).toBe(2);
    expect(await lifetime("99")).toBe(24);
    expect(await lifetime("0")).toBe(1);
    expect(await lifetime("not-a-number")).toBe(24);
    setEnv("GUEST_DOWNLOAD_GRANT_HOURS", undefined);

    const o = await guestOrder("expiry", g.id);
    const access = accessCookie(await checkout(o, g.cookie))!;
    const grant = (await checkoutGrantOf(o.id))!;
    expect((await download(o.docId!, access)).status).toBe(200);
    await prisma.guestCapabilityGrant.update({ where: { id: grant.id }, data: { createdAt: new Date(Date.now() - 2 * HOUR), expiresAt: new Date(Date.now() - 1000) } });
    expect((await download(o.docId!, access)).status).toBe(404);
    expect((await (await status(o.reference, cookies(g.cookie, access))).json()).canDownload).toBe(false);
    expect(accessCookie(await checkout(o, cookies(g.cookie, access)))).toBeNull();
    expect(await prisma.guestCapabilityGrant.count({ where: { orderId: o.id, issuedFor: "checkout" } })).toBe(1);
    await expect(prisma.guestCapabilityGrant.update({ where: { id: grant.id }, data: { expiresAt: new Date(Date.now() + 24 * HOUR) } })).rejects.toThrow();

    const old = await guestOrder("old-verification", g.id);
    await prisma.orderContactVerification.updateMany({ where: { orderId: old.id }, data: { verifiedAt: new Date(Date.now() - 25 * HOUR) } });
    expect(accessCookie(await checkout(old, g.cookie))).toBeNull();
    expect(await checkoutGrantOf(old.id)).toBeNull();
  });

  it("a grant's origin is fixed in the database: issued_for cannot be changed either way", async () => {
    const g = await guestSession(prisma, fx);
    const o = await guestOrder("origin-fixed", g.id);
    await checkout(o, g.cookie);
    const grant = (await checkoutGrantOf(o.id))!;
    await expect(prisma.guestCapabilityGrant.update({ where: { id: grant.id }, data: { issuedFor: "recovery" } })).rejects.toThrow(/origin are fixed/);
    const emailed = await emailedLink(o.id);
    await expect(prisma.guestCapabilityGrant.update({ where: { id: emailed.grantId }, data: { issuedFor: "checkout" } })).rejects.toThrow(/origin are fixed/);
  });

  it("revocation stops it at once, and checkout cannot bring it back", async () => {
    const g = await guestSession(prisma, fx);
    const o = await guestOrder("revoke", g.id);
    const access = accessCookie(await checkout(o, g.cookie))!;
    expect((await download(o.docId!, access)).status).toBe(200);
    const grant = (await checkoutGrantOf(o.id))!;
    expect(await capability.capabilityService.revoke(prisma, grant.id, "staff")).toBe(true);
    expect((await download(o.docId!, access)).status).toBe(404);
    expect((await (await status(o.reference, cookies(g.cookie, access))).json()).canDownload).toBe(false);
    expect(accessCookie(await checkout(o, cookies(g.cookie, access)))).toBeNull();
    expect(await prisma.guestCapabilityGrant.count({ where: { orderId: o.id, issuedFor: "checkout", revokedAt: null } })).toBe(0);
  });

  it("two issuances at once leave exactly one grant", async () => {
    const g = await guestSession(prisma, fx);
    const o = await guestOrder("race", g.id);
    const input = { orderId: o.id, guestSessionId: g.id, verificationId: o.verificationId!, existingCookie: undefined };
    const [x, y] = await Promise.all([grantSvc.checkoutDownloadGrant.issue(input), grantSvc.checkoutDownloadGrant.issue(input)]);
    expect(await prisma.guestCapabilityGrant.count({ where: { orderId: o.id, issuedFor: "checkout" } })).toBe(1);
    expect([x, y].filter(Boolean).length).toBeGreaterThanOrEqual(1);
    for (const c of [x, y]) if (c) expect((await download(o.docId!, `outlyy_ticket_access=${c.value}`)).status).toBe(200);
  });

  it("the release switch off disables issued grants and issues none, without touching documents or other access", async () => {
    const g = await guestSession(prisma, fx);
    const o = await guestOrder("switch", g.id);
    const access = accessCookie(await checkout(o, g.cookie))!;
    expect((await download(o.docId!, access)).status).toBe(200);

    setSwitch(false);
    expect((await download(o.docId!, access)).status).toBe(404);
    expect((await (await status(o.reference, cookies(g.cookie, access))).json()).canDownload).toBe(false);
    const second = await guestOrder("switch-off-issue", g.id);
    expect(accessCookie(await checkout(second, g.cookie))).toBeNull();
    expect(await checkoutGrantOf(second.id)).toBeNull();
    expect(await prisma.supplierDocument.findUniqueOrThrow({ where: { id: o.docId! } })).toMatchObject({ customerVisible: true, status: "valid" });
    expect((await checkoutGrantOf(o.id))!.revokedAt).toBeNull();
    expect((await download(o.docId!, (await emailedLink(o.id)).cookie)).status).toBe(200);
    const mine = await instantOrder(prisma, run, fx, { label: "owner-switch", owner: { kind: "customer", customerId: owner.id }, sagaState: "fulfilled", capturedMinor: 45_000n, bookingState: "confirmed" });
    const mineDoc = await voucher(mine);
    expect((await download(mineDoc, owner.cookie)).status).toBe(200);

    setSwitch(true);
    expect((await download(o.docId!, access)).status).toBe(200);
  });

  it("downloads through a checkout grant are rate-limited per grant, fail closed when the store is down, and another grant is preferred", async () => {
    const g = await guestSession(prisma, fx);
    const o = await guestOrder("limit", g.id);
    const access = accessCookie(await checkout(o, g.cookie))!;
    const { CHECKOUT_GRANT_DOWNLOAD_RATE } = await import("@/app/api/tickets/shared");
    for (let i = 0; i < CHECKOUT_GRANT_DOWNLOAD_RATE.limit; i++) expect((await download(o.docId!, access)).status, `download ${i + 1}`).toBe(200);
    expect((await download(o.docId!, access)).status).toBe(429);
    // With an emailed link in the same cookie, that grant is used, so the checkout grant's budget does not apply.
    const both = (await emailedLink(o.id, access)).cookie;
    expect((await download(o.docId!, both)).status).toBe(200);

    // A real store failure: the limiter table is gone for a moment. The checkout-grant download fails closed (503).
    const fresh = await guestOrder("limit-store", g.id);
    const freshAccess = accessCookie(await checkout(fresh, g.cookie))!;
    await prisma.$executeRawUnsafe(`ALTER TABLE "rate_limit_buckets" RENAME TO "rate_limit_buckets_zz_off"`);
    try {
      const res = await download(fresh.docId!, freshAccess);
      expect(res.status).toBe(503);
      expect(res.headers.get("content-type") ?? "").not.toContain("pdf");
    } finally {
      await prisma.$executeRawUnsafe(`ALTER TABLE "rate_limit_buckets_zz_off" RENAME TO "rate_limit_buckets"`);
    }
    expect((await download(fresh.docId!, freshAccess)).status).toBe(200);
  });

  it("a checkout grant alone cannot request a cancellation; the browser's own guest session still can, as before", async () => {
    const g = await guestSession(prisma, fx);
    const o = await guestOrder("no-cancel", g.id);
    const access = accessCookie(await checkout(o, g.cookie))!;
    const { POST } = await cancellationRoute();
    const res = await POST(apiRequest(`/api/orders/${o.reference}/cancellation`, { body: { orderItemId: o.itemId, kind: "cancel" }, cookie: access, headers: { "x-real-ip": nextIp() } }), params({ reference: o.reference }));
    expect(res.status).toBe(404);
    expect(await prisma.cancellationRequest.count({ where: { orderId: o.id } })).toBe(0);

    const { decideOrderAccess, orderAccessService } = await import("@/server/services/order-access.service");
    const grantOnly = (await decideOrderAccess(o.reference, { customerId: null, guestSessionId: null, accessCookie: access.split("=")[1] }))!;
    expect(grantOnly).toMatchObject({ via: "grant", canDownload: true, grantIssuedFor: "checkout", quoteSession: false });
    expect(orderAccessService.mayRequestCancellation(grantOnly)).toBe(false);
    const withSession = (await decideOrderAccess(o.reference, { customerId: null, guestSessionId: g.id, accessCookie: access.split("=")[1] }))!;
    expect(withSession).toMatchObject({ canDownload: true, quoteSession: true });
    expect(orderAccessService.mayRequestCancellation(withSession)).toBe(true);
    // An emailed link still may (unchanged).
    const emailed = await emailedLink(o.id);
    expect(orderAccessService.mayRequestCancellation((await decideOrderAccess(o.reference, { customerId: null, guestSessionId: null, accessCookie: emailed.cookie.split("=")[1] }))!)).toBe(true);
  });

  it("an order whose every item is refunded or rejected ends its checkout grant only; emailed links stay", async () => {
    const g = await guestSession(prisma, fx);
    const o = await guestOrder("ended", g.id);
    const access = accessCookie(await checkout(o, g.cookie))!;
    const emailed = await emailedLink(o.id);
    const { revokeCheckoutAccessIfOrderEnded } = await import("@/server/services/cancellation.service");
    // Still live: nothing ends.
    expect(await revokeCheckoutAccessIfOrderEnded(prisma, o.id)).toBe(0);
    // The saga's full refund marks every item rejected.
    await prisma.orderItem.updateMany({ where: { orderId: o.id }, data: { status: "rejected" } });
    expect(await revokeCheckoutAccessIfOrderEnded(prisma, o.id)).toBe(1);
    expect((await checkoutGrantOf(o.id))!.revokeReason).toBe("order_cancelled");
    expect((await prisma.guestCapabilityGrant.findUniqueOrThrow({ where: { id: emailed.grantId } })).revokedAt).toBeNull();
    expect((await download(o.docId!, access)).status).toBe(404);
    expect(await revokeCheckoutAccessIfOrderEnded(prisma, o.id)).toBe(0);
  });

  it("Remove access on this browser: revokes its checkout grants, clears its cookies, ends its guest session; idempotent and audited", async () => {
    logged.length = 0;
    const g = await guestSession(prisma, fx);
    const o = await guestOrder("remove", g.id);
    const access = accessCookie(await checkout(o, g.cookie))!;
    const withEmail = (await emailedLink(o.id, access)).cookie;
    const emailedId = (await prisma.guestCapabilityGrant.findFirstOrThrow({ where: { orderId: o.id, issuedFor: "ticket_notification" } })).id;
    const { POST } = await removeRoute();
    const call = (cookie?: string, origin?: string | null) => POST(apiRequest("/api/tickets/remove-access", { method: "POST", cookie, origin, headers: { "x-real-ip": nextIp() } }), params({}));

    // Cross-site: refused before anything happens.
    expect((await call(cookies(g.cookie, withEmail), "https://evil.example")).status).toBe(403);
    expect((await checkoutGrantOf(o.id))!.revokedAt).toBeNull();

    const res = await call(cookies(g.cookie, withEmail));
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("private, no-store");
    expect(await res.json()).toEqual({ ok: true });
    const sets = res.headers.getSetCookie();
    expect(sets.find((c) => c.startsWith("outlyy_ticket_access="))).toMatch(/Max-Age=0/i);
    expect(sets.find((c) => c.startsWith("outlyy_guest_session="))).toMatch(/Max-Age=0/i);
    expect((await checkoutGrantOf(o.id))!.revokeReason).toBe("customer");
    // The emailed link is forgotten here but keeps working from the email (not revoked).
    expect((await prisma.guestCapabilityGrant.findUniqueOrThrow({ where: { id: emailedId } })).revokedAt).toBeNull();
    expect((await prisma.guestSession.findUniqueOrThrow({ where: { id: g.id } })).revokedAt).not.toBeNull();
    // Even a copy of the old cookies no longer downloads through the checkout grant or sees the order through the session.
    expect((await download(o.docId!, access)).status).toBe(404);
    expect((await status(o.reference, g.cookie)).status).toBe(404);
    expect(logged.map((l) => JSON.parse(l)).find((l: { msg: string }) => l.msg === "capability.browser_access_removed")?.fields).toEqual({ revoked: 1, entries: 2, guestSession: true });

    // Again (idempotent) and with nothing at all.
    expect((await call(cookies(g.cookie, withEmail))).status).toBe(200);
    expect((await call()).status).toBe(200);
    expect(await prisma.guestCapabilityGrant.count({ where: { orderId: o.id, revokedAt: { not: null } } })).toBe(1);
  });

  it("cookie eviction: abandoned checkout entries go first; a full cookie of links and recoveries keeps them and refuses the new checkout entry", async () => {
    const g = await guestSession(prisma, fx);
    const linked = await guestOrder("evict-links", g.id);
    // Two checkout entries first, then six emailed links: eight entries, the cap.
    const c1 = await guestOrder("evict-c1", g.id);
    const c2 = await guestOrder("evict-c2", g.id);
    let jar = accessCookie(await checkout(c1, g.cookie))!;
    jar = accessCookie(await checkout(c2, cookies(g.cookie, jar)))!;
    const links: string[] = [];
    for (let i = 0; i < 6; i++) {
      const l = await emailedLink(linked.id, jar);
      links.push(l.grantId);
      jar = l.cookie;
    }
    expect(jar.split("=")[1].split("~")).toHaveLength(8);
    // A ninth (a link): the oldest CHECKOUT entry goes, never a link.
    const ninth = await emailedLink(linked.id, jar);
    let kept = capability.accessCookieGrants(ninth.cookie.split("=")[1]);
    expect(kept).toHaveLength(8);
    expect(kept.map((e) => e.grantId)).not.toContain((await checkoutGrantOf(c1.id))!.id);
    expect(kept.map((e) => e.grantId)).toContain((await checkoutGrantOf(c2.id))!.id);
    // A tenth: the other checkout entry goes.
    const tenth = await emailedLink(linked.id, ninth.cookie);
    kept = capability.accessCookieGrants(tenth.cookie.split("=")[1]);
    expect(kept.filter((e) => e.checkout)).toHaveLength(0);
    expect(kept.map((e) => e.grantId)).toEqual(expect.arrayContaining([...links, ninth.grantId, tenth.grantId]));
    // Full of links: a new checkout gives way instead of pushing one out.
    const c3 = await guestOrder("evict-c3", g.id);
    const res = await checkout(c3, cookies(g.cookie, tenth.cookie));
    expect(res.status).toBe(201);
    expect(accessCookie(res)).toBeNull();
    expect(logged.some((l) => l.includes("capability.checkout_refused") && l.includes("cookie_full"))).toBe(true);
  });

  it("the emailed link, a staff resend and recovery keep working beside it; none of them revokes it, nor it them", async () => {
    const g = await guestSession(prisma, fx);
    const email = `zz-sec-${run}-grant-recover@outlyy.test`;
    const o = await guestOrder("beside", g.id, { email });

    const emailed = await capability.capabilityService.mint(prisma, { orderId: o.id, purpose: "download_tickets", issuedFor: "ticket_notification", supersede: "after_sent" });
    const access = accessCookie(await checkout(o, g.cookie))!;
    const checkoutGrant = (await checkoutGrantOf(o.id))!;
    const later = await capability.capabilityService.mint(prisma, { orderId: o.id, purpose: "download_tickets", issuedFor: "ticket_notification", supersede: "after_sent" });
    await capability.capabilityService.supersedePrevious(prisma, later.grantId);
    expect((await prisma.guestCapabilityGrant.findUniqueOrThrow({ where: { id: emailed.grantId } })).revokeReason).toBe("superseded");
    await capability.capabilityService.mint(prisma, { orderId: o.id, purpose: "download_tickets", issuedFor: "staff_resend" });
    expect((await prisma.guestCapabilityGrant.findUniqueOrThrow({ where: { id: later.grantId } })).revokeReason).toBe("superseded");
    expect((await prisma.guestCapabilityGrant.findUniqueOrThrow({ where: { id: checkoutGrant.id } })).revokedAt).toBeNull();
    expect((await download(o.docId!, access)).status).toBe(200);

    const { emailAdapter } = await import("@/server/notifications/email.adapter");
    vi.spyOn(emailAdapter, "provider").mockReturnValue("log");
    const send = vi.spyOn(emailAdapter, "send").mockImplementation((async (_msg: unknown, opts?: { idempotencyKey: string }) => ({ kind: "sent", providerId: `fake-${opts?.idempotencyKey}` })) as never);
    const { POST: start } = await recoveryStartRoute();
    const started = await start(apiRequest("/api/recovery/start", { body: { reference: o.reference, channel: "email", contact: email }, headers: { "x-real-ip": nextIp() } }), params({}));
    expect(started.status).toBe(200);
    const { challengeId } = await started.json();
    await vi.waitFor(() => expect(send).toHaveBeenCalled());
    const code = /\b(\d{6})\b/.exec((send.mock.calls.at(-1)![0] as unknown as { text: string }).text)![1];
    const { POST: verify } = await recoveryVerifyRoute();
    const verified = await verify(apiRequest("/api/recovery/verify", { body: { challengeId, code }, cookie: access, headers: { "x-real-ip": nextIp() } }), params({}));
    expect(verified.status).toBe(200);
    const withRecovery = accessCookie(verified)!;
    expect(withRecovery.split("=")[1].split("~")).toHaveLength(2);
    expect((await download(o.docId!, withRecovery)).status).toBe(200);
    expect((await prisma.guestCapabilityGrant.findFirstOrThrow({ where: { orderId: o.id, issuedFor: "recovery" } })).revokedAt).toBeNull();
    await capability.capabilityService.revoke(prisma, checkoutGrant.id, "staff");
    expect((await download(o.docId!, withRecovery)).status).toBe(200);
    expect((await download(o.docId!, access)).status).toBe(404);
  });

  it("is audited with ids and codes only; no token, cookie value, reference or contact reaches a log line", async () => {
    logged.length = 0;
    const g = await guestSession(prisma, fx);
    const other = await guestSession(prisma, fx);
    const o = await guestOrder("audit", g.id);
    const access = accessCookie(await checkout(o, g.cookie))!;
    await checkout(o, g.cookie, uuidv7());
    await grantSvc.checkoutDownloadGrant.issue({ orderId: o.id, guestSessionId: other.id, verificationId: o.verificationId!, existingCookie: undefined });
    await download(o.docId!, access);
    const grant = (await checkoutGrantOf(o.id))!;
    const lines = logged.map((l) => JSON.parse(l) as { msg: string; fields?: Record<string, unknown> });
    expect(lines.find((l) => l.msg === "capability.minted" && l.fields?.grantId === grant.id)?.fields).toEqual({ grantId: grant.id, purpose: "download_tickets", issuedFor: "checkout" });
    expect(lines.find((l) => l.msg === "capability.checkout_issued")?.fields).toEqual({ grantId: grant.id, reused: false });
    const refusals = lines.filter((l) => l.msg === "capability.checkout_refused").map((l) => l.fields);
    expect(refusals).toEqual(expect.arrayContaining([{ reason: "verification_mismatch" }, { reason: "not_quote_owner" }]));
    expect(lines.find((l) => l.msg === "document.served" && l.fields?.documentId === o.docId)?.fields).toEqual({ documentId: o.docId, accessKind: "guest", grantId: grant.id, issuedFor: "checkout" });
    const text = logged.join("\n");
    expect(text).not.toContain(access.split("=")[1]);
    expect(text).not.toContain(o.reference);
    expect(text).not.toContain(g.token);
    expect(text).not.toMatch(/\+9199\d{8}/);
  });

  it("the signed-in owner downloads exactly as before, with or without a checkout grant anywhere", async () => {
    const mine = await instantOrder(prisma, run, fx, { label: "owner", owner: { kind: "customer", customerId: owner.id }, sagaState: "fulfilled", capturedMinor: 45_000n, bookingState: "confirmed" });
    const docId = await voucher(mine);
    const body = await (await status(mine.reference, owner.cookie)).json();
    expect(body.canDownload).toBe(true);
    expect(body.canRemoveBrowserAccess).toBe(false);
    expect((await download(docId, owner.cookie)).status).toBe(200);
    const g = await guestSession(prisma, fx);
    const theirs = await guestOrder("owner-neighbour", g.id);
    const theirAccess = accessCookie(await checkout(theirs, g.cookie))!;
    expect((await download(docId, cookies(owner.cookie, theirAccess))).status).toBe(200);
    expect((await download(docId, theirAccess)).status).toBe(404);
  });
});
