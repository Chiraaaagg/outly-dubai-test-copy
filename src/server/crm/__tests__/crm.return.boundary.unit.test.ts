import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";

/**
 * The control that keeps CRM edits away from money and access (doc 29e
 * §3.7, §12; release evidence): the return path modules import nothing from
 * payments, bookings, suppliers, orders, tickets, documents, refunds,
 * privacy or authentication, and the one module that changes OUTLYY state
 * calls the inquiry service's `transition` and `assign` only.
 */

const ROOT = path.join(process.cwd(), "src/server/crm");
const RETURN_MODULES = ["crm.reconcile.ts", "crm.return.config.ts", "crm.return.store.ts", "crm.return.commands.ts", "crm.return.alerts.ts"];
const FORBIDDEN = /payment|stripe|refund|booking|supplier|order\.service|order\.repo|document|ticket|capabilit|privacy|erasure|auth|session|lib\/crypto|checkout|quote/i;

function imports(file: string): string[] {
  const src = readFileSync(path.join(ROOT, file), "utf8");
  return [...src.matchAll(/^\s*import\s[^;]*?from\s+["']([^"']+)["']/gm)].map((m) => m[1]);
}

describe("return path import boundary", () => {
  it.each(RETURN_MODULES)("%s imports nothing from payments, bookings, tickets, refunds, privacy or access code", (file) => {
    const found = imports(file);
    expect(found.length).toBeGreaterThan(0);
    expect(found.filter((i) => FORBIDDEN.test(i))).toEqual([]);
  });

  it("the reconciler engine reaches OUTLYY only through its injected commands (no service, repository or database import)", () => {
    const found = imports("crm.reconcile.ts");
    expect(found.filter((i) => /services|repositories|lib\/db|prisma/.test(i))).toEqual([]);
  });

  it("the commands module calls the inquiry service's transition and assign only", () => {
    // Code only: the doc comment names what is out of reach.
    const src = readFileSync(path.join(ROOT, "crm.return.commands.ts"), "utf8").replace(/\/\*[^]*?\*\//g, "").replace(/\/\/.*$/gm, "");
    const calls = [...src.matchAll(/inquiryService\.(\w+)/g)].map((m) => m[1]);
    expect([...new Set(calls)].sort()).toEqual(["assign", "transition"]);
    expect(src).not.toMatch(/convertToOrder|markSpam|orderService|paymentService|refund/);
    const repos = [...src.matchAll(/(\w+Repo)\.(\w+)/g)].map((m) => `${m[1]}.${m[2]}`);
    expect([...new Set(repos)]).toEqual(["adminRepo.findById"]);
  });
});
