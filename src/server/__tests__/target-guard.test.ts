import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { createHash } from "node:crypto";
import net from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  assertDisposableDbLive,
  assertDisposableTarget,
  assertNoDatabaseTarget,
  assertNoLinkedSupabaseDir,
  assertNoPrismaEnvFiles,
  confirmProductionTarget,
  EgressBlockedError,
  guardedChildEnv,
  namesProductionRef,
  parseTargetArgs,
  PRODUCTION_PROJECT_REF_SHA256,
  testEnvFile,
  type RawQueryClient,
} from "./helpers/target-guard";

/**
 * Target guard negative tests (SEC-3, SEC-6). No database: the live checks run
 * against a scripted client. Each refused shape from the review is covered:
 * hosted URL, loopback without marker, wrong database name, Postgres 16,
 * Supabase fingerprint, linked parent directory, deny-listed env keys.
 */

const ID = "0192f0aa-1234-7abc-8def-0123456789ab";
const URL_OK = "postgresql://outly_test:pw@127.0.0.1:55434/outly_test_main?schema=public";

let tmp: string;
let cwd: string;

function env(over: Record<string, string | undefined> = {}): Record<string, string | undefined> {
  return { DATABASE_URL: URL_OK, DIRECT_URL: URL_OK, OUTLY_TEST_DB_INSTANCE_ID: ID, ...over };
}

function refuses(over: Record<string, string | undefined>, pattern: RegExp, opts: { cwd?: string; allowTravelDeskTestKey?: boolean } = {}) {
  expect(() => assertDisposableTarget({ env: env(over), cwd: opts.cwd ?? cwd, allowTravelDeskTestKey: opts.allowTravelDeskTestKey })).toThrow(pattern);
}

interface Live {
  db?: string;
  usr?: string;
  addr?: string | null;
  ver?: number;
  supa?: number;
  marker?: string | null;
  rows?: Array<{ id: string; port: number }>;
}

/** Answers the guard's three queries the way a server would. */
function fakeClient(live: Live = {}): RawQueryClient {
  return {
    async $queryRawUnsafe<T>(q: string): Promise<T> {
      if (q.includes("current_database()")) {
        return [{ db: live.db ?? "outly_test_main", usr: live.usr ?? "outly_test", addr: live.addr === undefined ? "172.17.0.2" : live.addr, ver: live.ver ?? 170006, supa: live.supa ?? 0 }] as T;
      }
      if (q.includes("to_regclass")) return [{ t: live.marker === undefined ? "zz_disposable.zz_disposable_instance" : live.marker }] as T;
      if (q.includes("zz_disposable_instance")) return (live.rows ?? [{ id: ID, port: 55434 }]) as T;
      throw new Error(`unexpected query: ${q}`);
    },
  };
}

beforeAll(() => {
  tmp = realpathSync(mkdtempSync(path.join(tmpdir(), "outly-guard-")));
  cwd = path.join(tmp, "work");
  mkdirSync(cwd, { recursive: true });
});

afterAll(() => {
  rmSync(tmp, { recursive: true, force: true });
});

