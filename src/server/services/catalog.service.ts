import "server-only";
import type { Prisma } from "@prisma/client";
import { prisma, TX_OPTIONS } from "../lib/db";
import type { Actor } from "../lib/actor";
import { requirePermission } from "../lib/actor";
import { audit } from "../lib/audit";
import { AppError, Errors } from "../lib/errors";
import { moneyToMinor } from "../lib/money";
import { revalidateCatalog } from "../lib/catalog-cache";
import { env } from "../lib/env";
import { supplierFor } from "../suppliers/registry";
import type { PrivilegedApproval } from "../suppliers/booking-port";
import { approvalService, type ApprovalEnvironment } from "./approval.service";
import { readinessService } from "./readiness.service";
import { assertBulkItemInTx } from "./bulk-guard";
import { log } from "../lib/logger";
import type { ReadinessResult } from "../quotes/contracts";
import { activityBySlug as fixtureActivityBySlug } from "@/lib/data/activities";
import { comboBySlug } from "@/lib/data/combos";
import { activitySchema } from "../schemas/activity.schema";
import { effectiveModeFrom, storefrontGate } from "@/lib/catalog/eligibility";
import type { Activity } from "@/lib/types";
import { computeBreakdown, variantById } from "@/lib/pricing";
import { paxBillable, scaleMoney } from "@/lib/utils";
import type { CartItem, FulfilmentMode, Money, PaxCount } from "@/lib/types";

/**
 * Catalogue service — the read model the backend owns today:
 *
 *  - `fulfilment_mode` per product/combo (THE HINGE, §17 §6.4) with an
 *    audited admin flip. This is the Rathin go-live switch and its rollback.
 *  - Server-side re-pricing of cart items from `products.content` (the
 *    admin-owned activity document; fixtures only as a fallback for rows
 *    without a document), so an inquiry's indicative totals are never taken
 *    from the client (§13.1 threat #1 applies to indicative prices too — an
 *    agent triages on them). Combos are still fixture-priced (future phase).
 */

export interface PricedItem {
  cartItem: CartItem;
  productId?: string;
  comboId?: string;
  tier: string;
  unit: Money;
  total: Money;
  unitMinor: { inr: bigint; aed: bigint };
  totalMinor: { inr: bigint; aed: bigint };
  fulfilmentMode: FulfilmentMode;
  /** True when the client's total differed from the server's — recorded, not rejected. */
  clientMismatch: boolean;
  /** What the customer was shown — snapshotted onto inquiry_items and copied to order_items. */
  inclusions: string[];
  cancellationPolicy: Record<string, unknown>;
  /**
   * Catalogue facts for the inquiry item snapshot, from the server's record,
   * never the cart (PRD-5). `variantName` is null when the cart named a
   * variant the product does not have.
   */
  snapshot: { title: string; image: string; variantName: string | null; confirmation: "instant" | "manual"; freeCancellationHours: number; durationMinutes: number };
  /** Snapshot fields where the cart disagreed with the server — recorded as a signal, not rejected. */
  snapshotMismatch: string[];
}

/** One cart line that can no longer be priced (deleted, unpublished or unknown product). */
export interface UnavailableLine {
  index: number;
  slug: string;
  kind: "activity" | "combo";
}

/**
 * 422 naming the cart lines that are no longer sold (PRD-26), so the form can
 * remove them instead of failing the whole inquiry. The field keys
 * (`items.<index>`) are what the inquiry form reads.
 */
export function unavailableLinesError(lines: UnavailableLine[]): AppError {
  const fields: Record<string, string> = { items: "Some items in your trip are no longer available" };
  for (const l of lines) fields[`items.${l.index}`] = `${l.slug} is no longer available`;
  return new AppError({
    status: 422,
    code: "VALIDATION_FAILED",
    message: "Some items in your trip are no longer available",
    recovery: "Remove them and send the rest.",
    details: { fields, unavailable: lines },
  });
}

