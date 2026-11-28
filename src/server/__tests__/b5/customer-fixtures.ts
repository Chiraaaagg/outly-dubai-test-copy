import { createHash, randomBytes } from "node:crypto";
import { uuidv7, formatReference } from "../../lib/ids";
import type { SeedProduct } from "../security/_mercury-fixtures";

/**
 * Fixtures for the B5 customer suites (customer-*.test.ts). Not a test file.
 *
 * Every row is synthetic and tagged with the run id: orders carry
 * `lead_name = "zz-sec-<run> …"` (so `cleanupBusinessRows` finds them), the
 * supplier is `zz-b5c-<run>`, amounts are synthetic and no supplier net or
 * margin is meaningful. `cleanupCustomerRows` removes, child first, every row
 * these helpers write. Callers must run `assertDisposableDb()` first.
 */

type Prisma = typeof import("../../lib/db").prisma;

export const sha = (s: string) => createHash("sha256").update(s).digest("hex");

export interface InstantOrderOptions {
  label: string;
  /** Who made the quote: a customer (owner of the order) or a guest session. */
  owner: { kind: "customer"; customerId: string } | { kind: "guest"; guestSessionId: string };
  sagaState?: string;
  sagaDeadline?: Date | null;
  /** Captured amount on the payment (0 = an authorisation or nothing). */
  capturedMinor?: bigint;
  bookingState?: string | null;
  serviceDate?: string;
  startMinutes?: number | null;
  freeCancellationUntilUtc?: string | null;
  nonRefundableAfterConfirm?: boolean;
  issuesTicketsAtConfirm?: "yes" | "no" | null;
  /** Verified contact bound to the order (recovery). */
  verified?: { channel: "phone" | "email"; contact: string };
  orderStatus?: "pending_payment" | "paid" | "confirmed";
}

export interface InstantOrder {
  id: string;
  reference: string;
  itemId: string;
  quoteId: string;
  paymentId: string;
  sagaId: string;
  bookingId: string | null;
  mappingId: string;
  gatewayPaymentId: string;
}

export interface CustomerFixtures {
  supplierId: string;
  product: SeedProduct;
  orders: InstantOrder[];
  guestSessions: string[];
  guests: string[];
}

export async function setupCustomerFixtures(prisma: Prisma, run: string, product: SeedProduct): Promise<CustomerFixtures> {
  const supplierId = uuidv7();
  await prisma.supplier.create({ data: { id: supplierId, code: `zz-b5c-${run}`, name: "zz b5 customer fixture", source: "api", adapter: "traveldesk" } });
  return { supplierId, product, orders: [], guestSessions: [], guests: [] };
}

/** A live guest session row and its cookie token (as guest-session.service.ts mints them). */
export async function guestSession(prisma: Prisma, fx: CustomerFixtures, opts: { expired?: boolean } = {}) {
  const token = randomBytes(32).toString("base64url");
  const id = uuidv7();
  const now = Date.now();
  await prisma.guestSession.create({
    data: { id, tokenHash: sha(token), createdAt: new Date(now - 3600_000), expiresAt: new Date(opts.expired ? now - 1000 : now + 3600_000) },
  });
  fx.guestSessions.push(id);
  return { id, token, cookie: `outlyy_guest_session=${token}` };
}

/**
 * A self-serve instant order with its quote, payment, saga and (optionally)
 * a supplier attempt and a bound verified contact, written straight to the
 * database so each suite says exactly what state it is in.
 */
