import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import { B1_PERMISSIONS } from "../../suppliers/booking-port";
import { PERMISSIONS, ROLE_CODES, ROLE_PERMISSIONS, type RoleCode } from "../permissions";

/**
 * Role matrix for the B1 permissions (doc 22 §24.3, SEC-10). The holders are
 * the proposal in §24.3; the grant rows in migration 20261101110000 must say
 * exactly the same, so a database migrated without a reseed matches the code.
 */

const B1_HOLDERS: Record<(typeof B1_PERMISSIONS)[number], RoleCode[]> = {
  "products.activate_instant": ["admin"],
  "suppliers.pause": ["admin", "ops", "agent_lead"],
  "suppliers.resume": ["admin"],
  "suppliers.limits.raise": ["admin"],
  "suppliers.costs.view": ["admin", "finance"],
  "bookings.privileged_resolution": ["admin"],
  "payments.reconcile": ["admin", "finance"],
};

const MIGRATION = path.join(process.cwd(), "prisma/migrations/20261101110000_b1_engine_and_provenance/migration.sql");

function migrationGrants(): Array<[string, string]> {
  const sql = readFileSync(MIGRATION, "utf8");
  const block = sql.slice(sql.indexOf('INSERT INTO "role_permissions"'), sql.indexOf("ON CONFLICT DO NOTHING"));
  return [...block.matchAll(/\('([a-z_]+)', '([a-z_.]+)'\)/g)].map((m) => [m[1], m[2]]);
}

describe("B1 permissions", () => {
  it("every B1 permission is in PERMISSIONS", () => {
    for (const p of B1_PERMISSIONS) expect(PERMISSIONS as readonly string[], p).toContain(p);
  });

  it.each(B1_PERMISSIONS)("%s is held by exactly its proposed roles", (permission) => {
    const holders = ROLE_CODES.filter((r) => (ROLE_PERMISSIONS[r] as string[]).includes(permission));
    expect(holders.sort()).toEqual([...B1_HOLDERS[permission]].sort());
  });

  it("suppliers.manage keeps its existing holders (no grant removed)", () => {
    const holders = ROLE_CODES.filter((r) => ROLE_PERMISSIONS[r].includes("suppliers.manage"));
    expect(holders.sort()).toEqual(["admin", "ops"]);
  });

  it("the migration grants the same rows as the matrix, and only those", () => {
    const fromMatrix = ROLE_CODES.flatMap((r) => B1_PERMISSIONS.filter((p) => (ROLE_PERMISSIONS[r] as string[]).includes(p)).map((p) => `${r}:${p}`)).sort();
    expect(migrationGrants().map(([r, p]) => `${r}:${p}`).sort()).toEqual(fromMatrix);
  });

  it("the migration never deletes a grant", () => {
    expect(readFileSync(MIGRATION, "utf8")).not.toMatch(/DELETE\s+FROM\s+"?role_permissions/i);
  });
});
