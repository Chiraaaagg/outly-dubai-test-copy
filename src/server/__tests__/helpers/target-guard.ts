import { createHash } from "node:crypto";
import { existsSync, readFileSync, realpathSync, statSync } from "node:fs";
import net from "node:net";
import path from "node:path";

/**
 * Target guard for tests and scripts that open the database
 * (docs/backend/reviews/2026-10-31-independent/security-database.md §6.3,
 * SEC-3/SEC-6).
 *
 * A test or script may write only to a disposable local Postgres that was
 * created by `scripts/test-db/up.sh`. Loopback alone proves nothing (an SSH
 * tunnel to a kept database is also loopback), so the guard checks, in order:
 *
 *  1. Static, before connecting (`assertDisposableTarget`):
 *     - no linked Supabase CLI directory in the working directory, and none in
 *       a parent unless that exact parent is acknowledged (see
 *       `assertNoLinkedSupabaseDir`);
 *     - no provider credential, live key or hosted database identifier
 *       anywhere in the process environment;
 *     - no libpq fallbacks (PGHOST, PGSERVICE, ...);
 *     - DATABASE_URL and DIRECT_URL: loopback host, an allowlisted port,
 *       database `outly_test_*`, user `outly_test`, no TLS requirement and no
 *       host or service override in the query string;
 *     - OUTLY_TEST_DB_INSTANCE_ID is a UUID;
 *     - for a Prisma run (`prismaRoot`, scripts/db.mjs): DIRECT_URL is set and
 *       no `.env` or `prisma/.env` exists for Prisma to load on its own.
 *  2. Live, after connecting (`assertDisposableDbLive`):
 *     - current_database() and current_user equal the URL;
 *     - the server address is loopback or a Docker bridge address;
 *     - Postgres 17 or later (production is 17);
 *     - the marker row in zz_disposable.zz_disposable_instance equals
 *       OUTLY_TEST_DB_INSTANCE_ID and records the URL's port;
 *     - no Supabase roles, unless the local Supabase stack mode is declared.
 *
 * This module imports only Node built-ins and uses erasable TypeScript only,
 * so it loads under vitest, tsx and plain `node` (type stripping) alike.
 * Error messages name the failing check and the variable, never a value.
 */

type Env = Record<string, string | undefined>;

export class TargetGuardError extends Error {
  constructor(message: string) {
    super(`target guard: ${message}`);
    this.name = "TargetGuardError";
  }
}

/** 55433: the security branch's container. 55434: the PG 17 container from scripts/test-db/up.sh. */
export const DEFAULT_TEST_DB_PORTS: readonly number[] = [55433, 55434];
/** Ports that belong to a real or pooled Postgres, never to a disposable one. */
const FORBIDDEN_PORTS = new Set([5432, 6543]);
export const SUPABASE_LOCAL_DB_PORT = 54322;
export const SUPABASE_LOCAL_API_URL = "http://127.0.0.1:54321";
/**
 * SHA-256 of the production Supabase project ref. The ref itself is never
 * written in code (the public test copy must not carry it); any 20-letter
 * lowercase run in a value is hashed and compared (`namesProductionRef`).
 */
export const PRODUCTION_PROJECT_REF_SHA256 = "cc87d4bd1987dcc17bae60bdd221c561834a350b6191b1e5a99b1ba98a0b4102";

/** True when `value` contains a 20-letter lowercase run whose SHA-256 is `refSha256`. */
export function namesProductionRef(value: string, refSha256: string = PRODUCTION_PROJECT_REF_SHA256): boolean {
  for (const run of value.toLowerCase().match(/[a-z]{20,}/g) ?? []) {
    for (let i = 0; i + 20 <= run.length; i++) {
      if (createHash("sha256").update(run.slice(i, i + 20)).digest("hex") === refSha256) return true;
    }
  }
  return false;
}

export const TEST_DB_NAME = /^outly_test_[a-z0-9_]{1,40}$/;
export const TEST_DB_USER = "outly_test";
const LOOPBACK_HOSTS = new Set(["127.0.0.1", "[::1]"]);
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

