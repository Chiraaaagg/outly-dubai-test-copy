import "server-only";
import { createHash } from "node:crypto";
import { Prisma, type SupplierEnvironment } from "@prisma/client";
import { PAGE_PAX_AGES } from "@/lib/pricing";
import { prisma, TX_OPTIONS } from "../lib/db";
import type { Actor } from "../lib/actor";
import { requirePermission } from "../lib/actor";
import { audit } from "../lib/audit";
import { Errors } from "../lib/errors";
import { uuidv7 } from "../lib/ids";
import { decimalToMinor } from "../domain/decimal";
import { suggestCandidates, type MatchOffer, type MatchProduct } from "../domain/supplier-matching";
import type { ReadinessReason } from "../quotes/contracts";
import type { Tristate } from "../suppliers/booking-port";
import { travelDeskExternalRefSchema } from "../suppliers/traveldesk/traveldesk.adapter";
import type { TravelDeskAvailabilityRow, TravelDeskOffer, TravelDeskTourDetail, TravelDeskTourSummary } from "../suppliers/traveldesk/traveldesk.codec";
import { offerTermsHash, parseStoredOffer, parseStoredPolicy } from "../suppliers/traveldesk/traveldesk.offer-terms";
import { ageBandMismatches, offerReadinessFacts } from "../suppliers/traveldesk/traveldesk.quote";
import { readinessService } from "./readiness.service";
import { verifyStepUp } from "./approval.service";
import { gateVerdict, loadCapabilityGate } from "../suppliers/capability-gate";
import { CAPABILITY_DERIVATION_VERSION, deriveCapabilities } from "../suppliers/traveldesk/traveldesk.capability";
import type { ReadLimits } from "../suppliers/read-budget";
import { TravelDeskApiError } from "../suppliers/traveldesk/traveldesk.http";
import { bookingAccountId, DEFAULT_BOOKING_ACCOUNT_ID, mutationInFlight, takeReadToken } from "./supplier-booking.service";
import { supplierCheckAccountId } from "./supplier-quote.service";

/**
 * Supplier catalogue + mapping review (docs/backend/21 §2–§3, Stage 1).
 *
 *  - `syncTravelDeskCatalogue` stores what TravelDesk offers (read-only calls)
 *    in `supplier_catalogue_items`. It never touches product content: OUTLY's
 *    copy, prices, images and variants stay OUTLY's (§3.4).
 *  - `generateCandidates` runs the pure matcher and stores SUGGESTIONS only.
 *  - `reviewCandidate` is the one path that writes `product_supplier_mappings`,
 *    and only on a human approval with a reason. Approval never changes
 *    `fulfilment_mode` or a price; the instant flip stays a separate audited
 *    action that the TravelDesk capabilities refuse until Stage 3.
 *  - Approval records `approved_offer_hash`, a hash of the offer terms the
 *    editor saw (traveldesk.offer-terms.ts). Every sync compares the stored
 *    terms with it and marks the mapping `changed` on any difference (SUP-15).
 *  - `mappingReadinessFor` is the mapping half of readiness: one state per
 *    product variant, read by readiness.service.ts. Approve, revoke and every
 *    sync re-evaluate readiness for the products they touch.
 */

export const TRAVELDESK_SUPPLIER_CODE = "traveldesk";

/** How the sync shares the supplier's lane with the booking engine (SUP-6). */
export interface SyncLaneOptions {
  /** Supplier account whose read budget the sync draws on; default the unpinned test account. */
  accountId?: string | null;
  /** Test seam only; production uses the shared `READ_BUDGET` (N5). */
  readLimits?: ReadLimits;
  /** Longest wait for a quiet lane or a read token before one call; default 5 minutes. */
  maxWaitMs?: number;
  pollMs?: number;
  /**
   * Absolute end of the run (epoch ms). Past it the sync stops before the next
   * call and reports `incomplete`, so a platform time limit never kills it
   * mid-write. Unset: no deadline (the local script).
   */
  deadlineMs?: number;
}

/**
 * Wait until no booking mutation is in flight on the supplier and a read
 * token is available, before each catalogue call (SUP-6): the sync never runs
 * beside a mutation, and its reads count against the shared per-account budget.
 */
async function quietLane(supplierId: string, code: string, environment: SupplierEnvironment, lane: SyncLaneOptions): Promise<"ok" | "deadline"> {
  const account = lane.accountId ?? bookingAccountId(environment, null) ?? DEFAULT_BOOKING_ACCOUNT_ID;
  const until = Date.now() + (lane.maxWaitMs ?? 300_000);
  for (;;) {
    if (lane.deadlineMs !== undefined && Date.now() >= lane.deadlineMs) return "deadline";
    if (!(await mutationInFlight(supplierId, environment)) && (await takeReadToken(code, environment, account, lane.readLimits))) return "ok";
    if (Date.now() > until) throw Errors.unavailable(60);
    await new Promise((r) => setTimeout(r, lane.pollMs ?? 2_000));
  }
}

/** Above this share of live items disappearing in one pull, removals are skipped and reported. */
const MAX_REMOVAL_SHARE = 0.2;

/** The read calls the sync needs; `TravelDeskReadClient` satisfies it. */
export interface TravelDeskCatalogueSource {
  listTours(): Promise<TravelDeskTourSummary[]>;
  getTour(tourId: number): Promise<TravelDeskTourDetail>;
}

export interface TravelDeskAvailabilitySource {
  getAvailability(offerId: number, from: string, to: string, opts: { isExternal: boolean }): Promise<{ rows: TravelDeskAvailabilityRow[] }>;
}

export interface SyncResult {
  environment: SupplierEnvironment;
  tours: number;
  offers: number;
  added: number;
  changed: number;
  removed: number;
  revived: number;
  failedTours: number[];
  /**
   * False when the pull looked implausible: removals are then skipped, so a
   * partial pull cannot "delete" inventory. Removals are judged per tour: a
   * tour that failed to load keeps its items (it is in `failedTours`), and the
   * other tours' removals still apply (SUP-15).
   */
  removalsApplied: boolean;
  /** Why removals were skipped, when they were. */
  removalsSkipped?: "empty_tour_list" | "too_many_removals" | "incomplete";
  /** True when the run stopped at its deadline before every tour was read; removals are then skipped. */
  incomplete?: boolean;
  mappingsChecked: number;
  /** Mappings whose offer terms differ from the approved ones this run. */
  mappingsChanged: number;
  /** Approved mappings from before B2 that got their `approved_offer_hash` from this run's terms. */
  hashesBackfilled: number;
}

/** JSON.stringify with bigint → string and sorted keys, so the hash is stable. */
function stableJson(value: unknown): string {
  return JSON.stringify(value, (_k, v) => {
    if (typeof v === "bigint") return v.toString();
    if (v && typeof v === "object" && !Array.isArray(v)) {
      return Object.fromEntries(Object.entries(v as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b)));
    }
    return v;
  });
}

function toJson(value: unknown): Prisma.InputJsonValue {
  return JSON.parse(stableJson(value)) as Prisma.InputJsonValue;
}

function hashOf(value: unknown): string {
  return createHash("sha256").update(stableJson(value)).digest("hex");
}

/**
 * Derive and store the offer's capability (doc 29 §3.1, Batch 1a) from the
 * payload exactly as stored, so the stored row and the gate's own derivation
 * read the same input. Provenance only: the gate never reads this row.
 */
