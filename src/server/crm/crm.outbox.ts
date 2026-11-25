import "server-only";
import type { Tx } from "../lib/db";
import { env } from "../lib/env";
import { uuidv7 } from "../lib/ids";
import { emitEvent } from "../lib/structured-events";
import { crmConfigFrom, crmScopeFrom, originatorIdFor, type CrmScope } from "./crm.config";
import { CRM_PAYLOAD_VERSION, originIdFor, type CrmSubject } from "./crm.mapping";

/**
 * CRM outbox writes (doc 29 §6.2, §6.4; CRM batch C1), called inside the
 * domain transaction that changes an inquiry or order, as its last
 * statements.
 *
 * Switch semantics (doc 29 §6.4, §7.3 "rollback: switch the worker off;
 * outbox rows wait"; C2a with decision C2-12 "no backfill"):
 *  - No portal scope (`CRM_BITRIX_PORTAL_HOST` plus a valid `CRM_BITRIX_ENV`
 *    pairing): nothing is written at all; these functions return before
 *    touching the database.
 *  - A scope, `CRM_SYNC_ENABLED` not exactly `true`: no new subject is
 *    linked, so nothing created before switch-on is ever queued (no
 *    backfill) and setting the portal host alone stages nothing. Only
 *    subjects that already have a link (pushed while the sync was on) get
 *    rows: their changes, and erasure and retention deletes, wait for the
 *    worker. Before the first switch-on there are no links, so nothing at
 *    all is written.
 *  - A scope and `CRM_SYNC_ENABLED=true`: every change is enqueued; a new
 *    subject gets its link at its first change after switch-on. The worker
 *    still never creates a deal for a subject created before switch-on
 *    (crm.worker.ts `SWITCH_ON_SLACK_MS`).
 *  Rows are only ever delivered by the worker while `CRM_SYNC_ENABLED=true`.
 *  The outbox never holds a payload (ids and versions only).
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
 *
 * Never waits long on the link lock (review R12): a payment, booking or
 * refund transaction must not run into its own timeout because another
 * transaction on the same deal subject holds the link row. The link
 * statement runs with `lock_timeout` = `CRM_LINK_LOCK_TIMEOUT` under its own
 * savepoint (the caller's setting is restored afterwards). When the lock is
 * not granted in time (55P03) the change is enqueued deferred instead: an
 * outbox row that does not touch the link, due `CRM_DEFERRED_DELAY_MS`
 * later, with `CRM_DEFERRED_VERSION` (above any real version) so the worker
 * never treats it as stale: it re-reads the subject then, after both
 * transactions have committed, and pushes the full snapshot unless the hash
 * is unchanged. If the transaction holding the lock was creating the link
 * and rolled back, the deferred row finds no link and the change waits for
 * the subject's next one (the C3 reconciler is the backstop).
 */

const SAVEPOINT = "crm_outbox_enqueue";
const LINK_SAVEPOINT = "crm_outbox_link";
/** How long an enqueue waits for the subject's link row lock before it falls back to a deferred row. */
export const CRM_LINK_LOCK_TIMEOUT = "1s";
/** A deferred row is due this much later, after the transactions holding the link lock have committed. */
export const CRM_DEFERRED_DELAY_MS = 60_000;
/** The version of a deferred row: above any link version, so it is never a stale no-op (the push takes the link's own version). */
export const CRM_DEFERRED_VERSION = 2n ** 62n;

export type CrmOutboxKind = "sync" | "delete";
export type CrmDeleteReason = "erasure" | "retention";

/** The scope rows are written for, or null when no portal is configured (nothing is enqueued). */
export function crmOutboxScope(): CrmScope | null {
  return crmScopeFrom(env());
}

const deliverable = new WeakMap<object, boolean>();

/**
 * Whether a change may link a subject not linked yet: only while the sync is
 * switched on AND the whole configuration validates, so links exist only
 * when the worker can deliver (no backfill, C2-12; review C2A-04: a subject
 * linked while a value was wrong would later be refused as "before
 * switch-on"). Memoised per parsed environment.
 */
