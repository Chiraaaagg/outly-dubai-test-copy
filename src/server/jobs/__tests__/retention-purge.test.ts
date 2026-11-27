import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The retention purge's loop and statements without a database (doc 26 §2,
 * Batch 1c): batches stop at a short batch, at the batch cap or at the run
 * budget; one failing table does not stop the others; cutoffs come from the
 * run's start; the log line carries counts and codes only; and each Postgres
 * statement is bounded, skips locked rows and matches only rows past their
 * window (live rows are covered on the database in retention-purge.db.test.ts).
 */

const executeRaw = vi.hoisted(() => vi.fn());
vi.mock("../../lib/db", () => ({ prisma: { $executeRaw: executeRaw } }));
const emitted = vi.hoisted(() => [] as { name: string; fields: Record<string, unknown>; level?: string }[]);
vi.mock("../../lib/structured-events", () => ({
  emitEvent: (name: string, fields: Record<string, unknown>, level?: string) => emitted.push({ name, fields, level }),
}));

import { PURGE_CLASSES, RETENTION_WINDOWS, prismaPurgeStore, purgeCutoff, runRetentionPurge, type PurgeClass, type PurgeStore } from "../retention-purge";

const DAY = 24 * 3600_000;
const T0 = new Date("2030-06-01T02:45:00.000Z");

/** A store whose tables hold `rows[cls]` purge-due rows; records every call. */
function fakeStore(rows: Partial<Record<PurgeClass, number>>, fail: Partial<Record<PurgeClass, unknown>> = {}) {
  const left = { ...rows };
  const calls: { cls: PurgeClass; cutoff: Date; limit: number }[] = [];
  const store: PurgeStore = {
    async purgeBatch(cls, cutoff, limit) {
      calls.push({ cls, cutoff, limit });
      if (fail[cls]) throw fail[cls];
      const n = Math.min(limit, left[cls] ?? 0);
      left[cls] = (left[cls] ?? 0) - n;
      return n;
    },
  };
  return { store, calls, left };
}

beforeEach(() => {
  emitted.length = 0;
  executeRaw.mockReset();
});
afterEach(() => vi.restoreAllMocks());

describe("purgeCutoff", () => {
  it("keeps each table for its own window after expiry", () => {
    expect(purgeCutoff("otp_challenges", T0).getTime()).toBe(T0.getTime() - RETENTION_WINDOWS.otpAbuseWindowMs);
    expect(purgeCutoff("customer_sessions", T0).getTime()).toBe(T0.getTime() - RETENTION_WINDOWS.sessionGraceMs);
    expect(purgeCutoff("admin_sessions", T0).getTime()).toBe(T0.getTime() - RETENTION_WINDOWS.sessionGraceMs);
    expect(purgeCutoff("guest_sessions", T0).getTime()).toBe(T0.getTime() - RETENTION_WINDOWS.sessionGraceMs);
    expect(purgeCutoff("guest_capability_grants", T0).getTime()).toBe(T0.getTime() - RETENTION_WINDOWS.grantAuditWindowMs);
    expect(purgeCutoff("quotes", T0).getTime()).toBe(T0.getTime() - RETENTION_WINDOWS.quoteWindowMs);
    expect(purgeCutoff("unbound_contact_verifications", T0).getTime()).toBe(T0.getTime() - RETENTION_WINDOWS.quoteWindowMs);
  });

  it("never reaches a row that is still inside its validity: every window is at least a day", () => {
    for (const ms of Object.values(RETENTION_WINDOWS)) expect(ms).toBeGreaterThanOrEqual(DAY);
    // A checkout grant lives at most 24 h after its verification; the audit window must outlast that by far.
    expect(RETENTION_WINDOWS.grantAuditWindowMs).toBeGreaterThan(2 * DAY);
  });
});

