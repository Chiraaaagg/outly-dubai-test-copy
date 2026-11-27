import { uuidv7 } from "@/server/lib/ids";

/**
 * Shared synthetic rows for the `carry-*` B5 suites (not a test file):
 * a run-scoped supplier, and a confirmed order-item booking written
 * directly, as the document service suite does. Names carry `zz-carry-<run>`.
 */

type Prisma = typeof import("@/server/lib/db").prisma;

export const CARRY_SERVICE_DATE = "2030-03-20";
export const CARRY_OFFER = "779002";

export async function carrySupplier(prisma: Prisma, run: string): Promise<{ id: string; code: string }> {
  const code = `zz-carry-${run}`;
  const s = await prisma.supplier.upsert({
    where: { code },
    create: { id: uuidv7(), code, name: "Carry-over (test)", source: "api", adapter: "traveldesk" },
    update: {},
  });
  return { id: s.id, code };
}

let n = 0;
let seq = 80_000 + Math.floor(Math.random() * 10_000);

/** A confirmed booking for a fresh order and item. */
export async function carryConfirmedBooking(prisma: Prisma, run: string, supplierId: string, opts: { adults?: number } = {}) {
  const tag = `zz-carry-${run}-${++n}`;
  const guest = await prisma.guest.create({ data: { id: uuidv7(), phoneE164: "+910000000000", fullName: "test-carry" } });
  const combo = await prisma.combo.create({ data: { id: uuidv7(), slug: tag, name: "test-carry", confirmation: "manual" } });
  const order = await prisma.order.create({
    data: { id: uuidv7(), reference: `OUT-TEST${Math.floor(Math.random() * 1e9)}`, rail: "assisted", guestId: guest.id, currency: "INR", subtotalInr: 1000n, subtotalAed: 45n, totalInr: 1000n, totalAed: 45n, leadName: "test-carry", leadPhone: "+910000000000" },
  });
  const item = await prisma.orderItem.create({
    data: {
      id: uuidv7(),
      orderId: order.id,
      comboId: combo.id,
      titleSnapshot: "test-carry",
      tierSnapshot: "C",
      slugSnapshot: tag,
      kindSnapshot: "combo",
      confirmationSnapshot: "manual",
      fulfilmentModeSnapshot: "inquiry",
      freeCancellationHoursSnapshot: 24,
      durationMinutesSnapshot: 60,
      serviceDate: new Date(CARRY_SERVICE_DATE),
      pax: { adult: opts.adults ?? 2 },
      unitInr: 1000n,
      unitAed: 45n,
      totalInr: 1000n,
      totalAed: 45n,
    },
  });
  const k = n;
  return prisma.supplierBooking.create({
    data: {
      id: uuidv7(),
      orderId: order.id,
      orderItemId: item.id,
      supplierId,
      environment: "test",
      idempotencyKey: `carry-${run}-${k}`,
      clientRef: `OUTTD-CARRY${run.toUpperCase()}${k}`,
      bookingKind: "live_book",
      afterReserve: "await_payment",
      state: "confirmed",
      tourExternalId: "1",
      offerExternalId: CARRY_OFFER,
      serviceDate: new Date(CARRY_SERVICE_DATE),
      startMinutes: 600,
      adults: opts.adults ?? 2,
      children: 0,
      infants: 0,
      guestName: "test-carry",
      expectedNetMinor: 24000n,
      expectedNetUsdMinor: 6600n,
      supplierBookingId: String(seq++),
      confirmedAt: new Date(),
      closedAt: new Date(),
    },
  });
}

export function carryTicket(i: number, code: string) {
  return { unitIndex: i, ticketFor: "adult" as const, ticketTypeId: null, ticketTypeName: null, displayType: null, code, validUntil: "2030-03-21T00:00:00Z" };
}
