import "server-only";
import type { OrderStatus, Prisma } from "@prisma/client";
import { prisma, TX_OPTIONS, type Tx } from "../lib/db";
import { uuidv7, formatReference } from "../lib/ids";
import type { Actor } from "../lib/actor";
import { requirePermission } from "../lib/actor";
import { audit } from "../lib/audit";
import { AppError, Errors } from "../lib/errors";
import type { FulfilmentOrigin } from "../suppliers/booking-port";
import type { Currency, PaxCount } from "@/lib/types";

/**
 * Order service — DORMANT → ACTIVE on win (§17 §5.1).
 *
 * THE single architectural rule (§09.2, §17 §6.5 item 3): every order — an
 * agent converting a won inquiry today, self-serve checkout for instant SKUs
 * later — is created by `orderService.createOrder(input, actor)`. There is no
 * second path. The input is the `order_items` shape; `inquiry.convertToOrder`
 * builds it by column copy from `inquiry_items`.
 *
 * What is deliberately NOT here yet (all FUTURE per §17 §5.1, all additive):
 *  - gateway payment intents / webhooks (payments are recorded manually)
 *  - supplier fulfilment (SupplierPort → supplier_bookings)
 *  - vouchers, refunds, cancellation engine, coupons, tax lines
 *
 * Provenance (doc 22 PRD-3, PAY-9; B1):
 *  - every item states its `fulfilmentOrigin`. Assisted callers pass
 *    `assisted_conversion`. `instant_checkout` is the only origin that may ever
 *    create a supplier attempt, needs the self-serve rail with gateway
 *    collection, and is refused outright until B2/B3 add the server quote and
 *    the gateway (see `refuseInstantCheckout`);
 *  - manual payments are written as `gateway: "manual"`, `source: "manual"`,
 *    and never count as payment evidence (src/server/payments/evidence.ts).
 *
 * B3: an `instant_checkout` order is created only by the checkout service
 * (src/server/payments/checkout.service.ts) from a server quote, passing
 * `{ instantCheckout: { quoteId } }`. Inside the order's transaction the
 * quote row is locked and must be active, unexpired and in the order's
 * currency, and every item must name it and carry its charged amount and
 * allocations. Each item then charges in one currency only; the other
 * currency's columns are 0 (never a converted figure).
 */

const FULFILMENT_ORIGINS: readonly FulfilmentOrigin[] = ["instant_checkout", "assisted_conversion"];

/** Upper bound for a recorded payment variance reason. */
const VARIANCE_REASON_MAX = 500;

/** Why `createOrder` refused an `instant_checkout` item. */
export type FulfilmentOriginRefusal =
  /** No server quote or gateway exists yet (B2, B3), so no instant checkout order may be created. */
  | "instant_checkout_disabled"
  /** Instant checkout is only the self-serve rail with gateway collection. */
  | "instant_checkout_needs_gateway"
  /** One order cannot mix instant checkout and assisted items. */
  | "mixed_fulfilment_origins";

/** Typed refusal for an order-item provenance the order cannot take (409). */
export class FulfilmentOriginError extends AppError {
  readonly reason: FulfilmentOriginRefusal;

  constructor(reason: FulfilmentOriginRefusal, message: string) {
    super({ status: 409, code: "CONFLICT", message, details: { reason } });
    this.name = "FulfilmentOriginError";
    this.reason = reason;
  }
}

export interface CreateOrderOptions {
  /**
   * Lets a test create an `instant_checkout` order without a quote. Honoured
   * only when NODE_ENV is "test" (never in a Next.js build).
   */
  allowInstantCheckout?: "test-only";
  /** The server quote an instant checkout order is created from (checkout service only); checked in the transaction. */
  instantCheckout?: { quoteId: string };
}