describe("runRetentionPurge", () => {
  it("purges every table in foreign-key order, in batches until a short batch", async () => {
    const { store, calls, left } = fakeStore({ otp_challenges: 25, quotes: 10, guest_sessions: 3 });
    const out = await runRetentionPurge({ store, now: () => T0, batchSize: 10, maxBatches: 50 });
    expect(out.ok).toBe(true);
    expect(out.outOfTime).toBe(false);
    expect(out.classes.otp_challenges).toEqual({ deleted: 25, batches: 3, complete: true, failed: null });
    // Exactly a full batch: one more (empty) batch proves nothing is left.
    expect(out.classes.quotes).toEqual({ deleted: 10, batches: 2, complete: true, failed: null });
    expect(out.classes.guest_sessions).toEqual({ deleted: 3, batches: 1, complete: true, failed: null });
    expect(Object.values(left).every((n) => n === 0)).toBe(true);
    const order = [...new Set(calls.map((c) => c.cls))];
    expect(order).toEqual([...PURGE_CLASSES]);
    expect(order.indexOf("unbound_contact_verifications")).toBeLessThan(order.indexOf("quotes"));
    expect(order.indexOf("quotes")).toBeLessThan(order.indexOf("guest_sessions"));
    for (const c of calls) {
      expect(c.limit).toBe(10);
      expect(c.cutoff.getTime()).toBe(purgeCutoff(c.cls, T0).getTime());
    }
  });

  it("is idempotent: a second run over the same tables deletes nothing", async () => {
    const f = fakeStore({ customer_sessions: 7, guest_capability_grants: 4 });
    await runRetentionPurge({ store: f.store, now: () => T0, batchSize: 5 });
    const again = await runRetentionPurge({ store: f.store, now: () => T0, batchSize: 5 });
    for (const cls of PURGE_CLASSES) expect(again.classes[cls].deleted, cls).toBe(0);
  });

  it("stops a table at the batch cap and reports it incomplete", async () => {
    const { store } = fakeStore({ admin_sessions: 1_000 });
    const out = await runRetentionPurge({ store, now: () => T0, batchSize: 10, maxBatches: 3 });
    expect(out.classes.admin_sessions).toEqual({ deleted: 30, batches: 3, complete: false, failed: null });
    const line = emitted.find((e) => e.name === "retention.purged")!;
    expect(line.fields).toMatchObject({ adminSessions: 30, incomplete: 1, failed: 0, outOfTime: false });
  });

  it("starts no batch once the run budget is spent, and keeps the cutoff from the start", async () => {
    let t = T0.getTime();
    const now = () => new Date((t += 1_000));
    const { store, calls } = fakeStore({ otp_challenges: 1_000 });
    const out = await runRetentionPurge({ store, now, batchSize: 1, maxBatches: 1_000, budgetMs: 5_500 });
    expect(out.outOfTime).toBe(true);
    expect(out.ok).toBe(true);
    expect(calls.length).toBeLessThanOrEqual(5);
    const start = T0.getTime() + 1_000;
    for (const c of calls) expect(c.cutoff.getTime()).toBe(purgeCutoff(c.cls, new Date(start)).getTime());
  });

  it("a failing table is reported with its code only and the others still run", async () => {
    const secret = "row content that must not reach a log";
    const { store, calls } = fakeStore({ otp_challenges: 2, guest_sessions: 2 }, { quotes: Object.assign(new Error(secret), { code: "P2003" }) });
    const out = await runRetentionPurge({ store, now: () => T0 });
    expect(out.ok).toBe(false);
    expect(out.classes.quotes.failed).toBe("P2003");
    expect(out.classes.guest_sessions.deleted).toBe(2);
    expect(calls.some((c) => c.cls === "guest_sessions")).toBe(true);
    const failed = emitted.find((e) => e.name === "retention.purge_failed")!;
    expect(failed).toEqual({ name: "retention.purge_failed", fields: { table: "quotes", reason: "P2003", batches: 0 }, level: "error" });
    expect(JSON.stringify(emitted)).not.toContain(secret);
  });

  it("an error without a safe code is reported as `error`", async () => {
    const { store } = fakeStore({}, { otp_challenges: { code: "has spaces and text" } });
    const out = await runRetentionPurge({ store, now: () => T0 });
    expect(out.classes.otp_challenges.failed).toBe("error");
  });

  it("logs one summary line of counts and durations only", async () => {
    const { store } = fakeStore({ otp_challenges: 1, customer_sessions: 2, admin_sessions: 3, guest_capability_grants: 4, unbound_contact_verifications: 5, quotes: 6, guest_sessions: 7 });
    await runRetentionPurge({ store, now: () => T0 });
    const lines = emitted.filter((e) => e.name === "retention.purged");
    expect(lines).toHaveLength(1);
    expect(lines[0].fields).toEqual({
      otpChallenges: 1,
      customerSessions: 2,
      adminSessions: 3,
      grants: 4,
      contactVerifications: 5,
      quotes: 6,
      guestSessions: 7,
      failed: 0,
      incomplete: 0,
      outOfTime: false,
      durationMs: 0,
    });
    for (const v of Object.values(lines[0].fields)) expect(["number", "boolean"]).toContain(typeof v);
  });
});

