import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { createHash, randomBytes } from "node:crypto";
import { apiRequest, assertDisposableDb, dbEnabled, params, runId, syntheticPhone } from "../../__tests__/helpers/fixtures";
import { forbidNetwork, leadTag, publishedProduct } from "../../__tests__/security/_mercury-fixtures";
import { formatReference, uuidv7 } from "../../lib/ids";
import type { Actor } from "../../lib/actor";

/**
 * PRV-3 erasure workflow (doc 22 §23 B4; money-tickets-privacy.md PRV-2,
 * PRV-3, PRV-7) on the disposable database:
 *
 *  - every PII store is erased or pseudonymised for an order with nothing owed;
 *  - an active obligation (future service, pending refund, dispute window,
 *    open payment or supplier attempt) defers that order and keeps what
 *    fulfilment and refunds need, while the rest is erased;
 *  - suppression is a keyed hash, never plaintext, and a new inquiry from the
 *    same number is filed as spam;
 *  - the audit row holds field names, ids and counts, no contact value;
 *  - ticket codes are deleted, documents are no longer served and their
 *    stored objects removed, capability grants are revoked (`erasure`);
 *  - a customer account linked to a deferred order stays open (R-B4-2), a
 *    failed refund or remedy still defers its order (R-B4-7), the legacy
 *    plaintext suppression row goes (R-B4-6), and a missing `lookup` ring
 *    degrades the inquiry suppression check but fails erasure closed (R-B4-3).
 *
 * Every row is synthetic. Rows that can be deleted are deleted afterwards;
 * audit rows and inquiry events are append-only and stay, without contacts.
 */

type Prisma = typeof import("../../lib/db").prisma;

const run = runId();
const DAY = 86_400_000;
const PAST = "2026-01-10";
const FUTURE = "2030-01-15";
const sha = (s: string) => createHash("sha256").update(s).digest("hex");
const hex32 = () => randomBytes(16).toString("hex");

let prisma: Prisma;
let comboId: string;
let supplierId: string;
const created = {
  orders: [] as string[],
  inquiries: [] as string[],
  customers: [] as string[],
  guests: [] as string[],
  bookings: [] as string[],
  documents: [] as string[],
  quotes: [] as string[],
  guestSessions: [] as string[],
  notifications: [] as string[],
  webhooks: [] as string[],
  wa: [] as string[],
  hashes: [] as string[],
  phones: [] as string[],
};

/** Session cookie per customer id, for the customers created here. */
const cookies = new Map<string, string>();

const staff = (permissions: string[]): Actor => ({ type: "admin", id: uuidv7(), roles: ["admin"], permissions: new Set(permissions) });
const ADMIN = staff(["privacy.anonymise"]);

function phone(n: number): string {
  const p = syntheticPhone(run, n);
  created.phones.push(p);
  return p;
}
const email = (label: string) => `zz-priv-${run}-${label}@outlyy.test`;

async function customer(p: string, e: string | null) {
  const id = uuidv7();
  const token = randomBytes(32).toString("base64url");
  await prisma.customer.create({ data: { id, phoneE164: p, email: e, fullName: `${leadTag(run)} cust`, hotel: "Palm Hotel", dietary: "jain" } });
  await prisma.customerSession.create({ data: { id: uuidv7(), customerId: id, tokenHash: sha(token), ipHash: "ip-hash", userAgent: "ua", expiresAt: new Date(Date.now() + DAY) } });
  const { CUSTOMER_COOKIE } = await import("../../lib/customer-session");
  cookies.set(id, `${CUSTOMER_COOKIE}=${token}`);
  created.customers.push(id);
  return id;
}

async function inquiry(p: string, e: string | null, customerId: string | null) {
  const [{ n }] = await prisma.$queryRaw<{ n: bigint }[]>`SELECT nextval('inquiry_ref_seq') AS n`;
  const id = uuidv7();
  await prisma.inquiry.create({
    data: {
      id,
      reference: formatReference("INQ", n),
      source: "inquiry_form",
      leadName: `${leadTag(run)} inq`,
      leadPhone: p,
      leadEmail: e,
      countryCode: "+91",
      hotel: "Palm Hotel",
      dietary: "jain",
      pickupZone: "marina",
      specialRequests: "wheelchair",
      attribution: { fbclid: "fb.1" },
      ipHash: "ip-hash",
      userAgent: "ua",
      sessionId: "sess",
      anonId: "anon",
      customerId,
    },
  });
  created.inquiries.push(id);
  return id;
}

interface OrderFixture {
  orderId: string;
  itemId: string;
  guestId: string;
}

async function order(p: string, e: string | null, opts: { serviceDate: string; customerId?: string | null; inquiryId?: string | null }): Promise<OrderFixture> {
  const guestId = uuidv7();
  await prisma.guest.create({ data: { id: guestId, phoneE164: p, email: e, fullName: `${leadTag(run)} guest` } });
  created.guests.push(guestId);
  const [{ n }] = await prisma.$queryRaw<{ n: bigint }[]>`SELECT nextval('order_ref_seq') AS n`;
  const orderId = uuidv7();
  await prisma.order.create({
    data: {
      id: orderId,
      reference: formatReference("OUT", n),
      status: "confirmed",
      rail: "self_serve",
      guestId,
      currency: "AED",
      subtotalInr: 0n,
      subtotalAed: 1000n,
      totalInr: 0n,
      totalAed: 1000n,
      leadName: `${leadTag(run)} lead`,
      leadPhone: p,
      leadEmail: e,
      hotel: "Palm Hotel",
      pickupZone: "marina",
      dietary: "jain",
      specialRequests: "wheelchair",
      customerId: opts.customerId ?? null,
      sourceInquiryId: opts.inquiryId ?? null,
    },
  });
  created.orders.push(orderId);
  await prisma.orderAttribution.create({ data: { orderId, firstSource: "meta", fbclid: "fb.1", fbc: "fbc", fbp: "fbp", gclid: "g" } });
  const itemId = uuidv7();
  await prisma.$executeRaw`
    INSERT INTO order_items
      (id, order_id, combo_id, title_snapshot, tier_snapshot, slug_snapshot, kind_snapshot, confirmation_snapshot,
       fulfilment_mode_snapshot, free_cancellation_hours_snapshot, duration_minutes_snapshot, service_date, pax,
       unit_inr, unit_aed, total_inr, total_aed, status)
    VALUES
      (${itemId}::uuid, ${orderId}::uuid, ${comboId}::uuid, 'zz-priv', 'C', ${`zz-priv-${run}`}, 'combo', 'instant',
       'instant', 24, 60, ${opts.serviceDate}::date, '{"adult":1}'::jsonb, 0, 1000, 0, 1000, 'confirmed')`;
  return { orderId, itemId, guestId };
}

