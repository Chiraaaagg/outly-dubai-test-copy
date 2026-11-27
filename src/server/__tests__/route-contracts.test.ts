import { describe, expect, it } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { NON_BROWSER, ROUTES } from "./security/_route-table";

/**
 * Route contracts that need no database (SEC-5, SEC-7). They used to sit
 * inside the DB-gated origin suite, so a run without a database silently
 * skipped them.
 *
 *  1. The H04 table in security/_route-table.ts covers every POST/PUT/PATCH/
 *     DELETE handler under src/app/api, apart from the listed non-browser ones.
 *  2. Every handler under src/app/api/jobs/** calls `requireCron(req)` as its
 *     first statement.
 *  3. Every GET handler under src/app/api/jobs/** is listed below with what it
 *     changes. Vercel Cron calls GET, so a GET job is a mutation route; a new
 *     one fails here until it is reviewed and listed.
 *  4. Every route under the private customer API prefixes (orders, recovery,
 *     tickets; PRIVATE_CUSTOMER_ROUTE_PREFIXES) builds every response it
 *     returns with `private, no-store` and `no-referrer`: through
 *     TICKET_HEADERS from src/app/api/tickets/shared.ts, a headers constant of
 *     a helper module that uses them, or both literal values. The proxy sets
 *     the same headers at the edge (src/proxy.ts); this keeps the handlers
 *     correct on their own, including when called directly.
 */

const API_ROOT = path.resolve(process.cwd(), "src/app/api");

/** Scheduled job GET handlers and the state each one changes. */
const JOB_GETS = new Map([
  ["GET jobs/inquiry-sweep", "SLA breaches, follow-up ladder, auto-lost, notification retries"],
  ["GET jobs/offline-conversions", "Meta offline conversion upload (counts and logs only until the adapter exists)"],
  ["GET jobs/supplier-worker", "recovery, polling and watchdog reads, plus confirms of order-item attempts with verified payment evidence"],
  ["GET jobs/payments-tick", "payment inbox processing and payment saga deadlines, captures, releases and refunds"],
  ["GET jobs/booking-tick", "payments-tick's step, then supplier-worker's scheduled run, in that order (CO-38); each with its own guards"],
  ["GET jobs/supplier-reconcile", "reads TravelDesk bookings and balance; records the reconcile summary"],
  ["GET jobs/documents-tick", "ticket documents: missing-codes sweep, F12 attention, evidenced document reads and PDF downloads into private storage"],
  ["GET jobs/fx-refresh", "fetches the ECB USD/INR rate and, when every guard passes, writes a new pricing.fx_inr_per_aed version"],
  ["GET jobs/crm-worker", "CRM outbox delivery to Bitrix24 deals and its retention purge; skipped unless CRM_SYNC_ENABLED=true (not scheduled in C1)"],
  ["GET jobs/catalogue-sync", "daily read-only TravelDesk catalogue sync (GET calls only): catalogue items, mapping sync status, suggestions, price snapshots, a supplier_sync_runs row, then readiness (doc 29 Batch 1b)"],
  ["GET jobs/traveldesk-upkeep", "daily upkeep of imported TravelDesk listings after a complete sync (no TravelDesk call): listing versions, mapping re-approvals, change rows, the owner digest (doc 30 N3)"],
  ["GET jobs/retention-purge", "deletes expired one-time-code rows, sessions and capability grants, unused expired quotes with their unbound verifications, and guest sessions no quote names (doc 26 §2)"],
]);

interface RouteFile {
  rel: string;
  src: string;
}

function routeFiles(root: string): RouteFile[] {
  const out: RouteFile[] = [];
  const walk = (dir: string) => {
    for (const name of readdirSync(dir)) {
      const full = path.join(dir, name);
      if (statSync(full).isDirectory()) walk(full);
      else if (name === "route.ts") out.push({ rel: path.relative(root, dir).split(path.sep).join("/"), src: readFileSync(full, "utf8") });
    }
  };
  walk(root);
  return out;
}

