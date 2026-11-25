import { afterEach, describe, expect, it, vi } from "vitest";
import type { Actor } from "../actor";

/**
 * PRV-2: field-name audit. `auditFieldChanges` writes the names of changed
 * fields, ids, keyed hashes, counts and codes, never a value: whatever a
 * caller passes, no name, phone, e-mail, address or free text reaches the
 * immutable `audit_logs` row. The database is replaced by a recording fake.
 */

vi.mock("../db", () => ({ prisma: new Proxy({}, { get: () => { throw new Error("no database in unit tests"); } }), TX_OPTIONS: {} }));

const { auditFieldChanges, changedFields, fieldChangeRecord } = await import("../audit");

const actor: Actor = { type: "customer", id: "0192f0aa-1234-7abc-8def-0123456789ab", roles: [], permissions: new Set(), ipHash: "abc123", userAgent: "vitest" };
const PII = ["Asha Rao", "+971501234567", "971501234567", "asha@example.test", "Palm Hotel, Room 12", "jain", "https://x.example/?t=1"];

function recorder() {
  const rows: Record<string, unknown>[] = [];
  return { rows, tx: { auditLog: { create: async ({ data }: { data: Record<string, unknown> }) => void rows.push(data) } } as never };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("fieldChangeRecord", () => {
  it("keeps field names, ids, keyed hashes, counts and codes", () => {
    const { record, dropped } = fieldChangeRecord({
      fields: ["hotel", "fullName", "hotel", "orders.leadPhone"],
      ids: { orderId: "0192f0aa-1234-7abc-8def-0123456789ab", token: "a1b2c3d4e5f6", deferred: ["0192f0aa-0000-7abc-8def-0123456789ab"] },
      hashes: { contact: "ab".repeat(32) },
      counts: { orders: 2, guests: 0 },
      codes: { status: "partial", obligations: ["future_service", "dispute_window"] },
    });
    expect(dropped).toEqual([]);
    expect(record).toEqual({
      fields: ["fullName", "hotel", "orders.leadPhone"],
      ids: { orderId: "0192f0aa-1234-7abc-8def-0123456789ab", token: "a1b2c3d4e5f6", deferred: ["0192f0aa-0000-7abc-8def-0123456789ab"] },
      hashes: { contact: "ab".repeat(32) },
      counts: { orders: 2, guests: 0 },
      codes: { status: "partial", obligations: ["future_service", "dispute_window"] },
    });
  });

  it("drops every value-shaped entry, wherever it is passed", () => {
    // A one-word value ("jain") has the shape of a field name and cannot be told apart from one: field
    // names are the caller's constants, never request data. Every other shape is refused.
    const shaped = PII.filter((v) => v !== "jain");
    const { record, dropped } = fieldChangeRecord({
      fields: [...shaped, "email"],
      ids: { a: PII[0], b: PII[1], c: PII[2], d: PII[3], e: [PII[4], "0192f0aa-1234-7abc-8def-0123456789ab"], "bad key": "x1" },
      hashes: { h: PII[3], short: "abc", upper: "AB".repeat(32), plain: "deadbeef" },
      counts: { n: -1, f: 1.5, s: "3" as unknown as number, big: Number.MAX_SAFE_INTEGER + 2 },
      codes: { reason: "The guest Asha Rao called from +971501234567", ok: "store_unconfigured" },
    });
    const text = JSON.stringify(record);
    for (const v of shaped) expect(text).not.toContain(v);
    expect(text).not.toMatch(/Asha|971501234567|@|Palm|https?:/);
    expect(record.fields).toEqual(["email"]);
    expect(record.ids).toEqual({ e: ["0192f0aa-1234-7abc-8def-0123456789ab"] });
    expect(record.hashes).toBeUndefined();
    expect(record.counts).toBeUndefined();
    expect(record.codes).toEqual({ ok: "store_unconfigured" });
    expect(dropped).toEqual(expect.arrayContaining(["fields", "ids.a", "ids.b", "ids.c", "ids.d", "ids.e", "ids.?", "hashes.h", "counts.n", "codes.reason"]));
  });
});

describe("changedFields", () => {
  it("names the keys whose values differ; null and undefined are equal", () => {
    expect(changedFields({ fullName: "A", email: null, hotel: "H", dietary: undefined }, { fullName: "B", email: undefined, hotel: "H", dietary: "jain" })).toEqual(["dietary", "fullName"]);
  });
});

describe("auditFieldChanges", () => {
  it("writes the record as `after`, no `before`, and no value of the change", async () => {
    const { rows, tx } = recorder();
    const before = { fullName: "Asha Rao", email: "asha@example.test", hotel: "Palm Hotel, Room 12", dietary: "jain" };
    const after = { fullName: "Asha R", email: "asha@example.test", hotel: null, dietary: "jain" };
    await auditFieldChanges(actor, "customer.profile_updated", { type: "customer", id: actor.id! }, { fields: changedFields(before, after) }, tx);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ actorType: "customer", actorId: actor.id, action: "customer.profile_updated", entityType: "customer", entityId: actor.id, after: { fields: ["fullName", "hotel"] } });
    expect(rows[0].before).toBeUndefined();
    expect(rows[0].reason).toBeUndefined();
    const text = JSON.stringify(rows[0]);
    for (const v of PII) expect(text).not.toContain(v);
    expect(text).not.toContain("Asha");
  });

  it("logs the dropped keys, never their values", async () => {
    const lines: string[] = [];
    vi.spyOn(console, "warn").mockImplementation((l: unknown) => void lines.push(String(l)));
    const { rows } = recorder();
    const { tx } = { tx: { auditLog: { create: async ({ data }: { data: Record<string, unknown> }) => void rows.push(data) } } as never };
    await auditFieldChanges(actor, "privacy.erasure", { type: "privacy_request", id: "0192f0aa-1234-7abc-8def-0123456789ab" }, { fields: ["orders.leadPhone"], ids: { phone: "+971501234567" } }, tx);
    expect(lines.join("\n")).toContain("audit.field_values_dropped");
    expect(lines.join("\n")).not.toContain("971501234567");
    expect(JSON.stringify(rows)).not.toContain("971501234567");
  });

  it("refuses a contact as the entity id", async () => {
    const { rows, tx } = recorder();
    await expect(auditFieldChanges(actor, "privacy.erasure", { type: "phone", id: "+971501234567" }, { fields: [] }, tx)).rejects.toThrow(/identifiers/);
    await expect(auditFieldChanges(actor, "privacy.erasure", { type: "phone", id: "971501234567" }, { fields: [] }, tx)).rejects.toThrow(/identifiers/);
    await expect(auditFieldChanges(actor, "privacy.erasure", { type: "email", id: "asha@example.test" }, { fields: [] }, tx)).rejects.toThrow(/identifiers/);
    expect(rows).toEqual([]);
  });
});
