import { createHash, randomBytes } from "node:crypto";
import path from "node:path";
import { PrismaClient } from "@prisma/client";
import { assertDisposableDbLive, loadEnvFile, testEnvFile } from "../../src/server/__tests__/helpers/target-guard";
import { formatReference, uuidv7 } from "../../src/server/lib/ids";

/**
 * Database access for the browser specs that need a real order behind a
 * server-rendered page (the customer status page renders the server's own
 * projection, so it cannot be routed in the browser).
 *
 * The connection comes from the test env file the app server uses
 * (OUTLY_TEST_ENV_FILE, a `.env.test*.local` name; `.env.test.local` by
 * default), and the target guard admits it before the first write: loopback,
 * a disposable test database carrying the instance marker, no provider
 * credential in the environment. Every row is synthetic: `zz-e2e-<run>`
 * names, synthetic amounts and nets, a synthetic guest. `cleanup` removes
 * them, child first.
 */

const repoRoot = path.resolve(__dirname, "../..");
const sha = (s: string) => createHash("sha256").update(s).digest("hex");

let client: PrismaClient | null = null;

/** A guarded client for the disposable test database. Throws (never skips) when the target is not admitted. */
export async function testDb(): Promise<PrismaClient> {
  if (client) return client;
  const fileEnv: Record<string, string | undefined> = {};
  const file = testEnvFile({ env: { OUTLY_TEST_ENV_FILE: process.env.OUTLY_TEST_ENV_FILE }, cwd: repoRoot });
  loadEnvFile(file, fileEnv);
  // The guard sees this process's variables too (no provider credential may be present), with the file's database.
  const env = { ...process.env, ...fileEnv };
  const url = fileEnv.DATABASE_URL;
  if (!url) throw new Error(`${path.basename(file)} has no DATABASE_URL`);
  const prisma = new PrismaClient({ datasources: { db: { url } } });
  try {
    await assertDisposableDbLive(prisma, { env, cwd: repoRoot });
  } catch (e) {
    await prisma.$disconnect();
    throw e;
  }
  client = prisma;
  return prisma;
}

export async function closeTestDb(): Promise<void> {
  await client?.$disconnect();
  client = null;
}

export interface PlantedItem {
  id: string;
  title: string;
  bookingId: string;
  chargedMinor: bigint;
}

export interface PlantedOrder {
  run: string;
  id: string;
  reference: string;
  /** The guest session cookie value (`outlyy_guest_session`) of the browser that made the quote. */
  guestToken: string;
  paymentId: string;
  sagaId: string;
  supplierId: string;
  guestId: string;
  guestSessionId: string;
  items: PlantedItem[];
  totalMinor: bigint;
}

/** Synthetic charged amounts (AED fils); nets are a token 1 fil, never a real rate. */
const ITEM_CHARGES = [44_000n, 52_000n, 61_000n];

/**
 * A three-item instant order as checkout and the saga leave it after the
 * capture (doc 22 §32.20): one quote used by the order, one item per quote
 * line (in line order), one captured AED payment for the quote total, and the
 * saga in `confirm_pending`. Item 1's supplier booking is already confirmed,
 * item 2's is confirming, item 3's is still held. The browser that made the
 * quote is a guest session; its cookie token is returned.
 */