/** Credentials that must never be present in a test process. */
export const DENY_KEYS: readonly string[] = [
  "RESEND_API_KEY",
  "MSG91_AUTH_KEY",
  "TRAVELDESK_API_KEY",
  "SUPABASE_SERVICE_ROLE_KEY",
  "SUPABASE_SECRET_KEY",
  "SUPABASE_ACCESS_TOKEN",
  "SUPABASE_DB_PASSWORD",
  "VERCEL_TOKEN",
  "NEON_API_KEY",
  "WHATSAPP_API_TOKEN",
  "META_CAPI_ACCESS_TOKEN",
  "META_MARKETING_API_TOKEN",
  "RAZORPAY_KEY_SECRET",
  "AED_GATEWAY_KEY_SECRET",
  "RATHIN_CLIENT_SECRET",
  "SENTRY_AUTH_TOKEN",
  "PEXELS_API_KEY",
  "GA4_API_SECRET",
  "POSTHOG_API_KEY",
  "UPSTASH_REDIS_REST_TOKEN",
  "QSTASH_TOKEN",
  "R2_SECRET_ACCESS_KEY",
  "TURNSTILE_SECRET_KEY",
];

/** Hosted database or project identifiers. Matched against every environment value. */
export const HOSTED_VALUE = /supabase\.(co|com|in|net)\b|pooler\.supabase|neon\.tech|rds\.amazonaws\.com/i;
const LIVE_VALUE = /\b(sk|rk|pk|rzp)_live_/;
/** libpq reads these when a URL leaves something out; a test URL must be complete. */
const LIBPQ_FALLBACKS = ["PGHOST", "PGHOSTADDR", "PGSERVICE", "PGSERVICEFILE", "PGDATABASE", "PGPORT"];
/** Query parameters that redirect a Postgres URL to another server. */
const URL_OVERRIDES = ["host", "hostaddr", "service", "port", "dbname"];

export interface GuardOptions {
  env?: Env;
  cwd?: string;
  /**
   * TravelDesk drills and the test catalogue sync carry the TravelDesk TEST key.
   * Allowed only together with TRAVELDESK_ENV=test and the test API host.
   */
  allowTravelDeskTestKey?: boolean;
  /**
   * Repository root, set when the target is handed to the Prisma CLI or a
   * Prisma script (scripts/db.mjs). DIRECT_URL is then required, and the env
   * files Prisma loads by itself under this root are refused
   * (`assertNoPrismaEnvFiles`).
   */
  prismaRoot?: string;
}

export interface DisposableTarget {
  host: string;
  port: number;
  database: string;
  user: string;
  instanceId: string;
  supabaseLocal: boolean;
}

interface ParsedUrl {
  key: string;
  host: string;
  port: number;
  database: string;
  user: string;
}

function realDir(p: string): string {
  try {
    return realpathSync(p);
  } catch {
    return path.resolve(p);
  }
}

/**
 * Refuses when a Supabase CLI directory linked to a hosted project
 * (`supabase/.temp/project-ref`) is reachable from `cwd`:
 *
 *  - in `cwd` itself: always refused. A CLI command run here would target the
 *    linked project.
 *  - in a parent: refused unless OUTLY_TEST_ALLOW_LINKED_PARENT names exactly
 *    that parent. The worktrees live under /Users/ASUS/Programs/OUTLYY, whose
 *    `supabase/` is linked to production; tests never run the Supabase CLI, so
 *    a known parent link can be acknowledged. Any other or unexpected link
 *    still refuses, and an override naming a directory without a link is
 *    itself refused (it would otherwise go stale silently).
 *
 * The local Supabase stack mode additionally requires an explicit, unlinked
 * CLI workdir (`assertSupabaseLocalMode`).
 */