function exportedMethods(src: string): string[] {
  return [...src.matchAll(/export (?:const|async function) (GET|POST|PUT|PATCH|DELETE)\b/g)].map((m) => m[1]);
}

/** True when the handler exported as `method` starts with `requireCron(req);`. */
function startsWithRequireCron(src: string, method: string): boolean {
  let open: RegExpExecArray | null = null;
  const named = new RegExp(`export const ${method} = handle(?:<[^>]*>)?\\((\\w+)\\)`).exec(src);
  if (named) open = new RegExp(`(?:async\\s+)?function\\s+${named[1]}\\s*\\([^)]*\\)[^{]*\\{`).exec(src);
  else {
    open =
      new RegExp(`export const ${method} = handle(?:<[^>]*>)?\\(async\\s*\\(([^)]*)\\)[^=]*=>\\s*\\{`).exec(src) ??
      new RegExp(`export async function ${method}\\s*\\([^)]*\\)[^{]*\\{`).exec(src);
  }
  if (!open) return false;
  return /^\s*requireCron\(\s*req\s*\)\s*;/.test(src.slice(open.index + open[0].length));
}

function mutationCoverageGaps(root: string): string[] {
  const covered = new Set(ROUTES.map((r) => `${r.method} ${r.file}`));
  const gaps: string[] = [];
  for (const f of routeFiles(root)) {
    for (const m of exportedMethods(f.src)) {
      if (m === "GET") continue;
      const key = `${m} ${f.rel}`;
      if (!covered.has(key) && !NON_BROWSER.has(key)) gaps.push(key);
    }
  }
  return gaps;
}

function jobRouteProblems(root: string, listedGets: Map<string, string>): string[] {
  const jobs = path.join(root, "jobs");
  const problems: string[] = [];
  for (const f of routeFiles(jobs)) {
    const rel = `jobs/${f.rel}`;
    if (!/import\s*\{[^}]*\brequireCron\b[^}]*\}\s*from\s*"@\/server\/lib\/http"/.test(f.src)) problems.push(`${rel}: does not import requireCron`);
    for (const m of exportedMethods(f.src)) {
      if (!startsWithRequireCron(f.src, m)) problems.push(`${m} ${rel}: first statement is not requireCron(req)`);
      if (m === "GET" && !listedGets.has(`GET ${rel}`)) problems.push(`GET ${rel}: unlisted GET job handler`);
    }
  }
  return problems;
}

/** API directories whose every route is a private customer route. */
const PRIVATE_API_DIRS = ["orders", "recovery", "tickets"];
const NO_STORE = "private, no-store";
const NO_REFERRER = "no-referrer";

/** Source with comments removed and string contents kept, so a header value in a comment does not count. */
function stripComments(src: string): string {
  let out = "";
  let i = 0;
  while (i < src.length) {
    const c = src[i];
    const next = src[i + 1];
    if (c === "/" && next === "/") {
      while (i < src.length && src[i] !== "\n") i++;
    } else if (c === "/" && next === "*") {
      i = src.indexOf("*/", i + 2);
      i = i < 0 ? src.length : i + 2;
    } else if (c === '"' || c === "'" || c === "`") {
      const start = i++;
      while (i < src.length && src[i] !== c) i += src[i] === "\\" ? 2 : 1;
      out += src.slice(start, ++i);
    } else {
      out += c;
      i++;
    }
  }
  return out;
}

function hasBothLiterals(code: string): boolean {
  return [NO_STORE, NO_REFERRER].every((v) => code.includes(`"${v}"`) || code.includes(`'${v}'`) || code.includes(`\`${v}\``));
}

interface NamedImport {
  local: string;
  imported: string;
  file: string | null;
}

