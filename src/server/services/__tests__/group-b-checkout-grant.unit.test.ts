import { afterEach, describe, expect, it, vi } from "vitest";
import { resetEnvCache } from "../../lib/env";

/**
 * Group B attach rule (b) through a checkout grant (review 103 finding 11,
 * re-review 103b): the checkout-grant release switch applies to the attach
 * as it does to ticket access. The signed access cookie is replaced by a
 * stub that always holds one live checkout grant, so the only thing that can
 * keep the grant out is the switch. No database: the transaction is a fake
 * that records its reads.
 */

vi.mock("../capability.service", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../capability.service")>()),
  accessCookieGrants: () => [{ grantId: "0190f7a2-0000-7000-8000-0000000000a1", checkout: true }],
}));

const { checkoutGrantOrders } = await import("../customer-identity.service");

function fakeTx() {
  const reads: unknown[] = [];
  const tx = {
    guestCapabilityGrant: {
      findMany: async (args: unknown) => {
        reads.push(args);
        return [{ orderId: "0190f7a2-0000-7000-8000-0000000000b1" }];
      },
    },
  } as unknown as Parameters<typeof checkoutGrantOrders>[0];
  return { tx, reads };
}

afterEach(() => {
  vi.unstubAllEnvs();
  resetEnvCache();
});

describe("rule (b) through a checkout grant follows the release switch", () => {
  it("returns [] and reads nothing while checkoutGrantsEnabled() is false", async () => {
    vi.stubEnv("GUEST_DOWNLOAD_GRANT_ENABLED", "false");
    resetEnvCache();
    const { tx, reads } = fakeTx();
    expect(await checkoutGrantOrders(tx, "a-signed-cookie-value", new Date("2031-03-04T10:00:00Z"))).toEqual([]);
    expect(reads).toHaveLength(0);
  });

  it("unset is off too", async () => {
    vi.stubEnv("GUEST_DOWNLOAD_GRANT_ENABLED", "");
    resetEnvCache();
    const { tx, reads } = fakeTx();
    expect(await checkoutGrantOrders(tx, "a-signed-cookie-value", new Date("2031-03-04T10:00:00Z"))).toEqual([]);
    expect(reads).toHaveLength(0);
  });

  it("with the switch on, the cookie's live checkout grant is re-read and its order returned", async () => {
    vi.stubEnv("GUEST_DOWNLOAD_GRANT_ENABLED", "true");
    resetEnvCache();
    const { tx, reads } = fakeTx();
    expect(await checkoutGrantOrders(tx, "a-signed-cookie-value", new Date("2031-03-04T10:00:00Z"))).toEqual(["0190f7a2-0000-7000-8000-0000000000b1"]);
    expect(reads).toHaveLength(1);
  });
});
