import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";

/**
 * The control that keeps CRM edits away from money and access (doc 29e
 * §3.7, §12; release evidence; review C3-07). For every return path module:
 *  - every import, re-export (`export … from`), dynamic `import()` and
 *    `require()` is on an allowlist; nothing from payments, bookings,
 *    suppliers, orders, tickets, documents, refunds, privacy or access;
 *  - every Prisma model it touches, and every method on it, is on an
 *    allowlist; every table named in raw SQL is on an allowlist;
 *  - the commands module calls the inquiry service's `transition` and
 *    `assign` only, and the admin repository's `findById` only.
 * Comments are stripped first, so a doc comment can name what is out of reach.
 */

const ROOT = path.join(process.cwd(), "src/server/crm");
/** The database module's specifier, assembled so this unit file is not mistaken for a database suite (test-projects). */
const DB = ["..", "lib", "db"].join("/");

interface Rule {
  imports: string[];
  /** `model.method` pairs on `prisma.` or `tx.`. */
  models: string[];
  tables: string[];
}

const RULES: Record<string, Rule> = {
  "crm.reconcile.ts": { imports: ["node:crypto", "./bitrix.client", "./crm.config", "./crm.return.config", "./crm.mapping", "./crm.probe", "./crm.timeline", "./crm.worker"], models: [], tables: [] },
  "crm.return.config.ts": { imports: ["./crm.config"], models: [], tables: [] },
  "crm.return.alerts.ts": { imports: ["server-only", DB, "../services/ops-alert.service"], models: [], tables: ["crm_return_findings"] },
  "crm.return.store.ts": {
    imports: ["server-only", DB, "../lib/ids", "./crm.config", "./crm.mapping", "./crm.outbox", "./crm.reconcile", "./crm.store", "./crm.worker"],
    models: ["crmPortalState.findUnique", "crmPortalState.updateMany", "crmLink.findFirst", "crmLink.findMany", "crmLink.updateMany", "crmReturnFinding.deleteMany", "crmReturnFinding.updateMany"],
    tables: ["crm_links", "crm_outbox", "crm_return_findings"],
  },
  "crm.return.commands.ts": {
    imports: ["server-only", DB, "../lib/audit", "../lib/errors", "../lib/actor", "../repositories/admin.repo", "../services/inquiry.service", "@/lib/types", "./crm.reconcile"],
    models: ["inquiry.findUnique", "adminUser.findMany", "inquiryEvent.create"],
    tables: [],
  },
};

const FORBIDDEN = /payment|stripe|refund|booking|supplier|order|document|ticket|capabilit|privacy|erasure|auth|session|lib\/crypto|checkout|quote/i;

function code(file: string): string {
  return readFileSync(path.join(ROOT, file), "utf8")
    .replace(/\/\*[^]*?\*\//g, "")
    .replace(/^\s*\/\/.*$/gm, "")
    .replace(/\s\/\/ .*$/gm, "");
}

function specifiers(src: string): string[] {
  const out: string[] = [];
  for (const m of src.matchAll(/^\s*(?:import|export)\s[^;]*?from\s+["']([^"']+)["']/gm)) out.push(m[1]);
  for (const m of src.matchAll(/^\s*import\s+["']([^"']+)["']/gm)) out.push(m[1]);
  for (const m of src.matchAll(/\bimport\(\s*["'`]([^"'`]*)["'`]/g)) out.push(`dynamic:${m[1]}`);
  for (const m of src.matchAll(/\brequire\(\s*["'`]([^"'`]*)["'`]/g)) out.push(`require:${m[1]}`);
  // A dynamic import of a computed path cannot be checked at all.
  for (const m of src.matchAll(/\bimport\(\s*[^"'`\s)]/g)) out.push(`dynamic:${m[0]}`);
  return out;
}

function models(src: string): string[] {
  return [...new Set([...src.matchAll(/\b(?:prisma|tx)\.([a-z]\w*)\.(\w+)/g)].map((m) => `${m[1]}.${m[2]}`))].sort();
}

function sqlTables(src: string): string[] {
  const sql = [...src.matchAll(/\$(?:queryRaw|executeRaw)(?:Unsafe)?\s*(?:<[^`]*?>)?\s*`([^`]*)`/g)].map((m) => m[1]).join("\n");
  // `DO UPDATE SET` and `FOR UPDATE SKIP LOCKED` name no table.
  const keywords = new Set(["set", "skip", "of", "nowait"]);
  return [...new Set([...sql.matchAll(/\b(?:FROM|INTO|UPDATE|JOIN)\s+"?([a-z_]+)"?/gi)].map((m) => m[1]).filter((t) => !keywords.has(t.toLowerCase())))].sort();
}

describe("return path import and data boundary", () => {
  it.each(Object.keys(RULES))("%s: imports only its allowlist, nothing from payments, bookings, tickets, refunds, privacy or access", (file) => {
    const found = specifiers(code(file));
    expect(found.length).toBeGreaterThan(0);
    expect(found.filter((i) => !RULES[file].imports.includes(i))).toEqual([]);
    // The one services import is the inquiry service (the commands module); everything else is CRM or lib.
    expect(found.filter((i) => FORBIDDEN.test(i) && i !== "../services/ops-alert.service")).toEqual([]);
  });

  it.each(Object.keys(RULES))("%s: touches only its allowlisted Prisma models and methods, and names only its tables in raw SQL", (file) => {
    const src = code(file);
    expect(models(src).filter((m) => !RULES[file].models.includes(m))).toEqual([]);
    expect(sqlTables(src).filter((t) => !RULES[file].tables.includes(t))).toEqual([]);
    // No unchecked SQL text and no Prisma escape hatches.
    expect(src).not.toMatch(/\$(?:queryRawUnsafe|executeRawUnsafe)|Prisma\.raw|\$extends|\$use\(/);
  });

  it("the boundary helpers really see what they guard (self-test)", () => {
    expect(specifiers(`export { x } from "../services/payment.service";`)).toEqual(["../services/payment.service"]);
    expect(specifiers(`const m = await import("../payments/stripe");`)).toEqual(["dynamic:../payments/stripe"]);
    expect(specifiers(`const m = require("../orders/x");`)).toEqual(["require:../orders/x"]);
    expect(models(`await prisma.payment.update({}); await tx.order.findMany();`)).toEqual(["order.findMany", "payment.update"]);
    expect(sqlTables("await prisma.$executeRaw`UPDATE payments SET x = 1 FROM orders o`;")).toEqual(["orders", "payments"]);
  });

  it("the commands module calls the inquiry service's transition and assign only, and the admin repository's findById only", () => {
    const src = code("crm.return.commands.ts");
    expect([...new Set([...src.matchAll(/inquiryService\.(\w+)/g)].map((m) => m[1]))].sort()).toEqual(["assign", "transition"]);
    expect([...new Set([...src.matchAll(/(\w+Repo)\.(\w+)/g)].map((m) => `${m[1]}.${m[2]}`))]).toEqual(["adminRepo.findById"]);
    expect(src).not.toMatch(/convertToOrder|markSpam|orderService|paymentService|refundService/);
  });

  it("the reconciler engine reaches OUTLYY only through its injected commands (no service, repository or database import)", () => {
    expect(specifiers(code("crm.reconcile.ts")).filter((i) => /services|repositories|lib\/db|prisma/.test(i))).toEqual([]);
  });
});
