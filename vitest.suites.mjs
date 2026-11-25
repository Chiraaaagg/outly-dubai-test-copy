/**
 * Which test files need the disposable database. Shared by vitest.config.mts
 * (project membership) and the unit meta-test that refuses a database suite
 * outside this list (src/server/__tests__/test-projects.test.ts).
 */

/** `db` project: guarded globalSetup, the test env file, egress blocked. */
/** @type {string[]} */
export const DB_SUITES = [
  "src/server/__tests__/b1-migration.test.ts",
  "src/server/__tests__/b2-migration.test.ts",
  "src/server/__tests__/b3-migration.test.ts",
  "src/server/__tests__/b4-migration.test.ts",
  "src/server/__tests__/db-integrity.test.ts",
  "src/server/__tests__/non-owner-role.test.ts",
  "src/server/__tests__/schema-rls.test.ts",
  "src/server/__tests__/supplier-guard-states.test.ts",
  // Migration safety (doc 27 §3): scratch databases next to the guarded one.
  "src/server/__tests__/migration-safety.test.ts",
  // B5 suites that need the database (customer status, recovery, cancellation, console queues, carry-overs).
  "src/server/__tests__/b5/*.test.ts",
  "src/server/__tests__/security/*.test.ts",
  "src/server/lib/__tests__/idempotency.test.ts",
  "src/server/payments/__tests__/evidence.test.ts",
  "src/server/services/__tests__/approval.service.test.ts",
  "src/server/services/__tests__/capability.service.test.ts",
  "src/server/services/__tests__/document.service.test.ts",
  "src/server/services/__tests__/fx-refresh.db.test.ts",
  "src/server/services/__tests__/notification.outbox.test.ts",
  "src/server/services/__tests__/ops-alert.service.test.ts",
  "src/server/services/__tests__/privacy.erasure.test.ts",
  "src/server/services/__tests__/supplier-booking.tickets.test.ts",
  "src/server/services/__tests__/activity.service.test.ts",
  "src/server/services/__tests__/import.service.test.ts",
  "src/server/services/__tests__/quote.store.test.ts",
  "src/server/services/__tests__/supplier-booking.service.test.ts",
  "src/server/services/__tests__/supplier-catalog.service.test.ts",
  "src/server/services/__tests__/supplier-capability.service.test.ts",
  "src/server/services/__tests__/traveldesk-catalogue-sync.service.test.ts",
  // CRM batch C1: outbox, links, Postgres store, worker on the fake portal, erasure and retention.
  "src/server/crm/__tests__/crm.db.test.ts",
  // CRM batch C3ab: the return path's Postgres store, checks and alert read.
  "src/server/crm/__tests__/crm.return.db.test.ts",
  // CRM batch C3ab fix round: the real return path commands on the inquiry service (review C3-08).
  "src/server/crm/__tests__/crm.return.commands.db.test.ts",
  // Batch 1c: the retention purge leaves live rows alone (doc 26 §2).
  "src/server/jobs/__tests__/retention-purge.db.test.ts",
  // Batch 1c: the Prisma timing extension counts queries of the request it runs in (doc 29 §6.6).
  "src/server/lib/__tests__/request-timing.db.test.ts",
  // Batch 3: the browse read class in the shared budget row, and the order item pickup columns.
  "src/server/services/__tests__/pickup-hotel.db.test.ts",
  // Batch 7: date-only readiness, the slot_rules_unknown blocker against the flag and evidence.
  "src/server/services/__tests__/date-only.db.test.ts",
  // Doc 30 N0: tour content stored apart from the catalogue payload, and the read-only dry-run report.
  "src/server/services/__tests__/traveldesk-dry-run.db.test.ts",
];

/**
 * `db` suites that run on the disposable Postgres 17 container only, never on
 * the local Supabase stack (OUTLY_TEST_SUPABASE_LOCAL=1), each with its reason.
 * There they skip, and vitest.no-skip-reporter.ts reports them as deliberately
 * excluded instead of failing the run. On any other target a skip in them is a
 * failure like any other.
 */
/** @type {Record<string, string>} */
export const PG17_ONLY_SUITES = {
  // Creates and drops scratch databases next to the guarded one; the Supabase stack's role may not CREATE DATABASE.
  "src/server/__tests__/migration-safety.test.ts": "needs CREATE DATABASE for scratch databases",
};

/** True when the run targets the declared local Supabase stack (the target guard's own switch). */
export function isSupabaseLocalTarget(env = process.env) {
  return env.OUTLY_TEST_SUPABASE_LOCAL === "1";
}

/**
 * `storage` project: the S3 document store against a local Supabase Storage
 * container (scripts/test-storage/up.sh). Never a hosted project.
 */
/** @type {string[]} */
export const STORAGE_SUITES = ["src/server/documents/__tests__/*.storage.test.ts"];

/** `render` project: also needs a running `next dev`/`next start` on the same database (JSON_LD_RENDER_BASE). */
/** @type {string[]} */
export const RENDER_SUITES = ["src/app/__tests__/json-ld-render.test.ts"];

/** @type {string[]} */
export const ALL_TESTS = ["src/**/__tests__/**/*.test.ts", "src/**/*.test.ts"];
