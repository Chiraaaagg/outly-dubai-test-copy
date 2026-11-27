import { PrismaClient } from "@prisma/client";
import { assertDisposableDbLive, assertDisposableTarget, loadTestEnv, TargetGuardError } from "./src/server/__tests__/helpers/target-guard";

/**
 * Runs once before any `db`/`render` worker starts. Refuses the whole run when
 * the target is not the disposable instance, and, with OUTLY_REQUIRE_DB=1,
 * when there is no database at all (a skip is not a pass).
 */
export default async function setup(): Promise<void> {
  try {
    await guard();
  } catch (e) {
    // Printed here as well: vitest's own report of a globalSetup error can fail
    // while mapping the stack and hide the message.
    console.error(`\ndb project refused: ${e instanceof Error ? e.message : String(e)}\n`);
    throw e;
  }
}

async function guard(): Promise<void> {
  const file = loadTestEnv();
  if (!process.env.DATABASE_URL) {
    if (process.env.OUTLY_REQUIRE_DB === "1") throw new TargetGuardError("OUTLY_REQUIRE_DB=1 but no test database is configured (run scripts/test-db/up.sh)");
    console.warn("db project: no DATABASE_URL in the test env; database suites will skip");
    return;
  }
  const target = assertDisposableTarget();
  const client = new PrismaClient({ datasources: { db: { url: process.env.DATABASE_URL } } });
  try {
    await assertDisposableDbLive(client);
  } finally {
    await client.$disconnect();
  }
  console.log(`db project: disposable ${target.database} on port ${target.port}, instance ${target.instanceId.slice(0, 8)}${file ? "" : " (from the process environment)"}`);
}
