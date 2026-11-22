import { afterEach, describe, expect, it, vi } from "vitest";
import { SYSTEM_ACTOR, customerActor, type Actor } from "../../lib/actor";
import { isAppError } from "../../lib/errors";
import type { TravelDeskConfig } from "../../suppliers/traveldesk/traveldesk.config";
import { CATALOGUE_STALE_AFTER_MS, catalogueStale, catalogueSyncedAt } from "../supplier-catalog.service";
import { readinessService } from "../readiness.service";
import { runScheduledCatalogueSync, runTravelDeskCatalogueSync } from "../traveldesk-catalogue-sync.service";

/**
 * Doc 29 Batch 1b without a database: the staleness rule's arithmetic and
 * fallback, the admin entry point refusing the system actor before any
 * TravelDesk call or database write, and the scheduled entry point on a
 * deployment without TravelDesk. The run rows, resume, removal cap and lease
 * are in the DB suite (traveldesk-catalogue-sync.service.test.ts).
 */

const config = { environment: "test", agencyId: null } as unknown as TravelDeskConfig;
const H = 3_600_000;

describe("catalogue staleness (doc 29 Batch 1b)", () => {
  const at = new Date("2026-11-23T03:00:00Z");
  const ago = (ms: number) => new Date(at.getTime() - ms);

  it("is stale only past 48 hours, and when the age is unknown", () => {
    expect(CATALOGUE_STALE_AFTER_MS).toBe(48 * H);
    expect(catalogueStale(ago(47 * H), at)).toBe(false);
    expect(catalogueStale(ago(48 * H), at)).toBe(false);
    expect(catalogueStale(ago(48 * H + 1), at)).toBe(true);
    expect(catalogueStale(null, at)).toBe(true);
  });

  it("reads the offer's own last read, no later than the last complete run (review R2)", () => {
    // A fresh deploy with no run row: the offer the last sync read stays fresh.
    expect(catalogueSyncedAt(null, ago(2 * H))).toEqual(ago(2 * H));
    // A complete run older than the offer's read still caps it, even when an incomplete run saw the offer since: never more permissive.
    expect(catalogueSyncedAt(ago(60 * H), ago(1 * H))).toEqual(ago(60 * H));
    expect(catalogueStale(catalogueSyncedAt(ago(60 * H), ago(1 * H)), at)).toBe(true);
    // A recent complete run does not refresh an offer it did not read (its tour failed, or every tour failed,
    // or a long resumed pass read it early).
    expect(catalogueSyncedAt(ago(1 * H), ago(60 * H))).toEqual(ago(60 * H));
    expect(catalogueStale(catalogueSyncedAt(ago(1 * H), ago(60 * H)), at)).toBe(true);
    expect(catalogueStale(catalogueSyncedAt(ago(1 * H), ago(3 * H)), at)).toBe(false);
    // No offer row: unknown, so stale.
    expect(catalogueSyncedAt(ago(1 * H), null)).toBeNull();
    expect(catalogueSyncedAt(null, null)).toBeNull();
  });
});

describe("catalogue sync entry points (doc 29 Batch 1b)", () => {
  afterEach(() => vi.restoreAllMocks());

  const neverCalled = () => {
    throw new Error("TravelDesk must not be called");
  };

  it.each<[string, Actor]>([
    ["the system actor", SYSTEM_ACTOR],
    ["a customer, even with the permission", { ...customerActor(), permissions: new Set(["suppliers.manage"]) }],
  ])("the admin button refuses %s before the code check, the lease or any TravelDesk call", async (_label, actor) => {
    const stepUp = vi.fn(async () => null);
    await expect(runTravelDeskCatalogueSync(actor, "123456", { config, stepUp, source: neverCalled })).rejects.toSatisfy((e) => isAppError(e) && e.code === "FORBIDDEN");
    expect(stepUp).not.toHaveBeenCalled();
  });

  it("the admin button still needs a code from staff", async () => {
    const staff: Actor = { type: "admin", id: "00000000-0000-7000-8000-000000000001", roles: ["admin"], permissions: new Set(["*"]) };
    await expect(runTravelDeskCatalogueSync(staff, undefined, { config, source: neverCalled })).rejects.toSatisfy((e) => isAppError(e) && e.code === "VALIDATION_FAILED");
  });

  it("the scheduled run skips a deployment without TravelDesk and re-checks readiness for the catalogue's age", async () => {
    const reevaluate = vi.spyOn(readinessService, "reevaluateInstantCandidates").mockResolvedValue();
    await expect(runScheduledCatalogueSync({ config: null, source: neverCalled })).resolves.toEqual({ status: "skipped", reason: "not_configured" });
    expect(reevaluate).toHaveBeenCalledWith("catalogue_age");
  });
});
