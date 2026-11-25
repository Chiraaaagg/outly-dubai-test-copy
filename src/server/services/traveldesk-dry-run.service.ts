import "server-only";
import type { SupplierEnvironment } from "@prisma/client";
import { PAGE_PAX_AGES } from "@/lib/pricing";
import { prisma } from "../lib/db";
import type { Actor } from "../lib/actor";
import { requirePermission } from "../lib/actor";
import { settingsRepo } from "../repositories/settings.repo";
import { MARGIN_POLICY_SETTING_KEY } from "../quotes/contracts";
import { RULE_TARGET_MARGIN_BPS, type RuleCostLine } from "../domain/rule-price";
import { gateVerdict, loadCapabilityGate } from "../suppliers/capability-gate";
import { slotRulesUnknown } from "../suppliers/traveldesk/traveldesk.capability";
import { buildListingPlan, type ListingPlan, type PlanOffer, type PlanTourContent } from "../suppliers/traveldesk/traveldesk.listing-plan";
import { offerTermsHash, parseStoredOffer, parseStoredPolicy } from "../suppliers/traveldesk/traveldesk.offer-terms";
import { ageBandMismatches, offerReadinessFacts } from "../suppliers/traveldesk/traveldesk.quote";
import { costInputsSchema, FX_INR_PER_AED_SETTING_KEY, fxInputSchema, MARGIN_COST_INPUTS_SETTING_KEY, marginPolicySchema } from "./margin.service";
import { catalogueStale, catalogueSyncedAt, lastCompleteSync, TRAVELDESK_SUPPLIER_CODE } from "./supplier-catalog.service";

/**
 * TravelDesk dry-run report (doc 30 §3.2, build N0): what the N1 importer
 * would create from the stored catalogue, per offer type (step), with its
 * prices under the rule of §3.6, every blocker, start-time splits, the
 * child-price effect, seasonal offers, already-linked offers and the old
 * pages that may be replaced.
 *
 * Read-only: it reads the stored catalogue, content, capability flags and
 * evidence, mappings, matcher suggestions and pricing settings. It writes
 * nothing and calls no supplier. It shows supplier nets, so it needs
 * `suppliers.costs.view` (review 98 P30-29), not `suppliers.manage`.
 */

export interface DryRunReport extends ListingPlan {
  environment: SupplierEnvironment;
  supplierCode: string;
  generatedAt: string;
  /** Finish of the latest complete catalogue sync; null when none is recorded. */
  lastCompleteSyncAt: string | null;
  tours: number;
  /** Tours with a stored content row (`supplier_tour_content`). */
  toursWithContent: number;
  settings: { marginPolicyVersion: number | null; costInputsVersion: number | null; fxVersion: number | null };
}

async function readRules(at: Date) {
  const [policyRaw, costsRaw, fxRaw] = await Promise.all([
    settingsRepo.get<unknown>(MARGIN_POLICY_SETTING_KEY, null),
    settingsRepo.get<unknown>(MARGIN_COST_INPUTS_SETTING_KEY, null),
    settingsRepo.get<unknown>(FX_INR_PER_AED_SETTING_KEY, null),
  ]);
  const t = at.getTime();
  const policy = marginPolicySchema.safeParse(policyRaw);
  const policyOk = policy.success && Date.parse(policy.data.effectiveFrom) <= t;
  const costs = costInputsSchema.safeParse(costsRaw);
  const costsOk = costs.success && Date.parse(costs.data.recordedAt) <= t;
  const fx = fxInputSchema.safeParse(fxRaw);
  const fxOk = fx.success && Date.parse(fx.data.recordedAt) <= t && Date.parse(fx.data.expiresAt) > t;
  return {
    rules: {
      targetBps: RULE_TARGET_MARGIN_BPS,
      floorBps: policyOk ? policy.data.floorBps : null,
      costs: costsOk ? (costs.data.lines as RuleCostLine[]) : null,
      inrPerAed: fxOk ? fx.data.inrPerAed : null,
    },
    versions: {
      marginPolicyVersion: policyOk ? policy.data.version : null,
      costInputsVersion: costsOk ? costs.data.version : null,
      fxVersion: fxOk ? fx.data.version : null,
    },
  };
}

function contentSummary(row: { salesDescription: string; photos: unknown; faq: unknown; itinerary: unknown; warnings: string[]; schemaVersion: number }): PlanTourContent {
  const len = (v: unknown) => (Array.isArray(v) ? v.length : 0);
  return {
    hasDescription: row.salesDescription.trim().length > 0,
    photos: len(row.photos),
    faq: len(row.faq),
    itinerary: len(row.itinerary),
    warnings: row.warnings.length,
    schemaVersion: row.schemaVersion,
  };
}