export function assertNoLinkedSupabaseDir(opts: { cwd?: string; env?: Env } = {}): void {
  const env = opts.env ?? process.env;
  const cwd = realDir(opts.cwd ?? process.cwd());
  const allowParent = env.OUTLY_TEST_ALLOW_LINKED_PARENT ? realDir(env.OUTLY_TEST_ALLOW_LINKED_PARENT) : undefined;
  let allowedSeen = false;
  let dir = cwd;
  for (;;) {
    if (existsSync(path.join(dir, "supabase", ".temp", "project-ref"))) {
      if (dir === cwd) throw new TargetGuardError("the working directory contains a linked Supabase project (supabase/.temp/project-ref); run from an unlinked directory");
      if (dir !== allowParent) {
        throw new TargetGuardError(`a linked Supabase project exists in parent directory ${dir}; set OUTLY_TEST_ALLOW_LINKED_PARENT=${dir} to acknowledge it (tests never run the Supabase CLI)`);
      }
      allowedSeen = true;
    }
    const up = path.dirname(dir);
    if (up === dir) break;
    dir = up;
  }
  if (allowParent && !allowedSeen) throw new TargetGuardError("OUTLY_TEST_ALLOW_LINKED_PARENT names a directory that is not a linked parent of the working directory");
}

/** Refuses provider credentials, live keys and hosted identifiers anywhere in the environment. */
export function assertCleanEnvironment(opts: GuardOptions = {}): void {
  const env = opts.env ?? process.env;
  for (const key of DENY_KEYS) {
    if (!env[key]?.trim()) continue;
    if (key === "TRAVELDESK_API_KEY" && opts.allowTravelDeskTestKey && isTravelDeskTestConfig(env)) continue;
    throw new TargetGuardError(`${key} is set; a test process must not hold provider credentials`);
  }
  for (const [key, value] of Object.entries(env)) {
    if (!value) continue;
    if (/_LIVE_/.test(key)) throw new TargetGuardError(`${key} is set; live credentials are refused`);
    if (LIVE_VALUE.test(value)) throw new TargetGuardError(`${key} holds a live key`);
    if (HOSTED_VALUE.test(value) || namesProductionRef(value)) throw new TargetGuardError(`${key} names a hosted database or project`);
  }
  for (const key of LIBPQ_FALLBACKS) {
    if (env[key]) throw new TargetGuardError(`${key} is set; libpq fallbacks are refused`);
  }
}

function isTravelDeskTestConfig(env: Env): boolean {
  if (env.TRAVELDESK_ENV !== "test") return false;
  try {
    return new URL(env.TRAVELDESK_API_BASE_URL ?? "").hostname === "testapi.traveldesk.me";
  } catch {
    return false;
  }
}

export function allowedPorts(env: Env = process.env): number[] {
  const raw = env.OUTLY_TEST_DB_PORTS?.trim();
  if (!raw) return [...DEFAULT_TEST_DB_PORTS];
  return raw.split(",").map((s) => {
    const n = Number(s.trim());
    if (!Number.isInteger(n) || n < 1024 || n > 65535 || FORBIDDEN_PORTS.has(n) || n === SUPABASE_LOCAL_DB_PORT) {
      throw new TargetGuardError("OUTLY_TEST_DB_PORTS contains a port that cannot be a disposable test database");
    }
    return n;
  });
}

