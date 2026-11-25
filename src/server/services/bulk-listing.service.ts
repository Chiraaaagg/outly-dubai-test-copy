import "server-only";
import { type Actor, requirePermission } from "../lib/actor";
import { audit } from "../lib/audit";
import { sha256Hex } from "../lib/crypto";
import { prisma, TX_OPTIONS } from "../lib/db";
import { Errors } from "../lib/errors";
import { uuidv7 } from "../lib/ids";
import { activityInputSchema, activitySchema } from "../schemas/activity.schema";
import { travelDeskExternalRefSchema } from "../suppliers/traveldesk/traveldesk.adapter";
import { DISARMED_OUTCOME } from "./bulk-guard";
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

export type BulkItemState = "pending" | "running" | "applied" | "skipped" | "failed";
/** How long one run holds an item it is executing; a lapsed claim (a crash) can be taken again. */
const CLAIM_MS = 5 * 60_000;

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
        const approval = await tx.privilegedApproval.findUniqueOrThrow({ where: { id: opts.approvalId! }, select: { approvalMode: true, requestedBy: true } });
        // Review N2-10: the person who asked for the run starts and runs it; a second administrator only approves.
        if (approval.requestedBy !== actor.id) throw Errors.conflict("The administrator who asked for this run starts it; your request approved it", { reason: "requester_starts" });
        approvalMode = approval.approvalMode;
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
   * Run the open items of a run. Only the person who started it, only in its
   * window. Each item is claimed first (`pending` → `running` with a lease,
   * recording the listing's requested mode on the first claim), so two runs
   * never execute one item; a claim whose lease lapsed (a crash) can be taken
   * again. Each item commits alone and is never re-run once finished.
   * `source` is the written answer for `free_cancellation` (not stored on the
   * run; each link records it).
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
        if (item.state !== "pending" && item.state !== "running") continue;
        const now = clock();
        // The window is checked before each item: a run never starts an item after it closed.
        if (now.getTime() >= bulk.expiresAt.getTime()) break;
        const claim = await prisma.$queryRaw<{ was_instant: boolean | null }[]>`
          UPDATE bulk_operation_items i
          SET state = 'running', claimed_until = ${new Date(now.getTime() + CLAIM_MS)},
              was_instant = COALESCE(i.was_instant, (SELECT p.fulfilment_mode = 'instant' FROM products p WHERE p.id = i.product_id))
          WHERE i.id = ${item.id}::uuid AND (i.state = 'pending' OR (i.state = 'running' AND i.claimed_until < ${now}))
          RETURNING i.was_instant`;
        if (claim.length === 0) continue; // another run holds it
        const wasInstant = claim[0].was_instant === true;
        let state: FinishedState;
        let outcome: string;
        try {
          const r = await runItem(actor, action, item.productId, bulk, source, wasInstant, now);
          state = r.state;
          outcome = r.outcome;
        } catch (error) {
          state = "failed";
          outcome = reasonOf(error);
        }
        const finished = await prisma.bulkOperationItem.updateMany({ where: { id: item.id, state: "running" }, data: { state, outcome, finishedAt: new Date(), claimedUntil: null } });
        if (finished.count === 1) {
          await audit(actor, "bulk_operation.item", { type: "product", id: item.productId }, { after: { bulkId, action, state, outcome } });
        }
      }
      const open = await prisma.bulkOperationItem.count({ where: { bulkId, state: { in: ["pending", "running"] } } });
      if (open === 0) await prisma.bulkOperation.updateMany({ where: { id: bulkId, finishedAt: null }, data: { finishedAt: new Date() } });
    }

    const items = await prisma.bulkOperationItem.findMany({ where: { bulkId }, orderBy: { position: "asc" } });
    const pick = (s: BulkItemState) => items.filter((i) => i.state === s).map((i) => ({ productId: i.productId, state: s, outcome: i.outcome }));
    const unfinished = items.filter((i) => i.state === "pending" || i.state === "running");
    return {
      bulkId,
      action,
      expired: expired || unfinished.length > 0,
      applied: pick("applied"),
      skipped: pick("skipped"),
      failed: pick("failed"),
      remaining: unfinished.map((i) => i.productId),
    };
  },

  /** Whether `actor` asked for the approval (the person who starts a run under it, review N2-10). */
  async isRequester(actor: Actor, approvalId: string): Promise<boolean> {
    const row = await prisma.privilegedApproval.findUnique({ where: { id: approvalId }, select: { requestedBy: true } });
    return Boolean(row && actor.id && row.requestedBy === actor.id);
  },

  /** The unfinished items of an expired run: what a new approval would cover. */
  async remainingItems(actor: Actor, bulkId: string): Promise<string[]> {
    requirePermission(actor, "products.edit");
    const items = await prisma.bulkOperationItem.findMany({ where: { bulkId, state: { in: ["pending", "running"] } }, select: { productId: true } });
    return freezeItems(items.map((i) => i.productId));
  },
};