export interface CreateOrderItemInput {
  productId?: string;
  comboId?: string;
  variantCode?: string;
  mappingId?: string;
  titleSnapshot: string;
  tierSnapshot: string;
  slugSnapshot: string;
  kindSnapshot: "activity" | "combo";
  imageSnapshot?: string;
  variantNameSnapshot?: string;
  inclusionsSnapshot?: string[];
  cancellationPolicySnapshot?: Record<string, unknown>;
  confirmationSnapshot: "instant" | "manual";
  fulfilmentModeSnapshot: "inquiry" | "instant";
  freeCancellationHoursSnapshot: number;
  durationMinutesSnapshot: number;
  serviceDate: string; // YYYY-MM-DD (Asia/Dubai local date)
  timeslot?: string;
  pax: PaxCount;
  addons: string[];
  unitInr: bigint;
  unitAed: bigint;
  totalInr: bigint;
  totalAed: bigint;
  netCostAed?: bigint;
  /** How this item came to exist (PRD-3). Required; assisted callers pass `assisted_conversion`. */
  fulfilmentOrigin: FulfilmentOrigin;
  /** B2/B3 quote snapshot: the charged currency and gross amount, its discount and tax shares (minor units). */
  chargedCurrency?: Currency;
  chargedAmountMinor?: bigint;
  discountAllocMinor?: bigint;
  taxAllocMinor?: bigint;
  quoteId?: string;
  /** MarginSnapshot with bigint values as strings. */
  marginSnapshot?: Record<string, unknown>;
  /** Instant items: the index of the quote line this item was sold from (its position in the order). */
  quoteLineIndex?: number;
  /** Batch 3: the TravelDesk hotel id the quote accepted for pickup, and its name on the supplier's list then. */
  pickupHotelId?: string | null;
  pickupHotelNameSnapshot?: string | null;
}

export interface CreateOrderInput {
  rail: "self_serve" | "assisted";
  currency: Currency;
  paymentCollection: "gateway" | "manual_link" | "bank_transfer";
  sourceInquiryId?: string;
  idempotencyKey?: string;
  traveller: {
    fullName: string;
    phoneE164: string;
    email?: string;
    hotel?: string;
    pickupZone?: string;
    dietary?: string;
    specialRequests?: string;
  };
  items: CreateOrderItemInput[];
  attribution?: {
    firstSource?: string; firstMedium?: string; firstCampaign?: string; firstTouchAt?: Date;
    lastSource?: string; lastMedium?: string; lastCampaign?: string; lastTouchAt?: Date;
    fbclid?: string; fbc?: string; fbp?: string; gclid?: string; waConversationId?: string;
  };
  /** Initial status. Agent conversion after a paid link → `paid`; gateway flow → `pending_payment`. */
  initialStatus?: "pending_payment" | "paid";
  paidAt?: Date;
  /** The signed-in customer who owns the order (instant checkout by a customer). */
  customerId?: string;
}

export interface CreateOrderResult {
  id: string;
  reference: string;
  status: string;
  totalInr: bigint;
  totalAed: bigint;
}

/**
 * Provenance rules for the items of one order. Runs before the idempotency
 * replay, so a replayed key cannot carry a refused origin through.
 */
function checkFulfilmentOrigins(input: CreateOrderInput, opts: CreateOrderOptions): void {
  if (input.items.some((i) => !FULFILMENT_ORIGINS.includes(i.fulfilmentOrigin))) {
    throw Errors.validation({ items: "Every item needs a fulfilment origin" });
  }
  const instant = input.items.filter((i) => i.fulfilmentOrigin === "instant_checkout").length;
  if (!instant) return;
  if (instant !== input.items.length) {
    throw new FulfilmentOriginError("mixed_fulfilment_origins", "An order cannot mix instant checkout and assisted items");
  }
  if (input.rail !== "self_serve" || input.paymentCollection !== "gateway") {
    throw new FulfilmentOriginError("instant_checkout_needs_gateway", "Instant checkout needs the self-serve rail with gateway payment");
  }
  refuseInstantCheckout(input, opts);
}