export function crmNewLinksAllowed(): boolean {
  const e = env();
  if (e.CRM_SYNC_ENABLED !== true) return false;
  let ok = deliverable.get(e);
  if (ok === undefined) {
    ok = crmConfigFrom(e) !== null;
    deliverable.set(e, ok);
  }
  return ok;
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

/** Postgres `lock_not_available` (a `lock_timeout` expiry), however the driver reports it. */
export function isLockTimeout(e: unknown): boolean {
  const err = e as { code?: unknown; meta?: { code?: unknown; driverAdapterError?: { cause?: { originalCode?: unknown; code?: unknown } } }; message?: unknown } | null;
  const codes = [err?.code, err?.meta?.code, err?.meta?.driverAdapterError?.cause?.originalCode, err?.meta?.driverAdapterError?.cause?.code];
  if (codes.includes("55P03")) return true;
  return typeof err?.message === "string" && /55P03|lock timeout/i.test(err.message);
}

/** The link statement under its own savepoint, bounded by the short lock timeout. Null when the lock was not granted in time. */
async function bumpLink(tx: Tx, scope: CrmScope, subject: CrmSubject, kind: CrmOutboxKind, newLinks: boolean): Promise<{ local_version: bigint; state: string }[] | null> {
  await tx.$executeRawUnsafe(`SAVEPOINT ${LINK_SAVEPOINT}`);
  try {
    const rows = await linkStatement(tx, scope, subject, kind, newLinks);
    await tx.$executeRawUnsafe(`RELEASE SAVEPOINT ${LINK_SAVEPOINT}`);
    return rows;
  } catch (e) {
    if (!isLockTimeout(e)) throw e;
    await tx.$executeRawUnsafe(`ROLLBACK TO SAVEPOINT ${LINK_SAVEPOINT}`);
    return null;
  }
}

/**
 * The fallback when the link lock was busy: a row that does not touch the
 * link (a plain read never waits on a row lock), due later. Its key carries
 * its own id, so it never collides with the versioned rows. A delete is only
 * written for a subject with a committed, not-deleted link.
 */
async function writeDeferred(tx: Tx, scope: CrmScope, subject: CrmSubject, kind: CrmOutboxKind, reason: CrmDeleteReason | null, newLinks: boolean): Promise<boolean> {
  const [link] = await tx.$queryRaw<{ state: string }[]>`
    SELECT state FROM crm_links
    WHERE environment = ${scope.environment} AND portal = ${scope.portal} AND entity_type = ${subject.type} AND entity_id = ${subject.id}::uuid`;
  if (link?.state === "deleted") return false;
  if ((kind === "delete" || !newLinks) && !link) return false;
  const version = CRM_DEFERRED_VERSION;
  const id = uuidv7();
  await tx.$executeRaw`
    INSERT INTO crm_outbox (id, environment, portal, entity_type, entity_id, kind, version, payload_version, dedupe_key, reason, next_attempt_at, updated_at)
    VALUES (${id}::uuid, ${scope.environment}, ${scope.portal}, ${subject.type}, ${subject.id}::uuid, ${kind}, ${version},
            ${CRM_PAYLOAD_VERSION}, ${`${kind}:${subject.type}:${subject.id}:deferred-${id}@${scope.environment}/${scope.portal}`}, ${reason},
            now() + ${`${CRM_DEFERRED_DELAY_MS} milliseconds`}::interval, now())`;
  emitEvent("crm.enqueue_deferred", { entityType: subject.type, entityId: subject.id, kind }, "warn");
  return true;
}

async function linkStatement(tx: Tx, scope: CrmScope, subject: CrmSubject, kind: CrmOutboxKind, newLinks: boolean): Promise<{ local_version: bigint; state: string }[]> {
  let rows: { local_version: bigint; state: string }[];
  if (kind === "sync" && !newLinks) {
    // Sync switched off: only a subject that is already linked takes a row (no backfill, C2-12).
    rows = await tx.$queryRaw<{ local_version: bigint; state: string }[]>`
      UPDATE crm_links SET local_version = local_version + 1, updated_at = now()
      WHERE environment = ${scope.environment} AND portal = ${scope.portal} AND entity_type = ${subject.type}
        AND entity_id = ${subject.id}::uuid
      RETURNING local_version, state`;
  } else if (kind === "sync") {
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
  return rows;
}

/** One subject's link bump and outbox row. Returns false when nothing was written (a delete with no link, or a tombstone). */
async function writeOne(tx: Tx, scope: CrmScope, subject: CrmSubject, kind: CrmOutboxKind, reason: CrmDeleteReason | null, newLinks = false): Promise<boolean> {
  const rows = await bumpLink(tx, scope, subject, kind, newLinks);
  if (rows === null) return writeDeferred(tx, scope, subject, kind, reason, newLinks);
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
    // Local to the transaction; a rollback to the savepoint undoes it, and the caller's value is put back below.
    const [prior] = await tx.$queryRaw<{ setting: string }[]>`SELECT current_setting('lock_timeout') AS setting`;
    await tx.$queryRaw`SELECT set_config('lock_timeout', ${CRM_LINK_LOCK_TIMEOUT}, true)`;
    const n = await run();
    await tx.$queryRaw`SELECT set_config('lock_timeout', ${prior?.setting ?? "0"}, true)`;
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
 * configured, when the sync is off and the subject has no link yet, or on a
 * swallowed failure). `newLinks` defaults to the switch (`crmNewLinksAllowed`).
 */
export async function enqueueCrmSync(tx: Tx, subjects: CrmSubject[], scope: CrmScope | null = crmOutboxScope(), newLinks: boolean = crmNewLinksAllowed()): Promise<number> {
  if (!scope || subjects.length === 0) return 0;
  const list = sorted(subjects);
  return guarded(tx, list, async () => {
    let n = 0;
    for (const s of list) if (await writeOne(tx, scope, s, "sync", null, newLinks)) n += 1;
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
export async function enqueueCrmSyncForOrders(tx: Tx, orderIds: string[], scope: CrmScope | null = crmOutboxScope(), newLinks: boolean = crmNewLinksAllowed()): Promise<number> {
  if (!scope || orderIds.length === 0) return 0;
  const subjects: CrmSubject[] = [];
  // The lookup runs under the same savepoint guard as the writes.
  return guarded(tx, [{ type: "order", id: orderIds[0] }], async () => {
    for (const id of [...new Set(orderIds)]) {
      const s = await crmSubjectForOrder(tx, id);
      if (s) subjects.push(s);
    }
    let n = 0;
    for (const s of sorted(subjects)) if (await writeOne(tx, scope, s, "sync", null, newLinks)) n += 1;
    return n;
  });
}

/**
 * A consent change (review C2A-02): the deal shows the latest marketing
 * consent, so every linked deal subject of this phone (WhatsApp) or email
 * (email) gets a push in the consent's own transaction. Only subjects that
 * already have a live link are touched (never a new link, whatever the
 * switch); a converted inquiry matches through its order's traveller too.
 * Bounded to `CRM_CONTACT_FANOUT_LIMIT` subjects; reaching it emits
 * `crm.contact_fanout_capped` (warn, ids-free), and the C3 reconciler is the
 * backstop for the rest (re-review R-04).
 */
export const CRM_CONTACT_FANOUT_LIMIT = 200;

export async function enqueueCrmSyncForContact(tx: Tx, contact: { phoneE164?: string | null; email?: string | null }, scope: CrmScope | null = crmOutboxScope()): Promise<number> {
  const phone = contact.phoneE164?.trim() || null;
  const email = contact.email?.trim().toLowerCase() || null;
  if (!scope || (!phone && !email)) return 0;
  return guarded(tx, [], async () => {
    const rows = await tx.$queryRaw<{ entity_type: "inquiry" | "order"; entity_id: string }[]>`
      SELECT l.entity_type, l.entity_id::text AS entity_id FROM crm_links l
      WHERE l.environment = ${scope.environment} AND l.portal = ${scope.portal} AND l.state <> 'deleted'
        AND (
          (l.entity_type = 'inquiry' AND EXISTS (
            SELECT 1 FROM inquiries i LEFT JOIN orders o ON o.id = i.converted_order_id
            WHERE i.id = l.entity_id
              AND ((${phone}::text IS NOT NULL AND (i.lead_phone = ${phone} OR o.lead_phone = ${phone}))
                OR (${email}::text IS NOT NULL AND (lower(i.lead_email) = ${email} OR lower(o.lead_email) = ${email})))))
          OR (l.entity_type = 'order' AND EXISTS (
            SELECT 1 FROM orders o WHERE o.id = l.entity_id
              AND ((${phone}::text IS NOT NULL AND o.lead_phone = ${phone}) OR (${email}::text IS NOT NULL AND lower(o.lead_email) = ${email}))))
        )
      ORDER BY l.entity_type, l.entity_id LIMIT ${CRM_CONTACT_FANOUT_LIMIT}`;
    if (rows.length >= CRM_CONTACT_FANOUT_LIMIT) {
      emitEvent("crm.contact_fanout_capped", { limit: CRM_CONTACT_FANOUT_LIMIT, channel: phone ? "whatsapp" : "email" }, "warn");
    }
    let n = 0;
    for (const s of sorted(rows.map((r) => ({ type: r.entity_type, id: r.entity_id })))) if (await writeOne(tx, scope, s, "sync", null, false)) n += 1;
    return n;
  });
}

/**
 * Erasure propagation (doc 29 §6.5): called in `privacyService.eraseContact`'s
 * transaction. Every erased inquiry, and every erased order (through its deal
 * subject), gets a `delete` of its CRM copies; only subjects that were ever
 * linked get a row, whether or not the sync is on (the delete waits for the
 * worker). A deal is deleted even when its order is kept for an obligation
 * (dispute window, open refund): the CRM copy is a convenience copy that
 * carries the customer's details since C2a, so deletion loses nothing the
 * order needs (review C2A-07).
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
