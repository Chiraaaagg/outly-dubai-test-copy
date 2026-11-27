import { NextRequest } from "next/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resetEnvCache } from "@/server/lib/env";

/**
 * /api/jobs/catalogue-sync (doc 29 Batch 1b) is server to server only: the
 * scheduled GET needs CRON_SECRET, the manual POST also SUPPLIER_JOB_SECRET,
 * like the other supplier job routes. A refused call never reaches the sync.
 * The service is replaced; secrets are synthetic and assembled at runtime.
 */

const runScheduledCatalogueSync = vi.hoisted(() => vi.fn());
vi.mock("@/server/services/traveldesk-catalogue-sync.service", () => ({ runScheduledCatalogueSync }));

const CRON = "cron-".padEnd(32, "c");
const JOB = "job-".padEnd(32, "j");

function req(method: "GET" | "POST", headers: Record<string, string> = {}) {
  return new NextRequest("http://localhost/api/jobs/catalogue-sync", { method, headers });
}

const complete = {
  status: "complete",
  result: {
    environment: "test",
    agencyId: "4242",
    pinnedAgencyId: null,
    sync: { tours: 3, offers: 9, added: 1, changed: 0, removed: 0, revived: 0, failedTours: [], removalsApplied: true, mappingsChanged: 0 },
    candidates: { skipped: "incomplete" },
    snapshots: { skipped: "no_offers" },
    run: { id: "run-1", status: "complete", resumedFromRunId: null, resumeAfterTourId: null },
    durationMs: 1200,
  },
};

describe("catalogue-sync job route", () => {
  beforeEach(() => {
    runScheduledCatalogueSync.mockReset();
    runScheduledCatalogueSync.mockResolvedValue(complete);
    vi.stubEnv("CRON_SECRET", CRON);
    vi.stubEnv("SUPPLIER_JOB_SECRET", JOB);
    resetEnvCache();
  });
  afterEach(() => {
    vi.unstubAllEnvs();
    resetEnvCache();
  });

  it.each([
    ["no secret", {}],
    ["a wrong bearer", { authorization: `Bearer ${"x".repeat(32)}` }],
    ["a wrong header", { "x-cron-secret": "nope" }],
    ["the cron secret under another header", { "x-job-secret": CRON }],
  ])("refuses %s with 401 and does not sync", async (_label, headers) => {
    const { GET, POST } = await import("../catalogue-sync/route");
    expect((await GET(req("GET", headers), undefined as never)).status).toBe(401);
    expect((await POST(req("POST", headers), undefined as never)).status).toBe(401);
    expect(runScheduledCatalogueSync).not.toHaveBeenCalled();
  });

  it("is disabled (503) when CRON_SECRET is unset, whatever is sent", async () => {
    vi.stubEnv("CRON_SECRET", "");
    resetEnvCache();
    const { GET } = await import("../catalogue-sync/route");
    expect((await GET(req("GET", { authorization: "Bearer " }), undefined as never)).status).toBe(503);
    expect(runScheduledCatalogueSync).not.toHaveBeenCalled();
  });

  it("the manual POST needs the job secret as well as the cron secret", async () => {
    const { POST } = await import("../catalogue-sync/route");
    expect((await POST(req("POST", { authorization: `Bearer ${CRON}` }), undefined as never)).status).toBe(401);
    expect(runScheduledCatalogueSync).not.toHaveBeenCalled();
    expect((await POST(req("POST", { "x-cron-secret": CRON, "x-job-secret": JOB }), undefined as never)).status).toBe(200);
    expect(runScheduledCatalogueSync).toHaveBeenCalledTimes(1);
  });

  it("the scheduled GET runs the sync and answers counts only", async () => {
    const { GET } = await import("../catalogue-sync/route");
    const res = await GET(req("GET", { authorization: `Bearer ${CRON}` }), undefined as never);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toMatchObject({ ok: true, status: "complete", runId: "run-1", tours: 3, offers: 9, failedTours: 0 });
    // No agency id or balance in a job response.
    expect(JSON.stringify(body)).not.toContain("4242");
    expect(runScheduledCatalogueSync).toHaveBeenCalledWith();
  });

  it("answers 409 while another run holds the lease, 502 for a failed run and 200 when TravelDesk is not configured", async () => {
    const { GET } = await import("../catalogue-sync/route");
    const auth = { authorization: `Bearer ${CRON}` };
    runScheduledCatalogueSync.mockResolvedValueOnce({ status: "skipped", reason: "lease_held" });
    expect((await GET(req("GET", auth), undefined as never)).status).toBe(409);
    runScheduledCatalogueSync.mockResolvedValueOnce({ status: "failed", errorCode: "traveldesk_auth" });
    const failed = await GET(req("GET", auth), undefined as never);
    expect(failed.status).toBe(502);
    expect(await failed.json()).toMatchObject({ ok: false, errorCode: "traveldesk_auth" });
    runScheduledCatalogueSync.mockResolvedValueOnce({ status: "skipped", reason: "not_configured" });
    expect(await (await GET(req("GET", auth), undefined as never)).json()).toMatchObject({ ok: true, skipped: "not_configured" });
  });
});
