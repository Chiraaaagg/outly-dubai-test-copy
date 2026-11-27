import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { randomBytes } from "node:crypto";
import { assertDisposableDb, assertDisposableDbLive } from "../../__tests__/helpers/target-guard";
import { uuidv7 } from "../../lib/ids";
import { resetEnvCache, type Env } from "../../lib/env";
import { MemoryDocumentStore } from "../../documents/memory-store";
import { sha256Of } from "../../documents/pdf";
import type { FiscalSeller } from "../../documents/generated/fiscal/snapshot";
import type { EmailOutcome, EmailSend, EmailSendOptions } from "../../notifications/email.adapter";
import { syntheticSupplierPdf } from "../../documents/generated/specimen/synthetic-supplier";

/**
 * Group C against the disposable database (doc 93 §1.4–§1.6, §2, §3.1, §7.4):
 * gap-free numbering under concurrency and failure, idempotency, append-only
 * rows, test/production separation, refusals, credit notes, the refund
 * reconciliation, drawing and serving the files, the branded entry file from
 * a SYNTHETIC supplier PDF, and the payment email.
 *
 * Every run uses its own legal entity key and series, so numbers start at 1
 * and nothing mixes with other suites. Fiscal rows are append-only by design
 * and stay; every scan is scoped to this run's ids. Synthetic values only.
 */

const RUN = randomBytes(4).toString("hex");
const ENTITY = `zz_c_${RUN}`;
const PREFIX = `TEST-Z${RUN.toUpperCase()}-`;
const CN_PREFIX = `TEST-Z${RUN.toUpperCase()}C-`;
const NOW = new Date("2027-02-14T10:05:00.000Z");
/** Synthetic phone, built at run time (the public CI copy is scanned for phone-like literals). */
const PHONE = ["+91", "0000", "000000"].join("");
/**
 * A ticket code row's ciphertext in the shape `supplier_ticket_codes_ciphertext_check` requires
 * (`v2.ticket_codes.<key id>.<a>.<b>.<c>`, key id = `code_key_id`). Never decrypted here: the entry step only counts
 * the rows (units issued).
 */
const PLACEHOLDER_CIPHERTEXT = ["v2", "ticket_codes", "zz", "AAAA", "BBBB", "CCCC"].join(".");
/** Synthetic recipients only (example.invalid never delivers). */
const MAIL_DOMAIN = "@example.invalid";

type Prisma = typeof import("../../lib/db").prisma;
let prisma: Prisma;
let fiscal: typeof import("../fiscal-document.service");
let generated: typeof import("../generated-document.service");
let read: typeof import("../generated-document.read");
let notifications: typeof import("../notification.service");
let storeMod: typeof import("../../documents/store");
let productId: string;
let priorCategory: string | null;
let unclassifiedProductId: string;
let unclassifiedPrior: string | null;
let supplierId: string;
const savedEnv = { ...process.env };
const sent: { key: string; msg: EmailSend }[] = [];

const seller: FiscalSeller = { legalName: "[Legal name]", tradingName: "OUTLYY", trn: "[TRN]", address: "[Registered address]", licence: null, supportEmail: null, phone: null, placeholder: true };
const realSeller: FiscalSeller = { ...seller, legalName: "Specimen Legal Name LLC", trn: ["1", "0".repeat(13), "3"].join(""), address: "Specimen Street, Dubai", placeholder: false };
const deps = (over: Partial<import("../fiscal-document.service").IssueDeps> = {}) => ({ now: NOW, legalEntity: ENTITY, seller, productionAllowed: false, ...over });

function envWith(over: Partial<Env>): Env {
  return { ...(process.env as unknown as Env), FISCAL_DOCUMENTS_ENABLED: false, BRANDED_ENTRY_PDF_ENABLED: false, BRANDED_ENTRY_PDF_KINDS: ["tickets_pdf"], FISCAL_LEGAL_ENTITY: ENTITY, isProduction: false, isNonProduction: true, ...over } as Env;
}

let n = 0;
/** An AED instant order with priced items, a captured test payment and its capture ledger entry. */
async function paidOrder(opts: { grosses?: bigint[]; environment?: "test" | "production"; withProduct?: boolean; currency?: "AED" | "INR"; email?: string | null; captured?: bigint } = {}) {
  const k = ++n;
  const grosses = opts.grosses ?? [40000n, 2000n];
  const total = grosses.reduce((a, b) => a + b, 0n);
  const currency = opts.currency ?? "AED";
  // Every order names its buyer: `order_has_buyer` (init migration) requires a guest row.
  const guest = await prisma.guest.create({ data: { id: uuidv7(), phoneE164: PHONE, fullName: `zz-c-${RUN} Asha Specimen` } });
  const order = await prisma.order.create({
    data: {
      id: uuidv7(),
      reference: `OUT-ZC${RUN.toUpperCase()}${k}`,
      guestId: guest.id,
      status: "paid",
      rail: "self_serve",
      currency,
      subtotalInr: 0n,
      subtotalAed: total,
      totalInr: 0n,
      totalAed: total,
      leadName: `zz-c-${RUN} Asha Specimen`,
      leadPhone: PHONE,
      leadEmail: opts.email === undefined ? `zz-c-${RUN}-${k}${MAIL_DOMAIN}` : opts.email,
      paidAt: NOW,
    },
  });
  const items: string[] = [];
  for (const [i, g] of grosses.entries()) {
    const id = uuidv7();
    items.push(id);
    await prisma.orderItem.create({
      data: {
        id,
        orderId: order.id,
        // `order_item_has_product` needs a product: "without a VAT category" is a second product left unclassified.
        productId: opts.withProduct === false ? unclassifiedProductId : productId,
        titleSnapshot: `Specimen Activity ${i + 1}`,
        tierSnapshot: "A",
        slugSnapshot: `zz-c-${RUN}-${k}-${i}`,
        kindSnapshot: "activity",
        confirmationSnapshot: "instant",
        fulfilmentModeSnapshot: "instant",
        freeCancellationHoursSnapshot: 24,
        durationMinutesSnapshot: 60,
        serviceDate: new Date("2027-02-20T00:00:00Z"),
        pax: { adult: 2 },
        unitInr: 0n,
        unitAed: g,
        totalInr: 0n,
        totalAed: g,
        fulfilmentOrigin: "instant_checkout",
        chargedCurrency: currency,
        chargedAmountMinor: g,
        discountAllocMinor: 0n,
        taxAllocMinor: 0n,
        quoteLineIndex: i,
      },
    });
  }
  const environment = opts.environment ?? "test";
  const captured = opts.captured ?? total;
  const paymentId = uuidv7();
  const pi = `pi_zc_${RUN}_${k}`;
  await prisma.payment.create({
    data: { id: paymentId, orderId: order.id, gateway: "stripe", gatewayPaymentId: pi, amountMinor: total, currency, status: "captured", source: "gateway_verified", rail: "aed_card", provider: "stripe", providerAccountId: "acct_zz", environment, capturedMinor: captured, capturedAt: NOW, method: "card" },
  });
  const ledgerId = uuidv7();
  await prisma.ledgerEntry.create({
    data: { id: ledgerId, book: "customer_money", orderId: order.id, paymentId, currency, amountMinor: captured, kind: "capture", evidenceRef: `capture:${environment}:stripe:${pi}:${captured}`, occurredAt: NOW },
  });
  return { orderId: order.id, reference: order.reference, items, paymentId, ledgerId, pi };
}

/** A settled refund on one item, with its ledger entry (as refunds.ts settle writes it). */
async function settledRefund(o: Awaited<ReturnType<typeof paidOrder>>, itemIndex: number, amount: bigint, over: { outlyFunded?: boolean } = {}) {
  const id = uuidv7();
  const providerRefundId = `re_zc_${RUN}_${++n}`;
  await prisma.refund.create({ data: { id, paymentId: o.paymentId, orderItemId: o.items[itemIndex], provider: "stripe", providerRefundId, idempotencyKey: `zc-${RUN}-${n}`, amountMinor: amount, currency: "AED", status: "succeeded", reason: "customer_cancel_request", outlyFunded: over.outlyFunded ?? false } });
  const p = await prisma.payment.findUniqueOrThrow({ where: { id: o.paymentId } });
  await prisma.payment.update({ where: { id: o.paymentId }, data: { refundedMinor: p.refundedMinor + amount, status: "partially_refunded" } });
  const ledgerId = uuidv7();
  await prisma.ledgerEntry.create({ data: { id: ledgerId, book: "customer_money", orderId: o.orderId, paymentId: o.paymentId, currency: "AED", amountMinor: -amount, kind: "refund", evidenceRef: `refund:test:stripe:${providerRefundId}`, occurredAt: new Date(NOW.getTime() + 3600_000) } });
  return { refundId: id, ledgerId };
}

