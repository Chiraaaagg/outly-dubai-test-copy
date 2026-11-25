import "server-only";
import { type Actor, requirePermission } from "../lib/actor";
import { audit } from "../lib/audit";
import { sha256Hex } from "../lib/crypto";
import { prisma, TX_OPTIONS } from "../lib/db";
import { Errors } from "../lib/errors";
import { uuidv7 } from "../lib/ids";
import { activitySchema } from "../schemas/activity.schema";
import type { Activity } from "@/lib/types";
import { activityService, type ActivityListFilters } from "./activity.service";
import { APPROVAL_TTL_MS, MAX_ITEMS_PER_RUN, type ApprovalEnvironment } from "./approval.service";
import { catalogService } from "./catalog.service";
import { readinessService } from "./readiness.service";
import { supplierCatalogService } from "./supplier-catalog.service";
import { useApproval } from "./supplier-booking.service";

/**
 * Bulk actions on listings (doc 30 §3.12, build N2; owner decisions D6, D15,
 * D16; review P30-08, P30-09).
 *
 *  - `arm`: requested mode instant ("arm / make instant"). Readiness still
 *    decides each listing's effective mode, so an armed listing sells as
 *    inquiry until every check passes. Loosening: one approval
 *    (`instant.activate.bulk`, a fresh code; one person in production under
 *    D15/D16, see approval.service.ts) for the frozen item list.
 *  - `inquiry`: back to inquiry. Tightening: no approval, as the single flip.
 *  - `free_cancellation`: "free cancellation confirmed" (D6, run only on
 *    TravelDesk's written answer). Per listing: disarm, record "no ticket
 *    issued at confirmation" with its source on every TravelDesk link,
 *    rewrite the cancellation text to the supplier's window, arm again if it
 *    was armed. Loosening: one approval, same mechanics as `arm`.
 *
 * Mechanics:
 *  - Selection: explicit ids, or "select all matching" recomputed here from
 *    the console's filters. At most `MAX_ITEMS_PER_RUN` (50) listings.
 *  - Burned once: the approval is used (`useApproval`) in the transaction
 *    that creates the `bulk_operations` row holding the frozen, sorted item
 *    list and its hash; the payload the approval was asked for names that
 *    hash, so a changed list never matches. One approval, one run (unique
 *    index).
 *  - Running: items run under that row, only by the person who started it,
 *    only for 30 minutes. Each item re-runs its own checks and writes its own
 *    audit rows naming the bulk id, and commits alone: the result lists
 *    applied, skipped and failed items with reasons.
 *  - Re-run: finished items are skipped. After expiry a new approval is
 *    needed over the remaining items (`remainingItems`).
 *  - Undo of `arm`: a bulk `inquiry` run.
 *
 * Two runs racing over one item: each item write is conditional (a mode
 * write only from the mode it read; the item row only from `pending`), and
 * every step of `free_cancellation` writes the same values twice at worst.
 */

export const BULK_ACTIONS = ["arm", "inquiry", "free_cancellation"] as const;
export type BulkAction = (typeof BULK_ACTIONS)[number];
/** Items of one run (the plan's cap; also the approval's item cap). */
export const BULK_RUN_MAX = MAX_ITEMS_PER_RUN;
/** How long a run may execute its items after it was started. */
export const BULK_WINDOW_MS = APPROVAL_TTL_MS;

export type BulkItemState = "pending" | "applied" | "skipped" | "failed";

export interface BulkItemResult {
  productId: string;
  state: BulkItemState;
  /** Short reason code (`armed`, `already_instant`, `instant_not_released`, ...). */
  outcome: string | null;
}

export interface BulkRunResult {
  bulkId: string;
  action: BulkAction;
  expired: boolean;
  applied: BulkItemResult[];
  skipped: BulkItemResult[];
  failed: BulkItemResult[];
  /** Items not run (expired window): a new approval is needed over them. */
  remaining: string[];
}