describe("target guard: static checks", () => {
  it("accepts the disposable target", () => {
    expect(assertDisposableTarget({ env: env(), cwd })).toMatchObject({ host: "127.0.0.1", port: 55434, database: "outly_test_main", user: "outly_test", instanceId: ID, supabaseLocal: false });
  });

  it("refuses a missing DATABASE_URL", () => {
    refuses({ DATABASE_URL: undefined }, /DATABASE_URL is not set/);
  });

  it.each([
    ["Supabase pooler", "postgresql://postgres.abcdefghijklmnopqrst:pw@aws-0-eu-west-1.pooler.supabase.com:6543/postgres?pgbouncer=true"],
    ["Supabase direct", "postgresql://postgres:pw@db.abcdefghijklmnopqrst.supabase.co:5432/postgres"],
    ["Neon", "postgresql://u:pw@ep-x-pooler.eu-central-1.aws.neon.tech/outlyy"],
  ])("refuses a hosted URL (%s)", (_label, url) => {
    refuses({ DATABASE_URL: url }, /hosted database or project/);
  });

  it.each([
    ["remote host", "postgresql://outly_test:pw@db.example.test:55434/outly_test_main", /not 127\.0\.0\.1/],
    ["localhost name (resolver-dependent)", "postgresql://outly_test:pw@localhost:55434/outly_test_main", /not 127\.0\.0\.1/],
    ["TLS required", `${URL_OK}&sslmode=require`, /requires TLS/],
    ["host override in the query", `${URL_OK}&host=/tmp`, /overrides "host"/],
    ["no port", "postgresql://outly_test:pw@127.0.0.1/outly_test_main", /no explicit port/],
    ["default Postgres port", "postgresql://outly_test:pw@127.0.0.1:5432/outly_test_main", /not an allowlisted test port/],
    ["the PG 16 TravelDesk container", "postgresql://outly_test:pw@127.0.0.1:55440/outly_test_main", /not an allowlisted test port/],
    ["not postgres", "mysql://outly_test:pw@127.0.0.1:55434/outly_test_main", /not a postgres URL/],
  ])("refuses %s", (_label, url, pattern) => {
    refuses({ DATABASE_URL: url }, pattern);
  });

  it.each(["outly_main", "outly_luna", "outly_td", "postgres", "outly_test_", "outly_test_Main", "outly_test_main;drop", `outly_test_${"x".repeat(41)}`])("refuses database name %s", (name) => {
    refuses({ DATABASE_URL: `postgresql://outly_test:pw@127.0.0.1:55434/${name}` }, /database does not match/);
  });

  it.each(["postgres", "outly", "outly_test2"])("refuses user %s", (user) => {
    refuses({ DATABASE_URL: `postgresql://${user}:pw@127.0.0.1:55434/outly_test_main` }, /user is not outly_test/);
  });

  it("refuses a DIRECT_URL that points elsewhere", () => {
    refuses({ DIRECT_URL: "postgresql://outly_test:pw@127.0.0.1:55433/outly_test_other" }, /different databases/);
  });

  it("refuses a missing or malformed instance id", () => {
    refuses({ OUTLY_TEST_DB_INSTANCE_ID: undefined }, /OUTLY_TEST_DB_INSTANCE_ID/);
    refuses({ OUTLY_TEST_DB_INSTANCE_ID: "not-a-uuid" }, /OUTLY_TEST_DB_INSTANCE_ID/);
  });

  it("honours OUTLY_TEST_DB_PORTS but never for real-database ports", () => {
    expect(assertDisposableTarget({ env: env({ OUTLY_TEST_DB_PORTS: "55499", DATABASE_URL: URL_OK.replace("55434", "55499"), DIRECT_URL: undefined }), cwd }).port).toBe(55499);
    refuses({ OUTLY_TEST_DB_PORTS: "55499" }, /port 55434 is not an allowlisted test port/);
    refuses({ OUTLY_TEST_DB_PORTS: "5432" }, /OUTLY_TEST_DB_PORTS/);
    refuses({ OUTLY_TEST_DB_PORTS: "6543" }, /OUTLY_TEST_DB_PORTS/);
    refuses({ OUTLY_TEST_DB_PORTS: "54322" }, /OUTLY_TEST_DB_PORTS/);
  });

  describe("deny-listed environment", () => {
    it.each(["RESEND_API_KEY", "MSG91_AUTH_KEY", "TRAVELDESK_API_KEY", "SUPABASE_SERVICE_ROLE_KEY", "SUPABASE_SECRET_KEY", "SUPABASE_ACCESS_TOKEN", "VERCEL_TOKEN", "NEON_API_KEY", "META_CAPI_ACCESS_TOKEN"])("refuses %s", (key) => {
      refuses({ [key]: "zz-synthetic" }, new RegExp(`${key} is set`));
    });

    it("ignores an empty deny-listed value", () => {
      expect(() => assertDisposableTarget({ env: env({ RESEND_API_KEY: "" }), cwd })).not.toThrow();
    });

    it("allows only the TravelDesk TEST key, and only when asked", () => {
      const td = { TRAVELDESK_API_KEY: "zz-synthetic", TRAVELDESK_ENV: "test", TRAVELDESK_API_BASE_URL: "https://testapi.traveldesk.me/public/b2b/v1" };
      refuses(td, /TRAVELDESK_API_KEY is set/);
      expect(() => assertDisposableTarget({ env: env(td), cwd, allowTravelDeskTestKey: true })).not.toThrow();
      refuses({ ...td, TRAVELDESK_ENV: "production" }, /TRAVELDESK_API_KEY is set/, { allowTravelDeskTestKey: true });
      refuses({ ...td, TRAVELDESK_API_BASE_URL: "https://api.traveldesk.me/public/b2b/v1" }, /TRAVELDESK_API_KEY is set/, { allowTravelDeskTestKey: true });
    });

    it("refuses live keys and *_LIVE_* variables", () => {
      refuses({ SOME_KEY: "sk_live_zzsynthetic" }, /SOME_KEY holds a live key/);
      refuses({ RAZORPAY_LIVE_KEY: "zz" }, /RAZORPAY_LIVE_KEY is set/);
    });

    it("finds the production ref by its hash anywhere in a value, never by a literal", () => {
      const fake = "abcdefghijklmnopqrst";
      const fakeSha = createHash("sha256").update(fake).digest("hex");
      expect(namesProductionRef(`postgresql://outly_test:pw@127.0.0.1:55434/outly_test_${fake}`, fakeSha)).toBe(true);
      expect(namesProductionRef(`zz${fake}zz`, fakeSha)).toBe(true);
      expect(namesProductionRef("postgresql://outly_test:pw@127.0.0.1:55434/outly_test_main", fakeSha)).toBe(false);
      expect(PRODUCTION_PROJECT_REF_SHA256).toMatch(/^[0-9a-f]{64}$/);
    });

    it("refuses hosted identifiers in any variable", () => {
      refuses({ SOMETHING_ELSE: "https://abcdefghijklmnopqrst.supabase.co" }, /SOMETHING_ELSE names a hosted/);
    });

    it.each(["PGHOST", "PGSERVICE", "PGHOSTADDR", "PGDATABASE"])("refuses the libpq fallback %s", (key) => {
      refuses({ [key]: "zz" }, new RegExp(`${key} is set`));
    });
  });
});

