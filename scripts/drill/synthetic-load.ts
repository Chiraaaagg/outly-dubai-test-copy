/**
 * Synthetic scenario set for the restore drill
 * (docs/backend/24-runbook-restore-drill.md §5).
 *
 *   NODE_OPTIONS=--conditions=react-server node node_modules/tsx/dist/cli.mjs \
 *     scripts/drill/synthetic-load.ts --database=outly_test_drill_src
 *
 * Guard first: `.env.test.local` (or OUTLY_TEST_ENV_FILE) must pass the full
 * target guard, the named database must be an `outly_test_drill_*` database
 * on the same disposable server, and that database must pass the guard's
 * live checks (its marker row) before anything is written. The restore drill
 * (scripts/drill/restore-drill.ts) creates such a database and calls
 * `loadSyntheticScenarios` itself.
 *
 * Synthetic values only: names start "ZZ Drill", emails are @example.test,
 * phones use the unassigned +999 country code, every reference carries
 * ZZDRILL, supplier ids and nets are made-up round numbers (never a real
 * supplier net rate), and no request reaches any provider. Ticket codes and
 * capability tokens are encrypted with the process's key rings
 * (`OUTLY_KEYS_*`, or the non-production fallback ring derived from the
 * local AUTH_JWT_SECRET), so a restored copy can be checked for decryption.
 *
 * The set (one row or more in each state):
 *  - inquiry only (quoted), and an inquiry won and converted to an assisted order;
 *  - instant single-item orders whose sagas are `fulfilled`, `reserved`
 *    (held authorisation, booking `awaiting_payment`), `confirm_pending`
 *    (booking `confirming`, attention), `attention` (booking
 *    `outcome_unknown`, attention), `capture_unknown`, `failed` and
 *    `released` (a late-accepted booking re-blocked, alert event);
 *  - multi-item instant orders: three items `fulfilled` with one item
 *    rejected and refunded, and two items in `reserve_pending`;
 *  - refunds `requested`, `succeeded` and `failed`; remedies;
 *  - cancellation requests `cancelling`, `refund_pending`, `refund_failed`,
 *    `refunded` and an open exception;
 *  - ticket code sets (encrypted), a voucher PDF's metadata, a pending PDF;
 *  - notifications `queued`, `sent` and `failed`; guest capability grants live
 *    and revoked;
 *  - ledger entries in all three books, a settlement, payment inbox rows;
 *  - settings: margin policy, FX input, cost inputs, exposure limits, the
 *    supplier booking control; a feature flag; a privileged approval.
 */
import { createHash, randomBytes } from "node:crypto";
import { pathToFileURL } from "node:url";
import type { Prisma, PrismaClient } from "@prisma/client";
import { encryptFor, hmacFor, sha256Hex, ciphertextKeyId } from "../../src/server/lib/crypto";
import { uuidv7 } from "../../src/server/lib/ids";
import { ROLE_CODES, ROLE_NAMES, ROLE_PERMISSIONS } from "../../src/server/lib/permissions";
import { installEgressBlock } from "../lib/target-guard";

type Db = PrismaClient;

const PROVIDER = "fake-aed-card";
const SUPPLIER_CODE = "traveldesk";
const ENV = "test" as const;
const DAY = 86_400_000;

/** Made-up round amounts, AED minor units. Never a real supplier rate. */
const SELL_AED = 20_000n;
const SELL_INR = 480_000n;
const NET_AED = 15_000n;
const NET_USD = 4_100n;

export interface LoadSummary {
  orders: number;
  inquiries: number;
  supplierBookings: number;
  payments: number;
  refunds: number;
  /** Order references by scenario key, for the incident and the report. */
  refs: Record<string, string>;
  instantProductId: string;
}

function hex64(seed: string): string {
  return createHash("sha256").update(`zz-drill:${seed}`).digest("hex");
}

function dateOnly(d: Date): Date {
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
}

/**
 * Writes the scenario set. The caller has already passed the target guard on
 * `db` (this function never decides the target). Not idempotent: run it once
 * on a freshly migrated database.
 */