function parseDbUrl(key: string, raw: string): ParsedUrl {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    throw new TargetGuardError(`${key} is not a URL`);
  }
  if (u.protocol !== "postgresql:" && u.protocol !== "postgres:") throw new TargetGuardError(`${key} is not a postgres URL`);
  for (const p of URL_OVERRIDES) {
    if (u.searchParams.has(p)) throw new TargetGuardError(`${key} overrides "${p}" in its query string`);
  }
  const sslmode = u.searchParams.get("sslmode");
  if (sslmode && sslmode !== "disable" && sslmode !== "prefer") throw new TargetGuardError(`${key} requires TLS; hosted URLs do, the disposable database does not`);
  if (!u.port) throw new TargetGuardError(`${key} has no explicit port`);
  return {
    key,
    host: u.hostname,
    port: Number(u.port),
    database: decodeURIComponent(u.pathname.replace(/^\//, "")),
    user: decodeURIComponent(u.username),
  };
}

function supabaseLocalMode(env: Env): boolean {
  return env.OUTLY_TEST_SUPABASE_LOCAL === "1";
}

/**
 * The local Supabase stack (`supabase start`, PG 17) is allowed only when it is
 * declared, reachable on its fixed loopback ports, and run from an explicit
 * workdir outside every linked tree.
 */
function assertSupabaseLocalMode(env: Env): void {
  if (env.OUTLY_TEST_SUPABASE_API_URL !== SUPABASE_LOCAL_API_URL) {
    throw new TargetGuardError(`OUTLY_TEST_SUPABASE_LOCAL=1 needs OUTLY_TEST_SUPABASE_API_URL=${SUPABASE_LOCAL_API_URL}`);
  }
  const workdir = env.OUTLY_TEST_SUPABASE_WORKDIR;
  if (!workdir || !path.isAbsolute(workdir)) throw new TargetGuardError("OUTLY_TEST_SUPABASE_LOCAL=1 needs an absolute OUTLY_TEST_SUPABASE_WORKDIR");
  if (!existsSync(path.join(workdir, "supabase", "config.toml"))) throw new TargetGuardError("OUTLY_TEST_SUPABASE_WORKDIR has no supabase/config.toml");
  let dir = realDir(workdir);
  for (;;) {
    if (existsSync(path.join(dir, "supabase", ".temp", "project-ref"))) throw new TargetGuardError("OUTLY_TEST_SUPABASE_WORKDIR is linked, or inside a linked tree");
    const up = path.dirname(dir);
    if (up === dir) break;
    dir = up;
  }
}

/**
 * Static checks (no connection). Throws `TargetGuardError` on the first
 * failure; returns the disposable target otherwise.
 */
export function assertDisposableTarget(opts: GuardOptions = {}): DisposableTarget {
  const env = opts.env ?? process.env;
  assertNoLinkedSupabaseDir({ cwd: opts.cwd, env });
  if (opts.prismaRoot) assertNoPrismaEnvFiles(opts.prismaRoot);
  assertCleanEnvironment({ ...opts, env });
  const supabaseLocal = supabaseLocalMode(env);
  if (supabaseLocal) assertSupabaseLocalMode(env);
  const ports = allowedPorts(env);

  const urls: ParsedUrl[] = [];
  for (const key of ["DATABASE_URL", "DIRECT_URL"]) {
    const raw = env[key];
    if (!raw) {
      // Prisma Migrate prefers directUrl; an unset one would be filled from a file the guard never saw.
      if (key === "DIRECT_URL" && !opts.prismaRoot) continue;
      throw new TargetGuardError(`${key} is not set`);
    }
    const u = parseDbUrl(key, raw);
    if (!LOOPBACK_HOSTS.has(u.host)) throw new TargetGuardError(`${key} host is not 127.0.0.1 or [::1]`);
    if (supabaseLocal) {
      if (u.port !== SUPABASE_LOCAL_DB_PORT) throw new TargetGuardError(`${key} port is not the local Supabase database port ${SUPABASE_LOCAL_DB_PORT}`);
      if (u.user !== TEST_DB_USER && u.user !== "postgres") throw new TargetGuardError(`${key} user is not ${TEST_DB_USER} or the local stack's postgres`);
      if (!TEST_DB_NAME.test(u.database) && u.database !== "postgres") throw new TargetGuardError(`${key} database is not outly_test_* or the local stack's postgres`);
    } else {
      if (!ports.includes(u.port)) throw new TargetGuardError(`${key} port ${u.port} is not an allowlisted test port (${ports.join(", ")}; OUTLY_TEST_DB_PORTS)`);
      if (u.user !== TEST_DB_USER) throw new TargetGuardError(`${key} user is not ${TEST_DB_USER}`);
      if (!TEST_DB_NAME.test(u.database)) throw new TargetGuardError(`${key} database does not match ${TEST_DB_NAME.source}`);
    }
    urls.push(u);
  }
  const [main, direct] = urls;
  if (direct && (direct.host !== main.host || direct.port !== main.port || direct.database !== main.database)) {
    throw new TargetGuardError("DIRECT_URL and DATABASE_URL point at different databases");
  }
  const instanceId = env.OUTLY_TEST_DB_INSTANCE_ID?.trim().toLowerCase() ?? "";
  if (!UUID.test(instanceId)) throw new TargetGuardError("OUTLY_TEST_DB_INSTANCE_ID is not set to the instance's UUID (scripts/test-db/up.sh writes it)");
  return { host: main.host, port: main.port, database: main.database, user: main.user, instanceId, supabaseLocal };
}

/** Existing security-branch callers: static checks, nothing returned. */
export function assertDisposableDb(): void {
  assertDisposableTarget();
}

/** Anything with Prisma's raw query method (PrismaClient, a transaction client or a fake). */
export interface RawQueryClient {
  $queryRawUnsafe<T = unknown>(query: string, ...values: unknown[]): Promise<T>;
}

function isLocalServerAddress(addr: string | null): boolean {
  if (!addr) return false;
  const a = addr.replace(/^::ffff:/, "");
  if (a === "::1" || /^127\./.test(a)) return true;
  const m = /^(\d+)\.(\d+)\./.exec(a);
  if (!m) return false;
  const [x, y] = [Number(m[1]), Number(m[2])];
  // Docker bridge networks (172.16.0.0/12) and Docker Desktop's VM network (192.168.0.0/16).
  return (x === 172 && y >= 16 && y <= 31) || (x === 192 && y === 168);
}

/**
 * Static checks, then live identity on the connection `client` actually uses.
 * Call once per process before the first write.
 */
export async function assertDisposableDbLive(client: RawQueryClient, opts: GuardOptions = {}): Promise<DisposableTarget> {
  const target = assertDisposableTarget(opts);
  const env = opts.env ?? process.env;
  const [id] = await client.$queryRawUnsafe<Array<{ db: string; usr: string; addr: string | null; ver: number; supa: number }>>(
    `SELECT current_database()::text AS db, current_user::text AS usr, host(inet_server_addr()) AS addr,
            current_setting('server_version_num')::int AS ver,
            (SELECT count(*)::int FROM pg_roles WHERE rolname IN ('authenticator', 'supabase_admin')) AS supa`,
  );
  if (!id) throw new TargetGuardError("live identity query returned nothing");
  if (id.db !== target.database) throw new TargetGuardError("connected database differs from DATABASE_URL");
  if (id.usr !== target.user) throw new TargetGuardError("connected user differs from DATABASE_URL");
  if (!isLocalServerAddress(id.addr)) throw new TargetGuardError("server address is not loopback or a local Docker network");
  if (!(Number(id.ver) >= 170000)) throw new TargetGuardError(`server is Postgres ${Math.floor(Number(id.ver) / 10000)}; tests need Postgres 17 or later (production is 17)`);
  if (Number(id.supa) > 0 && !(supabaseLocalMode(env) && env.OUTLY_TEST_SUPABASE_API_URL === SUPABASE_LOCAL_API_URL)) {
    throw new TargetGuardError("server has Supabase roles; only the declared local Supabase stack (OUTLY_TEST_SUPABASE_LOCAL=1) is allowed");
  }
  if (Number(id.supa) === 0 && target.supabaseLocal) throw new TargetGuardError("OUTLY_TEST_SUPABASE_LOCAL=1 but the server is not a Supabase stack");

  const [reg] = await client.$queryRawUnsafe<Array<{ t: string | null }>>(`SELECT to_regclass('zz_disposable.zz_disposable_instance')::text AS t`);
  if (!reg?.t) throw new TargetGuardError("no disposable marker table (zz_disposable.zz_disposable_instance); this is not an instance created by scripts/test-db/up.sh");
  const rows = await client.$queryRawUnsafe<Array<{ id: string; port: number }>>(`SELECT instance_id::text AS id, host_port AS port FROM zz_disposable.zz_disposable_instance`);
  if (rows.length !== 1) throw new TargetGuardError("the disposable marker table must hold exactly one row");
  if (rows[0].id.toLowerCase() !== target.instanceId) throw new TargetGuardError("the disposable marker does not match OUTLY_TEST_DB_INSTANCE_ID");
  if (Number(rows[0].port) !== target.port) throw new TargetGuardError("the disposable marker records a different port");
  return target;
}

/** Scripts that never open the database (the read-only probe) refuse any database target. */
export function assertNoDatabaseTarget(env: Env = process.env): void {
  for (const key of ["DATABASE_URL", "DIRECT_URL", ...LIBPQ_FALLBACKS]) {
    if (env[key]) throw new TargetGuardError(`${key} is set; this script must run without any database configured`);
  }
}

/* ------------------------------------------------------------------ env files */

/** Parses KEY=VALUE lines the way `node --env-file` does; never overrides a variable already set. */
export function loadEnvFile(file: string, env: Env = process.env): void {
  for (const raw of readFileSync(file, "utf8").split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq <= 0) continue;
    const key = line.slice(0, eq).trim().replace(/^export\s+/, "");
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) continue;
    let value = line.slice(eq + 1).trim();
    const quoted = value.length >= 2 && ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'")));
    if (quoted) value = value.slice(1, -1);
    else {
      const hash = value.indexOf(" #");
      if (hash >= 0) value = value.slice(0, hash).trim();
    }
    if (env[key] === undefined) env[key] = value;
  }
}

