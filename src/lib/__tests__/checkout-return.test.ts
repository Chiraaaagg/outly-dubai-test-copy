import { describe, expect, it } from "vitest";
import { gatewayReturnUrls, readReturnHint, withReturnHint } from "../checkout-return";

/**
 * The Stripe return hint (checkout redesign batch 3, CO-08): success and
 * cancel come back to the same neutral page with a different `result`, and
 * nothing else is added. The hint is read strictly and only for wording.
 */

describe("gatewayReturnUrls", () => {
  it("gives success and cancel distinct URLs on the same page, differing only by the hint", () => {
    const urls = gatewayReturnUrls("https://outlyy.com/booking/confirmation");
    expect(urls).toEqual({
      success: "https://outlyy.com/booking/confirmation?result=success",
      cancel: "https://outlyy.com/booking/confirmation?result=cancel",
    });
    expect(urls.success).not.toBe(urls.cancel);
    for (const u of Object.values(urls)) {
      const parsed = new URL(u);
      expect(parsed.pathname).toBe("/booking/confirmation");
      expect([...parsed.searchParams.keys()]).toEqual(["result"]);
    }
  });

  it("keeps an existing query, replaces a stale hint and accepts a URL object", () => {
    expect(gatewayReturnUrls(new URL("http://localhost:3000/checkout/return?x=1")).cancel).toBe("http://localhost:3000/checkout/return?x=1&result=cancel");
    expect(gatewayReturnUrls("https://outlyy.com/r?result=cancel").success).toBe("https://outlyy.com/r?result=success");
  });

  it("refuses something that is not a URL rather than inventing one", () => {
    expect(() => gatewayReturnUrls("not a url")).toThrow();
  });
});

describe("readReturnHint", () => {
  it.each([
    ["success", "success"],
    ["cancel", "cancel"],
    [" Cancel ", "cancel"],
    ["SUCCESS", "success"],
  ] as const)("%j reads as %s", (raw, hint) => {
    expect(readReturnHint(raw)).toBe(hint);
  });

  it.each([null, undefined, "", "paid", "succeeded", "cancelled", "success;paid=1", ["success"], ["success", "cancel"]])("%j is no hint", (raw) => {
    expect(readReturnHint(raw as never)).toBeNull();
  });
});

describe("withReturnHint", () => {
  it("adds the hint to the status page path, and nothing without one", () => {
    expect(withReturnHint("/booking/OUT-ABC123", "cancel")).toBe("/booking/OUT-ABC123?result=cancel");
    expect(withReturnHint("/booking/OUT-ABC123?x=1", "success")).toBe("/booking/OUT-ABC123?x=1&result=success");
    expect(withReturnHint("/booking/OUT-ABC123", null)).toBe("/booking/OUT-ABC123");
  });
});
