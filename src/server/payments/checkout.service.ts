import "server-only";
import { z } from "zod";
import { prisma, TX_OPTIONS } from "../lib/db";
import { env } from "../lib/env";
import { isAppError } from "../lib/errors";
import { uuidv7 } from "../lib/ids";
import { log } from "../lib/logger";
import { SYSTEM_ACTOR } from "../lib/actor";
import { orderService, type CreateOrderItemInput } from "../services/order.service";
import { contactHash, contactVerificationService, normaliseContact } from "../services/contact-verification.service";
import { readinessService } from "../services/readiness.service";
import { bookingAccountId, bookingControl } from "../services/supplier-booking.service";
import { MAX_INSTANT_ITEMS_PER_ORDER, QUOTE_TTL_MS, repeatsInstantLine, type ReadinessService } from "../quotes/contracts";
import type { Currency, PaxCount } from "@/lib/types";
import type { CheckoutService, PaymentRail } from "./contracts";
import { UnsupportedMethodError } from "./fake-gateways";
import { instantOrderCapVerdict, readCurrentInrPerAed, readExposureLimits, type ExposureLimits } from "./exposure-limits";
import { paymentGateways, railForCurrency, type GatewayRegistry } from "./registry";
import { StripeUnsupportedMethodError } from "./stripe/stripe-gateway";

/**
 * Instant checkout (doc 22 §23 B3; PAY-5, PAY-6, PAY-7, F21, F29, F52, F57).
 * Called by `POST /api/checkout` (Juniper) as `checkoutService.start`.
 *
 * Every gate runs before an order row or a gateway session exists, in this
 * order, and a refusal names its reason:
 *  1. `release_switch_off` — INSTANT_RELEASE_ENABLED is not "true";
 *  2. the quote: `quote_not_found` (unknown, or another owner's: the same
 *     answer), `quote_not_active`, `quote_expired`, and one to
 *     `MAX_INSTANT_ITEMS_PER_ORDER` lines with no two sharing `instantLineKey`
 *     (product, variant, date and slot) (`too_many_items`; multi-item, lead-approved 3 Nov 2026:
 *     the quote service already sends such a cart to inquiry);
 *  3. the rail for the quote's currency has a gateway (`payments_not_configured`)
 *     that offers the method (`method_not_supported`);
 *  3a. the per-order instant cap (doc 22 §32.24, owner: 500 AED per order):
 *     the quote total, the whole order, against
 *     `payments.exposure_limits.maxInstantOrderAedMinor`, by the quote
 *     service's own rule (`instantOrderCapVerdict`; INR converted with the
 *     current FX row, rounded up). Over the cap: `order_over_limit`; no
 *     usable FX row for an INR order: `fx_input_missing`; no cap set:
 *     `exposure_cap`. All fold into the public `requires_inquiry`; the quote
 *     service refuses such a cart before checkout in the first place;
 *  4. readiness is still effectively instant for every line (`requires_inquiry`);
 *  5. the supplier account's control allows new sales for every line
 *     (`sales_paused`; any pause scope counts, and a missing production row
 *     is a pause);
 *  6. queue admission: queued confirms and cancels on that account would
 *     still fit before their deadlines with as many more bookings as the
 *     quote has lines (`queue_busy`);
 *  7. exposure (`exposure_cap`): uncaptured holds on the rail, a burst of
 *     failed or risky payments, and Outly-funded remedies in the window, all
 *     under `payments.exposure_limits` (exposure-limits.ts; owner policy,
 *     question 8);
 *  8. the order-bound contact verification (TKT-4): it must exist and belong
 *     to this quote, whose owner was checked in 2 (`verification_required`);
 *     be bound to no order yet (`verification_already_bound`); be younger
 *     than `VERIFICATION_MAX_AGE_MS` (`verification_expired`); and its
 *     `contact_hash` must equal the hash of the traveller's contact on the
 *     verified channel, normalised the same way (E.164 phone, lower-case
 *     email): `verified_contact_missing` when the traveller gives none on
 *     that channel, `verified_contact_mismatch` when it differs. The order
 *     stores that normalised contact as its recovery contact
 *     (`lead_phone` or `lead_email`), and the verification is bound to it.
 *
 * Then, in one transaction: the order (one `instant_checkout` item per quote
 * line, in line order, each with its line index, charged amount,
 * allocations, margin snapshot and policy; the items' payable amounts sum to
 * the quote total exactly), the quote marked used by it, the verification
 * bound to it, the payment row for the quote total (`gateway_verified`,
 * `created`, idempotency key `pay:<order>:1`) and the saga
 * (`session_created`, deadline = quote expiry, naming the first item). Only after the commit is
 * the gateway asked for a session under that key; its hosted page URL is kept
 * on the payment row, and the saga's deadline becomes the earlier of the quote
 * and session expiries (F46). A quote with less than `MIN_PAYMENT_WINDOW_MS`
 * left is refused (`quote_expired`): the customer could not pay in time.
 *
 * Idempotent per quote: a repeat for a used quote by the same owner returns
 * the same order and page while the quote lives and the saga still waits for
 * payment; a stale link is never handed out again (`quote_expired`). When no
 * session was stored yet (the gateway call failed or the process died), the
 * gates run again before the session is requested again with the same key.
 */