async function storeCapability(
  supplierId: string,
  environment: SupplierEnvironment,
  catalogueItemId: string,
  offerExternalId: string,
  offerPayload: Prisma.InputJsonValue,
  tourPayload: Prisma.InputJsonValue,
  at: Date,
) {
  const cap = deriveCapabilities(offerPayload);
  const data = {
    catalogueItemId,
    fulfilment: cap.dimensions.fulfilment,
    timeShape: cap.dimensions.timeShape,
    arrival: cap.dimensions.arrival,
    route: cap.dimensions.route,
    pricingUnit: cap.dimensions.pricingUnit,
    classKey: cap.classKey,
    reviewReasons: cap.reviewReasons,
    rawValues: toJson(cap.raw),
    derivationVersion: CAPABILITY_DERIVATION_VERSION,
    offerTermsHash: offerTermsHash(offerPayload, tourPayload),
    derivedAt: at,
  };
  await prisma.supplierOfferCapability.upsert({
    where: { supplierId_environment_offerExternalId: { supplierId, environment, offerExternalId } },
    create: { id: uuidv7(), supplierId, environment, offerExternalId, ...data },
    update: data,
  });
}

/** `code` exists so integration tests can isolate themselves on their own supplier row. */
async function ensureTravelDeskSupplier(code: string = TRAVELDESK_SUPPLIER_CODE, tx: Prisma.TransactionClient | typeof prisma = prisma) {
  const existing = await tx.supplier.findUnique({ where: { code } });
  if (existing) return existing;
  return tx.supplier.create({
    data: {
      id: uuidv7(),
      code,
      name: "TravelDesk",
      source: "api",
      adapter: "traveldesk",
      // Capabilities live in code (TRAVELDESK_CAPABILITIES); this column is informational.
      capabilities: { availability: "live", booking: "engine", cancellation: "engine", lookup: "engine" },
    },
  });
}

interface ItemInput {
  kind: "tour" | "offer";
  externalId: string;
  parentExternalId: string | null;
  name: string | null;
  bookingKind: string | null;
  isExternal: boolean;
  payload: unknown;
}

function tourItem(t: TravelDeskTourDetail): ItemInput {
  // Structure and rules only; descriptions, photos and FAQs are not stored (§3.4).
  const { offers: _offers, warnings: _warnings, ...rest } = t;
  return { kind: "tour", externalId: String(t.tourId), parentExternalId: null, name: t.name, bookingKind: null, isExternal: t.isExternal, payload: rest };
}

function offerItem(o: TravelDeskOffer): ItemInput {
  return {
    kind: "offer",
    externalId: String(o.offerId),
    parentExternalId: String(o.tourId),
    name: o.name,
    bookingKind: o.bookingKind,
    isExternal: o.isExternal,
    payload: o,
  };
}

/** First AED pricing period that covers `onDate`, else the first AED period. Reference only; bookings re-check live. */
function referencePrice(o: TravelDeskOffer, onDate: string) {
  const priced = o.pricingPeriods.filter((p) => p.price);
  const current = priced.find((p) => (!p.dateStart || p.dateStart <= onDate) && (!p.dateEnd || p.dateEnd >= onDate));
  return (current ?? priced[0])?.price ?? null;
}

interface StoredOffer {
  offerId: number;
  tourId: number;
  name: string | null;
  bookingKind: TravelDeskOffer["bookingKind"];
  isExternal: boolean;
  durationHours: number;
  privateType: TravelDeskOffer["privateType"];
  isDirectReporting: boolean;
  childAge: number;
  timeSlots: { startMinutes: number }[];
  pricingPeriods: { dateStart: string | null; dateEnd: string | null; price: { perAdultMinor: string; perChildMinor: string; perTripMinor: string } | null }[];
}

function matchOfferFrom(offer: StoredOffer, tourName: string, onDate: string): MatchOffer {
  const price = referencePrice(offer as unknown as TravelDeskOffer, onDate) as unknown as StoredOffer["pricingPeriods"][number]["price"];
  return {
    tourId: String(offer.tourId),
    tourName,
    offerId: String(offer.offerId),
    offerName: offer.name ?? "",
    bookingKind: offer.bookingKind,
    isExternal: offer.isExternal,
    durationHours: offer.durationHours,
    privateType: offer.privateType,
    isDirectReporting: offer.isDirectReporting,
    childAge: offer.childAge,
    startMinutes: [...new Set(offer.timeSlots.map((s) => s.startMinutes))],
    netAdultMinor: price ? BigInt(price.perAdultMinor) : 0n,
    netChildMinor: price ? BigInt(price.perChildMinor) : 0n,
    netTripMinor: price ? BigInt(price.perTripMinor) : 0n,
  };
}

function aedMinor(v: unknown): bigint | null {
  if (typeof v !== "number" || !Number.isFinite(v) || v < 0) return null;
  return decimalToMinor(String(v)).minor;
}

/** Product row + `content` → matcher input. Prices are authored major units in content (§6.1). */
export function matchProductFrom(p: { id: string; slug: string; title: string; durationMinutes: number | null; isPrivate: boolean; pickupIncluded: boolean; content: unknown }): MatchProduct {
  const c = (p.content ?? {}) as Record<string, unknown>;
  const price = (c.price ?? {}) as { adult?: { aed?: number }; child?: { aed?: number } };
  const baseAdult = aedMinor(price.adult?.aed) ?? 0n;
  const baseChild = aedMinor(price.child?.aed);
  const rawVariants = Array.isArray(c.variants) ? (c.variants as Record<string, unknown>[]) : [];
  const variants = rawVariants.length
    ? rawVariants.map((v) => {
        // Deltas may be negative ("Night Tour −40"); base prices may not.
        const rawDelta = (v.delta as { aed?: unknown } | undefined)?.aed;
        const deltaSigned = typeof rawDelta === "number" && Number.isFinite(rawDelta) ? decimalToMinor(String(rawDelta)).minor : 0n;
        return {
          code: String(v.id ?? ""),
          name: String(v.name ?? ""),
          sellAdultMinor: baseAdult + deltaSigned,
          sellChildMinor: baseChild === null ? null : baseChild + deltaSigned,
          isPrivate: v.isPrivate === true,
        };
      })
    : [{ code: "", name: p.title, sellAdultMinor: baseAdult, sellChildMinor: baseChild, isPrivate: p.isPrivate }];
  return {
    productId: p.id,
    slug: p.slug,
    title: p.title,
    durationMinutes: p.durationMinutes,
    isPrivate: p.isPrivate,
    pickupIncluded: p.pickupIncluded,
    timeSlots: Array.isArray(c.timeSlots) ? (c.timeSlots as unknown[]).map(String) : [],
    variants,
  };
}

export interface CandidateRow {
  id: string;
  state: "suggested" | "approved" | "rejected";
  environment: SupplierEnvironment;
  score: number;
  evidence: string[];
  conflicts: string[];
  marginBps: number | null;
  sellAdultMinor: string | null;
  netAdultMinor: string | null;
  source: string;
  reviewNote: string | null;
  reviewedAt: string | null;
  product: { id: string; slug: string; title: string; status: string; fulfilmentMode: "inquiry" | "instant" };
  variantCode: string;
  variantName: string;
  tour: { externalId: string; name: string | null };
  offer: { externalId: string; name: string | null; bookingKind: string | null; isExternal: boolean; removed: boolean };
  /** The approved mapping and its recorded ticket evidence; null unless this candidate holds the active mapping. */
  mapping: { id: string; ticketEvidence: TicketEvidenceRecord | null } | null;
}

