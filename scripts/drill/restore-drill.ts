/**
 * Local restore drill, Part A (docs/backend/24-runbook-restore-drill.md §3).
 *
 *   NODE_OPTIONS=--conditions=react-server node node_modules/tsx/dist/cli.mjs \
 *     scripts/drill/restore-drill.ts --out=<directory outside the repository>
 *
 * Runs on the disposable PG 17 server of scripts/test-db/up.sh, next to the
 * guarded test database, without touching that database's contents:
 *
 *   1. create `outly_test_drill_src` (marker copied, guard passing), apply
 *      every migration;
 *   2. load the synthetic scenario set (scripts/drill/synthetic-load.ts);
 *   3. baseline: row count and checksum of every table, money and ledger
 *      invariants, sequences, the catalogue of constraints and triggers;
 *   4. `pg_dump -Fc` inside the container, timed;
 *   5. the incident on the source: work in the window that the restore will
 *      rewind (a capture, a confirmation, a refund, a whole new order, the
 *      sales pause), then `DELETE FROM notifications`; the supplier's and the
 *      gateway's view of the world after it is recorded as the fakes' state;
 *   6. restore into a fresh `outly_test_drill_restore` with
 *      `pg_restore --no-owner`, timed;
 *   7. the §6 checks on the restored database against the baseline;
 *   8. F35: release switch, sales pause, the supplier reconciliation
 *      (`supplierBookingService.reconcile` with a fake supplier listing),
 *      the payment comparison with the fake gateway's state, the readiness
 *      verdict and the ops queues, all against the restored database only;
 *   9. drop both drill databases and the dump, and verify they are gone.
 *
 * Nothing leaves the machine: the egress block refuses every non-loopback
 * connection in this process, the supplier and the gateway are fakes, and no
 * worker runs. The evidence (counts, checksums, timings, findings; no codes,
 * tokens, URLs or contacts) is written to <out>/evidence.json.
 */
