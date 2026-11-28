import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { randomBytes } from "node:crypto";
import {
  apiRequest,
  assertDisposableDb,
  cleanupPeople,
  createCustomer,
  createStaff,
  dbEnabled,
  params,
  runId,
  syntheticPhone,
  type CustomerFixture,
  type StaffFixture,
} from "../helpers/fixtures";
import { cleanupBusinessRows, db, forbidNetwork, makeOrder, publishedProduct, type SeedProduct } from "./_mercury-fixtures";
import { uuidv7 } from "@/server/lib/ids";
import { resetEnvCache } from "@/server/lib/env";
import type { ServableDocument } from "@/server/services/document.service";

/**
 * Ticket routes, end to end through the real handlers and the disposable
 * database (doc 22 §23 B4 tests; TKT-3, TKT-4, TKT-5, TKT-9; §26 F39, F55):
 *
 *  - customer A/B: B can neither list nor download A's documents;
 *  - a ticket-access cookie for order A cannot reach order B, a
 *    `view_status` cookie cannot download, a revoked grant stops at once;
 *  - expired, revoked, used-up and unknown tokens get one refusal; the
 *    exchange has no GET, so a link preview consumes nothing;
 *  - staff: a role without `tickets.view` is refused, ops is allowed and
 *    audited with field names and ids only;
 *  - download headers; no response redirects or names a storage URL.
 *
 * The document bytes come from a mocked `documentService.readServable` (the
 * document service is tested by its owner); the document rows are real, so
 * ownership is resolved from the database.
 */

const run = runId();
const runOctet = (Number.parseInt(run.slice(-2), 16) % 200) + 20;
let ipSeq = 0;
/** A fresh trusted IP per call group, so the per-IP limits never interfere. */
const nextIp = () => `198.18.${runOctet}.${(ipSeq++ % 250) + 1}`;
const savedEnv = { ...process.env };

type Prisma = Awaited<ReturnType<typeof db>>;
let prisma: Prisma;
let product: SeedProduct;
let capability: typeof import("@/server/services/capability.service");
let A: CustomerFixture;
let B: CustomerFixture;
let ops: StaffFixture;
let agentStaff: StaffFixture;
let supplierId: string;

interface Seeded {
  id: string;
  reference: string;
  itemId: string;
  docId: string;
  hiddenDocId: string;
  leadEmail: string;
  leadName: string;
}
let orderA: Seeded;
let orderB: Seeded;
const PDF = new TextEncoder().encode("%PDF-1.7\n% zz synthetic ticket\n%%EOF\n");
const storageKey = () => `test/${randomBytes(16).toString("hex")}`;
let unavailable = new Set<string>();

const exchangeRoute = () => import("@/app/api/tickets/exchange/route");
const listRoute = () => import("@/app/api/tickets/orders/[reference]/route");
const docRoute = () => import("@/app/api/tickets/documents/[id]/route");
const resendRoute = () => import("@/app/api/tickets/orders/[reference]/resend/route");

async function seedOrder(label: string, customerId: string): Promise<Seeded> {
  const o = await makeOrder(run, { leadPhone: syntheticPhone(run, label === "a" ? 41 : 42), customerId, label: `tickets-${label}` });
  const itemId = uuidv7();
  await prisma.orderItem.create({
    data: {
      id: itemId,
      orderId: o.id,
      productId: product.id,
      titleSnapshot: `zz-sec-${run} item ${label}`,
      tierSnapshot: product.tier,
      slugSnapshot: product.slug,
      kindSnapshot: "activity",
      confirmationSnapshot: "instant",
      fulfilmentModeSnapshot: "instant",
      freeCancellationHoursSnapshot: 24,
      durationMinutesSnapshot: 60,
      serviceDate: new Date("2030-01-15T00:00:00.000Z"),
      pax: { adult: 1 },
      unitInr: 1_000n,
      unitAed: 45n,
      totalInr: 1_000n,
      totalAed: 45n,
      fulfilmentOrigin: "instant_checkout",
    },
  });
  const bookingId = uuidv7();
  await prisma.supplierBooking.create({
    data: {
      id: bookingId,
      orderId: o.id,
      orderItemId: itemId,
      supplierId,
      environment: "test",
      idempotencyKey: `zz-sec-${run}:${itemId}:1`,
      clientRef: `ZZT${bookingId.replace(/-/g, "").slice(-12)}`,
      bookingKind: "live_book",
      tourExternalId: "zz-tour",
      offerExternalId: "zz-offer",
      serviceDate: new Date("2030-01-15T00:00:00.000Z"),
      adults: 1,
      guestName: `zz-sec-${run} guest`,
      expectedNetMinor: 1_000n,
      expectedNetUsdMinor: 270n,
      state: "manual_review",
      closedAt: new Date(),
    },
  });
  const doc = (id: string, kind: string, customerVisible: boolean) => ({
    id,
    supplierBookingId: bookingId,
    orderId: o.id,
    orderItemId: itemId,
    kind,
    version: 1,
    status: "valid",
    source: "pdf_download",
    storageKey: storageKey(),
    contentType: "application/pdf",
    byteSize: PDF.byteLength,
    sha256: randomBytes(32).toString("hex"),
    customerVisible,
  });
  const docId = uuidv7();
  const hiddenDocId = uuidv7();
  await prisma.supplierDocument.create({ data: doc(docId, "tickets_pdf", true) });
  await prisma.supplierDocument.create({ data: doc(hiddenDocId, "voucher_pdf", false) });
  const lead = await prisma.order.findUniqueOrThrow({ where: { id: o.id }, select: { leadEmail: true, leadName: true } });
  return { ...o, itemId, docId, hiddenDocId, leadEmail: lead.leadEmail!, leadName: lead.leadName };
}