export type CheckoutRefusal =
  | "invalid_request"
  | "release_switch_off"
  | "quote_not_found"
  | "quote_not_active"
  | "quote_expired"
  | "too_many_items"
  | "payments_not_configured"
  | "method_not_supported"
  | "requires_inquiry"
  | "sales_paused"
  | "queue_busy"
  | "exposure_cap"
  | "order_over_limit"
  | "fx_input_missing"
  | "verification_required"
  | "verification_already_bound"
  | "verification_expired"
  | "verified_contact_missing"
  | "verified_contact_mismatch"
  | "payment_session_failed"
  | "payment_session_unavailable";

type StartInput = Parameters<CheckoutService["start"]>[0];
type StartResult = Awaited<ReturnType<CheckoutService["start"]>>;

/** The least quote life left for a customer to pay on the hosted page. */
export const MIN_PAYMENT_WINDOW_MS = 2 * 60_000;

/** A verification older than a quote's whole life cannot belong to a live quote's checkout. */
export const VERIFICATION_MAX_AGE_MS = QUOTE_TTL_MS;

export { EXPOSURE_LIMITS_SETTING_KEY, exposureLimitsSchema, type ExposureLimits } from "./exposure-limits";

/** The quote line as stored (bigint values as strings), the fields checkout reads. */
const storedLineSchema = z.object({
  productId: z.string().uuid(),
  productVersion: z.number().int().nullable().optional(),
  variantId: z.string(),
  mappingId: z.string().uuid(),
  supplierEnvironment: z.enum(["test", "production"]).nullable(),
  supplierAccountId: z.string().nullable().optional(),
  serviceDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  slotRef: z.string().nullable(),
  units: z.record(z.string(), z.number().int().min(0)),
  unitDefinitions: z.array(z.object({ unitId: z.string(), supplierUnit: z.string(), label: z.string().optional() }).passthrough()),
  chargedMinor: z.string().regex(/^\d+$/),
  discountAllocMinor: z.string().regex(/^\d+$/),
  taxAllocMinor: z.string().regex(/^\d+$/),
  supplierNetAedMinor: z.string().regex(/^\d+$/),
  margin: z.record(z.string(), z.unknown()),
  freeCancellationUntilUtc: z.string().nullable(),
  nonRefundableAfterConfirm: z.boolean(),
  // Batch 3: the accepted pickup hotel. Absent on lines quoted before pickup snapshots, and then read as none.
  pickup: z.object({ hotelRef: z.string(), hotelName: z.string().nullable().optional() }).nullable().optional(),
});
type StoredLine = z.infer<typeof storedLineSchema>;

export interface CheckoutLineFacts {
  mappingId: string;
  supplierEnvironment: "test" | "production" | null;
  supplierAccountId: string | null;
}

