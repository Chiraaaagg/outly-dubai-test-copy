#!/usr/bin/env node
/**
 * Starts (or builds) the app for the browser specs against the local
 * Supabase test stack, and refuses anything that could reach a real provider.
 *
 *   node e2e/support/guarded-server.mjs dev   --dir <app dir> --port 3100
 *   node e2e/support/guarded-server.mjs build --dir <app dir> --port 3100
 *   node e2e/support/guarded-server.mjs start --dir <app dir> --port 3100
 *
 * The environment is `.env.test.supabase.local` (or OUTLY_TEST_ENV_FILE, which
 * must name a `.env.test*.local` file) plus PATH and HOME, and nothing else:
 * no inherited variable reaches Next. NEXT_PUBLIC_SITE_URL is set to
 * `http://localhost:<port>` so the same-origin check admits the specs
 * (E2E_BASE_URL must be that origin).
 *
 * Refuses when:
 *  - any variable whose name contains STRIPE, or starts with PAYMENTS_, is
 *    set in this process or in the env file (payments stay on the fakes:
 *    with no gateway configured every rail is NOT_CONFIGURED);
 *  - TravelDesk or Rathin is not the `mock` adapter, TravelDesk bookings are
 *    enabled, or SMS / WhatsApp is not the `log` provider;
 *  - the target guard (src/server/__tests__/helpers/target-guard.ts) does
 *    not admit the database: loopback, the local Supabase port, a test
 *    database and user, no provider credential anywhere;
 *  - the app directory holds any `.env*` file Next would load by itself.
 *
 * Prints variable names only, never values.
 */
import { spawn } from "node:child_process";
import { existsSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { assertDisposableTarget, guardedChildEnv, loadEnvFile, testEnvFile } from "../../src/server/__tests__/helpers/target-guard.ts";

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, "../..");

function fail(message) {
  console.error(`guarded-server: refused: ${message}`);
  process.exit(2);
}

const [mode, ...rest] = process.argv.slice(2);
if (!["dev", "build", "start"].includes(mode)) fail("mode must be dev, build or start");
const args = new Map();
for (let i = 0; i < rest.length; i += 2) args.set(rest[i], rest[i + 1]);
const appDir = path.resolve(args.get("--dir") ?? repoRoot);
const port = Number(args.get("--port") ?? "3100");
if (!Number.isInteger(port) || port < 1024 || port > 65535) fail("--port must be an unprivileged port");

const FORBIDDEN_NAME = (key) => /STRIPE/i.test(key) || /^PAYMENTS_/i.test(key);

for (const key of Object.keys(process.env)) {
  if (FORBIDDEN_NAME(key)) fail(`${key} is set in this process`);
}

const envFile = testEnvFile({ env: { OUTLY_TEST_ENV_FILE: process.env.OUTLY_TEST_ENV_FILE ?? ".env.test.supabase.local" }, cwd: repoRoot });
if (!existsSync(envFile)) fail(`${path.basename(envFile)} does not exist`);
const fileEnv = {};
loadEnvFile(envFile, fileEnv);
for (const key of Object.keys(fileEnv)) {
  if (FORBIDDEN_NAME(key)) fail(`${key} is set in ${path.basename(envFile)}`);
}

const must = {
  SUPPLIER_ADAPTER_TRAVELDESK: "mock",
  SUPPLIER_ADAPTER_RATHIN: "mock",
  SMS_PROVIDER: "log",
  WHATSAPP_PROVIDER: "log",
  OUTLY_TEST_SUPABASE_LOCAL: "1",
};
for (const [key, value] of Object.entries(must)) {
  if (fileEnv[key] !== value) fail(`${key} must be ${value}`);
}
if (fileEnv.TRAVELDESK_BOOKINGS_ENABLED === "true") fail("TRAVELDESK_BOOKINGS_ENABLED must not be true");

const dotEnvFiles = existsSync(appDir) ? readdirSync(appDir).filter((f) => f.startsWith(".env")) : [];
if (appDir !== repoRoot && dotEnvFiles.length) fail(`${appDir} holds ${dotEnvFiles.join(", ")}; Next would load them`);
if (appDir === repoRoot && dotEnvFiles.some((f) => /^\.env(\.(development|production))?(\.local)?$/.test(f))) fail("the repository holds a .env file Next loads by itself");

const childEnv = guardedChildEnv(fileEnv);
childEnv.NEXT_PUBLIC_SITE_URL = `http://localhost:${port}`;
childEnv.NEXT_TELEMETRY_DISABLED = "1";
// The acknowledgement of a linked parent directory applies to the worktree only; an app copy elsewhere has none to acknowledge.
const linkedParent = childEnv.OUTLY_TEST_ALLOW_LINKED_PARENT;
if (linkedParent && !(appDir + path.sep).startsWith(path.resolve(linkedParent) + path.sep)) delete childEnv.OUTLY_TEST_ALLOW_LINKED_PARENT;

try {
  assertDisposableTarget({ env: childEnv, cwd: appDir });
} catch (e) {
  fail(e instanceof Error ? e.message : String(e));
}
for (const key of Object.keys(childEnv)) {
  if (FORBIDDEN_NAME(key)) fail(`${key} reached the child environment`);
}

const nextBin = path.join(appDir, "node_modules", "next", "dist", "bin", "next");
if (!existsSync(nextBin)) fail("next is not installed in the app directory");
const nextArgs = mode === "build" ? ["build"] : [mode, "-p", String(port), "-H", "localhost"];
console.error(`guarded-server: ${mode} in ${appDir} on port ${port}; env from ${path.basename(envFile)} (${Object.keys(childEnv).length} variables)`);
const child = spawn(process.execPath, [nextBin, ...nextArgs], { cwd: appDir, env: childEnv, stdio: "inherit" });
for (const sig of ["SIGINT", "SIGTERM"]) process.on(sig, () => child.kill(sig));
child.on("exit", (code, signal) => process.exit(code ?? (signal ? 1 : 0)));
