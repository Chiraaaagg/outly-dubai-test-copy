import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { emitEvent, STRUCTURED_EVENTS, structuredFields, type StructuredEventName } from "../structured-events";

/**
 * B5 review fix (b7a8ea0): the recovery and cancellation log lines go through
 * `emitEvent` with allowlisted names and keys (doc 27 §2, "Events").
 *
 *  - every `recovery.*` / `cancellation.*` name the source emits is in
 *    STRUCTURED_EVENTS, with every key it passes, and every listed name is
 *    emitted somewhere (no stale entries);
 *  - a source scan finds no `log.*` call using those names any more;
 *  - the fields those calls pass survive the value allowlist, so the line
 *    `customer-recovery.test.ts` asserts on (`recovery.start_budget_exhausted`)
 *    is still written, at `warn`.
 */

const ROOT = process.cwd();
const FAMILY = /^(recovery|cancellation)\./;

function sources(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const full = path.join(dir, name);
    if (statSync(full).isDirectory()) {
      if (name !== "__tests__" && name !== "node_modules") sources(full, out);
    } else if (/\.(ts|tsx)$/.test(name) && !/\.test\.tsx?$/.test(name)) out.push(full);
  }
  return out;
}

/** The text between the bracket at `open` and its match. */
function balanced(text: string, open: number): string {
  let depth = 0;
  for (let i = open; i < text.length; i++) {
    if (text[i] === "{" || text[i] === "(" || text[i] === "[") depth++;
    else if (text[i] === "}" || text[i] === ")" || text[i] === "]") {
      depth--;
      if (depth === 0) return text.slice(open + 1, i);
    }
  }
  throw new Error("unbalanced");
}

/** Top-level keys of an object literal body (`a: 1, b, c: f(x, y)`). */
function keysOf(body: string): string[] {
  const keys: string[] = [];
  let depth = 0;
  let part = "";
  for (const ch of `${body},`) {
    if ("{([".includes(ch)) depth++;
    if ("})]".includes(ch)) depth--;
    if (ch === "," && depth === 0) {
      const k = part.trim().match(/^([A-Za-z_$][\w$]*)/)?.[1];
      if (k) keys.push(k);
      part = "";
    } else part += ch;
  }
  return keys;
}

interface Call {
  file: string;
  name: string;
  keys: string[];
}

function emitCalls(): Call[] {
  const calls: Call[] = [];
  for (const file of sources(path.join(ROOT, "src"))) {
    const text = readFileSync(file, "utf8");
    const re = /emitEvent\(\s*"([a-z_.]+)"\s*(,\s*)?/g;
    for (let m = re.exec(text); m; m = re.exec(text)) {
      if (!FAMILY.test(m[1])) continue;
      const after = m.index + m[0].length;
      const keys = m[2] && text[after] === "{" ? keysOf(balanced(text, after)) : [];
      calls.push({ file: path.relative(ROOT, file), name: m[1], keys });
    }
  }
  return calls;
}

const LISTED = Object.keys(STRUCTURED_EVENTS).filter((n) => FAMILY.test(n));

describe("recovery and cancellation events are allowlisted (b7a8ea0)", () => {
  const calls = emitCalls();

  it("the scan finds the calls in both services", () => {
    const files = new Set(calls.map((c) => c.file));
    expect(files).toContain("src/server/services/recovery.service.ts");
    expect(files).toContain("src/server/services/cancellation.service.ts");
    expect(calls.length).toBeGreaterThanOrEqual(LISTED.length);
  });

  it("every emitted recovery.* and cancellation.* name is listed, with every key it passes", () => {
    for (const c of calls) {
      const keys = (STRUCTURED_EVENTS as Record<string, readonly string[]>)[c.name];
      expect(keys, `${c.file}: ${c.name}`).toBeDefined();
      expect(c.keys.filter((k) => !keys.includes(k)), `${c.file}: ${c.name}`).toEqual([]);
    }
  });

  it("every listed recovery.* and cancellation.* name is emitted somewhere", () => {
    const emitted = new Set(calls.map((c) => c.name));
    expect(LISTED.filter((n) => !emitted.has(n))).toEqual([]);
    expect(LISTED.length).toBe(17);
  });

  it("no log.* call uses a recovery.* or cancellation.* name any more", () => {
    const offenders: string[] = [];
    for (const file of sources(path.join(ROOT, "src"))) {
      const text = readFileSync(file, "utf8");
      for (const m of text.matchAll(/\blog\.(debug|info|warn|error)\(\s*["'`]((recovery|cancellation)\.[^"'`]*)/g)) offenders.push(`${path.relative(ROOT, file)}: ${m[2]}`);
    }
    expect(offenders).toEqual([]);
  });
});

describe("the values those calls pass survive the value allowlist", () => {
  let lines: { stream: string; entry: Record<string, unknown> }[] = [];
  const UUID = "0192f0aa-1234-7abc-8def-0123456789ab";
  const UUID2 = "0192f0aa-1234-7abc-8def-0123456789ac";

  beforeEach(() => {
    lines = [];
    for (const stream of ["log", "warn", "error"] as const) {
      vi.spyOn(console, stream).mockImplementation((line: unknown) => {
        lines.push({ stream, entry: JSON.parse(String(line)) });
      });
    }
  });

  afterEach(() => vi.restoreAllMocks());

  it("recovery.start_budget_exhausted is written at warn with its scope and store flag", () => {
    emitEvent("recovery.start_budget_exhausted", { scope: "ip", storeUnavailable: false }, "warn");
    expect(lines).toHaveLength(1);
    expect(lines[0].stream).toBe("warn");
    expect(lines[0].entry).toMatchObject({ msg: "recovery.start_budget_exhausted", level: "warn", scope: "ip", storeUnavailable: false });
  });

  it.each<[StructuredEventName, Record<string, unknown>]>([
    ["recovery.started", { challengeId: UUID, channel: "phone" }],
    ["recovery.start_decoy", { channel: "email" }],
    ["recovery.code_delivery", { challengeId: UUID, channel: "phone", outcome: "sent" }],
    ["recovery.verify_refused", { reason: "rate_limited" }],
    ["recovery.verify_daily_cap", { scope: "order", storeUnavailable: true }],
    ["recovery.verified", { challengeId: UUID, grantId: UUID2, channel: "email" }],
    ["cancellation.requested", { requestId: UUID, kind: "supported", via: "customer" }],
    ["cancellation.sent", { requestId: UUID }],
    ["cancellation.engine_refused", { requestId: UUID, reason: "CONFLICT" }],
    ["cancellation.stuck", { requestId: UUID, reason: "cancel_near_deadline" }],
    ["cancellation.refused", { requestId: UUID }],
    ["cancellation.refund_opened", { requestId: UUID, refundId: UUID2 }],
    ["cancellation.refund_refused", { requestId: UUID, reason: "refund_refund_cap" }],
    ["cancellation.refund_failed", { requestId: UUID }],
    ["cancellation.refunded", { requestId: UUID }],
    ["cancellation.advance_failed", { requestId: UUID, reason: "P2034" }],
  ])("%s keeps every field it is given", (name, fields) => {
    expect(structuredFields(name, fields)).toEqual(fields);
  });

  it("an id key never carries a non-UUID (a reference or a contact cannot ride along)", () => {
    expect(structuredFields("cancellation.refund_opened", { requestId: "OUT-10000017", refundId: "+971501234567" })).toEqual({});
  });
});
