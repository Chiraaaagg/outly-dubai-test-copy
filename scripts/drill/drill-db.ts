/**
 * Guarded scratch databases for the local restore drill
 * (docs/backend/24-runbook-restore-drill.md Part A).
 *
 * The same rules as the migration suite's scratch databases
 * (src/server/__tests__/helpers/scratch-db.ts), with the `outly_test_drill_`
 * prefix:
 *
 *  - the guarded test database (`.env.test.local`, normally
 *    `outly_test_main`) passes the full target guard, static and live, before
 *    any drill database is created through its connection. Nothing is read
 *    from or written to that database itself: it only issues CREATE DATABASE
 *    and DROP DATABASE for drill names;
 *  - a drill URL is the guarded URL with only the database name changed, and
 *    passes the guard's static checks;
 *  - a drill connection must report the same server (postmaster start time
 *    and port) as the guarded connection, and then passes the guard's live
 *    checks (marker row included) before anything is written to it;
 *  - only `outly_test_drill_*` names are ever created or dropped;
 *  - `docker exec` runs only after the container's published port and its
 *    postmaster start time match the guarded connection.
 *
 * Connection strings are never printed.
 */
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { PrismaClient } from "@prisma/client";
import {
  assertDisposableDbLive,
  assertDisposableTarget,
  assertNoPrismaEnvFiles,
  loadTestEnv,
  TargetGuardError,
  TEST_DB_NAME,
  type DisposableTarget,
} from "../lib/target-guard";

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const PRISMA_CLI = path.join(ROOT, "node_modules/prisma/build/index.js");
export const DRILL_PREFIX = "outly_test_drill_";
const DRILL_NAME = /^outly_test_drill_[a-z0-9_]{1,23}$/;
/** The container scripts/test-db/up.sh creates. */
export const CONTAINER = "outly-test-pg17";

export interface Main {
  client: PrismaClient;
  target: DisposableTarget;
  url: string;
  identity: Identity;
}

export interface DrillDb {
  name: string;
  url: string;
  client: PrismaClient;
}

interface Identity {
  started: string;
  port: number;
  db: string;
}

type Raw = { $queryRawUnsafe<T>(q: string): Promise<T> };

async function identityOf(client: Raw): Promise<Identity> {
  const [r] = await client.$queryRawUnsafe<{ started: string; port: number; db: string }[]>(
    `SELECT pg_postmaster_start_time()::text AS started, inet_server_port() AS port, current_database()::text AS db`,
  );
  return { started: r.started, port: Number(r.port), db: r.db };
}

/** Loads `.env.test.local` (or OUTLY_TEST_ENV_FILE) and passes the full guard on the guarded test database. */
export async function openMain(): Promise<Main> {
  const file = loadTestEnv({ cwd: ROOT });
  if (!file) throw new TargetGuardError(".env.test.local not found; run scripts/test-db/up.sh first");
  assertNoPrismaEnvFiles(ROOT);
  const url = process.env.DATABASE_URL!;
  const client = new PrismaClient({ datasources: { db: { url } } });
  try {
    const target = await assertDisposableDbLive(client, { cwd: ROOT });
    if (target.database.startsWith(DRILL_PREFIX)) throw new TargetGuardError("the guarded test database must not itself be a drill database");
    return { client, target, url, identity: await identityOf(client) };
  } catch (e) {
    await client.$disconnect();
    throw e;
  }
}

export function assertDrillName(name: string): void {
  if (!DRILL_NAME.test(name) || !TEST_DB_NAME.test(name)) throw new TargetGuardError("drill database name must be outly_test_drill_[a-z0-9_]{1,23}");
}

/** The guarded URL with only the database name changed; passes the guard's static checks. */
export function drillUrl(main: Main, name: string): string {
  assertDrillName(name);
  if (name === main.target.database) throw new TargetGuardError("a drill database never replaces the guarded test database");
  const u = new URL(main.url);
  u.pathname = `/${name}`;
  const url = u.toString();
  assertDisposableTarget({ env: { ...process.env, DATABASE_URL: url, DIRECT_URL: url }, cwd: ROOT });
  return url;
}

function guardEnv(url: string) {
  return { env: { ...process.env, DATABASE_URL: url, DIRECT_URL: url }, cwd: ROOT };
}

async function connectSameServer(main: Main, name: string, url: string): Promise<PrismaClient> {
  const client = new PrismaClient({ datasources: { db: { url } } });
  try {
    const theirs = await identityOf(client);
    if (theirs.db !== name || theirs.port !== main.identity.port || theirs.started !== main.identity.started) {
      throw new TargetGuardError("the drill connection did not reach the guarded test server");
    }
    return client;
  } catch (e) {
    await client.$disconnect();
    throw e;
  }
}

/**
 * Creates (or recreates) a drill database on the guarded server. With
 * `marker`, the guarded instance's marker row is copied in and the guard's
 * live checks run on it; without, the database stays empty (a restore target
 * gets its marker from the dump) and is not connected to.
 */
