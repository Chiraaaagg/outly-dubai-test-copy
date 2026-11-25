import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { dbEnabled } from "./helpers/fixtures";
import { assertDisposableDb, assertDisposableDbLive } from "./helpers/target-guard";

/**
 * Schema lint (SEC-1): every table in `public` has row level security on, and
 * the Supabase API roles hold no privilege on any table or sequence there.
 *
 * Runs on the disposable database built from the migrations. On plain
 * Postgres, scripts/test-db/up.sh creates `anon` and `authenticated` with
 * Supabase-style default grants, so a migration that forgets the revoke fails
 * here exactly as it would expose the table on a hosted project. The roles are
 * required: without them the grant check would prove nothing.
 */

const API_ROLES = ["anon", "authenticated"];
const TRAVELDESK_TABLES = [
  "supplier_catalogue_items",
  "supplier_price_snapshots",
  "supplier_mapping_candidates",
  "supplier_bookings",
  "supplier_booking_events",
  "supplier_jobs",
  "supplier_account_leases",
  // Doc 29 Batch 1a.
  "supplier_offer_capabilities",
  "supplier_capability_flags",
  "supplier_offer_enablement",
  // Doc 29 Batch 1b.
  "supplier_sync_runs",
  // Doc 30 N0.
  "supplier_tour_content",
];

describe.skipIf(!dbEnabled)("schema lint: RLS and API-role grants in public", () => {
  let prisma: typeof import("../lib/db").prisma;

  beforeAll(async () => {
    assertDisposableDb();
    ({ prisma } = await import("../lib/db"));
    await assertDisposableDbLive(prisma);
  });

  afterAll(async () => {
    await prisma?.$disconnect();
  });

  it("every table in public has row level security enabled", async () => {
    const rows = await prisma.$queryRawUnsafe<Array<{ name: string; rls: boolean }>>(
      `SELECT c.relname::text AS name, c.relrowsecurity AS rls
       FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
       WHERE n.nspname = 'public' AND c.relkind IN ('r', 'p')
       ORDER BY 1`,
    );
    expect(rows.length).toBeGreaterThan(30);
    expect(rows.filter((r) => !r.rls).map((r) => r.name)).toEqual([]);
    const names = new Set(rows.map((r) => r.name));
    for (const t of TRAVELDESK_TABLES) expect(names.has(t), t).toBe(true);
  });

  it("the Supabase API roles exist on the test database (so the grant check below means something)", async () => {
    const rows = await prisma.$queryRawUnsafe<Array<{ rolname: string }>>(`SELECT rolname::text AS rolname FROM pg_roles WHERE rolname = ANY($1::text[]) ORDER BY 1`, API_ROLES);
    expect(rows.map((r) => r.rolname)).toEqual(API_ROLES);
  });

  it.each(API_ROLES)("%s holds no privilege on any table, view or sequence in public", async (role) => {
    const tables = await prisma.$queryRawUnsafe<Array<{ name: string }>>(
      `SELECT c.relname::text AS name
       FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
       WHERE n.nspname = 'public' AND c.relkind IN ('r', 'p', 'v', 'm', 'f')
         AND CASE WHEN c.relkind IN ('r', 'p', 'v', 'm', 'f') THEN has_table_privilege($1, c.oid, 'SELECT, INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER') ELSE false END
       ORDER BY 1`,
      role,
    );
    expect(tables.map((t) => t.name)).toEqual([]);
    const sequences = await prisma.$queryRawUnsafe<Array<{ name: string }>>(
      `SELECT c.relname::text AS name
       FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
       WHERE n.nspname = 'public' AND c.relkind = 'S'
         -- CASE: the planner may evaluate the function before the relkind filter.
         AND CASE WHEN c.relkind = 'S' THEN has_sequence_privilege($1, c.oid, 'USAGE, SELECT, UPDATE') ELSE false END
       ORDER BY 1`,
      role,
    );
    expect(sequences.map((s) => s.name)).toEqual([]);
  });
});