async function payment(o: OrderFixture, capturedDaysAgo: number) {
  const id = uuidv7();
  await prisma.payment.create({
    data: { id, orderId: o.orderId, gateway: "razorpay", gatewayPaymentId: `pay_zzpriv_${run}_${id.slice(-8)}`, amountMinor: 1000n, currency: "AED", status: "captured", capturedMinor: 1000n, capturedAt: new Date(Date.now() - capturedDaysAgo * DAY) },
  });
  return id;
}

let bookingN = 0;
async function booking(o: OrderFixture, state = "confirmed", serviceDate = PAST) {
  const id = uuidv7();
  bookingN += 1;
  await prisma.supplierBooking.create({
    data: {
      id,
      orderId: o.orderId,
      orderItemId: o.itemId,
      supplierId,
      environment: "test",
      idempotencyKey: `zz-priv:${run}:${bookingN}`,
      clientRef: `zzp${run}${bookingN}`,
      bookingKind: "live_book",
      state: state as never,
      tourExternalId: "t1",
      offerExternalId: "o1",
      serviceDate: new Date(`${serviceDate}T00:00:00Z`),
      adults: 1,
      guestName: `${leadTag(run)} guest name`,
      expectedNetMinor: 0n,
      expectedNetUsdMinor: 0n,
      requestPayload: { tourId: "t1", leadName: "Asha Rao", specialRequests: "wheelchair" },
      requestHash: sha("request"),
    },
  });
  created.bookings.push(id);
  return id;
}

/** A valid code set with two codes, a valid PDF with a stored object, and a live grant. */
async function tickets(o: OrderFixture, bookingId: string, store: import("../../documents/memory-store").MemoryDocumentStore) {
  const { encryptFor, ciphertextKeyId, hmacFor } = await import("../../lib/crypto");
  const codesDoc = uuidv7();
  await prisma.supplierDocument.create({ data: { id: codesDoc, supplierBookingId: bookingId, orderId: o.orderId, orderItemId: o.itemId, kind: "ticket_codes", version: 1, status: "valid", source: "confirm_response" } });
  for (const unitIndex of [0, 1]) {
    const ct = encryptFor("ticket_codes", `ZZ-CODE-${run}-${unitIndex}`);
    await prisma.supplierTicketCode.create({
      data: { id: uuidv7(), documentId: codesDoc, supplierBookingId: bookingId, unitIndex, ticketFor: "adult", codeCiphertext: ct, codeKeyId: ciphertextKeyId(ct), codeHash: hmacFor("ticket_code_hash", `ZZ-CODE-${run}-${unitIndex}`) },
    });
  }
  const pdfDoc = uuidv7();
  const storageKey = `test/${hex32()}`;
  const bytes = new TextEncoder().encode("%PDF-1.4 zz");
  await store.put(storageKey, bytes, "application/pdf");
  await prisma.supplierDocument.create({
    data: { id: pdfDoc, supplierBookingId: bookingId, orderId: o.orderId, orderItemId: o.itemId, kind: "tickets_pdf", version: 1, status: "valid", source: "pdf_download", storageKey, contentType: "application/pdf", byteSize: bytes.byteLength, sha256: sha("pdf") },
  });
  created.documents.push(codesDoc, pdfDoc);
  const grantId = uuidv7();
  await prisma.guestCapabilityGrant.create({
    data: { id: grantId, tokenHash: sha(randomBytes(32).toString("hex")), tokenCiphertext: encryptFor("capability_tokens", "zz-token"), orderId: o.orderId, purpose: "download_tickets", issuedFor: "ticket_notification", expiresAt: new Date(Date.now() + 30 * DAY) },
  });
  return { codesDoc, pdfDoc, storageKey, grantId };
}

async function notification(data: { recipient: string; orderId?: string; inquiryId?: string; status?: "queued" | "sent"; channel?: "whatsapp" | "email"; event?: string; payload?: Record<string, unknown> }) {
  const id = uuidv7();
  await prisma.notification.create({
    data: {
      id,
      event: data.event ?? "TICKETS_READY",
      channel: data.channel ?? "whatsapp",
      recipient: data.recipient,
      orderId: data.orderId,
      inquiryId: data.inquiryId,
      status: data.status ?? "sent",
      payload: (data.payload ?? { leadName: "Asha Rao", leadPhone: data.recipient, hotel: "Palm Hotel", dietary: "jain" }) as never,
      providerError: data.status === "sent" ? null : "rejected for +919900000000",
    },
  });
  created.notifications.push(id);
  return id;
}

async function webhook(payload: Record<string, unknown>) {
  const id = uuidv7();
  await prisma.webhookEvent.create({ data: { id, provider: "whatsapp", providerEventId: `zz-priv-${run}-${id.slice(-12)}`, eventType: "message.text", payload: payload as never, signatureValid: true } });
  created.webhooks.push(id);
  return id;
}

/** A stored quote line with the Batch 3 pickup copy: the hotel id and the accepted hotel's name. */
const pickupLine = (hotelRef: string, hotelName: string) => ({ index: 0, productId: uuidv7(), serviceDate: PAST, pickup: { hotelRef, hotelName } });

async function quoteWithVerification(channel: "phone" | "email", contact: string, orderId: string | null, lines: unknown[] = []) {
  const gs = uuidv7();
  await prisma.guestSession.create({ data: { id: gs, tokenHash: sha(randomBytes(8).toString("hex")), expiresAt: new Date(Date.now() + DAY) } });
  created.guestSessions.push(gs);
  const quoteId = uuidv7();
  await prisma.quote.create({
    data: { id: quoteId, fingerprint: sha(quoteId), ownerKind: "guest", guestSessionId: gs, currency: "AED", totalMinor: 1000n, lines: lines as never, request: {}, status: orderId ? "used" : "active", usedByOrderId: orderId, expiresAt: new Date(Date.now() + DAY) },
  });
  created.quotes.push(quoteId);
  const id = uuidv7();
  await prisma.orderContactVerification.create({
    data: { id, quoteId, orderId, channel, contactHash: sha(contact), method: channel === "phone" ? "otp_whatsapp" : "email_code", verifiedAt: new Date() },
  });
  return { quoteId, verificationId: id };
}

function noContact(value: unknown, ...contacts: string[]) {
  const text = JSON.stringify(value, (_k, v) => (typeof v === "bigint" ? v.toString() : v));
  for (const c of contacts) expect(text).not.toContain(c);
}