export async function createDrillDb(main: Main, name: string, opts: { marker: boolean }): Promise<DrillDb | { name: string; url: string }> {
  const url = drillUrl(main, name);
  await assertDisposableDbLive(main.client, { cwd: ROOT });
  await main.client.$executeRawUnsafe(`DROP DATABASE IF EXISTS "${name}" WITH (FORCE)`);
  await main.client.$executeRawUnsafe(`CREATE DATABASE "${name}"`);
  if (!opts.marker) return { name, url };
  const client = await connectSameServer(main, name, url);
  try {
    const [marker] = await main.client.$queryRawUnsafe<{ id: string; port: number }[]>(
      `SELECT instance_id::text AS id, host_port AS port FROM zz_disposable.zz_disposable_instance`,
    );
    await client.$executeRawUnsafe(`CREATE SCHEMA zz_disposable`);
    await client.$executeRawUnsafe(
      `CREATE TABLE zz_disposable.zz_disposable_instance (singleton boolean PRIMARY KEY DEFAULT true CHECK (singleton), instance_id uuid NOT NULL, host_port integer NOT NULL, created_at timestamptz NOT NULL DEFAULT now())`,
    );
    await client.$executeRawUnsafe(`INSERT INTO zz_disposable.zz_disposable_instance (instance_id, host_port) VALUES ('${marker.id}'::uuid, ${Number(marker.port)})`);
    await assertDisposableDbLive(client, guardEnv(url));
    // The Supabase-style default grants scripts/test-db/up.sh sets on the test database, so the
    // RLS/grant lint on a restored copy sees what a hosted apply would expose (migrations must revoke them).
    await client.$executeRawUnsafe(`GRANT USAGE ON SCHEMA public TO anon, authenticated`);
    for (const kind of ["TABLES", "SEQUENCES", "FUNCTIONS"]) {
      await client.$executeRawUnsafe(`ALTER DEFAULT PRIVILEGES FOR ROLE outly_test IN SCHEMA public GRANT ALL ON ${kind} TO anon, authenticated`);
    }
    return { name, url, client };
  } catch (e) {
    await client.$disconnect();
    await dropDrillDb(main, name);
    throw e;
  }
}

/** Connects to an existing drill database: same server, then the full live guard (its marker must match). */
export async function openDrillDb(main: Main, name: string): Promise<DrillDb> {
  const url = drillUrl(main, name);
  const client = await connectSameServer(main, name, url);
  try {
    await assertDisposableDbLive(client, guardEnv(url));
    return { name, url, client };
  } catch (e) {
    await client.$disconnect();
    throw e;
  }
}

export async function dropDrillDb(main: Main, name: string): Promise<void> {
  assertDrillName(name);
  await main.client.$executeRawUnsafe(`DROP DATABASE IF EXISTS "${name}" WITH (FORCE)`);
}

/** Drill databases that exist on the server now. */
export async function listDrillDbs(main: Main): Promise<string[]> {
  const rows = await main.client.$queryRawUnsafe<{ name: string }[]>(`SELECT datname::text AS name FROM pg_database WHERE datname LIKE 'outly\\_test\\_drill\\_%' ORDER BY 1`);
  return rows.map((r) => r.name);
}

/** `prisma migrate deploy` of every migration on one drill database, with an explicit environment. */
export function migrateDrillDb(main: Main, name: string): { status: number | null; output: string; ms: number } {
  const url = drillUrl(main, name);
  assertNoPrismaEnvFiles(ROOT);
  const env: NodeJS.ProcessEnv = { NODE_ENV: "test", DATABASE_URL: url, DIRECT_URL: url, CHECKPOINT_DISABLE: "1", PRISMA_HIDE_UPDATE_MESSAGE: "1", NO_COLOR: "1" };
  for (const k of ["PATH", "HOME"]) if (process.env[k]) env[k] = process.env[k]!;
  const t = performance.now();
  const r = spawnSync(process.execPath, [PRISMA_CLI, "migrate", "deploy"], { cwd: ROOT, env, encoding: "utf8", timeout: 300_000 });
  return { status: r.status, output: `${r.stdout ?? ""}${r.stderr ?? ""}`, ms: Math.round(performance.now() - t) };
}

/**
 * The container must be the guarded server: its published port is the
 * guarded URL's (loopback only) and its postmaster started when the guarded
 * connection's did. Only then does the drill `docker exec` into it.
 */
export function assertContainerIsMain(main: Main): void {
  const port = spawnSync("docker", ["port", CONTAINER, "5432/tcp"], { encoding: "utf8" });
  const published = (port.stdout ?? "").trim().split(/\r?\n/);
  if (port.status !== 0 || published.length !== 1 || published[0] !== `127.0.0.1:${main.target.port}`) {
    throw new TargetGuardError(`container ${CONTAINER} does not publish the guarded port on 127.0.0.1 only`);
  }
  const started = spawnSync("docker", ["exec", CONTAINER, "psql", "-U", "outly_test", "-d", main.target.database, "-Atc", "SELECT pg_postmaster_start_time()::text"], { encoding: "utf8" });
  if (started.status !== 0 || started.stdout.trim() !== main.identity.started) {
    throw new TargetGuardError(`container ${CONTAINER} is not the server the guarded connection reached`);
  }
}

export function dockerAvailable(): boolean {
  return spawnSync("docker", ["container", "inspect", CONTAINER], { stdio: "ignore" }).status === 0;
}
