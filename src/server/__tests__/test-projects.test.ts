import { describe, expect, it } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { DB_SUITES, RENDER_SUITES, STORAGE_SUITES } from "../../../vitest.suites.mjs";

/**
 * A database suite outside the `db` project would run in `unit`, find no
 * DATABASE_URL and skip silently. Every test file that reaches for the
 * database must be listed in vitest.suites.mjs. The same holds for the
 * local Storage suites and the `storage` project.
 */

const ROOT = process.cwd();
const DB_MARKERS = /lib\/db["']|@prisma\/client|\bdbEnabled\b|process\.env\.DATABASE_URL/;
const SELF = "src/server/__tests__/test-projects.test.ts";
/** A suite that replaces the database module with a mock is a unit suite. */
const MOCKED_DB = /vi\.mock\(\s*["'][^"']*lib\/db["']/g;

function usesDatabase(file: string): boolean {
  return DB_MARKERS.test(readFileSync(path.join(ROOT, file), "utf8").replace(MOCKED_DB, ""));
}

/** vitest.suites.mjs uses plain paths and single-segment `*` only. */
function toRegex(glob: string): RegExp {
  return new RegExp(`^${glob.replace(/[.+?^${}()|[\]\\]/g, "\\$&").replace(/\*/g, "[^/]*")}$`);
}

function testFiles(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const full = path.join(dir, name);
    if (statSync(full).isDirectory()) testFiles(full, out);
    else if (name.endsWith(".test.ts")) out.push(path.relative(ROOT, full).split(path.sep).join("/"));
  }
  return out;
}

/**
 * A suite that reaches for the local Storage stack. Outside the `storage`
 * project it would run in `unit` without its env file and skip silently.
 */
const STORAGE_MARKERS = /OUTLY_STORAGE_ENV_FILE|OUTLY_REQUIRE_STORAGE/;

function usesStorage(file: string): boolean {
  return /\.storage\.test\.ts$/.test(file) || STORAGE_MARKERS.test(readFileSync(path.join(ROOT, file), "utf8"));
}

describe("vitest project membership", () => {
  const listed = [...DB_SUITES, ...RENDER_SUITES].map(toRegex);
  const storage = STORAGE_SUITES.map(toRegex);
  const files = testFiles(path.join(ROOT, "src"));

  it("every test file that uses the database is in the db or render project", () => {
    const strays = files.filter((f) => f !== SELF && !listed.some((r) => r.test(f)) && !storage.some((r) => r.test(f)) && usesDatabase(f));
    expect(strays).toEqual([]);
  });

  it("every test file that uses the local Storage stack is in the storage project", () => {
    const strays = files.filter((f) => f !== SELF && !storage.some((r) => r.test(f)) && usesStorage(f));
    expect(strays).toEqual([]);
  });

  it("no suite is in two projects", () => {
    const both = files.filter((f) => listed.some((r) => r.test(f)) && storage.some((r) => r.test(f)));
    expect(both).toEqual([]);
  });

  it("storage suites do not use the database", () => {
    const withDb = files.filter((f) => storage.some((r) => r.test(f)) && usesDatabase(f));
    expect(withDb).toEqual([]);
  });

  it("every listed suite exists", () => {
    for (const glob of [...DB_SUITES, ...RENDER_SUITES, ...STORAGE_SUITES]) expect(files.some((f) => toRegex(glob).test(f)), glob).toBe(true);
  });
});