export interface CheckoutDeps {
  gateways: GatewayRegistry;
  releaseEnabled(): boolean;
  readiness: Pick<ReadinessService, "evaluate">;
  /** Whether the supplier account behind this line takes new sales (control row, fail closed). */
  salesOpen(line: CheckoutLineFacts): Promise<boolean>;
  /** Whether `bookings` more reservations (default one) fit the account's queue (SUP-7 admission). */
  admission(line: CheckoutLineFacts, now: Date, bookings?: number): Promise<boolean>;
  exposureLimits(): Promise<ExposureLimits>;
  /** The current `pricing.fx_inr_per_aed` rate, or null when none is usable (missing, malformed, expired). */
  fxInrPerAed(now: Date): Promise<string | null>;
  now(): Date;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const HOLDING_SAGA_STATES = ["authorized", "reserve_pending", "reserved", "capture_unknown"];
/** Sagas whose payment window is over: their link is never handed out again. */
const CLOSED_SAGA_STATES = ["failed", "released", "refunded", "attention", "release_pending", "refund_pending"];
const RISKY_WINDOW_MS = 15 * 60_000;
const DEFAULT_MUTATION_P95_MS = 30_000;

function refuse(reason: CheckoutRefusal): StartResult {
  return { ok: false, reason };
}

function ownerMatches(q: { ownerKind: string; customerId: string | null; guestSessionId: string | null }, owner: StartInput["owner"]): boolean {
  return owner.kind === "customer" ? q.ownerKind === "customer" && q.customerId === owner.customerId : q.ownerKind === "guest" && q.guestSessionId === owner.guestSessionId;
}

/** Guests by supplier unit (TravelDesk adult/child/infant); anything else counts as an adult seat. */
function paxOf(line: StoredLine): PaxCount {
  const pax: PaxCount = { adult: 0, child: 0, infant: 0, senior: 0 };
  for (const u of line.unitDefinitions) {
    const n = line.units[u.unitId] ?? 0;
    if (u.supplierUnit === "child") pax.child += n;
    else if (u.supplierUnit === "infant") pax.infant += n;
    else pax.adult += n;
  }
  return pax;
}

export function createCheckoutService(deps: CheckoutDeps): CheckoutService & { exposure(rail: PaymentRail, currency: Currency): Promise<boolean> } {
  const db = prisma;

  async function exposure(rail: PaymentRail, currency: Currency): Promise<boolean> {
    const limits = await deps.exposureLimits();
    const now = deps.now();
    const holds = await db.paymentSaga.count({ where: { rail, state: { in: HOLDING_SAGA_STATES } } });
    if (holds >= limits.maxUncapturedHolds) return false;
    const risky = await db.payment.count({
      where: {
        rail,
        source: "gateway_verified",
        createdAt: { gte: new Date(now.getTime() - RISKY_WINDOW_MS) },
        OR: [{ status: "failed" }, { threeDs: "failed" }, { risk: { in: ["elevated", "highest"] } }],
      },
    });
    if (risky >= limits.maxRiskyPaymentsPer15Min) return false;
    const funded = await db.customerRemedy.aggregate({
      where: { outlyFunded: true, currency, status: { notIn: ["cancelled", "failed"] }, createdAt: { gte: new Date(now.getTime() - limits.outlyFundedWindowDays * 86_400_000) } },
      _sum: { amountMinor: true },
    });
    return (funded._sum.amountMinor ?? 0n) <= BigInt(limits.outlyFundedCapMinor[currency]);
  }

  /**
   * The per-order instant cap (doc 22 §32.24), the quote's own rule
   * (`instantOrderCapVerdict`) on the whole quote total. A missing cap is an
   * exposure input missing (`exposure_cap`); no usable FX row for an INR
   * order is `fx_input_missing`.
   */
  async function orderCap(totalMinor: bigint, currency: Currency): Promise<CheckoutRefusal | null> {
    const limits = await deps.exposureLimits();
    const now = deps.now();
    const inrPerAed = currency === "INR" ? await deps.fxInrPerAed(now) : null;
    const verdict = instantOrderCapVerdict({ totalMinor, currency, capAedMinor: limits.maxInstantOrderAedMinor, inrPerAed });
    if (verdict.ok) return null;
    return verdict.reason === "limit_not_configured" ? "exposure_cap" : verdict.reason;
  }

  /** Gates 3–7 for the quote's lines (every line must pass). Null when they all pass. */
  async function gates(lines: StoredLine[], rail: PaymentRail, currency: Currency, method: string, totalMinor: bigint): Promise<CheckoutRefusal | null> {
    let gw;
    try {
      gw = deps.gateways.forRail(rail);
    } catch (e) {
      if (isAppError(e) && e.code === "NOT_CONFIGURED") return "payments_not_configured";
      throw e;
    }
    try {
      gw.capabilities(method);
    } catch (e) {
      // Each gateway throws its own error for a method it does not offer (the fakes', Stripe's).
      if (e instanceof UnsupportedMethodError || e instanceof StripeUnsupportedMethodError) return "method_not_supported";
      throw e;
    }
    const capped = await orderCap(totalMinor, currency);
    if (capped) return capped;
    for (const line of lines) {
      const readiness = await deps.readiness.evaluate(line.productId, line.supplierEnvironment ? { environment: line.supplierEnvironment } : undefined);
      if (readiness.effective !== "instant") return "requires_inquiry";
    }
    for (const line of lines) {
      const facts: CheckoutLineFacts = { mappingId: line.mappingId, supplierEnvironment: line.supplierEnvironment, supplierAccountId: line.supplierAccountId ?? null };
      if (!(await deps.salesOpen(facts))) return "sales_paused";
      // Every line is one more reservation; counted all on each account (conservative when lines share it).
      if (!(await deps.admission(facts, deps.now(), lines.length))) return "queue_busy";
    }
    if (!(await exposure(rail, currency))) return "exposure_cap";
    return null;
  }

  /** Ask the gateway for the session of an order already written; idempotent on the payment's key. */
  async function openSession(paymentId: string, input: StartInput): Promise<StartResult> {
    const p = await db.payment.findUniqueOrThrow({ where: { id: paymentId }, include: { order: { select: { id: true, reference: true } }, saga: true, quote: { select: { expiresAt: true } } } });
    // A link is handed out only while the customer can still pay on it: never for a closed saga or a lapsed quote (F46).
    const live = Boolean(p.saga && !CLOSED_SAGA_STATES.includes(p.saga.state) && p.quote && p.quote.expiresAt.getTime() - deps.now().getTime() >= MIN_PAYMENT_WINDOW_MS);
    if (p.paymentLinkUrl) return live ? { ok: true, orderId: p.order.id, orderReference: p.order.reference, redirectUrl: p.paymentLinkUrl } : refuse("quote_expired");
    if (!p.saga || p.saga.state !== "session_created" || !p.rail || !p.idempotencyKey || !p.quoteId) return refuse("payment_session_failed");
    if (!live) return refuse("quote_expired");
    const gw = deps.gateways.forRail(p.rail as PaymentRail);
    let r: Awaited<ReturnType<typeof gw.createSession>>;
    try {
      r = await gw.createSession({
        orderId: p.order.id,
        quoteId: p.quoteId,
        currency: p.currency,
        amountMinor: p.amountMinor,
        idempotencyKey: p.idempotencyKey,
        returnUrl: input.returnUrl,
        method: p.method ?? input.method,
        // The provider must stop taking payment when the quote lapses (CR-B3-7).
        expiresAt: p.quote!.expiresAt.toISOString(),
      });
    } catch (error) {
      log.warn("checkout.session_unavailable", { orderId: p.order.id, error: error instanceof Error ? error.message : String(error) });
      return refuse("payment_session_unavailable");
    }
    if (!r.ok) {
      const saga = p.saga;
      await db.$transaction(async (tx) => {
        const moved = await tx.paymentSaga.updateMany({ where: { id: saga.id, version: saga.version, state: "session_created" }, data: { state: "failed", version: { increment: 1 } } });
        if (!moved.count) return;
        await tx.payment.update({ where: { id: p.id }, data: { status: "failed", failureCode: r.code.slice(0, 64) } });
        await orderService.applyPaymentOutcome(tx, p.order.id, "payment_failed", deps.now());
      }, TX_OPTIONS);
      return refuse("payment_session_failed");
    }
    const sessionEnds = Date.parse(r.session.expiresAt);
    const quoteEnds = p.quote!.expiresAt.getTime();
    await db.$transaction(async (tx) => {
      await tx.payment.update({
        where: { id: p.id },
        data: { providerOrderId: r.session.providerOrderId, gatewayOrderId: r.session.providerOrderId, paymentLinkUrl: r.session.redirectUrl },
      });
      // The payment window is the earlier of the quote and the provider session (asked to end with the quote; a provider may end it sooner).
      if (Number.isFinite(sessionEnds) && sessionEnds < quoteEnds) await tx.paymentSaga.updateMany({ where: { id: p.saga!.id, state: "session_created" }, data: { deadlineAt: new Date(sessionEnds) } });
    }, TX_OPTIONS);
    return { ok: true, orderId: p.order.id, orderReference: p.order.reference, redirectUrl: r.session.redirectUrl };
  }

  async function start(input: StartInput): Promise<StartResult> {
    if (!UUID.test(input.quoteId) || !UUID.test(input.verificationId) || !input.method || input.method.length > 40 || !input.traveller?.fullName?.trim()) return refuse("invalid_request");
    if (!deps.releaseEnabled()) return refuse("release_switch_off");
    const now = deps.now();

    const quote = await db.quote.findUnique({ where: { id: input.quoteId } });
    if (!quote || !ownerMatches(quote, input.owner)) return refuse("quote_not_found");
    const rail = railForCurrency(quote.currency);
    if (!rail) return refuse("quote_not_active");
    const rawLines = Array.isArray(quote.lines) ? quote.lines : [];
    if (rawLines.length < 1 || rawLines.length > MAX_INSTANT_ITEMS_PER_ORDER) return refuse("too_many_items");
    const lines: StoredLine[] = [];
    for (const raw of rawLines) {
      const parsed = storedLineSchema.safeParse(raw);
      if (!parsed.success) return refuse("quote_not_active");
      lines.push(parsed.data);
    }
    if (repeatsInstantLine(lines)) return refuse("too_many_items");

    if (quote.status === "used" && quote.usedByOrderId) {
      const payment = await db.payment.findFirst({ where: { orderId: quote.usedByOrderId, saga: { isNot: null } } });
      if (!payment) return refuse("quote_not_active");
      if (!payment.paymentLinkUrl) {
        const refusal = await gates(lines, rail, quote.currency, payment.method ?? input.method, quote.totalMinor);
        if (refusal) return refuse(refusal);
      }
      return openSession(payment.id, input);
    }
    if (quote.status !== "active") return refuse("quote_not_active");
    if (quote.expiresAt.getTime() - now.getTime() < MIN_PAYMENT_WINDOW_MS) return refuse("quote_expired");

    const refusal = await gates(lines, rail, quote.currency, input.method, quote.totalMinor);
    if (refusal) return refuse(refusal);

    const verification = await db.orderContactVerification.findUnique({ where: { id: input.verificationId } });
    if (!verification || verification.quoteId !== quote.id) return refuse("verification_required");
    if (verification.orderId) return refuse("verification_already_bound");
    if (verification.verifiedAt.getTime() + VERIFICATION_MAX_AGE_MS <= now.getTime()) return refuse("verification_expired");
    const channel = verification.channel === "email" ? "email" : "phone";
    const given = channel === "phone" ? input.traveller.phoneE164 : input.traveller.email;
    if (!given?.trim()) return refuse("verified_contact_missing");
    const verifiedContact = normaliseContact(channel, given);
    if (!verifiedContact || contactHash(verifiedContact) !== verification.contactHash) return refuse("verified_contact_mismatch");

    const gw = deps.gateways.forRail(rail);
    const account = gw.account();
    const inr = quote.currency === "INR";
    const items: CreateOrderItemInput[] = [];
    for (const [index, line] of lines.entries()) {
      const product = await db.product.findUnique({ where: { id: line.productId }, select: { id: true, title: true, tier: true, slug: true, durationMinutes: true, content: true } });
      if (!product) return refuse("requires_inquiry");
      const content = (product.content ?? {}) as { variants?: Array<{ id: string; name: string }>; freeCancellationHours?: number; image?: string };
      const variantName = content.variants?.find((v) => v.id === line.variantId)?.name;
      const charged = BigInt(line.chargedMinor);
      items.push({
        productId: product.id,
        variantCode: line.variantId,
        mappingId: line.mappingId,
        titleSnapshot: product.title,
        tierSnapshot: product.tier,
        slugSnapshot: product.slug,
        kindSnapshot: "activity",
        variantNameSnapshot: variantName,
        cancellationPolicySnapshot: { freeCancellationUntilUtc: line.freeCancellationUntilUtc, nonRefundableAfterConfirm: line.nonRefundableAfterConfirm },
        confirmationSnapshot: "instant",
        fulfilmentModeSnapshot: "instant",
        freeCancellationHoursSnapshot: typeof content.freeCancellationHours === "number" ? content.freeCancellationHours : 0,
        durationMinutesSnapshot: product.durationMinutes ?? 0,
        serviceDate: line.serviceDate,
        timeslot: line.slotRef ?? undefined,
        pax: paxOf(line),
        addons: [],
        // One currency is charged; the other columns stay 0, never a converted figure.
        unitInr: inr ? charged : 0n,
        unitAed: inr ? 0n : charged,
        totalInr: inr ? charged : 0n,
        totalAed: inr ? 0n : charged,
        netCostAed: BigInt(line.supplierNetAedMinor),
        fulfilmentOrigin: "instant_checkout",
        chargedCurrency: quote.currency,
        chargedAmountMinor: charged,
        discountAllocMinor: BigInt(line.discountAllocMinor),
        taxAllocMinor: BigInt(line.taxAllocMinor),
        quoteId: quote.id,
        marginSnapshot: line.margin,
        // The item's position: the saga reserves and confirms in this order, and the engine reads this line.
        quoteLineIndex: index,
        // The hotel the supplier check accepted, as the order's own record of it (Batch 3).
        pickupHotelId: line.pickup?.hotelRef ?? null,
        pickupHotelNameSnapshot: line.pickup ? (line.pickup.hotelName ?? null) : null,
      });
    }
    // The payment is the quote total; each item's allocation is its own payable share, and they add up exactly.
    const allocated = items.reduce((sum, i) => sum + (i.chargedAmountMinor ?? 0n) - (i.discountAllocMinor ?? 0n) + (i.taxAllocMinor ?? 0n), 0n);
    if (allocated !== quote.totalMinor || items.some((i) => (i.chargedAmountMinor ?? 0n) - (i.discountAllocMinor ?? 0n) + (i.taxAllocMinor ?? 0n) <= 0n)) return refuse("quote_not_active");

    let paymentId: string;
    try {
      paymentId = await db.$transaction(async (tx) => {
        const order = await orderService.createOrder(
          {
            rail: "self_serve",
            currency: quote.currency,
            paymentCollection: "gateway",
            customerId: input.owner.kind === "customer" ? input.owner.customerId : undefined,
            traveller: {
              fullName: input.traveller.fullName.trim(),
              // The verified contact is the order's recovery contact, stored normalised. The order needs a
              // phone column; an email-verified checkout without a phone keeps it empty (never matched by phone linking).
              phoneE164: channel === "phone" ? verifiedContact : (input.traveller.phoneE164?.trim() ?? ""),
              email: channel === "email" ? verifiedContact : (input.traveller.email?.trim() || undefined),
            },
            items,
          },
          SYSTEM_ACTOR,
          tx,
          { instantCheckout: { quoteId: quote.id } },
        );
        const used = await tx.quote.updateMany({ where: { id: quote.id, status: "active" }, data: { status: "used", usedByOrderId: order.id } });
        if (used.count !== 1) throw new QuoteRace();
        await contactVerificationService.bindToOrder(tx, input.verificationId, order.id);
        // The saga names the first item; every item of the order belongs to it (payments/saga.ts).
        const orderItem = await tx.orderItem.findFirstOrThrow({ where: { orderId: order.id, quoteLineIndex: 0 }, select: { id: true } });
        const pid = uuidv7();
        await tx.payment.create({
          data: {
            id: pid,
            orderId: order.id,
            gateway: account.provider,
            source: "gateway_verified",
            rail,
            provider: account.provider,
            providerAccountId: account.accountId,
            environment: account.environment,
            idempotencyKey: `pay:${order.id}:1`,
            method: input.method,
            amountMinor: quote.totalMinor,
            currency: quote.currency,
            status: "created",
            quoteId: quote.id,
          },
        });
        await tx.paymentSaga.create({
          data: { id: uuidv7(), orderId: order.id, orderItemId: orderItem.id, paymentId: pid, rail, state: "session_created", deadlineAt: quote.expiresAt },
        });
        return pid;
      }, TX_OPTIONS);
    } catch (e) {
      if (e instanceof QuoteRace) return start(input);
      if (isAppError(e) && e.status === 409) {
        // Another request took the quote first, or it expired under us: answer as for that quote now.
        const fresh = await db.quote.findUnique({ where: { id: quote.id }, select: { status: true } });
        if (fresh?.status === "used") return start(input);
        return refuse("quote_not_active");
      }
      throw e;
    }
    log.info("checkout.order_created", { paymentId, rail });
    return openSession(paymentId, input);
  }

  return { start, exposure };
}

class QuoteRace extends Error {}

/* ---------------------------------------------------------------------------
 * Production wiring
 * ------------------------------------------------------------------------ */

async function lineSupplier(line: CheckoutLineFacts) {
  const mapping = await prisma.productSupplierMapping.findUnique({ where: { id: line.mappingId }, select: { supplier: { select: { id: true, code: true } } } });
  if (!mapping) return null;
  // An unreported environment is treated as production: the strictest control applies.
  const environment = line.supplierEnvironment ?? "production";
  const accountId = line.supplierAccountId ?? bookingAccountId(environment, null);
  return accountId ? { supplierId: mapping.supplier.id, code: mapping.supplier.code, environment, accountId } : null;
}

export const checkoutService = createCheckoutService({
  gateways: paymentGateways,
  releaseEnabled: () => env().INSTANT_RELEASE_ENABLED === true,
  readiness: readinessService,
  async salesOpen(line) {
    const s = await lineSupplier(line);
    if (!s) return false;
    return !(await bookingControl(s.code, s.environment, s.accountId)).paused;
  },
  async admission(line, now, bookings = 1) {
    const s = await lineSupplier(line);
    if (!s) return false;
    // The engine's reserve admission (SUP-7), asked before any money moves.
    const [row] = await prisma.$queryRaw<{ n: number; earliest: Date | null }[]>`
      SELECT count(*)::int AS n, min(j.deadline_at) AS earliest
      FROM supplier_jobs j JOIN supplier_bookings b ON b.id = j.supplier_booking_id
      WHERE j.status IN ('queued', 'running') AND j.kind IN ('confirm', 'cancel')
        AND b.supplier_id = ${s.supplierId}::uuid AND b.environment = ${s.environment}::supplier_environment AND b.account_id = ${s.accountId}`;
    if (!row?.earliest) return true;
    return now.getTime() + (row.n + bookings) * DEFAULT_MUTATION_P95_MS <= row.earliest.getTime();
  },
  // A missing row, or one that does not parse (including one without `maxInstantOrderAedMinor`), refuses new sales (fail closed).
  exposureLimits: readExposureLimits,
  fxInrPerAed: readCurrentInrPerAed,
  now: () => new Date(),
});
