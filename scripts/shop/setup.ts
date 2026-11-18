/**
 * Local test shop: prepare the shop database (scripts/shop/README.md).
 *
 * Writes to the LOCAL disposable shop database only (target guard): the
 * pricing and payment settings the instant path needs, TravelDesk TEST
 * mappings for a few seeded products, local test prices that clear the
 * margin floor, and instant mode. Then re-runs readiness and prints each
 * product's effective mode and blockers.
 *
 * Nothing here touches TravelDesk or Stripe. Run after
 * `scripts/traveldesk-sync-local.ts` has stored the TEST catalogue:
 *
 *   OUTLY_TEST_ENV_FILE=.env.test.shop.local NODE_OPTIONS=--conditions=react-server \
 *     node --env-file=.env.test.shop.local node_modules/tsx/dist/cli.mjs scripts/shop/setup.ts
 */
import { createHash } from "node:crypto";
import { assertDisposableDbLive, assertDisposableTarget } from "../lib/target-guard";

assertDisposableTarget({ allowTravelDeskTestKey: true });
if (process.env.TRAVELDESK_ENV !== "test") throw new Error("shop setup: TravelDesk TEST only");

/** Seeded product → TravelDesk TEST offer, with a local test price (AED) that clears the 15% floor. */
const PICKS = [
  // freeHours: the full-refund window of the TravelDesk TEST tour's policy (100% refund "more than" these hours).
  // times: plain HH:mm matching the TEST offer's slot start; the cart sends a time to the quote only in that form.
  { slug: "dhow-cruise-marina-dinner", offer: "62", adultAed: 229, childAed: 159, freeHours: 72, times: ["21:00"] },
  { slug: "evening-desert-safari-veg-jain", offer: "166", adultAed: 319, childAed: 299, freeHours: 24, times: ["15:00"] },
  { slug: "abu-dhabi-city-tour-grand-mosque", offer: "45", adultAed: 339, childAed: 259, freeHours: 48, times: ["09:00"] },
];

const INR_PER_AED = 24.3;