describe("target guard: linked Supabase directories", () => {
  function linked(dir: string) {
    mkdirSync(path.join(dir, "supabase", ".temp"), { recursive: true });
    writeFileSync(path.join(dir, "supabase", ".temp", "project-ref"), "zzsyntheticprojectrf");
  }

  it("refuses a linked parent directory unless that exact parent is acknowledged", () => {
    const parent = path.join(tmp, "linked-parent");
    const child = path.join(parent, "worktree");
    mkdirSync(child, { recursive: true });
    linked(parent);
    expect(() => assertNoLinkedSupabaseDir({ cwd: child, env: {} })).toThrow(/linked Supabase project exists in parent directory/);
    expect(() => assertDisposableTarget({ env: env(), cwd: child })).toThrow(/parent directory/);
    expect(() => assertNoLinkedSupabaseDir({ cwd: child, env: { OUTLY_TEST_ALLOW_LINKED_PARENT: parent } })).not.toThrow();
    expect(() => assertNoLinkedSupabaseDir({ cwd: child, env: { OUTLY_TEST_ALLOW_LINKED_PARENT: tmp } })).toThrow(/parent directory/);
  });

  it("refuses a linked working directory even with the override", () => {
    const dir = path.join(tmp, "linked-cwd");
    mkdirSync(dir, { recursive: true });
    linked(dir);
    expect(() => assertNoLinkedSupabaseDir({ cwd: dir, env: { OUTLY_TEST_ALLOW_LINKED_PARENT: dir } })).toThrow(/working directory contains a linked/);
  });

  it("refuses a stale override", () => {
    expect(() => assertNoLinkedSupabaseDir({ cwd, env: { OUTLY_TEST_ALLOW_LINKED_PARENT: tmp } })).toThrow(/not a linked parent/);
  });
});

