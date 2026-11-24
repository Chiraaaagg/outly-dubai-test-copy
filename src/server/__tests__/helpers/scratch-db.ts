import { spawn, spawnSync } from "node:child_process";
import { copyFileSync, cpSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { PrismaClient } from "@prisma/client";
import { assertDisposableDbLive, assertDisposableTarget, TargetGuardError, TEST_DB_NAME } from "./target-guard";

/**
 * Scratch databases for the migration safety suite (docs/backend/27 §3).
 *
 * A scratch database lives on the SAME disposable Postgres server as the
 * guarded test database and nowhere else:
 *
 *  - the guarded test database passes the full target guard (static and live,
 *    marker row included) before a scratch database is created through it;
 *  - the scratch name is `outly_test_mig_<label>` (it matches the guard's
 *    `outly_test_*` rule and never equals the guarded database's own name);
 *  - its URL is the guarded URL with only the database name changed, and it
 *    passes the guard's static checks;
 *  - once connected, it must report the same server (postmaster start time
 *    and port) as the guarded connection; the guard's marker row is then
 *    copied in and the guard's live checks run on it too;
 *  - every Prisma CLI child gets an explicit environment (the scratch URL,
 *    PATH and HOME), and its URL is re-checked before each spawn.
 *
 * Only names this helper created are ever dropped.
 */

const ROOT = path.resolve(import.meta.dirname, "../../../..");
const PRISMA_CLI = path.join(ROOT, "node_modules/prisma/build/index.js");
export const MIGRATIONS_DIR = path.join(ROOT, "prisma/migrations");
const SCHEMA_FILE = path.join(ROOT, "prisma/schema.prisma");
const SCRATCH_PREFIX = "outly_test_mig_";
const LABEL = /^[a-z0-9_]{1,24}$/;

/** Every migration directory, in apply order. */
export function migrationNames(): string[] {
  return readdirSync(MIGRATIONS_DIR, { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => d.name)
    .sort();
}

export interface ScratchDb {
  name: string;
  url: string;
  client: PrismaClient;
  drop(): Promise<void>;
}

function scratchUrl(name: string): string {
  const base = process.env.DATABASE_URL;
  if (!base) throw new TargetGuardError("DATABASE_URL is not set");
  const u = new URL(base);
  u.pathname = `/${name}`;
  return u.toString();
}

/** The guard's static checks, judged on the scratch URL (and only scratch names). */
function assertScratchUrl(url: string): void {
  const name = decodeURIComponent(new URL(url).pathname.replace(/^\//, ""));
  if (!name.startsWith(SCRATCH_PREFIX) || !TEST_DB_NAME.test(name)) throw new TargetGuardError("scratch database name is not outly_test_mig_*");
  assertDisposableTarget({ env: { ...process.env, DATABASE_URL: url, DIRECT_URL: url } });
}

type Identity = { started: Date; port: number; db: string };

async function identity(client: { $queryRawUnsafe<T>(q: string): Promise<T> }): Promise<Identity> {
  const [r] = await client.$queryRawUnsafe<Identity[]>(`SELECT pg_postmaster_start_time() AS started, inet_server_port() AS port, current_database()::text AS db`);
  return r;
}

/**
 * Creates (or recreates) `outly_test_mig_<label>` next to the guarded test
 * database `main`, after the full guard has passed on `main`.
 */
export async function createScratchDb(main: PrismaClient, label: string): Promise<ScratchDb> {
  if (!LABEL.test(label)) throw new TargetGuardError("scratch label must be [a-z0-9_]{1,24}");
  const target = await assertDisposableDbLive(main);
  const name = `${SCRATCH_PREFIX}${label}`;
  if (name === target.database) throw new TargetGuardError("a scratch database never replaces the guarded test database");
  const url = scratchUrl(name);
  assertScratchUrl(url);

  await main.$executeRawUnsafe(`DROP DATABASE IF EXISTS "${name}" WITH (FORCE)`);
  await main.$executeRawUnsafe(`CREATE DATABASE "${name}"`);
  const client = new PrismaClient({ datasources: { db: { url } } });
  const drop = async () => {
    await client.$disconnect().catch(() => {});
    await main.$executeRawUnsafe(`DROP DATABASE IF EXISTS "${name}" WITH (FORCE)`);
  };
  try {
    const [mine, theirs] = await Promise.all([identity(main), identity(client)]);
    if (theirs.db !== name || theirs.port !== mine.port || new Date(theirs.started).getTime() !== new Date(mine.started).getTime()) {
      throw new TargetGuardError("the scratch connection did not reach the guarded test server");
    }
    // The guarded instance's marker, so the guard's live checks hold here too.
    const [marker] = await main.$queryRawUnsafe<{ id: string; port: number }[]>(`SELECT instance_id::text AS id, host_port AS port FROM zz_disposable.zz_disposable_instance`);
    await client.$executeRawUnsafe(`CREATE SCHEMA zz_disposable`);
    await client.$executeRawUnsafe(
      `CREATE TABLE zz_disposable.zz_disposable_instance (singleton boolean PRIMARY KEY DEFAULT true CHECK (singleton), instance_id uuid NOT NULL, host_port integer NOT NULL, created_at timestamptz NOT NULL DEFAULT now())`,
    );
    await client.$executeRawUnsafe(`INSERT INTO zz_disposable.zz_disposable_instance (instance_id, host_port) VALUES ('${marker.id}'::uuid, ${Number(marker.port)})`);
    await assertDisposableDbLive(client, { env: { ...process.env, DATABASE_URL: url, DIRECT_URL: url } });
  } catch (e) {
    await drop();
    throw e;
  }
  return { name, url, client, drop };
}

export interface CliResult {
  status: number | null;
  output: string;
}

/** Runs the Prisma CLI against one scratch database only, with an explicit environment. */
function cliEnv(url: string): NodeJS.ProcessEnv {
  assertScratchUrl(url);
  const env: NodeJS.ProcessEnv = { NODE_ENV: "test", DATABASE_URL: url, DIRECT_URL: url, CHECKPOINT_DISABLE: "1", PRISMA_HIDE_UPDATE_MESSAGE: "1", NO_COLOR: "1" };
  for (const k of ["PATH", "HOME"]) if (process.env[k]) env[k] = process.env[k]!;
  return env;
}

export function prismaCli(url: string, args: string[], timeoutMs = 120_000): CliResult {
  const r = spawnSync(process.execPath, [PRISMA_CLI, ...args], { cwd: ROOT, env: cliEnv(url), encoding: "utf8", timeout: timeoutMs });
  return { status: r.status, output: `${r.stdout ?? ""}${r.stderr ?? ""}${r.error ? String(r.error) : ""}` };
}

/** As `prismaCli`, without blocking the event loop (a test can hold a lock on another connection meanwhile). */
export function prismaCliAsync(url: string, args: string[], timeoutMs = 120_000): Promise<CliResult> {
  const env = cliEnv(url);
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [PRISMA_CLI, ...args], { cwd: ROOT, env });
    let output = "";
    child.stdout.on("data", (d) => (output += String(d)));
    child.stderr.on("data", (d) => (output += String(d)));
    const timer = setTimeout(() => child.kill("SIGKILL"), timeoutMs);
    child.on("close", (status) => {
      clearTimeout(timer);
      resolve({ status, output });
    });
  });
}

/** `prisma migrate deploy` of exactly `names`, without blocking the event loop. */
export async function deployAsync(url: string, names: string[], timeoutMs?: number): Promise<CliResult> {
  const sub = migrationsSubset(names);
  try {
    return await prismaCliAsync(url, ["migrate", "deploy", "--schema", sub.schema], timeoutMs);
  } finally {
    sub.cleanup();
  }
}

/**
 * A throwaway Prisma project holding the schema and the named migrations
 * only (optionally with a migration's SQL replaced), for `migrate deploy` of
 * a prefix of the history. Returns the schema path; `cleanup` removes it.
 */
export function migrationsSubset(names: string[], replace: Record<string, string> = {}): { schema: string; cleanup(): void } {
  const dir = mkdtempSync(path.join(os.tmpdir(), "outly-mig-"));
  const schema = path.join(dir, "schema.prisma");
  copyFileSync(SCHEMA_FILE, schema);
  mkdirSync(path.join(dir, "migrations"));
  copyFileSync(path.join(MIGRATIONS_DIR, "migration_lock.toml"), path.join(dir, "migrations", "migration_lock.toml"));
  for (const n of names) {
    const to = path.join(dir, "migrations", n);
    cpSync(path.join(MIGRATIONS_DIR, n), to, { recursive: true });
    if (replace[n] !== undefined) writeFileSync(path.join(to, "migration.sql"), replace[n]);
  }
  return { schema, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

/** `prisma migrate deploy` of exactly `names` (in order) on a scratch database. */
export function deploy(url: string, names: string[], replace: Record<string, string> = {}, timeoutMs?: number): CliResult {
  const sub = migrationsSubset(names, replace);
  try {
    return prismaCli(url, ["migrate", "deploy", "--schema", sub.schema], timeoutMs);
  } finally {
    sub.cleanup();
  }
}

/** `prisma migrate resolve --rolled-back <name>`: marks a failed migration rolled back so it may be applied again. */
export function resolveRolledBack(url: string, names: string[], name: string): CliResult {
  const sub = migrationsSubset(names);
  try {
    return prismaCli(url, ["migrate", "resolve", "--rolled-back", name, "--schema", sub.schema]);
  } finally {
    sub.cleanup();
  }
}

type Raw = { $queryRawUnsafe<T>(q: string): Promise<T> };

/**
 * A comparable picture of everything the migrations create in `public`,
 * from pg_catalog: tables and RLS flags, columns, constraints, indexes,
 * triggers, functions, enum labels, sequences, policies and table ACLs.
 * Prisma's own `_prisma_migrations` table is left out.
 */
export async function catalogSnapshot(db: Raw): Promise<Record<string, string[]>> {
  const q = async (sql: string) => (await db.$queryRawUnsafe<{ v: string }[]>(sql)).map((r) => r.v);
  const ns = `(SELECT oid FROM pg_namespace WHERE nspname = 'public')`;
  const rel = `c.relnamespace = ${ns} AND c.relname <> '_prisma_migrations'`;
  return {
    relations: await q(`SELECT c.relname || ' ' || c.relkind::text || ' rls=' || c.relrowsecurity || ' force=' || c.relforcerowsecurity AS v FROM pg_class c WHERE ${rel} AND c.relkind IN ('r','v','m','S','p') ORDER BY 1`),
    columns: await q(
      `SELECT c.relname || '.' || a.attname || ' ' || format_type(a.atttypid, a.atttypmod) || ' notnull=' || a.attnotnull || ' default=' || coalesce(pg_get_expr(d.adbin, d.adrelid), '-') || ' identity=' || a.attidentity::text || ' generated=' || a.attgenerated::text AS v
       FROM pg_attribute a JOIN pg_class c ON c.oid = a.attrelid LEFT JOIN pg_attrdef d ON d.adrelid = a.attrelid AND d.adnum = a.attnum
       WHERE ${rel} AND c.relkind IN ('r','v','m','p') AND a.attnum > 0 AND NOT a.attisdropped ORDER BY 1`,
    ),
    constraints: await q(`SELECT c.relname || ' ' || k.conname || ' ' || pg_get_constraintdef(k.oid) AS v FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid WHERE ${rel} ORDER BY 1`),
    indexes: await q(`SELECT pg_get_indexdef(i.indexrelid) AS v FROM pg_index i JOIN pg_class c ON c.oid = i.indrelid WHERE ${rel} ORDER BY 1`),
    triggers: await q(`SELECT c.relname || ' ' || pg_get_triggerdef(t.oid) || ' enabled=' || t.tgenabled::text AS v FROM pg_trigger t JOIN pg_class c ON c.oid = t.tgrelid WHERE ${rel} AND NOT t.tgisinternal ORDER BY 1`),
    functions: await q(`SELECT p.proname || '(' || pg_get_function_identity_arguments(p.oid) || ') ' || md5(pg_get_functiondef(p.oid)) AS v FROM pg_proc p WHERE p.pronamespace = ${ns} AND p.prokind IN ('f','p') ORDER BY 1`),
    enums: await q(`SELECT t.typname || ' ' || string_agg(e.enumlabel, ',' ORDER BY e.enumsortorder) AS v FROM pg_type t JOIN pg_enum e ON e.enumtypid = t.oid WHERE t.typnamespace = ${ns} GROUP BY t.typname ORDER BY 1`),
    sequences: await q(`SELECT c.relname || ' ' || s.seqtypid::regtype || ' start=' || s.seqstart || ' inc=' || s.seqincrement || ' min=' || s.seqmin || ' max=' || s.seqmax || ' cycle=' || s.seqcycle AS v FROM pg_sequence s JOIN pg_class c ON c.oid = s.seqrelid WHERE ${rel} ORDER BY 1`),
    policies: await q(`SELECT c.relname || ' ' || p.polname || ' ' || p.polcmd::text || ' ' || coalesce(pg_get_expr(p.polqual, p.polrelid), '-') || ' ' || coalesce(pg_get_expr(p.polwithcheck, p.polrelid), '-') AS v FROM pg_policy p JOIN pg_class c ON c.oid = p.polrelid WHERE ${rel} ORDER BY 1`),
    acls: await q(`SELECT c.relname || ' ' || coalesce(c.relacl::text, '-') AS v FROM pg_class c WHERE ${rel} AND c.relkind IN ('r','v','m','S','p') ORDER BY 1`),
  };
}

export interface ColumnInfo {
  table: string;
  column: string;
  type: string;
  notNull: boolean;
  hasDefault: boolean;
  identityOrGenerated: boolean;
}

/** Columns of every ordinary table in `public` (Prisma's own table excluded). */
export async function columnsOf(db: Raw): Promise<ColumnInfo[]> {
  return db.$queryRawUnsafe<ColumnInfo[]>(
    `SELECT c.relname AS "table", a.attname AS "column", format_type(a.atttypid, a.atttypmod) AS "type", a.attnotnull AS "notNull",
            (d.adbin IS NOT NULL) AS "hasDefault", (a.attidentity <> '' OR a.attgenerated <> '') AS "identityOrGenerated"
     FROM pg_attribute a JOIN pg_class c ON c.oid = a.attrelid LEFT JOIN pg_attrdef d ON d.adrelid = a.attrelid AND d.adnum = a.attnum
     WHERE c.relnamespace = (SELECT oid FROM pg_namespace WHERE nspname = 'public') AND c.relkind IN ('r','p') AND c.relname <> '_prisma_migrations'
       AND a.attnum > 0 AND NOT a.attisdropped ORDER BY 1, 2`,
  );
}