function snapshotMismatchOf(item: CartItem, server: PricedItem["snapshot"]): string[] {
  const out: string[] = [];
  if (item.title !== server.title) out.push("title");
  if (item.image !== server.image) out.push("image");
  if ((item.variantName ?? null) !== server.variantName) out.push("variantName");
  if (item.confirmation !== server.confirmation) out.push("confirmation");
  if (item.freeCancellationHours !== server.freeCancellationHours) out.push("freeCancellationHours");
  if (item.durationMinutes !== server.durationMinutes) out.push("durationMinutes");
  return out;
}

/**
 * Outcome of a fulfilment flip. `pending` means a production activation is
 * waiting for a second administrator: nothing was written and the product
 * keeps its current mode.
 */
export type FulfilmentFlipResult =
  | { status: "applied"; id: string; fulfilmentMode: FulfilmentMode; approvalId: string | null; readiness?: ReadinessResult | null }
  | { status: "pending"; id: string; fulfilmentMode: FulfilmentMode; approvalId: string };

/** `APP_ENV` values that positively identify a non-production deployment. */
const TEST_APP_ENVS: ReadonlySet<string> = new Set(["development", "test"]);

/**
 * Approval environment for catalogue operations, failing closed to production
 * (CR-B1-3). Reads the raw variables rather than `env().APP_ENV`, which
 * defaults an unset value to `development`. Only an explicit allowlisted
 * `APP_ENV` outside a Vercel production deployment counts as `test`; unset,
 * `staging`, `production` or anything else needs the second approver.
 */
export function approvalEnvironmentFor(raw: { APP_ENV?: string; VERCEL_ENV?: string }): ApprovalEnvironment {
  if (raw.VERCEL_ENV === "production") return "production";
  return raw.APP_ENV !== undefined && TEST_APP_ENVS.has(raw.APP_ENV) ? "test" : "production";
}

function approvalEnvironment(): ApprovalEnvironment {
  return approvalEnvironmentFor({ APP_ENV: process.env.APP_ENV, VERCEL_ENV: process.env.VERCEL_ENV });
}

/**
 * Step-up and, in production, a second approver for one instant activation.
 * The payload names only the product and the target mode, so two
 * administrators asking for the same activation with different reasons match.
 */
async function requestInstantActivation(actor: Actor, productId: string, totpCode: string | undefined): Promise<Extract<PrivilegedApproval, { status: "applied" | "pending" }>> {
  if (!totpCode) throw Errors.validation({ totpCode: "Enter the current code from your authenticator app" }, "Activating instant booking needs a fresh authenticator code");
  const approval = await approvalService.requestPrivileged(
    actor,
    "instant.activate",
    "products.activate_instant",
    { kind: "product", productId, mode: "instant" },
    { environment: approvalEnvironment(), totpCode },
  );
  if (approval.status === "refused") {
    if (approval.reason === "forbidden") throw Errors.forbidden("products.activate_instant");
    if (approval.reason === "step_up_required") {
      throw Errors.validation({ totpCode: "That code was not accepted. Wait for a new code and try again." }, "Activating instant booking needs a fresh authenticator code");
    }
    if (approval.reason === "item_cap") {
      throw Errors.conflict("You have reached the limit of 100 instant activations in one hour. Try again later or ask another administrator.", { reason: approval.reason });
    }
    throw Errors.conflict("This activation request can no longer be approved — start a new one", { reason: approval.reason });
  }
  return approval;
}

type ProductWithMappings = Prisma.ProductGetPayload<{ include: { mappings: { include: { supplier: true } }; listingLink: { select: { kind: true; deactivatedAt: true } } } }>;
/** What `assertInstantAllowed` reads: the mappings with their suppliers, and the doc 30 listing link. */
const INSTANT_CHECK_INCLUDE = { mappings: { include: { supplier: true } }, listingLink: { select: { kind: true, deactivatedAt: true } } } as const;

/**
 * The checks an instant request must pass before any approval is asked for
 * or used: the release switch, an active API supplier mapping, and every
 * active API mapping's adapter able to confirm a booking. Shared by the
 * single flip and each item of a bulk arm run (doc 30 §3.12).
 */