export async function instantOrder(prisma: Prisma, run: string, fx: CustomerFixtures, o: InstantOrderOptions): Promise<InstantOrder> {
  const [{ n }] = await prisma.$queryRaw<{ n: bigint }[]>`SELECT nextval('order_ref_seq') AS n`;
  const id = uuidv7();
  const reference = formatReference("OUT", n);
  const itemId = uuidv7();
  const quoteId = uuidv7();
  const paymentId = uuidv7();
  const sagaId = uuidv7();
  const mappingId = uuidv7();
  const serviceDate = o.serviceDate ?? "2030-01-15";
  const captured = o.capturedMinor ?? 0n;
  const gatewayPaymentId = `zz_pay_${run}_${o.label}_${randomBytes(3).toString("hex")}`;
  const now = new Date();

  await prisma.productSupplierMapping.create({
    data: {
      id: mappingId,
      productId: fx.product.id,
      supplierId: fx.supplierId,
      variantCode: `zz-${run}-${o.label}-${randomBytes(3).toString("hex")}`,
      externalRef: {
        tourId: 1,
        offerId: 2,
        bookingKind: "live_book",
        isExternal: false,
        ...(o.issuesTicketsAtConfirm ? { ticketEvidence: { issuesTicketsAtConfirm: o.issuesTicketsAtConfirm, source: "zz test fixture", recordedAt: now.toISOString() } } : {}),
      },
      isActive: false,
    },
  });
  const guestId = uuidv7();
  await prisma.guest.create({ data: { id: guestId, phoneE164: o.verified?.channel === "phone" ? o.verified.contact : "+971500000000", fullName: `zz-sec-${run} ${o.label}` } });
  fx.guests.push(guestId);
  await prisma.order.create({
    data: {
      id,
      reference,
      guestId,
      status: o.orderStatus ?? (captured > 0n ? "paid" : "pending_payment"),
      rail: "self_serve",
      paymentCollection: "gateway",
      currency: "AED",
      subtotalInr: 0n,
      subtotalAed: 45_000n,
      totalInr: 0n,
      totalAed: 45_000n,
      netCostAed: 30_000n,
      leadName: `zz-sec-${run} ${o.label}`,
      leadPhone: o.verified?.channel === "phone" ? o.verified.contact : "",
      leadEmail: o.verified?.channel === "email" ? o.verified.contact : `zz-sec-${run}-${o.label}@outlyy.test`,
      customerId: o.owner.kind === "customer" ? o.owner.customerId : null,
      paidAt: captured > 0n ? now : null,
    },
  });
  await prisma.quote.create({
    data: {
      id: quoteId,
      fingerprint: sha(`zz-b5c:${run}:${quoteId}`),
      ownerKind: o.owner.kind,
      customerId: o.owner.kind === "customer" ? o.owner.customerId : null,
      guestSessionId: o.owner.kind === "guest" ? o.owner.guestSessionId : null,
      currency: "AED",
      totalMinor: 45_000n,
      lines: [
        {
          index: 0,
          productId: fx.product.id,
          mappingId,
          serviceDate,
          slotRef: null,
          chargedMinor: "45000",
          discountAllocMinor: "0",
          taxAllocMinor: "0",
          freeCancellationUntilUtc: o.freeCancellationUntilUtc === undefined ? "2030-01-14T06:00:00.000Z" : o.freeCancellationUntilUtc,
          nonRefundableAfterConfirm: o.nonRefundableAfterConfirm ?? false,
        },
      ],
      request: { lines: [] },
      status: "used",
      usedByOrderId: id,
      createdAt: new Date(now.getTime() - 3600_000),
      expiresAt: new Date(now.getTime() + 600_000),
    },
  });
  await prisma.orderItem.create({
    data: {
      id: itemId,
      orderId: id,
      productId: fx.product.id,
      mappingId,
      titleSnapshot: `zz-sec-${run} instant ${o.label}`,
      tierSnapshot: fx.product.tier,
      slugSnapshot: fx.product.slug,
      kindSnapshot: "activity",
      confirmationSnapshot: "instant",
      fulfilmentModeSnapshot: "instant",
      freeCancellationHoursSnapshot: 24,
      durationMinutesSnapshot: 120,
      serviceDate: new Date(`${serviceDate}T00:00:00.000Z`),
      pax: { adult: 2 },
      unitInr: 0n,
      unitAed: 45_000n,
      totalInr: 0n,
      totalAed: 45_000n,
      netCostAed: 30_000n,
      fulfilmentOrigin: "instant_checkout",
      chargedCurrency: "AED",
      chargedAmountMinor: 45_000n,
      discountAllocMinor: 0n,
      taxAllocMinor: 0n,
      quoteId,
      marginSnapshot: { policyVersion: 1, floorBps: 1500, grossMarginBps: 3000, costLines: [] },
    },
  });
  await prisma.payment.create({
    data: {
      id: paymentId,
      orderId: id,
      gateway: "fake_aed_card",
      source: "gateway_verified",
      rail: "aed_card",
      provider: "fake_aed_card",
      providerAccountId: "zz-acct",
      environment: "test",
      idempotencyKey: `pay:${id}:1`,
      gatewayPaymentId,
      method: "card",
      amountMinor: 45_000n,
      currency: "AED",
      status: captured > 0n ? "captured" : "authorized",
      capturedMinor: captured,
      authorizedAt: now,
      capturedAt: captured > 0n ? now : null,
      quoteId,
    },
  });
  await prisma.paymentSaga.create({
    data: { id: sagaId, orderId: id, orderItemId: itemId, paymentId, rail: "aed_card", state: o.sagaState ?? "session_created", deadlineAt: o.sagaDeadline === undefined ? null : o.sagaDeadline },
  });
  let bookingId: string | null = null;
  if (o.bookingState) {
    bookingId = uuidv7();
    await prisma.supplierBooking.create({
      data: {
        id: bookingId,
        orderId: id,
        orderItemId: itemId,
        supplierId: fx.supplierId,
        mappingId,
        environment: "test",
        idempotencyKey: `zz-b5c:${run}:${itemId}:1`,
        clientRef: `ZZC${bookingId.replace(/-/g, "").slice(-12)}`,
        bookingKind: "live_book",
        afterReserve: "await_payment",
        tourExternalId: "1",
        offerExternalId: "2",
        serviceDate: new Date(`${serviceDate}T00:00:00.000Z`),
        startMinutes: o.startMinutes === undefined ? 600 : o.startMinutes,
        adults: 2,
        guestName: `zz-sec-${run} guest`,
        expectedNetMinor: 30_000n,
        expectedNetUsdMinor: 8_000n,
        supplierBookingId: String(900_000 + Math.floor(Math.random() * 99_999)),
        state: o.bookingState as never,
        confirmedAt: ["confirmed", "cancelling", "cancelled", "cancel_refused", "cancel_unverified"].includes(o.bookingState) ? now : null,
      },
    });
  }
  if (o.verified) {
    await prisma.orderContactVerification.create({
      data: {
        id: uuidv7(),
        quoteId,
        orderId: id,
        channel: o.verified.channel,
        contactHash: sha(o.verified.contact),
        method: o.verified.channel === "phone" ? "otp_sms" : "email_code",
        verifiedAt: now,
      },
    });
  }
  const order = { id, reference, itemId, quoteId, paymentId, sagaId, bookingId, mappingId, gatewayPaymentId };
  fx.orders.push(order);
  return order;
}