/** Named imports, with each module resolved to a file under `apiRoot` when it is one. */
function namedImports(code: string, fromFile: string, apiRoot: string): NamedImport[] {
  const out: NamedImport[] = [];
  for (const m of code.matchAll(/import\s*(?:type\s*)?\{([^}]*)\}\s*from\s*["']([^"']+)["']/g)) {
    const spec = m[2];
    let base: string | null = null;
    if (spec.startsWith(".")) base = path.resolve(path.dirname(fromFile), spec);
    else if (spec.startsWith("@/app/api/")) base = path.join(apiRoot, spec.slice("@/app/api/".length));
    const file = base ? [base, `${base}.ts`, path.join(base, "index.ts")].find((f) => /\.ts$/.test(f) && existsSync(f)) ?? null : null;
    for (const part of m[1].split(",")) {
      const [imported, local] = part.trim().replace(/^type\s+/, "").split(/\s+as\s+/);
      if (imported) out.push({ imported, local: local ?? imported, file });
    }
  }
  return out;
}

/**
 * Identifiers in a module that carry both private headers: TICKET_HEADERS
 * imported from tickets/shared.ts (or defined there), a *HEADERS* import from
 * a helper module that is itself a header source, and local constants built
 * from either.
 */
function headerIdentifiers(file: string, apiRoot: string, seen = new Set<string>()): Set<string> {
  const ids = new Set<string>();
  if (seen.has(file)) return ids;
  seen.add(file);
  const code = stripComments(readFileSync(file, "utf8"));
  const shared = path.join(apiRoot, "tickets", "shared.ts");
  if (file === shared && /export const TICKET_HEADERS\b/.test(code) && hasBothLiterals(code)) ids.add("TICKET_HEADERS");
  for (const imp of namedImports(code, file, apiRoot)) {
    if (!imp.file) continue;
    if (imp.file === shared && imp.imported === "TICKET_HEADERS") ids.add(imp.local);
    else if (/HEADERS/.test(imp.imported) && imp.file !== shared) {
      const helper = stripComments(readFileSync(imp.file, "utf8"));
      if (headerIdentifiers(imp.file, apiRoot, seen).has(imp.imported) || (new RegExp(`export const ${imp.imported}\\b`).test(helper) && hasBothLiterals(helper))) ids.add(imp.local);
    }
  }
  // Local constants: `const X = { ...ID, ... }`, `const X = ID`, or an object holding both literals.
  for (let grew = true; grew; ) {
    grew = false;
    for (const m of code.matchAll(/(?:export\s+)?const\s+(\w+)\s*(?::[^=]+)?=\s*/g)) {
      if (ids.has(m[1])) continue;
      const init = code.slice(m.index + m[0].length, code.indexOf(";", m.index + m[0].length));
      const fromId = [...ids].some((id) => new RegExp(`^(?:Object\\.freeze\\()?\\{?\\s*(?:\\.\\.\\.)?${id}\\b`).test(init.trim()));
      if (fromId || (/^(?:Object\.freeze\()?\{/.test(init.trim()) && hasBothLiterals(init))) {
        ids.add(m[1]);
        grew = true;
      }
    }
  }
  return ids;
}

/** The argument text of each direct response construction in `code`. */
function responseCalls(code: string): string[] {
  const calls: string[] = [];
  const re = /(?<![\w.])json\s*\(|(?<![\w.])(?:Next)?Response\.(?:json|redirect)\s*\(|\bnew\s+(?:NextResponse|Response)\s*\(/g;
  for (const m of code.matchAll(re)) {
    let depth = 1;
    let i = m.index + m[0].length;
    const start = i;
    while (i < code.length && depth > 0) {
      if (code[i] === "(") depth++;
      else if (code[i] === ")") depth--;
      i++;
    }
    calls.push(code.slice(start, i - 1));
  }
  return calls;
}

function privateHeaderProblems(apiRoot: string): string[] {
  const problems: string[] = [];
  for (const dir of PRIVATE_API_DIRS) {
    const root = path.join(apiRoot, dir);
    if (!existsSync(root)) continue;
    for (const f of routeFiles(root)) {
      const rel = `${dir}/${f.rel}`;
      const file = path.join(root, f.rel, "route.ts");
      const code = stripComments(f.src);
      const ids = headerIdentifiers(file, apiRoot);
      if (ids.size === 0 && !hasBothLiterals(code)) {
        problems.push(`${rel}: does not use TICKET_HEADERS or set "${NO_STORE}" and "${NO_REFERRER}"`);
        continue;
      }
      problems.push(...unmarkedResponses(rel, code, ids));
    }
    // Helper modules beside the routes build responses too (ticketNotFound).
    for (const file of helperFiles(root)) {
      const ids = headerIdentifiers(file, apiRoot);
      problems.push(...unmarkedResponses(path.relative(apiRoot, file).split(path.sep).join("/"), stripComments(readFileSync(file, "utf8")), ids));
    }
  }
  return problems;
}

function unmarkedResponses(rel: string, code: string, ids: Set<string>): string[] {
  return responseCalls(code)
    .filter((args) => ![...ids].some((id) => new RegExp(`\\b${id}\\b`).test(args)) && !hasBothLiterals(args))
    .map((args) => `${rel}: a response without the private headers: ${args.replace(/\s+/g, " ").slice(0, 80)}`);
}

/** Non-route TypeScript modules under `root` (not tests). */
function helperFiles(root: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(root)) {
    const full = path.join(root, name);
    if (statSync(full).isDirectory()) {
      if (name !== "__tests__") out.push(...helperFiles(full));
    } else if (name.endsWith(".ts") && name !== "route.ts" && !name.endsWith(".test.ts")) out.push(full);
  }
  return out;
}

describe("API route contracts (no database)", () => {
  it("the H04 table covers every browser mutation handler under src/app/api", () => {
    expect(mutationCoverageGaps(API_ROOT)).toEqual([]);
  });

  it("every job route calls requireCron first, and every GET job is listed", () => {
    expect(jobRouteProblems(API_ROOT, JOB_GETS)).toEqual([]);
    // The list holds no stale entries either.
    const present = new Set(routeFiles(path.join(API_ROOT, "jobs")).flatMap((f) => exportedMethods(f.src).map((m) => `${m} jobs/${f.rel}`)));
    expect([...JOB_GETS.keys()].filter((k) => !present.has(k))).toEqual([]);
  });

  it("routes that read payment gateways load the composition root (review 102c D5: the sweep's duplicate alerts)", () => {
    for (const rel of ["jobs/inquiry-sweep", "jobs/payments-tick", "jobs/booking-tick", "checkout"]) {
      const src = readFileSync(path.join(API_ROOT, rel, "route.ts"), "utf8");
      expect(src, rel).toMatch(/^import "@\/server\/wiring";$/m);
    }
  });

  it("every private customer API route answers with private, no-store and no-referrer", () => {
    expect(privateHeaderProblems(API_ROOT)).toEqual([]);
  });

  describe("the checks catch planted routes", () => {
    function planted(files: Record<string, string>) {
      const root = mkdtempSync(path.join(tmpdir(), "outly-routes-"));
      for (const [rel, src] of Object.entries(files)) {
        mkdirSync(path.join(root, path.dirname(rel)), { recursive: true });
        writeFileSync(path.join(root, rel), src);
      }
      return root;
    }
    const guarded = (exp: string) => `import type { NextRequest } from "next/server";
import { handle, json, requireCron } from "@/server/lib/http";
async function run(req: NextRequest) {
  requireCron(req);
  return json({ ok: true });
}
${exp}
`;

    it("an unlisted GET job route", () => {
      const root = planted({ "jobs/new-job/route.ts": guarded("export const GET = handle(run);") });
      try {
        expect(jobRouteProblems(root, JOB_GETS)).toEqual(["GET jobs/new-job: unlisted GET job handler"]);
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    });

    it("a job handler that does not start with requireCron", () => {
      const src = `import type { NextRequest } from "next/server";
import { handle, json, requireCron } from "@/server/lib/http";
async function run(req: NextRequest) {
  await doWork();
  requireCron(req);
  return json({ ok: true });
}
export const POST = handle(run);
`;
      const root = planted({ "jobs/late-auth/route.ts": src, "jobs/inline/route.ts": `import { handle, json } from "@/server/lib/http";\nexport const POST = handle(async (req) => {\n  return json({ ok: true });\n});\n` });
      try {
        expect(jobRouteProblems(root, JOB_GETS).sort()).toEqual([
          "POST jobs/inline: first statement is not requireCron(req)",
          "jobs/inline: does not import requireCron",
          "POST jobs/late-auth: first statement is not requireCron(req)",
        ].sort());
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    });

    const SHARED = `export const TICKET_HEADERS = Object.freeze({ "cache-control": "private, no-store", "referrer-policy": "no-referrer" });\n`;

    it("private API routes: compliant handlers pass", () => {
      const root = planted({
        "tickets/shared.ts": SHARED,
        "tickets/ok/route.ts": `import { json } from "@/server/lib/http";\nimport { TICKET_HEADERS } from "../shared";\nexport const GET = handle(async () => json({}, { headers: { ...TICKET_HEADERS } }));\n`,
        "orders/[reference]/status/route.ts": `import { json } from "@/server/lib/http";\nimport { TICKET_HEADERS as H } from "@/app/api/tickets/shared";\nconst headers = { ...H, vary: "cookie" };\nexport const GET = handle(async (req) => {\n  const body = await req.json();\n  return json(body, { headers });\n});\n`,
        "orders/_shared.ts": `import { TICKET_HEADERS } from "../tickets/shared";\nexport const ORDER_HEADERS = { ...TICKET_HEADERS };\nexport function notFound() { return json({}, { status: 404, headers: ORDER_HEADERS }); }\n`,
        "orders/[reference]/cancellation/route.ts": `import { ORDER_HEADERS, notFound } from "../../_shared";\nexport const POST = handle(async () => { if (x) return notFound(); return json({ status: "requested" }, { status: 202, headers: ORDER_HEADERS }); });\n`,
        "recovery/start/route.ts": `export const POST = handle(async () => json({ challengeId }, { headers: { "cache-control": "private, no-store", "referrer-policy": "no-referrer" } }));\n`,
      });
      try {
        expect(privateHeaderProblems(root)).toEqual([]);
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    });

    it("private API routes: missing headers, a bare error response, and values only in a comment", () => {
      const root = planted({
        "tickets/shared.ts": SHARED,
        "tickets/bare/route.ts": `export const GET = handle(async () => json({}));\n`,
        "orders/[reference]/status/route.ts": `import { TICKET_HEADERS } from "../../../tickets/shared";\nexport const GET = handle(async () => {\n  if (x) return json({ error: 1 }, { status: 404 });\n  return json({}, { headers: TICKET_HEADERS });\n});\n`,
        "recovery/verify/route.ts": `// cache-control: "private, no-store", referrer-policy: "no-referrer"\nexport const POST = handle(async () => new NextResponse("{}"));\n`,
        "recovery/start/route.ts": `import { TICKET_HEADERS } from "./not-the-shared-module";\nexport const POST = handle(async () => json({}, { headers: TICKET_HEADERS }));\n`,
        "recovery/start/not-the-shared-module.ts": `export const TICKET_HEADERS = { "cache-control": "no-store" };\n`,
        "orders/_helpers.ts": `import { TICKET_HEADERS } from "../tickets/shared";\nexport function gone() { return json({ error: { code: "NOT_FOUND" } }, { status: 404 }); }\n`,
      });
      try {
        expect(privateHeaderProblems(root).sort()).toEqual([
          'orders/[reference]/status: a response without the private headers: { error: 1 }, { status: 404 }',
          'orders/_helpers.ts: a response without the private headers: { error: { code: "NOT_FOUND" } }, { status: 404 }',
          'recovery/start: does not use TICKET_HEADERS or set "private, no-store" and "no-referrer"',
          'recovery/verify: does not use TICKET_HEADERS or set "private, no-store" and "no-referrer"',
          'tickets/bare: does not use TICKET_HEADERS or set "private, no-store" and "no-referrer"',
        ].sort());
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    });

    it("an unlisted POST handler outside the H04 table", () => {
      const root = planted({ "admin/new-thing/route.ts": `export const POST = handle(async (req) => json({}));\n` });
      try {
        expect(mutationCoverageGaps(root)).toEqual(["POST admin/new-thing"]);
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    });
  });
});