async function grantCookie(orderId: string, purpose: "download_tickets" | "view_status") {
  const g = await capability.capabilityService.mint(prisma, { orderId, purpose, issuedFor: "ticket_notification" });
  const res = await exchange(g.token);
  expect(res.status).toBe(200);
  return { ...g, cookie: cookieFrom(res) };
}

function cookieFrom(res: Response): string {
  const set = res.headers.getSetCookie().find((c) => c.startsWith("outlyy_ticket_access="));
  if (!set) throw new Error("no access cookie");
  return set.split(";")[0];
}

async function exchange(token: unknown, opts: { contentType?: string; cookie?: string } = {}) {
  const { POST } = await exchangeRoute();
  return POST(apiRequest("/api/tickets/exchange", { body: { token }, headers: { "x-real-ip": nextIp() }, ...opts }), params({}));
}

async function list(reference: string, cookie?: string) {
  const { GET } = await listRoute();
  return GET(apiRequest(`/api/tickets/orders/${reference}`, { cookie, headers: { "x-real-ip": nextIp() } }), params({ reference }));
}

async function download(id: string, cookie?: string) {
  const { GET } = await docRoute();
  return GET(apiRequest(`/api/tickets/documents/${id}`, { cookie, headers: { "x-real-ip": nextIp() } }), params({ id }));
}

const all: Response[] = [];
function seen(res: Response) {
  all.push(res.clone());
  return res;
}