async function main() {
  const { prisma } = await import("../../src/server/lib/db");
  await assertDisposableDbLive(prisma, { allowTravelDeskTestKey: true });
  const { uuidv7 } = await import("../../src/server/lib/ids");
  const { travelDeskExternalRefSchema } = await import("../../src/server/suppliers/traveldesk/traveldesk.adapter");
  const { offerTermsHash } = await import("../../src/server/suppliers/traveldesk/traveldesk.offer-terms");
  const { readinessService } = await import("../../src/server/services/readiness.service");

  const now = new Date();
  const iso = (ms: number) => new Date(now.getTime() + ms).toISOString();
  const supplier = await prisma.supplier.findUniqueOrThrow({ where: { code: "traveldesk" } });

  const settings: Record<string, unknown> = {
    "pricing.fx_inr_per_aed": { version: 1, inrPerAed: INR_PER_AED.toFixed(2), source: "Local test shop (synthetic)", recordedAt: iso(-60_000), expiresAt: iso(6 * 24 * 3600_000) },
    "pricing.margin_cost_inputs": {
      version: 1,
      source: "Owner-accepted Stripe fees (doc 22 §32.24), local test shop",
      recordedAt: iso(-60_000),
      lines: [
        { name: "Stripe fee", kind: "percent_of_charge", bps: 490 },
        { name: "VAT on Stripe fee", kind: "percent_of_charge", bps: 25 },
        { name: "Stripe fixed fee", kind: "fixed_aed", aedMinor: "100" },
        { name: "VAT on fixed fee", kind: "fixed_aed", aedMinor: "5" },
      ],
    },
    "payments.exposure_limits": { maxUncapturedHolds: 3, maxRiskyPaymentsPer15Min: 5, outlyFundedWindowDays: 30, outlyFundedCapMinor: { INR: 0, AED: 0 }, maxInstantOrderAedMinor: 50_000 },
    "supplier_bookings.traveldesk.test.default": { paused: false, scope: "new_sales", maxBookingNetMinor: 500_000, minFundsAfterMinor: 0 },
  };
  for (const [key, value] of Object.entries(settings)) {
    await prisma.setting.upsert({ where: { key }, create: { key, value: value as never }, update: { value: value as never } });
  }

  for (const pick of PICKS) {
    const product = await prisma.product.findUniqueOrThrow({ where: { slug: pick.slug } });
    const offer = await prisma.supplierCatalogueItem.findUniqueOrThrow({
      where: { supplierId_environment_kind_externalId: { supplierId: supplier.id, environment: "test", kind: "offer", externalId: pick.offer } },
    });
    const tour = await prisma.supplierCatalogueItem.findUniqueOrThrow({
      where: { supplierId_environment_kind_externalId: { supplierId: supplier.id, environment: "test", kind: "tour", externalId: offer.parentExternalId! } },
    });
    const content = product.content as Record<string, unknown>;
    const price = { ...(content.price as Record<string, unknown>) };
    const adult = { aed: pick.adultAed, inr: Math.ceil(pick.adultAed * INR_PER_AED) };
    const child = { aed: pick.childAed, inr: Math.ceil(pick.childAed * INR_PER_AED) };
    price.adult = adult;
    price.child = child;
    if (price.senior) price.senior = adult;
    delete price.compareAt;
    // One variant, priced by the page, with typed units the TravelDesk offer accepts (readiness rules).
    const unit = (unitId: "adult" | "child", label: string, money: { aed: number; inr: number }) => ({
      unitId, label, per: "person", ageMin: null, ageMax: null, residency: "any", heightMinCm: null, heightMaxCm: null,
      seatConsuming: true, minQty: 0, maxQty: 20, price: money, supplierUnit: unitId,
    });
    const first = ((content.variants ?? []) as Record<string, unknown>[])[0];
    const variant = { ...first, delta: { aed: 0, inr: 0 }, soldOut: false, units: [unit("adult", "Adult", adult), unit("child", "Child", child)] };
    const variants = [String(first.id)];
    const policyText = `Free cancellation up to ${pick.freeHours} hours before your start time. After that, no refund.`;
    await prisma.product.update({
      where: { id: product.id },
      data: {
        content: { ...content, price, addOns: [], variants: [variant], confirmation: "instant", freeCancellationHours: pick.freeHours, cancellationPolicy: policyText, timeSlots: pick.times } as never,
        priceFromAed: pick.adultAed,
        priceFromInr: adult.inr,
        fulfilmentMode: "instant",
        confirmation: "instant",
      },
    });

    const externalRef = travelDeskExternalRefSchema.parse({
      tourId: Number(tour.externalId),
      offerId: Number(offer.externalId),
      bookingKind: offer.bookingKind ?? "unknown",
      isExternal: offer.isExternal,
      ticketEvidence: { issuesTicketsAtConfirm: "no", source: "Local test shop: TravelDesk live bookings return a voucher only", recordedAt: now.toISOString() },
    });
    const hash = offerTermsHash(offer.payload, tour.payload);
    for (const variantCode of variants.length ? variants : [null]) {
      const existing = await prisma.productSupplierMapping.findFirst({ where: { productId: product.id, supplierId: supplier.id, variantCode } });
      await prisma.productSupplierMapping.updateMany({ where: { productId: product.id, supplierId: supplier.id, NOT: { variantCode } }, data: { isActive: false } });
      const data = {
        externalRef,
        supplierProductId: tour.externalId,
        supplierOfferId: offer.externalId,
        bookingKind: offer.bookingKind,
        environment: "test" as const,
        isActive: true,
        lastSyncedAt: offer.lastSeenAt,
        syncStatus: hash ? "ok" : "changed",
        approvedOfferHash: hash,
      };
      if (existing) await prisma.productSupplierMapping.update({ where: { id: existing.id }, data });
      else await prisma.productSupplierMapping.create({ data: { id: uuidv7(), productId: product.id, supplierId: supplier.id, variantCode, priority: 1, ...data } });
    }
    const result = await readinessService.reevaluate(product.id, "flip");
    const elig = await prisma.productEligibility.findUnique({ where: { productId: product.id } });
    console.log(JSON.stringify({ slug: pick.slug, offer: pick.offer, variants, effectiveMode: elig?.effectiveMode ?? null, reasons: elig?.reasons ?? null, result: result ? "evaluated" : null }));
  }
  await prisma.$disconnect();
  void createHash;
}

void main();