describe.skipIf(!dbEnabled)("privacy erasure workflow (PRV-3)", () => {
  let store: import("../../documents/memory-store").MemoryDocumentStore;

  beforeAll(async () => {
    assertDisposableDb();
    forbidNetwork();
    ({ prisma } = await import("../../lib/db"));
    const { MemoryDocumentStore } = await import("../../documents/memory-store");
    const { setDocumentStoreForTests } = await import("../../documents/store");
    store = new MemoryDocumentStore();
    setDocumentStoreForTests(store);
    comboId = uuidv7();
    await prisma.combo.create({ data: { id: comboId, slug: `zz-priv-${run}`, name: "zz-priv", confirmation: "instant" } });
    supplierId = uuidv7();
    await prisma.supplier.create({ data: { id: supplierId, code: `zz-priv-${run}`, name: "zz-priv", source: "api", adapter: "manual" } });
  });

  afterAll(async () => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    const { setKeyRingsForTests } = await import("../../lib/crypto");
    setKeyRingsForTests(null);
    const { setDocumentStoreForTests } = await import("../../documents/store");
    setDocumentStoreForTests(undefined);
    const quiet = async (fn: () => Promise<unknown>) => {
      try {
        await fn();
      } catch {
        // Best effort: the disposable database tolerates leftovers.
      }
    };
    const orderIds = created.orders;
    await quiet(() => prisma.supplierTicketCode.deleteMany({ where: { supplierBookingId: { in: created.bookings } } }));
    await quiet(() => prisma.supplierDocument.deleteMany({ where: { supplierBookingId: { in: created.bookings } } }));
    await quiet(() => prisma.guestCapabilityGrant.deleteMany({ where: { orderId: { in: orderIds } } }));
    await quiet(() => prisma.notification.deleteMany({ where: { id: { in: created.notifications } } }));
    await quiet(() => prisma.webhookEvent.deleteMany({ where: { id: { in: created.webhooks } } }));
    await quiet(() => prisma.customerRemedy.deleteMany({ where: { orderId: { in: orderIds } } }));
    await quiet(() => prisma.refund.deleteMany({ where: { payment: { orderId: { in: orderIds } } } }));
    await quiet(() => prisma.paymentSaga.deleteMany({ where: { orderId: { in: orderIds } } }));
    await quiet(() => prisma.orderContactVerification.deleteMany({ where: { quoteId: { in: created.quotes } } }));
    await quiet(() => prisma.quote.deleteMany({ where: { id: { in: created.quotes } } }));
    await quiet(() => prisma.guestSession.deleteMany({ where: { id: { in: created.guestSessions } } }));
    await quiet(() => prisma.payment.deleteMany({ where: { orderId: { in: orderIds } } }));
    await quiet(() => prisma.supplierBooking.deleteMany({ where: { id: { in: created.bookings } } }));
    await quiet(() => prisma.orderAttribution.deleteMany({ where: { orderId: { in: orderIds } } }));
    await quiet(() => prisma.orderItem.deleteMany({ where: { orderId: { in: orderIds } } }));
    await quiet(() => prisma.order.deleteMany({ where: { id: { in: orderIds } } }));
    await quiet(() => prisma.guest.deleteMany({ where: { id: { in: created.guests } } }));
    // One by one: an inquiry with timeline events (the spam-filed one) is append-only and stays.
    for (const id of created.inquiries) {
      if ((await prisma.inquiryEvent.count({ where: { inquiryId: id } })) === 0) await quiet(() => prisma.inquiry.delete({ where: { id } }));
    }
    await quiet(() => prisma.customer.deleteMany({ where: { id: { in: created.customers } } }));
    await quiet(() => prisma.waConversation.deleteMany({ where: { id: { in: created.wa } } }));
    await quiet(() => prisma.otpChallenge.deleteMany({ where: { phoneE164: { in: created.phones } } }));
    await quiet(() => prisma.suppressedContact.deleteMany({ where: { contactHash: { in: created.hashes } } }));
    await quiet(() => prisma.suppressedPhone.deleteMany({ where: { phoneE164: { in: created.phones } } }));
    await quiet(() => prisma.supplier.delete({ where: { id: supplierId } }));
    await quiet(() => prisma.combo.delete({ where: { id: comboId } }));
  });

  async function trackSuppression(p: string | null, e: string | null) {
    const { suppressionCandidates } = await import("../../repositories/privacy.repo");
    if (p) created.hashes.push(...suppressionCandidates("phone", p));
    if (e) created.hashes.push(...suppressionCandidates("email", e));
  }

  it("refuses a caller without privacy.anonymise, and a malformed or missing contact", async () => {
    const { privacyService } = await import("../privacy.service");
    await expect(privacyService.requestErasure(staff(["inquiries.view"]), { phoneE164: phone(90) })).rejects.toMatchObject({ status: 403 });
    await expect(privacyService.requestErasure(ADMIN, { phoneE164: "0501234567" })).rejects.toMatchObject({ status: 422 });
    await expect(privacyService.requestErasure(ADMIN, { email: "not-an-address" })).rejects.toMatchObject({ status: 422 });
    await expect(privacyService.requestErasure(ADMIN, {})).rejects.toMatchObject({ status: 422 });
  });

  it("nothing owed: every PII store is erased or pseudonymised, money stays, tickets go, grants are revoked", async () => {
    const P = phone(1);
    const E = email("a");
    const digits = P.slice(1);
    const other = phone(2);
    const custId = await customer(P, E);
    const inqId = await inquiry(P, E, custId);
    const o = await order(P, E, { serviceDate: PAST, customerId: custId, inquiryId: inqId });
    const paymentId = await payment(o, 200);
    await prisma.paymentSaga.create({ data: { id: uuidv7(), orderId: o.orderId, orderItemId: o.itemId, paymentId, rail: "aed_card", state: "fulfilled" } });
    const bookingId = await booking(o);
    const t = await tickets(o, bookingId, store);
    const ocvBound = await quoteWithVerification("phone", P, o.orderId, [pickupLine("42", "zz Example Marina Hotel"), { index: 1, productId: uuidv7(), serviceDate: PAST, pickup: null }]);
    const ocvLoose = await quoteWithVerification("email", E, null, [pickupLine("43", "zz Example Creek Hotel")]);
    const otherQuote = await quoteWithVerification("phone", other, null, [pickupLine("44", "zz Example Other Hotel")]);
    await prisma.orderItem.update({ where: { id: o.itemId }, data: { pickupHotelId: "42", pickupHotelNameSnapshot: "zz Example Marina Hotel" } });
    const otherRecovery = uuidv7();
    await prisma.otpChallenge.createMany({
      data: [
        { id: uuidv7(), phoneE164: P, codeHash: sha("1"), expiresAt: new Date(Date.now() + 300_000) },
        { id: uuidv7(), phoneE164: `ocv:v1:${ocvLoose.quoteId}:email:${sha(E)}`, codeHash: sha("2"), expiresAt: new Date(Date.now() + 300_000) },
        { id: uuidv7(), phoneE164: other, codeHash: sha("3"), expiresAt: new Date(Date.now() + 300_000) },
        // Order recovery (R-B5-4): by the subject's phone hash, by its email hash on another order, and any row of an erased order.
        { id: uuidv7(), phoneE164: `rcv:v1:${o.orderId}:phone:${sha(P)}`, codeHash: sha("4"), expiresAt: new Date(Date.now() + 300_000) },
        { id: uuidv7(), phoneE164: `rcv:v1:${uuidv7()}:email:${sha(E)}`, codeHash: sha("5"), expiresAt: new Date(Date.now() + 300_000) },
        { id: uuidv7(), phoneE164: `rcv:v1:${o.orderId}:email:${sha(`zz-unrelated-${P}`)}`, codeHash: sha("6"), expiresAt: new Date(Date.now() + 300_000) },
        { id: otherRecovery, phoneE164: `rcv:v1:${uuidv7()}:phone:${sha(other)}`, codeHash: sha("7"), expiresAt: new Date(Date.now() + 300_000) },
      ],
    });
    const waId = uuidv7();
    await prisma.waConversation.create({ data: { id: waId, phoneE164: P, entryContext: { ref: "x" }, attribution: { ctwa: "y" } } });
    created.wa.push(waId);
    const nSent = await notification({ recipient: P, orderId: o.orderId });
    const nQueued = await notification({ recipient: E, channel: "email", status: "queued", event: "ORDER_STATUS" });
    const nOps = await notification({ recipient: "ops@outlyy.test", inquiryId: inqId, channel: "email", event: "INQUIRY_OPS_ALERT", payload: { leadName: "Asha Rao", leadPhone: P } });
    const nDeletion = await notification({ recipient: "ops@outlyy.test", channel: "email", event: "ACCOUNT_DELETION_REQUEST", payload: { customerId: custId, leadPhone: P, leadEmail: E } });
    const nOther = await notification({ recipient: other, payload: { leadPhone: other } });
    const wMessage = await webhook({ id: "wamid.1", from: digits, type: "text", text: { body: "hello, I am Asha" } });
    const wStatus = await webhook({ id: "wamid.2", status: "delivered", recipient_id: digits });
    const wEnvelope = await webhook({ object: "whatsapp_business_account", entry: [{ changes: [{ value: { contacts: [{ wa_id: digits, profile: { name: "Asha" } }] } }] }] });
    const wOther = await webhook({ id: "wamid.3", from: other.slice(1), type: "text", text: { body: "someone else" } });
    const paymentBefore = await prisma.payment.findUniqueOrThrow({ where: { id: paymentId } });
    await trackSuppression(P, E);

    const { privacyService } = await import("../privacy.service");
    const result = await privacyService.requestErasure(ADMIN, { phoneE164: P, email: E.toUpperCase() });

    expect(result).toMatchObject({ status: "completed", obligations: [], deferredOrders: [], suppressed: { phone: true, email: true }, storage: { deleted: 1, failed: 0 } });
    expect(result.counts).toMatchObject({ customers: 1, customerSessions: 1, otpChallenges: 5, inquiries: 1, orders: 1, ordersDeferred: 0, guests: 1, verifications: 2, supplierBookings: 1, ticketCodes: 2, documents: 2, grants: 1, notifications: 4, notificationsCancelled: 1, webhookEvents: 3, waConversations: 1 });
    const marker = `[deleted-${result.token}]`;
    expect(result.token).toMatch(/^[0-9a-f]{12}$/);

    // Customers: account closed, sessions revoked, OTP challenges gone.
    const c = await prisma.customer.findUniqueOrThrow({ where: { id: custId } });
    expect(c).toMatchObject({ email: null, fullName: null, hotel: null, dietary: null });
    expect(c.phoneE164).toMatch(/^\[deleted-/);
    expect(c.deletedAt).not.toBeNull();
    expect(await prisma.customerSession.count({ where: { customerId: custId, revokedAt: null } })).toBe(0);
    expect(await prisma.customerSession.count({ where: { customerId: custId, OR: [{ ipHash: { not: null } }, { userAgent: { not: null } }] } })).toBe(0);
    expect(await prisma.otpChallenge.count({ where: { OR: [{ phoneE164: P }, { phoneE164: { contains: sha(E) } }] } })).toBe(0);
    expect(await prisma.otpChallenge.count({ where: { phoneE164: other } })).toBe(1);
    expect(await prisma.otpChallenge.count({ where: { OR: [{ phoneE164: { contains: sha(P) } }, { phoneE164: { startsWith: `rcv:v1:${o.orderId}:` } }] } })).toBe(0);
    expect(await prisma.otpChallenge.count({ where: { id: otherRecovery } }), "another person's recovery row stays").toBe(1);
    await prisma.otpChallenge.deleteMany({ where: { id: otherRecovery } });

    // Inquiry, order, guest, attribution.
    const inq = await prisma.inquiry.findUniqueOrThrow({ where: { id: inqId } });
    expect(inq).toMatchObject({ leadName: marker, leadPhone: marker, leadEmail: null, hotel: null, dietary: null, pickupZone: null, specialRequests: null, attribution: null, ipHash: null, userAgent: null, sessionId: null, anonId: null });
    const ord = await prisma.order.findUniqueOrThrow({ where: { id: o.orderId } });
    expect(ord).toMatchObject({ leadName: marker, leadPhone: marker, leadEmail: null, hotel: null, dietary: null, pickupZone: null, specialRequests: null, totalAed: 1000n, status: "confirmed" });
    expect(await prisma.guest.findUniqueOrThrow({ where: { id: o.guestId } })).toMatchObject({ fullName: marker, phoneE164: marker, email: null });
    expect(await prisma.orderAttribution.findUniqueOrThrow({ where: { orderId: o.orderId } })).toMatchObject({ firstSource: "meta", fbclid: null, fbc: null, fbp: null, gclid: null });
    // Money is a financial record: untouched.
    expect(await prisma.payment.findUniqueOrThrow({ where: { id: paymentId } })).toEqual(paymentBefore);

    // Verifications keep their shape; the contact hash no longer links to the person.
    for (const v of [ocvBound, ocvLoose]) {
      const row = await prisma.orderContactVerification.findUniqueOrThrow({ where: { id: v.verificationId } });
      expect(row.contactHash).toMatch(/^[0-9a-f]{64}$/);
      expect([sha(P), sha(E)]).not.toContain(row.contactHash);
    }

    // Pickup hotel (Batch 3): the item's id and name, and the quote's copy of the name, on the erased order's quote and on
    // the subject's unused quote. The hotel id in the quote lines stays (its readers require it); another person's quote is untouched.
    expect(await prisma.orderItem.findUniqueOrThrow({ where: { id: o.itemId }, select: { pickupHotelId: true, pickupHotelNameSnapshot: true } })).toEqual({ pickupHotelId: null, pickupHotelNameSnapshot: null });
    expect((await prisma.quote.findUniqueOrThrow({ where: { id: ocvBound.quoteId } })).lines).toEqual([
      { ...pickupLine("42", "x"), productId: expect.any(String), pickup: { hotelRef: "42", hotelName: null } },
      { index: 1, productId: expect.any(String), serviceDate: PAST, pickup: null },
    ]);
    expect((await prisma.quote.findUniqueOrThrow({ where: { id: ocvLoose.quoteId } })).lines).toMatchObject([{ pickup: { hotelRef: "43", hotelName: null } }]);
    expect((await prisma.quote.findUniqueOrThrow({ where: { id: otherQuote.quoteId } })).lines).toMatchObject([{ pickup: { hotelRef: "44", hotelName: "zz Example Other Hotel" } }]);

    // Supplier attempt, tickets, documents, grants.
    const b = await prisma.supplierBooking.findUniqueOrThrow({ where: { id: bookingId } });
    expect(b.guestName).toBe(marker);
    expect(b.requestPayload).toEqual({ tourId: "t1", leadName: marker, specialRequests: marker });
    expect(b.requestHash).toBeNull();
    expect(await prisma.supplierTicketCode.count({ where: { supplierBookingId: bookingId } })).toBe(0);
    const docs = await prisma.supplierDocument.findMany({ where: { id: { in: [t.codesDoc, t.pdfDoc] } } });
    for (const d of docs) expect(d).toMatchObject({ status: "superseded", customerVisible: false, storageKey: null, quarantineReason: "erased" });
    expect(store.has(t.storageKey)).toBe(false);
    expect(await prisma.guestCapabilityGrant.findUniqueOrThrow({ where: { id: t.grantId } })).toMatchObject({ revokeReason: "erasure", tokenCiphertext: null });

    // Notifications: payloads gone, the person's addresses masked, staff addresses kept, the queued one cancelled.
    const notes = Object.fromEntries((await prisma.notification.findMany({ where: { id: { in: [nSent, nQueued, nOps, nDeletion, nOther] } } })).map((n) => [n.id, n]));
    for (const id of [nSent, nQueued, nOps, nDeletion]) expect(notes[id]).toMatchObject({ payload: null, providerError: null });
    expect(notes[nSent].recipient).toBe(marker);
    expect(notes[nQueued]).toMatchObject({ recipient: marker, status: "suppressed", suppressedReason: "deletion_request" });
    expect(notes[nOps].recipient).toBe("ops@outlyy.test");
    expect(notes[nDeletion].recipient).toBe("ops@outlyy.test");
    expect(notes[nOther]).toMatchObject({ recipient: other, payload: { leadPhone: other } });

    // WhatsApp: conversation pseudonymised, inbound bodies for the number erased, others untouched.
    expect(await prisma.waConversation.findUniqueOrThrow({ where: { id: waId } })).toMatchObject({ phoneE164: marker, entryContext: null, attribution: null });
    for (const id of [wMessage, wStatus, wEnvelope]) expect((await prisma.webhookEvent.findUniqueOrThrow({ where: { id } })).payload).toEqual({ erased: true });
    expect((await prisma.webhookEvent.findUniqueOrThrow({ where: { id: wOther } })).payload).toMatchObject({ from: other.slice(1) });

    // Nothing in any row this subject owned still names them.
    noContact(await prisma.customer.findUnique({ where: { id: custId } }), P, E);
    noContact(await prisma.notification.findMany({ where: { id: { in: [nSent, nQueued, nOps, nDeletion] } } }), P, E, digits, "Asha");
    noContact(await prisma.webhookEvent.findMany({ where: { id: { in: [wMessage, wStatus, wEnvelope] } } }), digits, "Asha");

    // Audit: field names, ids and counts; no contact value.
    const audit = await prisma.auditLog.findFirstOrThrow({ where: { action: "privacy.erasure", entityType: "privacy_request", entityId: result.requestId } });
    expect(audit).toMatchObject({ actorType: "admin", actorId: ADMIN.id, before: null });
    const after = audit.after as { fields: string[]; ids: Record<string, unknown>; counts: Record<string, number>; codes: Record<string, unknown> };
    expect(after.fields).toEqual(expect.arrayContaining(["orders.leadPhone", "customers.email", "notifications.payload", "webhook_events.payload", "supplier_ticket_codes.deleted", "order_items.pickupHotelNameSnapshot", "quotes.lines.pickup.hotelName"]));
    expect(after.ids.markerToken).toBe(result.token);
    expect(after.counts).toMatchObject({ orders: 1, ticketCodes: 2, suppressedPhone: 1, suppressedEmail: 1 });
    expect(after.codes).toMatchObject({ status: "completed", obligations: [], channels: ["phone", "email"] });
    noContact(audit, P, E, digits, E.toUpperCase(), "Asha", "Palm");
  });

  it("suppression is a keyed hash with no plaintext, and a new inquiry from the same number is filed as spam", async () => {
    const P = phone(3);
    const E = email("s");
    await trackSuppression(P, E);
    const { privacyService } = await import("../privacy.service");
    const { suppressionCandidates, suppressionHash } = await import("../../repositories/privacy.repo");
    const legacyBefore = await prisma.suppressedPhone.count();
    const r = await privacyService.requestErasure(ADMIN, { phoneE164: P, email: E });
    expect(r).toMatchObject({ status: "completed", suppressed: { phone: true, email: true } });

    const rows = await prisma.suppressedContact.findMany({ where: { contactHash: { in: [...suppressionCandidates("phone", P), ...suppressionCandidates("email", E)] } } });
    expect(rows.map((x) => x.channel).sort()).toEqual(["email", "phone"]);
    expect(rows.map((x) => x.contactHash).sort()).toEqual([suppressionHash("email", E), suppressionHash("phone", P)].sort());
    for (const row of rows) {
      expect(row.contactHash).toMatch(/^[0-9a-f]{64}$/);
      noContact(row, P, P.slice(1), E);
      // Not an unkeyed hash of the contact either.
      expect([sha(P), sha(E), sha(`phone:${P}`), sha(`email:${E}`)]).not.toContain(row.contactHash);
    }
    expect(await prisma.suppressedPhone.count()).toBe(legacyBefore);
    expect(await prisma.suppressedPhone.findUnique({ where: { phoneE164: P } })).toBeNull();

    // A second request for the same contact writes no second row.
    const again = await privacyService.requestErasure(ADMIN, { phoneE164: P });
    expect(again.suppressed.phone).toBe(false);

    const { inquiryRepo } = await import("../../repositories/inquiry.repo");
    expect(await inquiryRepo.isSuppressed(P)).toBe(true);
    expect(await inquiryRepo.isSuppressed(phone(4), E)).toBe(true);
    expect(await inquiryRepo.isSuppressed(phone(5))).toBe(false);

    // The real submission path: accepted, but filed straight to spam with no acknowledgement.
    const product = await publishedProduct();
    const { POST } = await import("@/app/api/inquiries/route");
    const res = await POST(
      apiRequest("/api/inquiries", {
        body: {
          items: [
            {
              id: `${product.slug}-2027-02-01-10:00-std`,
              kind: "activity",
              slug: product.slug,
              title: product.title,
              image: "",
              date: "2027-02-01",
              time: "10:00",
              pax: { adult: 2, child: 0, infant: 0, senior: 0 },
              addOnIds: [],
              unit: { inr: 1, aed: 1 },
              total: { inr: 2, aed: 2 },
              confirmation: "instant",
              fulfilmentMode: "instant",
              freeCancellationHours: 24,
              durationMinutes: 60,
            },
          ],
          leadName: `${leadTag(run)} returning`,
          leadPhone: P.replace(/^\+91/, ""),
          countryCode: "+91",
          datesFlexible: false,
          currency: "INR",
          source: "inquiry_form",
          whatsappConsent: true,
          startedAt: Date.now() - 120_000,
        },
      }),
      params({}),
    );
    expect(res.status).toBe(201);
    const { id } = await res.json();
    created.inquiries.push(id);
    const filed = await prisma.inquiry.findUniqueOrThrow({ where: { id } });
    expect(filed.status).toBe("spam");
    expect(filed.spamSignals).toMatchObject({ suppressed: true });
    expect(await prisma.notification.count({ where: { inquiryId: id, event: "INQUIRY_ACK" } })).toBe(0);
  });

  it("future service: the order keeps contact, guest, supplier name, tickets, grants and its messages; the rest is erased (partial)", async () => {
    const P = phone(6);
    const E = email("f");
    await trackSuppression(P, E);
    const custId = await customer(P, E);
    const inqId = await inquiry(P, E, custId);
    const o = await order(P, E, { serviceDate: FUTURE, customerId: custId, inquiryId: inqId });
    const bookingId = await booking(o, "confirmed", FUTURE);
    const t = await tickets(o, bookingId, store);
    const ocv = await quoteWithVerification("phone", P, o.orderId, [pickupLine("42", "zz Example Marina Hotel")]);
    await prisma.orderItem.update({ where: { id: o.itemId }, data: { pickupHotelId: "42", pickupHotelNameSnapshot: "zz Example Marina Hotel" } });
    const nBound = await notification({ recipient: P, orderId: o.orderId });
    const nLoose = await notification({ recipient: P, event: "OTP" });

    const { privacyService } = await import("../privacy.service");
    const r = await privacyService.requestErasure(ADMIN, { phoneE164: P, email: E });
    expect(r).toMatchObject({ status: "partial", obligations: ["future_service"], deferredOrders: [{ orderId: o.orderId, obligations: ["future_service"] }] });
    expect(r.counts).toMatchObject({ customers: 0, customersDeferred: 1, customerSessions: 0, inquiries: 1, orders: 0, ordersDeferred: 1, guests: 0, supplierBookings: 0, ticketCodes: 0, documents: 0, grants: 0, notifications: 1 });

    // Kept for fulfilment.
    expect(await prisma.order.findUniqueOrThrow({ where: { id: o.orderId } })).toMatchObject({ leadPhone: P, leadEmail: E, hotel: "Palm Hotel", leadName: `${leadTag(run)} lead` });
    expect(await prisma.guest.findUniqueOrThrow({ where: { id: o.guestId } })).toMatchObject({ phoneE164: P });
    expect((await prisma.supplierBooking.findUniqueOrThrow({ where: { id: bookingId } })).guestName).toBe(`${leadTag(run)} guest name`);
    expect(await prisma.supplierTicketCode.count({ where: { supplierBookingId: bookingId } })).toBe(2);
    expect(await prisma.supplierDocument.count({ where: { id: { in: [t.codesDoc, t.pdfDoc] }, status: "valid" } })).toBe(2);
    expect(store.has(t.storageKey)).toBe(true);
    expect(await prisma.guestCapabilityGrant.findUniqueOrThrow({ where: { id: t.grantId } })).toMatchObject({ revokedAt: null });
    expect((await prisma.orderContactVerification.findUniqueOrThrow({ where: { id: ocv.verificationId } })).contactHash).toBe(sha(P));
    // The pickup hotel is needed to fulfil the deferred order: the item and its quote keep it.
    expect(await prisma.orderItem.findUniqueOrThrow({ where: { id: o.itemId }, select: { pickupHotelId: true, pickupHotelNameSnapshot: true } })).toEqual({ pickupHotelId: "42", pickupHotelNameSnapshot: "zz Example Marina Hotel" });
    expect((await prisma.quote.findUniqueOrThrow({ where: { id: ocv.quoteId } })).lines).toMatchObject([{ pickup: { hotelRef: "42", hotelName: "zz Example Marina Hotel" } }]);
    expect(await prisma.notification.findUniqueOrThrow({ where: { id: nBound } })).toMatchObject({ recipient: P, payload: { leadPhone: P } });
    // Not needed for fulfilment: erased even on the deferred order.
    expect(await prisma.orderAttribution.findUniqueOrThrow({ where: { orderId: o.orderId } })).toMatchObject({ fbclid: null, gclid: null });
    // The account stays open while its order is deferred (R-B4-2): login, contact, sessions and the order link
    // are kept; only the profile's dietary and hotel prefill is cleared (the order keeps its own snapshot).
    expect(await prisma.customer.findUniqueOrThrow({ where: { id: custId } })).toMatchObject({ phoneE164: P, email: E, deletedAt: null, dietary: null, hotel: null });
    expect(await prisma.customerSession.count({ where: { customerId: custId, revokedAt: null } })).toBe(1);
    expect((await prisma.order.findUniqueOrThrow({ where: { id: o.orderId } })).customerId).toBe(custId);
    // Everything else.
    expect((await prisma.inquiry.findUniqueOrThrow({ where: { id: inqId } })).leadPhone).toBe(`[deleted-${r.token}]`);
    expect(await prisma.notification.findUniqueOrThrow({ where: { id: nLoose } })).toMatchObject({ recipient: `[deleted-${r.token}]`, payload: null });

    const audit = await prisma.auditLog.findFirstOrThrow({ where: { action: "privacy.erasure", entityId: r.requestId } });
    expect(audit.after).toMatchObject({ ids: { deferredOrderIds: [o.orderId] }, codes: { status: "partial", obligations: ["future_service"] } });
    noContact(audit, P, E, P.slice(1));
  });

  it("pending refund: the order is deferred; with nothing else to erase the request is deferred", async () => {
    const P = phone(7);
    await trackSuppression(P, null);
    const o = await order(P, null, { serviceDate: PAST });
    const paymentId = await payment(o, 200);
    await prisma.refund.create({ data: { id: uuidv7(), paymentId, orderItemId: o.itemId, provider: "razorpay", idempotencyKey: `zz-priv:${run}:refund`, amountMinor: 400n, currency: "AED", status: "requested", reason: "zz-priv" } });

    const { privacyService } = await import("../privacy.service");
    const r = await privacyService.requestErasure(ADMIN, { phoneE164: P });
    expect(r).toMatchObject({ status: "deferred", obligations: ["refund_pending"], deferredOrders: [{ orderId: o.orderId, obligations: ["refund_pending"] }], suppressed: { phone: true } });
    expect(await prisma.order.findUniqueOrThrow({ where: { id: o.orderId } })).toMatchObject({ leadPhone: P, leadName: `${leadTag(run)} lead` });
    expect(await prisma.guest.findUniqueOrThrow({ where: { id: o.guestId } })).toMatchObject({ phoneE164: P });
  });

  it("dispute window, open payment and open supplier attempt defer their orders; an order with nothing owed is erased", async () => {
    const P = phone(8);
    await trackSuppression(P, null);
    const recent = await order(P, null, { serviceDate: PAST });
    await payment(recent, 10);
    const settled = await order(P, null, { serviceDate: PAST });
    await payment(settled, 200);
    const paying = await order(P, null, { serviceDate: PAST });
    await prisma.paymentSaga.create({ data: { id: uuidv7(), orderId: paying.orderId, orderItemId: paying.itemId, rail: "aed_card", state: "reserved" } });
    const supplierOpen = await order(P, null, { serviceDate: PAST });
    await booking(supplierOpen, "manual_review");

    const { privacyService, DISPUTE_WINDOW_DAYS } = await import("../privacy.service");
    expect(DISPUTE_WINDOW_DAYS).toBeGreaterThan(10);
    const r = await privacyService.requestErasure(ADMIN, { phoneE164: P });
    expect(r.status).toBe("partial");
    expect(r.obligations).toEqual(["dispute_window", "payment_open", "supplier_booking_open"]);
    expect(Object.fromEntries(r.deferredOrders.map((d) => [d.orderId, d.obligations]))).toEqual({
      [recent.orderId]: ["dispute_window"],
      [paying.orderId]: ["payment_open"],
      [supplierOpen.orderId]: ["supplier_booking_open"],
    });
    for (const kept of [recent, paying, supplierOpen]) expect((await prisma.order.findUniqueOrThrow({ where: { id: kept.orderId } })).leadPhone).toBe(P);
    expect((await prisma.order.findUniqueOrThrow({ where: { id: settled.orderId } })).leadPhone).toBe(`[deleted-${r.token}]`);
    expect((await prisma.guest.findUniqueOrThrow({ where: { id: settled.guestId } })).phoneE164).toBe(`[deleted-${r.token}]`);
  });

  it("an object that cannot be deleted is reported and keeps its key for a retry; the erasure still commits", async () => {
    const P = phone(9);
    await trackSuppression(P, null);
    const o = await order(P, null, { serviceDate: PAST });
    const bookingId = await booking(o);
    const t = await tickets(o, bookingId, store);
    const del = vi.spyOn(store, "delete").mockRejectedValueOnce(new Error("storage down"));
    const lines: string[] = [];
    vi.spyOn(console, "error").mockImplementation((l: unknown) => void lines.push(String(l)));

    const { privacyService } = await import("../privacy.service");
    const r = await privacyService.requestErasure(ADMIN, { phoneE164: P });
    expect(del).toHaveBeenCalledWith(t.storageKey);
    expect(r).toMatchObject({ status: "completed", storage: { deleted: 0, failed: 1 } });
    expect(await prisma.supplierDocument.findUniqueOrThrow({ where: { id: t.pdfDoc } })).toMatchObject({ status: "superseded", storageKey: t.storageKey });
    expect((await prisma.order.findUniqueOrThrow({ where: { id: o.orderId } })).leadPhone).toBe(`[deleted-${r.token}]`);
    expect(lines.join("\n")).toContain("document.store_error");
    expect(lines.join("\n")).not.toContain(t.storageKey);
    vi.restoreAllMocks();
  });

  it("anonymiseByPhone stays callable and runs the same workflow, with hashed suppression only", async () => {
    const P = phone(10);
    await trackSuppression(P, null);
    const custId = await customer(P, null);
    const inqId = await inquiry(P, null, custId);
    await order(P, null, { serviceDate: PAST, customerId: custId, inquiryId: inqId });
    const { anonymiseByPhone, suppressionCandidates } = await import("../../repositories/privacy.repo");
    const r = await anonymiseByPhone(P, uuidv7());
    expect(r).toMatchObject({ inquiries: 1, orders: 1, guests: 1, suppressed: true });
    expect(r.token).toMatch(/^[0-9a-f]{12}$/);
    expect(await prisma.suppressedPhone.findUnique({ where: { phoneE164: P } })).toBeNull();
    expect(await prisma.suppressedContact.count({ where: { contactHash: { in: suppressionCandidates("phone", P) } } })).toBe(1);
    expect((await prisma.customer.findUniqueOrThrow({ where: { id: custId } })).deletedAt).not.toBeNull();
  });

  it("phone-only customer with a future booking: the account, its session and the order link stay (deferred)", async () => {
    const P = phone(11);
    await trackSuppression(P, null);
    const custId = await customer(P, null);
    const o = await order(P, null, { serviceDate: FUTURE, customerId: custId });

    const { privacyService } = await import("../privacy.service");
    const r = await privacyService.requestErasure(ADMIN, { phoneE164: P });
    expect(r).toMatchObject({ status: "deferred", obligations: ["future_service"], deferredOrders: [{ orderId: o.orderId, obligations: ["future_service"] }], suppressed: { phone: true } });
    expect(r.counts).toMatchObject({ customers: 0, customersDeferred: 1, customerSessions: 0, orders: 0, ordersDeferred: 1 });

    const c = await prisma.customer.findUniqueOrThrow({ where: { id: custId } });
    expect(c).toMatchObject({ phoneE164: P, deletedAt: null, dietary: null, hotel: null });
    expect(await prisma.customerSession.count({ where: { customerId: custId, revokedAt: null } })).toBe(1);
    const ord = await prisma.order.findUniqueOrThrow({ where: { id: o.orderId } });
    expect(ord).toMatchObject({ customerId: custId, leadPhone: P });

    // Still signed in, and still sees the order.
    const { GET } = await import("@/app/api/me/orders/route");
    const res = await GET(apiRequest("/api/me/orders", { cookie: cookies.get(custId) }), params({}));
    expect(res.status).toBe(200);
    expect(((await res.json()) as { items: { reference: string }[] }).items.map((i) => i.reference)).toContain(ord.reference);

    const audit = await prisma.auditLog.findFirstOrThrow({ where: { action: "privacy.erasure", entityId: r.requestId } });
    expect(audit.after).toMatchObject({ counts: { customers: 0, customersDeferred: 1 }, codes: { status: "deferred", obligations: ["future_service"] } });
    noContact(audit, P, P.slice(1));
  });

  it("once nothing is owed, a second request closes the kept account", async () => {
    const P = phone(12);
    await trackSuppression(P, null);
    const custId = await customer(P, null);
    const o = await order(P, null, { serviceDate: FUTURE, customerId: custId });
    const { privacyService } = await import("../privacy.service");
    expect((await privacyService.requestErasure(ADMIN, { phoneE164: P })).status).toBe("deferred");

    // The service took place.
    await prisma.orderItem.update({ where: { id: o.itemId }, data: { serviceDate: new Date(`${PAST}T00:00:00Z`) } });
    const r = await privacyService.requestErasure(ADMIN, { phoneE164: P });
    expect(r).toMatchObject({ status: "completed", counts: { customers: 1, customersDeferred: 0, customerSessions: 1, orders: 1 } });
    const c = await prisma.customer.findUniqueOrThrow({ where: { id: custId } });
    expect(c.deletedAt).not.toBeNull();
    expect(c.phoneE164).toMatch(/^\[deleted-/);
    expect(await prisma.customerSession.count({ where: { customerId: custId, revokedAt: null } })).toBe(0);
  });

  it("a failed refund or remedy still owes money: the order is deferred until it is resolved", async () => {
    const P = phone(13);
    await trackSuppression(P, null);
    const refundOrder = await order(P, null, { serviceDate: PAST });
    const refundPayment = await payment(refundOrder, 200);
    const failedRefundId = uuidv7();
    await prisma.refund.create({
      data: { id: failedRefundId, paymentId: refundPayment, orderItemId: refundOrder.itemId, provider: "razorpay", idempotencyKey: `zz-priv:${run}:failed-refund`, amountMinor: 400n, currency: "AED", status: "failed", reason: "zz-priv" },
    });
    const remedyOrder = await order(P, null, { serviceDate: PAST });
    await payment(remedyOrder, 200);
    const remedyId = uuidv7();
    await prisma.customerRemedy.create({
      data: { id: remedyId, orderId: remedyOrder.orderId, orderItemId: remedyOrder.itemId, kind: "alternative_offered", reason: "zz-priv", amountMinor: 0n, currency: "AED", status: "failed" },
    });

    const { privacyService } = await import("../privacy.service");
    const r = await privacyService.requestErasure(ADMIN, { phoneE164: P });
    expect(r).toMatchObject({ status: "deferred", obligations: ["refund_pending"] });
    expect(Object.fromEntries(r.deferredOrders.map((d) => [d.orderId, d.obligations]))).toEqual({
      [refundOrder.orderId]: ["refund_pending"],
      [remedyOrder.orderId]: ["refund_pending"],
    });
    for (const kept of [refundOrder, remedyOrder]) expect((await prisma.order.findUniqueOrThrow({ where: { id: kept.orderId } })).leadPhone).toBe(P);

    // Resolved: a retry of the refund succeeded, and staff closed the remedy. Now nothing is owed.
    await prisma.refund.create({
      data: { id: uuidv7(), paymentId: refundPayment, orderItemId: refundOrder.itemId, provider: "razorpay", idempotencyKey: `zz-priv:${run}:retry-refund`, amountMinor: 400n, currency: "AED", status: "succeeded", reason: "zz-priv" },
    });
    await prisma.customerRemedy.update({ where: { id: remedyId }, data: { status: "cancelled" } });
    const again = await privacyService.requestErasure(ADMIN, { phoneE164: P });
    expect(again).toMatchObject({ status: "completed", obligations: [], counts: { orders: 2 } });
  });

  it("erasure removes the number's legacy plaintext suppression row in the same transaction", async () => {
    const P = phone(14);
    await trackSuppression(P, null);
    await prisma.suppressedPhone.create({ data: { phoneE164: P, reason: "zz-priv legacy" } });
    const { privacyService } = await import("../privacy.service");
    const { suppressionCandidates } = await import("../../repositories/privacy.repo");
    const r = await privacyService.requestErasure(ADMIN, { phoneE164: P });
    expect(r.suppressed.phone).toBe(true);
    expect(await prisma.suppressedPhone.findUnique({ where: { phoneE164: P } })).toBeNull();
    expect(await prisma.suppressedContact.count({ where: { contactHash: { in: suppressionCandidates("phone", P) } } })).toBe(1);
    const audit = await prisma.auditLog.findFirstOrThrow({ where: { action: "privacy.erasure", entityId: r.requestId } });
    expect(audit.after).toMatchObject({ counts: { legacySuppressionRemoved: 1, suppressedPhone: 1 } });
    noContact(audit, P, P.slice(1));
    const { inquiryRepo } = await import("../../repositories/inquiry.repo");
    expect(await inquiryRepo.isSuppressed(P)).toBe(true);
  });

  it("without a lookup ring the inquiry suppression check falls back to the legacy list and alerts; erasure fails closed", async () => {
    const legacy = phone(15);
    const fresh = phone(16);
    await prisma.suppressedPhone.create({ data: { phoneE164: legacy, reason: "zz-priv legacy" } });
    const custId = await customer(fresh, null);
    const { setKeyRingsForTests, KeyUnavailableError } = await import("../../lib/crypto");
    const { inquiryRepo } = await import("../../repositories/inquiry.repo");
    const { privacyService } = await import("../privacy.service");
    const lines: string[] = [];
    const spy = vi.spyOn(console, "error").mockImplementation((l: unknown) => void lines.push(String(l)));
    setKeyRingsForTests({ lookup: null });
    try {
      expect(await inquiryRepo.isSuppressed(legacy)).toBe(true);
      expect(await inquiryRepo.isSuppressed(fresh, email("nokey"))).toBe(false);
      const alerts = lines.filter((l) => l.includes("keys.unavailable"));
      expect(alerts.length).toBe(2);
      expect(alerts[0]).toContain("inquiry_suppression");
      expect(alerts.join("\n")).not.toContain(legacy.slice(1));
      expect(alerts.join("\n")).not.toContain(fresh.slice(1));

      // Erasure never falls back: nothing is written and the customer is untouched.
      await expect(privacyService.requestErasure(ADMIN, { phoneE164: fresh })).rejects.toBeInstanceOf(KeyUnavailableError);
      expect(await prisma.customer.findUniqueOrThrow({ where: { id: custId } })).toMatchObject({ phoneE164: fresh, deletedAt: null, dietary: "jain" });
    } finally {
      setKeyRingsForTests(null);
      spy.mockRestore();
    }
  });
});
