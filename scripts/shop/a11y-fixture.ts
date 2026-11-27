/**
 * Browser and accessibility checks: prepare the synthetic shop in a
 * disposable test database (scripts/shop/README.md, "Browser and
 * accessibility checks"; run by scripts/shop/a11y.sh).
 *
 * Writes to the LOCAL disposable database only: the target guard runs first
 * (loopback, an allowlisted test port, an outly_test_* database, the instance
 * marker, no provider credential in the environment; a TravelDesk test key is
 * refused too). It needs the seeded catalogue (`scripts/db.mjs seed`).
 *
 * What it writes: for the two products of e2e/support/a11y-shop.ts, an
 * eligibility verdict `instant` under the current readiness rules, so the
 * storefront renders them as instant products once INSTANT_RELEASE_ENABLED is
 * true for the app. Nothing else changes: the product content stays as
 * seeded, no mapping, capability flag or offer evidence is written, and no
 * supplier or payment provider is called.
 *
 * Why the verdict is written directly instead of switching capability flags
 * on and re-running readiness: readiness, the start-times read and the pickup
 * hotel read all need a live TravelDesk configuration, and the TravelDesk
 * config admits only the two official hosts (traveldesk.config.ts). A CI job
 * must never hold one. The browser specs answer the two public reads with
 * contract-typed synthetic bodies instead (e2e/support/controls.ts); the
 * server side of both reads is covered by the unit and database suites.
 *
 *   OUTLY_TEST_ENV_FILE=.env.test.local NODE_OPTIONS=--conditions=react-server \
 *     node --env-file=.env.test.local node_modules/tsx/dist/cli.mjs scripts/shop/a11y-fixture.ts
 */
import { A11Y_SHOP_SLUGS } from "../../e2e/support/a11y-shop";
import { assertDisposableDbLive, assertDisposableTarget } from "../lib/target-guard";

assertDisposableTarget();

async function main() {
  const { prisma } = await import("../../src/server/lib/db");
  await assertDisposableDbLive(prisma);
  const { READINESS_RULES_VERSION } = await import("../../src/server/services/readiness.service");
  const now = new Date();
  for (const slug of A11Y_SHOP_SLUGS) {
    const product = await prisma.product.findUnique({ where: { slug }, select: { id: true, status: true, deletedAt: true } });
    if (!product || product.status !== "published" || product.deletedAt) throw new Error(`a11y fixture: ${slug} is not a published seeded product (run scripts/db.mjs seed)`);
    const verdict = { effectiveMode: "instant" as const, reasons: [], readinessVersion: READINESS_RULES_VERSION, evaluatedAt: now };
    await prisma.productEligibility.upsert({ where: { productId: product.id }, create: { productId: product.id, ...verdict }, update: verdict });
    console.log(JSON.stringify({ slug, effectiveMode: "instant", readinessVersion: READINESS_RULES_VERSION }));
  }
  await prisma.$disconnect();
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
