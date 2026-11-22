import { afterEach, describe, expect, it, vi } from "vitest";
import { resetEnvCache } from "@/server/lib/env";
import { crmOutboxScope, dedupeKeyFor, enqueueCrmDelete, enqueueCrmErasure, enqueueCrmSync, enqueueCrmSyncForOrders } from "@/server/crm/crm.outbox";
import type { CrmScope } from "@/server/crm/crm.config";

/**
 * The domain-transaction enqueue (doc 29 §6.4) without a database: a
 * recording stand-in for the transaction client. What it proves:
 *  - with no portal configured (every environment after C1) nothing at all
 *    is sent to the database;
 *  - with a scope, the writes run under a savepoint, in a fixed subject
 *    order, and a failure rolls back to the savepoint and is swallowed, so
 *    the domain transaction (an inquiry, a payment move, a refund) never
 *    fails because of the CRM.
 * The SQL itself is exercised on the disposable database (crm.db.test.ts).
 */

type Call = { op: string; sql: string; values: unknown[] };

function fakeTx(opts: { failOn?: RegExp; order?: { id: string; sourceInquiryId: string | null } | null } = {}) {
  const calls: Call[] = [];
  const raw = (op: string) => async (strings: TemplateStringsArray | string, ...values: unknown[]) => {
    const sql = typeof strings === "string" ? strings : strings.join("?");
    calls.push({ op, sql, values });
    if (opts.failOn && opts.failOn.test(sql)) throw Object.assign(new Error("synthetic failure"), { code: "P2010" });
    if (op === "$queryRaw") return [{ local_version: BigInt(calls.length), state: "pending" }];
    return 1;
  };
  const tx = {
    $queryRaw: raw("$queryRaw"),
    $executeRaw: raw("$executeRaw"),
    $executeRawUnsafe: raw("$executeRawUnsafe"),
    order: { findUnique: async () => (opts.order === undefined ? { id: "o", sourceInquiryId: null } : opts.order) },
  };
  return { tx: tx as never, calls };
}

const scope: CrmScope = { environment: "staging", portal: "outlyy-fake.bitrix24.test" };
const A = "00000000-0000-7000-8000-00000000000a";
const B = "00000000-0000-7000-8000-00000000000b";

afterEach(() => {
  vi.unstubAllEnvs();
  resetEnvCache();
});

describe("CRM outbox enqueue", () => {
  it("writes nothing at all while no CRM portal is configured", async () => {
    vi.stubEnv("CRM_BITRIX_PORTAL_HOST", "");
    resetEnvCache();
    expect(crmOutboxScope()).toBeNull();
    const { tx, calls } = fakeTx();
    expect(await enqueueCrmSync(tx, [{ type: "inquiry", id: A }])).toBe(0);
    expect(await enqueueCrmSyncForOrders(tx, [A])).toBe(0);
    expect(await enqueueCrmDelete(tx, [{ type: "inquiry", id: A }], "erasure")).toBe(0);
    expect(await enqueueCrmErasure(tx, { inquiryIds: [A], orderIds: [B] })).toBe(0);
    expect(calls).toEqual([]);
  });

  it("the scope comes from the environment's pinned portal, whether or not delivery is on", () => {
    vi.stubEnv("APP_ENV", "staging");
    vi.stubEnv("CRM_BITRIX_ENV", "test");
    vi.stubEnv("CRM_BITRIX_PORTAL_HOST", "outlyy-fake.bitrix24.test");
    vi.stubEnv("CRM_SYNC_ENABLED", "false");
    resetEnvCache();
    expect(crmOutboxScope()).toEqual(scope);
  });

  it("bumps the link version and writes one row per subject, under a savepoint, in a fixed order", async () => {
    const { tx, calls } = fakeTx();
    expect(await enqueueCrmSync(tx, [{ type: "inquiry", id: B }, { type: "inquiry", id: A }, { type: "inquiry", id: B }], scope)).toBe(2);
    expect(calls[0]).toMatchObject({ op: "$executeRawUnsafe", sql: "SAVEPOINT crm_outbox_enqueue" });
    expect(calls.at(-1)).toMatchObject({ op: "$executeRawUnsafe", sql: "RELEASE SAVEPOINT crm_outbox_enqueue" });
    const upserts = calls.filter((c) => c.sql.includes("INSERT INTO crm_links"));
    expect(upserts.map((c) => c.values[4])).toEqual([A, B]);
    const rows = calls.filter((c) => c.sql.includes("INSERT INTO crm_outbox"));
    expect(rows).toHaveLength(2);
    // No payload column: ids, kind, version and the dedupe key only.
    expect(rows[0].sql).not.toMatch(/payload\s*[,)]/);
  });

  it("a failing write rolls back to the savepoint and never throws into the domain transaction", async () => {
    const { tx, calls } = fakeTx({ failOn: /INSERT INTO crm_outbox/ });
    await expect(enqueueCrmSync(tx, [{ type: "inquiry", id: A }], scope)).resolves.toBe(0);
    expect(calls.at(-1)).toMatchObject({ sql: "ROLLBACK TO SAVEPOINT crm_outbox_enqueue" });
  });

  it("an order from an inquiry is pushed on the inquiry's deal; a direct order on its own", async () => {
    const fromInquiry = fakeTx({ order: { id: B, sourceInquiryId: A } });
    await enqueueCrmSyncForOrders(fromInquiry.tx, [B], scope);
    const up = fromInquiry.calls.find((c) => c.sql.includes("INSERT INTO crm_links"))!;
    expect(up.values.slice(3, 5)).toEqual(["inquiry", A]);
    expect(up.values[6]).toBe(`inq:${A}`);
    const direct = fakeTx({ order: { id: B, sourceInquiryId: null } });
    await enqueueCrmSyncForOrders(direct.tx, [B], scope);
    const up2 = direct.calls.find((c) => c.sql.includes("INSERT INTO crm_links"))!;
    expect(up2.values.slice(3, 5)).toEqual(["order", B]);
  });

  it("a delete never creates a link", async () => {
    const { tx, calls } = fakeTx();
    await enqueueCrmDelete(tx, [{ type: "inquiry", id: A }], "retention", scope);
    expect(calls.some((c) => c.sql.includes("INSERT INTO crm_links"))).toBe(false);
    expect(calls.some((c) => c.sql.includes("UPDATE crm_links"))).toBe(true);
  });

  it("dedupe keys name the kind, subject, version and scope", () => {
    expect(dedupeKeyFor("sync", { type: "order", id: A }, 3n, scope)).toBe(`sync:order:${A}:3@staging/outlyy-fake.bitrix24.test`);
  });
});
