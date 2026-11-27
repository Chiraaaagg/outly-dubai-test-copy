import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

/**
 * Review 103 N0-06: `supplier_tour_content.raw` keeps supplier HTML and
 * dropped addresses as received, for re-parsing only. Pin who may touch it:
 * the catalogue sync writes it; no other source file reads the table with
 * `raw` selected or spreads a whole row (no `select`) into anything.
 */

const SRC = path.join(process.cwd(), "src");
const WRITERS = new Set(["src/server/services/supplier-catalog.service.ts"]);

function sources(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const full = path.join(dir, name);
    if (statSync(full).isDirectory()) return name === "__tests__" ? [] : sources(full);
    return /\.(ts|tsx)$/.test(name) && !/\.test\.tsx?$/.test(name) ? [full] : [];
  });
}

describe("supplier_tour_content.raw readers", () => {
  it("only the catalogue sync touches raw; every other reader selects named columns without it", () => {
    const users = sources(SRC)
      .map((f) => ({ file: path.relative(process.cwd(), f), text: readFileSync(f, "utf8") }))
      .filter((f) => f.text.includes("supplierTourContent"));
    expect(users.length).toBeGreaterThan(0);
    for (const { file, text } of users) {
      if (WRITERS.has(file)) continue;
      expect(text, file).not.toMatch(/raw:\s*true/);
      for (const call of text.matchAll(/supplierTourContent\.(findMany|findFirst|findUnique|findFirstOrThrow|findUniqueOrThrow)\(\{([\s\S]*?)\}\)/g)) {
        expect(call[2], `${file}: ${call[1]} must name its columns`).toMatch(/select:/);
      }
    }
  });
});
