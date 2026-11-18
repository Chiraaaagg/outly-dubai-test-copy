import { createHash, randomBytes } from "node:crypto";
import type { Prisma as P } from "@prisma/client";
import { uuidv7 } from "../../lib/ids";
import { FakeAedCardGateway, FakeInrPacbGateway } from "../fake-gateways";
import { createGatewayRegistry } from "../registry";
import type { EngineSagaApi } from "../contracts";
import type { BookingStateReader, BookingView } from "../saga";
import type { ExposureLimits } from "../checkout.service";

/**
 * Shared harness for the B3 database suites (checkout, inbox, saga). Imported
 * by evidence.test.ts, which is the payments suite listed in
 * vitest.suites.mjs; this file is not a test file itself.
 *
 * Every row is synthetic (synthetic amounts, `zz-b3-<run>` names) and is
 * written to the disposable database the target guard admits. The clock is
 * real time plus an offset, because the order path compares quote expiry
 * with the database clock.
 */

type Prisma = typeof import("../../lib/db").prisma;

export const SERVICE_DATE = "2030-01-15";
/** Synthetic UAE mobile number in E.164; the verification fixture hashes it. */
export const TRAVELLER_PHONE = "+971501234567";
const HOLD_MS = 15 * 60_000;
/** The fake engine's confirm budget before the hold deadline (the real one: max(5 min, mutation timeout + 60 s)). */
const CONFIRM_BUDGET_MS = 5 * 60_000;

export class Clock {
  offsetMs = 0;
  /** Set by `freeze`: time stands still there (plus the offset), for tests that compare exact instants. */
  frozenAt: number | null = null;
  now = () => new Date((this.frozenAt ?? Date.now()) + this.offsetMs);
  advance(ms: number) {
    this.offsetMs += ms;
  }
  freeze() {
    this.frozenAt = Date.now();
  }
}

/**
 * The engine side of the seam, in memory (Halyard implements the real one).
 * `startAttempt` must be given the saga's transaction; `confirmIfPaid` asks
 * the real database evidence port, exactly as the engine re-reads it before
 * a confirm send.
 */
type EngineOp = "startAttempt" | "confirmIfPaid" | "releaseHold" | "confirmSendBy";

export class FakeEngine implements EngineSagaApi, BookingStateReader {
  readonly bookings = new Map<string, BookingView & { orderItemId: string; confirmSent?: boolean }>();
  readonly calls: Array<{ op: EngineOp; id: string; reason?: string }> = [];
  /** What the engine does when asked to confirm. */
  confirmOutcome: "confirmed" | "rejected" | "unknown" | "too_late" = "confirmed";
  /** Multi-item: what the engine does when asked to confirm one order item (overrides `confirmOutcome`). */
  readonly confirmOutcomeFor = new Map<string, "confirmed" | "rejected" | "unknown" | "too_late">();
  /** Throws (not an AppError) from the next `startAttempt`: a process dying mid-step. */
  crashNextStart = false;
  /**
   * Order items whose attempt the engine holds for a human (booking-level
   * `attention_required_at`, e.g. `charged_amount_mismatch` at reserve):
   * `confirmIfPaid` answers `not_ready` and queues nothing, as the real engine.
   */
  readonly heldForHuman = new Set<string>();
  /** A definite refusal from intake (pause, wrong origin). */
  refuseIntake = false;
  confirmsSent = 0;
  /** `later`: a release queues a cancel (`cancelling`) and a test reports the verified cancel with `set`. */
  releaseVerifies: "at_once" | "later" = "at_once";
  /** Runs inside `releaseHold` before the booking lock decides: the worker's confirm send racing the release (CR-B3-1). */
  onRelease: ((b: BookingView & { orderItemId: string; confirmSent?: boolean }) => void) | null = null;
  /** The engine reports no send-by (an unknown reservation deadline). */
  sendByUnknown = false;

  constructor(
    private readonly clock: Clock,
    private readonly evidence: () => Promise<{ capturedFor(orderItemId: string): Promise<unknown> }>,
  ) {}

