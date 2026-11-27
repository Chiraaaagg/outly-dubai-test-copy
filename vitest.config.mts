import { configDefaults, defineConfig } from "vitest/config";
import path from "node:path";
import { ALL_TESTS, DB_SUITES, RENDER_SUITES, STORAGE_SUITES } from "./vitest.suites.mjs";

/**
 * Four projects (docs/backend/reviews/2026-10-31-independent/security-database.md §6.3):
 *
 *  - unit:   no database and no env file; network egress blocked except
 *            loopback. `npm test` runs this one only.
 *  - db:     the disposable Postgres 17 from scripts/test-db/up.sh, through
 *            the target guard (globalSetup and every worker). Env comes from
 *            `.env.test.local` or OUTLY_TEST_ENV_FILE, never `.env.local`.
 *            `npm run test:db` sets OUTLY_REQUIRE_DB=1: a missing database
 *            fails the run and any skipped test counts as a failure.
 *  - render: the JSON-LD page check, which also needs a running server.
 *  - storage: the S3 document store against the disposable local Supabase
 *            Storage of scripts/test-storage/up.sh (loopback only; the
 *            suites refuse any other host). Env comes from the file named by
 *            OUTLY_STORAGE_ENV_FILE. `npm run test:storage` sets
 *            OUTLY_REQUIRE_STORAGE=1: a missing stack fails the run.
 */
const dbProject = {
  setupFiles: ["./vitest.setup.ts"],
  // One file at a time: suites share one database and its rate-limit buckets.
  fileParallelism: false,
  testTimeout: 60_000,
  hookTimeout: 60_000,
};

export default defineConfig({
  test: {
    environment: "node",
    reporters: ["default", "./vitest.no-skip-reporter.ts"],
    projects: [
      {
        extends: true,
        test: {
          name: "unit",
          include: ALL_TESTS,
          exclude: [...configDefaults.exclude, ...DB_SUITES, ...RENDER_SUITES, ...STORAGE_SUITES],
          setupFiles: ["./vitest.unit.setup.ts"],
        },
      },
      {
        extends: true,
        test: { name: "db", include: DB_SUITES, globalSetup: ["./vitest.db.global-setup.ts"], ...dbProject },
      },
      {
        extends: true,
        test: { name: "render", include: RENDER_SUITES, globalSetup: ["./vitest.db.global-setup.ts"], ...dbProject },
      },
      {
        extends: true,
        // One file at a time: suites share one local bucket.
        test: { name: "storage", include: STORAGE_SUITES, fileParallelism: false, testTimeout: 60_000, hookTimeout: 60_000 },
      },
    ],
  },
  resolve: {
    alias: { "@": path.resolve(import.meta.dirname, "src"), "server-only": path.resolve(import.meta.dirname, "vitest.server-only.ts") },
  },
});