/** What an administrator recorded about an offer's tickets (`externalRef.ticketEvidence`, Q-T1). */
export interface TicketEvidenceRecord {
  issuesTicketsAtConfirm: "yes" | "no";
  source: string;
  recordedAt: string;
}

/** Owner input of `setTicketEvidence`; `unknown` clears the record. */
export interface TicketEvidenceInput {
  issuesTicketsAtConfirm: "yes" | "no" | "unknown";
  /** Where the answer comes from, e.g. a TEST booking number and what its confirm answer held. Stored on the mapping. */
  source: string;
  /** Why it is being changed now. Goes to the audit log. */
  note: string;
  totpCode: string;
}

/** The readiness reasons a variant's mapping can produce (quotes/contracts.ts). */
export type MappingBlocker = Extract<
  ReadinessReason,
  "variant_without_mapping" | "mapping_inactive" | "mapping_changed_upstream" | "mapping_missing_upstream" | "slot_rules_unknown" | "capability_not_ready" | "unit_not_mapped"
>;

/** One storefront variant and the supplier mapping that would fulfil it. */
export interface VariantMappingState {
  /** `content.variants[].id`; null for a product without variants (its mapping has no variant code). */
  variantCode: string | null;
  mapping: {
    mappingId: string;
    /** The mapping's own variant code: null when a whole-product mapping covers this variant. */
    variantCode: string | null;
    environment: SupplierEnvironment | null;
    isActive: boolean;
    syncStatus: string | null;
    lastSyncedAt: string | null;
    bookingKind: string | null;
    tourExternalId: string | null;
    offerExternalId: string | null;
    approvedOfferHash: string | null;
    /** Hash of the terms stored now; equal to the approved one when nothing drifted. */
    currentOfferHash: string | null;
    issuesTicketsAtConfirm: Tristate;
    /** From the stored offer and tour policy (`offerReadinessFacts`). */
    supplierUnits: string[];
    netAedMinorByUnit: Record<string, bigint> | null;
    supplierFreeCancellationHours: number | null;
    /** True: no pickup. False: the offer collects from hotels. Null: the stored offer cannot be read. */
    isDirectReporting: boolean | null;
    /** The stored slots' start times (minutes after midnight); null when the stored offer cannot be read. */
    slotStartMinutes: number[] | null;
    /** Whether a stored slot is an "any time" slot; null when the stored offer cannot be read. */
    anyTimeSlots: boolean | null;
    /** The supplier account a quote in this environment checks against; null when TravelDesk is not configured for it. */
    accountId: string | null;
    /** The offer's composed capability class (doc 29 §3.1); `unknown` when the stored offer cannot be read. */
    capabilityClassKey?: string;
    /** Why the capability gate refuses instant sale; null when it allows it. */
    capabilityRefusal?: string | null;
  } | null;
  /** Empty when the mapping side is ready; readiness adds its own reasons. */
  blockers: MappingBlocker[];
}

export interface ProductMappingReadiness {
  productId: string;
  environment: SupplierEnvironment;
  variants: VariantMappingState[];
  evaluatedAt: string;
}

/** Variant ids as the storefront and the matcher see them (`matchProductFrom`). */
function variantCodesOf(content: unknown): (string | null)[] {
  const raw = (content as { variants?: unknown } | null)?.variants;
  const ids = Array.isArray(raw) ? raw.map((v) => (v as { id?: unknown })?.id).filter((id): id is string => typeof id === "string" && id !== "") : [];
  return ids.length ? [...new Set(ids)] : [null];
}

