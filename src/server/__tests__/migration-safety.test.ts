import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import { PrismaClient } from "@prisma/client";
import { formatReference, uuidv7 } from "../lib/ids";
import { isSupabaseLocalTarget } from "../../../vitest.suites.mjs";
import { dbEnabled } from "./helpers/fixtures";
import {
  catalogSnapshot,
  columnsOf,
  createScratchDb,
  deploy,
  deployAsync,
  migrationNames,
  MIGRATIONS_DIR,
  resolveRolledBack,
  type ColumnInfo,
  type ScratchDb,
} from "./helpers/scratch-db";

/**
 * Migration safety (docs/backend/27-deferred-test-plan.md §3), on scratch
 * databases next to the guarded disposable test database (helpers/scratch-db.ts;
 * the target guard runs on the test database first, and every scratch
 * database is created, checked and dropped through it).
 *
 *  1. Mixed version. The schema as of `74d0260` (the six migrations that
 *     existed then) against today's: no legacy column is dropped, renamed or
 *     retyped, and every column added to a legacy table is nullable or has a
 *     default. Legacy-shaped writes (the columns and values the code at
 *     `74d0260` wrote, nothing newer) on today's schema, inside a transaction
 *     that is always rolled back: orders, order items, payments, OTP
 *     challenges, notifications, inquiries and customers. No new trigger or
 *     check may refuse them.
 *  2. Failure and rollback. Every migration from `20261101100000` onward is
 *     applied with an injected fault first: an error in an appended last
 *     statement, and a lock held on every existing table past the
 *     migration's `lock_timeout`. The failed transaction must leave the
 *     catalogue exactly as it was, `_prisma_migrations` must show the
 *     migration as not applied, and after `migrate resolve --rolled-back` the
 *     real migration must apply cleanly.
 *  3. Applying from empty in one run matches applying the history step by
 *     step (pg_catalog snapshots, `_prisma_migrations` left out).
 *
 * Every value written is synthetic.
 */

/** The migrations present at commit 74d0260 (the schema old code was written against). */
const LEGACY = [
  "20260914000000_init",
  "20260914102118_inquiry_item_snapshots_and_money_guards",
  "20260918175017_customer_auth",
  "20260919085708_image_assets",
  "20260920060000_catalogue_content",
  "20260920070000_catalogue_history_cascade",
];
const FIRST_FAULTED = "20261101100000_b1a_booking_safety_states";
/**
 * KNOWN GAP (reported to the lead, not fixed here: applied migrations are
 * never edited). These alter existing tables without `SET LOCAL lock_timeout`,
 * against prisma/migrations/README.md "Locks", so behind a held lock they wait
 * instead of failing fast. The lock test pins that behaviour for them.
 */
const NO_LOCK_TIMEOUT = ["20261101100000_b1a_booking_safety_states"];
/**
 * Migrations that only replace function bodies (`CREATE OR REPLACE FUNCTION`)
 * and take no lock on an existing table: a held table lock cannot stall them.
 * Checked below: their SQL has no ALTER, CREATE TABLE/INDEX/TRIGGER or LOCK.
 */
const LOCK_FREE = [
  "20261101140000_refund_cap_counts_provider_refunds",
  // Only ALTER FUNCTION ... SET search_path (A4): no lock on any table.
  "20261103120000_function_search_path",
];
/**
 * Migrations that only create new tables (with their own indexes, RLS and
 * revokes) and reference no existing table: they take no lock on anything
 * that exists, so a held table lock cannot stall them either. Checked below:
 * every table they name is one they create, and they have no foreign key.
 */
const NEW_TABLES_ONLY = [
  // ops_alerts (doc 22 §32.24): a standalone table, no foreign key.
  "20261104120000_ops_alerts",
  // crm_outbox, crm_links, crm_portal_state (doc 29 C1): standalone tables, no foreign key.
  "20261122130000_crm_c1_outbox_links",
  // supplier_sync_runs (doc 29 Batch 1b): a standalone table, no foreign key.
  "20261123120000_b1b_supplier_sync_runs",
];
/** How long the injected lock is held. Longer than every `lock_timeout` (5 s). */
const HOLD_MS = 12_000;
const ROLLBACK = new Error("ROLLBACK");