describe("target guard: live checks", () => {
  const live = (l: Live, over: Record<string, string | undefined> = {}) => assertDisposableDbLive(fakeClient(l), { env: env(over), cwd });

  it("accepts the disposable instance", async () => {
    await expect(live({})).resolves.toMatchObject({ database: "outly_test_main", port: 55434 });
    await expect(live({ addr: "127.0.0.1" })).resolves.toBeTruthy();
  });

  it("refuses loopback without the marker (a tunnel to a kept database)", async () => {
    await expect(live({ marker: null })).rejects.toThrow(/no disposable marker/);
  });

  it("refuses a marker for another instance or port, or more than one row", async () => {
    await expect(live({ rows: [{ id: "0192f0aa-1234-7abc-8def-000000000000", port: 55434 }] })).rejects.toThrow(/does not match/);
    await expect(live({ rows: [{ id: ID, port: 55433 }] })).rejects.toThrow(/different port/);
    await expect(live({ rows: [] })).rejects.toThrow(/exactly one row/);
    await expect(live({ rows: [{ id: ID, port: 55434 }, { id: ID, port: 55434 }] })).rejects.toThrow(/exactly one row/);
  });

  it("refuses Postgres 16", async () => {
    await expect(live({ ver: 160015 })).rejects.toThrow(/Postgres 16; tests need Postgres 17/);
  });

  it("refuses a connection whose database or user differs from the URL", async () => {
    await expect(live({ db: "outly_td" })).rejects.toThrow(/connected database differs/);
    await expect(live({ usr: "postgres" })).rejects.toThrow(/connected user differs/);
  });

  it("refuses a server address that is not local", async () => {
    await expect(live({ addr: "10.20.30.40" })).rejects.toThrow(/server address/);
    await expect(live({ addr: "203.0.113.7" })).rejects.toThrow(/server address/);
    await expect(live({ addr: null })).rejects.toThrow(/server address/);
  });

  it("refuses a Supabase fingerprint unless the local stack is declared", async () => {
    await expect(live({ supa: 2 })).rejects.toThrow(/Supabase roles/);
    await expect(live({ supa: 2 }, { OUTLY_TEST_SUPABASE_LOCAL: "1" })).rejects.toThrow(/OUTLY_TEST_SUPABASE_API_URL/);
  });

  it("accepts the declared local Supabase stack from an unlinked workdir, and only that", async () => {
    const workdir = path.join(tmp, "outly-disposable");
    mkdirSync(path.join(workdir, "supabase"), { recursive: true });
    writeFileSync(path.join(workdir, "supabase", "config.toml"), "project_id = \"outly-disposable\"\n");
    const url = "postgresql://postgres:pw@127.0.0.1:54322/postgres";
    const supa = { OUTLY_TEST_SUPABASE_LOCAL: "1", OUTLY_TEST_SUPABASE_API_URL: "http://127.0.0.1:54321", OUTLY_TEST_SUPABASE_WORKDIR: workdir, DATABASE_URL: url, DIRECT_URL: url };
    await expect(live({ supa: 2, db: "postgres", usr: "postgres", rows: [{ id: ID, port: 54322 }] }, supa)).resolves.toMatchObject({ supabaseLocal: true });
    // Declared but not a Supabase server; wrong API URL; workdir missing or linked.
    await expect(live({ supa: 0, db: "postgres", usr: "postgres", rows: [{ id: ID, port: 54322 }] }, supa)).rejects.toThrow(/not a Supabase stack/);
    await expect(live({ supa: 2 }, { ...supa, OUTLY_TEST_SUPABASE_API_URL: "https://abc.supabase.co" })).rejects.toThrow(/OUTLY_TEST_SUPABASE_API_URL/);
    await expect(live({ supa: 2 }, { ...supa, OUTLY_TEST_SUPABASE_WORKDIR: undefined })).rejects.toThrow(/OUTLY_TEST_SUPABASE_WORKDIR/);
    mkdirSync(path.join(workdir, "supabase", ".temp"), { recursive: true });
    writeFileSync(path.join(workdir, "supabase", ".temp", "project-ref"), "zzsyntheticprojectrf");
    await expect(live({ supa: 2 }, supa)).rejects.toThrow(/linked/);
    // The local stack's port is refused outside that mode.
    refuses({ DATABASE_URL: url.replace("postgres:pw", "outly_test:pw").replace("/postgres", "/outly_test_main"), DIRECT_URL: undefined }, /not an allowlisted test port/);
  });
});