type FinishedState = "applied" | "skipped" | "failed";

async function runItem(
  actor: Actor,
  action: BulkAction,
  productId: string,
  bulk: { id: string; reason: string },
  source: string | null,
  wasInstant: boolean,
  now: Date,
): Promise<{ state: FinishedState; outcome: string }> {
  const why = `${bulk.reason} (bulk ${bulk.id})`;
  const run = { bulkId: bulk.id, now };
  if (action === "arm") {
    const r = await catalogService.setProductModeForBulk(actor, productId, "instant", why, run);
    return { state: r.state, outcome: r.state === "applied" ? (r.effectiveMode === "instant" ? "armed_instant" : "armed_inquiry_until_ready") : r.outcome };
  }
  if (action === "inquiry") {
    const r = await catalogService.setProductModeForBulk(actor, productId, "inquiry", why, run);
    return { state: r.state, outcome: r.outcome };
  }
  return freeCancellationItem(actor, productId, run, source!, why, wasInstant);
}

/** A free-cancellation link as the pre-check reads it. */
export interface FreeCancellationLink {
  mappingId: string;
  /** The stored mapping row, or null when readiness named a mapping the database no longer has. */
  row: { isActive: boolean; adapter: string; bookingKind: string | null; refBookingKind: string | null; refReadable: boolean } | null;
  issuesTicketsAtConfirm: "yes" | "no" | "unknown";
  supplierFreeCancellationHours: number | null;
  dateOnlySellable: boolean;
}

/**
 * Pre-check of one free-cancellation listing, before anything is written
 * (review N2-02, N2-04). Pure. `skip`: nothing to do for a good reason;
 * `fail`: a link the run could not write. Tickets (by booking kind, whatever
 * their key's state) and links with a recorded "yes" are never confirmed.
 */
export function freeCancellationPrecheck(links: readonly FreeCancellationLink[]): { skip?: string; fail?: string; window?: number; dateOnly?: boolean } {
  if (links.length === 0) return { skip: "no_traveldesk_link" };
  if (links.some((l) => l.row?.bookingKind === "ticket_only" || l.row?.refBookingKind === "ticket_only")) return { skip: "ticket_never_refundable" };
  if (links.some((l) => l.issuesTicketsAtConfirm === "yes")) return { skip: "ticket_issued_recorded" };
  if (links.some((l) => !l.row || !l.row.isActive)) return { fail: "link_inactive" };
  if (links.some((l) => l.row!.adapter !== "traveldesk" || !l.row!.refReadable)) return { fail: "link_unreadable" };
  const hours = links.map((l) => l.supplierFreeCancellationHours);
  if (hours.some((h) => h === null)) return { fail: "supplier_policy_unknown" };
  if (hours.some((h) => h === 0)) return { skip: "supplier_non_refundable" };
  const dateOnly = links.every((l) => l.dateOnlySellable);
  if (!dateOnly && links.some((l) => l.dateOnlySellable)) return { fail: "mixed_date_only_options" };
  // The page's window must be at least every option's supplier window (policyWithinSupplier).
  return { window: Math.max(...(hours as number[])), dateOnly };
}

/**
 * One listing of a "free cancellation confirmed" run (D6). Every check runs
 * before the first write: the links (active, readable, not a ticket, no
 * recorded "yes"), the supplier windows and the new content. Then: disarm,
 * record "no ticket at confirmation" per link, rewrite the text, arm again if
 * the listing was armed when the item was first claimed (`wasInstant`, kept on
 * the item, so a resumed item still re-arms). A failure after the disarm
 * re-arms the listing when it can (`failed_after_disarm_rearmed:<code>`);
 * when it cannot, the item is `failed_after_disarm:<code>`, which raises an
 * ops alert (bulk-guard.ts).
 */