  /** The supplier row the engine's attempts belong to (`harness` creates it). */
  supplierId = "";

  /**
   * Writes the attempt row in the saga's transaction, as `createIntent(tx, …)`
   * does; after that the fake keeps the attempt's state in memory and never
   * writes the row again, so the row shows whether anyone else did (SUP-20).
   */
  async startAttempt(tx: unknown, input: { orderId: string; orderItemId: string; quoteId: string }) {
    if (!tx || typeof (tx as { $queryRaw?: unknown }).$queryRaw !== "function") throw new Error("startAttempt needs the saga's transaction");
    if (this.refuseIntake) {
      const { Errors } = await import("../../lib/errors");
      throw Errors.conflict("New sales are paused", { reason: "paused" });
    }
    if (this.crashNextStart) {
      this.crashNextStart = false;
      throw new Error("process died");
    }
    const id = uuidv7();
    const t = tx as import("../../lib/db").Tx;
    await t.supplierBooking.create({
      data: {
        id,
        orderId: input.orderId,
        orderItemId: input.orderItemId,
        supplierId: this.supplierId,
        environment: "test",
        idempotencyKey: `zz-b3:${input.orderItemId}:1`,
        clientRef: `ZZB3${id.replace(/-/g, "").slice(-12)}`,
        bookingKind: "live_book",
        afterReserve: "await_payment",
        tourExternalId: "zz-b3-tour",
        offerExternalId: "zz-b3-offer",
        serviceDate: new Date(`${SERVICE_DATE}T00:00:00Z`),
        adults: 2,
        guestName: "zz-b3 traveller",
        expectedNetMinor: 5_000n,
        expectedNetUsdMinor: 1_400n,
      },
    });
    this.bookings.set(input.orderItemId, { id, orderItemId: input.orderItemId, state: "queued", reservationDeadline: null });
    this.calls.push({ op: "startAttempt", id });
    return { supplierBookingId: id };
  }

  /** The supplier answered the reserve. */
  reserve(orderItemId: string, outcome: "awaiting_payment" | "rejected" = "awaiting_payment") {
    const b = this.bookings.get(orderItemId)!;
    b.state = outcome;
    b.reservationDeadline = outcome === "awaiting_payment" ? new Date(this.clock.now().getTime() + HOLD_MS) : null;
  }

  set(orderItemId: string, state: string) {
    this.bookings.get(orderItemId)!.state = state;
  }

  async confirmIfPaid(supplierBookingId: string) {
    this.calls.push({ op: "confirmIfPaid", id: supplierBookingId });
    const b = [...this.bookings.values()].find((x) => x.id === supplierBookingId)!;
    if (b.state !== "awaiting_payment") return "not_ready" as const;
    if (this.heldForHuman.has(b.orderItemId)) return "not_ready" as const;
    if (!(await (await this.evidence()).capturedFor(b.orderItemId))) return "not_ready" as const;
    const outcome = this.confirmOutcomeFor.get(b.orderItemId) ?? this.confirmOutcome;
    if (outcome === "too_late") return "too_late" as const;
    this.confirmsSent += 1;
    b.confirmSent = true;
    b.state = outcome === "confirmed" ? "confirmed" : outcome === "rejected" ? "rejected" : "confirming";
    return "queued" as const;
  }

  /** The worker sent the confirm (it passed the database-clock gate first). */
  sendConfirm(orderItemId: string, outcome: "confirming" | "confirmed" | "rejected" = "confirming") {
    const b = this.bookings.get(orderItemId)!;
    this.confirmsSent += 1;
    b.confirmSent = true;
    b.state = outcome;
  }

  /** As the engine: refused once a confirm was sent or the attempt is past releasing; a never-sent attempt closes at once. */
  async releaseHold(supplierBookingId: string, reason: string) {
    this.calls.push({ op: "releaseHold", id: supplierBookingId, reason });
    const b = [...this.bookings.values()].find((x) => x.id === supplierBookingId);
    if (b && this.onRelease) this.onRelease(b);
    if (!b || b.confirmSent || !["queued", "reserving", "reserved", "awaiting_payment", "outcome_unknown", "not_found_unresolved"].includes(b.state)) return "not_applicable" as const;
    b.state = b.state === "queued" ? "not_created" : this.releaseVerifies === "later" ? "cancelling" : "cancelled";
    return "queued" as const;
  }