function assertInstantAllowed(before: ProductWithMappings): void {
  // Doc 30 D4 (review 106 N1-06): an imported TravelDesk inquiry listing can never be armed, singly or in bulk.
  const link = before.listingLink;
  if (link && !link.deactivatedAt && link.kind === "inquiry") {
    throw Errors.conflict("This is a TravelDesk inquiry listing (options that are never instant); it cannot be made instant", { productId: before.id });
  }
  if (env().INSTANT_RELEASE_ENABLED !== true) {
    throw Errors.validation(
      { mode: "Instant booking is switched off for this environment. Products stay in inquiry mode until it is released." },
      "Instant mode is not released in this environment",
    );
  }
  const apiMapping = before.mappings.find((m) => m.isActive && m.supplier.source === "api" && m.supplier.adapter !== "manual" && m.supplier.status === "active" && !m.supplier.deletedAt);
  if (!apiMapping) {
    throw Errors.conflict("Instant mode needs an active API supplier mapping (Rathin) on this product", { productId: before.id });
  }
  // Every active API mapping's adapter must actually be able to confirm a
  // booking: whichever one the booking path picks, it must not be one that
  // cannot. TravelDesk confirms only where its booking mutations are
  // allowed (travelDeskMutationRefusal); elsewhere its mappings keep a
  // product in inquiry mode, whatever the supplier row says.
  for (const m of before.mappings) {
    // An editorial supplier record (adapter "manual", made from the content's supplier block) never
    // books: the instant path reads only the booking supplier's own mappings (readiness/quote).
    if (!m.isActive || m.supplier.source !== "api" || m.supplier.deletedAt || m.supplier.adapter === "manual") continue;
    let confirms = false;
    try {
      confirms = supplierFor(m.supplier, env()).capabilities().instantConfirmation;
    } catch {
      confirms = false; // unknown adapter string
    }
    if (!confirms) {
      throw Errors.conflict("This supplier's integration cannot confirm bookings yet, so the product must stay in inquiry mode", {
        productId: before.id,
        adapter: m.supplier.adapter,
      });
    }
  }
}

/** Outcome of one bulk item's mode write (doc 30 §3.12). */
export type BulkModeOutcome = { state: "applied" | "skipped"; outcome: string; effectiveMode: FulfilmentMode | null };

