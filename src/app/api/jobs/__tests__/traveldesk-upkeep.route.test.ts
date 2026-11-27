import { NextRequest } from "next/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resetEnvCache } from "@/server/lib/env";

/**
 * /api/jobs/traveldesk-upkeep (doc 30 N3, review 108 NR-01) is server to
 * server only, like the catalogue sync: the scheduled GET needs CRON_SECRET,
 * the manual POST also SUPPLIER_JOB_SECRET. A refused call never reaches the
 * upkeep. The service is replaced; secrets are synthetic.
 */

const runScheduledUpkeep = vi.hoisted(() => vi.fn());
vi.mock("@/server/services/traveldesk-upkeep-job", () => ({ runScheduledUpkeep }));

const CRON = "cron-".padEnd(32, "c");
const JOB = "job-".padEnd(32, "j");
const req = (method: "GET" | "POST", headers: Record<string, string> = {}) => new NextRequest("http://localhost/api/jobs/traveldesk-upkeep", { method, headers });

const complete = {
  status: "complete",
  syncRunId: "run-9",
  result: { environment: "test", links: 4, processed: 4, changed: 1, reapproved: 1, reviews: 0, unavailable: 0, hidden: 0, skipped: [], incomplete: false, contentPurged: 0, digest: "queued" },
};

describe("traveldesk-upkeep job route", () => {
  beforeEach(() => {
    runScheduledUpkeep.mockReset();
    runScheduledUpkeep.mockResolvedValue(complete);
    vi.stubEnv("CRON_SECRET", CRON);
    vi.stubEnv("SUPPLIER_JOB_SECRET", JOB);
    resetEnvCache();
  });
  afterEach(() => {
    vi.unstubAllEnvs();
    resetEnvCache();
  });

  it("refuses without the cron secret, and the manual POST also needs the job secret", async () => {
    const { GET, POST } = await import("../traveldesk-upkeep/route");
    expect((await GET(req("GET"), undefined as never)).status).toBe(401);
    expect((await POST(req("POST", { authorization: `Bearer ${CRON}` }), undefined as never)).status).toBe(401);
    expect(runScheduledUpkeep).not.toHaveBeenCalled();
    expect((await POST(req("POST", { "x-cron-secret": CRON, "x-job-secret": JOB }), undefined as never)).status).toBe(200);
    expect(runScheduledUpkeep).toHaveBeenCalledTimes(1);
  });

  it("the scheduled GET runs the upkeep and answers counts only; 409 on the lease, 502 on failure", async () => {
    const { GET } = await import("../traveldesk-upkeep/route");
    const auth = { authorization: `Bearer ${CRON}` };
    const res = await GET(req("GET", auth), undefined as never);
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ ok: true, status: "complete", syncRunId: "run-9", links: 4, changed: 1, skipped: 0, digest: "queued" });
    runScheduledUpkeep.mockResolvedValueOnce({ status: "skipped", reason: "lease_held" });
    expect((await GET(req("GET", auth), undefined as never)).status).toBe(409);
    runScheduledUpkeep.mockResolvedValueOnce({ status: "skipped", reason: "latest_sync_not_complete" });
    expect(await (await GET(req("GET", auth), undefined as never)).json()).toMatchObject({ ok: true, skipped: "latest_sync_not_complete" });
    runScheduledUpkeep.mockResolvedValueOnce({ status: "failed", errorCode: "Error" });
    expect((await GET(req("GET", auth), undefined as never)).status).toBe(502);
  });
});