  async confirmSendBy(supplierBookingId: string) {
    this.calls.push({ op: "confirmSendBy", id: supplierBookingId });
    const b = [...this.bookings.values()].find((x) => x.id === supplierBookingId);
    if (!b?.reservationDeadline || this.sendByUnknown) return null;
    return new Date(b.reservationDeadline.getTime() - CONFIRM_BUDGET_MS).toISOString();
  }

  async current(orderItemId: string) {
    const b = this.bookings.get(orderItemId);
    return b ? { id: b.id, state: b.state, reservationDeadline: b.reservationDeadline } : null;
  }

  count(op: EngineOp) {
    return this.calls.filter((c) => c.op === op).length;
  }
}

export const OPEN_LIMITS: ExposureLimits = {
  maxUncapturedHolds: 1_000_000,
  maxRiskyPaymentsPer15Min: 1_000_000,
  outlyFundedWindowDays: 30,
  outlyFundedCapMinor: { INR: 1_000_000_000, AED: 1_000_000_000 },
  maxInstantOrderAedMinor: 1_000_000_000,
};
/** A usable synthetic INR-per-AED rate for the order cap on INR quotes. */
export const OPEN_FX = "25.00";

export interface Harness {
  prisma: Prisma;
  clock: Clock;
  inr: FakeInrPacbGateway;
  aed: FakeAedCardGateway;
  engine: FakeEngine;
  saga: import("../saga").PaymentSagaService;
  inbox: import("../inbox").PaymentInbox;
  checkout: ReturnType<typeof import("../checkout.service").createCheckoutService>;
  gates: { release: boolean; salesOpen: boolean; admission: boolean; limits: ExposureLimits; readiness: "instant" | "inquiry"; fx: string | null };
}

export async function harness(prisma: Prisma, opts: { refundsSettle?: "immediately" | "manual"; elapsedMs?: () => number } = {}): Promise<Harness> {
  const clock = new Clock();
  const inr = new FakeInrPacbGateway({ now: clock.now, refundsSettle: opts.refundsSettle });
  const aed = new FakeAedCardGateway({ now: clock.now, refundsSettle: opts.refundsSettle });
  const gateways = createGatewayRegistry([inr, aed], { production: false });
  const { paymentEvidenceFrom } = await import("../evidence");
  const engine = new FakeEngine(clock, async () => paymentEvidenceFrom(prisma));
  const supplier = await prisma.supplier.upsert({
    where: { code: "zz-b3-supplier" },
    create: { id: uuidv7(), code: "zz-b3-supplier", name: "zz-b3 synthetic supplier", source: "api", adapter: "manual" },
    update: {},
  });
  engine.supplierId = supplier.id;
  const { createPaymentSaga } = await import("../saga");
  const { createPaymentInbox } = await import("../inbox");
  const { createCheckoutService } = await import("../checkout.service");
  const saga = createPaymentSaga({ gateways, engine, bookings: engine, now: clock.now, elapsedMs: opts.elapsedMs });
  const inbox = createPaymentInbox({ gateways, saga, now: clock.now });
  const gates: Harness["gates"] = { release: true, salesOpen: true, admission: true, limits: OPEN_LIMITS, readiness: "instant", fx: OPEN_FX };
  const checkout = createCheckoutService({
    gateways,
    releaseEnabled: () => gates.release,
    readiness: {
      async evaluate(productId) {
        return { productId, requested: "instant", effective: gates.readiness, reasons: [], readinessVersion: 3, evaluatedAt: clock.now().toISOString() };
      },
    },
    salesOpen: async () => gates.salesOpen,
    admission: async () => gates.admission,
    exposureLimits: async () => gates.limits,
    fxInrPerAed: async () => gates.fx,
    now: clock.now,
  });
  return { prisma, clock, inr, aed, engine, saga, inbox, checkout, gates };
}