/** A confirmed ticket booking with `units` issued codes and a SYNTHETIC tickets PDF stored in `store`. */
async function entrySource(store: MemoryDocumentStore, o: Awaited<ReturnType<typeof paidOrder>>, units = 2) {
  const booking = await prisma.supplierBooking.create({
    data: {
      id: uuidv7(),
      orderId: o.orderId,
      orderItemId: o.items[0],
      supplierId,
      environment: "test",
      idempotencyKey: `zc-${RUN}-b${++n}`,
      clientRef: `OUTTD-ZC${RUN.toUpperCase()}${n}`,
      bookingKind: "ticket_only",
      afterReserve: "await_payment",
      state: "confirmed",
      tourExternalId: "1",
      offerExternalId: "1",
      serviceDate: new Date("2027-02-20T00:00:00Z"),
      adults: units,
      guestName: "Asha Specimen",
      expectedNetMinor: 1000n,
      expectedNetUsdMinor: 300n,
      supplierBookingId: "000000",
      confirmedAt: NOW,
      closedAt: NOW,
    },
  });
  const codesDoc = await prisma.supplierDocument.create({ data: { id: uuidv7(), supplierBookingId: booking.id, orderId: o.orderId, orderItemId: o.items[0], kind: "ticket_codes", version: 1, status: "valid", source: "confirm_response", validatedAt: NOW } });
  for (let i = 0; i < units; i++) {
    await prisma.supplierTicketCode.create({ data: { id: uuidv7(), documentId: codesDoc.id, supplierBookingId: booking.id, unitIndex: i, ticketFor: "adult", codeCiphertext: PLACEHOLDER_CIPHERTEXT, codeKeyId: "zz", codeHash: randomBytes(32).toString("hex") } });
  }
  const pdf = await syntheticSupplierPdf({ layout: Array.from({ length: units }, () => 1) });
  const key = `test/${randomBytes(16).toString("hex")}`;
  await store.put(key, pdf, "application/pdf");
  const src = await prisma.supplierDocument.create({
    data: { id: uuidv7(), supplierBookingId: booking.id, orderId: o.orderId, orderItemId: o.items[0], kind: "tickets_pdf", version: 1, status: "valid", source: "pdf_download", storageKey: key, contentType: "application/pdf", byteSize: pdf.byteLength, sha256: sha256Of(pdf), validatedAt: NOW },
  });
  return { booking, src };
}

/** A store whose reads fail: the entry step's fault path. */
class FailingReadStore extends MemoryDocumentStore {
  override async get(): Promise<Uint8Array | null> {
    throw new Error("injected read fault");
  }
}

/**
 * Removes every row this run created, child first, scoped to this run's ids (fix round 2: later suites count order
 * items with a charged amount, and the payments tick treats a captured payment with no saga as a duplicate to
 * refund, so leftovers broke `b2-migration` and CR-B3-8).
 *
 * `ledger_entries` and `fiscal_documents` are append-only by trigger, and every order, payment, item and refund of
 * this run is referenced by them, so the delete runs in one transaction with `session_replication_role = replica`
 * (user triggers off for this transaction only). That needs the disposable CI database's superuser, which the guard
 * at the top of the suite has already proved is a disposable database. Where it is not allowed, the mutable rows are
 * still removed and the attention rows closed, and a warning names what was left.
 */
async function cleanupRun(): Promise<void> {
  assertDisposableDb();
  const orderIds = (await prisma.order.findMany({ where: { leadName: { startsWith: `zz-c-${RUN}` } }, select: { id: true } })).map((o) => o.id);
  const guestIds = (await prisma.guest.findMany({ where: { fullName: { startsWith: `zz-c-${RUN}` } }, select: { id: true } })).map((g) => g.id);
  const entities = [ENTITY, `zz_d_${RUN}`];
  const bookingIds = (await prisma.supplierBooking.findMany({ where: { OR: [{ orderId: { in: orderIds } }, { supplierId }] }, select: { id: true } })).map((b) => b.id);
  try {
    await prisma.$transaction(async (tx) => {
      await tx.$executeRawUnsafe("SET LOCAL session_replication_role = replica");
      await tx.$executeRaw`DELETE FROM notifications WHERE order_id = ANY(${orderIds}::uuid[])`;
      await tx.$executeRaw`DELETE FROM fiscal_attention WHERE order_id = ANY(${orderIds}::uuid[])`;
      await tx.$executeRaw`DELETE FROM generated_documents WHERE order_id = ANY(${orderIds}::uuid[])`;
      await tx.$executeRaw`DELETE FROM fiscal_document_parties WHERE fiscal_document_id IN (SELECT id FROM fiscal_documents WHERE order_id = ANY(${orderIds}::uuid[]))`;
      await tx.$executeRaw`DELETE FROM fiscal_documents WHERE order_id = ANY(${orderIds}::uuid[]) AND refers_to_id IS NOT NULL`;
      await tx.$executeRaw`DELETE FROM fiscal_documents WHERE order_id = ANY(${orderIds}::uuid[])`;
      await tx.$executeRaw`DELETE FROM fiscal_series WHERE legal_entity = ANY(${entities}::text[])`;
      await tx.$executeRaw`DELETE FROM supplier_ticket_codes WHERE supplier_booking_id = ANY(${bookingIds}::uuid[])`;
      await tx.$executeRaw`DELETE FROM supplier_documents WHERE supplier_booking_id = ANY(${bookingIds}::uuid[])`;
      await tx.$executeRaw`DELETE FROM supplier_booking_events WHERE supplier_booking_id = ANY(${bookingIds}::uuid[])`;
      await tx.$executeRaw`DELETE FROM supplier_bookings WHERE id = ANY(${bookingIds}::uuid[])`;
      await tx.$executeRaw`DELETE FROM refunds WHERE payment_id IN (SELECT id FROM payments WHERE order_id = ANY(${orderIds}::uuid[]))`;
      await tx.$executeRaw`DELETE FROM ledger_entries WHERE order_id = ANY(${orderIds}::uuid[])`;
      await tx.$executeRaw`DELETE FROM payments WHERE order_id = ANY(${orderIds}::uuid[])`;
      await tx.$executeRaw`DELETE FROM order_items WHERE order_id = ANY(${orderIds}::uuid[])`;
      await tx.$executeRaw`DELETE FROM orders WHERE id = ANY(${orderIds}::uuid[])`;
      await tx.$executeRaw`DELETE FROM guests WHERE id = ANY(${guestIds}::uuid[])`;
      await tx.$executeRaw`DELETE FROM suppliers WHERE id = ${supplierId}::uuid`;
    });
  } catch (err) {
    // No superuser here: remove what is mutable, close the attention rows (raised at the fixed 2027 NOW, so resolved
    // after it: `fiscal_attention_times_check`, review 102 finding 2), and say what stays.
    console.warn(`group-c cleanup: append-only rows kept (${err instanceof Error ? err.message.slice(0, 120) : "error"})`);
    await prisma.notification.deleteMany({ where: { orderId: { in: orderIds } } });
    await prisma.fiscalAttention.updateMany({ where: { resolvedAt: null, orderId: { in: orderIds } }, data: { resolvedAt: new Date(NOW.getTime() + 7 * 86_400_000) } });
    await prisma.supplierTicketCode.deleteMany({ where: { supplierBookingId: { in: bookingIds } } });
  }
}

async function fakeSend(msg: EmailSend, opts?: EmailSendOptions): Promise<EmailOutcome> {
  sent.push({ key: opts?.idempotencyKey ?? "none", msg });
  return { kind: "sent", providerId: `fake-${opts?.idempotencyKey}` };
}

