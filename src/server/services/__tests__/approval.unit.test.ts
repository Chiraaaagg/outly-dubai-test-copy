import { describe, expect, it } from "vitest";
import { B1_PERMISSIONS } from "../../suppliers/booking-port";
import { canonicalPayload, OPERATION_PERMISSION, privilegedPayloadHash } from "../approval.service";

/** Pure parts of approval.service.ts; the flows run in approval.service.test.ts (db project). */
describe("privileged payload hash", () => {
  it("ignores key order and undefined fields", () => {
    const a = privilegedPayloadHash("supplier.resume", "suppliers.resume", "production", { supplier: "td", account: "default", note: undefined });
    const b = privilegedPayloadHash("supplier.resume", "suppliers.resume", "production", { account: "default", supplier: "td" });
    expect(a).toBe(b);
    expect(a).toMatch(/^[0-9a-f]{64}$/);
  });

  it("differs by operation, permission, environment, value and value type", () => {
    const base = privilegedPayloadHash("supplier.limits.raise", "suppliers.limits.raise", "production", { maxMinor: 5n });
    expect(privilegedPayloadHash("supplier.limits.raise", "suppliers.limits.raise", "test", { maxMinor: 5n })).not.toBe(base);
    expect(privilegedPayloadHash("supplier.limits.raise", "suppliers.limits.raise", "production", { maxMinor: 6n })).not.toBe(base);
    expect(privilegedPayloadHash("supplier.limits.raise", "suppliers.limits.raise", "production", { maxMinor: "5" })).not.toBe(base);
    expect(privilegedPayloadHash("supplier.limits.raise", "suppliers.resume", "production", { maxMinor: 5n })).not.toBe(base);
    expect(privilegedPayloadHash("supplier.resume", "suppliers.limits.raise", "production", { maxMinor: 5n })).not.toBe(base);
  });

  it("sorts nested keys and tags bigint", () => {
    expect(JSON.stringify(canonicalPayload({ b: { y: 1, x: [2n, { d: 1, c: 2 }] }, a: true }))).toBe('{"a":true,"b":{"x":[{"$bigint":"2"},{"c":2,"d":1}],"y":1}}');
  });

  it("refuses functions", () => {
    expect(() => canonicalPayload({ f: () => 1 })).toThrow(TypeError);
  });
});

describe("operation permissions", () => {
  it("every operation needs a B1 permission", () => {
    for (const p of Object.values(OPERATION_PERMISSION)) expect(B1_PERMISSIONS as readonly string[]).toContain(p);
  });
});