export const supplierCatalogService = {
  /**
   * The mapping half of readiness (SUP-15, doc 22 §23 B2), for
   * readiness.service.ts. One entry per storefront variant, with the
   * TravelDesk mapping in `environment` that would fulfil it (the variant's
   * own, else a whole-product mapping) and why it is not ready. Read-only;
   * it calls no supplier. The blockers, in order:
   *  - `variant_without_mapping`: no TravelDesk mapping in this environment;
   *  - `mapping_inactive`: revoked;
   *  - `mapping_missing_upstream`: the offer or its tour is gone from the stored catalogue;
   *  - `mapping_changed_upstream`: the last sync saw other terms than the
   *    approved ones, the stored terms hash differently now, or there is no
   *    approved hash at all;
   *  - `slot_rules_unknown`: the stored offer cannot be read, or a slot-based
   *    offer has no slots;
   *  - `capability_not_ready`: not a live-book offer (on request, TicketOnly or
   *    unknown), the supplier row is not the TravelDesk adapter, or the
   *    capability gate refuses the offer (doc 29 §3.3, Batch 1a): its class is
   *    unknown or never sellable, needs review, its exact class key is not
   *    switched on for this environment, or it lacks the per-offer evidence
   *    the flag asks for (`capabilityRefusal` says which);
   *  - `unit_not_mapped`: the offer's child or infant age band does not reach
   *    the top of the page's band for that unit (`PAGE_PAX_AGES`,
   *    `ageBandMismatches`, N3). That unit is also left out of
   *    `supplierUnits`, so readiness refuses any content unit sold through it.
   */
  async mappingReadinessFor(productId: string, environment: SupplierEnvironment, opts: { supplierCode?: string; now?: () => Date } = {}): Promise<ProductMappingReadiness> {
    const product = await prisma.product.findUnique({ where: { id: productId }, select: { id: true, content: true } });
    if (!product) throw Errors.notFound("Product");
    const code = opts.supplierCode ?? TRAVELDESK_SUPPLIER_CODE;
    const at = (opts.now ?? (() => new Date()))();
    const evaluatedAt = at.toISOString();
    // Pricing periods are dated in Asia/Dubai (UTC+4).
    const today = new Date(at.getTime() + 4 * 3_600_000).toISOString().slice(0, 10);
    const supplier = await prisma.supplier.findUnique({ where: { code } });
    const variants = variantCodesOf(product.content);
    if (!supplier) return { productId, environment, variants: variants.map((v) => ({ variantCode: v, mapping: null, blockers: ["variant_without_mapping"] })), evaluatedAt };

    const mappings = await prisma.productSupplierMapping.findMany({ where: { productId, supplierId: supplier.id, environment } });
    const items = await prisma.supplierCatalogueItem.findMany({
      where: {
        supplierId: supplier.id,
        environment,
        OR: [
          { kind: "offer", externalId: { in: mappings.flatMap((m) => (m.supplierOfferId ? [m.supplierOfferId] : [])) } },
          { kind: "tour", externalId: { in: mappings.flatMap((m) => (m.supplierProductId ? [m.supplierProductId] : [])) } },
        ],
      },
      select: { kind: true, externalId: true, payload: true, removedAt: true },
    });
    const byKey = new Map(items.map((i) => [`${i.kind}:${i.externalId}`, i]));
    const accountId = supplierCheckAccountId(environment);
    const gate = await loadCapabilityGate(prisma, {
      adapter: supplier.adapter,
      supplierId: supplier.id,
      environment,
      offerExternalIds: mappings.flatMap((m) => (m.supplierOfferId ? [m.supplierOfferId] : [])),
    });

    const states = variants.map((variantCode): VariantMappingState => {
      const m = mappings.find((x) => x.variantCode === variantCode) ?? mappings.find((x) => x.variantCode === null);
      if (!m) return { variantCode, mapping: null, blockers: ["variant_without_mapping"] };
      const offer = m.supplierOfferId ? byKey.get(`offer:${m.supplierOfferId}`) : undefined;
      const tourRow = m.supplierProductId ? byKey.get(`tour:${m.supplierProductId}`) : undefined;
      const present = Boolean(offer && !offer.removedAt && tourRow && !tourRow.removedAt);
      const currentOfferHash = present ? offerTermsHash(offer!.payload, tourRow!.payload) : null;
      const ref = travelDeskExternalRefSchema.safeParse(m.externalRef);
      const stored = offer ? parseStoredOffer(offer.payload) : null;
      const offerFacts = offerReadinessFacts(stored, tourRow ? parseStoredPolicy(tourRow.payload) : null, today);
      const bandMismatch = stored ? ageBandMismatches(stored, PAGE_PAX_AGES) : [];
      const facts = { ...offerFacts, supplierUnits: offerFacts.supplierUnits.filter((u) => !(bandMismatch as string[]).includes(u)) };

      const blockers: MappingBlocker[] = [];
      if (!m.isActive) blockers.push("mapping_inactive");
      if (!present || m.syncStatus === "missing_upstream") blockers.push("mapping_missing_upstream");
      else if (m.syncStatus !== "ok" || !m.approvedOfferHash || currentOfferHash !== m.approvedOfferHash) blockers.push("mapping_changed_upstream");
      if (!stored || (stored.bookingKind === "live_book" && stored.timeSlots.length === 0)) blockers.push("slot_rules_unknown");
      // The capability lookup is added beside the old live-book test, which stays, so the verdict is never more permissive (Batch 1a parity).
      const capability = gateVerdict(gate, m.supplierOfferId ?? "", offer && !offer.removedAt ? offer.payload : null, currentOfferHash);
      if (
        supplier.adapter !== "traveldesk" ||
        !ref.success ||
        ref.data.bookingKind !== "live_book" ||
        m.bookingKind !== "live_book" ||
        !capability.verdict.instant
      )
        blockers.push("capability_not_ready");
      if (bandMismatch.length) blockers.push("unit_not_mapped");

      return {
        variantCode,
        mapping: {
          mappingId: m.id,
          variantCode: m.variantCode,
          environment: m.environment,
          isActive: m.isActive,
          syncStatus: m.syncStatus,
          lastSyncedAt: m.lastSyncedAt?.toISOString() ?? null,
          bookingKind: m.bookingKind,
          tourExternalId: m.supplierProductId,
          offerExternalId: m.supplierOfferId,
          approvedOfferHash: m.approvedOfferHash,
          currentOfferHash,
          issuesTicketsAtConfirm: ref.success ? (ref.data.ticketEvidence?.issuesTicketsAtConfirm ?? "unknown") : "unknown",
          ...facts,
          accountId,
          capabilityClassKey: capability.verdict.classKey,
          capabilityRefusal: capability.verdict.instant ? null : capability.verdict.reason,
        },
        blockers,
      };
    });
    return { productId, environment, variants: states, evaluatedAt };
  },


  /**
   * Pull the TravelDesk catalogue (GET only) and store it. Serial, one tour at a
   * time (TravelDesk processes one agency's requests at a time). System action.
   */
  async syncTravelDeskCatalogue(
    source: TravelDeskCatalogueSource,
    environment: SupplierEnvironment,
    opts: { now?: () => Date; supplierCode?: string; lane?: SyncLaneOptions } = {},
  ): Promise<SyncResult> {
    const now = opts.now ?? (() => new Date());
    const supplier = await ensureTravelDeskSupplier(opts.supplierCode);
    const code = opts.supplierCode ?? TRAVELDESK_SUPPLIER_CODE;
    const lane = opts.lane ?? {};
    const runStarted = now();
    if ((await quietLane(supplier.id, code, environment, lane)) === "deadline") throw Errors.unavailable(60);
    const tours = await source.listTours();
    const result: SyncResult = {
      environment,
      tours: 0,
      offers: 0,
      added: 0,
      changed: 0,
      removed: 0,
      revived: 0,
      failedTours: [],
      removalsApplied: false,
      mappingsChecked: 0,
      mappingsChanged: 0,
      hashesBackfilled: 0,
    };

    for (const t of tours) {
      let detail: TravelDeskTourDetail;
      if ((await quietLane(supplier.id, code, environment, lane)) === "deadline") {
        result.incomplete = true;
        break;
      }
      try {
        detail = await source.getTour(t.tourId);
      } catch (error) {
        // A rejected key fails every tour the same way: stop instead of reporting an empty catalogue.
        if (error instanceof TravelDeskApiError && error.kind === "auth") throw error;
        result.failedTours.push(t.tourId);
        continue;
      }
      result.tours += 1;
      const items = [tourItem(detail), ...detail.offers.map(offerItem)];
      result.offers += detail.offers.length;
      const tourPayload = toJson(tourItem(detail).payload);
      for (const item of items) {
        const payloadHash = hashOf(item.payload);
        const key = { supplierId_environment_kind_externalId: { supplierId: supplier.id, environment, kind: item.kind, externalId: item.externalId } };
        const existing = await prisma.supplierCatalogueItem.findUnique({ where: key });
        if (!existing) {
          const created = await prisma.supplierCatalogueItem.create({
            data: {
              id: uuidv7(),
              supplierId: supplier.id,
              environment,
              kind: item.kind,
              externalId: item.externalId,
              parentExternalId: item.parentExternalId,
              name: item.name,
              bookingKind: item.bookingKind,
              isExternal: item.isExternal,
              payload: toJson(item.payload),
              payloadHash,
              firstSeenAt: runStarted,
              lastSeenAt: runStarted,
            },
          });
          if (item.kind === "offer") await storeCapability(supplier.id, environment, created.id, item.externalId, toJson(item.payload), tourPayload, runStarted);
          result.added += 1;
          continue;
        }
        if (existing.removedAt) result.revived += 1;
        if (existing.payloadHash !== payloadHash) result.changed += 1;
        if (item.kind === "offer") await storeCapability(supplier.id, environment, existing.id, item.externalId, toJson(item.payload), tourPayload, runStarted);
        await prisma.supplierCatalogueItem.update({
          where: { id: existing.id },
          data: {
            parentExternalId: item.parentExternalId,
            name: item.name,
            bookingKind: item.bookingKind,
            isExternal: item.isExternal,
            payload: existing.payloadHash === payloadHash ? undefined : toJson(item.payload),
            payloadHash,
            lastSeenAt: runStarted,
            removedAt: null,
          },
        });
      }
    }

    // Only a plausible pull may mark inventory as gone: a non-empty tour list,
    // and at most 20% of live items disappearing at once (an upstream glitch
    // must not empty the catalogue). Removals are per tour: a tour whose
    // detail failed keeps its tour row and offers, and every other tour's
    // withdrawn offers are still removed, so one persistently failing tour
    // cannot hide withdrawals elsewhere (SUP-15).
    const failedIds = result.failedTours.map(String);
    const unseen: Prisma.SupplierCatalogueItemWhereInput = {
      supplierId: supplier.id,
      environment,
      removedAt: null,
      lastSeenAt: { not: runStarted },
      ...(failedIds.length
        ? { OR: [{ kind: "tour", externalId: { notIn: failedIds } }, { kind: "offer", parentExternalId: { notIn: failedIds } }] }
        : {}),
    };
    const live = await prisma.supplierCatalogueItem.count({ where: { supplierId: supplier.id, environment, removedAt: null } });
    const wouldRemove = await prisma.supplierCatalogueItem.count({ where: unseen });
    if (result.incomplete) result.removalsSkipped = "incomplete";
    else if (tours.length === 0) result.removalsSkipped = "empty_tour_list";
    else if (live > 0 && wouldRemove / live > MAX_REMOVAL_SHARE) result.removalsSkipped = "too_many_removals";
    else {
      result.removed = (await prisma.supplierCatalogueItem.updateMany({ where: unseen, data: { removedAt: runStarted } })).count;
      result.removalsApplied = true;
    }

    // Drift on approved mappings (§2.3, SUP-15). Readiness reads the status;
    // the sync itself only marks the mapping.
    const failed = new Set(failedIds);
    const mappings = await prisma.productSupplierMapping.findMany({ where: { supplierId: supplier.id, environment, supplierOfferId: { not: null } } });
    const checkedProducts = new Set<string>();
    for (const m of mappings) {
      // A mapping whose tour could not be fetched this run keeps its previous status.
      if (m.supplierProductId && failed.has(m.supplierProductId)) continue;
      const item = await prisma.supplierCatalogueItem.findUnique({
        where: { supplierId_environment_kind_externalId: { supplierId: supplier.id, environment, kind: "offer", externalId: m.supplierOfferId! } },
      });
      const tourRow = m.supplierProductId
        ? await prisma.supplierCatalogueItem.findUnique({
            where: { supplierId_environment_kind_externalId: { supplierId: supplier.id, environment, kind: "tour", externalId: m.supplierProductId } },
          })
        : null;
      const present = item && !item.removedAt && tourRow && !tourRow.removedAt;
      const current = present ? offerTermsHash(item.payload, tourRow.payload) : null;
      // Approvals from before B2 carry no hash. They take this run's terms once
      // (code path, not SQL, migration 20261101120000): nothing could be
      // instant on TravelDesk before B2, so no sale relied on older terms.
      // Conditional on the column still being null, so a concurrent approval wins.
      let approved = m.approvedOfferHash;
      if (approved === null && m.isActive && current) {
        const filled = await prisma.productSupplierMapping.updateMany({ where: { id: m.id, approvedOfferHash: null }, data: { approvedOfferHash: current } });
        if (filled.count === 1) {
          approved = current;
          result.hashesBackfilled += 1;
        } else approved = (await prisma.productSupplierMapping.findUnique({ where: { id: m.id }, select: { approvedOfferHash: true } }))?.approvedOfferHash ?? null;
      }
      const ref = travelDeskExternalRefSchema.safeParse(m.externalRef);
      const syncStatus = !present
        ? "missing_upstream"
        : item.bookingKind !== m.bookingKind ||
            item.parentExternalId !== m.supplierProductId ||
            !ref.success ||
            ref.data.isExternal !== item.isExternal ||
            current === null ||
            current !== approved
          ? "changed"
          : "ok";
      await prisma.productSupplierMapping.update({ where: { id: m.id }, data: { syncStatus, lastSyncedAt: runStarted } });
      result.mappingsChecked += 1;
      checkedProducts.add(m.productId);
      if (syncStatus === "changed") result.mappingsChanged += 1;
    }
    // Removals and price moves can change readiness even when the status stays the same.
    await readinessService.reevaluateMany([...checkedProducts], "sync");
    return result;
  },

  /**
   * Store date-specific net prices for the given offers (AED only, enforced by
   * the client and a DB check). Replaces earlier snapshots for the same
   * offer and dates.
   */
  async snapshotAvailability(
    source: TravelDeskAvailabilitySource,
    environment: SupplierEnvironment,
    offers: { offerId: number; isExternal: boolean }[],
    from: string,
    to: string,
    opts: { now?: () => Date; supplierCode?: string; lane?: SyncLaneOptions } = {},
  ) {
    const now = opts.now ?? (() => new Date());
    const supplier = await ensureTravelDeskSupplier(opts.supplierCode);
    const code = opts.supplierCode ?? TRAVELDESK_SUPPLIER_CODE;
    let rows = 0;
    let incomplete = false;
    const failed: number[] = [];
    for (const o of offers) {
      let fetched: TravelDeskAvailabilityRow[];
      // With a lane, each read waits for a quiet supplier and a read token, like the catalogue pull (SUP-6).
      if (opts.lane && (await quietLane(supplier.id, code, environment, opts.lane)) === "deadline") {
        incomplete = true;
        break;
      }
      try {
        fetched = (await source.getAvailability(o.offerId, from, to, { isExternal: o.isExternal })).rows;
      } catch {
        failed.push(o.offerId);
        continue;
      }
      await prisma.$transaction([
        prisma.supplierPriceSnapshot.deleteMany({
          where: { supplierId: supplier.id, environment, offerExternalId: String(o.offerId), serviceDate: { gte: new Date(`${from}T00:00:00Z`), lte: new Date(`${to}T00:00:00Z`) } },
        }),
        prisma.supplierPriceSnapshot.createMany({
          data: fetched.map((r) => ({
            id: uuidv7(),
            supplierId: supplier.id,
            environment,
            offerExternalId: String(o.offerId),
            serviceDate: new Date(`${r.date}T00:00:00Z`),
            timeSlotId: String(r.timeSlotId),
            startMinutes: r.startMinutes,
            seatsLeft: r.seatsLeft,
            isBookable: r.price.isBookable,
            currency: "AED",
            netAdultMinor: r.price.perAdultMinor,
            netChildMinor: r.price.perChildMinor,
            netTripMinor: r.price.perTripMinor,
            recAdultMinor: r.price.recPerAdultMinor,
            recChildMinor: r.price.recPerChildMinor,
            recTripMinor: r.price.recPerTripMinor,
            fetchedAt: now(),
          })),
        }),
      ]);
      rows += fetched.length;
    }
    return { rows, failed, incomplete };
  },

  /**
   * Run the matcher over live (non-deleted, non-archived) products and store
   * suggestions. Reviewed candidates are never touched; stale suggestions are
   * removed. System action.
   */
  async generateCandidates(
    environment: SupplierEnvironment,
    opts: { onDate?: string; maxPerVariant?: number; minScore?: number; supplierCode?: string; productIds?: string[] } = {},
  ) {
    const supplier = await ensureTravelDeskSupplier(opts.supplierCode);
    const onDate = opts.onDate ?? new Date().toISOString().slice(0, 10);
    const items = await prisma.supplierCatalogueItem.findMany({ where: { supplierId: supplier.id, environment, removedAt: null } });
    const tourNames = new Map(items.filter((i) => i.kind === "tour").map((i) => [i.externalId, i.name ?? ""]));
    const offers = items
      .filter((i) => i.kind === "offer" && i.parentExternalId && tourNames.has(i.parentExternalId))
      .map((i) => matchOfferFrom(i.payload as unknown as StoredOffer, tourNames.get(i.parentExternalId!)!, onDate));

    const products = await prisma.product.findMany({
      where: { deletedAt: null, status: { in: ["published", "draft"] }, ...(opts.productIds ? { id: { in: opts.productIds } } : {}) },
      select: { id: true, slug: true, title: true, durationMinutes: true, isPrivate: true, pickupIncluded: true, content: true },
    });

    let upserted = 0;
    let deleted = 0;
    for (const p of products) {
      const suggestions = suggestCandidates(matchProductFrom(p), offers, { maxPerVariant: opts.maxPerVariant, minScore: opts.minScore });
      const keep = new Set(suggestions.map((s) => `${s.variantCode}|${s.offerId}`));
      for (const s of suggestions) {
        const where = { productId_variantCode_supplierId_environment_offerExternalId: { productId: p.id, variantCode: s.variantCode, supplierId: supplier.id, environment, offerExternalId: s.offerId } };
        const existing = await prisma.supplierMappingCandidate.findUnique({ where });
        const data = {
          tourExternalId: s.tourId,
          score: s.score,
          evidence: s.evidence,
          conflicts: s.conflicts,
          sellAdultMinor: s.sellAdultMinor,
          netAdultMinor: s.netAdultMinor,
          marginBps: s.marginBps,
        };
        if (!existing) {
          await prisma.supplierMappingCandidate.create({
            data: { id: uuidv7(), productId: p.id, variantCode: s.variantCode, supplierId: supplier.id, environment, offerExternalId: s.offerId, source: "matcher", ...data },
          });
          upserted += 1;
        } else if (existing.state === "suggested") {
          await prisma.supplierMappingCandidate.update({ where: { id: existing.id }, data });
          upserted += 1;
        }
      }
      const stale = await prisma.supplierMappingCandidate.findMany({
        where: { productId: p.id, supplierId: supplier.id, environment, state: "suggested", source: "matcher" },
        select: { id: true, variantCode: true, offerExternalId: true },
      });
      const drop = stale.filter((c) => !keep.has(`${c.variantCode}|${c.offerExternalId}`)).map((c) => c.id);
      if (drop.length) deleted += (await prisma.supplierMappingCandidate.deleteMany({ where: { id: { in: drop } } })).count;
    }
    return { products: products.length, offers: offers.length, upserted, deleted };
  },

  async summary(actor: Actor) {
    requirePermission(actor, "suppliers.manage");
    const supplier = await prisma.supplier.findUnique({ where: { code: TRAVELDESK_SUPPLIER_CODE } });
    if (!supplier) return { configured: false as const };
    const [items, candidates, lastSeen] = await Promise.all([
      prisma.supplierCatalogueItem.groupBy({ by: ["environment", "kind", "bookingKind"], where: { supplierId: supplier.id, removedAt: null }, _count: { _all: true } }),
      prisma.supplierMappingCandidate.groupBy({ by: ["environment", "state"], where: { supplierId: supplier.id }, _count: { _all: true } }),
      prisma.supplierCatalogueItem.groupBy({ by: ["environment"], where: { supplierId: supplier.id }, _max: { lastSeenAt: true } }),
    ]);
    return {
      configured: true as const,
      items: items.map((i) => ({ environment: i.environment, kind: i.kind, bookingKind: i.bookingKind, count: i._count._all })),
      candidates: candidates.map((c) => ({ environment: c.environment, state: c.state, count: c._count._all })),
      lastSyncAt: Object.fromEntries(lastSeen.map((l) => [l.environment, l._max.lastSeenAt?.toISOString() ?? null])) as Partial<Record<SupplierEnvironment, string | null>>,
    };
  },

  async listCandidates(actor: Actor, filters: { state?: "suggested" | "approved" | "rejected"; environment?: SupplierEnvironment; supplierCode?: string } = {}): Promise<CandidateRow[]> {
    requirePermission(actor, "suppliers.manage");
    const supplier = await prisma.supplier.findUnique({ where: { code: filters.supplierCode ?? TRAVELDESK_SUPPLIER_CODE } });
    if (!supplier) return [];
    const rows = await prisma.supplierMappingCandidate.findMany({
      where: { supplierId: supplier.id, state: filters.state, environment: filters.environment, product: { deletedAt: null } },
      include: { product: { select: { id: true, slug: true, title: true, status: true, fulfilmentMode: true, content: true } } },
      orderBy: [{ product: { title: "asc" } }, { variantCode: "asc" }, { score: "desc" }],
      take: 2000,
    });
    const ids = [...new Set(rows.flatMap((r) => [`tour:${r.environment}:${r.tourExternalId}`, `offer:${r.environment}:${r.offerExternalId}`]))];
    const items = ids.length
      ? await prisma.supplierCatalogueItem.findMany({
          where: {
            supplierId: supplier.id,
            OR: rows.flatMap((r) => [
              { environment: r.environment, kind: "tour", externalId: r.tourExternalId },
              { environment: r.environment, kind: "offer", externalId: r.offerExternalId },
            ]),
          },
          select: { environment: true, kind: true, externalId: true, name: true, bookingKind: true, isExternal: true, removedAt: true },
        })
      : [];
    const byKey = new Map(items.map((i) => [`${i.kind}:${i.environment}:${i.externalId}`, i]));
    const mappingIds = rows.flatMap((r) => (r.state === "approved" && r.mappingId ? [r.mappingId] : []));
    const mappings = mappingIds.length
      ? await prisma.productSupplierMapping.findMany({ where: { id: { in: mappingIds } }, select: { id: true, externalRef: true, isActive: true, supplierOfferId: true, environment: true } })
      : [];
    const mappingById = new Map(mappings.map((m) => [m.id, m]));
    return rows.map((r) => {
      const m = r.state === "approved" && r.mappingId ? mappingById.get(r.mappingId) : undefined;
      const ref = m ? travelDeskExternalRefSchema.safeParse(m.externalRef) : null;
      const holds = m && m.isActive && m.supplierOfferId === r.offerExternalId && m.environment === r.environment;
      const variants = (((r.product.content as Record<string, unknown>)?.variants ?? []) as { id?: string; name?: string }[]) ?? [];
      const tour = byKey.get(`tour:${r.environment}:${r.tourExternalId}`);
      const offer = byKey.get(`offer:${r.environment}:${r.offerExternalId}`);
      return {
        id: r.id,
        state: r.state,
        environment: r.environment,
        score: r.score,
        evidence: (r.evidence as string[]) ?? [],
        conflicts: (r.conflicts as string[]) ?? [],
        marginBps: r.marginBps,
        sellAdultMinor: r.sellAdultMinor?.toString() ?? null,
        netAdultMinor: r.netAdultMinor?.toString() ?? null,
        source: r.source,
        reviewNote: r.reviewNote,
        reviewedAt: r.reviewedAt?.toISOString() ?? null,
        product: { id: r.product.id, slug: r.product.slug, title: r.product.title, status: r.product.status, fulfilmentMode: r.product.fulfilmentMode },
        variantCode: r.variantCode,
        variantName: r.variantCode ? (variants.find((v) => v.id === r.variantCode)?.name ?? r.variantCode) : "(whole product)",
        tour: { externalId: r.tourExternalId, name: tour?.name ?? null },
        offer: {
          externalId: r.offerExternalId,
          name: offer?.name ?? null,
          bookingKind: offer?.bookingKind ?? null,
          isExternal: offer?.isExternal ?? false,
          removed: !offer || offer.removedAt !== null,
        },
        mapping: m && holds ? { id: m.id, ticketEvidence: ref?.success ? (ref.data.ticketEvidence ?? null) : null } : null,
      };
    });
  },

  /**
   * Record whether a mapped TravelDesk offer issues tickets at confirmation
   * (`externalRef.ticketEvidence`, Q-T1). The answer decides three things:
   *  - readiness: an offer that may issue tickets only fits a
   *    "non-refundable once confirmed" page (`policyWithinSupplier`);
   *  - customer cancellation: refused unless the answer is `no`
   *    (cancellation.service);
   *  - documents: with `no` and no codes seen, a live booking completes on
   *    its voucher with no staff codes read (document.service).
   *
   * Administrators only (`products.activate_instant`, owner answer Q6), with
   * a fresh authenticator code, a source and a reason; audited before and
   * after. `yes` and clearing (`unknown`) tighten and are allowed at any
   * time. `no` loosens refunds, so it is refused while the product is
   * instant: switch it to inquiry, record the answer, then activate again
   * (which needs the second approver in production).
   */
  async setTicketEvidence(actor: Actor, mappingId: string, input: TicketEvidenceInput, now: Date = new Date()): Promise<TicketEvidenceRecord | null> {
    requirePermission(actor, "products.activate_instant");
    if (!actor.id) throw Errors.forbidden("products.activate_instant");
    const source = input.source.trim();
    const note = input.note.trim();
    if (input.issuesTicketsAtConfirm !== "unknown" && (source.length < 8 || source.length > 200)) {
      throw Errors.validation({ source: "Say where the answer comes from (8 to 200 characters), e.g. the TEST booking number and what its confirm answer held" });
    }
    if (note.length < 8) throw Errors.validation({ note: "Give a reason of at least 8 characters — it goes in the audit log" });
    const refused = await verifyStepUp(actor, input.totpCode, now);
    if (refused) throw Errors.validation({ totpCode: refused === "not_enrolled" ? "Set up your authenticator app first" : "The code was not accepted; wait for a new one" });

    const result = await prisma.$transaction(async (tx) => {
      // Serialise with approve and revoke, which rewrite the same row.
      await tx.$queryRaw`SELECT id FROM product_supplier_mappings WHERE id = ${mappingId}::uuid FOR UPDATE`;
      const m = await tx.productSupplierMapping.findUnique({ where: { id: mappingId }, include: { product: { select: { id: true, fulfilmentMode: true, deletedAt: true } }, supplier: { select: { adapter: true } } } });
      if (!m || m.supplier.adapter !== "traveldesk") throw Errors.notFound("Mapping");
      if (!m.isActive || m.product.deletedAt) throw Errors.conflict("This mapping is not active");
      const ref = travelDeskExternalRefSchema.safeParse(m.externalRef);
      if (!ref.success) throw Errors.conflict("This mapping's TravelDesk reference is unreadable; approve it again first");
      if (input.issuesTicketsAtConfirm === "no" && m.product.fulfilmentMode === "instant") {
        throw Errors.conflict("This product is instant. Switch it to inquiry, record the answer, then activate it again", { productId: m.product.id });
      }
      const before = ref.data.ticketEvidence ?? null;
      const record: TicketEvidenceRecord | null = input.issuesTicketsAtConfirm === "unknown" ? null : { issuesTicketsAtConfirm: input.issuesTicketsAtConfirm, source, recordedAt: now.toISOString() };
      const { ticketEvidence: _old, ...rest } = ref.data;
      const externalRef = travelDeskExternalRefSchema.parse({ ...rest, ...(record ? { ticketEvidence: record } : {}) });
      await tx.productSupplierMapping.update({ where: { id: m.id }, data: { externalRef } });
      await audit(actor, "supplier_mapping.ticket_evidence", { type: "product", id: m.product.id }, { before: { mappingId: m.id, ticketEvidence: before }, after: { mappingId: m.id, ticketEvidence: record }, reason: note }, tx);
      return { productId: m.product.id, record };
    }, TX_OPTIONS);
    // After commit, so readiness reads the new answer. Never throws (a failure demotes to inquiry).
    await readinessService.reevaluate(result.productId, "ticket_evidence");
    return result.record;
  },

  /**
   * Human review. Approve writes (or re-activates) the product → TravelDesk
   * mapping for that variant and environment; reject records why. Both are
   * audited with the reason. Neither changes fulfilment mode or price.
   *
   * Concurrency: the FIRST statement claims the candidate with a conditional
   * update (`state = 'suggested'`), so a double-submit, two tabs, or an
   * approve racing a reject cannot both win: the loser updates 0 rows and gets
   * a conflict. The partial unique index then guarantees one approved offer
   * per variant, supplier and environment.
   */
  async reviewCandidate(actor: Actor, candidateId: string, decision: "approve" | "reject", note: string) {
    requirePermission(actor, "suppliers.manage");
    if (!actor.id) throw Errors.forbidden("suppliers.manage");
    if (note.trim().length < 8) throw Errors.validation({ note: "Give a reason of at least 8 characters — it goes in the audit log" });
    const reviewed = { reviewedBy: actor.id, reviewedAt: new Date(), reviewNote: note.trim() };

    const row = await prisma
      .$transaction(async (tx) => {
        const claimed = await tx.supplierMappingCandidate.updateMany({
          where: { id: candidateId, state: "suggested" },
          data: { state: decision === "approve" ? "approved" : "rejected", ...reviewed },
        });
        if (claimed.count === 0) {
          const current = await tx.supplierMappingCandidate.findUnique({ where: { id: candidateId }, select: { state: true } });
          if (!current) throw Errors.notFound("Candidate");
          throw Errors.conflict(`This candidate was already ${current.state}`, { candidateId });
        }
        const c = await tx.supplierMappingCandidate.findUniqueOrThrow({ where: { id: candidateId } });

        if (decision === "reject") {
          await audit(actor, "supplier_mapping.reject", { type: "product", id: c.productId }, { after: { candidateId: c.id, offer: c.offerExternalId, environment: c.environment }, reason: note.trim() }, tx);
          return c;
        }

        const product = await tx.product.findUnique({ where: { id: c.productId }, select: { deletedAt: true, fulfilmentMode: true } });
        if (!product || product.deletedAt) throw Errors.conflict("This product has been deleted", { productId: c.productId });
        if (product.fulfilmentMode === "instant") {
          // A new mapping must not reach an instant product before its readiness is reviewed: switch to inquiry first.
          throw Errors.conflict("This product is instant; switch it to inquiry before adding a TravelDesk mapping", { productId: c.productId });
        }

        const offer = await tx.supplierCatalogueItem.findUnique({
          where: { supplierId_environment_kind_externalId: { supplierId: c.supplierId, environment: c.environment, kind: "offer", externalId: c.offerExternalId } },
        });
        if (!offer || offer.removedAt) throw Errors.conflict("The supplier no longer lists this offer; re-sync before approving", { offer: c.offerExternalId });

        const variantCode = c.variantCode === "" ? null : c.variantCode;
        const existing = await tx.productSupplierMapping.findFirst({ where: { productId: c.productId, supplierId: c.supplierId, variantCode } });
        // Ticket evidence belongs to the offer: kept when the same offer is approved again.
        const prior = existing ? travelDeskExternalRefSchema.safeParse(existing.externalRef) : null;
        const ticketEvidence = prior?.success && String(prior.data.offerId) === c.offerExternalId ? prior.data.ticketEvidence : undefined;
        const externalRef = travelDeskExternalRefSchema.parse({
          tourId: Number(c.tourExternalId),
          offerId: Number(c.offerExternalId),
          bookingKind: offer.bookingKind ?? "unknown",
          isExternal: offer.isExternal,
          ...(ticketEvidence ? { ticketEvidence } : {}),
        });
        if (existing?.isActive && existing.environment && existing.environment !== c.environment) {
          // One mapping row per product, supplier and variant: never let a test approval and a production approval overwrite each other.
          throw Errors.conflict(`An active ${existing.environment} mapping exists for this variant; revoke it first`, { mappingId: existing.id });
        }
        if (existing?.isActive && existing.supplierOfferId && existing.supplierOfferId !== c.offerExternalId) {
          throw Errors.conflict(`This variant is already mapped to offer ${existing.supplierOfferId}; revoke it first`, { mappingId: existing.id });
        }
        const tourRow = await tx.supplierCatalogueItem.findUnique({
          where: { supplierId_environment_kind_externalId: { supplierId: c.supplierId, environment: c.environment, kind: "tour", externalId: c.tourExternalId } },
        });
        if (!tourRow || tourRow.removedAt) throw Errors.conflict("The supplier no longer lists this tour; re-sync before approving", { tour: c.tourExternalId });
        // The terms the editor approves (SUP-15). Null when the stored payload is unreadable: the
        // mapping is still recorded for inquiry use, but marked changed and never ready.
        const approvedOfferHash = offerTermsHash(offer.payload, tourRow.payload);
        const mappingData = {
          externalRef,
          supplierProductId: c.tourExternalId,
          supplierOfferId: c.offerExternalId,
          bookingKind: offer.bookingKind,
          environment: c.environment,
          isActive: true,
          lastSyncedAt: offer.lastSeenAt,
          syncStatus: approvedOfferHash ? "ok" : "changed",
          approvedOfferHash,
        };
        let mappingId: string;
        if (existing) {
          await tx.productSupplierMapping.update({ where: { id: existing.id }, data: mappingData });
          mappingId = existing.id;
        } else {
          // An additional supplier never takes over as the default (priority 1).
          const top = await tx.productSupplierMapping.aggregate({ where: { productId: c.productId }, _max: { priority: true } });
          mappingId = uuidv7();
          await tx.productSupplierMapping.create({
            data: { id: mappingId, productId: c.productId, supplierId: c.supplierId, variantCode, priority: (top._max.priority ?? 0) + 1, ...mappingData },
          });
        }
        const after = await tx.supplierMappingCandidate.update({ where: { id: c.id }, data: { mappingId } });
        await audit(
          actor,
          "supplier_mapping.approve",
          { type: "product", id: c.productId },
          {
            before: existing ? { mappingId: existing.id, externalRef: existing.externalRef, isActive: existing.isActive } : null,
            after: { mappingId, candidateId: c.id, externalRef, environment: c.environment, approvedOfferHash },
            reason: note.trim(),
          },
          tx,
        );
        return after;
      }, TX_OPTIONS)
      .catch((e: unknown) => {
        if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === "P2002") {
          throw Errors.conflict("Another offer is already approved for this variant, or this approval was submitted twice", { candidateId });
        }
        throw e;
      });
    // After commit, so readiness reads the new mapping. Never throws (a failure demotes to inquiry).
    if (decision === "approve") await readinessService.reevaluate(row.productId, "mapping_approve");
    return row;
  },

  /**
   * Undo an approval: the mapping is deactivated (kept for history) and the
   * candidate goes back to `suggested`, so it can be reviewed again. The audit
   * log keeps both decisions.
   */
  async revokeCandidate(actor: Actor, candidateId: string, note: string) {
    requirePermission(actor, "suppliers.manage");
    if (!actor.id) throw Errors.forbidden("suppliers.manage");
    if (note.trim().length < 8) throw Errors.validation({ note: "Give a reason of at least 8 characters — it goes in the audit log" });
    const row = await prisma.$transaction(async (tx) => {
      const claimed = await tx.supplierMappingCandidate.updateMany({
        where: { id: candidateId, state: "approved" },
        data: { state: "suggested", reviewedBy: actor.id, reviewedAt: new Date(), reviewNote: `Revoked: ${note.trim()}` },
      });
      if (claimed.count === 0) {
        const current = await tx.supplierMappingCandidate.findUnique({ where: { id: candidateId }, select: { state: true } });
        if (!current) throw Errors.notFound("Candidate");
        throw Errors.conflict("Only an approved candidate can be revoked", { candidateId });
      }
      const c = await tx.supplierMappingCandidate.findUniqueOrThrow({ where: { id: candidateId } });
      let mappingDeactivated = false;
      if (c.mappingId) {
        // Only deactivate the mapping if it still points at THIS candidate's offer and environment.
        const m = await tx.productSupplierMapping.findUnique({ where: { id: c.mappingId } });
        if (m && m.supplierOfferId === c.offerExternalId && m.environment === c.environment) {
          await tx.productSupplierMapping.update({ where: { id: m.id }, data: { isActive: false } });
          mappingDeactivated = true;
        }
      }
      const after = await tx.supplierMappingCandidate.update({ where: { id: c.id }, data: { mappingId: null } });
      await audit(
        actor,
        "supplier_mapping.revoke",
        { type: "product", id: c.productId },
        { before: { candidateId: c.id, mappingId: c.mappingId, state: "approved" }, after: { state: "suggested", mappingDeactivated }, reason: note.trim() },
        tx,
      );
      return after;
    }, TX_OPTIONS);
    await readinessService.reevaluate(row.productId, "mapping_revoke");
    return row;
  },

  /** Put a rejected candidate back up for review. */
  async reopenCandidate(actor: Actor, candidateId: string, note: string) {
    requirePermission(actor, "suppliers.manage");
    if (!actor.id) throw Errors.forbidden("suppliers.manage");
    if (note.trim().length < 8) throw Errors.validation({ note: "Give a reason of at least 8 characters — it goes in the audit log" });
    return prisma.$transaction(async (tx) => {
      const claimed = await tx.supplierMappingCandidate.updateMany({
        where: { id: candidateId, state: "rejected" },
        data: { state: "suggested", reviewedBy: actor.id, reviewedAt: new Date(), reviewNote: `Reopened: ${note.trim()}` },
      });
      if (claimed.count === 0) {
        const current = await tx.supplierMappingCandidate.findUnique({ where: { id: candidateId }, select: { state: true } });
        if (!current) throw Errors.notFound("Candidate");
        throw Errors.conflict("Only a rejected candidate can be reopened", { candidateId });
      }
      const c = await tx.supplierMappingCandidate.findUniqueOrThrow({ where: { id: candidateId } });
      await audit(actor, "supplier_mapping.reopen", { type: "product", id: c.productId }, { after: { candidateId: c.id, state: "suggested" }, reason: note.trim() }, tx);
      return c;
    }, TX_OPTIONS);
  },
};
