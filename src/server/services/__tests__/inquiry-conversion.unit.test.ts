import { describe, expect, it, vi } from "vitest";

/**
 * PRD-8 e: the manual payment an assisted conversion records keeps the
 * agent's amount in the currency they chose, and a variance reason whenever
 * that is not the order total in the order's currency. Pure: the database
 * module is replaced, so nothing here opens a connection. Synthetic amounts.
 */

vi.mock("../../lib/db", () => ({ prisma: {}, TX_OPTIONS: {} }));

const { manualPaymentFor } = await import("../inquiry.service");

describe("manualPaymentFor (PRD-8 e)", () => {
  it("no amount entered: the order total in the order's currency, no variance", () => {
    expect(manualPaymentFor({ orderCurrency: "AED", expectedMinor: 45_000n })).toEqual({ amountMinor: 45_000n, currency: "AED" });
  });

  it("the order total entered in the order's currency: recorded as is, no variance", () => {
    expect(manualPaymentFor({ orderCurrency: "AED", expectedMinor: 45_000n, entered: { amountMinor: 45_000n, currency: "AED" } })).toEqual({ amountMinor: 45_000n, currency: "AED" });
    expect(manualPaymentFor({ orderCurrency: "INR", expectedMinor: 1_020_000n, entered: { amountMinor: 1_020_000n, currency: "INR" } })).toEqual({ amountMinor: 1_020_000n, currency: "INR" });
  });

  it("an AED amount for an AED order that differs keeps the AED amount and a reason", () => {
    const r = manualPaymentFor({ orderCurrency: "AED", expectedMinor: 45_000n, entered: { amountMinor: 44_000n, currency: "AED" }, varianceReason: "Customer used a voucher" });
    expect(r).toEqual({ amountMinor: 44_000n, currency: "AED", varianceReason: "Customer used a voucher" });
  });

  it("an INR amount for an AED order is recorded in INR, never converted, with a reason", () => {
    const r = manualPaymentFor({ orderCurrency: "AED", expectedMinor: 45_000n, entered: { amountMinor: 1_020_000n, currency: "INR" } });
    expect(r.amountMinor).toBe(1_020_000n);
    expect(r.currency).toBe("INR");
    expect(r.varianceReason).toBe("Agent recorded 1020000 INR (minor) against an order total of 45000 AED (minor)");
  });

  it("the reason falls back to the note, and is capped at 500 characters", () => {
    expect(manualPaymentFor({ orderCurrency: "INR", expectedMinor: 100n, entered: { amountMinor: 90n, currency: "INR" }, note: "  partial link  " }).varianceReason).toBe("partial link");
    expect(manualPaymentFor({ orderCurrency: "INR", expectedMinor: 100n, entered: { amountMinor: 90n, currency: "INR" }, varianceReason: "x".repeat(600) }).varianceReason).toHaveLength(500);
  });
});