async function freeCancellationItem(
  actor: Actor,
  productId: string,
  run: { bulkId: string; now: Date },
  source: string,
  why: string,
  wasInstant: boolean,
): Promise<{ state: FinishedState; outcome: string }> {
  const assessed = await readinessService.assess(productId);
  const product = await prisma.product.findUnique({ where: { id: productId }, select: { id: true, fulfilmentMode: true, deletedAt: true, version: true, content: true } });
  if (!product || product.deletedAt) return { state: "failed", outcome: "not_found" };
  const rows = await prisma.productSupplierMapping.findMany({
    where: { id: { in: assessed.mappings.map((m) => m.mappingId) } },
    select: { id: true, isActive: true, bookingKind: true, externalRef: true, supplier: { select: { adapter: true } } },
  });
  const links: FreeCancellationLink[] = assessed.mappings.map((m) => {
    const row = rows.find((r) => r.id === m.mappingId);
    const ref = row ? travelDeskExternalRefSchema.safeParse(row.externalRef) : null;
    return {
      mappingId: m.mappingId,
      row: row
        ? { isActive: row.isActive, adapter: row.supplier.adapter, bookingKind: row.bookingKind, refBookingKind: ref?.success ? ref.data.bookingKind : null, refReadable: Boolean(ref?.success) }
        : null,
      issuesTicketsAtConfirm: m.issuesTicketsAtConfirm,
      supplierFreeCancellationHours: m.supplierFreeCancellationHours,
      dateOnlySellable: m.dateOnlySellable === true,
    };
  });
  const pre = freeCancellationPrecheck(links);
  if (pre.skip) return { state: "skipped", outcome: pre.skip };
  if (pre.fail) return { state: "failed", outcome: pre.fail };
  const window = pre.window!;
  const text = freeCancellationText(window, pre.dateOnly!);
  const parsed = activitySchema.safeParse(product.content);
  if (!parsed.success) return { state: "failed", outcome: "content_invalid" };
  const doc = parsed.data as Activity;
  if (doc.freeCancellationHours === window && doc.cancellationPolicy === text && links.every((l) => l.issuesTicketsAtConfirm === "no")) return { state: "skipped", outcome: "already_confirmed" };
  const { id: _id, rating: _r, reviewCount: _rc, bookedThisMonth: _b, ...input } = doc;
  const next = { ...input, freeCancellationHours: window, cancellationPolicy: text };
  if (!activityInputSchema.safeParse(next).success) return { state: "failed", outcome: "content_invalid" };

  // 1. Disarm: `setTicketEvidence` refuses "no" while a listing is instant.
  if (product.fulfilmentMode === "instant") await catalogService.setProductModeForBulk(actor, productId, "inquiry", why, run);
  try {
    // 2. Record the answer with its source on every link.
    for (const l of links) await supplierCatalogService.recordNoTicketForBulk(actor, l.mappingId, source, why, { bulkId: run.bulkId }, run.now);
    // 3. Rewrite the cancellation text (a version row and an audit row through the activity service).
    await activityService.update(actor, productId, next, { reason: why, expectedVersion: product.version });
  } catch (error) {
    if (!wasInstant) return { state: "failed", outcome: reasonOf(error) };
    try {
      await catalogService.setProductModeForBulk(actor, productId, "instant", why, run);
      return { state: "failed", outcome: `failed_after_disarm_rearmed:${reasonOf(error)}`.slice(0, 120) };
    } catch {
      return { state: "failed", outcome: `${DISARMED_OUTCOME}${reasonOf(error)}`.slice(0, 120) };
    }
  }
  // 4. Arm again, under the same approval, if it was armed when first claimed.
  if (wasInstant) {
    try {
      const r = await catalogService.setProductModeForBulk(actor, productId, "instant", why, run);
      return { state: "applied", outcome: r.effectiveMode === "instant" ? "confirmed_rearmed_instant" : "confirmed_rearmed_inquiry_until_ready" };
    } catch (error) {
      return { state: "failed", outcome: `${DISARMED_OUTCOME}rearm_${reasonOf(error)}`.slice(0, 120) };
    }
  }
  return { state: "applied", outcome: "confirmed" };
}
