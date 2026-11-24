import { NextRequest } from "next/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resetEnvCache } from "@/server/lib/env";

/**
 * /api/jobs/retention-purge is server to server only: the scheduled GET and
 * the manual POST both need CRON_SECRET, like every job route, and a refused
 * call never reaches the purge. The purge is replaced; secrets are synthetic.
 */

const runRetentionPurge = vi.hoisted(() => vi.fn());
vi.mock("@/server/jobs/retention-purge", () => ({ runRetentionPurge }));

const CRON = "cron-".padEnd(32, "c");

function req(method: "GET" | "POST", headers: Record<string, string> = {}) {
  return new NextRequest("http://localhost/api/jobs/retention-purge", { method, headers });
}

describe("retention-purge job route", () => {
  beforeEach(() => {
    runRetentionPurge.mockReset();
    runRetentionPurge.mockResolvedValue({ ok: true, ranAt: "2030-06-01T02:45:00.000Z", durationMs: 12, outOfTime: false, classes: {} });
    vi.stubEnv("CRON_SECRET", CRON);
    resetEnvCache();
  });
  afterEach(() => {
    vi.unstubAllEnvs();
    resetEnvCache();
  });

  it.each([
    ["no secret", {}],
    ["a wrong bearer", { authorization: `Bearer ${"x".repeat(32)}` }],
    ["the cron secret under another header", { "x-job-secret": CRON }],
  ])("refuses %s with 401 and does not purge", async (_label, headers) => {
    const { GET, POST } = await import("../retention-purge/route");
    expect((await GET(req("GET", headers), undefined as never)).status).toBe(401);
    expect((await POST(req("POST", headers), undefined as never)).status).toBe(401);
    expect(runRetentionPurge).not.toHaveBeenCalled();
  });

  it("is disabled (503) when CRON_SECRET is unset", async () => {
    vi.stubEnv("CRON_SECRET", "");
    resetEnvCache();
    const { GET } = await import("../retention-purge/route");
    expect((await GET(req("GET", { authorization: "Bearer " }), undefined as never)).status).toBe(503);
    expect(runRetentionPurge).not.toHaveBeenCalled();
  });

  it("runs with the cron secret by bearer or header, and answers 500 when a table failed", async () => {
    const { GET, POST } = await import("../retention-purge/route");
    const ok = await GET(req("GET", { authorization: `Bearer ${CRON}` }), undefined as never);
    expect(ok.status).toBe(200);
    expect(await ok.json()).toMatchObject({ ok: true, durationMs: 12 });
    runRetentionPurge.mockResolvedValueOnce({ ok: false, ranAt: "2030-06-01T02:45:00.000Z", durationMs: 3, outOfTime: false, classes: {} });
    expect((await POST(req("POST", { "x-cron-secret": CRON }), undefined as never)).status).toBe(500);
    expect(runRetentionPurge).toHaveBeenCalledTimes(2);
  });
});
