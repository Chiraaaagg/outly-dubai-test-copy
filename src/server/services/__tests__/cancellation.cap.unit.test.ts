import { describe, expect, it, vi } from "vitest";

/**
 * The cancellation step under the booking tick's cap (checkout redesign
 * batch 4, review follow-up 5): once `stop` says so no request is started,
 * and `visited` counts only the requests actually started. The database is a
 * fake with two open requests; nothing is advanced.
 */

vi.mock("../../lib/db", () => ({
  prisma: {
    cancellationRequest: { findMany: async () => [{ id: "r1" }, { id: "r2" }] },
    $queryRaw: async () => [],
  },
  TX_OPTIONS: {},
}));

const { createCancellationService } = await import("../cancellation.service");

describe("cancellations.advanceOpen with a cap", () => {
  it("stopped before the first request: none started, visited 0", async () => {
    const svc = createCancellationService({ requestCancel: async () => {}, driveRefund: async () => "succeeded" } as never);
    expect(await svc.advanceOpen({ max: 50, stop: () => true })).toEqual({ visited: 0, refunded: 0, refused: 0, failed: 0 });
  });
});