/**
 * Instant checkout needs a server quote and the gateway saga: only the
 * checkout service creates such an order, naming its quote (checked again in
 * the transaction by `checkQuoteBinding`). Anything else is refused, except
 * a test process that asks for it explicitly.
 */
function refuseInstantCheckout(input: CreateOrderInput, opts: CreateOrderOptions): void {
  const quoteId = opts.instantCheckout?.quoteId;
  if (!quoteId && opts.allowInstantCheckout === "test-only" && process.env.NODE_ENV === "test") return;
  if (quoteId) {
    const bound = input.items.every(
      (i) => i.quoteId === quoteId && i.chargedCurrency === input.currency && i.chargedAmountMinor !== undefined && i.chargedAmountMinor > 0n && i.discountAllocMinor !== undefined && i.taxAllocMinor !== undefined,
    );
    if (bound) return;
    throw Errors.validation({ items: "Every instant item names the quote and carries its charged amount and allocations" });
  }
  throw new FulfilmentOriginError("instant_checkout_disabled", "Instant checkout needs a server quote");
}

/** Lock the quote and check it can still become this order (instant checkout only). */
async function checkQuoteBinding(t: Tx, input: CreateOrderInput, quoteId: string): Promise<void> {
  const rows = await t.$queryRaw<{ status: string; currency: string; expires_at: Date; total_minor: bigint; now: Date }[]>`
    SELECT status, currency::text AS currency, expires_at, total_minor, now() AS now FROM quotes WHERE id = ${quoteId}::uuid FOR UPDATE`;
  const q = rows[0];
  if (!q || q.status !== "active" || q.expires_at.getTime() <= q.now.getTime()) throw Errors.conflict("The quote is no longer active", { reason: "quote_not_active" });
  if (q.currency !== input.currency) throw Errors.conflict("The order currency differs from the quote", { reason: "quote_currency_mismatch" });
  const payable = input.items.reduce((s, i) => s + (i.chargedAmountMinor ?? 0n) - (i.discountAllocMinor ?? 0n) + (i.taxAllocMinor ?? 0n), 0n);
  if (payable !== q.total_minor) throw Errors.conflict("The order total differs from the quote", { reason: "quote_total_mismatch" });
}

/** What one item is charged in its own currency after its discount and tax shares; null when it carries no allocation. */
export function itemPayableMinor(i: { chargedAmountMinor: bigint | null; discountAllocMinor: bigint | null; taxAllocMinor: bigint | null }): bigint | null {
  if (i.chargedAmountMinor === null) return null;
  return i.chargedAmountMinor - (i.discountAllocMinor ?? 0n) + (i.taxAllocMinor ?? 0n);
}

/** The amount the order charges: the total in the order's own currency (the other column is display only). */
export function chargedTotal(order: { currency: Currency; totalInr: bigint; totalAed: bigint }): bigint {
  return order.currency === "AED" ? order.totalAed : order.totalInr;
}

async function nextOrderReference(tx: Tx): Promise<string> {
  const rows = await tx.$queryRaw<{ n: bigint }[]>`SELECT nextval('order_ref_seq') AS n`;
  return formatReference("OUT", rows[0].n);
}

