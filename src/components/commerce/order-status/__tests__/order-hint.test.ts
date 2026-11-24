import { describe, expect, it } from "vitest";
import { ORDER_HINT_KEY, clearLegacyOrderData, clearOrderHints, cleanReference, pickReference, readOrderHint, writeOrderHint } from "../order-hint";

/**
 * The gateway-return hint holds the order reference only (PRV-4) and is
 * never evidence of anything. Synthetic references; a Map stands in for
 * sessionStorage.
 */

function memory() {
  const m = new Map<string, string>();
  return {
    m,
    getItem: (k: string) => m.get(k) ?? null,
    setItem: (k: string, v: string) => void m.set(k, v),
    removeItem: (k: string) => void m.delete(k),
  };
}

describe("order hint", () => {
  it("stores only a normalised, well-formed reference", () => {
    const s = memory();
    writeOrderHint(" out-123455 ", s);
    expect([...s.m.entries()]).toEqual([[ORDER_HINT_KEY, "OUT-123455"]]);
    expect(readOrderHint(s)).toBe("OUT-123455");
  });

  it("refuses a malformed or wrong-check-digit reference", () => {
    const s = memory();
    writeOrderHint("OUT-123456", s);
    writeOrderHint("INQ-123455", s);
    expect(s.m.size).toBe(0);
    s.m.set(ORDER_HINT_KEY, "<script>");
    expect(readOrderHint(s)).toBeNull();
  });

  it("clears the hint and the legacy traveller snapshot", () => {
    const s = memory();
    s.m.set(ORDER_HINT_KEY, "OUT-123455");
    s.m.set("outlyy.lastOrder", JSON.stringify({ traveller: { fullName: "Synthetic Person" } }));
    clearLegacyOrderData(s);
    expect([...s.m.keys()]).toEqual([ORDER_HINT_KEY]);
    clearOrderHints(s);
    expect(s.m.size).toBe(0);
  });

  it("survives a storage that throws", () => {
    const broken = {
      getItem: () => {
        throw new Error("blocked");
      },
      setItem: () => {
        throw new Error("blocked");
      },
      removeItem: () => {
        throw new Error("blocked");
      },
    };
    expect(() => writeOrderHint("OUT-123455", broken)).not.toThrow();
    expect(readOrderHint(broken)).toBeNull();
    expect(() => clearOrderHints(broken)).not.toThrow();
    expect(readOrderHint(null)).toBeNull();
  });

  it("prefers a valid ?ref= and falls back to the hint", () => {
    expect(pickReference("OUT-482919", "OUT-123455")).toBe("OUT-482919");
    expect(pickReference("OUT-482910", "OUT-123455")).toBe("OUT-123455");
    expect(pickReference(null, null)).toBeNull();
    expect(cleanReference("")).toBeNull();
  });
});