import { spawnSync } from "node:child_process";
import { closeSync, mkdirSync, openSync, rmSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import type { PrismaClient } from "@prisma/client";
import { catalogSnapshot } from "../../src/server/__tests__/helpers/scratch-db";
import { ciphertextKeyId, decryptFor, hmacFor, KeyUnavailableError, setKeyRingsForTests, sha256Hex } from "../../src/server/lib/crypto";
import { uuidv7 } from "../../src/server/lib/ids";
import { installEgressBlock, TargetGuardError } from "../lib/target-guard";
import {
  assertContainerIsMain,
  CONTAINER,
  createDrillDb,
  dropDrillDb,
  listDrillDbs,
  migrateDrillDb,
  openDrillDb,
  openMain,
  ROOT,
  type DrillDb,
  type Main,
} from "./drill-db";
import { loadSyntheticScenarios, type LoadSummary } from "./synthetic-load";

const SRC = "outly_test_drill_src";
const RESTORE = "outly_test_drill_restore";
/** Append-only tables and whether DELETE is refused too (product_versions: UPDATE only, rows go with their product, 20260920070000). */
const APPEND_ONLY: [string, boolean][] = [
  ["audit_logs", true],
  ["inquiry_events", true],
  ["consents", true],
  ["supplier_booking_events", true],
  ["settlements", true],
  ["ledger_entries", true],
  ["product_versions", false],
];

type Json = Record<string, unknown>;
type Raw = Pick<PrismaClient, "$queryRawUnsafe" | "$executeRawUnsafe" | "$transaction">;

function log(step: string, detail = "") {
  console.log(`[drill] ${new Date().toISOString()} ${step}${detail ? `: ${detail}` : ""}`);
}

const big = (v: unknown) => (typeof v === "bigint" ? v.toString() : v);
const plain = (v: unknown) => JSON.parse(JSON.stringify(v, (_k, x) => big(x)));

/* ------------------------------------------------------------------ baseline */

interface Baseline {
  takenAt: string;
  tables: Record<string, { rows: number; checksum: string }>;
  sequences: Record<string, string | null>;
  bigintIds: Record<string, { min: string | null; max: string | null; n: number }>;
  money: Json;
  ledgerByOrder: Record<string, Record<string, string>>;
  catalog: Record<string, string[]>;
  /** Privileges as they apply (a NULL ACL read as the owner's defaults), per relation. */
  effectiveAcls: string[];
}

async function tableNames(db: Raw): Promise<string[]> {
  const rows = await db.$queryRawUnsafe<{ t: string }[]>(
    `SELECT quote_ident(n.nspname) || '.' || quote_ident(c.relname) AS t FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
     WHERE c.relkind IN ('r', 'p') AND n.nspname IN ('public', 'zz_disposable') ORDER BY 1`,
  );
  return rows.map((r) => r.t);
}

async function moneyInvariants(db: Raw): Promise<Json> {
  const one = async (sql: string) => Number((await db.$queryRawUnsafe<{ n: number }[]>(sql))[0].n);
  return {
    refundedAboveCaptured: await one(`SELECT count(*)::int AS n FROM payments WHERE refunded_minor > captured_minor OR captured_minor > amount_minor`),
    refundCapBreaches: await one(
      `SELECT count(*)::int AS n FROM payments p JOIN LATERAL (
         SELECT COALESCE(SUM(amount_minor) FILTER (WHERE status = 'succeeded'), 0) AS s, COALESCE(SUM(amount_minor) FILTER (WHERE status NOT IN ('succeeded', 'failed')), 0) AS o
         FROM refunds r WHERE r.payment_id = p.id) r ON true
       WHERE GREATEST(p.refunded_minor, r.s) + r.o > p.captured_minor`,
    ),
    itemCapBreaches: await one(
      `SELECT count(*)::int AS n FROM order_items i JOIN LATERAL (SELECT COALESCE(SUM(amount_minor), 0) AS s FROM refunds r WHERE r.order_item_id = i.id AND r.status <> 'failed') r ON true
       WHERE i.charged_amount_minor IS NOT NULL AND r.s > i.charged_amount_minor - COALESCE(i.discount_alloc_minor, 0) + COALESCE(i.tax_alloc_minor, 0)`,
    ),
    customerMoneyMismatches: await one(
      `SELECT count(*)::int AS n FROM payments p LEFT JOIN LATERAL (SELECT COALESCE(SUM(amount_minor), 0) AS s FROM ledger_entries l WHERE l.book = 'customer_money' AND l.payment_id = p.id) l ON true
       WHERE p.source = 'gateway_verified' AND l.s <> p.captured_minor - p.refunded_minor`,
    ),
    walletMismatches: await one(
      `SELECT count(*)::int AS n FROM supplier_bookings b LEFT JOIN LATERAL (SELECT COALESCE(SUM(amount_minor), 0) AS s FROM ledger_entries l WHERE l.book = 'supplier_wallet' AND l.supplier_booking_id = b.id) l ON true
       WHERE l.s <> -COALESCE(b.charged_net_minor, 0) + COALESCE(b.refund_minor, 0)`,
    ),
    settlementLedger: (await db.$queryRawUnsafe<{ v: string }[]>(
      `SELECT ((SELECT COALESCE(SUM(net_minor), 0) FROM settlements) = (SELECT COALESCE(SUM(amount_minor), 0) FROM ledger_entries WHERE book = 'gateway_settlement'))::text AS v`,
    ))[0].v === "true",
  };
}

async function takeBaseline(db: Raw): Promise<Baseline> {
  const tables: Baseline["tables"] = {};
  for (const t of await tableNames(db)) {
    const [r] = await db.$queryRawUnsafe<{ n: bigint; sum: string }[]>(
      `SELECT count(*)::bigint AS n, md5(COALESCE(string_agg(h, ',' ORDER BY h), '')) AS sum FROM (SELECT md5(x::text) AS h FROM ${t} x) s`,
    );
    tables[t] = { rows: Number(r.n), checksum: r.sum };
  }
  const seqRows = await db.$queryRawUnsafe<{ name: string; v: string | null }[]>(`SELECT schemaname || '.' || sequencename AS name, last_value::text AS v FROM pg_sequences WHERE schemaname = 'public' ORDER BY 1`);
  const bigintIds: Baseline["bigintIds"] = {};
  for (const t of ["audit_logs", "inquiry_events"]) {
    const [r] = await db.$queryRawUnsafe<{ min: string | null; max: string | null; n: number }[]>(`SELECT min(id)::text AS min, max(id)::text AS max, count(*)::int AS n FROM ${t}`);
    bigintIds[t] = r;
  }
  const ledger = await db.$queryRawUnsafe<{ ref: string; book: string; s: string }[]>(
    `SELECT COALESCE(o.reference, '(none)') AS ref, l.book, SUM(l.amount_minor)::text AS s FROM ledger_entries l LEFT JOIN orders o ON o.id = l.order_id GROUP BY 1, 2 ORDER BY 1, 2`,
  );
  const ledgerByOrder: Baseline["ledgerByOrder"] = {};
  for (const r of ledger) (ledgerByOrder[r.ref] ??= {})[r.book] = r.s;
  return {
    takenAt: new Date().toISOString(),
    tables,
    sequences: Object.fromEntries(seqRows.map((r) => [r.name, r.v])),
    bigintIds,
    money: await moneyInvariants(db),
    ledgerByOrder,
    catalog: await catalogSnapshot(db),
    effectiveAcls: (
      await db.$queryRawUnsafe<{ v: string }[]>(
        `SELECT c.relname || ' ' || COALESCE((SELECT string_agg(CASE WHEN a.grantee = 0 THEN 'PUBLIC' ELSE pg_get_userbyid(a.grantee) END || ':' || a.privilege_type, ',' ORDER BY 1)
           FROM aclexplode(COALESCE(c.relacl, acldefault(CASE WHEN c.relkind = 'S' THEN 's' ELSE 'r' END::"char", c.relowner))) a), '-') AS v
         FROM pg_class c WHERE c.relnamespace = 'public'::regnamespace AND c.relkind IN ('r', 'v', 'm', 'S', 'p') AND c.relname <> '_prisma_migrations' ORDER BY 1`,
      )
    ).map((r) => r.v),
  };
}

/* ------------------------------------------------------------------ dump and restore */

function docker(args: string[], io: { stdin?: number; stdout?: number } = {}) {
  const t = performance.now();
  const r = spawnSync("docker", args, { stdio: [io.stdin ?? "ignore", io.stdout ?? "pipe", "pipe"], encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
  return { status: r.status, stderr: (r.stderr ?? "").trim(), stdout: typeof r.stdout === "string" ? r.stdout.trim() : "", ms: Math.round(performance.now() - t) };
}

/* ------------------------------------------------------------------ incident */

async function incident(src: DrillDb, refs: Record<string, string>): Promise<Json> {
  const db = src.client;
  const now = new Date();
  const orderOf = async (key: string) => db.order.findUniqueOrThrow({ where: { reference: refs[key] }, include: { items: true, payments: true, paymentSaga: true, supplierBookings: true } });
  const done: string[] = [];
  const event = (bookingId: string, from: string, to: string) =>
    db.supplierBookingEvent.create({ data: { id: uuidv7(), supplierBookingId: bookingId, kind: "transition", fromState: from, toState: to, actor: "engine", detail: { zzDrill: "incident" } } });
  const capture = async (paymentId: string, orderId: string, amount: bigint) => {
    const p = await db.payment.update({ where: { id: paymentId }, data: { status: "captured", capturedMinor: amount, capturedAt: now } });
    await db.ledgerEntry.create({ data: { id: uuidv7(), book: "customer_money", orderId, paymentId, currency: "AED", amountMinor: amount, kind: "capture", evidenceRef: `capture:test:${p.provider}:${p.gatewayPaymentId}:${amount}`, occurredAt: now } });
  };

  // 1. The held authorisation is captured and the booking confirmed.
  {
    const o = await orderOf("awaiting_payment");
    const b = o.supplierBookings[0];
    await capture(o.payments[0].id, o.id, o.payments[0].amountMinor);
    await db.supplierBooking.update({ where: { id: b.id }, data: { state: "confirmed", confirmedAt: now, hasTickets: true } });
    await event(b.id, "awaiting_payment", "confirming");
    await event(b.id, "confirming", "confirmed");
    await db.paymentSaga.update({ where: { orderId: o.id }, data: { state: "fulfilled", version: { increment: 3 } } });
    await db.orderItem.update({ where: { id: o.items[0].id }, data: { status: "confirmed" } });
    await db.order.update({ where: { id: o.id }, data: { status: "confirmed", paidAt: now, confirmedAt: now } });
    done.push(`${refs.awaiting_payment}: captured and confirmed`);
  }
  // 2. The confirming booking is confirmed; attention cleared.
  {
    const o = await orderOf("confirming");
    const b = o.supplierBookings[0];
    await db.supplierBooking.update({ where: { id: b.id }, data: { state: "confirmed", confirmedAt: now, hasTickets: true, attentionRequiredAt: null } });
    await event(b.id, "confirming", "confirmed");
    await db.paymentSaga.update({ where: { orderId: o.id }, data: { state: "fulfilled", attentionRequiredAt: null, version: { increment: 1 } } });
    await db.orderItem.update({ where: { id: o.items[0].id }, data: { status: "confirmed" } });
    await db.order.update({ where: { id: o.id }, data: { status: "confirmed", confirmedAt: now } });
    done.push(`${refs.confirming}: confirmed`);
  }
  // 3. The requested refund succeeds; the cancellation request closes.
  {
    const o = await orderOf("cancel_refund_pending");
    const r = await db.refund.findFirstOrThrow({ where: { paymentId: o.payments[0].id } });
    await db.refund.update({ where: { id: r.id }, data: { status: "succeeded", providerRefundId: "zz-rf-cancel_refund_pending" } });
    await db.payment.update({ where: { id: o.payments[0].id }, data: { refundedMinor: r.amountMinor, status: "refunded" } });
    await db.ledgerEntry.create({ data: { id: uuidv7(), book: "customer_money", orderId: o.id, paymentId: o.payments[0].id, currency: "AED", amountMinor: -r.amountMinor, kind: "refund", evidenceRef: "refund:test:fake-aed-card:zz-rf-cancel_refund_pending", occurredAt: now } });
    await db.cancellationRequest.updateMany({ where: { refundId: r.id }, data: { status: "refunded", closedAt: now } });
    await db.order.update({ where: { id: o.id }, data: { status: "refunded" } });
    done.push(`${refs.cancel_refund_pending}: refund succeeded, request closed`);
  }
  // 4. A whole new instant order in the window: paid, booked, confirmed.
  {
    const model = await orderOf("fulfilled");
    const item = model.items[0];
    const id = uuidv7();
    const itemId = uuidv7();
    refs.window_new = "OUT-ZZDRILL-15";
    const guestId = uuidv7();
    await db.guest.create({ data: { id: guestId, phoneE164: "+999000000215", email: "zz-drill-guest-15@example.test", fullName: "ZZ Drill Guest 15" } });
    await db.order.create({
      data: {
        id, reference: refs.window_new, status: "confirmed", rail: "self_serve", guestId, currency: "AED", subtotalAed: model.subtotalAed, subtotalInr: model.subtotalInr, totalAed: model.totalAed, totalInr: model.totalInr,
        netCostAed: model.netCostAed, leadName: "ZZ Drill Guest 15", leadEmail: "zz-drill-guest-15@example.test", leadPhone: "+999000000215", paidAt: now, confirmedAt: now,
      },
    });
    await db.orderItem.create({
      data: {
        id: itemId, orderId: id, productId: item.productId, mappingId: item.mappingId, titleSnapshot: item.titleSnapshot, tierSnapshot: item.tierSnapshot, slugSnapshot: item.slugSnapshot, kindSnapshot: item.kindSnapshot,
        confirmationSnapshot: item.confirmationSnapshot, fulfilmentModeSnapshot: item.fulfilmentModeSnapshot, freeCancellationHoursSnapshot: item.freeCancellationHoursSnapshot, durationMinutesSnapshot: item.durationMinutesSnapshot,
        serviceDate: item.serviceDate, pax: item.pax ?? {}, unitAed: item.unitAed, unitInr: item.unitInr, totalAed: item.totalAed, totalInr: item.totalInr, netCostAed: item.netCostAed, status: "confirmed",
        fulfilmentOrigin: "instant_checkout", chargedCurrency: "AED", chargedAmountMinor: item.chargedAmountMinor, quoteLineIndex: 0,
      },
    });
    const payId = uuidv7();
    await db.payment.create({
      data: {
        id: payId, orderId: id, gateway: "fake-aed-card", gatewayOrderId: "zz-po-window_new", gatewayPaymentId: "zz-pay-window_new", method: "card", amountMinor: model.totalAed, currency: "AED", status: "authorized", source: "gateway_verified",
        rail: "aed_card", provider: "fake-aed-card", providerAccountId: "zz-drill-account", environment: "test", providerOrderId: "zz-po-window_new", idempotencyKey: "zz-drill:payment:window_new", authorizedAt: now, threeDs: "passed", risk: "normal",
      },
    });
    await capture(payId, id, model.totalAed);
    const b = model.supplierBookings[0];
    const bookingId = uuidv7();
    await db.supplierBooking.create({
      data: {
        id: bookingId, orderId: id, orderItemId: itemId, supplierId: b.supplierId, environment: "test", idempotencyKey: "zz-drill:booking:window_new", clientRef: "OUTTD-ZZDRILL-WINDOWNEW", bookingKind: "live_book", state: "confirmed",
        tourExternalId: b.tourExternalId, offerExternalId: b.offerExternalId, serviceDate: b.serviceDate, timeSlotId: b.timeSlotId, startMinutes: b.startMinutes, adults: 2, guestName: "ZZ Drill Guest",
        expectedNetMinor: b.expectedNetMinor, expectedNetUsdMinor: b.expectedNetUsdMinor, chargedNetMinor: b.chargedNetMinor, chargedNetUsdMinor: b.chargedNetUsdMinor, supplierBookingId: "zz-sb-window_new", supplierStatusCode: 1,
        hasTickets: true, requestSentAt: now, reservedAt: now, confirmedAt: now, requestHash: "0".repeat(64), accountId: "default",
      },
    });
    await event(bookingId, "queued", "confirmed");
    await db.ledgerEntry.create({ data: { id: uuidv7(), book: "supplier_wallet", orderId: id, supplierBookingId: bookingId, currency: "AED", amountMinor: -(b.chargedNetMinor ?? 0n), kind: "charged", evidenceRef: "wallet:test:traveldesk:zz-sb-window_new:charged", occurredAt: now } });
    await db.paymentSaga.create({ data: { id: uuidv7(), orderId: id, orderItemId: itemId, paymentId: payId, rail: "aed_card", state: "fulfilled", version: 7 } });
    done.push(`${refs.window_new}: new order paid, booked and confirmed`);
  }
  // 5. Ops pause new sales before the restore (F35).
  await db.setting.update({ where: { key: "supplier_bookings.traveldesk.test.default" }, data: { value: { paused: true, scope: "new_sales", reason: "F35 restore in progress", maxBookingNetMinor: 500_000, minFundsAfterMinor: 0 } } });
  done.push("sales paused (supplier control new_sales)");
  // 6. The destructive event.
  const deleted = await db.notification.deleteMany({});
  done.push(`DELETE FROM notifications: ${deleted.count} rows`);
  return { at: now.toISOString(), steps: done };
}

/** What the supplier and the gateway show after the incident: the fakes' recorded state (F35 step 2). */
async function recordFakes(src: DrillDb) {
  const db = src.client;
  const statusFor: Record<string, string | null> = {
    confirmed: "CONFIRMED",
    confirming: "CONFIRMED",
    outcome_unknown: "CONFIRMED",
    awaiting_payment: "ON_HOLD",
    reserved: "ON_HOLD",
    cancelling: "CANCELLED",
    cancelled: "CANCELLED",
    cancel_unverified: "CANCELLED",
    expired: "EXPIRED",
    awaiting_external: "PENDING",
  };
  const bookings = await db.supplierBooking.findMany({ where: { supplierBookingId: { not: null } }, orderBy: { clientRef: "asc" } });
  const supplier = bookings
    .filter((b) => statusFor[b.state])
    .map((b) => ({
      ref: b.supplierBookingId!,
      bookingReference: b.clientRef,
      status: statusFor[b.state]!,
      rawStatus: statusFor[b.state] === "CONFIRMED" ? 1 : 0,
      offerExternalId: b.offerExternalId,
      tourExternalId: b.tourExternalId,
      serviceDate: b.serviceDate.toISOString().slice(0, 10),
      timeSlotId: b.timeSlotId,
      startMinutes: b.startMinutes,
      adults: b.adults,
      children: b.children,
      infants: b.infants,
      chargedNetMinor: b.chargedNetMinor?.toString() ?? null,
    }));
  const payments = (await db.payment.findMany({ where: { provider: { not: null } }, include: { refunds: true }, orderBy: { providerOrderId: "asc" } })).map((p) => ({
    providerOrderId: p.providerOrderId,
    providerPaymentId: p.gatewayPaymentId,
    status: p.status,
    capturedMinor: p.capturedMinor.toString(),
    refundedMinor: p.refundedMinor.toString(),
    refunds: p.refunds.filter((r) => r.providerRefundId).map((r) => ({ providerRefundId: r.providerRefundId, status: r.status, amountMinor: r.amountMinor.toString() })),
  }));
  return { supplier, payments };
}

type Fakes = Awaited<ReturnType<typeof recordFakes>>;

/* ------------------------------------------------------------------ §6 checks */

function diffBaseline(base: Baseline, now: Baseline) {
  const tables = Object.keys({ ...base.tables, ...now.tables }).sort();
  const rows = tables.map((t) => ({ table: t, baseline: base.tables[t]?.rows ?? null, restored: now.tables[t]?.rows ?? null, checksumMatch: base.tables[t]?.checksum === now.tables[t]?.checksum }));
  const catalogDiff: Record<string, { missing: string[]; extra: string[] }> = {};
  // Raw `relacl` text is compared as effective privileges instead: pg_restore leaves a NULL ACL
  // (the owner's defaults) where the source held the same privileges as an explicit list.
  const base2: Record<string, string[]> = { ...base.catalog, acls: base.effectiveAcls };
  const now2: Record<string, string[]> = { ...now.catalog, acls: now.effectiveAcls };
  for (const k of Object.keys(base2)) {
    const a = new Set(base2[k]);
    const b = new Set(now2[k] ?? []);
    const missing = [...a].filter((x) => !b.has(x));
    const extra = [...b].filter((x) => !a.has(x));
    if (missing.length || extra.length) catalogDiff[k] = { missing, extra };
  }
  return {
    tables: tables.length,
    tablesMatched: rows.filter((r) => r.baseline === r.restored && r.checksumMatch).length,
    differences: rows.filter((r) => r.baseline !== r.restored || !r.checksumMatch),
    rows,
    sequencesMatch: JSON.stringify(base.sequences) === JSON.stringify(now.sequences),
    bigintIdsMatch: JSON.stringify(base.bigintIds) === JSON.stringify(now.bigintIds),
    bigintIdsContiguous: Object.fromEntries(Object.entries(now.bigintIds).map(([t, r]) => [t, r.n === 0 || BigInt(r.max!) - BigInt(r.min!) + 1n === BigInt(r.n)])),
    moneyMatch: JSON.stringify(base.money) === JSON.stringify(now.money),
    money: now.money,
    ledgerMatch: JSON.stringify(base.ledgerByOrder) === JSON.stringify(now.ledgerByOrder),
    catalogMatch: Object.keys(catalogDiff).length === 0,
    catalogCounts: Object.fromEntries(Object.entries(now.catalog).map(([k, v]) => [k, v.length])),
    catalogDiff,
    rawAclTextDiffers: JSON.stringify(base.catalog.acls) !== JSON.stringify(now.catalog.acls),
  };
}

async function appendOnlyRefusals(db: PrismaClient) {
  const out: Record<string, { rows: number; update: string; delete: string; asExpected: boolean }> = {};
  for (const [t, deleteRefused] of APPEND_ONLY) {
    const [{ n }] = await db.$queryRawUnsafe<{ n: number }[]>(`SELECT count(*)::int AS n FROM "${t}"`);
    const attempt = async (sql: string) => {
      try {
        await db.$transaction(async (tx) => {
          await tx.$executeRawUnsafe(sql);
          throw new Error("__accepted__");
        });
        return "accepted";
      } catch (e) {
        const m = e instanceof Error ? e.message : String(e);
        return m.includes("__accepted__") ? "ACCEPTED (rolled back)" : "refused";
      }
    };
    const pick = `(SELECT ctid FROM "${t}" LIMIT 1)`;
    const update = await attempt(`UPDATE "${t}" SET id = id WHERE ctid = ${pick}`);
    const del = await attempt(`DELETE FROM "${t}" WHERE ctid = ${pick}`);
    out[t] = { rows: n, update, delete: del, asExpected: n > 0 && update === "refused" && (del === "refused") === deleteRefused };
  }
  return out;
}

async function rlsAndGrants(db: Raw) {
  const noRls = await db.$queryRawUnsafe<{ name: string }[]>(
    `SELECT c.relname::text AS name FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relkind IN ('r', 'p') AND NOT c.relrowsecurity ORDER BY 1`,
  );
  const grants: Record<string, string[]> = {};
  for (const role of ["anon", "authenticated"]) {
    const rows = await db.$queryRawUnsafe<{ name: string }[]>(
      `SELECT c.relname::text AS name FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
       WHERE n.nspname = 'public' AND c.relkind IN ('r', 'p', 'v', 'm', 'f', 'S')
         AND CASE WHEN c.relkind = 'S' THEN has_sequence_privilege('${role}', c.oid, 'USAGE, SELECT, UPDATE')
                  ELSE has_table_privilege('${role}', c.oid, 'SELECT, INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER') END ORDER BY 1`,
    );
    grants[role] = rows.map((r) => r.name);
  }
  return { tablesWithoutRls: noRls.map((r) => r.name), apiRoleGrants: grants };
}

async function newInserts(db: PrismaClient, base: Baseline) {
  const audit = await db.auditLog.create({ data: { actorType: "system", action: "drill.post_restore_insert", entityType: "drill", entityId: "zz-drill-post-restore" } });
  const ev = await db.inquiryEvent.create({ data: { inquiryId: (await db.inquiry.findFirstOrThrow()).id, kind: "system", actorType: "system", note: "zz drill post-restore insert" } });
  const fresh = uuidv7();
  const maxes: Record<string, string | null> = {};
  for (const t of ["orders", "payments", "supplier_bookings", "ledger_entries", "refunds"]) {
    maxes[t] = (await db.$queryRawUnsafe<{ m: string | null }[]>(`SELECT max(id::text) AS m FROM "${t}"`))[0].m;
  }
  return {
    auditLogId: audit.id.toString(),
    auditLogAfterBaselineMax: audit.id > BigInt(base.bigintIds.audit_logs.max ?? "0"),
    inquiryEventId: ev.id.toString(),
    inquiryEventAfterBaselineMax: ev.id > BigInt(base.bigintIds.inquiry_events.max ?? "0"),
    uuidv7AfterEveryRestoredId: Object.values(maxes).every((m) => m === null || fresh > m),
  };
}

async function keyRings(db: PrismaClient) {
  const codes = await db.supplierTicketCode.findMany({ select: { codeCiphertext: true, codeHash: true, codeKeyId: true } });
  let codesOk = 0;
  for (const c of codes) {
    const plainCode = decryptFor("ticket_codes", c.codeCiphertext);
    if (hmacFor("ticket_code_hash", plainCode) === c.codeHash && ciphertextKeyId(c.codeCiphertext) === c.codeKeyId) codesOk++;
  }
  const grants = await db.guestCapabilityGrant.findMany({ where: { tokenCiphertext: { not: null } }, select: { tokenCiphertext: true, tokenHash: true } });
  let grantsOk = 0;
  for (const g of grants) if (sha256Hex(decryptFor("capability_tokens", g.tokenCiphertext!)) === g.tokenHash) grantsOk++;
  let missingRing: string;
  setKeyRingsForTests({ ticket_codes: null });
  try {
    decryptFor("ticket_codes", codes[0].codeCiphertext);
    missingRing = "decrypted without a ring (unexpected)";
  } catch (e) {
    missingRing = e instanceof KeyUnavailableError ? "KeyUnavailableError (keys.unavailable), no crash" : `other error: ${e instanceof Error ? e.name : "unknown"}`;
  } finally {
    setKeyRingsForTests(null);
  }
  return { ticketCodes: codes.length, ticketCodesDecrypted: codesOk, capabilityTokens: grants.length, capabilityTokensDecrypted: grantsOk, missingRing, keyIds: [...new Set(codes.map((c) => c.codeKeyId))] };
}

/* ------------------------------------------------------------------ F35 */

async function f35(restored: DrillDb, fakes: Fakes, summary: LoadSummary): Promise<Json> {
  // The services use the shared Prisma client, built from DATABASE_URL on first import: point it at the restored database only.
  process.env.DATABASE_URL = restored.url;
  process.env.DIRECT_URL = restored.url;
  const { prisma } = await import("../../src/server/lib/db");
  const [{ db: reached }] = await prisma.$queryRawUnsafe<{ db: string }[]>(`SELECT current_database()::text AS db`);
  if (reached !== RESTORE) throw new TargetGuardError("the services' Prisma client did not reach the restored drill database");
  const { env } = await import("../../src/server/lib/env");
  const { supplierBookingService, bookingControl, TRAVELDESK_SUPPLIER_CODE } = await import("../../src/server/services/supplier-booking.service");
  const { readinessService } = await import("../../src/server/services/readiness.service");
  const { opsQueueService } = await import("../../src/server/services/ops-queue.service");

  // 1. Release switch: off for the whole drill (an env value, so the restore cannot rewind it).
  const releaseSwitch = env().INSTANT_RELEASE_ENABLED === true ? "ON" : "off";
  // The sales pause is a database row: did the restore rewind it?
  const controlAfterRestore = await bookingControl(TRAVELDESK_SUPPLIER_CODE, "test");
  let pauseReapplied = false;
  if (!controlAfterRestore.paused) {
    await prisma.setting.update({ where: { key: "supplier_bookings.traveldesk.test.default" }, data: { value: { ...controlAfterRestore, paused: true, scope: "new_sales", reason: "F35 restore: re-applied after restore" } } });
    pauseReapplied = true;
  }
  const controlNow = await bookingControl(TRAVELDESK_SUPPLIER_CODE, "test");

  // 2–4a. Supplier: the engine's own reconciliation against the fake supplier's listing. It sends nothing.
  const snapshots = fakes.supplier.map((s) => ({
    ...s,
    status: s.status as "CONFIRMED" | "ON_HOLD" | "CANCELLED" | "EXPIRED" | "PENDING",
    chargedNetMinor: s.chargedNetMinor === null ? null : BigInt(s.chargedNetMinor),
    externalInProgress: false,
    externalFailed: false,
    holdExpiresAtUtc: null,
    ticketsIssued: null,
  }));
  const fakeSupplier = {
    supplierCode: TRAVELDESK_SUPPLIER_CODE,
    environment: "test" as const,
    capabilities: () => ({ holds: { minutes: 60 }, oneStep: false, clientRefLookup: "list_scan" as const, notFoundFinalAfterMs: null, readIssuesTickets: "no" as const, cancel: "full" as const, documents: "codes" as const }),
    account: async () => ({ accountId: "default" }),
    readStatus: async () => ({ kind: "failed" as const, reason: "drill fake: not used" }),
    findByClientRef: async () => ({ matches: [], complete: false }),
    funds: async () => ({ spendableMinor: 1_000_000n, currency: "AED" as const, accountId: "default" }),
    listWindow: async () => ({ snapshots, complete: true }),
  };
  const reconcile = await supplierBookingService.reconcile({ adapter: fakeSupplier, environment: "test", supplierCode: TRAVELDESK_SUPPLIER_CODE, accountId: "default" });
  const recoverJobs = await prisma.supplierJob.count({ where: { kind: "recover", status: "queued" } });

  // 2–4b. Gateway: there is no engine entry point that reconciles a rewound window of payments
  // (the saga reconciles only its own open sessions by provider order), so the drill compares the
  // restored payments and refunds with the fake gateway's state directly. It writes nothing.
  const ours = await prisma.payment.findMany({ where: { provider: { not: null } }, include: { refunds: true } });
  const byOrder = new Map(ours.map((p) => [p.providerOrderId, p]));
  const paymentFindings: Json[] = [];
  for (const g of fakes.payments) {
    const p = byOrder.get(g.providerOrderId);
    if (!p) {
      paymentFindings.push({ kind: "unknown_to_outly", providerOrderId: g.providerOrderId, gateway: { status: g.status, capturedMinor: g.capturedMinor }, action: "re-create through the normal engine paths or flag for staff; never re-send a supplier mutation" });
      continue;
    }
    if (p.status !== g.status || p.capturedMinor.toString() !== g.capturedMinor || p.refundedMinor.toString() !== g.refundedMinor) {
      paymentFindings.push({
        kind: "payment_state_mismatch",
        providerOrderId: g.providerOrderId,
        ours: { status: p.status, capturedMinor: p.capturedMinor.toString(), refundedMinor: p.refundedMinor.toString() },
        gateway: { status: g.status, capturedMinor: g.capturedMinor, refundedMinor: g.refundedMinor },
        action: "advance from provider evidence (saga run / refund reread); never re-capture",
      });
    }
    for (const gr of g.refunds) {
      const r = p.refunds.find((x) => x.providerRefundId === gr.providerRefundId) ?? p.refunds.find((x) => x.amountMinor.toString() === gr.amountMinor && x.status !== gr.status);
      if (!r || r.status !== gr.status) paymentFindings.push({ kind: "refund_state_mismatch", providerOrderId: g.providerOrderId, ours: r ? r.status : null, gateway: gr.status, action: "reread the refund at the provider; finance signs off" });
    }
  }
  const gatewayOrders = new Set(fakes.payments.map((g) => g.providerOrderId));
  for (const p of ours) if (!gatewayOrders.has(p.providerOrderId)) paymentFindings.push({ kind: "missing_at_gateway", providerOrderId: p.providerOrderId, action: "keep blocking; recovery reads it" });

  // Readiness: the instant product must read as inquiry while the switch is off.
  const readiness = await readinessService.evaluate(summary.instantProductId, { environment: "test" });
  // What still blocks before sales resume: the ops queues on the restored database.
  const queues = await opsQueueService.counts({ type: "admin", roles: ["ops"], permissions: new Set(["orders.view_all"]) });

  const unresolved = reconcile.issuesTotal + paymentFindings.length;
  return {
    releaseSwitch,
    salesPause: { afterRestore: controlAfterRestore.paused, reapplied: pauseReapplied, now: controlNow.paused, scope: controlNow.scope },
    supplierReconcile: {
      listComplete: reconcile.listComplete,
      skipped: reconcile.skipped,
      supplierListed: reconcile.supplierListed,
      ours: reconcile.ours,
      issuesTotal: reconcile.issuesTotal,
      issues: reconcile.issues.map((i) => ({ kind: i.kind, reference: i.reference, ours: i.ours, theirs: i.theirs })),
      reblocked: reconcile.reblocked,
      recoverJobsQueued: recoverJobs,
    },
    paymentFindings,
    readiness: { productEffective: readiness.effective, reasons: readiness.reasons },
    opsQueues: queues,
    resumeAllowed: unresolved === 0 && releaseSwitch === "off" ? "only after ops and finance sign-off" : "no: unresolved differences, sign-off required",
    unresolved,
  };
}

/* ------------------------------------------------------------------ main */

async function main() {
  installEgressBlock();
  const outArg = process.argv.slice(2).find((a) => a.startsWith("--out="))?.slice("--out=".length);
  if (!outArg) throw new Error("usage: restore-drill.ts --out=<directory outside the repository>");
  const out = path.resolve(outArg);
  if (out === ROOT || out.startsWith(`${ROOT}${path.sep}`)) throw new Error("--out must be outside the repository");
  mkdirSync(out, { recursive: true });
  const dump = path.join(out, "outly_drill.dump");
  const evidence: Json = { drill: "restore, synthetic, local (Part A)", startedAt: new Date().toISOString(), container: CONTAINER };
  const write = () => writeFileSync(path.join(out, "evidence.json"), `${JSON.stringify(plain(evidence), null, 2)}\n`);

  const main: Main = await openMain();
  evidence.target = { server: `127.0.0.1:${main.target.port}`, guardedDatabase: main.target.database, instance: main.target.instanceId.slice(0, 8), postgres: (await main.client.$queryRawUnsafe<{ v: string }[]>(`SHOW server_version`))[0] };
  const opened: DrillDb[] = [];
  try {
    assertContainerIsMain(main);
    const leftovers = await listDrillDbs(main);
    if (leftovers.length) log("dropping leftover drill databases", leftovers.join(", "));
    for (const n of leftovers) await dropDrillDb(main, n);

    // 1. Source database and migrations.
    log("create", SRC);
    const src = (await createDrillDb(main, SRC, { marker: true })) as DrillDb;
    opened.push(src);
    const mig = migrateDrillDb(main, SRC);
    if (mig.status !== 0) throw new Error(`migrate deploy failed:\n${mig.output.slice(-2000)}`);
    const applied = await src.client.$queryRawUnsafe<{ n: number }[]>(`SELECT count(*)::int AS n FROM _prisma_migrations WHERE finished_at IS NOT NULL AND rolled_back_at IS NULL`);
    evidence.migrations = { applied: applied[0].n, ms: mig.ms };
    log("migrated", `${applied[0].n} migrations in ${mig.ms} ms`);

    // 2. Synthetic scenarios.
    const t2 = performance.now();
    const summary = await loadSyntheticScenarios(src.client);
    evidence.load = { ...summary, ms: Math.round(performance.now() - t2) };
    log("loaded", `${summary.orders} orders, ${summary.supplierBookings} bookings, ${summary.payments} payments, ${summary.refunds} refunds`);

    // 3. Baseline.
    const baseline = await takeBaseline(src.client);
    writeFileSync(path.join(out, "drill-baseline.json"), `${JSON.stringify(plain(baseline), null, 2)}\n`);
    evidence.baseline = { takenAt: baseline.takenAt, tables: Object.keys(baseline.tables).length, rows: Object.values(baseline.tables).reduce((a, t) => a + t.rows, 0), money: baseline.money };
    log("baseline", `${Object.keys(baseline.tables).length} tables`);

    // 4. Dump inside the container.
    assertContainerIsMain(main);
    const fd = openSync(dump, "w", 0o600);
    const d = docker(["exec", CONTAINER, "pg_dump", "-Fc", "-U", "outly_test", "-d", SRC], { stdout: fd });
    closeSync(fd);
    if (d.status !== 0) throw new Error(`pg_dump failed: ${d.stderr}`);
    evidence.dump = { command: `docker exec ${CONTAINER} pg_dump -Fc -U outly_test -d ${SRC} > <out>/outly_drill.dump`, ms: d.ms, bytes: statSync(dump).size };
    log("dump", `${d.ms} ms, ${statSync(dump).size} bytes`);

    // 5. Incident, then the fakes' view of the world.
    evidence.incident = await incident(src, summary.refs);
    const fakes = await recordFakes(src);
    evidence.fakes = { supplierBookingsListed: fakes.supplier.length, gatewayPayments: fakes.payments.length };
    log("incident", (evidence.incident as { steps: string[] }).steps.join("; "));

    // 6. Restore into a fresh database.
    await createDrillDb(main, RESTORE, { marker: false });
    assertContainerIsMain(main);
    const rfd = openSync(dump, "r");
    const r = docker(["exec", "-i", CONTAINER, "pg_restore", "--no-owner", "-U", "outly_test", "-d", RESTORE], { stdin: rfd });
    closeSync(rfd);
    if (r.status !== 0) throw new Error(`pg_restore failed: ${r.stderr}`);
    evidence.restore = { command: `docker exec -i ${CONTAINER} pg_restore --no-owner -U outly_test -d ${RESTORE} < <out>/outly_drill.dump`, ms: r.ms, warnings: r.stderr || null };
    log("restore", `${r.ms} ms`);
    const restored = await openDrillDb(main, RESTORE);
    opened.push(restored);

    // 7. §6 checks against the baseline.
    const after = await takeBaseline(restored.client);
    const diff = diffBaseline(baseline, after);
    const { rows, ...diffSummary } = diff;
    evidence.checks = {
      ...diffSummary,
      appendOnly: await appendOnlyRefusals(restored.client),
      rls: await rlsAndGrants(restored.client),
      newInserts: await newInserts(restored.client, baseline),
      keyRings: await keyRings(restored.client),
    };
    evidence.tableComparison = rows;
    log("checks", `${diff.tablesMatched}/${diff.tables} tables match`);

    // 8. F35 against the restored database only.
    evidence.f35 = await f35(restored, fakes, summary);
    log("f35", `unresolved differences: ${(evidence.f35 as { unresolved: number }).unresolved}`);
    evidence.finishedAt = new Date().toISOString();
  } catch (e) {
    evidence.error = e instanceof Error ? e.message : String(e);
    throw e;
  } finally {
    // 9. Cleanup: both drill databases and the dump.
    for (const db of opened) await db.client.$disconnect().catch(() => {});
    try {
      const { prisma } = await import("../../src/server/lib/db");
      await prisma.$disconnect();
    } catch {
      /* not loaded */
    }
    for (const n of [SRC, RESTORE]) await dropDrillDb(main, n);
    rmSync(dump, { force: true });
    const remaining = await listDrillDbs(main);
    const mainStill = await main.client.$queryRawUnsafe<{ n: number }[]>(`SELECT count(*)::int AS n FROM zz_disposable.zz_disposable_instance`);
    evidence.cleanup = { drillDatabasesLeft: remaining, dumpDeleted: !statExists(dump), guardedDatabaseMarkerRows: mainStill[0].n };
    write();
    await main.client.$disconnect();
    log("cleanup", `drill databases left: ${remaining.length ? remaining.join(", ") : "none"}; dump deleted`);
  }
}

function statExists(p: string): boolean {
  try {
    statSync(p);
    return true;
  } catch {
    return false;
  }
}

main().catch((e) => {
  console.error(`restore-drill: ${e instanceof Error ? e.message : String(e)}`);
  process.exit(2);
});