export interface QuoteFixture {
  quoteId: string;
  verificationId: string;
  guestSessionId: string;
  productId: string;
  totalMinor: bigint;
}

/**
 * A guest session, a product, an active one-line quote and its verification.
 * AED: 11_000 charged − 1_500 discount + 500 tax = 10_000. INR: 230_000.
 */
export interface QuoteOptions {
  ttlMs?: number;
  /**
   * Multi-item: the number of lines (default 1), each its own product, mapping
   * and date. Line i charges the one-line amount plus i × 1_000 (AED) or
   * i × 10_000 (INR), so allocations differ: AED 10_000, 11_000, 12_000…
   */
  items?: number;
  /** Fields to set on the quote line once the product exists (the real-engine suite maps it to a supplier offer). */
  line?: (productId: string) => Promise<Record<string, unknown>>;
}

export async function quoteFixture(h: Harness, run: string, currency: "INR" | "AED", opts: QuoteOptions = {}): Promise<QuoteFixture> {
  const p = h.prisma;
  const now = h.clock.now();
  const guest = await p.guestSession.create({ data: { id: uuidv7(), tokenHash: createHash("sha256").update(randomBytes(16)).digest("hex"), expiresAt: new Date(now.getTime() + 86_400_000) } });
  const aed = currency === "AED";
  const lines: Record<string, unknown>[] = [];
  let total = 0n;
  let firstProductId = "";
  for (let i = 0; i < (opts.items ?? 1); i++) {
    const product = await p.product.create({
      data: {
        id: uuidv7(),
        slug: `zz-b3-${run}-${uuidv7().slice(-8)}`,
        title: i === 0 ? "zz-b3 synthetic tour" : `zz-b3 synthetic tour ${i + 1}`,
        tier: "A",
        categorySlug: "zz-b3",
        confirmation: "instant",
        // Draft: invisible to every storefront query other suites run; readiness is a fake here.
        status: "draft",
        fulfilmentMode: "instant",
        durationMinutes: 120,
        content: { variants: [{ id: "v1", name: "Standard" }], freeCancellationHours: 0 },
      },
    });
    if (i === 0) firstProductId = product.id;
    const step = BigInt(i) * (aed ? 1_000n : 10_000n);
    const [charged, discount, tax] = aed ? [11_000n + step, 1_500n, 500n] : [230_000n + step, 0n, 0n];
    total += charged - discount + tax;
    lines.push({
      index: i,
      productId: product.id,
      productVersion: 1,
      variantId: "v1",
      mappingId: uuidv7(),
      approvedOfferHash: "zz-b3-hash",
      supplierEnvironment: "test",
      readinessRulesVersion: 3,
      serviceDate: SERVICE_DATE,
      slotRef: null,
      units: { adult: 2 },
      unitDefinitions: [{ unitId: "adult", label: "Adult", per: "person", ageMin: null, ageMax: null, residency: "any", heightMinCm: null, heightMaxCm: null, seatConsuming: true, minQty: 1, maxQty: 9, price: { inr: 1, aed: 1 }, supplierUnit: "adult" }],
      addonIds: [],
      pickup: null,
      chargedMinor: charged.toString(),
      discountAllocMinor: discount.toString(),
      taxAllocMinor: tax.toString(),
      supplierNetAedMinor: "5000",
      supplierCheckedAt: now.toISOString(),
      margin: { policyVersion: 1, floorBps: 1500, grossMarginBps: 3000, costLines: [] },
      freeCancellationUntilUtc: null,
      nonRefundableAfterConfirm: true,
      supplierAccountId: null,
      couponVersion: null,
      ...(opts.line ? await opts.line(product.id) : {}),
    });
  }
  const quoteId = uuidv7();
  await p.quote.create({
    data: {
      id: quoteId,
      fingerprint: createHash("sha256").update(quoteId).digest("hex"),
      ownerKind: "guest",
      guestSessionId: guest.id,
      currency,
      totalMinor: total,
      lines: lines as unknown as P.InputJsonValue,
      request: { lines: [], currency, couponCode: null },
      status: "active",
      createdAt: now,
      expiresAt: new Date(now.getTime() + (opts.ttlMs ?? 10 * 60_000)),
    },
  });
  const { contactHash, normaliseContact } = await import("../../services/contact-verification.service");
  const v = await p.orderContactVerification.create({
    data: { id: uuidv7(), quoteId, channel: "phone", contactHash: contactHash(normaliseContact("phone", TRAVELLER_PHONE)!), method: "otp_sms", verifiedAt: now },
  });
  return { quoteId, verificationId: v.id, guestSessionId: guest.id, productId: firstProductId, totalMinor: total };
}