describe.skipIf(!dbEnabled)("ticket routes: ownership on every request (TKT-3/4/5, F39, F55)", () => {
  beforeAll(async () => {
    assertDisposableDb();
    forbidNetwork();
    process.env.TRUST_PROXY_IP_HEADERS = "true";
    process.env.NOTIFICATION_RECIPIENT_ALLOWLIST = "@outlyy.test";
    delete process.env.RESEND_API_KEY;
    resetEnvCache();
    prisma = await db();
    product = await publishedProduct();
    capability = await import("@/server/services/capability.service");
    supplierId = uuidv7();
    await prisma.supplier.create({ data: { id: supplierId, code: `zz-sec-tk-${run}`, name: "zz tickets fixture", source: "api", adapter: "traveldesk" } });
    A = await createCustomer(run, syntheticPhone(run, 43));
    B = await createCustomer(run, syntheticPhone(run, 44));
    ops = await createStaff(run, "tk-ops", ["ops"]);
    agentStaff = await createStaff(run, "tk-agent", ["agent"]);
    orderA = await seedOrder("a", A.id);
    orderB = await seedOrder("b", B.id);

    const { documentService } = await import("@/server/services/document.service");
    vi.spyOn(documentService, "readServable").mockImplementation(async (documentId: string): Promise<ServableDocument> => {
      if (unavailable.has(documentId)) return { kind: "unavailable", reason: "refetching" };
      const row = await prisma.supplierDocument.findUnique({ where: { id: documentId } });
      if (!row || !row.orderId || !row.orderItemId) return { kind: "unavailable", reason: "not_found" };
      return { kind: "ok", bytes: PDF, contentType: "application/pdf", document: { id: row.id, orderId: row.orderId, orderItemId: row.orderItemId, kind: row.kind, version: row.version } };
    });
    // Summaries as the document service builds them, plus fields that must never reach a response.
    vi.spyOn(documentService, "listForOrder").mockImplementation(async (orderId: string) => {
      const docs = await prisma.supplierDocument.findMany({ where: { orderId } });
      return [
        {
          orderItemId: docs[0]?.orderItemId ?? uuidv7(),
          fulfilment: "issued",
          documents: docs.map((d) => ({
            id: d.id,
            kind: d.kind as "tickets_pdf",
            version: d.version,
            status: d.status as "valid",
            contentType: d.contentType,
            byteSize: d.byteSize,
            createdAt: d.createdAt.toISOString(),
            ...({ storageKey: d.storageKey, sha256: d.sha256, downloadCodeLink: "https://supplier.example/downloadcode?Guid=zz" } as object),
          })),
        },
      ];
    });
    const { emailAdapter } = await import("@/server/notifications/email.adapter");
    vi.spyOn(emailAdapter, "send").mockImplementation((async (_msg: unknown, opts?: { idempotencyKey: string }) => ({ kind: "sent", providerId: `fake-${opts?.idempotencyKey}` })) as never);
  });

  afterEach(() => {
    unavailable = new Set();
  });

  afterAll(async () => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    process.env = { ...savedEnv };
    resetEnvCache();
    if (!prisma) return;
    const ids = [orderA?.id, orderB?.id].filter(Boolean) as string[];
    await prisma.guestCapabilityGrant.deleteMany({ where: { orderId: { in: ids } } });
    await prisma.supplierDocument.deleteMany({ where: { orderId: { in: ids } } });
    await prisma.supplierBooking.deleteMany({ where: { supplierId } });
    await prisma.supplier.deleteMany({ where: { id: supplierId } });
    await cleanupBusinessRows(run);
    await cleanupPeople(run);
  });

  it("customer A lists and downloads A's tickets with private, non-referring headers", async () => {
    const res = seen(await list(orderA.reference, A.cookie));
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("private, no-store");
    expect(res.headers.get("referrer-policy")).toBe("no-referrer");
    const body = await res.json();
    expect(body.reference).toBe(orderA.reference);
    const ids = body.items.flatMap((i: { documents: { id: string }[] }) => i.documents.map((d) => d.id));
    expect(ids).toContain(orderA.docId);
    const text = JSON.stringify(body);
    // TKT-9 and TKT-3: no storage key, checksum, supplier URL, Guid or code in a customer DTO.
    expect(text).not.toMatch(/storageKey|sha256|downloadCodeLink|Guid=|test\/[0-9a-f]{32}|https?:/);

    const dl = seen(await download(orderA.docId, A.cookie));
    expect(dl.status).toBe(200);
    expect(dl.headers.get("content-type")).toBe("application/pdf");
    expect(dl.headers.get("cache-control")).toBe("private, no-store");
    expect(dl.headers.get("referrer-policy")).toBe("no-referrer");
    expect(dl.headers.get("x-content-type-options")).toBe("nosniff");
    // CO-22 (batch 3): named after the order reference; this fixture's document is a TicketOnly tickets PDF.
    expect(dl.headers.get("content-disposition")).toBe(`attachment; filename="OUTLYY-tickets-${orderA.reference}.pdf"; filename*=UTF-8''OUTLYY-tickets-${orderA.reference}.pdf`);
    expect(dl.headers.get("content-security-policy")).toContain("default-src 'none'");
    expect(dl.headers.get("location")).toBeNull();
    expect(new Uint8Array(await dl.arrayBuffer())).toEqual(PDF);
  });

  it("customer B cannot list or download A's documents; anonymous callers neither (404, no oracle)", async () => {
    const { documentService } = await import("@/server/services/document.service");
    const reads = vi.mocked(documentService.readServable);
    reads.mockClear();
    for (const cookie of [B.cookie, undefined]) {
      const l = seen(await list(orderA.reference, cookie));
      expect(l.status).toBe(404);
      const d = seen(await download(orderA.docId, cookie));
      expect(d.status).toBe(404);
    }
    // A missing document and someone else's document look the same.
    const missing = seen(await download(uuidv7(), B.cookie));
    expect(missing.status).toBe(404);
    expect(await missing.json()).toEqual(await (await download(orderA.docId, B.cookie)).json());
    expect(reads, "no bytes are read before ownership is proven").not.toHaveBeenCalled();
    // A's own access does not leak to B's order.
    expect((await download(orderB.docId, A.cookie)).status).toBe(404);
    // A customer never sees an internal (not customer-visible) document.
    expect((await download(orderA.hiddenDocId, A.cookie)).status).toBe(404);
  });

  it("a guest cookie for order A reaches A only; view_status cannot download; revocation applies at once", async () => {
    const guest = await grantCookie(orderA.id, "download_tickets");
    expect(seen(await list(orderA.reference, guest.cookie)).status).toBe(200);
    expect(seen(await download(orderA.docId, guest.cookie)).status).toBe(200);
    expect(seen(await list(orderB.reference, guest.cookie)).status).toBe(404);
    expect(seen(await download(orderB.docId, guest.cookie)).status).toBe(404);

    const viewer = await grantCookie(orderA.id, "view_status");
    expect(seen(await list(orderA.reference, viewer.cookie)).status).toBe(200);
    expect(seen(await download(orderA.docId, viewer.cookie)).status).toBe(404);

    await capability.capabilityService.revoke(prisma, guest.grantId, "staff");
    expect(seen(await download(orderA.docId, guest.cookie)).status).toBe(404);
    expect(seen(await list(orderA.reference, guest.cookie)).status).toBe(404);

    // A forged cookie (another grant id under the old signature) is refused.
    const [name, value] = guest.cookie.split("=");
    const parts = value.split(".");
    expect(seen(await download(orderA.docId, `${name}=${[parts[0], viewer.grantId, parts[2], parts[3]].join(".")}`)).status).toBe(404);
  });

  it("one browser keeps grants for two orders: a second link adds to the cookie instead of replacing it (R-B4-11)", async () => {
    const ga = await capability.capabilityService.mint(prisma, { orderId: orderA.id, purpose: "download_tickets", issuedFor: "ticket_notification" });
    const gb = await capability.capabilityService.mint(prisma, { orderId: orderB.id, purpose: "download_tickets", issuedFor: "ticket_notification" });
    const first = seen(await exchange(ga.token));
    const second = seen(await exchange(gb.token, { cookie: cookieFrom(first) }));
    expect(await second.json()).toMatchObject({ ok: true, reference: orderB.reference });
    const both = cookieFrom(second);
    expect(both).not.toContain(orderA.id);
    expect(both).not.toContain(orderB.id);
    expect(seen(await download(orderA.docId, both)).status).toBe(200);
    expect(seen(await download(orderB.docId, both)).status).toBe(200);
    // Revoking one order's grant stops that order only, on the next request.
    await capability.capabilityService.revoke(prisma, ga.grantId, "staff");
    expect(seen(await download(orderA.docId, both)).status).toBe(404);
    expect(seen(await list(orderA.reference, both)).status).toBe(404);
    expect(seen(await download(orderB.docId, both)).status).toBe(200);
  });

  it("exchange: httpOnly SameSite=Strict cookie; expired, revoked, used-up and unknown tokens get one refusal", async () => {
    const g = await capability.capabilityService.mint(prisma, { orderId: orderB.id, purpose: "download_tickets", issuedFor: "ticket_notification" });
    const ok = seen(await exchange(g.token));
    expect(ok.status).toBe(200);
    expect(ok.headers.get("cache-control")).toBe("private, no-store");
    expect(ok.headers.get("referrer-policy")).toBe("no-referrer");
    const set = ok.headers.getSetCookie().find((c) => c.startsWith("outlyy_ticket_access="))!;
    expect(set).toMatch(/HttpOnly/i);
    expect(set).toMatch(/SameSite=Strict/i);
    expect(set).toMatch(/Path=\//);
    expect(set).not.toContain(g.token);
    expect(await ok.json()).toMatchObject({ ok: true, purpose: "download_tickets", reference: orderB.reference });

    const expired = await capability.capabilityService.mint(prisma, { orderId: orderB.id, purpose: "view_status", issuedFor: "status_notification" });
    await prisma.guestCapabilityGrant.update({ where: { id: expired.grantId }, data: { expiresAt: new Date(Date.now() - 1000), createdAt: new Date(Date.now() - 2000) } });
    const revoked = await capability.capabilityService.mint(prisma, { orderId: orderB.id, purpose: "cancel_request", issuedFor: "status_notification" });
    await capability.capabilityService.revoke(prisma, revoked.grantId, "staff");
    await prisma.guestCapabilityGrant.update({ where: { id: g.grantId }, data: { exchangeCount: capability.CAPABILITY_LIMITS.maxExchanges } });

    const refusals = [];
    for (const token of [expired.token, revoked.token, g.token, randomBytes(32).toString("base64url")]) {
      const res = seen(await exchange(token));
      expect(res.status).toBe(404);
      expect(res.headers.getSetCookie().some((c) => c.startsWith("outlyy_ticket_access="))).toBe(false);
      refusals.push(await res.text());
    }
    expect(new Set(refusals).size).toBe(1);

    // Strict body: unknown keys and non-JSON are refused before any lookup.
    const { POST } = await exchangeRoute();
    expect((await POST(apiRequest("/api/tickets/exchange", { body: { token: g.token, extra: 1 }, headers: { "x-real-ip": nextIp() } }), params({}))).status).toBe(422);
    expect((await POST(apiRequest("/api/tickets/exchange", { rawBody: `token=${g.token}`, contentType: "application/x-www-form-urlencoded", headers: { "x-real-ip": nextIp() } }), params({}))).status).toBe(415);
  });

  it("a GET of the link consumes nothing: the exchange route has no GET and the token rides in the fragment", async () => {
    const mod = (await exchangeRoute()) as Record<string, unknown>;
    expect(mod.GET).toBeUndefined();
    expect(mod.HEAD).toBeUndefined();
    const g = await capability.capabilityService.mint(prisma, { orderId: orderA.id, purpose: "view_status", issuedFor: "status_notification" });
    const { ticketLink } = await import("@/server/notifications/templates");
    const link = new URL(ticketLink("https://outlyy.com", g.token));
    // What a scanner or preview would request: the path and query, never the fragment.
    expect(`${link.pathname}${link.search}`).toBe("/t");
    const row = await prisma.guestCapabilityGrant.findUniqueOrThrow({ where: { id: g.grantId } });
    expect(row).toMatchObject({ exchangeCount: 0, exchangedAt: null, revokedAt: null });
  });

  it("staff: a role without tickets.view is refused; ops is allowed and audited with field names and ids only", async () => {
    expect(seen(await list(orderA.reference, agentStaff.cookie)).status).toBe(404);
    expect(seen(await download(orderA.docId, agentStaff.cookie)).status).toBe(404);

    const res = seen(await download(orderA.hiddenDocId, ops.cookie));
    expect(res.status).toBe(200);
    expect(seen(await list(orderA.reference, ops.cookie)).status).toBe(200);
    const rows = await prisma.auditLog.findMany({ where: { actorId: ops.id, action: { in: ["tickets.view_document", "tickets.view_list"] } } });
    expect(rows.map((r) => r.action).sort()).toEqual(["tickets.view_document", "tickets.view_list"]);
    const text = JSON.stringify(rows, (_k, v) => (typeof v === "bigint" ? v.toString() : v));
    expect(text).not.toContain(orderA.leadEmail);
    expect(text).not.toContain(orderA.leadName);
    expect(text).not.toContain(A.phoneE164);
    expect(rows.find((r) => r.action === "tickets.view_document")?.after).toEqual({ orderId: orderA.id, fields: ["supplier_documents.content"] });
  });

  it("a document being prepared is 503 { status: preparing } with Retry-After, to the owner only", async () => {
    unavailable.add(orderA.docId);
    const res = seen(await download(orderA.docId, A.cookie));
    expect(res.status).toBe(503);
    expect(res.headers.get("retry-after")).toBe("300");
    expect(res.headers.get("cache-control")).toBe("private, no-store");
    expect(res.headers.get("referrer-policy")).toBe("no-referrer");
    expect(await res.json()).toEqual({ status: "preparing" });
    expect(seen(await download(orderA.docId, B.cookie)).status).toBe(404);
  });

  it("staff resend: tickets.resend required; the previous capability stops working", async () => {
    const { POST } = await resendRoute();
    const call = (cookie: string) => POST(apiRequest(`/api/tickets/orders/${orderA.reference}/resend`, { method: "POST", cookie }), params({ reference: orderA.reference }));
    const guest = await grantCookie(orderA.id, "download_tickets");
    expect(seen(await download(orderA.docId, guest.cookie)).status).toBe(200);

    expect(seen(await call(agentStaff.cookie)).status).toBe(403);
    const res = seen(await call(ops.cookie));
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ outcome: "sent", duplicate: false });
    expect(seen(await download(orderA.docId, guest.cookie)).status, "superseded by the resend").toBe(404);
    const audit = await prisma.auditLog.findFirstOrThrow({ where: { action: "tickets.resend", entityId: orderA.id } });
    expect(JSON.stringify(audit, (_k, v) => (typeof v === "bigint" ? v.toString() : v))).not.toContain(orderA.leadEmail);
  });

  it("no response redirected or named a storage URL", async () => {
    expect(all.length).toBeGreaterThan(20);
    for (const res of all) {
      expect(res.status < 300 || res.status >= 400, `status ${res.status}`).toBe(true);
      expect(res.headers.get("location")).toBeNull();
      const ct = res.headers.get("content-type") ?? "";
      if (ct.includes("json")) expect(await res.text()).not.toMatch(/https?:\/\/|test\/[0-9a-f]{32}|storage|Guid=/i);
    }
  });
});