export async function loadSyntheticScenarios(db: Db, now = new Date()): Promise<LoadSummary> {
  const at = (minutes: number) => new Date(now.getTime() + minutes * 60_000);
  const serviceDay = (days: number) => dateOnly(new Date(now.getTime() + days * DAY));
  const refs: Record<string, string> = {};
  let bookingCount = 0;
  let paymentCount = 0;
  let refundCount = 0;

  /* ---------------------------------------------------------------- people, roles, reference data */

  for (const code of ROLE_CODES) {
    const id = uuidv7();
    await db.role.create({ data: { id, code, name: ROLE_NAMES[code] } });
    await db.rolePermission.createMany({ data: ROLE_PERMISSIONS[code].map((permission) => ({ roleId: id, permission })) });
  }
  const roleId = async (code: string) => (await db.role.findUniqueOrThrow({ where: { code } })).id;
  const staff = async (label: string, role: string) => {
    const id = uuidv7();
    await db.adminUser.create({
      data: { id, email: `zz-drill-${label}@example.test`, fullName: `ZZ Drill ${label}`, passwordHash: "zz-drill-no-login", totpEnabled: false, status: "active" },
    });
    await db.adminUserRole.create({ data: { adminUserId: id, roleId: await roleId(role) } });
    return id;
  };
  const agentId = await staff("agent", "agent");
  const opsId = await staff("ops", "ops");
  const leadId = await staff("lead", "admin");
  await db.agentAvailability.create({ data: { agentId, status: "available", shift: "GST", title: "ZZ Drill agent" } });

  const supplierId = uuidv7();
  await db.supplier.create({
    data: { id: supplierId, code: SUPPLIER_CODE, name: "ZZ Drill Supplier (synthetic)", source: "api", adapter: "traveldesk", contactEmail: "zz-drill-supplier@example.test" },
  });

  const product = async (slug: string, mode: "inquiry" | "instant") => {
    const id = uuidv7();
    await db.product.create({
      data: {
        id,
        slug,
        title: `ZZ Drill ${slug}`,
        tier: "B",
        categorySlug: "zz-drill",
        confirmation: mode === "instant" ? "instant" : "manual",
        fulfilmentMode: mode,
        content: { zzDrill: true },
        priceFromInr: SELL_INR,
        priceFromAed: SELL_AED,
        durationMinutes: 240,
        publishedAt: at(-60 * 24 * 30),
      },
    });
    await db.productVersion.create({ data: { id: uuidv7(), productId: id, version: 1, content: { zzDrill: true }, status: "published", actorId: opsId, reason: "zz drill" } });
    return id;
  };
  const inquiryProduct = await product("zz-drill-inquiry-tour", "inquiry");
  const instantProduct = await product("zz-drill-instant-tour", "instant");
  const instantProduct2 = await product("zz-drill-instant-cruise", "instant");

  const mappingFor = async (productId: string, offer: string) => {
    const id = uuidv7();
    await db.productSupplierMapping.create({
      data: {
        id,
        productId,
        supplierId,
        variantCode: null,
        supplierProductId: "zz-tour-1",
        supplierOfferId: offer,
        bookingKind: "live_book",
        environment: ENV,
        approvedOfferHash: hex64(`offer:${offer}`),
        syncStatus: "ok",
        lastSyncedAt: at(-60),
      },
    });
    await db.supplierCatalogueItem.create({
      data: { id: uuidv7(), supplierId, environment: ENV, kind: "offer", externalId: offer, parentExternalId: "zz-tour-1", name: `ZZ Drill offer ${offer}`, bookingKind: "live_book", payload: { zzDrill: true }, payloadHash: hex64(`offer:${offer}`) },
    });
    await db.supplierPriceSnapshot.create({
      data: { id: uuidv7(), supplierId, environment: ENV, offerExternalId: offer, serviceDate: serviceDay(10), isBookable: true, netAdultMinor: 7_500n, netChildMinor: 5_000n, netTripMinor: 0n },
    });
    return id;
  };
  const mapping1 = await mappingFor(instantProduct, "zz-offer-1");
  const mapping2 = await mappingFor(instantProduct2, "zz-offer-2");
  for (const p of [instantProduct, instantProduct2]) {
    await db.productEligibility.create({ data: { productId: p, effectiveMode: "inquiry", reasons: ["release_switch_off"], readinessVersion: 4 } });
  }
  await db.supplierAccountLease.create({ data: { supplierId, environment: ENV, accountId: "default", holder: null, generation: 3n, heartbeatAt: at(-30) } });

  /* ---------------------------------------------------------------- settings (FX, margin, controls) */

  const settings: Record<string, Prisma.InputJsonValue> = {
    "pricing.margin_policy": { version: 1, floorBps: 1500, effectiveFrom: at(-60 * 24 * 7).toISOString() },
    "pricing.fx_inr_per_aed": { version: 3, inrPerAed: "24.00", source: "ZZ drill synthetic input", recordedAt: at(-60).toISOString(), expiresAt: at(60 * 24 * 6).toISOString() },
    "pricing.margin_cost_inputs": { version: 2, source: "ZZ drill synthetic input", recordedAt: at(-60).toISOString(), lines: [{ name: "zz gateway fee", kind: "percent_of_charge", bps: 300 }] },
    "payments.exposure_limits": { maxUncapturedHolds: 3, maxRiskyPaymentsPer15Min: 5, outlyFundedWindowDays: 30, outlyFundedCapMinor: { INR: 0, AED: 0 }, maxInstantOrderAedMinor: 50_000 },
    [`supplier_bookings.${SUPPLIER_CODE}.${ENV}.default`]: { paused: false, scope: "new_sales", maxBookingNetMinor: 500_000, minFundsAfterMinor: 0 },
  };
  // The margin policy row is written by a migration; the drill records its own version over it.
  for (const [key, value] of Object.entries(settings)) await db.setting.upsert({ where: { key }, create: { key, value, updatedBy: leadId }, update: { value, updatedBy: leadId } });
  await db.featureFlag.create({ data: { key: "zz_drill_flag", enabled: true, rolloutPct: 100 } });
  await db.privilegedApproval.create({
    data: {
      id: uuidv7(),
      operation: "instant.activate",
      permission: "products.activate_instant",
      payload: { productId: instantProduct, zzDrill: true },
      payloadHash: hex64("approval:1"),
      environment: ENV,
      status: "applied",
      requestedBy: opsId,
      requestedAt: at(-120),
      approvedBy: leadId,
      approvedAt: at(-110),
      appliedAt: at(-109),
      expiresAt: at(60 * 24),
    },
  });

  /* ---------------------------------------------------------------- customers and inquiries */

  const customerId = uuidv7();
  await db.customer.create({ data: { id: customerId, phoneE164: "+999000000001", email: "zz-drill-customer@example.test", fullName: "ZZ Drill Customer", preferredCurrency: "AED" } });
  await db.customerSession.create({ data: { id: uuidv7(), customerId, tokenHash: hex64("customer-session:1"), expiresAt: at(60 * 24) } });

  const inquiry = async (key: string, status: "quoted" | "won", n: number) => {
    const id = uuidv7();
    refs[key] = `INQ-ZZDRILL-${n}`;
    await db.inquiry.create({
      data: {
        id,
        reference: refs[key],
        // A won inquiry needs its order (inquiry_won_has_order); the conversion below sets both.
        status: "quoted",
        source: "inquiry_form",
        leadName: `ZZ Drill Lead ${n}`,
        leadPhone: `+99900000010${n}`,
        leadEmail: `zz-drill-lead-${n}@example.test`,
        countryCode: "AE",
        travelDateFrom: serviceDay(14),
        travelDateTo: serviceDay(16),
        pax: { adults: 2, children: 0 },
        currency: "AED",
        indicativeTotalAed: SELL_AED,
        indicativeTotalInr: SELL_INR,
        indicativeNetCostAed: NET_AED,
        assignedAgentId: agentId,
        assignedAt: at(-50),
        firstResponseAt: at(-45),
        customerId: n === 1 ? customerId : null,
        createdAt: at(-60),
      },
    });
    await db.inquiryItem.create({
      data: {
        id: uuidv7(),
        inquiryId: id,
        productId: inquiryProduct,
        serviceDate: serviceDay(14),
        pax: { adults: 2 },
        titleSnapshot: "ZZ Drill inquiry tour",
        tierSnapshot: "B",
        slugSnapshot: "zz-drill-inquiry-tour",
        kindSnapshot: "activity",
        confirmationSnapshot: "manual",
        fulfilmentModeSnapshot: "inquiry",
        freeCancellationHoursSnapshot: 24,
        durationMinutesSnapshot: 240,
        indicativeUnitInr: SELL_INR / 2n,
        indicativeUnitAed: SELL_AED / 2n,
        indicativeTotalInr: SELL_INR,
        indicativeTotalAed: SELL_AED,
        indicativeNetCostAed: NET_AED,
      },
    });
    const ladder: ["new" | "assigned" | "contacted" | "quoted" | "won", "new" | "assigned" | "contacted" | "quoted" | "won"][] = [
      ["new", "assigned"],
      ["assigned", "contacted"],
      ["contacted", "quoted"],
    ];
    if (status === "won") ladder.push(["quoted", "won"]);
    for (const [i, [from, to]] of ladder.entries()) {
      await db.inquiryEvent.create({ data: { inquiryId: id, kind: "status", fromStatus: from, toStatus: to, actorType: "agent", actorId: agentId, note: "zz drill", createdAt: at(-50 + i) } });
    }
    await db.consent.create({
      data: { id: uuidv7(), phoneE164: `+99900000010${n}`, channel: "whatsapp", purpose: "transactional", granted: true, source: "zz_drill_form", evidence: { zzDrill: true } },
    });
    await db.notification.create({
      data: { id: uuidv7(), event: "inquiry.ack", channel: "email", recipient: `zz-drill-lead-${n}@example.test`, inquiryId: id, template: "inquiry_ack", status: "sent", sentAt: at(-59), dedupKey: `zz-drill:inquiry-ack:${n}` },
    });
    return id;
  };
  await inquiry("inquiry_only", "quoted", 1);
  const wonInquiry = await inquiry("inquiry_won", "won", 2);

  /* ---------------------------------------------------------------- order helpers */

  interface ItemSpec {
    productId: string;
    mappingId: string | null;
    offer: string;
    status: "pending" | "confirmed" | "rejected" | "cancelled";
  }

  const createOrder = async (
    key: string,
    n: number,
    o: { rail: "self_serve" | "assisted"; status: Prisma.OrderCreateInput["status"]; items: ItemSpec[]; customer?: boolean; agent?: boolean; sourceInquiryId?: string; collection?: "gateway" | "manual_link" },
  ) => {
    const id = uuidv7();
    refs[key] = `OUT-ZZDRILL-${String(n).padStart(2, "0")}`;
    const count = BigInt(o.items.length);
    const guestId = uuidv7();
    await db.guest.create({ data: { id: guestId, phoneE164: `+9990000002${String(n).padStart(2, "0")}`, email: `zz-drill-guest-${n}@example.test`, fullName: `ZZ Drill Guest ${n}` } });
    await db.order.create({
      data: {
        id,
        reference: refs[key],
        status: o.status,
        rail: o.rail,
        guestId,
        customerId: o.customer ? customerId : null,
        createdByAgent: o.agent ? agentId : null,
        sourceInquiryId: o.sourceInquiryId ?? null,
        paymentCollection: o.collection ?? "gateway",
        currency: "AED",
        subtotalAed: SELL_AED * count,
        subtotalInr: SELL_INR * count,
        totalAed: SELL_AED * count,
        totalInr: SELL_INR * count,
        netCostAed: NET_AED * count,
        leadName: `ZZ Drill Guest ${n}`,
        leadEmail: `zz-drill-guest-${n}@example.test`,
        leadPhone: `+9990000002${String(n).padStart(2, "0")}`,
        placedAt: at(-40 + n),
      },
    });
    let quoteId: string | null = null;
    if (o.rail === "self_serve") {
      quoteId = uuidv7();
      const sessionId = uuidv7();
      if (!o.customer) await db.guestSession.create({ data: { id: sessionId, tokenHash: hex64(`guest-session:${n}`), createdAt: at(-45), expiresAt: at(60 * 24) } });
      await db.quote.create({
        data: {
          id: quoteId,
          fingerprint: hex64(`quote:${n}`),
          ownerKind: o.customer ? "customer" : "guest",
          customerId: o.customer ? customerId : null,
          guestSessionId: o.customer ? null : sessionId,
          currency: "AED",
          totalMinor: SELL_AED * count,
          lines: o.items.map((it, i) => ({ productId: it.productId, mappingId: it.mappingId, line: i, zzDrill: true })),
          request: { zzDrill: true },
          status: "used",
          usedByOrderId: id,
          createdAt: at(-45),
          expiresAt: at(-15),
        },
      });
    }
    const items: string[] = [];
    for (const [i, it] of o.items.entries()) {
      const itemId = uuidv7();
      items.push(itemId);
      const instant = o.rail === "self_serve";
      await db.orderItem.create({
        data: {
          id: itemId,
          orderId: id,
          productId: it.productId,
          mappingId: it.mappingId,
          titleSnapshot: "ZZ Drill tour",
          tierSnapshot: "B",
          slugSnapshot: "zz-drill-tour",
          kindSnapshot: "activity",
          confirmationSnapshot: instant ? "instant" : "manual",
          fulfilmentModeSnapshot: instant ? "instant" : "inquiry",
          freeCancellationHoursSnapshot: 0,
          durationMinutesSnapshot: 240,
          serviceDate: serviceDay(10 + i),
          pax: { adults: 2 },
          unitAed: SELL_AED / 2n,
          unitInr: SELL_INR / 2n,
          totalAed: SELL_AED,
          totalInr: SELL_INR,
          netCostAed: NET_AED,
          status: it.status,
          fulfilmentOrigin: instant ? "instant_checkout" : "assisted_conversion",
          chargedCurrency: instant ? "AED" : null,
          chargedAmountMinor: instant ? SELL_AED : null,
          quoteId,
          quoteLineIndex: instant ? i : null,
          marginSnapshot: instant ? { floorBps: 1500, policyVersion: 1, zzDrill: true } : undefined,
        },
      });
    }
    return { id, items, quoteId, guestId };
  };

  const payment = async (
    key: string,
    orderId: string,
    quoteId: string | null,
    p: { amount: bigint; status: Prisma.PaymentCreateInput["status"]; captured: bigint; authorizedMinutesAgo?: number; captureMinutesAgo?: number },
  ) => {
    const id = uuidv7();
    paymentCount++;
    await db.payment.create({
      data: {
        id,
        orderId,
        gateway: PROVIDER,
        gatewayOrderId: `zz-po-${key}`,
        gatewayPaymentId: `zz-pay-${key}`,
        method: "card",
        amountMinor: p.amount,
        currency: "AED",
        status: p.status,
        source: "gateway_verified",
        rail: "aed_card",
        provider: PROVIDER,
        providerAccountId: "zz-drill-account",
        environment: ENV,
        providerOrderId: `zz-po-${key}`,
        idempotencyKey: `zz-drill:payment:${key}`,
        authorizedAt: p.authorizedMinutesAgo !== undefined ? at(-p.authorizedMinutesAgo) : null,
        authorizationExpiresAt: p.authorizedMinutesAgo !== undefined ? at(60 * 24 * 6) : null,
        capturedMinor: p.captured,
        capturedAt: p.captured > 0n ? at(-(p.captureMinutesAgo ?? 20)) : null,
        threeDs: "passed",
        risk: "normal",
        quoteId,
        createdAt: at(-35),
      },
    });
    if (p.captured > 0n) {
      await ledger("customer_money", { orderId, paymentId: id, amount: p.captured, kind: "capture", evidence: `capture:${ENV}:${PROVIDER}:zz-pay-${key}:${p.captured}` });
    }
    return id;
  };

  const ledger = async (book: "customer_money" | "supplier_wallet" | "gateway_settlement", e: { orderId?: string | null; paymentId?: string | null; bookingId?: string | null; amount: bigint; kind: string; evidence: string }) => {
    await db.ledgerEntry.create({
      data: { id: uuidv7(), book, orderId: e.orderId ?? null, paymentId: e.paymentId ?? null, supplierBookingId: e.bookingId ?? null, currency: "AED", amountMinor: e.amount, kind: e.kind, evidenceRef: e.evidence, occurredAt: at(-10) },
    });
  };

  const saga = async (orderId: string, orderItemId: string, paymentId: string | null, state: string, opts: { attention?: boolean; version?: number } = {}) => {
    await db.paymentSaga.create({
      data: { id: uuidv7(), orderId, orderItemId, paymentId, rail: "aed_card", state, version: opts.version ?? 4, deadlineAt: at(90), attentionRequiredAt: opts.attention ? at(-5) : null, checkedAt: at(-2), createdAt: at(-35) },
    });
  };

  const booking = async (
    key: string,
    orderId: string,
    orderItemId: string,
    offer: string,
    b: { state: Prisma.SupplierBookingCreateInput["state"]; afterReserve?: string; charged?: boolean; supplierId?: boolean; attention?: boolean; errorCode?: string; refund?: bigint; history: string[]; serviceDays?: number },
  ) => {
    const id = uuidv7();
    bookingCount++;
    const ref = `OUTTD-ZZDRILL-${key.toUpperCase().replace(/[^A-Z0-9]/g, "")}`;
    const sent = b.supplierId ?? b.state !== "queued";
    await db.supplierBooking.create({
      data: {
        id,
        orderId,
        orderItemId,
        supplierId,
        environment: ENV,
        idempotencyKey: `zz-drill:booking:${key}`,
        clientRef: ref,
        bookingKind: "live_book",
        afterReserve: b.afterReserve ?? "confirm",
        state: b.state,
        tourExternalId: "zz-tour-1",
        offerExternalId: offer,
        serviceDate: serviceDay(b.serviceDays ?? 10),
        timeSlotId: "zz-slot-1",
        startMinutes: 600,
        adults: 2,
        guestName: "ZZ Drill Guest",
        expectedNetMinor: NET_AED,
        expectedNetUsdMinor: NET_USD,
        chargedNetMinor: b.charged ? NET_AED : null,
        chargedNetUsdMinor: b.charged ? NET_USD : null,
        refundMinor: b.refund ?? null,
        supplierBookingId: sent ? `zz-sb-${key}` : null,
        supplierStatusCode: sent ? 1 : null,
        reservationDeadline: ["awaiting_payment", "reserved"].includes(b.state as string) ? at(45) : null,
        hasTickets: b.state === "confirmed",
        errorCode: b.errorCode ?? null,
        attentionRequiredAt: b.attention ? at(-4) : null,
        requestPayload: { zzDrill: true },
        requestSentAt: sent ? at(-30) : null,
        reservedAt: sent ? at(-29) : null,
        confirmedAt: b.state === "confirmed" ? at(-25) : null,
        cancelledAt: b.state === "cancelled" ? at(-8) : null,
        closedAt: ["cancelled", "rejected", "expired", "not_created"].includes(b.state as string) ? at(-8) : null,
        requestHash: hex64(`request:${key}`),
        accountId: "default",
        createdAt: at(-31),
      },
    });
    let from: string | null = null;
    for (const [i, to] of b.history.entries()) {
      await db.supplierBookingEvent.create({ data: { id: uuidv7(), supplierBookingId: id, at: at(-31 + i), kind: "transition", fromState: from, toState: to, actor: "engine", detail: { zzDrill: true } } });
      from = to;
    }
    if (b.charged) await ledger("supplier_wallet", { orderId, bookingId: id, amount: -NET_AED, kind: "charged", evidence: `wallet:${ENV}:${SUPPLIER_CODE}:zz-sb-${key}:charged` });
    if (b.refund) await ledger("supplier_wallet", { orderId, bookingId: id, amount: b.refund, kind: "refunded", evidence: `wallet:${ENV}:${SUPPLIER_CODE}:zz-sb-${key}:refunded` });
    return id;
  };

  const refund = async (key: string, paymentId: string, orderItemId: string, amount: bigint, status: "requested" | "succeeded" | "failed", orderId: string) => {
    const id = uuidv7();
    refundCount++;
    await db.refund.create({
      data: { id, paymentId, orderItemId, provider: PROVIDER, providerRefundId: status === "requested" ? null : `zz-rf-${key}`, idempotencyKey: `zz-drill:refund:${key}`, amountMinor: amount, currency: "AED", status, reason: "zz_drill_cancellation", requestedBy: opsId },
    });
    if (status === "succeeded") {
      const p = await db.payment.findUniqueOrThrow({ where: { id: paymentId } });
      const refunded = p.refundedMinor + amount;
      await db.payment.update({ where: { id: paymentId }, data: { refundedMinor: refunded, status: refunded === p.capturedMinor ? "refunded" : "partially_refunded" } });
      await ledger("customer_money", { orderId, paymentId, amount: -amount, kind: "refund", evidence: `refund:${ENV}:${PROVIDER}:zz-rf-${key}` });
    }
    return id;
  };

  const ticketCodes = async (bookingId: string, orderId: string, orderItemId: string, key: string) => {
    const docId = uuidv7();
    await db.supplierDocument.create({
      data: { id: docId, supplierBookingId: bookingId, orderId, orderItemId, kind: "ticket_codes", version: 1, status: "valid", source: "confirm_response", unitsExpected: { adult: 2 }, unitsIssued: { adult: 2 }, issuedEvidence: "confirm_response", validatedAt: at(-24) },
    });
    for (let i = 0; i < 2; i++) {
      const code = `ZZDRILL-${key}-${i}-${randomBytes(4).toString("hex")}`;
      const codeCiphertext = encryptFor("ticket_codes", code);
      await db.supplierTicketCode.create({
        data: { id: uuidv7(), documentId: docId, supplierBookingId: bookingId, unitIndex: i, ticketFor: "adult", ticketTypeName: "ZZ Drill adult", displayType: 1, codeCiphertext, codeKeyId: ciphertextKeyId(codeCiphertext), codeHash: hmacFor("ticket_code_hash", code), validUntil: serviceDay(11) },
      });
    }
    return docId;
  };

  /* ---------------------------------------------------------------- assisted order (from the won inquiry) */

  {
    const o = await createOrder("assisted", 1, { rail: "assisted", status: "paid", items: [{ productId: inquiryProduct, mappingId: null, offer: "-", status: "pending" }], agent: true, sourceInquiryId: wonInquiry, collection: "manual_link" });
    await db.inquiry.update({ where: { id: wonInquiry }, data: { status: "won", convertedOrderId: o.id } });
    paymentCount++;
    await db.payment.create({
      data: { id: uuidv7(), orderId: o.id, gateway: "manual", paymentLinkId: "zz-link-1", method: "upi", amountMinor: SELL_AED, currency: "AED", status: "captured", source: "manual", recordedBy: agentId, capturedMinor: SELL_AED, capturedAt: at(-20) },
    });
    await db.auditLog.create({ data: { actorType: "agent", actorId: agentId, action: "order.convert", entityType: "order", entityId: o.id, after: { zzDrill: true } } });
  }

  /* ---------------------------------------------------------------- instant: fulfilled, tickets valid */

  {
    const o = await createOrder("fulfilled", 2, { rail: "self_serve", status: "confirmed", items: [{ productId: instantProduct, mappingId: mapping1, offer: "zz-offer-1", status: "confirmed" }], customer: true });
    const pay = await payment("fulfilled", o.id, o.quoteId, { amount: SELL_AED, status: "captured", captured: SELL_AED, authorizedMinutesAgo: 34 });
    const b = await booking("fulfilled", o.id, o.items[0], "zz-offer-1", { state: "confirmed", charged: true, history: ["queued", "reserving", "awaiting_payment", "confirming", "confirmed"] });
    await saga(o.id, o.items[0], pay, "fulfilled", { version: 7 });
    await ticketCodes(b, o.id, o.items[0], "fulfilled");
    await db.supplierDocument.create({
      data: { id: uuidv7(), supplierBookingId: b, orderId: o.id, orderItemId: o.items[0], kind: "voucher_pdf", version: 1, status: "valid", source: "pdf_download", storageKey: `test/${randomBytes(16).toString("hex")}`, contentType: "application/pdf", byteSize: 48_213, sha256: hex64("voucher:fulfilled"), validatedAt: at(-23) },
    });
    const sent = uuidv7();
    await db.notification.create({ data: { id: sent, event: "order.tickets_ready", channel: "email", recipient: "zz-drill-guest-2@example.test", orderId: o.id, template: "tickets_ready", status: "sent", providerId: "zz-msg-1", sentAt: at(-22), dedupKey: `zz-drill:tickets:${o.id}` } });
    const token = randomBytes(32).toString("base64url");
    await db.guestCapabilityGrant.create({
      data: { id: uuidv7(), tokenHash: sha256Hex(token), tokenCiphertext: encryptFor("capability_tokens", token), orderId: o.id, purpose: "download_tickets", issuedFor: "ticket_notification", notificationId: sent, expiresAt: at(60 * 24 * 14), createdAt: at(-22) },
    });
    await db.guestCapabilityGrant.create({
      data: { id: uuidv7(), tokenHash: sha256Hex(randomBytes(32).toString("base64url")), tokenCiphertext: null, orderId: o.id, purpose: "view_status", issuedFor: "status_notification", expiresAt: at(60 * 24 * 14), revokedAt: at(-21), revokeReason: "superseded", createdAt: at(-30) },
    });
    const quote = await db.quote.findUniqueOrThrow({ where: { id: o.quoteId! } });
    await db.orderContactVerification.create({ data: { id: uuidv7(), quoteId: quote.id, orderId: o.id, channel: "email", contactHash: sha256Hex("zz-drill-guest-2@example.test"), method: "email_code", verifiedAt: at(-36) } });
    await db.orderAttribution.create({ data: { orderId: o.id, firstSource: "zz-drill", firstMedium: "synthetic", firstTouchAt: at(-60), lastSource: "zz-drill", lastTouchAt: at(-40) } });
    await db.supplierJob.create({ data: { id: uuidv7(), kind: "confirm", supplierBookingId: b, dedupeKey: `zz-drill:confirm:${b}`, status: "succeeded", attempts: 1, runAfter: at(-26) } });
    await db.cancellationRequest.create({
      data: { id: uuidv7(), orderId: o.id, orderItemId: o.items[0], supplierBookingId: b, kind: "exception", status: "exception_open", requestedVia: "customer", reasonCode: "zz_drill.exception", eligibility: { supported: false, reason: "tickets_issued" } },
    });
  }

  /* ---------------------------------------------------------------- instant: reserved, held authorisation */

  {
    const o = await createOrder("awaiting_payment", 3, { rail: "self_serve", status: "pending_payment", items: [{ productId: instantProduct, mappingId: mapping1, offer: "zz-offer-1", status: "pending" }] });
    const pay = await payment("awaiting_payment", o.id, o.quoteId, { amount: SELL_AED, status: "authorized", captured: 0n, authorizedMinutesAgo: 6 });
    await booking("awaiting_payment", o.id, o.items[0], "zz-offer-1", { state: "awaiting_payment", afterReserve: "await_payment", charged: true, history: ["queued", "reserving", "awaiting_payment"] });
    await saga(o.id, o.items[0], pay, "reserved", { version: 3 });
    await db.notification.create({ data: { id: uuidv7(), event: "order.payment_pending", channel: "email", recipient: "zz-drill-guest-3@example.test", orderId: o.id, template: "payment_pending", status: "queued", scheduledFor: at(5), dedupKey: `zz-drill:pending:${o.id}` } });
  }

  /* ---------------------------------------------------------------- instant: confirming, attention */

  {
    const o = await createOrder("confirming", 4, { rail: "self_serve", status: "supplier_pending", items: [{ productId: instantProduct, mappingId: mapping1, offer: "zz-offer-1", status: "pending" }] });
    const pay = await payment("confirming", o.id, o.quoteId, { amount: SELL_AED, status: "captured", captured: SELL_AED, authorizedMinutesAgo: 20, captureMinutesAgo: 12 });
    await booking("confirming", o.id, o.items[0], "zz-offer-1", { state: "confirming", charged: true, attention: true, history: ["queued", "reserving", "awaiting_payment", "confirming"] });
    await saga(o.id, o.items[0], pay, "confirm_pending", { attention: true, version: 5 });
  }

  /* ---------------------------------------------------------------- instant: outcome unknown, attention */

  {
    const o = await createOrder("outcome_unknown", 5, { rail: "self_serve", status: "supplier_pending", items: [{ productId: instantProduct, mappingId: mapping1, offer: "zz-offer-1", status: "pending" }] });
    const pay = await payment("outcome_unknown", o.id, o.quoteId, { amount: SELL_AED, status: "captured", captured: SELL_AED, authorizedMinutesAgo: 25, captureMinutesAgo: 15 });
    const b = await booking("outcome_unknown", o.id, o.items[0], "zz-offer-1", { state: "outcome_unknown", attention: true, errorCode: "confirm_timeout", history: ["queued", "reserving", "awaiting_payment", "confirming", "outcome_unknown"] });
    await saga(o.id, o.items[0], pay, "attention", { attention: true, version: 6 });
    await db.supplierJob.create({ data: { id: uuidv7(), kind: "recover", supplierBookingId: b, dedupeKey: `zz-drill:recover:${b}`, status: "queued", runAfter: at(3), maxAttempts: 10 } });
  }

  /* ---------------------------------------------------------------- instant: capture unknown, and failed */

  {
    const o = await createOrder("capture_unknown", 6, { rail: "self_serve", status: "pending_payment", items: [{ productId: instantProduct2, mappingId: mapping2, offer: "zz-offer-2", status: "pending" }] });
    const pay = await payment("capture_unknown", o.id, o.quoteId, { amount: SELL_AED, status: "capture_unknown", captured: 0n, authorizedMinutesAgo: 9 });
    await booking("capture_unknown", o.id, o.items[0], "zz-offer-2", { state: "awaiting_payment", afterReserve: "await_payment", charged: true, history: ["queued", "reserving", "awaiting_payment"] });
    await saga(o.id, o.items[0], pay, "capture_unknown", { attention: true, version: 4 });
  }
  {
    const o = await createOrder("payment_failed", 7, { rail: "self_serve", status: "payment_failed", items: [{ productId: instantProduct2, mappingId: mapping2, offer: "zz-offer-2", status: "cancelled" }] });
    const pay = await payment("payment_failed", o.id, o.quoteId, { amount: SELL_AED, status: "failed", captured: 0n });
    await db.payment.update({ where: { id: pay }, data: { failureCode: "card_declined", failureReason: "ZZ drill synthetic decline" } });
    await saga(o.id, o.items[0], pay, "failed", { version: 2 });
  }

  /* ---------------------------------------------------------------- instant: late-accepted booking, re-blocked */

  {
    const o = await createOrder("late_accepted", 8, { rail: "self_serve", status: "cancelled", items: [{ productId: instantProduct, mappingId: mapping1, offer: "zz-offer-1", status: "cancelled" }] });
    const pay = await payment("late_accepted", o.id, o.quoteId, { amount: SELL_AED, status: "voided", captured: 0n, authorizedMinutesAgo: 30 });
    await db.payment.update({ where: { id: pay }, data: { voidedAt: at(-12) } });
    const b = await booking("late_accepted", o.id, o.items[0], "zz-offer-1", { state: "outcome_unknown", attention: true, errorCode: "late_acceptance", history: ["queued", "reserving", "awaiting_payment", "expired", "outcome_unknown"] });
    await db.supplierBookingEvent.create({ data: { id: uuidv7(), supplierBookingId: b, at: at(-3), kind: "alert", actor: "reconcile", detail: { reason: "late_acceptance", supplierStatus: "CONFIRMED" } } });
    await saga(o.id, o.items[0], pay, "released", { version: 5 });
    await db.customerRemedy.create({
      data: { id: uuidv7(), orderId: o.id, orderItemId: o.items[0], supplierBookingId: b, kind: "release_authorization", reason: "hold_expired", amountMinor: SELL_AED, currency: "AED", status: "completed" },
    });
  }

  /* ---------------------------------------------------------------- multi-item: three items, one rejected and refunded */

  {
    const o = await createOrder("multi_partial", 9, {
      rail: "self_serve",
      status: "partially_confirmed",
      items: [
        { productId: instantProduct, mappingId: mapping1, offer: "zz-offer-1", status: "confirmed" },
        { productId: instantProduct2, mappingId: mapping2, offer: "zz-offer-2", status: "confirmed" },
        { productId: instantProduct, mappingId: mapping1, offer: "zz-offer-1", status: "rejected" },
      ],
    });
    const pay = await payment("multi_partial", o.id, o.quoteId, { amount: SELL_AED * 3n, status: "captured", captured: SELL_AED * 3n, authorizedMinutesAgo: 33 });
    const b1 = await booking("multi_partial_1", o.id, o.items[0], "zz-offer-1", { state: "confirmed", charged: true, history: ["queued", "reserving", "awaiting_payment", "confirming", "confirmed"] });
    const b2 = await booking("multi_partial_2", o.id, o.items[1], "zz-offer-2", { state: "confirmed", charged: true, history: ["queued", "reserving", "awaiting_payment", "confirming", "confirmed"], serviceDays: 11 });
    const b3 = await booking("multi_partial_3", o.id, o.items[2], "zz-offer-1", { state: "rejected", history: ["queued", "reserving", "rejected"], serviceDays: 12 });
    await saga(o.id, o.items[0], pay, "fulfilled", { version: 9 });
    await ticketCodes(b1, o.id, o.items[0], "multi1");
    await ticketCodes(b2, o.id, o.items[1], "multi2");
    const r = await refund("multi_partial_3", pay, o.items[2], SELL_AED, "succeeded", o.id);
    await db.customerRemedy.create({ data: { id: uuidv7(), orderId: o.id, orderItemId: o.items[2], supplierBookingId: b3, kind: "refund", reason: "item_rejected", amountMinor: SELL_AED, currency: "AED", status: "completed", refundId: r } });
  }

  /* ---------------------------------------------------------------- multi-item: two items, reserve pending */

  {
    const o = await createOrder("multi_reserving", 10, {
      rail: "self_serve",
      status: "pending_payment",
      items: [
        { productId: instantProduct, mappingId: mapping1, offer: "zz-offer-1", status: "pending" },
        { productId: instantProduct2, mappingId: mapping2, offer: "zz-offer-2", status: "pending" },
      ],
    });
    const pay = await payment("multi_reserving", o.id, o.quoteId, { amount: SELL_AED * 2n, status: "authorized", captured: 0n, authorizedMinutesAgo: 4 });
    await booking("multi_reserving_1", o.id, o.items[0], "zz-offer-1", { state: "awaiting_payment", afterReserve: "await_payment", charged: true, history: ["queued", "reserving", "awaiting_payment"] });
    await booking("multi_reserving_2", o.id, o.items[1], "zz-offer-2", { state: "queued", afterReserve: "await_payment", history: ["queued"], serviceDays: 11 });
    await saga(o.id, o.items[0], pay, "reserve_pending", { version: 3 });
  }

  /* ---------------------------------------------------------------- cancellations and refunds after fulfilment */

  const cancelled = async (key: string, n: number, c: { booking: "cancelling" | "cancelled"; request: "cancelling" | "refund_pending" | "refund_failed" | "refunded"; refund?: "requested" | "failed" | "succeeded" }) => {
    const o = await createOrder(key, n, { rail: "self_serve", status: c.request === "refunded" ? "refunded" : "confirmed", items: [{ productId: instantProduct, mappingId: mapping1, offer: "zz-offer-1", status: c.booking === "cancelled" ? "cancelled" : "confirmed" }] });
    const pay = await payment(key, o.id, o.quoteId, { amount: SELL_AED, status: "captured", captured: SELL_AED, authorizedMinutesAgo: 30 });
    const history = ["queued", "reserving", "awaiting_payment", "confirming", "confirmed", "cancelling"];
    if (c.booking === "cancelled") history.push("cancelled");
    const b = await booking(key, o.id, o.items[0], "zz-offer-1", { state: c.booking, charged: true, refund: c.booking === "cancelled" ? NET_AED : undefined, history });
    await saga(o.id, o.items[0], pay, "fulfilled", { version: 7 });
    const r = c.refund ? await refund(key, pay, o.items[0], SELL_AED, c.refund, o.id) : null;
    await db.cancellationRequest.create({
      data: {
        id: uuidv7(),
        orderId: o.id,
        orderItemId: o.items[0],
        supplierBookingId: b,
        kind: "supported",
        status: c.request,
        requestedVia: n % 2 ? "guest" : "customer",
        eligibility: { supported: true, fullRefund: true },
        reasonCode: "zz_drill.change_of_plans",
        refundId: r,
        attentionRequiredAt: c.request === "refund_failed" ? at(-3) : null,
        closedAt: c.request === "refunded" ? at(-2) : null,
      },
    });
    if (c.refund === "failed") {
      await db.customerRemedy.create({ data: { id: uuidv7(), orderId: o.id, orderItemId: o.items[0], supplierBookingId: b, kind: "refund", reason: "customer_cancellation", amountMinor: SELL_AED, currency: "AED", status: "failed" } });
      await db.notification.create({ data: { id: uuidv7(), event: "ops.refund_failed", channel: "email", recipient: "zz-drill-ops@example.test", orderId: o.id, template: "ops_alert", status: "failed", providerError: "zz drill synthetic", failedAt: at(-2), attentionRequiredAt: at(-2), dedupKey: `zz-drill:refund-failed:${o.id}` } });
    }
  };
  await cancelled("cancel_cancelling", 11, { booking: "cancelling", request: "cancelling" });
  await cancelled("cancel_refund_pending", 12, { booking: "cancelled", request: "refund_pending", refund: "requested" });
  await cancelled("cancel_refund_failed", 13, { booking: "cancelled", request: "refund_failed", refund: "failed" });
  await cancelled("cancel_refunded", 14, { booking: "cancelled", request: "refunded", refund: "succeeded" });

  /* ---------------------------------------------------------------- gateway inbox, settlement, audit */

  await db.paymentEvent.create({ data: { id: uuidv7(), provider: PROVIDER, providerEventId: "zz-evt-1", state: "processed", type: "payment.captured", providerPaymentId: "zz-pay-fulfilled", payloadDigest: hex64("evt:1"), attempts: 1, processedAt: at(-20) } });
  await db.paymentEvent.create({ data: { id: uuidv7(), provider: PROVIDER, providerEventId: "zz-evt-2", state: "processing_failed", type: "payment.captured", providerPaymentId: "zz-pay-confirming", payloadDigest: hex64("evt:2"), attempts: 2, lastErrorCode: "db_unavailable", nextAttemptAt: at(5) } });
  const settlementId = uuidv7();
  await db.settlement.create({ data: { id: settlementId, provider: PROVIDER, providerSettlementId: "zz-st-1", currency: "AED", grossMinor: SELL_AED * 4n, feeMinor: 2_400n, netMinor: SELL_AED * 4n - 2_400n, settledAt: at(-1), rawDigest: hex64("settlement:1") } });
  await ledger("gateway_settlement", { amount: SELL_AED * 4n - 2_400n, kind: "settlement", evidence: `settlement:${ENV}:${PROVIDER}:zz-st-1` });
  await db.webhookEvent.create({ data: { id: uuidv7(), provider: "zz-drill", providerEventId: "zz-wh-1", eventType: "synthetic", payload: { zzDrill: true }, signatureValid: true, processedAt: at(-1) } });
  await db.suppressedContact.create({ data: { contactHash: hex64("suppressed:1"), channel: "email", reason: "zz_drill_bounce" } });
  for (const [i, action] of ["drill.loaded", "settings.update", "supplier.control"].entries()) {
    await db.auditLog.create({ data: { actorType: "system", action, entityType: "drill", entityId: `zz-drill-${i}`, after: { zzDrill: true }, createdAt: at(-1) } });
  }

  const [orders, inquiries] = await Promise.all([db.order.count(), db.inquiry.count()]);
  return { orders, inquiries, supplierBookings: bookingCount, payments: paymentCount, refunds: refundCount, refs, instantProductId: instantProduct };
}

/* ------------------------------------------------------------------ CLI */

async function main() {
  installEgressBlock();
  const arg = process.argv.slice(2).find((a) => a.startsWith("--database="))?.slice("--database=".length);
  if (!arg) throw new Error("usage: synthetic-load.ts --database=outly_test_drill_<name>");
  const { openMain, openDrillDb } = await import("./drill-db");
  const main = await openMain();
  try {
    const drill = await openDrillDb(main, arg);
    try {
      const summary = await loadSyntheticScenarios(drill.client);
      console.log(JSON.stringify({ database: drill.name, ...summary }, null, 2));
    } finally {
      await drill.client.$disconnect();
    }
  } finally {
    await main.client.$disconnect();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((e) => {
    console.error(`synthetic-load: ${e instanceof Error ? e.message : String(e)}`);
    process.exit(2);
  });
}
