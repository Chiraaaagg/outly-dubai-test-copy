/**
 * Runner behind every `npm run db:*` script. It decides which database a
 * Prisma command may touch, so no db:* script reads `.env.local` any more.
 *
 *   node scripts/db.mjs <command>
 *     migrate       prisma migrate deploy
 *     migrate:dev   prisma migrate dev            (disposable target only)
 *     status        prisma migrate status
 *     studio        prisma studio                 (disposable target only)
 *     seed          prisma/seed.ts                [--prune-unknown-grants]
 *     purge         scripts/purge-test-rows.mjs
 *
 * Default target: the disposable test database from `.env.test.local` (or
 * OUTLY_TEST_ENV_FILE), created by scripts/test-db/up.sh. The target guard
 * (src/server/__tests__/helpers/target-guard.ts) runs its static checks and
 * its live checks (marker row, Postgres 17, no Supabase roles) before the
 * command starts.
 *
 * The command runs with an explicit environment: the variables from that
 * file, PATH and HOME, nothing inherited besides (an exported DATABASE_URL or
 * DIRECT_URL is ignored). DIRECT_URL defaults to DATABASE_URL, and the run is
 * refused while a root `.env` or `prisma/.env` exists, because Prisma would
 * load either for any variable left unset (review CR-1).
 *
 * Production, owner only, never in agent or CI sessions:
 *
 *   node scripts/db.mjs migrate --target=production --project-ref=<ref> --env-file=<path>
 *
 * needs an interactive terminal and the project ref typed back; every
 * database URL in the env file must name that project. `seed` and `purge`
 * ask for the confirmation themselves (they are also runnable directly).
 */
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  assertDisposableDbLive,
  assertNoPrismaEnvFiles,
  confirmProductionTarget,
  guardedChildEnv,
  loadEnvFile,
  parseTargetArgs,
  testEnvFile,
} from "../src/server/__tests__/helpers/target-guard.ts";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const PRISMA = path.join(ROOT, "node_modules/prisma/build/index.js");
const TSX = path.join(ROOT, "node_modules/tsx/dist/cli.mjs");

const COMMANDS = {
  migrate: [PRISMA, "migrate", "deploy"],
  "migrate:dev": [PRISMA, "migrate", "dev"],
  status: [PRISMA, "migrate", "status"],
  studio: [PRISMA, "studio"],
  seed: [TSX, "prisma/seed.ts"],
  purge: [TSX, "scripts/purge-test-rows.mjs"],
};
/** Commands that may run against production at all. */
const PRODUCTION_COMMANDS = new Set(["migrate", "status", "seed", "purge"]);
/** Commands that confirm a production target themselves. */
const SELF_CONFIRMING = new Set(["seed", "purge"]);

function fail(message) {
  console.error(`db: ${message}`);
  process.exit(2);
}

async function main() {
  const [command, ...rest] = process.argv.slice(2);
  if (!command || !(command in COMMANDS)) fail(`usage: node scripts/db.mjs <${Object.keys(COMMANDS).join("|")}> [--target=production --project-ref=<ref> --env-file=<path>]`);
  const target = parseTargetArgs(rest);
  const envFileArg = rest.find((a) => a.startsWith("--env-file="))?.slice("--env-file=".length);
  let env = { ...process.env };
  const forward = [];
  if (command === "seed" && rest.includes("--prune-unknown-grants")) forward.push("--prune-unknown-grants");
  // Before anything imports @prisma/client, which loads these files too.
  assertNoPrismaEnvFiles(ROOT);

  if (target.target === "test") {
    if (envFileArg) fail("--env-file is for --target=production; the test target reads .env.test.local or OUTLY_TEST_ENV_FILE");
    const file = testEnvFile({ env: process.env, cwd: ROOT });
    if (!existsSync(file)) fail(`${path.relative(ROOT, file)} not found; run scripts/test-db/up.sh first`);
    const fileEnv = {};
    loadEnvFile(file, fileEnv);
    const ignored = ["DATABASE_URL", "DIRECT_URL"].filter((k) => process.env[k] !== undefined && process.env[k] !== fileEnv[k]);
    if (ignored.length) console.warn(`db: ignoring ${ignored.join(" and ")} from the shell; the target comes from ${path.relative(ROOT, file)}`);
    env = guardedChildEnv(fileEnv);
    const { PrismaClient } = await import("@prisma/client");
    const client = new PrismaClient({ datasources: { db: { url: env.DATABASE_URL } } });
    try {
      const t = await assertDisposableDbLive(client, { env, cwd: process.cwd(), prismaRoot: ROOT });
      console.log(`db: disposable target ${t.database} on port ${t.port} (instance ${t.instanceId.slice(0, 8)})`);
    } finally {
      await client.$disconnect();
    }
  } else {
    if (!PRODUCTION_COMMANDS.has(command)) fail(`${command} is never run against production`);
    if (!envFileArg || !existsSync(envFileArg)) fail("--target=production needs --env-file=<path> to an existing file");
    delete env.DATABASE_URL;
    delete env.DIRECT_URL;
    loadEnvFile(envFileArg, env);
    if (SELF_CONFIRMING.has(command)) forward.push(`--target=production`, `--project-ref=${target.projectRef}`);
    else await confirmProductionTarget({ projectRef: target.projectRef, action: `prisma ${COMMANDS[command].slice(1).join(" ")}` }, env);
  }

  const r = spawnSync(process.execPath, [...COMMANDS[command], ...forward], { cwd: ROOT, env, stdio: "inherit" });
  process.exit(r.status ?? 1);
}

main().catch((e) => fail(e instanceof Error ? e.message : String(e)));
