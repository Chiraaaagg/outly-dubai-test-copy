import { afterEach, describe, expect, it, vi } from "vitest";
import { resetEnvCache } from "@/server/lib/env";
import {
  CRM_DEFERRED_VERSION,
  CRM_LINK_LOCK_TIMEOUT,
  crmNewLinksAllowed,
  crmOutboxScope,
  dedupeKeyFor,
  enqueueCrmDelete,
  enqueueCrmErasure,
  enqueueCrmSync,
  enqueueCrmSyncForContact,
  enqueueCrmSyncForOrders,
  isLockTimeout,
} from "@/server/crm/crm.outbox";
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
 *  - while the sync is switched off no subject is linked for the first time
 *    (no backfill, decision C2-12): only an already linked subject bumps its
 *    link and takes a row.
 * The SQL itself is exercised on the disposable database (crm.db.test.ts).
 */

type Call = { op: string; sql: string; values: unknown[] };

function fakeTx(opts: { failOn?: RegExp; lockTimeoutOn?: RegExp; linkState?: string | null; order?: { id: string; sourceInquiryId: string | null } | null } = {}) {
  const calls: Call[] = [];
  const raw = (op: string) => async (strings: TemplateStringsArray | string, ...values: unknown[]) => {
    const sql = typeof strings === "string" ? strings : strings.join("?");
    calls.push({ op, sql, values });
    if (opts.failOn && opts.failOn.test(sql)) throw Object.assign(new Error("synthetic failure"), { code: "P2010" });
    // The shape Prisma gives a raw-query failure: P2010 with the Postgres code in `meta`.
    if (opts.lockTimeoutOn && opts.lockTimeoutOn.test(sql)) throw Object.assign(new Error("synthetic lock wait"), { code: "P2010", meta: { code: "55P03" } });
    if (sql.includes("current_setting('lock_timeout')")) return [{ setting: "7s" }];
    if (sql.includes("set_config")) return [{ set_config: values[0] }];
    if (sql.startsWith("\n    SELECT state FROM crm_links") || /^\s*SELECT state FROM crm_links/.test(sql)) return opts.linkState === null ? [] : [{ state: opts.linkState ?? "active" }];
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
    expect(await enqueueCrmSync(tx, [{ type: "inquiry", id: B }, { type: "inquiry", id: A }, { type: "inquiry", id: B }], scope, true)).toBe(2);
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
    await enqueueCrmSyncForOrders(fromInquiry.tx, [B], scope, true);
    const up = fromInquiry.calls.find((c) => c.sql.includes("INSERT INTO crm_links"))!;
    expect(up.values.slice(3, 5)).toEqual(["inquiry", A]);
    expect(up.values[6]).toBe(`inq:${A}`);
    const direct = fakeTx({ order: { id: B, sourceInquiryId: null } });
    await enqueueCrmSyncForOrders(direct.tx, [B], scope, true);
    const up2 = direct.calls.find((c) => c.sql.includes("INSERT INTO crm_links"))!;
    expect(up2.values.slice(3, 5)).toEqual(["order", B]);
  });

  it("a delete never creates a link", async () => {
    const { tx, calls } = fakeTx();
    await enqueueCrmDelete(tx, [{ type: "inquiry", id: A }], "retention", scope);
    expect(calls.some((c) => c.sql.includes("INSERT INTO crm_links"))).toBe(false);
    expect(calls.some((c) => c.sql.includes("UPDATE crm_links"))).toBe(true);
  });

  it("the link statement waits at most the short lock timeout, and the caller's setting is put back (review R12)", async () => {
    const { tx, calls } = fakeTx();
    await enqueueCrmSync(tx, [{ type: "inquiry", id: A }], scope, true);
    const sets = calls.filter((c) => c.sql.includes("set_config"));
    expect(sets.map((c) => c.values[0])).toEqual([CRM_LINK_LOCK_TIMEOUT, "7s"]);
    const sqls = calls.map((c) => c.sql);
    // Short timeout before the link statement, restored before the outer savepoint is released.
    expect(sqls.findIndex((q) => q.includes("set_config"))).toBeLessThan(sqls.findIndex((q) => q.includes("INSERT INTO crm_links")));
    expect(sqls.findLastIndex((q) => q.includes("set_config"))).toBe(sqls.length - 2);
    expect(sqls).toContain("SAVEPOINT crm_outbox_link");
    expect(sqls).toContain("RELEASE SAVEPOINT crm_outbox_link");
  });

  it("a link lock not granted in time falls back to a deferred row: no wait, no throw, no link bump (review R12)", async () => {
    const { tx, calls } = fakeTx({ lockTimeoutOn: /INSERT INTO crm_links/ });
    await expect(enqueueCrmSync(tx, [{ type: "inquiry", id: A }], scope, true)).resolves.toBe(1);
    const sqls = calls.map((c) => c.sql);
    expect(sqls).toContain("ROLLBACK TO SAVEPOINT crm_outbox_link");
    expect(sqls).not.toContain("ROLLBACK TO SAVEPOINT crm_outbox_enqueue");
    expect(sqls.at(-1)).toBe("RELEASE SAVEPOINT crm_outbox_enqueue");
    const row = calls.find((c) => c.sql.includes("INSERT INTO crm_outbox"))!;
    expect(row.sql).toContain("next_attempt_at");
    expect(row.values).toContain(CRM_DEFERRED_VERSION);
    expect(row.values.some((v) => typeof v === "string" && v.startsWith(`sync:inquiry:${A}:deferred-`))).toBe(true);
  });

  it("a deferred delete is written only for a committed, live link", async () => {
    const none = fakeTx({ lockTimeoutOn: /UPDATE crm_links/, linkState: null });
    await expect(enqueueCrmDelete(none.tx, [{ type: "inquiry", id: A }], "erasure", scope)).resolves.toBe(0);
    expect(none.calls.some((c) => c.sql.includes("INSERT INTO crm_outbox"))).toBe(false);
    const tomb = fakeTx({ lockTimeoutOn: /UPDATE crm_links/, linkState: "deleted" });
    await expect(enqueueCrmDelete(tomb.tx, [{ type: "inquiry", id: A }], "erasure", scope)).resolves.toBe(0);
    const live = fakeTx({ lockTimeoutOn: /UPDATE crm_links/, linkState: "active" });
    await expect(enqueueCrmDelete(live.tx, [{ type: "inquiry", id: A }], "erasure", scope)).resolves.toBe(1);
    expect(live.calls.find((c) => c.sql.includes("INSERT INTO crm_outbox"))!.values).toContain("erasure");
  });

  it("only a lock timeout is a deferral; any other failure still rolls back the whole enqueue", async () => {
    expect(isLockTimeout({ code: "55P03" })).toBe(true);
    expect(isLockTimeout({ code: "P2010", meta: { code: "55P03" } })).toBe(true);
    expect(isLockTimeout(new Error("canceling statement due to lock timeout"))).toBe(true);
    expect(isLockTimeout({ code: "P2010", meta: { code: "23505" } })).toBe(false);
    const { tx, calls } = fakeTx({ failOn: /INSERT INTO crm_links/ });
    await expect(enqueueCrmSync(tx, [{ type: "inquiry", id: A }], scope, true)).resolves.toBe(0);
    expect(calls.at(-1)?.sql).toBe("ROLLBACK TO SAVEPOINT crm_outbox_enqueue");
  });

  it("sync off (the portal host set, CRM_SYNC_ENABLED not true): no subject is linked for the first time (no backfill)", async () => {
    vi.stubEnv("CRM_SYNC_ENABLED", "false");
    resetEnvCache();
    expect(crmNewLinksAllowed()).toBe(false);
    const { tx, calls } = fakeTx();
    // The default follows the switch.
    await enqueueCrmSync(tx, [{ type: "inquiry", id: A }], scope);
    expect(calls.some((c) => c.sql.includes("INSERT INTO crm_links"))).toBe(false);
    const bump = calls.find((c) => c.sql.includes("UPDATE crm_links"))!;
    expect(bump.sql).not.toContain("state <> 'deleted'");
    vi.stubEnv("CRM_SYNC_ENABLED", "true");
    resetEnvCache();
    // On, but not fully configured: still no new links (C2A-04).
    expect(crmNewLinksAllowed()).toBe(false);
  });

  it("new links only while the sync is on AND the whole configuration validates (C2A-04)", async () => {
    const { fakeEnv } = await import("./_memory-store");
    const stub = (over: Record<string, string | undefined>) => {
      for (const [k, v] of Object.entries({ ...fakeEnv(), ...over })) vi.stubEnv(k, v === undefined ? "" : String(v));
      resetEnvCache();
    };
    stub({ CRM_SYNC_ENABLED: "true" });
    expect(crmNewLinksAllowed()).toBe(true);
    stub({ CRM_SYNC_ENABLED: "true", CRM_BITRIX_FIELD_CODES: "reference=UF_CRM_REFERENCE" });
    expect(crmNewLinksAllowed()).toBe(false);
    stub({ CRM_SYNC_ENABLED: "false" });
    expect(crmNewLinksAllowed()).toBe(false);
  });

  it("the boot check names what would block switch-on while the sync is still off (C2A-04)", async () => {
    const { fakeEnv } = await import("./_memory-store");
    const { assertBootEnv } = await import("@/server/lib/env");
    for (const [k, v] of Object.entries({ ...fakeEnv(), CRM_SYNC_ENABLED: "false", CRM_BITRIX_DEFAULT_OWNER_ID: "" })) vi.stubEnv(k, v === undefined ? "" : String(v));
    resetEnvCache();
    expect(assertBootEnv().filter((p) => p.startsWith("CRM not ready for switch-on"))).toEqual(["CRM not ready for switch-on: CRM_BITRIX_DEFAULT_OWNER_ID is missing"]);
  });

  it("sync off: an unlinked subject takes no row; an already linked one is bumped and queued", async () => {
    const none: ReturnType<typeof fakeTx> = fakeTx();
    // The UPDATE finds no link: the stand-in answers an empty RETURNING for it.
    const noneTx = none.tx as unknown as { $queryRaw: (s: TemplateStringsArray, ...v: unknown[]) => Promise<unknown> };
    const orig = noneTx.$queryRaw;
    noneTx.$queryRaw = async (strings, ...values) => (strings.join("?").includes("UPDATE crm_links") ? (none.calls.push({ op: "$queryRaw", sql: strings.join("?"), values }), []) : orig(strings, ...values));
    await expect(enqueueCrmSync(none.tx, [{ type: "inquiry", id: A }], scope, false)).resolves.toBe(0);
    expect(none.calls.some((c) => c.sql.includes("INSERT INTO crm_outbox"))).toBe(false);
    const linked = fakeTx();
    await expect(enqueueCrmSync(linked.tx, [{ type: "inquiry", id: A }], scope, false)).resolves.toBe(1);
    expect(linked.calls.some((c) => c.sql.includes("INSERT INTO crm_outbox"))).toBe(true);
  });

  it("sync off and the link lock busy: no deferred row for a subject without a link", async () => {
    const none = fakeTx({ lockTimeoutOn: /UPDATE crm_links/, linkState: null });
    await expect(enqueueCrmSync(none.tx, [{ type: "inquiry", id: A }], scope, false)).resolves.toBe(0);
    expect(none.calls.some((c) => c.sql.includes("INSERT INTO crm_outbox"))).toBe(false);
    const live = fakeTx({ lockTimeoutOn: /UPDATE crm_links/, linkState: "active" });
    await expect(enqueueCrmSync(live.tx, [{ type: "inquiry", id: A }], scope, false)).resolves.toBe(1);
  });

  it("erasure deletes are queued for linked subjects whether or not the sync is on", async () => {
    vi.stubEnv("CRM_SYNC_ENABLED", "false");
    resetEnvCache();
    const { tx, calls } = fakeTx();
    await expect(enqueueCrmErasure(tx, { inquiryIds: [A], orderIds: [] }, scope)).resolves.toBe(1);
    expect(calls.find((c) => c.sql.includes("INSERT INTO crm_outbox"))!.values).toContain("erasure");
  });

  it("a marketing consent change re-pushes the contact's linked deals, never links a new one (C2A-02)", async () => {
    const { tx, calls } = fakeTx();
    const t = tx as unknown as { $queryRaw: (s: TemplateStringsArray, ...v: unknown[]) => Promise<unknown> };
    const orig = t.$queryRaw;
    t.$queryRaw = async (strings, ...values) => {
      const sql = strings.join("?");
      if (sql.includes("FROM crm_links l")) {
        calls.push({ op: "$queryRaw", sql, values });
        return [
          { entity_type: "order", entity_id: B },
          { entity_type: "inquiry", entity_id: A },
        ];
      }
      return orig(strings, ...values);
    };
    const phone = ["+971", "4", "0001234"].join("");
    await expect(enqueueCrmSyncForContact(tx, { phoneE164: phone }, scope)).resolves.toBe(2);
    const lookup = calls.find((c) => c.sql.includes("FROM crm_links l"))!;
    expect(lookup.values).toContain(phone);
    expect(lookup.sql).toContain("state <> 'deleted'");
    expect(calls.some((c) => c.sql.includes("INSERT INTO crm_links"))).toBe(false);
    expect(calls.filter((c) => c.sql.includes("INSERT INTO crm_outbox"))).toHaveLength(2);
  });

  it("a consent change with no portal, or with neither phone nor email, writes nothing", async () => {
    const { tx, calls } = fakeTx();
    expect(await enqueueCrmSyncForContact(tx, { phoneE164: "+97140001234" }, null)).toBe(0);
    expect(await enqueueCrmSyncForContact(tx, { phoneE164: " ", email: null }, scope)).toBe(0);
    expect(calls).toEqual([]);
  });

  it("dedupe keys name the kind, subject, version and scope", () => {
    expect(dedupeKeyFor("sync", { type: "order", id: A }, 3n, scope)).toBe(`sync:order:${A}:3@staging/outlyy-fake.bitrix24.test`);
  });
});