/**
 * The test env file: `.env.test.local`, or the file named by
 * OUTLY_TEST_ENV_FILE. Only `.env.test*.local` names are accepted, so a test
 * run can never be pointed at `.env.local` or a production file.
 */
export function testEnvFile(opts: { env?: Env; cwd?: string } = {}): string {
  const env = opts.env ?? process.env;
  const file = path.resolve(opts.cwd ?? process.cwd(), env.OUTLY_TEST_ENV_FILE?.trim() || ".env.test.local");
  if (!/^\.env\.test(\.[A-Za-z0-9_-]+)*\.local$/.test(path.basename(file))) {
    throw new TargetGuardError("OUTLY_TEST_ENV_FILE must name a .env.test*.local file");
  }
  return file;
}

/**
 * Env files the Prisma CLI and the generated client load by themselves, for
 * any variable not already set. A hosted DIRECT_URL in one of them would be
 * used by Migrate without the guard ever seeing it, so a Prisma run refuses
 * while either file exists.
 */
export const PRISMA_AUTOLOADED_ENV_FILES: readonly string[] = [".env", "prisma/.env"];

export function assertNoPrismaEnvFiles(root: string): void {
  for (const rel of PRISMA_AUTOLOADED_ENV_FILES) {
    if (existsSync(path.join(root, rel))) {
      throw new TargetGuardError(`${rel} exists; Prisma would load it for any variable the guarded environment leaves unset. Move it out of the repository`);
    }
  }
}