export const traveldeskDryRunService = {
  async report(actor: Actor, environment: SupplierEnvironment, opts: { supplierCode?: string; now?: () => Date } = {}): Promise<DryRunReport> {
    requirePermission(actor, "suppliers.costs.view");
    const code = opts.supplierCode ?? TRAVELDESK_SUPPLIER_CODE;
    const at = (opts.now ?? (() => new Date()))();
    // Pricing periods are dated in Asia/Dubai (UTC+4), as readiness reads them.
    const today = new Date(at.getTime() + 4 * 3_600_000).toISOString().slice(0, 10);
    const { rules, versions } = await readRules(at);
    const supplier = await prisma.supplier.findUnique({ where: { code } });
    const base = { environment, supplierCode: code, generatedAt: at.toISOString(), settings: versions };
    if (!supplier) {
      return { ...base, lastCompleteSyncAt: null, tours: 0, toursWithContent: 0, ...buildListingPlan([], { rules, flagsOn: new Set(), content: new Map() }) };
    }

    const [items, contents, mappings, candidates, lastComplete] = await Promise.all([
      prisma.supplierCatalogueItem.findMany({
        where: { supplierId: supplier.id, environment, removedAt: null },
        select: { kind: true, externalId: true, parentExternalId: true, name: true, payload: true, lastSeenAt: true },
      }),
      prisma.supplierTourContent.findMany({
        where: { supplierId: supplier.id, environment },
        select: { tourExternalId: true, salesDescription: true, photos: true, faq: true, itinerary: true, warnings: true, schemaVersion: true },
      }),
      prisma.productSupplierMapping.findMany({
        where: { supplierId: supplier.id, environment, isActive: true, supplierOfferId: { not: null } },
        select: { supplierOfferId: true, product: { select: { id: true, slug: true, deletedAt: true } } },
      }),
      prisma.supplierMappingCandidate.findMany({
        where: { supplierId: supplier.id, environment, state: { in: ["suggested", "approved"] } },
        select: { offerExternalId: true, score: true, state: true, product: { select: { id: true, slug: true, title: true, deletedAt: true } } },
      }),
      lastCompleteSync(code, environment),
    ]);

    const tours = new Map(items.filter((i) => i.kind === "tour").map((i) => [i.externalId, i]));
    const offers = items.filter((i) => i.kind === "offer" && i.parentExternalId && tours.has(i.parentExternalId));
    const gate = await loadCapabilityGate(prisma, { adapter: supplier.adapter, supplierId: supplier.id, environment, offerExternalIds: offers.map((o) => o.externalId) });
    const flagsOn = new Set([...gate.flags].filter(([, f]) => f.enabled).map(([k]) => k));

    const links = new Map<string, { productId: string; slug: string }[]>();
    for (const m of mappings) {
      if (m.product.deletedAt) continue;
      const list = links.get(m.supplierOfferId!) ?? [];
      if (!list.some((l) => l.productId === m.product.id)) list.push({ productId: m.product.id, slug: m.product.slug });
      links.set(m.supplierOfferId!, list);
    }
    const suggestions = new Map<string, PlanOffer["suggestions"]>();
    for (const c of candidates) {
      if (c.product.deletedAt) continue;
      suggestions.set(c.offerExternalId, [...(suggestions.get(c.offerExternalId) ?? []), { productId: c.product.id, slug: c.product.slug, title: c.product.title, score: c.score, state: c.state }]);
    }

    const planOffers: PlanOffer[] = offers.map((item) => {
      const tour = tours.get(item.parentExternalId!)!;
      const stored = parseStoredOffer(item.payload);
      const policy = parseStoredPolicy(tour.payload);
      const facts = offerReadinessFacts(stored, policy, today);
      const check = gateVerdict(gate, item.externalId, item.payload, offerTermsHash(item.payload, tour.payload));
      const inForce = stored ? stored.pricingPeriods.filter((p) => p.dateEnd === null || p.dateEnd.slice(0, 10) >= today) : [];
      const adultNets = inForce.flatMap((p) => (p.price ? [p.price.perAdultMinor] : []));
      return {
        offerId: Number(item.externalId),
        tourId: Number(tour.externalId),
        tourName: tour.name,
        offerName: item.name,
        classKey: check.capability.classKey,
        dimensions: check.capability.dimensions,
        reviewReasons: check.capability.reviewReasons,
        gate: { instant: check.verdict.instant, reason: check.verdict.instant ? null : check.verdict.reason },
        isExternal: stored?.isExternal ?? false,
        durationHours: stored?.durationHours ?? null,
        daysOffered: stored?.daysOffered ?? 0,
        startMinutes: facts.slotStartMinutes,
        childrenAllowed: stored?.childrenAllowed ?? false,
        childAge: stored?.childAge ?? 0,
        infantsAllowed: stored?.infantsAllowed ?? false,
        infantAge: stored?.infantAge ?? 0,
        supplierUnits: facts.supplierUnits,
        netAedMinorByUnit: facts.netAedMinorByUnit,
        periodsInForce: inForce.length,
        adultNetRange: adultNets.length
          ? { min: adultNets.reduce((a, b) => (b < a ? b : a)), max: adultNets.reduce((a, b) => (b > a ? b : a)) }
          : null,
        freeCancellationHours: facts.supplierFreeCancellationHours,
        ageBandMismatches: stored ? ageBandMismatches(stored, PAGE_PAX_AGES) : [],
        slotRulesUnknown: slotRulesUnknown(stored, check.verdict.instant, check.verdict.classKey),
        catalogueStale: catalogueStale(catalogueSyncedAt(lastComplete, item.lastSeenAt), at),
        activeLinks: links.get(item.externalId) ?? [],
        suggestions: suggestions.get(item.externalId) ?? [],
      };
    });

    const content = new Map(contents.map((c) => [Number(c.tourExternalId), contentSummary(c)]));
    const plan = buildListingPlan(planOffers, { rules, flagsOn, content });
    return {
      ...base,
      lastCompleteSyncAt: lastComplete?.toISOString() ?? null,
      tours: tours.size,
      toursWithContent: [...tours.keys()].filter((id) => content.has(Number(id))).length,
      ...plan,
    };
  },
};
