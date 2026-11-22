import "server-only";
import type { Tx } from "../lib/db";
import { env } from "../lib/env";
import { uuidv7 } from "../lib/ids";
import { emitEvent } from "../lib/structured-events";
import { crmScopeFrom, originatorIdFor, type CrmScope } from "./crm.config";
import { CRM_PAYLOAD_VERSION, originIdFor, type CrmSubject } from "./crm.mapping";

/**
 * CRM outbox writes (doc 29 §6.2, §6.4; CRM batch C1), called inside the
 * domain transaction that changes an inquiry or order, as its last
 * statements.
 *
 * Switch semantics (doc 29 §6.4, §7.3 "rollback: switch the worker off;
 * outbox rows wait"): rows are enqueued whenever a CRM portal scope is
 * configured for this environment (`CRM_BITRIX_PORTAL_HOST` plus a valid
 * `CRM_BITRIX_ENV` pairing), whether or not delivery is on, and are only
 * ever delivered by the worker while `CRM_SYNC_ENABLED=true`. With no portal
 * configured (every environment after C1) nothing is written at all: these
 * functions return before touching the database.
 *
 * Per row: the subject's `crm_links` row is upserted and its `local_version`
 * bumped in one statement, which takes the link's row lock until commit. A
 * second transaction for the same subject waits there and reads the first
 * one's committed version, so versions follow commit order and "a row at or
 * below the pushed version is a no-op" holds. One outbox row per change,
 * keyed `kind:entity:version@scope`. No payload.
 *
 * Never fails the domain transaction: the writes run under a savepoint, and
 * any error rolls back to it, emits `crm.enqueue_failed` and returns. The
 * CRM copy then lags until the subject's next change (the C3 reconciler is
 * the backstop). A missing migration therefore cannot break checkout.
 */

const SAVEPOINT = "crm_outbox_enqueue";

export type CrmOutboxKind = "sync" | "delete";
export type CrmDeleteReason = "erasure" | "retention";

/** The scope rows are written for, or null when no portal is configured (nothing is enqueued). */
export function crmOutboxScope(): CrmScope | null {
  return crmScopeFrom(env());
}