describe("target guard: Prisma runs through scripts/db.mjs (CR-1)", () => {
  function repo(name: string, files: string[] = []): string {
    const root = path.join(tmp, name);
    mkdirSync(path.join(root, "prisma"), { recursive: true });
    for (const f of files) writeFileSync(path.join(root, f), "DIRECT_URL=postgresql://zz:zz@db.example.test:5432/zz\n");
    return root;
  }

  it("requires DIRECT_URL for a Prisma run, and only then", () => {
    const root = repo("prisma-clean");
    expect(() => assertDisposableTarget({ env: env({ DIRECT_URL: undefined }), cwd })).not.toThrow();
    expect(() => assertDisposableTarget({ env: env({ DIRECT_URL: undefined }), cwd, prismaRoot: root })).toThrow(/DIRECT_URL is not set/);
    expect(assertDisposableTarget({ env: env(), cwd, prismaRoot: root }).port).toBe(55434);
  });

  it.each([".env", "prisma/.env"])("refuses a Prisma run while %s exists", (file) => {
    const root = repo(`prisma-${file.replace(/\W/g, "_")}`, [file]);
    expect(() => assertNoPrismaEnvFiles(root)).toThrow(new RegExp(`${file.replace(".", "\\.")} exists`));
    expect(() => assertDisposableTarget({ env: env(), cwd, prismaRoot: root })).toThrow(/Prisma would load it/);
  });

  it("does not look for those files outside a Prisma run", () => {
    const root = repo("prisma-dotenv-unused", [".env"]);
    expect(() => assertDisposableTarget({ env: env(), cwd: root })).not.toThrow();
  });

  it("builds the child environment from the env file plus PATH and HOME only", () => {
    const parent = { PATH: "/usr/bin", HOME: "/home/zz", DATABASE_URL: "postgresql://zz:zz@db.example.test:5432/zz", DIRECT_URL: "postgresql://zz:zz@db.example.test:5432/zz", PGHOST: "db.example.test", OTHER: "zz" };
    const child = guardedChildEnv({ DATABASE_URL: URL_OK, OUTLY_TEST_DB_INSTANCE_ID: ID }, parent);
    expect(child).toEqual({ DATABASE_URL: URL_OK, DIRECT_URL: URL_OK, OUTLY_TEST_DB_INSTANCE_ID: ID, PATH: "/usr/bin", HOME: "/home/zz", CHECKPOINT_DISABLE: "1" });
    expect(assertDisposableTarget({ env: child, cwd, prismaRoot: repo("prisma-child") }).database).toBe("outly_test_main");
  });

  it("keeps the env file's own DIRECT_URL, so the guard still compares the two", () => {
    const other = "postgresql://outly_test:pw@127.0.0.1:55433/outly_test_other";
    const child = guardedChildEnv({ DATABASE_URL: URL_OK, DIRECT_URL: other, OUTLY_TEST_DB_INSTANCE_ID: ID }, {});
    expect(child.DIRECT_URL).toBe(other);
    expect(child.PATH).toBeUndefined();
    expect(() => assertDisposableTarget({ env: child, cwd, prismaRoot: repo("prisma-mismatch") })).toThrow(/different databases/);
  });

  it("takes PATH and HOME from the parent, never from the env file", () => {
    const child = guardedChildEnv({ DATABASE_URL: URL_OK, PATH: "/tmp/evil", HOME: "/tmp/evil" }, { PATH: "/usr/bin" });
    expect(child.PATH).toBe("/usr/bin");
    expect(child.HOME).toBeUndefined();
  });
});

