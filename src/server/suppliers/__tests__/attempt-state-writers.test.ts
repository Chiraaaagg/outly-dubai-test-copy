import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

/**
 * SUP-20: supplier switching, refunds and customer remedies never write
 * attempt state. The booking engine is the only code that inserts or updates
 * supplier booking rows; a remedy that "marks it cancelled so the refund can
 * go out" would release the duplicate guard. Static: it reads source files
 * only, so a new writer anywhere else fails here until it is reviewed. The
 * engine's exported `transitionWithEvent` counts as a write too (CR-B1-12).
 */

const ROOT = process.cwd();
const ALLOWED = new Set(["src/server/services/supplier-booking.service.ts"]);
/**
 * Writers allowed to change personal columns of settled attempts only, never
 * their state (PRV-3 erasure pseudonymises the guest name and request
 * payload). Every write in these files is checked below.
 */
const PERSONAL_ONLY = new Map([["src/server/repositories/privacy.repo.ts", ["guestName", "requestPayload", "requestHash"]]]);
/**
 * Restore-drill fixtures (docs/backend/24-runbook-restore-drill.md Part A).
 * They write synthetic attempt rows, and the drill's simulated in-window
 * work, into guarded `outly_test_drill_*` scratch databases only (through
 * scripts/drill/drill-db.ts); no deployment path imports them. Reviewed with
 * the drill; any other new writer still fails here.
 */
const DRILL_FIXTURES = new Set(["scripts/drill/synthetic-load.ts", "scripts/drill/restore-drill.ts"]);
const WRITE = /\bsupplierBooking\s*\.\s*(update|updateMany|upsert|create|createMany|delete|deleteMany)\b|\b(UPDATE|INSERT\s+INTO|DELETE\s+FROM)\s+"?supplier_bookings\b|\btransitionWithEvent\b/;

function sources(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const full = path.join(dir, name);
    if (statSync(full).isDirectory()) {
      if (name === "__tests__" || name === "node_modules") continue;
      sources(full, out);
    } else if (/\.(ts|tsx|mjs)$/.test(name) && !/\.test\.ts$/.test(name)) out.push(full);
  }
  return out;
}

describe("attempt state has one writer (SUP-20)", () => {
  it("only the booking engine writes supplier booking rows", () => {
    const writers = [...sources(path.join(ROOT, "src")), ...sources(path.join(ROOT, "scripts"))]
      .map((f) => path.relative(ROOT, f).split(path.sep).join("/"))
      .filter((rel) => !ALLOWED.has(rel) && !PERSONAL_ONLY.has(rel) && !DRILL_FIXTURES.has(rel) && WRITE.test(readFileSync(path.join(ROOT, rel), "utf8")));
    expect(writers).toEqual([]);
  });

  it("drill fixtures reach their database only through the drill guard", () => {
    for (const rel of DRILL_FIXTURES) {
      const src = readFileSync(path.join(ROOT, rel), "utf8");
      expect(src, rel).toMatch(/["']\.\/drill-db["']/);
      expect(src, rel).not.toMatch(/from ["'][^"']*lib\/db["']/);
    }
  });

  it("personal-column writers never touch attempt state", () => {
    for (const [rel, columns] of PERSONAL_ONLY) {
      const src = readFileSync(path.join(ROOT, rel), "utf8");
      expect(/\btransitionWithEvent\b|\b(UPDATE|INSERT\s+INTO|DELETE\s+FROM)\s+"?supplier_bookings\b/.test(src), rel).toBe(false);
      const writes = [...src.matchAll(/\bsupplierBooking\s*\.\s*(update|updateMany|upsert|create|createMany|delete|deleteMany)\b[^\n]*/g)];
      expect(writes.length, rel).toBeGreaterThan(0);
      for (const w of writes) {
        expect(w[1], rel).toBe("update");
        const data = /data:\s*\{([^}]*)\}/.exec(w[0]);
        expect(data, `${rel}: write must name its data inline`).not.toBeNull();
        const keys = [...data![1].matchAll(/(\w+)\s*:/g)].map((m) => m[1]);
        for (const k of keys) expect(columns, `${rel} writes ${k}`).toContain(k);
      }
    }
  });

  it("the check sees a planted writer", () => {
    expect(WRITE.test("await tx.supplierBooking.update({ where: { id }, data: { state: 'cancelled' } })")).toBe(true);
    expect(WRITE.test('UPDATE "supplier_bookings" SET state = \'cancelled\'')).toBe(true);
    expect(WRITE.test('import { transitionWithEvent } from "@/server/services/supplier-booking.service";')).toBe(true);
    expect(WRITE.test("prisma.supplierBooking.findMany()")).toBe(false);
  });
});