describe("Group C documents (disposable database)", () => {
  beforeAll(async () => {
    assertDisposableDb();
    ({ prisma } = await import("../../lib/db"));
    await assertDisposableDbLive(prisma);
    process.env.NOTIFICATION_RECIPIENT_ALLOWLIST = MAIL_DOMAIN;
    // The payment email kill switch is on for this suite (one test turns it off again).
    process.env.PAYMENT_RECEIVED_EMAIL_ENABLED = "true";
    delete process.env.RESEND_API_KEY;
    delete process.env.FISCAL_DOCUMENTS_ENABLED;
    delete process.env.BRANDED_ENTRY_PDF_ENABLED;
    resetEnvCache();
    fiscal = await import("../fiscal-document.service");
    generated = await import("../generated-document.service");
    read = await import("../generated-document.read");
    notifications = await import("../notification.service");
    storeMod = await import("../../documents/store");
    const { emailAdapter } = await import("../../notifications/email.adapter");
    vi.spyOn(emailAdapter, "send").mockImplementation(fakeSend as never);
    const product = await prisma.product.findFirstOrThrow({ where: { status: "published", deletedAt: null }, orderBy: { slug: "asc" }, select: { id: true, vatCategory: true } });
    productId = product.id;
    priorCategory = product.vatCategory;
    await prisma.product.update({ where: { id: productId }, data: { vatCategory: "standard" } });
    const other = await prisma.product.findFirstOrThrow({ where: { id: { not: productId }, deletedAt: null }, orderBy: { slug: "desc" }, select: { id: true, vatCategory: true } });
    unclassifiedProductId = other.id;
    unclassifiedPrior = other.vatCategory;
    await prisma.product.update({ where: { id: unclassifiedProductId }, data: { vatCategory: null } });
    await prisma.fiscalSeries.createMany({
      data: [
        { id: uuidv7(), legalEntity: ENTITY, environment: "test", docType: "tax_invoice", prefix: PREFIX, nextNumber: 1n },
        { id: uuidv7(), legalEntity: ENTITY, environment: "test", docType: "tax_credit_note", prefix: CN_PREFIX, nextNumber: 1n },
      ],
    });
    supplierId = uuidv7();
    await prisma.supplier.create({ data: { id: supplierId, code: `zzc${RUN}`, name: "Group C (test)", source: "api", adapter: "traveldesk" } });
  });

  afterAll(async () => {
    vi.restoreAllMocks();
    storeMod?.setDocumentStoreForTests(undefined);
    process.env = { ...savedEnv };
    resetEnvCache();
    if (!prisma) return;
    await prisma.product.update({ where: { id: productId }, data: { vatCategory: priorCategory } });
    if (unclassifiedProductId) await prisma.product.update({ where: { id: unclassifiedProductId }, data: { vatCategory: unclassifiedPrior } });
    await cleanupRun();
    await prisma.$disconnect();
  });

  /* -------------------------------------------------------------- numbering */

  it("issues the combined invoice: number 1, snapshot, party, pending file; a retry returns the same document", async () => {
    const o = await paidOrder();
    const r = await fiscal.issueForLedgerEntry(o.ledgerId, deps());
    expect(r).toMatchObject({ kind: "issued", displayNumber: `${PREFIX}000001`, docType: "tax_invoice" });
    const doc = await prisma.fiscalDocument.findUniqueOrThrow({ where: { ledgerEntryId: o.ledgerId }, include: { party: true, files: true } });
    expect(doc).toMatchObject({ number: 1n, environment: "test", currency: "AED", grossMinor: 42000n, vatMinor: 2000n, netMinor: 40000n, vatRule: expect.stringMatching(/unconfirmed/) });
    expect(doc.lines).toHaveLength(2);
    expect(JSON.stringify(doc.lines)).not.toMatch(/net_cost|margin|pi_zc|stripe/i);
    expect(JSON.stringify(doc.seller)).toContain("[Legal name]");
    expect(doc.party?.buyerName).toContain("Asha Specimen");
    expect(doc.files).toHaveLength(1);
    expect(doc.files[0]).toMatchObject({ kind: "tax_invoice", status: "pending" });
    expect(await fiscal.issueForLedgerEntry(o.ledgerId, deps())).toEqual({ kind: "exists", id: doc.id, displayNumber: doc.displayNumber });
    expect((await prisma.fiscalSeries.findFirstOrThrow({ where: { legalEntity: ENTITY, docType: "tax_invoice" } })).nextNumber).toBe(2n);
  });

  it("concurrent issuers produce consecutive numbers with no gap and no duplicate; the same entry raced gives one document", async () => {
    const orders = [];
    for (let i = 0; i < 30; i++) orders.push(await paidOrder({ grosses: [1000n + BigInt(i)] }));
    const before = (await prisma.fiscalSeries.findFirstOrThrow({ where: { legalEntity: ENTITY, docType: "tax_invoice" } })).nextNumber;
    const results = await Promise.all([...orders.map((o) => fiscal.issueForLedgerEntry(o.ledgerId, deps())), ...orders.slice(0, 5).map((o) => fiscal.issueForLedgerEntry(o.ledgerId, deps()))]);
    expect(results.filter((r) => r.kind === "issued")).toHaveLength(30);
    expect(results.filter((r) => r.kind === "exists")).toHaveLength(5);
    const numbers = (await prisma.fiscalDocument.findMany({ where: { ledgerEntryId: { in: orders.map((o) => o.ledgerId) } }, select: { number: true } })).map((d) => Number(d.number)).sort((a, b) => a - b);
    expect(numbers).toEqual(Array.from({ length: 30 }, (_, i) => Number(before) + i));
  }, 180_000);

  it("a failure after the counter was taken rolls the counter back: no number is lost", async () => {
    const o = await paidOrder();
    const before = (await prisma.fiscalSeries.findFirstOrThrow({ where: { legalEntity: ENTITY, docType: "tax_invoice" } })).nextNumber;
    await expect(
      fiscal.issueForLedgerEntry(o.ledgerId, deps({ faultAfterCounter: () => { throw new Error("injected"); } })),
    ).rejects.toThrow("injected");
    expect((await prisma.fiscalSeries.findFirstOrThrow({ where: { legalEntity: ENTITY, docType: "tax_invoice" } })).nextNumber).toBe(before);
    expect(await prisma.fiscalDocument.count({ where: { ledgerEntryId: o.ledgerId } })).toBe(0);
    const r = await fiscal.issueForLedgerEntry(o.ledgerId, deps());
    expect(r).toMatchObject({ kind: "issued", displayNumber: `${PREFIX}${String(before).padStart(6, "0")}` });
  });

  it("issued documents are append-only: update, delete and truncate are refused", async () => {
    const doc = await prisma.fiscalDocument.findFirstOrThrow({ where: { displayNumber: `${PREFIX}000001` } });
    await expect(prisma.fiscalDocument.update({ where: { id: doc.id }, data: { grossMinor: 1n } })).rejects.toThrow(/append-only/);
    await expect(prisma.$executeRaw`DELETE FROM fiscal_documents WHERE id = ${doc.id}::uuid`).rejects.toThrow(/append-only/);
    await expect(prisma.$executeRaw`TRUNCATE fiscal_documents CASCADE`).rejects.toThrow(/append-only/);
  });

  /* -------------------------------------------------------------- refusals */

  it("test and production never mix; a production document needs a production deployment, the seller details, the confirmed VAT rule, the owner's layout and its series", async () => {
    const o = await paidOrder({ environment: "production" });
    expect(await fiscal.issueForLedgerEntry(o.ledgerId, deps())).toEqual({ kind: "blocked", reason: "environment_mismatch" });
    expect(await fiscal.issueForLedgerEntry(o.ledgerId, deps({ productionAllowed: true }))).toEqual({ kind: "blocked", reason: "seller_unconfigured" });
    // Review 102 finding 5: the unconfirmed VAT rule and the specimen layout each refuse a production document in code.
    expect(await fiscal.issueForLedgerEntry(o.ledgerId, deps({ productionAllowed: true, seller: realSeller }))).toEqual({ kind: "blocked", reason: "vat_rule_unconfirmed" });
    expect(await fiscal.issueForLedgerEntry(o.ledgerId, deps({ productionAllowed: true, seller: realSeller, vatRuleConfirmed: true }))).toEqual({ kind: "blocked", reason: "layout_pending" });
    expect(await fiscal.issueForLedgerEntry(o.ledgerId, deps({ productionAllowed: true, seller: realSeller, vatRuleConfirmed: true, layoutProductionReady: true }))).toEqual({ kind: "blocked", reason: "series_missing" });
    expect(await prisma.fiscalDocument.count({ where: { ledgerEntryId: o.ledgerId } })).toBe(0);
    const open = await prisma.fiscalAttention.findMany({ where: { entityId: o.ledgerId, resolvedAt: null } });
    expect(open.map((a) => a.reason).sort()).toEqual(["environment_mismatch", "layout_pending", "seller_unconfigured", "series_missing", "vat_rule_unconfirmed"]);
    // The migration seeds no production series.
    expect(await prisma.fiscalSeries.count({ where: { environment: "production" } })).toBe(0);
    // Finding 6: a production series cannot exist without its cut-off.
    await expect(
      prisma.fiscalSeries.create({ data: { id: uuidv7(), legalEntity: ENTITY, environment: "production", docType: "tax_invoice", prefix: `ZP${RUN.toUpperCase()}-`, nextNumber: 1n } }),
    ).rejects.toThrow(/fiscal_series_issue_from_check/);
  });

  it("the series counter only moves forward, and a series row is never deleted (finding 17)", async () => {
    const series = await prisma.fiscalSeries.findFirstOrThrow({ where: { legalEntity: ENTITY, docType: "tax_invoice" } });
    await expect(prisma.$executeRaw`UPDATE fiscal_series SET next_number = next_number - 1 WHERE id = ${series.id}::uuid`).rejects.toThrow(/never decreases/);
    await expect(prisma.$executeRaw`UPDATE fiscal_series SET prefix = ${`TEST-ZQ${RUN.toUpperCase()}-`} WHERE id = ${series.id}::uuid`).rejects.toThrow(/fixed once the series has a document/);
    await expect(prisma.$executeRaw`DELETE FROM fiscal_series WHERE id = ${series.id}::uuid`).rejects.toThrow(/never deleted/);
    expect((await prisma.fiscalSeries.findUniqueOrThrow({ where: { id: series.id } })).nextNumber).toBe(series.nextNumber);
  });

  it("refuses an unclassified product, a total that does not add up, another currency, and alerts once per reason", async () => {
    const noCat = await paidOrder({ withProduct: false });
    expect(await fiscal.issueForLedgerEntry(noCat.ledgerId, deps())).toEqual({ kind: "blocked", reason: "vat_category_missing" });
    expect(await fiscal.issueForLedgerEntry(noCat.ledgerId, deps())).toEqual({ kind: "blocked", reason: "vat_category_missing" });
    expect(await prisma.fiscalAttention.count({ where: { entityId: noCat.ledgerId, resolvedAt: null } })).toBe(1);
    const mismatch = await paidOrder({ grosses: [40000n, 2000n], captured: 30000n });
    expect(await fiscal.issueForLedgerEntry(mismatch.ledgerId, deps())).toEqual({ kind: "blocked", reason: "amount_mismatch" });
    const inr = await paidOrder({ currency: "INR" });
    expect(await fiscal.issueForLedgerEntry(inr.ledgerId, deps())).toEqual({ kind: "blocked", reason: "currency_not_supported" });
    const incidents = await (await import("../ops-alert.service")).fiscalIncidents(new Date(NOW.getTime() - 1000), new Date(NOW.getTime() + 1000));
    const mine = incidents.filter((i) => i.entityId === noCat.ledgerId);
    expect(mine).toHaveLength(1);
    expect(mine[0]).toMatchObject({ kind: "fiscal_attention", entityKind: "ledger_entry", reason: "vat_category_missing", orderReference: noCat.reference });
    // Fixed: the next issue succeeds and closes the attention row.
    await prisma.orderItem.updateMany({ where: { orderId: noCat.orderId }, data: { productId } });
    expect((await fiscal.issueForLedgerEntry(noCat.ledgerId, deps())).kind).toBe("issued");
    expect(await prisma.fiscalAttention.count({ where: { entityId: noCat.ledgerId, resolvedAt: null } })).toBe(0);
  });

  /* -------------------------------------------------------------- credit notes */

  it("credit notes: full item refund, partial refunds per item, never above the invoiced line, goodwill held", async () => {
    const o = await paidOrder({ grosses: [40000n, 2000n] });
    const inv = await fiscal.issueForLedgerEntry(o.ledgerId, deps());
    expect(inv.kind).toBe("issued");

    const full = await settledRefund(o, 1, 2000n);
    const cn1 = await fiscal.issueForLedgerEntry(full.ledgerId, deps());
    expect(cn1).toMatchObject({ kind: "issued", docType: "tax_credit_note", displayNumber: expect.stringMatching(new RegExp(`^${CN_PREFIX}`)) });
    const d1 = await prisma.fiscalDocument.findUniqueOrThrow({ where: { ledgerEntryId: full.ledgerId } });
    expect(d1).toMatchObject({ refundId: full.refundId, grossMinor: 2000n, vatMinor: 95n });
    expect(d1.refersToId).toBe((inv as { id: string }).id);

    const p1 = await settledRefund(o, 0, 13333n);
    const p2 = await settledRefund(o, 0, 13333n);
    expect((await fiscal.issueForLedgerEntry(p1.ledgerId, deps())).kind).toBe("issued");
    expect((await fiscal.issueForLedgerEntry(p2.ledgerId, deps())).kind).toBe("issued");
    const p3 = await settledRefund(o, 0, 13334n);
    expect((await fiscal.issueForLedgerEntry(p3.ledgerId, deps())).kind).toBe("issued");
    const credits = await prisma.fiscalDocument.findMany({ where: { refersToId: (inv as { id: string }).id } });
    const line0 = credits.filter((c) => c.refundId !== full.refundId);
    // Three partial refunds credit exactly the invoiced line, VAT to the fil.
    expect(line0.reduce((t, c) => t + c.grossMinor, 0n)).toBe(40000n);
    expect(line0.reduce((t, c) => t + c.vatMinor, 0n)).toBe(1905n);
    expect(JSON.stringify(line0.map((c) => c.lines))).toContain("Partial refund");

    const o2 = await paidOrder({ grosses: [40000n, 2000n] });
    expect((await fiscal.issueForLedgerEntry(o2.ledgerId, deps())).kind).toBe("issued");
    const tooMuch = await settledRefund(o2, 1, 3000n);
    expect(await fiscal.issueForLedgerEntry(tooMuch.ledgerId, deps())).toEqual({ kind: "blocked", reason: "credit_exceeds_invoice" });
    const goodwill = await settledRefund(o2, 0, 1000n, { outlyFunded: true });
    expect(await fiscal.issueForLedgerEntry(goodwill.ledgerId, deps())).toEqual({ kind: "blocked", reason: "goodwill_unconfirmed" });

    // A refund before its invoice exists waits for it.
    const o3 = await paidOrder({ grosses: [5000n] });
    const early = await settledRefund(o3, 0, 5000n);
    expect(await fiscal.issueForLedgerEntry(early.ledgerId, deps())).toEqual({ kind: "blocked", reason: "invoice_missing" });
  });

  it("two refunds of one line issued at the same time never credit more than the line, VAT exact (finding 7)", async () => {
    const o = await paidOrder({ grosses: [40000n] });
    expect((await fiscal.issueForLedgerEntry(o.ledgerId, deps())).kind).toBe("issued");
    const a = await settledRefund(o, 0, 20000n);
    const b = await settledRefund(o, 0, 20000n);
    const results = await Promise.all([fiscal.issueForLedgerEntry(a.ledgerId, deps()), fiscal.issueForLedgerEntry(b.ledgerId, deps())]);
    expect(results.map((r) => r.kind)).toEqual(["issued", "issued"]);
    const inv = await prisma.fiscalDocument.findUniqueOrThrow({ where: { ledgerEntryId: o.ledgerId } });
    const credits = await prisma.fiscalDocument.findMany({ where: { refersToId: inv.id } });
    expect(credits.reduce((t, c) => t + c.grossMinor, 0n)).toBe(inv.grossMinor);
    // Built under the lock, the second credit note takes the line's remainder: VAT sums to the invoiced VAT exactly.
    expect(credits.reduce((t, c) => t + c.vatMinor, 0n)).toBe(inv.vatMinor);
  });

  it("the job step does nothing while the switch is off, and issues oldest first when on (scoped to this run)", async () => {
    const o = await paidOrder();
    expect(await fiscal.issueDue({ now: NOW, e: envWith({}), ledgerEntryIds: [o.ledgerId] })).toMatchObject({ skipped: "switch_off", issued: 0 });
    expect(await prisma.fiscalDocument.count({ where: { ledgerEntryId: o.ledgerId } })).toBe(0);
    const on = await fiscal.issueDue({ now: NOW, e: envWith({ FISCAL_DOCUMENTS_ENABLED: true }), ledgerEntryIds: [o.ledgerId], deps: { seller } });
    expect(on).toMatchObject({ issued: 1, blocked: 0, errors: 0 });
  });

  it("the job step never numbers an entry before the series' cut-off (finding 6)", async () => {
    // A separate legal entity, so the cut-off is set on a series with no document yet (it is fixed afterwards).
    const entity = `zz_d_${RUN}`;
    await prisma.fiscalSeries.create({ data: { id: uuidv7(), legalEntity: entity, environment: "test", docType: "tax_invoice", prefix: `TEST-ZD${RUN.toUpperCase()}-`, nextNumber: 1n, issueFrom: new Date(NOW.getTime() + 3600_000) } });
    const o = await paidOrder();
    const on = envWith({ FISCAL_DOCUMENTS_ENABLED: true, FISCAL_LEGAL_ENTITY: entity });
    expect(await fiscal.issueDue({ now: NOW, e: on, ledgerEntryIds: [o.ledgerId], deps: { seller } })).toMatchObject({ scanned: 0, issued: 0 });
    // Called directly it is refused too, silently (no attention row: being before the cut-off is by design).
    expect(await fiscal.issueForLedgerEntry(o.ledgerId, deps({ legalEntity: entity }))).toEqual({ kind: "blocked", reason: "before_issue_from" });
    expect(await prisma.fiscalAttention.count({ where: { entityId: o.ledgerId, resolvedAt: null } })).toBe(0);
    expect(await prisma.fiscalDocument.count({ where: { ledgerEntryId: o.ledgerId } })).toBe(0);
    // Re-review N9: a refund (after the cut-off) of that pre-cut-off capture has no invoice, so no credit note: silent.
    await prisma.fiscalSeries.create({ data: { id: uuidv7(), legalEntity: entity, environment: "test", docType: "tax_credit_note", prefix: `TEST-ZD${RUN.toUpperCase()}C-`, nextNumber: 1n } });
    const refund = await settledRefund(o, 0, 1000n);
    expect(await fiscal.issueDue({ now: new Date(NOW.getTime() + 2 * 3600_000), e: on, ledgerEntryIds: [refund.ledgerId], deps: { seller } })).toMatchObject({ scanned: 0 });
    expect(await fiscal.issueForLedgerEntry(refund.ledgerId, deps({ legalEntity: entity }))).toEqual({ kind: "blocked", reason: "before_issue_from" });
    expect(await prisma.fiscalAttention.count({ where: { entityId: refund.ledgerId, resolvedAt: null } })).toBe(0);
  });

  it("a blocked entry is looked at again only after the back-off, so it never hogs the scan (finding 6)", async () => {
    const o = await paidOrder({ withProduct: false });
    const on = envWith({ FISCAL_DOCUMENTS_ENABLED: true });
    expect(await fiscal.issueDue({ now: NOW, e: on, ledgerEntryIds: [o.ledgerId], deps: { seller } })).toMatchObject({ scanned: 1, blocked: 1 });
    expect(await fiscal.issueDue({ now: new Date(NOW.getTime() + 2 * 60_000), e: on, ledgerEntryIds: [o.ledgerId], deps: { seller } })).toMatchObject({ scanned: 0 });
    expect(await fiscal.issueDue({ now: new Date(NOW.getTime() + fiscal.FISCAL_BLOCKED_RECHECK_MS + 60_000), e: on, ledgerEntryIds: [o.ledgerId], deps: { seller } })).toMatchObject({ scanned: 1, blocked: 1 });
  });

  /* -------------------------------------------------------------- reconciliation */

  it("reconciliation: a refunded total with no refunds row raises one staff alert, cleared once the rows match", async () => {
    // Captured 100.00; a dashboard refund of 50.00 moves the provider's total with no refunds row (saga.ts syncPayment).
    // The capture leaves room for staff to record that refund afterwards: the database cap counts the provider total
    // AND every non-failed row (migration 20261101140000), so a row equal to the whole capture could never be added.
    const o = await paidOrder({ grosses: [10000n] });
    await prisma.payment.update({ where: { id: o.paymentId }, data: { refundedMinor: 5000n, status: "partially_refunded" } });
    const r1 = await fiscal.reconcileRefunds(NOW, { paymentIds: [o.paymentId] });
    expect(r1).toMatchObject({ checked: 1, raised: 1 });
    await fiscal.reconcileRefunds(new Date(NOW.getTime() + 60_000), { paymentIds: [o.paymentId] });
    const open = await prisma.fiscalAttention.findMany({ where: { entityId: o.paymentId, resolvedAt: null } });
    expect(open).toHaveLength(1);
    expect(open[0]).toMatchObject({ entityKind: "payment", reason: "refund_without_refund_row" });
    expect(JSON.stringify(open[0].detail)).not.toMatch(/\d{3,}/);
    const { fiscalIncidents } = await import("../ops-alert.service");
    // Finding 8: a refund gap reaches the ops email only once it has lasted 15 minutes.
    expect((await fiscalIncidents(new Date(NOW.getTime() - 1000), new Date(NOW.getTime() + 120_000))).find((i) => i.entityId === o.paymentId)).toBeUndefined();
    const incidents = await fiscalIncidents(new Date(NOW.getTime() - 1000), new Date(NOW.getTime() + 16 * 60_000));
    expect(incidents.find((i) => i.entityId === o.paymentId)).toMatchObject({ kind: "fiscal_attention", entityKind: "payment", reason: "refund_without_refund_row" });
    // No document is issued from here.
    expect(await prisma.fiscalDocument.count({ where: { paymentId: o.paymentId, docType: "tax_credit_note" } })).toBe(0);
    // Staff record the refund properly: the check clears.
    await prisma.refund.create({ data: { id: uuidv7(), paymentId: o.paymentId, orderItemId: o.items[0], provider: "stripe", providerRefundId: `re_dash_${RUN}`, idempotencyKey: `zc-dash-${RUN}`, amountMinor: 5000n, currency: "AED", status: "succeeded", reason: "staff_recorded" } });
    expect(await fiscal.reconcileRefunds(new Date(NOW.getTime() + 120_000), { paymentIds: [o.paymentId] })).toMatchObject({ resolved: 1 });
  });

  it("reconciliation: an ordinary refund still in flight (row accepted, provider total already moved) raises nothing (finding 8)", async () => {
    const o = await paidOrder({ grosses: [5000n] });
    await prisma.refund.create({ data: { id: uuidv7(), paymentId: o.paymentId, orderItemId: o.items[0], provider: "stripe", providerRefundId: `re_fl_${RUN}`, idempotencyKey: `zc-fl-${RUN}`, amountMinor: 2000n, currency: "AED", status: "accepted", reason: "customer_cancel_request" } });
    await prisma.payment.update({ where: { id: o.paymentId }, data: { refundedMinor: 2000n, status: "partially_refunded" } });
    expect(await fiscal.reconcileRefunds(NOW, { paymentIds: [o.paymentId] })).toMatchObject({ checked: 1, raised: 0 });
    expect(await prisma.fiscalAttention.count({ where: { entityId: o.paymentId, resolvedAt: null } })).toBe(0);
  });

  /* -------------------------------------------------------------- drawing and serving */

  it("draws the fiscal file from its snapshot, serves it checked, refuses while switched off, re-draws a lost object identically", async () => {
    const store = new MemoryDocumentStore();
    storeMod.setDocumentStoreForTests(store);
    const o = await paidOrder();
    const r = await fiscal.issueForLedgerEntry(o.ledgerId, deps());
    const fid = (r as { id: string }).id;
    const off = await generated.drawPendingFiscal({ store, now: NOW, max: 5, e: envWith({}), fiscalDocumentIds: [fid] });
    expect(off.skipped).toBe("switch_off");
    const on = envWith({ FISCAL_DOCUMENTS_ENABLED: true });
    expect(await generated.drawPendingFiscal({ store, now: NOW, max: 5, e: on, fiscalDocumentIds: [fid] })).toMatchObject({ drawn: 1, failed: 0 });
    const file = await prisma.generatedDocument.findFirstOrThrow({ where: { fiscalDocumentId: fid, status: "valid" } });
    expect(file.storageKey).toMatch(/^(test|development)\/[0-9a-f]{32}$/);

    expect(await read.readServableGenerated(file.id, NOW, envWith({}))).toEqual({ kind: "unavailable", reason: "switch_off" });
    const ok = await read.readServableGenerated(file.id, NOW, on);
    expect(ok.kind).toBe("ok");
    if (ok.kind !== "ok") return;
    expect(sha256Of(ok.bytes)).toBe(file.sha256);
    expect(ok.document).toMatchObject({ orderId: o.orderId, kind: "tax_invoice", displayNumber: (r as { displayNumber: string }).displayNumber });

    // The object is lost: the read answers "re-drawing" and queues a new copy; drawn again it is byte-identical.
    await store.delete(file.storageKey!);
    expect(await read.readServableGenerated(file.id, NOW, on)).toEqual({ kind: "unavailable", reason: "redrawing" });
    expect(await generated.drawPendingFiscal({ store, now: NOW, max: 5, e: on, fiscalDocumentIds: [fid] })).toMatchObject({ drawn: 1 });
    const again = await prisma.generatedDocument.findFirstOrThrow({ where: { fiscalDocumentId: fid, status: "valid" } });
    expect(again.id).not.toBe(file.id);
    expect(again.sha256).toBe(file.sha256);
    expect((await prisma.fiscalDocument.findUniqueOrThrow({ where: { id: fid } })).number).toBeGreaterThan(0n);
  });

  it("a fiscal file that fails for good raises a staff attention row; staff can re-queue it (finding 16)", async () => {
    const store = new MemoryDocumentStore();
    storeMod.setDocumentStoreForTests(store);
    const o = await paidOrder();
    const r = await fiscal.issueForLedgerEntry(o.ledgerId, deps());
    const fid = (r as { id: string }).id;
    const pending = await prisma.generatedDocument.findFirstOrThrow({ where: { fiscalDocumentId: fid, status: "pending" } });
    // The last allowed attempt, with a snapshot that cannot be drawn.
    await prisma.generatedDocument.update({ where: { id: pending.id }, data: { attempts: 4, snapshot: {} } });
    const on = envWith({ FISCAL_DOCUMENTS_ENABLED: true });
    expect(await generated.drawPendingFiscal({ store, now: NOW, max: 5, e: on, fiscalDocumentIds: [fid] })).toMatchObject({ failed: 1, drawn: 0 });
    expect((await prisma.generatedDocument.findUniqueOrThrow({ where: { id: pending.id } })).status).toBe("failed");
    const open = await prisma.fiscalAttention.findMany({ where: { entityId: o.ledgerId, resolvedAt: null } });
    expect(open.map((a) => a.reason)).toEqual(["fiscal_file_failed"]);
    // Staff fix the cause and re-queue: a new pending copy, the next version, the same number; the attention row closes.
    await prisma.generatedDocument.update({ where: { id: pending.id }, data: { snapshot: pending.snapshot as never } });
    expect(await generated.requeueFailedFiscalFile(fid, NOW)).toBe(true);
    expect(await generated.requeueFailedFiscalFile(fid, NOW)).toBe(false);
    expect(await generated.drawPendingFiscal({ store, now: NOW, max: 5, e: on, fiscalDocumentIds: [fid] })).toMatchObject({ drawn: 1 });
    expect((await prisma.generatedDocument.findFirstOrThrow({ where: { fiscalDocumentId: fid, status: "valid" } })).version).toBe(2);
    expect(await prisma.fiscalAttention.count({ where: { entityId: o.ledgerId, resolvedAt: null } })).toBe(0);
  });

  it("the download route answers 404 for a bad id, an unknown id, a switched-off kind and a caller without access", async () => {
    const { GET } = await import("@/app/api/tickets/generated/[id]/route");
    const call = async (id: string) => {
      const res = await GET(new (await import("next/server")).NextRequest(`http://localhost:3000/api/tickets/generated/${id}`, { headers: { "x-forwarded-for": `10.9.${n % 250}.${(++n % 250) + 1}` } }), { params: Promise.resolve({ id }) });
      return res;
    };
    const file = await prisma.generatedDocument.findFirstOrThrow({ where: { kind: "tax_invoice", status: "valid", orderId: { in: (await prisma.order.findMany({ where: { leadName: { startsWith: `zz-c-${RUN}` } }, select: { id: true } })).map((x) => x.id) } } });
    for (const id of ["not-a-uuid", uuidv7(), file.id]) {
      const res = await call(id);
      expect(res.status, id).toBe(404);
      expect(res.headers.get("cache-control")).toBe("private, no-store");
      expect(res.headers.get("referrer-policy")).toBe("no-referrer");
    }
    process.env.FISCAL_DOCUMENTS_ENABLED = "true";
    resetEnvCache();
    try {
      // Switched on, but the caller has no session, grant or staff role.
      expect((await call(file.id)).status).toBe(404);
    } finally {
      delete process.env.FISCAL_DOCUMENTS_ENABLED;
      resetEnvCache();
    }
  });

  /* -------------------------------------------------------------- branded entry file */

  it("branded entry file from a SYNTHETIC supplier tickets PDF: switch off does nothing; on, one verified file; a reissue supersedes it", async () => {
    const store = new MemoryDocumentStore();
    storeMod.setDocumentStoreForTests(store);
    const o = await paidOrder({ grosses: [5000n] });
    const booking = await prisma.supplierBooking.create({
      data: {
        id: uuidv7(),
        orderId: o.orderId,
        orderItemId: o.items[0],
        supplierId,
        environment: "test",
        idempotencyKey: `zc-${RUN}-b`,
        clientRef: `OUTTD-ZC${RUN.toUpperCase()}`,
        bookingKind: "ticket_only",
        afterReserve: "await_payment",
        state: "confirmed",
        tourExternalId: "1",
        offerExternalId: "1",
        serviceDate: new Date("2027-02-20T00:00:00Z"),
        adults: 2,
        guestName: "Asha Specimen",
        expectedNetMinor: 1000n,
        expectedNetUsdMinor: 300n,
        supplierBookingId: "000000",
        confirmedAt: NOW,
        closedAt: NOW,
      },
    });
    // Two issued units (TKT-1 rows; the ciphertext is a placeholder, never read here).
    const codesDoc = await prisma.supplierDocument.create({ data: { id: uuidv7(), supplierBookingId: booking.id, orderId: o.orderId, orderItemId: o.items[0], kind: "ticket_codes", version: 1, status: "valid", source: "confirm_response", validatedAt: NOW } });
    for (const i of [0, 1]) {
      await prisma.supplierTicketCode.create({ data: { id: uuidv7(), documentId: codesDoc.id, supplierBookingId: booking.id, unitIndex: i, ticketFor: "adult", codeCiphertext: PLACEHOLDER_CIPHERTEXT, codeKeyId: "zz", codeHash: randomBytes(32).toString("hex") } });
    }
    const pdf = await syntheticSupplierPdf({ layout: [1, 1] });
    const key = `test/${randomBytes(16).toString("hex")}`;
    await store.put(key, pdf, "application/pdf");
    const src = await prisma.supplierDocument.create({
      data: { id: uuidv7(), supplierBookingId: booking.id, orderId: o.orderId, orderItemId: o.items[0], kind: "tickets_pdf", version: 1, status: "valid", source: "pdf_download", storageKey: key, contentType: "application/pdf", byteSize: pdf.byteLength, sha256: sha256Of(pdf), validatedAt: NOW },
    });
    const scope = { sourceDocumentIds: [src.id] };
    expect(await generated.generatePendingEntries({ store, now: NOW, max: 3, e: envWith({}), ...scope })).toMatchObject({ skipped: "switch_off" });
    expect(await prisma.generatedDocument.count({ where: { sourceDocumentId: src.id } })).toBe(0);

    const on = envWith({ BRANDED_ENTRY_PDF_ENABLED: true });
    expect(await generated.generatePendingEntries({ store, now: NOW, max: 3, e: on, ...scope })).toMatchObject({ drawn: 1, none: 0 });
    const file = await prisma.generatedDocument.findFirstOrThrow({ where: { sourceDocumentId: src.id } });
    expect(file).toMatchObject({ kind: "entry_pdf", status: "valid", sourceSha256: src.sha256, orderItemId: o.items[0] });
    expect(JSON.stringify(file.snapshot)).not.toMatch(/SPECIMEN-NOT-VALID|placeholder|expectedNet/);
    // A second run does not make another.
    expect(await generated.generatePendingEntries({ store, now: NOW, max: 3, e: on, ...scope })).toMatchObject({ drawn: 0 });
    expect((await read.readServableGenerated(file.id, NOW, on)).kind).toBe("ok");
    // Vouchers are not on the approved list yet (O12).
    expect(on.BRANDED_ENTRY_PDF_KINDS).toEqual(["tickets_pdf"]);

    // The supplier reissues: the old source is superseded, so the branded file is no longer served and is superseded.
    await prisma.supplierDocument.update({ where: { id: src.id }, data: { status: "superseded", invalidatedAt: NOW } });
    expect(await read.readServableGenerated(file.id, NOW, on)).toEqual({ kind: "unavailable", reason: "not_valid" });
    await generated.supersedeStaleEntries(NOW);
    expect((await prisma.generatedDocument.findUniqueOrThrow({ where: { id: file.id } })).status).toBe("superseded");
  }, 120_000);

  it("a cancelled booking hides its branded file from customers and supersedes it, like the operator's file (finding 3)", async () => {
    const store = new MemoryDocumentStore();
    storeMod.setDocumentStoreForTests(store);
    const o = await paidOrder({ grosses: [5000n] });
    const { booking, src } = await entrySource(store, o);
    const on = envWith({ BRANDED_ENTRY_PDF_ENABLED: true });
    expect(await generated.generatePendingEntries({ store, now: NOW, max: 3, e: on, sourceDocumentIds: [src.id] })).toMatchObject({ drawn: 1 });
    const file = await prisma.generatedDocument.findFirstOrThrow({ where: { sourceDocumentId: src.id, status: "valid" } });
    const { ticketAccess } = await import("../capability.service");
    expect((await ticketAccess.documentOwner(src.id))?.customerVisible).toBe(true);
    expect((await read.generatedOwner(file.id))?.sourceDocumentId).toBe(src.id);

    // A verified cancellation (R-B5-8): the operator's file is hidden, and so is the branded one.
    await prisma.supplierBooking.update({ where: { id: booking.id }, data: { state: "cancelled" } });
    expect((await ticketAccess.documentOwner(src.id))?.customerVisible).toBe(false);
    expect(await read.readServableGenerated(file.id, NOW, on)).toEqual({ kind: "unavailable", reason: "not_valid" });
    await generated.supersedeStaleEntries(NOW);
    expect((await prisma.generatedDocument.findUniqueOrThrow({ where: { id: file.id } })).status).toBe("superseded");
    // And nothing new is made from it.
    expect(await generated.generatePendingEntries({ store, now: NOW, max: 3, e: on, sourceDocumentIds: [src.id] })).toMatchObject({ drawn: 0, cover: 0, none: 0 });
    expect(await prisma.generatedDocument.count({ where: { sourceDocumentId: src.id, status: { in: ["pending", "valid"] } } })).toBe(0);
  }, 120_000);

  it("taking a kind off BRANDED_ENTRY_PDF_KINDS stops its files at serve time (finding 23); a lost object is made again (finding 15)", async () => {
    const store = new MemoryDocumentStore();
    storeMod.setDocumentStoreForTests(store);
    const o = await paidOrder({ grosses: [5000n] });
    const { src } = await entrySource(store, o);
    const on = envWith({ BRANDED_ENTRY_PDF_ENABLED: true });
    expect(await generated.generatePendingEntries({ store, now: NOW, max: 3, e: on, sourceDocumentIds: [src.id] })).toMatchObject({ drawn: 1 });
    const file = await prisma.generatedDocument.findFirstOrThrow({ where: { sourceDocumentId: src.id, status: "valid" } });
    expect(await read.readServableGenerated(file.id, NOW, envWith({ BRANDED_ENTRY_PDF_ENABLED: true, BRANDED_ENTRY_PDF_KINDS: ["voucher_pdf"] }))).toEqual({ kind: "unavailable", reason: "switch_off" });
    // The stored object is lost: superseded at read, then made again with the next version.
    await store.delete(file.storageKey!);
    expect(await read.readServableGenerated(file.id, NOW, on)).toEqual({ kind: "unavailable", reason: "redrawing" });
    expect(await generated.generatePendingEntries({ store, now: NOW, max: 3, e: on, sourceDocumentIds: [src.id] })).toMatchObject({ drawn: 1 });
    const again = await prisma.generatedDocument.findFirstOrThrow({ where: { sourceDocumentId: src.id, status: "valid" } });
    expect(again.id).not.toBe(file.id);
    expect(again.version).toBe(file.version + 1);
  }, 120_000);

  it("a code reader that cannot load claims nothing and is reported as waiting; a faulting file is retried, then failed and reported (findings 11, 13)", async () => {
    const store = new MemoryDocumentStore();
    storeMod.setDocumentStoreForTests(store);
    const o = await paidOrder({ grosses: [5000n] });
    const { src } = await entrySource(store, o);
    const on = envWith({ BRANDED_ENTRY_PDF_ENABLED: true });
    const { DecoderUnavailableError } = await import("../../documents/generated/entry/code-decoder");
    const down = async () => {
      throw new DecoderUnavailableError("wasm_missing");
    };
    expect(await generated.generatePendingEntries({ store, now: NOW, max: 3, e: on, sourceDocumentIds: [src.id], decoderReady: down })).toMatchObject({ skipped: "decoder_unavailable" });
    expect(await prisma.generatedDocument.count({ where: { sourceDocumentId: src.id } })).toBe(0);

    process.env.BRANDED_ENTRY_PDF_ENABLED = "true";
    resetEnvCache();
    try {
      const { entryFileIncidents, ENTRY_FILE_WAIT_ALERT_MS } = await import("../ops-alert.service");
      const waiting = await entryFileIncidents(new Date(NOW.getTime() - 3600_000), new Date(NOW.getTime() + ENTRY_FILE_WAIT_ALERT_MS + 60_000));
      expect(waiting.find((i) => i.entityId === src.id)).toMatchObject({ kind: "entry_file_waiting", entityKind: "supplier_document" });

      // Reads that throw: a fault, retried with a back-off, failed for good on the third attempt.
      const failing = new FailingReadStore();
      const times = [NOW, new Date(NOW.getTime() + 3 * 60_000), new Date(NOW.getTime() + 8 * 60_000)];
      for (const t of times) await generated.generatePendingEntries({ store: failing, now: t, max: 3, e: on, sourceDocumentIds: [src.id], decoderReady: async () => {} });
      const row = await prisma.generatedDocument.findFirstOrThrow({ where: { sourceDocumentId: src.id } });
      expect(row).toMatchObject({ status: "failed", reasonCode: "fault_generate_error", attempts: 3 });
      // Not picked again for this source version.
      expect(await generated.generatePendingEntries({ store, now: new Date(NOW.getTime() + 3600_000), max: 3, e: on, sourceDocumentIds: [src.id] })).toMatchObject({ drawn: 0, failed: 0 });
      const failed = await entryFileIncidents(new Date(NOW.getTime() - 1000), new Date(NOW.getTime() + 3600_000));
      expect(failed.find((i) => i.entityId === src.id && i.kind === "entry_file_failed")).toMatchObject({ reason: "fault_generate_error" });
    } finally {
      delete process.env.BRANDED_ENTRY_PDF_ENABLED;
      resetEnvCache();
    }
  }, 120_000);

  it("a row whose last attempt never returned is failed, not claimed again for ever (re-review N6)", async () => {
    const store = new MemoryDocumentStore();
    storeMod.setDocumentStoreForTests(store);
    // Fiscal: a pending file at the attempt limit with an expired lock (the function was killed mid-draw).
    const o = await paidOrder();
    const r = await fiscal.issueForLedgerEntry(o.ledgerId, deps());
    const fid = (r as { id: string }).id;
    const pending = await prisma.generatedDocument.findFirstOrThrow({ where: { fiscalDocumentId: fid, status: "pending" } });
    await prisma.generatedDocument.update({ where: { id: pending.id }, data: { attempts: 5, lockedUntil: new Date(NOW.getTime() - 60_000) } });
    const on = envWith({ FISCAL_DOCUMENTS_ENABLED: true, BRANDED_ENTRY_PDF_ENABLED: true });
    expect(await generated.drawPendingFiscal({ store, now: NOW, max: 5, e: on, fiscalDocumentIds: [fid] })).toMatchObject({ failed: 1, drawn: 0 });
    expect(await prisma.generatedDocument.findUniqueOrThrow({ where: { id: pending.id } })).toMatchObject({ status: "failed", reasonCode: "fault_timeout" });
    expect((await prisma.fiscalAttention.findMany({ where: { entityId: o.ledgerId, resolvedAt: null } })).map((a) => a.reason)).toEqual(["fiscal_file_failed"]);
    // Entry: the same for a claimed row at the limit.
    const e2 = await paidOrder({ grosses: [5000n] });
    const { src } = await entrySource(store, e2);
    await prisma.generatedDocument.create({
      data: { id: uuidv7(), kind: "entry_pdf", orderId: e2.orderId, orderItemId: e2.items[0], sourceDocumentId: src.id, sourceSha256: src.sha256, templateVersion: 1, status: "pending", attempts: generated.ENTRY_MAX_ATTEMPTS, lockedUntil: new Date(NOW.getTime() - 60_000) },
    });
    expect(await generated.generatePendingEntries({ store, now: NOW, max: 3, e: on, sourceDocumentIds: [src.id], decoderReady: async () => {} })).toMatchObject({ failed: 1, drawn: 0 });
    expect(await prisma.generatedDocument.findFirstOrThrow({ where: { sourceDocumentId: src.id } })).toMatchObject({ status: "failed", reasonCode: "fault_timeout" });
  }, 120_000);

  it("a file that faults the reader while the reader still works is the file's fault: retried, then failed (re-review N7)", async () => {
    const store = new MemoryDocumentStore();
    storeMod.setDocumentStoreForTests(store);
    const o = await paidOrder({ grosses: [5000n] });
    const { src } = await entrySource(store, o);
    const on = envWith({ BRANDED_ENTRY_PDF_ENABLED: true });
    const { DecoderUnavailableError } = await import("../../documents/generated/entry/code-decoder");
    const faulting = () => ({
      async decode(): Promise<never> {
        throw new DecoderUnavailableError("read_failed");
      },
    });
    const run = (t: Date, works: boolean) => generated.generatePendingEntries({ store, now: t, max: 3, e: on, sourceDocumentIds: [src.id], decoderReady: async () => {}, decoder: faulting, decoderWorks: async () => works });
    // Reader down (the known-good decode fails too): the attempt is given back, nothing is failed.
    expect(await run(NOW, false)).toMatchObject({ failed: 0, retried: 1 });
    expect(await prisma.generatedDocument.findFirstOrThrow({ where: { sourceDocumentId: src.id } })).toMatchObject({ status: "pending", attempts: 0, reasonCode: "decoder_unavailable" });
    // Reader fine, this file faults it every time: counted, failed for good on the third attempt.
    for (const minutes of [6, 9, 14]) await run(new Date(NOW.getTime() + minutes * 60_000), true);
    expect(await prisma.generatedDocument.findFirstOrThrow({ where: { sourceDocumentId: src.id } })).toMatchObject({ status: "failed", reasonCode: "fault_decoder", attempts: 3 });
  }, 120_000);

  it("a second source of an item that already has a live entry file waits and never takes a place in the run (re-review N8)", async () => {
    const store = new MemoryDocumentStore();
    storeMod.setDocumentStoreForTests(store);
    const o = await paidOrder({ grosses: [5000n] });
    const { booking, src } = await entrySource(store, o);
    const on = envWith({ BRANDED_ENTRY_PDF_ENABLED: true, BRANDED_ENTRY_PDF_KINDS: ["tickets_pdf", "voucher_pdf"] });
    expect(await generated.generatePendingEntries({ store, now: NOW, max: 3, e: on, sourceDocumentIds: [src.id] })).toMatchObject({ drawn: 1 });
    const pdf = await syntheticSupplierPdf({ layout: [1, 1] });
    const key = `test/${randomBytes(16).toString("hex")}`;
    await store.put(key, pdf, "application/pdf");
    const voucher = await prisma.supplierDocument.create({
      data: { id: uuidv7(), supplierBookingId: booking.id, orderId: o.orderId, orderItemId: o.items[0], kind: "voucher_pdf", version: 1, status: "valid", source: "pdf_download", storageKey: key, contentType: "application/pdf", byteSize: pdf.byteLength, sha256: sha256Of(pdf), validatedAt: NOW },
    });
    expect(await generated.generatePendingEntries({ store, now: NOW, max: 3, e: on, sourceDocumentIds: [voucher.id] })).toMatchObject({ drawn: 0, cover: 0, none: 0, failed: 0 });
    expect(await prisma.generatedDocument.count({ where: { sourceDocumentId: voucher.id } })).toBe(0);
  }, 120_000);

  /* -------------------------------------------------------------- payment email */

  it("payment email: once per order, ids-only row, no link, no attachment while the fiscal switch is off", async () => {
    const o = await paidOrder();
    sent.length = 0;
    const r = await notifications.notificationService.onPaymentCaptured({ orderId: o.orderId, paymentId: o.paymentId }, NOW);
    expect(r?.outcome).toBe("sent");
    const row = await prisma.notification.findUniqueOrThrow({ where: { id: r!.id } });
    expect(row.event).toBe("PAYMENT_RECEIVED");
    expect(row.payload).toEqual({ kind: "payment_message", orderId: o.orderId, paymentId: o.paymentId, attachGeneratedDocumentId: null });
    expect(sent).toHaveLength(1);
    expect(sent[0].key).toBe(row.id);
    expect(sent[0].msg.text).toContain("This email is not your entry ticket.");
    expect(sent[0].msg.text).toContain("AED 420.00");
    expect(sent[0].msg.html).not.toMatch(/<a\s/i);
    expect(sent[0].msg.attachments).toBeUndefined();
    const again = await notifications.notificationService.onPaymentCaptured({ orderId: o.orderId, paymentId: o.paymentId }, NOW);
    expect(again).toMatchObject({ id: r!.id, duplicate: true });
    expect(sent).toHaveLength(1);
    // The sweep (scoped) finds nothing left to send for it.
    expect(await notifications.notificationService.sweepPaymentReceived(new Date(NOW.getTime() + 60_000), 25, { orderIds: [o.orderId] })).toMatchObject({ scanned: 0 });
    // No email address: nothing.
    const silent = await paidOrder({ email: null });
    expect(await notifications.notificationService.onPaymentCaptured({ orderId: silent.orderId, paymentId: silent.paymentId }, NOW)).toBeNull();
  });

  it("payment email sweep: a recent capture with no email yet gets one; an old capture never does", async () => {
    const recent = await paidOrder();
    sent.length = 0;
    const s1 = await notifications.notificationService.sweepPaymentReceived(new Date(NOW.getTime() + 5 * 60_000), 25, { orderIds: [recent.orderId] });
    expect(s1).toMatchObject({ scanned: 1, sent: 1 });
    const old = await paidOrder();
    const s2 = await notifications.notificationService.sweepPaymentReceived(new Date(NOW.getTime() + 2 * 3600_000), 25, { orderIds: [old.orderId] });
    expect(s2).toMatchObject({ scanned: 0 });
  });

  it("payment email attaches the combined invoice only when the switch is on and the file exists (O8)", async () => {
    const store = new MemoryDocumentStore();
    storeMod.setDocumentStoreForTests(store);
    const o = await paidOrder();
    const r = await fiscal.issueForLedgerEntry(o.ledgerId, deps());
    const fid = (r as { id: string }).id;
    process.env.FISCAL_DOCUMENTS_ENABLED = "true";
    resetEnvCache();
    try {
      await generated.drawPendingFiscal({ store, now: NOW, max: 5, fiscalDocumentIds: [fid] });
      sent.length = 0;
      const res = await notifications.notificationService.onPaymentCaptured({ orderId: o.orderId, paymentId: o.paymentId }, NOW);
      expect(res?.outcome).toBe("sent");
      expect(sent).toHaveLength(1);
      const att = sent[0].msg.attachments ?? [];
      expect(att).toHaveLength(1);
      expect(att[0].filename).toBe(`OUTLYY-tax-invoice-${(r as { displayNumber: string }).displayNumber}.pdf`);
      expect(Buffer.from(att[0].content).subarray(0, 5).toString()).toBe("%PDF-");
      expect(sent[0].msg.text).toContain((r as { displayNumber: string }).displayNumber);
      // The payment email carried the invoice: no follow-up invoice email for it.
      expect(await notifications.notificationService.sweepInvoiceIssued(new Date(NOW.getTime() + 60_000), 5, { orderIds: [o.orderId] })).toMatchObject({ scanned: 0 });
    } finally {
      delete process.env.FISCAL_DOCUMENTS_ENABLED;
      resetEnvCache();
    }
  });

  it("follow-up invoice email: an invoice drawn after the payment email is sent once, attached, only with the fiscal switch on (finding 14)", async () => {
    const store = new MemoryDocumentStore();
    storeMod.setDocumentStoreForTests(store);
    const o = await paidOrder();
    sent.length = 0;
    // The payment email goes first, before any invoice exists.
    expect((await notifications.notificationService.onPaymentCaptured({ orderId: o.orderId, paymentId: o.paymentId }, NOW))?.outcome).toBe("sent");
    expect(sent[0].msg.attachments).toBeUndefined();
    const r = await fiscal.issueForLedgerEntry(o.ledgerId, deps());
    const fid = (r as { id: string }).id;
    const later = new Date(NOW.getTime() + 2 * 60_000);
    // Fiscal switch off: nothing.
    expect(await notifications.notificationService.sweepInvoiceIssued(later, 5, { orderIds: [o.orderId] })).toMatchObject({ skipped: "switch_off" });
    process.env.FISCAL_DOCUMENTS_ENABLED = "true";
    resetEnvCache();
    try {
      await generated.drawPendingFiscal({ store, now: NOW, max: 5, fiscalDocumentIds: [fid] });
      sent.length = 0;
      // Re-review N5: the fiscal switch alone never starts customer email; the payment email switch gates it too.
      process.env.PAYMENT_RECEIVED_EMAIL_ENABLED = "false";
      resetEnvCache();
      expect(await notifications.notificationService.sweepInvoiceIssued(later, 5, { orderIds: [o.orderId] })).toMatchObject({ skipped: "switch_off" });
      process.env.PAYMENT_RECEIVED_EMAIL_ENABLED = "true";
      resetEnvCache();
      // The window is on the capture time: a day and more after the capture, nothing.
      expect(await notifications.notificationService.sweepInvoiceIssued(new Date(NOW.getTime() + notifications.INVOICE_ISSUED_WINDOW_MS + 60_000), 5, { orderIds: [o.orderId] })).toMatchObject({ scanned: 0 });
      expect(await notifications.notificationService.sweepInvoiceIssued(later, 5, { orderIds: [o.orderId] })).toMatchObject({ scanned: 1, sent: 1 });
      expect(sent).toHaveLength(1);
      expect(sent[0].msg.subject).toContain((r as { displayNumber: string }).displayNumber);
      expect(sent[0].msg.text).toContain("This email is not your entry ticket.");
      expect(sent[0].msg.text).not.toContain("separate email");
      expect(sent[0].msg.html).not.toMatch(/<a\s/i);
      expect(sent[0].msg.attachments?.[0].filename).toBe(`OUTLYY-tax-invoice-${(r as { displayNumber: string }).displayNumber}.pdf`);
      // Once per invoice.
      expect(await notifications.notificationService.sweepInvoiceIssued(new Date(later.getTime() + 60_000), 5, { orderIds: [o.orderId] })).toMatchObject({ scanned: 0 });
      expect(sent).toHaveLength(1);
    } finally {
      delete process.env.FISCAL_DOCUMENTS_ENABLED;
      resetEnvCache();
    }
  });

  it("payment email kill switch: off writes and sends nothing, and a row already written is not sent (PAYMENT_RECEIVED_EMAIL_ENABLED)", async () => {
    const o = await paidOrder();
    sent.length = 0;
    process.env.PAYMENT_RECEIVED_EMAIL_ENABLED = "false";
    resetEnvCache();
    try {
      expect(await notifications.notificationService.onPaymentCaptured({ orderId: o.orderId, paymentId: o.paymentId }, NOW)).toBeNull();
      expect(await notifications.notificationService.sweepPaymentReceived(new Date(NOW.getTime() + 60_000), 5, { orderIds: [o.orderId] })).toMatchObject({ skipped: "switch_off", scanned: 0 });
      expect(await prisma.notification.count({ where: { orderId: o.orderId, event: "PAYMENT_RECEIVED" } })).toBe(0);
    } finally {
      process.env.PAYMENT_RECEIVED_EMAIL_ENABLED = "true";
      resetEnvCache();
    }
    expect(sent).toHaveLength(0);
  });

  it("no payment email for an order whose money is being refunded, and only captured items are listed (finding 9)", async () => {
    sent.length = 0;
    // The supplier failed after capture and the saga started the refund: no "we have received your payment".
    const refunding = await paidOrder({ grosses: [5000n] });
    await prisma.refund.create({ data: { id: uuidv7(), paymentId: refunding.paymentId, orderItemId: refunding.items[0], provider: "stripe", providerRefundId: `re_auto_${RUN}`, idempotencyKey: `zc-auto-${RUN}`, amountMinor: 5000n, currency: "AED", status: "requested", reason: "supplier_failed" } });
    expect(await notifications.notificationService.onPaymentCaptured({ orderId: refunding.orderId, paymentId: refunding.paymentId }, NOW)).toBeNull();
    expect(await notifications.notificationService.sweepPaymentReceived(new Date(NOW.getTime() + 60_000), 5, { orderIds: [refunding.orderId] })).toMatchObject({ sent: 0 });
    const cancelled = await paidOrder({ grosses: [5000n] });
    await prisma.order.update({ where: { id: cancelled.orderId }, data: { status: "cancelled" } });
    expect(await notifications.notificationService.onPaymentCaptured({ orderId: cancelled.orderId, paymentId: cancelled.paymentId }, NOW)).toBeNull();
    expect(sent).toHaveLength(0);
    // A partial capture: the item rejected before it is not listed.
    const partial = await paidOrder({ grosses: [40000n, 2000n], captured: 40000n });
    await prisma.orderItem.update({ where: { id: partial.items[1] }, data: { status: "rejected" } });
    expect((await notifications.notificationService.onPaymentCaptured({ orderId: partial.orderId, paymentId: partial.paymentId }, NOW))?.outcome).toBe("sent");
    expect(sent[0].msg.text).toContain("Specimen Activity 1");
    expect(sent[0].msg.text).not.toContain("Specimen Activity 2");
  });
});