describe("target guard: env file, script targets and the probe", () => {
  it("accepts only .env.test*.local files", () => {
    expect(testEnvFile({ env: {}, cwd })).toBe(path.join(cwd, ".env.test.local"));
    expect(testEnvFile({ env: { OUTLY_TEST_ENV_FILE: ".env.test.supabase.local" }, cwd })).toBe(path.join(cwd, ".env.test.supabase.local"));
    for (const f of [".env.local", ".env", ".env.production.local", ".env.traveldesk.production.local", "../.env.local", ".env.test"]) {
      expect(() => testEnvFile({ env: { OUTLY_TEST_ENV_FILE: f }, cwd }), f).toThrow(/\.env\.test\*\.local/);
    }
  });

  it("parses script targets strictly", () => {
    expect(parseTargetArgs([])).toEqual({ target: "test" });
    expect(parseTargetArgs(["--target=production", "--project-ref=abcdefghijklmnopqrst"])).toEqual({ target: "production", projectRef: "abcdefghijklmnopqrst" });
    expect(() => parseTargetArgs(["--target=production"])).toThrow(/project-ref/);
    expect(() => parseTargetArgs(["--target=production", "--project-ref=short"])).toThrow(/project-ref/);
    expect(() => parseTargetArgs(["--target=staging"])).toThrow(/test or production/);
    expect(() => parseTargetArgs(["--project-ref=abcdefghijklmnopqrst"])).toThrow(/only valid with/);
  });

  it("refuses a production target in an agent or CI session before asking anything", async () => {
    await expect(confirmProductionTarget({ projectRef: "abcdefghijklmnopqrst", action: "seed" }, { CLAUDECODE: "1" })).rejects.toThrow(/agent and CI/);
    await expect(confirmProductionTarget({ projectRef: "abcdefghijklmnopqrst", action: "seed" }, { CI: "true" })).rejects.toThrow(/agent and CI/);
  });

  it("the read-only probe refuses any database configuration", () => {
    expect(() => assertNoDatabaseTarget({})).not.toThrow();
    expect(() => assertNoDatabaseTarget({ DATABASE_URL: URL_OK })).toThrow(/DATABASE_URL is set/);
    expect(() => assertNoDatabaseTarget({ PGHOST: "x" })).toThrow(/PGHOST is set/);
  });
});

describe("egress block (installed by the unit project setup)", () => {
  let server: Server;
  let port = 0;

  beforeAll(async () => {
    server = createServer((_req, res) => res.end("local-ok"));
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    port = (server.address() as net.AddressInfo).port;
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  it("fetch to a public host is refused before any connection", async () => {
    await expect(fetch("https://example.com/")).rejects.toBeInstanceOf(EgressBlockedError);
  });

  it("a raw TCP connection to a public address fails", async () => {
    const err = await new Promise<Error>((resolve) => {
      const s = net.connect({ host: "203.0.113.10", port: 443 });
      s.on("error", resolve);
      s.on("connect", () => resolve(new Error("connected")));
    });
    expect(err).toBeInstanceOf(EgressBlockedError);
  });

  it("loopback still works", async () => {
    const res = await fetch(`http://127.0.0.1:${port}/`);
    expect(await res.text()).toBe("local-ok");
  });
});
