import { assertDisposableDbLive, assertDisposableTarget, installEgressBlock, loadTestEnv } from "./src/server/__tests__/helpers/target-guard";

/**
 * `db` and `render` project setup, run in every worker before each test file.
 *
 *  - Env comes from `.env.test.local` (or OUTLY_TEST_ENV_FILE) only, never
 *    `.env.local`; a variable already in the environment is not overridden,
 *    and the guard then judges whatever is set.
 *  - The target guard runs its static checks, then its live checks on the
 *    same Prisma client the suites import.
 *  - Every non-loopback connection fails.
 *
 * Without a database (and without OUTLY_REQUIRE_DB=1) the suites skip through
 * `dbEnabled`; the globalSetup has already refused the run when it is required.
 */
loadTestEnv();
installEgressBlock();
if (process.env.DATABASE_URL || process.env.OUTLY_REQUIRE_DB === "1") {
  assertDisposableTarget();
  const { prisma } = await import("./src/server/lib/db");
  await assertDisposableDbLive(prisma);
}