/** The only variables a guarded Prisma child inherits from the parent process. */
export const CHILD_INHERITED_KEYS: readonly string[] = ["PATH", "HOME"];

/**
 * The complete environment for a Prisma child of scripts/db.mjs: the variables
 * loaded from the guarded env file, PATH and HOME from the parent, and nothing
 * else, so an inherited DATABASE_URL or DIRECT_URL cannot replace the guarded
 * one. DIRECT_URL defaults to DATABASE_URL, and Prisma's telemetry check is
 * switched off.
 */
export function guardedChildEnv(fileEnv: Env, parent: Env = process.env): Env {
  const env: Env = { ...fileEnv };
  for (const key of CHILD_INHERITED_KEYS) {
    if (parent[key] === undefined) delete env[key];
    else env[key] = parent[key];
  }
  if (!env.DIRECT_URL && env.DATABASE_URL) env.DIRECT_URL = env.DATABASE_URL;
  env.CHECKPOINT_DISABLE = "1";
  return env;
}

/** Loads the test env file when it exists. Returns its path, or undefined when absent. */
export function loadTestEnv(opts: { env?: Env; cwd?: string } = {}): string | undefined {
  const env = opts.env ?? process.env;
  const file = testEnvFile(opts);
  if (!existsSync(file) || !statSync(file).isFile()) return undefined;
  loadEnvFile(file, env);
  return file;
}

/* ------------------------------------------------------------------ egress */

const EGRESS_FLAG = Symbol.for("outly.test.egressBlocked");

export function isLoopbackHost(host: string | undefined | null): boolean {
  if (!host) return true; // Node's default host is localhost
  const h = host.replace(/^\[|\]$/g, "").toLowerCase();
  return h === "localhost" || h === "::1" || /^127\.\d+\.\d+\.\d+$/.test(h) || h.endsWith(".localhost");
}

export class EgressBlockedError extends Error {
  constructor(target: string) {
    super(`network egress blocked in tests: ${target}`);
    this.name = "EgressBlockedError";
  }
}

/**
 * Blocks every outbound connection except loopback, for the life of the
 * process:
 *  - `globalThis.fetch` rejects non-loopback URLs before any lookup;
 *  - `net.Socket.prototype.connect` (under net.connect, tls.connect, http(s)
 *    agents and Node's own fetch) fails non-loopback TCP targets.
 * Unix sockets stay allowed. Prisma's query engine is native and does not use
 * these; the static URL checks cover it.
 */