const ALL = migrationNames();
/** The same URL with a session lock_timeout of 5 s in the connection options (doc 25 §9, production migration runs). */
const withSessionLockTimeout = (url: string) => {
  const u = new URL(url);
  u.searchParams.set("options", "-c lock_timeout=5s");
  return u.toString();
};
const FAULTED = ALL.slice(ALL.indexOf(FIRST_FAULTED));
const sqlOf = (name: string) => readFileSync(path.join(MIGRATIONS_DIR, name, "migration.sql"), "utf8");
const upTo = (name: string) => ALL.slice(0, ALL.indexOf(name) + 1);

/** PG17 only (vitest.suites.mjs PG17_ONLY_SUITES): the local Supabase stack's role may not create the scratch databases. */
const excludedHere = isSupabaseLocalTarget();

describe.skipIf(!dbEnabled || excludedHere)("migration safety (doc 27 §3)", () => {
  let main: PrismaClient;
  let step: ScratchDb;
  let full: ScratchDb;
  let legacyColumns: ColumnInfo[];

  beforeAll(async () => {
    ({ prisma: main } = (await import("../lib/db")) as unknown as { prisma: PrismaClient });
    step = await createScratchDb(main, "step");
    full = await createScratchDb(main, "full");
  }, 120_000);

  afterAll(async () => {
    await step?.drop();
    await full?.drop();
  }, 60_000);

  it("the history is what this suite assumes: the legacy prefix, then the faulted migrations", () => {
    expect(ALL.slice(0, LEGACY.length)).toEqual(LEGACY);
    expect(FAULTED.length).toBeGreaterThanOrEqual(10);
    // Every faulted migration that lacks a lock timeout is a listed, reported gap.
    expect(FAULTED.filter((n) => !/SET LOCAL lock_timeout/.test(sqlOf(n)))).toEqual(NO_LOCK_TIMEOUT);
    // The lock-free list holds only function replacements.
    for (const n of LOCK_FREE) {
      const ddl = sqlOf(n).replace(/--.*$/gm, "").replace(/\$\$[^]*?\$\$/g, "");
      expect(ddl, n).not.toMatch(/\b(ALTER|LOCK|CREATE\s+(TABLE|INDEX|UNIQUE|TRIGGER|POLICY)|DROP|UPDATE|INSERT|DELETE)\b/i);
    }
    for (const n of NEW_TABLES_ONLY) {
      // String literals (CHECK value lists such as 'delete') are not statements.
      const ddl = sqlOf(n).replace(/--.*$/gm, "").replace(/\$\$[^]*?\$\$/g, "").replace(/'[^']*'/g, "''");
      const created = [...ddl.matchAll(/CREATE\s+TABLE\s+"?(\w+)"?/gi)].map((m) => m[1]);
      expect(created.length, n).toBeGreaterThan(0);
      const named = [...ddl.matchAll(/(?:ALTER\s+TABLE|\bON|REFERENCES)\s+"?(\w+)"?/gi)].map((m) => m[1]);
      expect(named.filter((t) => !created.includes(t)), n).toEqual([]);
      expect(ddl, n).not.toMatch(/\b(REFERENCES|LOCK|DROP|UPDATE|INSERT|DELETE|TRIGGER|FUNCTION)\b/i);
    }
  });

  it("every migration applies from empty in one run", () => {
    const r = deploy(full.url, ALL);
    expect(r.status, r.output).toBe(0);
  }, 180_000);

  it("the legacy schema (74d0260) applies on its own", async () => {
    const r = deploy(step.url, LEGACY);
    expect(r.status, r.output).toBe(0);
    legacyColumns = await columnsOf(step.client);
    expect(legacyColumns.length).toBeGreaterThan(100);
  }, 120_000);

  /* ------------------------------------------------------------ 1. mixed version */

  describe("mixed version: code from 74d0260 against today's schema", () => {
    it("no legacy table or column is dropped, renamed or retyped; every column added to a legacy table is nullable or has a default", async () => {
      const now = await columnsOf(full.client);
      const key = (c: { table: string; column: string }) => `${c.table}.${c.column}`;
      const today = new Map(now.map((c) => [key(c), c]));
      const missing = legacyColumns.filter((c) => !today.has(key(c))).map(key);
      expect(missing).toEqual([]);
      const retyped = legacyColumns.filter((c) => today.get(key(c))!.type !== c.type).map((c) => `${key(c)} ${c.type} -> ${today.get(key(c))!.type}`);
      expect(retyped).toEqual([]);
      // A legacy column that became NOT NULL without a default would refuse an old insert that omits it.
      const tightened = legacyColumns.filter((c) => !c.notNull && today.get(key(c))!.notNull && !today.get(key(c))!.hasDefault).map(key);
      expect(tightened).toEqual([]);
      const legacyTables = new Set(legacyColumns.map((c) => c.table));
      const legacyKeys = new Set(legacyColumns.map(key));
      const added = now.filter((c) => legacyTables.has(c.table) && !legacyKeys.has(key(c)));
      expect(added.length).toBeGreaterThan(0);
      const required = added.filter((c) => c.notNull && !c.hasDefault && !c.identityOrGenerated).map(key);
      expect(required).toEqual([]);
    });

    it("legacy-shaped inserts and updates of orders, items, payments, OTP challenges, notifications, inquiries and customers succeed (rolled back)", async () => {
      const legacy = new Set(legacyColumns.map((c) => `${c.table}.${c.column}`));
      const used: string[] = [];
      /** Records the columns a legacy statement names, so the test proves it wrote nothing newer. */
      const cols = (table: string, names: string[]) => {
        for (const n of names) used.push(`${table}.${n}`);
        return names.map((n) => `"${n}"`).join(", ");
      };
      const id = () => uuidv7();
      const ids = { customer: id(), guest: id(), combo: id(), order: id(), item: id(), payment: id(), otp: id(), notification: id(), inquiry: id() };
      const db = full.client;
      try {
        await db.$transaction(
          async (tx) => {
            const run = (sql: string) => tx.$executeRawUnsafe(sql);
            const [{ o }] = await tx.$queryRawUnsafe<{ o: bigint }[]>(`SELECT nextval('order_ref_seq') AS o`);
            const [{ q }] = await tx.$queryRawUnsafe<{ q: bigint }[]>(`SELECT nextval('inquiry_ref_seq') AS q`);
            const orderRef = formatReference("OUT", o);
            const inquiryRef = formatReference("INQ", q);

            // customers: customer-auth sign-up, then a profile edit and a login (customer.repo at 74d0260).
            await run(`INSERT INTO customers (${cols("customers", ["id", "phone_e164", "full_name", "email"])}) VALUES ('${ids.customer}', '+919900000001', 'zz legacy customer', 'zz-legacy@outlyy.test')`);
            await run(`UPDATE customers SET full_name = 'zz legacy renamed', hotel = 'zz hotel', last_login_at = now(), updated_at = now() WHERE id = '${ids.customer}'`);
            used.push("customers.hotel", "customers.last_login_at", "customers.updated_at");

            // inquiries: the inquiry form, then the agent pipeline.
            await run(
              `INSERT INTO inquiries (${cols("inquiries", ["id", "reference", "source", "lead_name", "lead_phone", "lead_email", "country_code", "pax", "currency", "indicative_total_inr", "indicative_total_aed", "customer_id"])})
               VALUES ('${ids.inquiry}', '${inquiryRef}', 'inquiry_form', 'zz legacy lead', '+919900000001', 'zz-legacy@outlyy.test', 'IN', '{"adult":2}', 'INR', 1000, 45, '${ids.customer}')`,
            );
            await run(`UPDATE inquiries SET status = 'contacted', first_response_at = now(), last_contact_at = now(), updated_at = now() WHERE id = '${ids.inquiry}'`);
            used.push("inquiries.status", "inquiries.first_response_at", "inquiries.last_contact_at", "inquiries.updated_at");

            // orders and order items: the assisted conversion (order.service.createOrder at 74d0260).
            await run(`INSERT INTO guests (${cols("guests", ["id", "phone_e164", "full_name"])}) VALUES ('${ids.guest}', '+919900000001', 'zz legacy guest')`);
            await run(`INSERT INTO combos (${cols("combos", ["id", "slug", "name", "confirmation"])}) VALUES ('${ids.combo}', 'zz-legacy-${ids.combo.slice(-8)}', 'zz legacy combo', 'manual')`);
            await run(
              `INSERT INTO orders (${cols("orders", ["id", "reference", "status", "rail", "guest_id", "source_inquiry_id", "payment_collection", "currency", "subtotal_inr", "subtotal_aed", "total_inr", "total_aed", "net_cost_aed", "lead_name", "lead_email", "lead_phone", "customer_id"])})
               VALUES ('${ids.order}', '${orderRef}', 'pending_payment', 'assisted', '${ids.guest}', '${ids.inquiry}', 'manual_link', 'INR', 1000, 45, 1000, 45, 30, 'zz legacy lead', 'zz-legacy@outlyy.test', '+919900000001', '${ids.customer}')`,
            );
            await run(
              `INSERT INTO order_items (${cols("order_items", ["id", "order_id", "combo_id", "title_snapshot", "tier_snapshot", "slug_snapshot", "kind_snapshot", "inclusions_snapshot", "cancellation_policy_snapshot", "confirmation_snapshot", "fulfilment_mode_snapshot", "free_cancellation_hours_snapshot", "duration_minutes_snapshot", "service_date", "pax", "addons", "unit_inr", "unit_aed", "total_inr", "total_aed", "net_cost_aed", "status"])})
               VALUES ('${ids.item}', '${ids.order}', '${ids.combo}', 'zz legacy item', 'C', 'zz-legacy', 'combo', '{}', '{}', 'manual', 'inquiry', 24, 60, '2030-02-10', '{"adult":2}', '[]', 1000, 45, 1000, 45, 30, 'pending')`,
            );
            await run(`UPDATE inquiries SET status = 'won', converted_order_id = '${ids.order}', updated_at = now() WHERE id = '${ids.inquiry}'`);
            used.push("inquiries.converted_order_id");

            // payments: the manual record of a payment-link payment (recordManualPayment at 74d0260), and the order marked paid.
            await run(
              `INSERT INTO payments (${cols("payments", ["id", "order_id", "gateway", "gateway_payment_id", "payment_link_id", "payment_link_url", "method", "amount_minor", "currency", "status", "recorded_by", "captured_at"])})
               VALUES ('${ids.payment}', '${ids.order}', 'razorpay', 'pay_zzlegacy${ids.payment.slice(-8)}', 'plink_zzlegacy', 'https://rzp.example.test/zz', 'upi', 1000, 'INR', 'captured', NULL, now())`,
            );
            await run(`UPDATE orders SET status = 'paid', paid_at = now(), updated_at = now() WHERE id = '${ids.order}'`);
            await run(`UPDATE order_items SET status = 'confirmed' WHERE id = '${ids.item}'`);
            await run(`UPDATE orders SET status = 'confirmed', confirmed_at = now(), updated_at = now() WHERE id = '${ids.order}'`);
            used.push("orders.paid_at", "orders.confirmed_at", "orders.updated_at");

            // otp_challenges: issue, a wrong try, consume (customer.repo at 74d0260).
            await run(`INSERT INTO otp_challenges (${cols("otp_challenges", ["id", "phone_e164", "code_hash", "expires_at", "ip_hash"])}) VALUES ('${ids.otp}', '+919900000001', '${"a".repeat(64)}', now() + interval '5 minutes', '${"b".repeat(64)}')`);
            await run(`UPDATE otp_challenges SET attempts = attempts + 1 WHERE id = '${ids.otp}'`);
            await run(`UPDATE otp_challenges SET consumed_at = now() WHERE id = '${ids.otp}' AND consumed_at IS NULL`);
            used.push("otp_challenges.attempts", "otp_challenges.consumed_at");

            // notifications: a sent message, then its delivery receipt (notification.service / notifications.repo at 74d0260).
            await run(
              `INSERT INTO notifications (${cols("notifications", ["id", "event", "channel", "recipient", "inquiry_id", "order_id", "template", "payload", "status", "sent_at", "provider_id", "cost_minor"])})
               VALUES ('${ids.notification}', 'ORDER_PAID', 'whatsapp', '+919900000001', '${ids.inquiry}', '${ids.order}', 'order_paid_v1', '{"reference":"zz"}', 'sent', now(), 'wamid.zzlegacy', 0)`,
            );
            await run(`UPDATE notifications SET status = 'delivered', delivered_at = now() WHERE provider_id = 'wamid.zzlegacy' AND status = 'sent'`);
            used.push("notifications.delivered_at");

            const [{ n }] = await tx.$queryRawUnsafe<{ n: bigint }[]>(`SELECT count(*) AS n FROM orders WHERE id = '${ids.order}' AND status = 'confirmed'`);
            expect(n).toBe(1n);
            throw ROLLBACK;
          },
          { maxWait: 20_000, timeout: 30_000 },
        );
      } catch (e) {
        if (e !== ROLLBACK) throw e;
      }
      // Only columns that existed at 74d0260 were named.
      expect(used.filter((c) => !legacy.has(c))).toEqual([]);
      // Nothing survived the rollback.
      const [{ n }] = await db.$queryRawUnsafe<{ n: bigint }[]>(`SELECT count(*) AS n FROM orders WHERE id = '${ids.order}'`);
      expect(n).toBe(0n);
    }, 60_000);
  });

  /* ------------------------------------------------------- 2. failure and rollback */

  describe("failure and rollback, each migration from 20261101100000", () => {
    const applied = (name: string) =>
      step.client.$queryRawUnsafe<{ n: bigint }[]>(`SELECT count(*) AS n FROM _prisma_migrations WHERE migration_name = '${name}' AND finished_at IS NOT NULL AND rolled_back_at IS NULL`).then(([r]) => Number(r.n));

    /** Runs `fn` while another connection holds ACCESS EXCLUSIVE on every existing table (released after HOLD_MS at most). */
    async function underLock<T>(fn: () => Promise<T>): Promise<{ result: T; waited: number }> {
      const blocker = new PrismaClient({ datasources: { db: { url: step.url } } });
      const tables = await step.client.$queryRawUnsafe<{ t: string }[]>(
        `SELECT quote_ident(relname) AS t FROM pg_class WHERE relnamespace = 'public'::regnamespace AND relkind IN ('r','p') AND relname <> '_prisma_migrations'`,
      );
      let release!: () => void;
      const released = new Promise<void>((r) => (release = r));
      let locked!: () => void;
      const isLocked = new Promise<void>((r) => (locked = r));
      const holding = blocker.$transaction(
        async (tx) => {
          await tx.$executeRawUnsafe(`LOCK TABLE ${tables.map((t) => t.t).join(", ")} IN ACCESS EXCLUSIVE MODE`);
          locked();
          await Promise.race([released, new Promise((r) => setTimeout(r, HOLD_MS))]);
        },
        { maxWait: 10_000, timeout: HOLD_MS + 20_000 },
      );
      try {
        await isLocked;
        const started = Date.now();
        const result = await fn();
        return { result, waited: Date.now() - started };
      } finally {
        release();
        await holding;
        await blocker.$disconnect();
      }
    }

    it("the migrations between the legacy schema and 20261101100000 apply", () => {
      const r = deploy(step.url, ALL.slice(0, ALL.indexOf(FIRST_FAULTED)));
      expect(r.status, r.output).toBe(0);
    }, 120_000);

    it.each(FAULTED)(
      "%s: an error in its last statement, and a lock held past its lock_timeout, roll it back fully; then it applies cleanly",
      async (name) => {
        const names = upTo(name);
        const before = await catalogSnapshot(step.client);

        // (a) An error in the last statement.
        const broken = deploy(step.url, names, { [name]: `${sqlOf(name)}\n;\nSELECT 1 / 0;\n` });
        expect(broken.status, broken.output).not.toBe(0);
        expect(broken.output).toMatch(/division by zero/);
        expect(await catalogSnapshot(step.client)).toEqual(before);
        expect(await applied(name)).toBe(0);
        // Prisma refuses to go on until the failure is resolved.
        const refused = deploy(step.url, names);
        expect(refused.status).not.toBe(0);
        expect(refused.output).toMatch(/P3009|failed migrations/);
        const resolved = resolveRolledBack(step.url, names, name);
        expect(resolved.status, resolved.output).toBe(0);

        // (b) A lock on every existing table, held past the migration's lock_timeout.
        if (NO_LOCK_TIMEOUT.includes(name)) {
          // The mitigation for the known gap (doc 25 §9): the migration session itself gets lock_timeout=5s from the
          // connection options, so the file fails fast behind the lock even without its own SET LOCAL.
          const guarded = await underLock(() => deployAsync(withSessionLockTimeout(step.url), names, HOLD_MS + 60_000));
          expect(guarded.result.status, guarded.result.output).not.toBe(0);
          expect(guarded.result.output).toMatch(/lock timeout/i);
          expect(guarded.waited).toBeLessThan(HOLD_MS);
          expect(await catalogSnapshot(step.client)).toEqual(before);
          expect(await applied(name)).toBe(0);
          const resolvedAgain = resolveRolledBack(step.url, names, name);
          expect(resolvedAgain.status, resolvedAgain.output).toBe(0);
        }
        const { result: blocked, waited } = await underLock(() => deployAsync(step.url, names, HOLD_MS + 60_000));

        if (NO_LOCK_TIMEOUT.includes(name)) {
          // KNOWN GAP: no lock_timeout, so it queued behind the lock until the holder let go, then applied.
          expect(blocked.status, blocked.output).toBe(0);
          expect(waited).toBeGreaterThanOrEqual(HOLD_MS - 1_000);
        } else if (LOCK_FREE.includes(name) || NEW_TABLES_ONLY.includes(name)) {
          // It takes no lock on any existing table, so a held lock cannot stall it: it applies at once.
          expect(blocked.status, blocked.output).toBe(0);
          expect(waited).toBeLessThan(HOLD_MS);
        } else {
          expect(blocked.status, blocked.output).not.toBe(0);
          expect(blocked.output).toMatch(/lock timeout/i);
          expect(waited).toBeLessThan(HOLD_MS);
          expect(await catalogSnapshot(step.client)).toEqual(before);
          expect(await applied(name)).toBe(0);
          const again = resolveRolledBack(step.url, names, name);
          expect(again.status, again.output).toBe(0);
        }

        // (c) The real migration now applies cleanly (or already has, for the known gap above).
        const ok = deploy(step.url, names);
        expect(ok.status, ok.output).toBe(0);
        expect(await applied(name)).toBe(1);
        expect(await catalogSnapshot(step.client)).not.toEqual(before);
      },
      HOLD_MS + 150_000,
    );
  });

  /* ---------------------------------------------------- 3. empty versus stepwise */

  it("applying step by step, through the injected failures, ends with the same catalogue as applying from empty", async () => {
    expect(ALL.filter((n) => !FAULTED.includes(n)).length + FAULTED.length).toBe(ALL.length);
    const [a, b] = await Promise.all([catalogSnapshot(step.client), catalogSnapshot(full.client)]);
    for (const k of Object.keys(b)) expect(a[k], k).toEqual(b[k]);
    // Both histories record every migration as applied once.
    for (const db of [step.client, full.client]) {
      const rows = await db.$queryRawUnsafe<{ migration_name: string }[]>(`SELECT migration_name FROM _prisma_migrations WHERE finished_at IS NOT NULL AND rolled_back_at IS NULL ORDER BY 1`);
      expect(rows.map((r) => r.migration_name)).toEqual(ALL);
    }
  }, 60_000);
});