function sorted(subjects: CrmSubject[]): CrmSubject[] {
  const seen = new Set<string>();
  const out: CrmSubject[] = [];
  for (const s of subjects) {
    const key = `${s.type}:${s.id.toLowerCase()}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ type: s.type, id: s.id.toLowerCase() });
  }
  // A fixed lock order: two transactions enqueueing the same subjects cannot deadlock on the link rows.
  return out.sort((a, b) => (a.type === b.type ? a.id.localeCompare(b.id) : a.type.localeCompare(b.type)));
}

export function dedupeKeyFor(kind: CrmOutboxKind, subject: CrmSubject, version: bigint, scope: CrmScope): string {
  return `${kind}:${subject.type}:${subject.id}:${version}@${scope.environment}/${scope.portal}`;
}

/** One subject's link bump and outbox row. Returns false when nothing was written (a delete with no link, or a tombstone). */
async function writeOne(tx: Tx, scope: CrmScope, subject: CrmSubject, kind: CrmOutboxKind, reason: CrmDeleteReason | null): Promise<boolean> {
  let rows: { local_version: bigint; state: string }[];
  if (kind === "sync") {
    rows = await tx.$queryRaw<{ local_version: bigint; state: string }[]>`
      INSERT INTO crm_links (id, environment, portal, entity_type, entity_id, originator_id, origin_id, local_version, updated_at)
      VALUES (${uuidv7()}::uuid, ${scope.environment}, ${scope.portal}, ${subject.type}, ${subject.id}::uuid,
              ${originatorIdFor(scope.environment)}, ${originIdFor(subject)}, 1, now())
      ON CONFLICT (environment, portal, entity_type, entity_id)
        DO UPDATE SET local_version = crm_links.local_version + 1, updated_at = now()
      RETURNING local_version, state`;
  } else {
    // A delete never creates a link: a subject never pushed has nothing in the CRM.
    rows = await tx.$queryRaw<{ local_version: bigint; state: string }[]>`
      UPDATE crm_links SET local_version = local_version + 1, updated_at = now()
      WHERE environment = ${scope.environment} AND portal = ${scope.portal} AND entity_type = ${subject.type}
        AND entity_id = ${subject.id}::uuid AND state <> 'deleted'
      RETURNING local_version, state`;
  }
  const link = rows[0];
  if (!link) return false;
  // A tombstoned subject is never re-created by a later change (doc 29 §6.4, 30-bitrix-crm §8 deletion).
  if (link.state === "deleted") return false;
  const version = BigInt(link.local_version);
  await tx.$executeRaw`
    INSERT INTO crm_outbox (id, environment, portal, entity_type, entity_id, kind, version, payload_version, dedupe_key, reason, updated_at)
    VALUES (${uuidv7()}::uuid, ${scope.environment}, ${scope.portal}, ${subject.type}, ${subject.id}::uuid, ${kind}, ${version},
            ${CRM_PAYLOAD_VERSION}, ${dedupeKeyFor(kind, subject, version, scope)}, ${reason}, now())
    ON CONFLICT (dedupe_key) DO NOTHING`;
  return true;
}

async function guarded(tx: Tx, subjects: CrmSubject[], run: () => Promise<number>): Promise<number> {
  await tx.$executeRawUnsafe(`SAVEPOINT ${SAVEPOINT}`);
  try {
    const n = await run();
    await tx.$executeRawUnsafe(`RELEASE SAVEPOINT ${SAVEPOINT}`);
    return n;
  } catch (e) {
    // If even the rollback fails, the transaction is lost anyway: let the caller see the original error.
    await tx.$executeRawUnsafe(`ROLLBACK TO SAVEPOINT ${SAVEPOINT}`).catch(() => {
      throw e;
    });
    const first = subjects[0];
    emitEvent("crm.enqueue_failed", { entityType: first?.type ?? "none", entityId: first?.id ?? null, count: subjects.length, reason: errorCode(e) }, "error");
    return 0;
  }
}

function errorCode(e: unknown): string {
  const code = (e as { code?: unknown })?.code;
  return typeof code === "string" && /^[A-Za-z0-9_]{1,20}$/.test(code) ? `db_${code}` : "db_error";
}

/**
 * Enqueue a full-snapshot push for each subject. Call last in the domain
 * transaction. Returns the number of rows written (0 when no portal is
 * configured, or on a swallowed failure).
 */
export async function enqueueCrmSync(tx: Tx, subjects: CrmSubject[], scope: CrmScope | null = crmOutboxScope()): Promise<number> {
  if (!scope || subjects.length === 0) return 0;
  const list = sorted(subjects);
  return guarded(tx, list, async () => {
    let n = 0;
    for (const s of list) if (await writeOne(tx, scope, s, "sync", null)) n += 1;
    return n;
  });
}

/**
 * Enqueue deletion of the CRM copies of subjects that have a link: erasure
 * propagation (doc 29 §6.5) and the 2-year retention delete (owner decision
 * 19). Delivery stays off in C1.
 */
export async function enqueueCrmDelete(tx: Tx, subjects: CrmSubject[], reason: CrmDeleteReason, scope: CrmScope | null = crmOutboxScope()): Promise<number> {
  if (!scope || subjects.length === 0) return 0;
  const list = sorted(subjects);
  return guarded(tx, list, async () => {
    let n = 0;
    for (const s of list) if (await writeOne(tx, scope, s, "delete", reason)) n += 1;
    return n;
  });
}

/**
 * The deal subject of an order: its source inquiry when it came from one
 * (one deal per sale, reused on conversion), else the order itself.
 */
export async function crmSubjectForOrder(tx: Tx, orderId: string): Promise<CrmSubject | null> {
  const o = await tx.order.findUnique({ where: { id: orderId }, select: { id: true, sourceInquiryId: true } });
  if (!o) return null;
  return o.sourceInquiryId ? { type: "inquiry", id: o.sourceInquiryId } : { type: "order", id: o.id };
}

/** Enqueue a push for the deal subject of each order (payment, booking and refund changes). */
export async function enqueueCrmSyncForOrders(tx: Tx, orderIds: string[], scope: CrmScope | null = crmOutboxScope()): Promise<number> {
  if (!scope || orderIds.length === 0) return 0;
  const subjects: CrmSubject[] = [];
  // The lookup runs under the same savepoint guard as the writes.
  return guarded(tx, [{ type: "order", id: orderIds[0] }], async () => {
    for (const id of [...new Set(orderIds)]) {
      const s = await crmSubjectForOrder(tx, id);
      if (s) subjects.push(s);
    }
    let n = 0;
    for (const s of sorted(subjects)) if (await writeOne(tx, scope, s, "sync", null)) n += 1;
    return n;
  });
}

/**
 * Erasure propagation (doc 29 §6.5): called in `privacyService.eraseContact`'s
 * transaction. Every erased inquiry, and every erased order (through its deal
 * subject), gets a `delete` of its CRM copies; only subjects that were ever
 * linked get a row. A deal of an erased inquiry is deleted even when its
 * order is kept for an obligation: the CRM copy is a convenience copy and C1
 * puts no personal data on it, so deletion loses nothing the order needs.
 */
export async function enqueueCrmErasure(tx: Tx, records: { inquiryIds: string[]; orderIds: string[] }, scope: CrmScope | null = crmOutboxScope()): Promise<number> {
  if (!scope || records.inquiryIds.length + records.orderIds.length === 0) return 0;
  const first: CrmSubject = records.inquiryIds.length ? { type: "inquiry", id: records.inquiryIds[0] } : { type: "order", id: records.orderIds[0] };
  return guarded(tx, [first], async () => {
    const subjects: CrmSubject[] = records.inquiryIds.map((id) => ({ type: "inquiry", id }));
    for (const id of records.orderIds) {
      const s = await crmSubjectForOrder(tx, id);
      if (s) subjects.push(s);
    }
    let n = 0;
    for (const s of sorted(subjects)) if (await writeOne(tx, scope, s, "delete", "erasure")) n += 1;
    return n;
  });
}