export async function plantMultiItemOrder(): Promise<PlantedOrder> {
  const prisma = await testDb();
  const run = randomBytes(4).toString("hex");
  const products = await prisma.product.findMany({
    where: { status: "published", deletedAt: null },
    orderBy: { slug: "asc" },
    select: { id: true, slug: true, tier: true },
    take: 3,
  });
  if (products.length < 3) throw new Error("the test database needs three published products (run the seed)");

  const supplierId = uuidv7();
  await prisma.supplier.create({ data: { id: supplierId, code: `zz-e2e-${run}`, name: "zz e2e multi-item fixture", source: "api", adapter: "traveldesk" } });

  const guestToken = randomBytes(32).toString("base64url");
  const guestSessionId = uuidv7();
  const now = new Date();
  await prisma.guestSession.create({ data: { id: guestSessionId, tokenHash: sha(guestToken), createdAt: new Date(now.getTime() - 600_000), expiresAt: new Date(now.getTime() + 3 * 3600_000) } });

  const guestId = uuidv7();
  await prisma.guest.create({ data: { id: guestId, phoneE164: "+971500000000", fullName: `zz-e2e-${run} traveller` } });

  const [{ n }] = await prisma.$queryRaw<{ n: bigint }[]>`SELECT nextval('order_ref_seq') AS n`;
  const id = uuidv7();
  const reference = formatReference("OUT", n);
  const totalMinor = ITEM_CHARGES.reduce((s, v) => s + v, 0n);
  const quoteId = uuidv7();
  const paymentId = uuidv7();
  const sagaId = uuidv7();

  await prisma.order.create({
    data: {
      id,
      reference,
      guestId,
      status: "paid",
      rail: "self_serve",
      paymentCollection: "gateway",
      currency: "AED",
      subtotalInr: 0n,
      subtotalAed: totalMinor,
      totalInr: 0n,
      totalAed: totalMinor,
      netCostAed: 3n,
      leadName: `zz-e2e-${run} traveller`,
      leadPhone: "",
      leadEmail: `zz-e2e-${run}@outlyy.test`,
      paidAt: now,
    },
  });

  const lines = products.map((p, index) => ({
    index,
    productId: p.id,
    serviceDate: `2030-01-${String(15 + index).padStart(2, "0")}`,
    slotRef: null,
    chargedMinor: ITEM_CHARGES[index].toString(),
    discountAllocMinor: "0",
    taxAllocMinor: "0",
    freeCancellationUntilUtc: null,
    nonRefundableAfterConfirm: true,
  }));
  await prisma.quote.create({
    data: {
      id: quoteId,
      fingerprint: sha(`zz-e2e:${run}:${quoteId}`),
      ownerKind: "guest",
      guestSessionId,
      currency: "AED",
      totalMinor,
      lines,
      request: { lines: [] },
      status: "used",
      usedByOrderId: id,
      createdAt: new Date(now.getTime() - 300_000),
      expiresAt: new Date(now.getTime() + 300_000),
    },
  });

  const items: PlantedItem[] = [];
  const mappings: string[] = [];
  for (const [index, p] of products.entries()) {
    const mappingId = uuidv7();
    mappings.push(mappingId);
    await prisma.productSupplierMapping.create({
      data: {
        id: mappingId,
        productId: p.id,
        supplierId,
        variantCode: `zz-e2e-${run}-${index}`,
        externalRef: { tourId: 1, offerId: 2, bookingKind: "live_book", isExternal: false },
        isActive: false,
      },
    });
    const itemId = uuidv7();
    const title = `Synthetic instant experience ${index + 1} (zz-e2e-${run})`;
    await prisma.orderItem.create({
      data: {
        id: itemId,
        orderId: id,
        productId: p.id,
        mappingId,
        titleSnapshot: title,
        tierSnapshot: p.tier,
        slugSnapshot: p.slug,
        kindSnapshot: "activity",
        confirmationSnapshot: "instant",
        fulfilmentModeSnapshot: "instant",
        freeCancellationHoursSnapshot: 0,
        durationMinutesSnapshot: 120,
        serviceDate: new Date(`${lines[index].serviceDate}T00:00:00.000Z`),
        timeslot: "10:00",
        pax: { adult: 2 },
        unitInr: 0n,
        unitAed: ITEM_CHARGES[index] / 2n,
        totalInr: 0n,
        totalAed: ITEM_CHARGES[index],
        netCostAed: 1n,
        fulfilmentOrigin: "instant_checkout",
        chargedCurrency: "AED",
        chargedAmountMinor: ITEM_CHARGES[index],
        discountAllocMinor: 0n,
        taxAllocMinor: 0n,
        quoteId,
        quoteLineIndex: index,
        marginSnapshot: { policyVersion: 1, floorBps: 1500, grossMarginBps: 3000, costLines: [] },
      },
    });
    items.push({ id: itemId, title, bookingId: uuidv7(), chargedMinor: ITEM_CHARGES[index] });
  }

  await prisma.payment.create({
    data: {
      id: paymentId,
      orderId: id,
      gateway: "fake_aed_card",
      source: "gateway_verified",
      rail: "aed_card",
      provider: "fake_aed_card",
      providerAccountId: "zz-e2e-acct",
      environment: "test",
      idempotencyKey: `pay:${id}:1`,
      gatewayPaymentId: `zz_e2e_pay_${run}`,
      method: "card",
      amountMinor: totalMinor,
      currency: "AED",
      status: "captured",
      capturedMinor: totalMinor,
      authorizedAt: now,
      capturedAt: now,
      quoteId,
    },
  });
  // The saga names the first item; it covers every instant item of the order.
  await prisma.paymentSaga.create({
    data: { id: sagaId, orderId: id, orderItemId: items[0].id, paymentId, rail: "aed_card", state: "confirm_pending", deadlineAt: new Date(now.getTime() + 20 * 60_000) },
  });

  const bookingStates = ["confirmed", "confirming", "awaiting_payment"] as const;
  for (const [index, item] of items.entries()) {
    await prisma.supplierBooking.create({
      data: {
        id: item.bookingId,
        orderId: id,
        orderItemId: item.id,
        supplierId,
        mappingId: mappings[index],
        environment: "test",
        idempotencyKey: `zz-e2e:${run}:${item.id}:1`,
        clientRef: `ZZE${item.bookingId.replace(/-/g, "").slice(-12)}`,
        bookingKind: "live_book",
        afterReserve: "await_payment",
        tourExternalId: "1",
        offerExternalId: "2",
        serviceDate: new Date(`${lines[index].serviceDate}T00:00:00.000Z`),
        startMinutes: 600,
        adults: 2,
        guestName: `zz-e2e-${run} guest`,
        expectedNetMinor: 1n,
        expectedNetUsdMinor: 1n,
        state: bookingStates[index],
        confirmedAt: bookingStates[index] === "confirmed" ? now : null,
      },
    });
  }

  return { run, id, reference, guestToken, paymentId, sagaId, supplierId, guestId, guestSessionId, items, totalMinor };
}