/** Removes every row the helpers above (and the flows under test) wrote, child first. */
export async function cleanupCustomerRows(prisma: Prisma, fx: CustomerFixtures | undefined): Promise<void> {
  if (!fx) return;
  const orderIds = fx.orders.map((o) => o.id);
  const itemIds = fx.orders.map((o) => o.itemId);
  const bookingIds = (await prisma.supplierBooking.findMany({ where: { supplierId: fx.supplierId }, select: { id: true } })).map((b) => b.id);
  await prisma.notification.deleteMany({ where: { orderId: { in: orderIds } } });
  await prisma.cancellationRequest.deleteMany({ where: { orderId: { in: orderIds } } });
  await prisma.customerRemedy.deleteMany({ where: { orderId: { in: orderIds } } });
  await prisma.refund.deleteMany({ where: { orderItemId: { in: itemIds } } });
  await prisma.paymentEvent.deleteMany({ where: { providerPaymentId: { in: fx.orders.map((o) => o.gatewayPaymentId) } } });
  await prisma.paymentSaga.deleteMany({ where: { orderId: { in: orderIds } } });
  await prisma.guestCapabilityGrant.deleteMany({ where: { orderId: { in: orderIds } } });
  await prisma.supplierDocument.deleteMany({ where: { orderId: { in: orderIds } } });
  await prisma.supplierJob.deleteMany({ where: { supplierBookingId: { in: bookingIds } } });
  await prisma.supplierBooking.deleteMany({ where: { id: { in: bookingIds } } });
  await prisma.otpChallenge.deleteMany({ where: { OR: orderIds.map((id) => ({ phoneE164: { startsWith: `rcv:v1:${id}:` } })) } });
  await prisma.orderContactVerification.deleteMany({ where: { orderId: { in: orderIds } } });
  await prisma.payment.deleteMany({ where: { orderId: { in: orderIds } } });
  await prisma.orderItem.deleteMany({ where: { orderId: { in: orderIds } } });
  await prisma.quote.deleteMany({ where: { usedByOrderId: { in: orderIds } } });
  await prisma.order.deleteMany({ where: { id: { in: orderIds } } });
  await prisma.guest.deleteMany({ where: { id: { in: fx.guests } } });
  await prisma.productSupplierMapping.deleteMany({ where: { supplierId: fx.supplierId } });
  await prisma.guestSession.deleteMany({ where: { id: { in: fx.guestSessions } } });
  await prisma.supplier.deleteMany({ where: { id: fx.supplierId } });
}

/** Keys that must never appear in a customer response, walked through the whole body. */
export const FORBIDDEN_KEY = /^(net.*|.*NetMinor|.*netCost.*|margin.*|supplierBookingId|supplierId|supplierName|storageKey|sha256|code|ticketCode.*|codes|gateway.*|providerPaymentId|providerRefundId|providerOrderId|orderId|errorCode|reasonCode|leadPhone|leadEmail|token)$/i;

export function forbiddenKeys(value: unknown, path = "$"): string[] {
  if (Array.isArray(value)) return value.flatMap((v, i) => forbiddenKeys(v, `${path}[${i}]`));
  if (value && typeof value === "object") {
    return Object.entries(value).flatMap(([k, v]) => [...(FORBIDDEN_KEY.test(k) ? [`${path}.${k}`] : []), ...forbiddenKeys(v, `${path}.${k}`)]);
  }
  return [];
}