export const catalogService = {
  /**
   * Inquiry pricing (indicative). Unchanged arithmetic (`computeBreakdown`,
   * fixture combo prices); what changed in B2:
   *  - every snapshot fact comes from the server record (PRD-5), the cart's
   *    copy only feeds `snapshotMismatch`;
   *  - a line whose product or combo is no longer published is reported with
   *    all the others in one `unavailableLinesError` (PRD-26) instead of
   *    failing on the first;
   *  - pricing a database row from its fixture (invalid stored content) logs
   *    a warning. This path is never used for payment: the paid quote reads
   *    validated database content only (PRD-13).
   */
  async priceCartItems(items: CartItem[]): Promise<PricedItem[]> {
    const slugs = items.map((i) => i.slug);
    const [products, combos] = await Promise.all([
      prisma.product.findMany({ where: { slug: { in: slugs }, deletedAt: null, status: "published" }, select: { id: true, slug: true, fulfilmentMode: true, tier: true, content: true } }),
      prisma.combo.findMany({ where: { slug: { in: slugs }, deletedAt: null, status: "published" }, select: { id: true, slug: true, fulfilmentMode: true, tier: true } }),
    ]);
    const productBySlug = new Map(products.map((p) => [p.slug, p]));
    const comboBySlugDb = new Map(combos.map((c) => [c.slug, c]));

    const out: PricedItem[] = [];
    const unavailable: UnavailableLine[] = [];
    for (const [index, item] of items.entries()) {
      const pax: PaxCount = item.pax;
      if (item.kind === "combo") {
        const combo = comboBySlug(item.slug);
        const row = comboBySlugDb.get(item.slug);
        if (!combo || !row) {
          unavailable.push({ index, slug: item.slug, kind: "combo" });
          continue;
        }
        const billable = Math.max(1, paxBillable(pax));
        const base = scaleMoney(combo.bundlePrice, billable);
        const upgrades = combo.upgrades.filter((u) => item.addOnIds.includes(u.id));
        const total = upgrades.reduce(
          (sum, u) => ({
            inr: sum.inr + (u.perPerson ? u.price.inr * billable : u.price.inr),
            aed: sum.aed + (u.perPerson ? u.price.aed * billable : u.price.aed),
          }),
          base,
        );
        const snapshot = { title: combo.name, image: combo.heroImage, variantName: null, confirmation: combo.confirmation, freeCancellationHours: combo.freeCancellationHours, durationMinutes: 0 };
        out.push({
          cartItem: item,
          comboId: row.id,
          tier: row.tier,
          unit: combo.bundlePrice,
          total,
          unitMinor: moneyToMinor(combo.bundlePrice),
          totalMinor: moneyToMinor(total),
          // Combos are inquiry by rule (doc 22 §22.2), whatever the row says.
          fulfilmentMode: "inquiry",
          clientMismatch: Math.round(total.inr) !== Math.round(item.total.inr),
          inclusions: combo.highlights,
          cancellationPolicy: { text: combo.cancellationPolicy, freeCancellationHours: combo.freeCancellationHours },
          snapshot,
          snapshotMismatch: snapshotMismatchOf(item, snapshot),
        });
        continue;
      }

      const row = productBySlug.get(item.slug);
      const parsed = row ? activitySchema.safeParse(row.content) : null;
      let activity: Activity | undefined = parsed?.success ? (parsed.data as Activity) : undefined;
      if (row && !activity) {
        activity = fixtureActivityBySlug(item.slug);
        if (activity) log.warn("catalog.price_fixture_fallback", { slug: item.slug });
      }
      if (!activity || !row) {
        unavailable.push({ index, slug: item.slug, kind: "activity" });
        continue;
      }
      const breakdown = computeBreakdown(activity, pax, item.variantId, item.addOnIds);
      const variant = item.variantId ? variantById(activity, item.variantId) : undefined;
      const snapshot = {
        title: activity.title,
        image: activity.images[0],
        variantName: variant?.name ?? null,
        confirmation: activity.confirmation,
        freeCancellationHours: activity.freeCancellationHours,
        durationMinutes: activity.durationMinutes,
      };
      out.push({
        cartItem: item,
        productId: row.id,
        tier: row.tier,
        unit: breakdown.perPersonFrom,
        total: breakdown.total,
        unitMinor: moneyToMinor(breakdown.perPersonFrom),
        totalMinor: moneyToMinor(breakdown.total),
        fulfilmentMode: row.fulfilmentMode,
        clientMismatch: Math.round(breakdown.total.inr) !== Math.round(item.total.inr),
        inclusions: activity.inclusions,
        cancellationPolicy: { text: activity.cancellationPolicy, freeCancellationHours: activity.freeCancellationHours },
        snapshot,
        snapshotMismatch: snapshotMismatchOf(item, snapshot),
      });
    }
    if (unavailable.length) throw unavailableLinesError(unavailable);
    return out;
  },

  async listProducts() {
    const rows = await prisma.product.findMany({
      where: { deletedAt: null },
      orderBy: [{ tier: "asc" }, { title: "asc" }],
      include: { mappings: { where: { isActive: true }, include: { supplier: { select: { source: true, adapter: true, status: true, deletedAt: true } } } } },
    });
    return rows.map(({ mappings, ...p }) => ({
      ...p,
      hasApiMapping: mappings.some((m) => m.supplier.source === "api" && m.supplier.adapter !== "manual" && m.supplier.status === "active" && !m.supplier.deletedAt),
    }));
  },

  async listCombos() {
    return prisma.combo.findMany({ where: { deletedAt: null }, orderBy: { name: "asc" } });
  },

  /**
   * Public: the mode each PUBLISHED slug sells in right now (PRD-25: drafts
   * are not listed). Products report their effective eligibility, never the
   * requested column (PRD-11), under the live release switch and the current
   * readiness rules version (`storefrontGate`); combos are always inquiry. A slug missing from
   * the map is not sold any more (PRD-26).
   */
  async fulfilmentModes(): Promise<Record<string, FulfilmentMode>> {
    const [products, combos] = await Promise.all([
      prisma.product.findMany({ where: { deletedAt: null, status: "published" }, select: { slug: true, eligibility: { select: { effectiveMode: true, readinessVersion: true } } } }),
      prisma.combo.findMany({ where: { deletedAt: null, status: "published" }, select: { slug: true } }),
    ]);
    const out: Record<string, FulfilmentMode> = {};
    const gate = storefrontGate();
    for (const p of products) out[p.slug] = effectiveModeFrom(p.eligibility, gate);
    for (const c of combos) out[c.slug] = "inquiry";
    return out;
  },

  /**
   * The flip (§17 §8.2). Per SKU, reversible, audited with a reason. Flipping
   * to `instant` requires the product to have an active API supplier mapping —
   * you cannot promise instant confirmation with a manual supplier.
   *
   * Instant mode is also refused outright while the environment release switch
   * (`INSTANT_RELEASE_ENABLED`, default off) is off: the storefront's paid path
   * is still a mock, so an instant product would show a confirmation for a
   * booking that was never paid for or placed (doc 22 PRD-2). Switching back
   * to inquiry is always allowed.
   *
   * Separation of duties (PRD-12, SEC-10; doc 22 §24.3):
   *  - back to inquiry: `products.publish`, applied at once. Pausing selling
   *    must stay easy.
   *  - to instant: `products.activate_instant`, never `products.publish`, and
   *    only through `approvalService.requestPrivileged` with a fresh TOTP code.
   *    Outside production it is applied after the step-up. In production the
   *    first request stays pending until a different administrator asks for
   *    the same activation with their own code; only then is the column
   *    written. The approval environment comes from the deployment
   *    (`APP_ENV`), never from the request, and anything not positively
   *    non-production counts as production.
   *
   * Every check below runs again on the second person's request, so an
   * activation is applied only if the product still qualifies at that moment.
   */
  async setFulfilmentMode(
    actor: Actor,
    target: { kind: "product" | "combo"; id: string },
    mode: FulfilmentMode,
    reason: string,
    activation?: { totpCode?: string },
  ): Promise<FulfilmentFlipResult> {
    requirePermission(actor, mode === "instant" ? "products.activate_instant" : "products.publish");
    if (!reason.trim()) throw Errors.validation({ reason: "A reason is required — this changes what customers are promised" });
    if (mode === "instant" && env().INSTANT_RELEASE_ENABLED !== true) {
      throw Errors.validation(
        { mode: "Instant booking is switched off for this environment. Products stay in inquiry mode until it is released." },
        "Instant mode is not released in this environment",
      );
    }

    if (target.kind === "product") {
      const before = await prisma.product.findUnique({ where: { id: target.id }, include: INSTANT_CHECK_INCLUDE });
      if (!before) throw Errors.notFound("Product");
      if (mode === "instant") assertInstantAllowed(before);
      let approvalId: string | null = null;
      if (mode === "instant") {
        const approval = await requestInstantActivation(actor, target.id, activation?.totpCode);
        if (approval.status === "pending") {
          return { status: "pending", id: before.id, fulfilmentMode: before.fulfilmentMode, approvalId: approval.approvalId };
        }
        approvalId = approval.approvalId;
      }
      const after = await prisma.product.update({ where: { id: target.id }, data: { fulfilmentMode: mode } });
      await audit(actor, "product.fulfilment_mode", { type: "product", id: target.id }, {
        before: { fulfilmentMode: before.fulfilmentMode },
        after: { fulfilmentMode: after.fulfilmentMode, ...(approvalId ? { approvalId } : {}) },
        reason,
      });
      revalidateCatalog();
      // The column is the requested mode; what the storefront may sell is the readiness verdict (PRD-11).
      const readiness = await readinessService.reevaluate(target.id, "flip");
      return { status: "applied", id: after.id, fulfilmentMode: after.fulfilmentMode, approvalId, readiness };
    }

    const before = await prisma.combo.findUnique({ where: { id: target.id } });
    if (!before) throw Errors.notFound("Combo");
    if (mode === "instant") throw Errors.conflict("Combos stay inquiry-mode until every component product is instant");
    const after = await prisma.combo.update({ where: { id: target.id }, data: { fulfilmentMode: mode } });
    await audit(actor, "combo.fulfilment_mode", { type: "combo", id: target.id }, { before: { fulfilmentMode: before.fulfilmentMode }, after: { fulfilmentMode: after.fulfilmentMode }, reason });
    revalidateCatalog(); // PRD-19: every mode change invalidates the catalogue, combos included.
    return { status: "applied", id: after.id, fulfilmentMode: after.fulfilmentMode, approvalId: null };
  },

  /**
   * One item of a bulk run (doc 30 §3.12; bulk-listing.service.ts): write the
   * requested mode of one product for run `bulk.bulkId`. The run itself is
   * checked here, in the transaction of the write (review N2-06,
   * `assertBulkItemInTx`): started by this person, inside its window, this
   * product a running item of it, and for instant an `arm` or
   * `free_cancellation` run with an applied approval. Instant ("arm") re-runs
   * every check of the single flip before writing; the effective mode stays
   * readiness's verdict, so an armed listing sells as inquiry until every
   * check passes. A product already in the mode is skipped. The audit row
   * names the run. Throws on a refusal; the run records it as that item's
   * failure.
   */
  async setProductModeForBulk(actor: Actor, productId: string, mode: FulfilmentMode, reason: string, bulk: { bulkId: string; now?: Date }): Promise<BulkModeOutcome> {
    requirePermission(actor, mode === "instant" ? "products.activate_instant" : "products.publish");
    const now = bulk.now ?? new Date();
    const before = await prisma.product.findUnique({ where: { id: productId }, include: INSTANT_CHECK_INCLUDE });
    if (!before || before.deletedAt) throw Errors.notFound("Product");
    if (mode === "instant") assertInstantAllowed(before);
    const written = await prisma.$transaction(async (tx) => {
      const { approvalId } = await assertBulkItemInTx(tx, actor, bulk.bulkId, productId, mode === "instant" ? "instant" : "inquiry", now);
      const current = await tx.product.findUnique({ where: { id: productId }, select: { fulfilmentMode: true, deletedAt: true } });
      if (!current || current.deletedAt) throw Errors.notFound("Product");
      if (current.fulfilmentMode === mode) return { state: "skipped" as const, outcome: `already_${mode}` };
      // Conditional on the mode it was read in: a concurrent flip makes this item a skip, never a double write.
      const won = await tx.product.updateMany({ where: { id: productId, fulfilmentMode: current.fulfilmentMode, deletedAt: null }, data: { fulfilmentMode: mode } });
      if (won.count !== 1) return { state: "skipped" as const, outcome: "changed_concurrently" };
      await audit(
        actor,
        "product.fulfilment_mode",
        { type: "product", id: productId },
        { before: { fulfilmentMode: current.fulfilmentMode }, after: { fulfilmentMode: mode, bulkId: bulk.bulkId, ...(mode === "instant" && approvalId ? { approvalId } : {}) }, reason },
        tx,
      );
      return { state: "applied" as const, outcome: mode === "instant" ? "armed" : "inquiry" };
    }, TX_OPTIONS);
    if (written.state !== "applied") return { ...written, effectiveMode: null };
    revalidateCatalog();
    const readiness = await readinessService.reevaluate(productId, "flip");
    return { ...written, effectiveMode: readiness?.effective ?? null };
  },
};