describe("prismaPurgeStore statements", () => {
  async function sqlFor(cls: PurgeClass): Promise<{ sql: string; values: unknown[] }> {
    executeRaw.mockReset();
    executeRaw.mockResolvedValue(0);
    const cutoff = new Date("2030-01-01T00:00:00.000Z");
    await prismaPurgeStore.purgeBatch(cls, cutoff, 123);
    const [strings, ...values] = executeRaw.mock.calls[0] as [TemplateStringsArray, ...unknown[]];
    return { sql: strings.join("?").replace(/\s+/g, " "), values };
  }

  it.each([...PURGE_CLASSES])("%s: one bounded delete that skips locked rows and binds the cutoff and limit", async (cls) => {
    const { sql, values } = await sqlFor(cls);
    expect(sql).toMatch(/^ DELETE FROM "\w+" WHERE "id" IN \( SELECT /);
    expect(sql).toMatch(/LIMIT \? FOR UPDATE (OF \w+ )?SKIP LOCKED\)$/);
    expect(values).toContain(123);
    expect(values.some((v) => v instanceof Date)).toBe(true);
    // Values are bound, never spliced into the text.
    expect(sql).not.toContain("2030");
  });

  it("matches only rows past their own expiry (sessions, codes) by `expires_at < cutoff`", async () => {
    for (const cls of ["otp_challenges", "customer_sessions", "admin_sessions"] as const) {
      const { sql } = await sqlFor(cls);
      expect(sql, cls).toContain(`DELETE FROM "${cls}"`);
      expect(sql, cls).toMatch(/WHERE "expires_at" < \? LIMIT/);
    }
  });

  it("deletes a checkout grant on expiry only, never on revocation alone", async () => {
    const { sql } = await sqlFor("guest_capability_grants");
    expect(sql).toContain(`WHERE "expires_at" < ? OR ("revoked_at" < ? AND "issued_for" <> 'checkout')`);
  });

  it("keeps any quote an order, payment or verification names, and any unbound verification of a used quote", async () => {
    const q = (await sqlFor("quotes")).sql;
    expect(q).toContain(`q."used_by_order_id" IS NULL`);
    for (const t of ["order_items", "payments", "order_contact_verifications"]) expect(q).toContain(`NOT EXISTS (SELECT 1 FROM "${t}"`);
    const v = (await sqlFor("unbound_contact_verifications")).sql;
    expect(v).toContain(`v."order_id" IS NULL`);
    expect(v).toContain(`q."used_by_order_id" IS NULL`);
    for (const t of ["order_items", "payments"]) expect(v).toContain(`NOT EXISTS (SELECT 1 FROM "${t}"`);
  });

  it("keeps a guest session any quote still names", async () => {
    const { sql } = await sqlFor("guest_sessions");
    expect(sql).toContain(`gs."expires_at" < ?`);
    expect(sql).toContain(`NOT EXISTS (SELECT 1 FROM "quotes" q WHERE q."guest_session_id" = gs."id")`);
  });
});
