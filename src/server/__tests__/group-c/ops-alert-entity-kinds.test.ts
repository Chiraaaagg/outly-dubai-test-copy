import { describe, expect, it } from "vitest";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { OPS_ENTITY_KINDS } from "../../services/ops-alert.kinds";

/**
 * Review 102 finding 1: `ops_alerts_entity_kind_check` is dropped and
 * re-created by several migrations, on more than one branch. A later
 * migration that copies an old list silently narrows it (Group B's kinds
 * would then fail on insert after both branches merge). This reads the SQL
 * only, no database: every re-definition must keep every kind of the one
 * before it, and the final one must hold every kind the code writes.
 */
const MIGRATIONS = path.resolve(import.meta.dirname, "../../../../prisma/migrations");

/** Group B (impl/postpay-b, migration 20261130120000_group_b_customer_identities) adds these; they must survive Group C's re-definition. */
const GROUP_B_KINDS = ["order_account_link", "customer", "email_volume"];

function definitions(): { migration: string; kinds: string[] }[] {
  const out: { migration: string; kinds: string[] }[] = [];
  for (const name of readdirSync(MIGRATIONS).filter((n) => /^\d{14}_/.test(n)).sort()) {
    let sql: string;
    try {
      sql = readFileSync(path.join(MIGRATIONS, name, "migration.sql"), "utf8");
    } catch {
      continue;
    }
    const code = sql.replace(/--.*$/gm, "");
    for (const m of code.matchAll(/"ops_alerts_entity_kind_check"\s+CHECK\s*\(\s*"entity_kind"\s+IN\s*\(([^)]*)\)/gi)) {
      out.push({ migration: name, kinds: [...m[1].matchAll(/'([a-z_]+)'/g)].map((k) => k[1]) });
    }
  }
  return out;
}

describe("ops_alerts_entity_kind_check (review 102 finding 1)", () => {
  const defs = definitions();

  it("is defined by the migrations this test knows", () => {
    expect(defs.length).toBeGreaterThanOrEqual(5);
    expect(defs[0].migration).toBe("20261104120000_ops_alerts");
  });

  it("no re-definition narrows the list", () => {
    for (let i = 1; i < defs.length; i++) {
      const missing = defs[i - 1].kinds.filter((k) => !defs[i].kinds.includes(k));
      expect(missing, `${defs[i].migration} drops kinds of ${defs[i - 1].migration}`).toEqual([]);
    }
  });

  it("the final constraint covers every OpsEntityKind, the digest row and Group B's kinds", () => {
    const final = defs[defs.length - 1].kinds;
    for (const k of [...OPS_ENTITY_KINDS, "digest", ...GROUP_B_KINDS]) expect(final, k).toContain(k);
  });
});