export const orderService = {
  async createOrder(input: CreateOrderInput, actor: Actor, tx?: Tx, opts: CreateOrderOptions = {}): Promise<CreateOrderResult> {
    requirePermission(actor, "orders.create");
    if (!input.items.length) throw Errors.validation({ items: "An order needs at least one item" });
    checkFulfilmentOrigins(input, opts);
    // Minor units are BigInt and never negative; the database checks agree, but
    // a caller gets a validation error here rather than a constraint failure.
    if (input.items.some((i) => i.unitInr < 0n || i.unitAed < 0n || i.totalInr < 0n || i.totalAed < 0n || (i.netCostAed ?? 0n) < 0n)) {
      throw Errors.validation({ items: "Amounts cannot be negative" });
    }

    if (input.idempotencyKey) {
      // Read through the caller's transaction when there is one: inside
      // inquiry.convertToOrder the global client would wait for a second pool
      // connection while the transaction holds the first (P2024 at connection_limit=1).
      const existing = await (tx ?? prisma).order.findFirst({ where: { idempotencyKey: input.idempotencyKey } });
      if (existing) return { id: existing.id, reference: existing.reference, status: existing.status, totalInr: existing.totalInr, totalAed: existing.totalAed };
    }

    const subtotalInr = input.items.reduce((s, i) => s + i.totalInr, 0n);
    const subtotalAed = input.items.reduce((s, i) => s + i.totalAed, 0n);
    const netCostAed = input.items.reduce((s, i) => s + (i.netCostAed ?? 0n), 0n);
    // Order-level discount and tax are the sums of the items' shares, in each item's charged currency.
    const shareOf = (c: Currency, f: "discountAllocMinor" | "taxAllocMinor") => input.items.reduce((s, i) => s + (i.chargedCurrency === c ? (i[f] ?? 0n) : 0n), 0n);
    const discountInr = shareOf("INR", "discountAllocMinor");
    const discountAed = shareOf("AED", "discountAllocMinor");
    const taxInr = shareOf("INR", "taxAllocMinor");
    const taxAed = shareOf("AED", "taxAllocMinor");

    const run = async (t: Tx): Promise<CreateOrderResult> => {
      if (opts.instantCheckout) await checkQuoteBinding(t, input, opts.instantCheckout.quoteId);
      const guest = await t.guest.create({
        data: { id: uuidv7(), phoneE164: input.traveller.phoneE164, email: input.traveller.email?.toLowerCase(), fullName: input.traveller.fullName },
      });
      const id = uuidv7();
      const reference = await nextOrderReference(t);
      const status = input.initialStatus ?? "pending_payment";
      const order = await t.order.create({
        data: {
          id,
          reference,
          status,
          rail: input.rail,
          guestId: guest.id,
          createdByAgent: actor.type === "agent" || actor.type === "admin" ? actor.id : undefined,
          sourceInquiryId: input.sourceInquiryId,
          paymentCollection: input.paymentCollection,
          currency: input.currency,
          subtotalInr,
          subtotalAed,
          discountInr,
          discountAed,
          taxInr,
          taxAed,
          totalInr: subtotalInr - discountInr + taxInr,
          totalAed: subtotalAed - discountAed + taxAed,
          netCostAed,
          customerId: input.customerId,
          leadName: input.traveller.fullName,
          leadEmail: input.traveller.email?.toLowerCase(),
          leadPhone: input.traveller.phoneE164,
          hotel: input.traveller.hotel,
          pickupZone: input.traveller.pickupZone,
          dietary: input.traveller.dietary,
          specialRequests: input.traveller.specialRequests,
          idempotencyKey: input.idempotencyKey,
          paidAt: status === "paid" ? (input.paidAt ?? new Date()) : undefined,
          items: {
            create: input.items.map((i, idx) => ({
              id: uuidv7(),
              productId: i.productId,
              comboId: i.comboId,
              variantCode: i.variantCode,
              mappingId: i.mappingId,
              titleSnapshot: i.titleSnapshot,
              tierSnapshot: i.tierSnapshot,
              slugSnapshot: i.slugSnapshot,
              kindSnapshot: i.kindSnapshot,
              imageSnapshot: i.imageSnapshot,
              variantNameSnapshot: i.variantNameSnapshot,
              inclusionsSnapshot: i.inclusionsSnapshot ?? [],
              cancellationPolicySnapshot: (i.cancellationPolicySnapshot ?? {}) as Prisma.InputJsonValue,
              confirmationSnapshot: i.confirmationSnapshot,
              fulfilmentModeSnapshot: i.fulfilmentModeSnapshot,
              freeCancellationHoursSnapshot: i.freeCancellationHoursSnapshot,
              durationMinutesSnapshot: i.durationMinutesSnapshot,
              serviceDate: new Date(`${i.serviceDate}T00:00:00Z`),
              timeslot: i.timeslot,
              pax: i.pax as unknown as Prisma.InputJsonValue,
              addons: i.addons as unknown as Prisma.InputJsonValue,
              unitInr: i.unitInr,
              unitAed: i.unitAed,
              totalInr: i.totalInr,
              totalAed: i.totalAed,
              netCostAed: i.netCostAed ?? 0n,
              fulfilmentOrigin: i.fulfilmentOrigin,
              chargedCurrency: i.chargedCurrency,
              chargedAmountMinor: i.chargedAmountMinor,
              discountAllocMinor: i.discountAllocMinor,
              taxAllocMinor: i.taxAllocMinor,
              quoteId: i.quoteId,
              marginSnapshot: i.marginSnapshot as Prisma.InputJsonValue | undefined,
              quoteLineIndex: i.quoteLineIndex,
              pickupHotelId: i.pickupHotelId ?? undefined,
              pickupHotelNameSnapshot: i.pickupHotelNameSnapshot ?? undefined,
              status: idx >= 0 ? "pending" : "pending",
            })),
          },
          attribution: input.attribution
            ? { create: { ...input.attribution } }
            : undefined,
        },
      });
      await audit(actor, "order.create", { type: "order", id }, { after: { reference, rail: input.rail, status, totalInr: subtotalInr.toString(), sourceInquiryId: input.sourceInquiryId } }, t);
      return { id: order.id, reference, status, totalInr: order.totalInr, totalAed: order.totalAed };
    };

    return tx ? run(tx) : prisma.$transaction(run, TX_OPTIONS);
  },

  /**
   * Manual payment recording (§17 §5.1 "payments rows created manually by the
   * agent for reconciliation"). PAY-9: the row is `gateway: "manual"`,
   * `source: "manual"`, so it can never pass for gateway evidence or collide
   * with a real gateway row under `payments_gateway_payment_idx`. A gateway
   * (B3) writes its own `gateway_verified` rows; it does not come through here.
   *
   * The amount and currency must equal the order's charged total, unless the
   * caller gives a `varianceReason`, which the audit row keeps as its reason
   * next to the expected figures. Orders with an `instant_checkout` item are refused: they
   * are paid through the gateway only. Rows recorded before B1 are untouched.
   */
  async recordManualPayment(
    actor: Actor,
    orderId: string,
    input: { amountMinor: bigint; currency: Currency; method?: string; paymentLinkId?: string; paymentLinkUrl?: string; gatewayPaymentId?: string; capturedAt?: Date; varianceReason?: string },
    tx?: Tx,
  ) {
    requirePermission(actor, "payments.record");
    if (input.amountMinor < 0n) throw Errors.validation({ amount: "Cannot be negative" });
    const varianceReason = input.varianceReason?.trim() || undefined;
    if (varianceReason && varianceReason.length > VARIANCE_REASON_MAX) {
      throw Errors.validation({ varianceReason: `Keep it under ${VARIANCE_REASON_MAX} characters` });
    }
    const run = async (t: Tx) => {
      const order = await t.order.findUnique({
        where: { id: orderId },
        select: { id: true, currency: true, totalInr: true, totalAed: true, items: { select: { fulfilmentOrigin: true } } },
      });
      if (!order) throw Errors.notFound("Order");
      if (order.items.some((i) => i.fulfilmentOrigin === "instant_checkout")) {
        throw Errors.conflict("Instant checkout orders are paid through the gateway only", { reason: "instant_checkout_order" });
      }
      const expectedMinor = chargedTotal(order);
      const matches = input.currency === order.currency && input.amountMinor === expectedMinor;
      if (!matches && !varianceReason) {
        throw Errors.validation(
          { amount: `Must be the order total (${expectedMinor} ${order.currency} in minor units), or give a variance reason` },
          "The payment does not match the order total",
        );
      }
      const payment = await t.payment.create({
        data: {
          id: uuidv7(),
          orderId,
          gateway: "manual",
          source: "manual",
          gatewayPaymentId: input.gatewayPaymentId,
          paymentLinkId: input.paymentLinkId,
          paymentLinkUrl: input.paymentLinkUrl,
          method: input.method,
          amountMinor: input.amountMinor,
          currency: input.currency,
          status: "captured",
          recordedBy: actor.id,
          capturedAt: input.capturedAt ?? new Date(),
        },
      });
      await t.order.update({ where: { id: orderId }, data: { status: "paid", paidAt: input.capturedAt ?? new Date() } });
      await audit(
        actor,
        "payment.record_manual",
        { type: "order", id: orderId },
        {
          after: {
            paymentId: payment.id,
            amountMinor: input.amountMinor.toString(),
            currency: input.currency,
            ...(matches ? {} : { expectedMinor: expectedMinor.toString(), expectedCurrency: order.currency }),
          },
          reason: matches ? undefined : varianceReason,
        },
        t,
      );
      return payment;
    };
    return tx ? run(tx) : prisma.$transaction(run, TX_OPTIONS);
  },

  /**
   * The payment saga's view of an instant order (src/server/payments/saga.ts),
   * written in the saga's transaction. Moves only forward from the states
   * listed for each outcome, so a late or repeated call changes nothing.
   * Never touches supplier attempts.
   *
   * `partially_confirmed` (multi-item): some items confirmed, the others
   * already marked `rejected` by `markItemRejected` and refunded; the pending
   * ones become `confirmed`.
   */
  async applyPaymentOutcome(tx: Tx, orderId: string, outcome: "paid" | "confirmed" | "partially_confirmed" | "payment_failed" | "refunded", at: Date): Promise<boolean> {
    const from: Record<typeof outcome, OrderStatus[]> = {
      paid: ["pending_payment"],
      confirmed: ["pending_payment", "paid", "supplier_pending"],
      partially_confirmed: ["pending_payment", "paid", "supplier_pending"],
      payment_failed: ["pending_payment"],
      refunded: ["pending_payment", "paid", "supplier_pending", "payment_failed"],
    };
    const data: Prisma.OrderUpdateManyMutationInput =
      outcome === "paid"
        ? { status: "paid", paidAt: at }
        : outcome === "confirmed"
          ? { status: "confirmed", confirmedAt: at }
          : outcome === "partially_confirmed"
            ? { status: "partially_confirmed", confirmedAt: at }
            : outcome === "refunded"
              ? { status: "refunded", cancelledAt: at }
              : { status: "payment_failed" };
    const r = await tx.order.updateMany({ where: { id: orderId, status: { in: from[outcome] } }, data });
    if ((outcome === "confirmed" || outcome === "partially_confirmed") && r.count) await tx.orderItem.updateMany({ where: { orderId, status: "pending" }, data: { status: "confirmed" } });
    if (outcome === "refunded" && r.count) await tx.orderItem.updateMany({ where: { orderId, status: "pending" }, data: { status: "rejected" } });
    return r.count === 1;
  },

  /**
   * Multi-item saga (payments/saga.ts): one item of an instant order will not
   * be supplied (its reserve or confirm failed) and is refunded on its own.
   * Moves only a `pending` item; never touches supplier attempts.
   */
  async markItemRejected(tx: Tx, orderItemId: string): Promise<boolean> {
    const r = await tx.orderItem.updateMany({ where: { id: orderItemId, status: "pending" }, data: { status: "rejected" } });
    return r.count === 1;
  },

  async getByReference(actor: Actor, reference: string) {
    requirePermission(actor, "orders.view_all");
    const o = await prisma.order.findUnique({ where: { reference }, include: { items: true, payments: true, attribution: true, fromInquiry: { select: { reference: true, id: true } } } });
    if (!o) throw Errors.notFound("Order");
    return o;
  },
};