export function startInput(q: QuoteFixture, method: string) {
  return {
    owner: { kind: "guest" as const, guestSessionId: q.guestSessionId },
    quoteId: q.quoteId,
    verificationId: q.verificationId,
    method,
    traveller: { fullName: "zz-b3 traveller", phoneE164: TRAVELLER_PHONE as string | null, email: null as string | null },
    returnUrl: "http://localhost:3000/checkout/return",
    ip: null,
  };
}

/** Checkout, then the ids every scenario needs. */
export async function checkedOut(h: Harness, run: string, currency: "INR" | "AED", method: string, opts: QuoteOptions = {}) {
  const q = await quoteFixture(h, run, currency, opts);
  const r = await h.checkout.start(startInput(q, method));
  if (!r.ok) throw new Error(`checkout refused: ${r.reason}`);
  const saga = await h.prisma.paymentSaga.findUniqueOrThrow({ where: { orderId: r.orderId }, include: { payment: true } });
  const gw = currency === "INR" ? h.inr : h.aed;
  // Every item in position order (multi-item); the saga names the first.
  const items = await h.prisma.orderItem.findMany({ where: { orderId: r.orderId }, orderBy: { quoteLineIndex: "asc" }, select: { id: true } });
  return { q, r, sagaId: saga.id, orderItemId: saga.orderItemId, itemIds: items.map((i) => i.id), paymentId: saga.paymentId!, providerOrderId: saga.payment!.providerOrderId!, gw };
}

/** Deliver a webhook through the inbox and process it, as the route and the job would. */
export async function deliver(h: Harness, gw: FakeInrPacbGateway | FakeAedCardGateway, type: string, providerPaymentId: string | null, opts: { eventId?: string; at?: Date } = {}) {
  const w = gw.webhook(type, providerPaymentId, opts);
  const r = await h.inbox.receive(gw.provider, w.raw, w.headers);
  if (r.result === "stored") await h.inbox.processOne(r.id);
  return { ...r, webhook: w };
}

export async function sagaState(h: Harness, sagaId: string) {
  return h.prisma.paymentSaga.findUniqueOrThrow({ where: { id: sagaId }, include: { payment: true } });
}

/**
 * Neutralise what the B3 suites wrote, without switching off any trigger:
 * append-only ledger, event and audit rows are never deleted, even in tests
 * (a Supabase stack does not allow it, and tests must not depend on bypassing
 * those protections). Test products are soft-deleted so catalogue suites never
 * see them; queued jobs and inbox rows of the fake providers are removed so
 * later runs start clean. Orders and payments stay; the B1 migration test only
 * checks rows older than that migration.
 */
export async function cleanupB3(prisma: Prisma): Promise<void> {
  await prisma.$transaction(async (tx) => {
    await tx.$executeRawUnsafe(`UPDATE products SET deleted_at = now() WHERE slug LIKE 'zz-b3-%' AND deleted_at IS NULL`);
    await tx.$executeRawUnsafe(
      `DELETE FROM supplier_jobs WHERE supplier_booking_id IN (SELECT b.id FROM supplier_bookings b JOIN order_items i ON i.id = b.order_item_id JOIN products p ON p.id = i.product_id WHERE p.slug LIKE 'zz-b3-%')`,
    );
    await tx.$executeRawUnsafe(`DELETE FROM payment_events WHERE provider IN ('fake-inr-pacb', 'fake-aed-card')`);
  }, { maxWait: 10_000, timeout: 60_000 });
}