export function installEgressBlock(): void {
  const g = globalThis as unknown as Record<symbol, boolean>;
  if (g[EGRESS_FLAG]) return;
  g[EGRESS_FLAG] = true;

  const realFetch = globalThis.fetch;
  globalThis.fetch = ((input: string | URL | Request, init?: RequestInit) => {
    let host = "";
    try {
      host = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url).hostname;
    } catch {
      return Promise.reject(new EgressBlockedError("unparseable URL"));
    }
    if (!isLoopbackHost(host)) return Promise.reject(new EgressBlockedError(host));
    return realFetch(input, init);
  }) as typeof fetch;

  const proto = net.Socket.prototype as unknown as { connect: (...args: unknown[]) => net.Socket };
  const realConnect = proto.connect;
  proto.connect = function connect(this: net.Socket, ...args: unknown[]) {
    const first = Array.isArray(args[0]) ? (args[0] as unknown[])[0] : args[0];
    let host: string | undefined;
    let unix = false;
    if (first && typeof first === "object") {
      const o = first as { host?: string; path?: string };
      unix = Boolean(o.path);
      host = o.host;
    } else if (typeof first === "string" && !/^\d+$/.test(first)) {
      unix = true;
    } else if (typeof args[1] === "string") {
      host = args[1];
    }
    if (!unix && !isLoopbackHost(host)) {
      const err = new EgressBlockedError(host ?? "unknown host");
      process.nextTick(() => this.destroy(err));
      return this;
    }
    return realConnect.apply(this, args);
  };
}

/* ------------------------------------------------------------------ production target (owner only) */

export type TargetArgs = { target: "test" } | { target: "production"; projectRef: string };

/** `--target=production --project-ref=<ref>`; anything else is the disposable test target. */
export function parseTargetArgs(argv: readonly string[]): TargetArgs {
  const get = (name: string) => argv.find((a) => a.startsWith(`--${name}=`))?.slice(name.length + 3);
  const target = get("target") ?? "test";
  if (target === "test") {
    if (get("project-ref") !== undefined) throw new TargetGuardError("--project-ref is only valid with --target=production");
    return { target: "test" };
  }
  if (target !== "production") throw new TargetGuardError("--target must be test or production");
  const projectRef = get("project-ref") ?? "";
  if (!/^[a-z]{20}$/.test(projectRef)) throw new TargetGuardError("--target=production needs --project-ref=<20-letter Supabase project ref>");
  return { target: "production", projectRef };
}

function urlNamesProject(raw: string | undefined, ref: string): boolean {
  if (!raw) return true;
  try {
    const u = new URL(raw);
    return u.hostname.split(".").includes(ref) || decodeURIComponent(u.username).endsWith(`.${ref}`);
  } catch {
    return false;
  }
}

/**
 * Owner-only path for a deliberate production write (migrate, seed, purge).
 * Requires an interactive terminal, refuses agent and CI sessions, checks that
 * every database URL names the given project, and asks for the project ref to
 * be typed back. Never exercised by agents or tests.
 */
export async function confirmProductionTarget(args: { projectRef: string; action: string }, env: Env = process.env): Promise<void> {
  if (env.CLAUDECODE || env.CI || env.OUTLY_AGENT) throw new TargetGuardError("production targets are refused in agent and CI sessions");
  if (!process.stdin.isTTY || !process.stdout.isTTY) throw new TargetGuardError("production targets need an interactive terminal");
  for (const key of ["DATABASE_URL", "DIRECT_URL"]) {
    if (!urlNamesProject(env[key], args.projectRef)) throw new TargetGuardError(`${key} does not point at project ${args.projectRef}`);
  }
  const { createInterface } = await import("node:readline/promises");
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    const typed = await rl.question(`\n  PRODUCTION ${args.action} on Supabase project ${args.projectRef}.\n  Type the project ref to continue: `);
    if (typed.trim() !== args.projectRef) throw new TargetGuardError("confirmation did not match; nothing was done");
  } finally {
    rl.close();
  }
}