/**
 * The saga settles (`fulfilled`): items 1 and 2 are confirmed, the operator
 * rejected item 3, and exactly its allocation was refunded (succeeded).
 */
export async function settleWithOneItemRefunded(o: PlantedOrder): Promise<void> {
  const prisma = await testDb();
  const now = new Date();
  const [first, second, third] = o.items;
  await prisma.supplierBooking.update({ where: { id: second.bookingId }, data: { state: "confirmed", confirmedAt: now } });
  await prisma.supplierBooking.update({ where: { id: third.bookingId }, data: { state: "rejected" } });
  await prisma.orderItem.updateMany({ where: { id: { in: [first.id, second.id] } }, data: { status: "confirmed" } });
  await prisma.orderItem.update({ where: { id: third.id }, data: { status: "rejected" } });
  await prisma.refund.create({
    data: {
      id: uuidv7(),
      paymentId: o.paymentId,
      orderItemId: third.id,
      provider: "fake_aed_card",
      providerRefundId: `zz_e2e_refund_${o.run}`,
      idempotencyKey: `zz-e2e:${o.run}:refund:${third.id}`,
      amountMinor: third.chargedMinor,
      currency: "AED",
      status: "succeeded",
      reason: "supplier_rejected",
    },
  });
  await prisma.payment.update({ where: { id: o.paymentId }, data: { refundedMinor: third.chargedMinor } });
  await prisma.paymentSaga.update({ where: { id: o.sagaId }, data: { state: "fulfilled" } });
}

/** Removes every row `plantMultiItemOrder` and `settleWithOneItemRefunded` wrote (and any the app wrote for that order), child first. */
export async function cleanupPlantedOrder(o: PlantedOrder | null): Promise<void> {
  if (!o) return;
  const prisma = await testDb();
  const itemIds = o.items.map((i) => i.id);
  await prisma.notification.deleteMany({ where: { orderId: o.id } });
  await prisma.cancellationRequest.deleteMany({ where: { orderId: o.id } });
  await prisma.customerRemedy.deleteMany({ where: { orderId: o.id } });
  await prisma.refund.deleteMany({ where: { orderItemId: { in: itemIds } } });
  await prisma.paymentEvent.deleteMany({ where: { providerPaymentId: `zz_e2e_pay_${o.run}` } });
  await prisma.paymentSaga.deleteMany({ where: { orderId: o.id } });
  await prisma.guestCapabilityGrant.deleteMany({ where: { orderId: o.id } });
  await prisma.supplierDocument.deleteMany({ where: { orderId: o.id } });
  await prisma.supplierJob.deleteMany({ where: { supplierBookingId: { in: o.items.map((i) => i.bookingId) } } });
  await prisma.supplierBooking.deleteMany({ where: { supplierId: o.supplierId } });
  await prisma.payment.deleteMany({ where: { orderId: o.id } });
  await prisma.orderItem.deleteMany({ where: { orderId: o.id } });
  await prisma.quote.deleteMany({ where: { usedByOrderId: o.id } });
  await prisma.order.deleteMany({ where: { id: o.id } });
  await prisma.guest.deleteMany({ where: { id: o.guestId } });
  await prisma.productSupplierMapping.deleteMany({ where: { supplierId: o.supplierId } });
  await prisma.guestSession.deleteMany({ where: { id: o.guestSessionId } });
  await prisma.supplier.deleteMany({ where: { id: o.supplierId } });
}