export interface BulkSelection {
  ids?: readonly string[];
  filters?: ActivityListFilters;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** The frozen item list: unique, sorted. */
export function freezeItems(ids: readonly string[]): string[] {
  return [...new Set(ids.map((i) => i.trim().toLowerCase()))].sort();
}

/** sha256 hex over the frozen item list. */
export function bulkItemsHash(ids: readonly string[]): string {
  return sha256Hex(JSON.stringify(freezeItems(ids)));
}

/**
 * The approval payload of a loosening run: the action, the approval
 * environment and the frozen list's hash and size. Asked for once, used once.
 */
export function bulkApprovalPayload(action: BulkAction, environment: ApprovalEnvironment, ids: readonly string[]) {
  const items = freezeItems(ids);
  return { kind: "bulk_listings", action, environment, itemsHash: bulkItemsHash(items), itemCount: items.length };
}

function checkReason(reason: string): string {
  const r = reason.trim();
  if (r.length < 8 || r.length > 500) throw Errors.validation({ reason: "Give a reason of 8 to 500 characters — it goes in the audit log" });
  return r;
}

/** The written answer's reference: names a message or document, never contact data. */
function checkSource(source: string | undefined): string {
  const s = (source ?? "").trim();
  if (s.length < 8 || s.length > 200) throw Errors.validation({ source: "Name TravelDesk's written answer (8 to 200 characters), e.g. the message date and subject" });
  if (/@|\+?\d[\d\s-]{8,}\d/.test(s)) throw Errors.validation({ source: "Name the written answer; never an email address or a phone number" });
  return s;
}

/** The cancellation text a confirmed window gets (doc 30 §3.4). Date-only offers count from 00:00 Dubai time on the day. */
export function freeCancellationText(hours: number, dateOnly: boolean): string {
  return dateOnly ? `Free cancellation up to ${hours} hours before 00:00 Dubai time on the day` : `Free cancellation up to ${hours} hours before the start time`;
}

function permissionFor(action: BulkAction) {
  return action === "inquiry" ? "products.publish" : "products.activate_instant";
}

const reasonOf = (error: unknown): string => {
  if (error && typeof error === "object" && "code" in error && typeof (error as { code: unknown }).code === "string") {
    const details = (error as { details?: { reason?: unknown } }).details;
    const extra = typeof details?.reason === "string" ? `:${details.reason}` : "";
    return `${(error as { code: string }).code.toLowerCase()}${extra}`.replace(/[^a-z0-9_.:-]+/g, "_").slice(0, 80);
  }
  return "unexpected_error";
};

export const bulkListingService = {
  /**
   * The item list of a selection, recomputed here: explicit ids, or every
   * live listing matching the console's filters. Refuses an empty list, more
   * than 50 listings, unknown or deleted listings.
   */
  async resolveSelection(actor: Actor, target: BulkSelection): Promise<string[]> {
    requirePermission(actor, "products.edit");
    let ids: string[];
    if (target.ids && target.ids.length) {
      if (target.ids.some((i) => !UUID.test(i.trim().toLowerCase()))) throw Errors.validation({ ids: "Unknown listing id" });
      ids = freezeItems(target.ids);
    } else if (target.filters) {
      if (target.filters.status === "deleted") throw Errors.validation({ ids: "Deleted listings cannot be changed in bulk" });
      const list = await activityService.list(actor, { ...target.filters, page: 1, pageSize: BULK_RUN_MAX + 1 });
      if (list.total > BULK_RUN_MAX) throw Errors.validation({ ids: `${list.total} listings match. One run takes at most ${BULK_RUN_MAX}; narrow the filters.` });
      ids = freezeItems(list.rows.map((r) => r.id));
    } else {
      ids = [];
    }
    if (ids.length === 0) throw Errors.validation({ ids: "Select at least one listing" });
    if (ids.length > BULK_RUN_MAX) throw Errors.validation({ ids: `One run takes at most ${BULK_RUN_MAX} listings` });
    const found = await prisma.product.count({ where: { id: { in: ids }, deletedAt: null } });
    if (found !== ids.length) throw Errors.validation({ ids: "A selected listing no longer exists" });
    return ids;
  },

  /**
   * Start one run: the row and its items, burning the approval in the same
   * transaction (loosening actions). `productIds` must be exactly the list
   * the approval was asked for.
   */
  async start(
    actor: Actor,
    input: { action: BulkAction; productIds: readonly string[]; reason: string; source?: string },
    opts: { environment: ApprovalEnvironment; approvalId?: string | null; now?: Date },
  ): Promise<{ bulkId: string; itemCount: number }> {
    if (!(BULK_ACTIONS as readonly string[]).includes(input.action)) throw Errors.validation({ action: "Unknown bulk action" });
    requirePermission(actor, permissionFor(input.action));
    if (input.action === "free_cancellation") requirePermission(actor, "products.edit");
    if (!actor.id || actor.type !== "admin") throw Errors.forbidden(permissionFor(input.action));
    const reason = checkReason(input.reason);
    if (input.action === "free_cancellation") checkSource(input.source);
    const items = freezeItems(input.productIds);
    if (items.length === 0 || items.length > BULK_RUN_MAX) throw Errors.validation({ ids: `One run takes 1 to ${BULK_RUN_MAX} listings` });
    const now = opts.now ?? new Date();
    const loosening = input.action !== "inquiry";
    if (loosening && !opts.approvalId) throw Errors.forbidden("products.activate_instant");
    const bulkId = uuidv7();

    await prisma.$transaction(async (tx) => {
      let approvalMode: string | null = null;
      if (loosening) {
        await useApproval(tx, actor, opts.approvalId!, "instant.activate.bulk", bulkApprovalPayload(input.action, opts.environment, items), opts.environment, now);
        approvalMode = (await tx.privilegedApproval.findUniqueOrThrow({ where: { id: opts.approvalId! }, select: { approvalMode: true } })).approvalMode;
      }
      await tx.bulkOperation.create({
        data: {
          id: bulkId,
          action: input.action,
          environment: opts.environment,
          approvalId: loosening ? opts.approvalId! : null,
          approvalMode,
          requestedBy: actor.id!,
          itemsHash: bulkItemsHash(items),
          itemCount: items.length,
          reason,
          createdAt: now,
          expiresAt: new Date(now.getTime() + BULK_WINDOW_MS),
        },
      });
      await tx.bulkOperationItem.createMany({ data: items.map((productId, position) => ({ id: uuidv7(), bulkId, productId, position, state: "pending" })) });
      await audit(
        actor,
        "bulk_operation.started",
        { type: "bulk_operation", id: bulkId },
        { after: { action: input.action, environment: opts.environment, itemCount: items.length, itemsHash: bulkItemsHash(items), approvalId: opts.approvalId ?? null, approvalMode }, reason },
        tx,
      );
    }, TX_OPTIONS);
    return { bulkId, itemCount: items.length };
  },

  /**
   * Run the pending items of a run. Only the person who started it, only in
   * its window. Each item commits alone and is never re-run once finished.
   * `source` is the written answer for `free_cancellation` (not stored on
   * the run; each link records it).
   */
  async run(actor: Actor, bulkId: string, opts: { source?: string; now?: Date } = {}): Promise<BulkRunResult> {
    const bulk = await prisma.bulkOperation.findUnique({ where: { id: bulkId }, include: { items: { orderBy: { position: "asc" } } } });
    if (!bulk) throw Errors.notFound("Bulk run");
    const action = bulk.action as BulkAction;
    requirePermission(actor, permissionFor(action));
    if (actor.id !== bulk.requestedBy) throw Errors.forbidden(permissionFor(action));
    const source = action === "free_cancellation" ? checkSource(opts.source) : null;
    const clock = () => opts.now ?? new Date();
    const expired = clock().getTime() >= bulk.expiresAt.getTime();

    if (!expired) {
      for (const item of bulk.items) {
        if (item.state !== "pending") continue;
        // The window is checked before each item: a run never starts an item after it closed.
        if (clock().getTime() >= bulk.expiresAt.getTime()) break;
        let state: Exclude<BulkItemState, "pending">;
        let outcome: string;
        try {
          const r = await runItem(actor, action, item.productId, bulk, source);
          state = r.state;
          outcome = r.outcome;
        } catch (error) {
          state = "failed";
          outcome = reasonOf(error);
        }
        const finished = await prisma.bulkOperationItem.updateMany({ where: { id: item.id, state: "pending" }, data: { state, outcome, finishedAt: new Date() } });
        if (finished.count === 1) {
          await audit(actor, "bulk_operation.item", { type: "product", id: item.productId }, { after: { bulkId, action, state, outcome } });
        }
      }
      const open = await prisma.bulkOperationItem.count({ where: { bulkId, state: "pending" } });
      if (open === 0) await prisma.bulkOperation.updateMany({ where: { id: bulkId, finishedAt: null }, data: { finishedAt: new Date() } });
    }

    const items = await prisma.bulkOperationItem.findMany({ where: { bulkId }, orderBy: { position: "asc" } });
    const pick = (s: BulkItemState) => items.filter((i) => i.state === s).map((i) => ({ productId: i.productId, state: s, outcome: i.outcome }));
    return {
      bulkId,
      action,
      expired: expired || items.some((i) => i.state === "pending"),
      applied: pick("applied"),
      skipped: pick("skipped"),
      failed: pick("failed"),
      remaining: items.filter((i) => i.state === "pending").map((i) => i.productId),
    };
  },

  /** The pending items of an expired run: what a new approval would cover. */
  async remainingItems(actor: Actor, bulkId: string): Promise<string[]> {
    requirePermission(actor, "products.edit");
    const items = await prisma.bulkOperationItem.findMany({ where: { bulkId, state: "pending" }, select: { productId: true } });
    return freezeItems(items.map((i) => i.productId));
  },
};

async function runItem(
  actor: Actor,
  action: BulkAction,
  productId: string,
  bulk: { id: string; approvalId: string | null; reason: string },
  source: string | null,
): Promise<{ state: "applied" | "skipped" | "failed"; outcome: string }> {
  const why = `${bulk.reason} (bulk ${bulk.id})`;
  if (action === "arm") {
    const r = await catalogService.setProductModeForBulk(actor, productId, "instant", why, { bulkId: bulk.id, approvalId: bulk.approvalId });
    return { state: r.state, outcome: r.state === "applied" ? (r.effectiveMode === "instant" ? "armed_instant" : "armed_inquiry_until_ready") : r.outcome };
  }
  if (action === "inquiry") {
    const r = await catalogService.setProductModeForBulk(actor, productId, "inquiry", why, { bulkId: bulk.id, approvalId: null });
    return { state: r.state, outcome: r.outcome };
  }
  return freeCancellationItem(actor, productId, bulk, source!, why);
}

/** One listing of a "free cancellation confirmed" run (D6). Stops at the first refusal; the listing is then left on inquiry. */
async function freeCancellationItem(
  actor: Actor,
  productId: string,
  bulk: { id: string; approvalId: string | null },
  source: string,
  why: string,
): Promise<{ state: "applied" | "skipped" | "failed"; outcome: string }> {
  const assessed = await readinessService.assess(productId);
  const product = await prisma.product.findUnique({ where: { id: productId }, select: { id: true, fulfilmentMode: true, deletedAt: true, version: true, content: true } });
  if (!product || product.deletedAt) return { state: "failed", outcome: "not_found" };
  const links = assessed.mappings;
  if (links.length === 0) return { state: "skipped", outcome: "no_traveldesk_link" };
  // Tickets are non-refundable once issued, whatever evidence says (Batch 5).
  if (links.some((m) => m.openDatedSellable === true)) return { state: "skipped", outcome: "ticket_never_refundable" };
  const hours = links.map((m) => m.supplierFreeCancellationHours);
  if (hours.some((h) => h === null)) return { state: "failed", outcome: "supplier_policy_unknown" };
  if (hours.some((h) => h === 0)) return { state: "skipped", outcome: "supplier_non_refundable" };
  // The page's window must be at least every option's supplier window (policyWithinSupplier).
  const window = Math.max(...(hours as number[]));
  const dateOnly = links.every((m) => m.dateOnlySellable === true);
  if (!dateOnly && links.some((m) => m.dateOnlySellable === true)) return { state: "failed", outcome: "mixed_date_only_options" };
  const parsed = activitySchema.safeParse(product.content);
  if (!parsed.success) return { state: "failed", outcome: "content_invalid" };
  const text = freeCancellationText(window, dateOnly);
  const doc = parsed.data as Activity;
  const alreadyDone = doc.freeCancellationHours === window && doc.cancellationPolicy === text && links.every((m) => m.issuesTicketsAtConfirm === "no");
  if (alreadyDone) return { state: "skipped", outcome: "already_confirmed" };

  const wasArmed = product.fulfilmentMode === "instant";
  // 1. Disarm: `setTicketEvidence` refuses "no" while a listing is instant.
  if (wasArmed) await catalogService.setProductModeForBulk(actor, productId, "inquiry", why, { bulkId: bulk.id, approvalId: null });
  // 2. Record the answer with its source on every link.
  for (const m of links) {
    await supplierCatalogService.recordNoTicketForBulk(actor, m.mappingId, source, why, { bulkId: bulk.id, approvalId: bulk.approvalId! });
  }
  // 3. Rewrite the cancellation text (a version row and an audit row through the activity service).
  const { id: _id, rating: _r, reviewCount: _rc, bookedThisMonth: _b, ...input } = doc;
  await activityService.update(actor, productId, { ...input, freeCancellationHours: window, cancellationPolicy: text }, {
    reason: why,
    expectedVersion: product.version,
  });
  // 4. Arm again, under the same approval, if it was armed.
  if (wasArmed) {
    const r = await catalogService.setProductModeForBulk(actor, productId, "instant", why, { bulkId: bulk.id, approvalId: bulk.approvalId });
    return { state: "applied", outcome: r.effectiveMode === "instant" ? "confirmed_rearmed_instant" : "confirmed_rearmed_inquiry_until_ready" };
  }
  return { state: "applied", outcome: "confirmed" };
}
