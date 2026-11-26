import { describe, expect, it } from "vitest";
import { bookingControlKeyFor } from "../booking-port";
import { bookingAccountId, DEFAULT_BOOKING_ACCOUNT_ID, pinnedControlAccount } from "../control-account";

/**
 * Doc 29 §7.3, defect D2: the admin controls panel must show the control row
 * the write action changes. Both resolve the account with
 * `pinnedControlAccount`; this proves the choice, without a database.
 */
describe("which control row an environment uses (D2)", () => {
  const production = { environment: "production" as const, agencyId: "4242" };

  it("a production deployment with a pinned agency uses that agency's row, never the default one", () => {
    expect(pinnedControlAccount("production", production)).toBe("4242");
    expect(bookingControlKeyFor("traveldesk", "production", pinnedControlAccount("production", production)!)).toBe(bookingControlKeyFor("traveldesk", "production", "4242"));
    expect(bookingControlKeyFor("traveldesk", "production", pinnedControlAccount("production", production)!)).not.toBe(bookingControlKeyFor("traveldesk", "production", DEFAULT_BOOKING_ACCOUNT_ID));
  });

  it("the pin belongs to the key's own environment only", () => {
    // A production key's agency is not the sandbox's: test uses its default row.
    expect(pinnedControlAccount("test", production)).toBe(DEFAULT_BOOKING_ACCOUNT_ID);
    expect(pinnedControlAccount("test", { environment: "test", agencyId: "77" })).toBe("77");
    expect(pinnedControlAccount("production", { environment: "test", agencyId: "77" })).toBeNull();
  });

  it("production with no pin has no row (shown paused, writes refused); test falls back to default", () => {
    expect(pinnedControlAccount("production", null)).toBeNull();
    expect(pinnedControlAccount("production", { environment: "production", agencyId: null })).toBeNull();
    expect(pinnedControlAccount("test", null)).toBe(DEFAULT_BOOKING_ACCOUNT_ID);
  });

  it("matches what the worker and intake use for the deployment's own environment", () => {
    expect(pinnedControlAccount("production", production)).toBe(bookingAccountId("production", "4242"));
    expect(pinnedControlAccount("test", { environment: "test", agencyId: null })).toBe(bookingAccountId("test", null));
  });
});
