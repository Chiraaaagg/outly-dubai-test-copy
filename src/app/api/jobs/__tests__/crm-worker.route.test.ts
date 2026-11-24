import { NextRequest } from "next/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resetEnvCache } from "@/server/lib/env";

/**
 * /api/jobs/crm-worker (doc 29 §6.4, CRM batch C1): its own route, behind
 * CRON_SECRET on GET and POST, and off by default: without
 * CRM_SYNC_ENABLED=true, or with an incomplete CRM configuration, it answers
 * `skipped` and touches nothing. The worker itself is never reached in these
 * cases, so no database is needed. Secrets are synthetic.
 */

const CRON = "cron-".padEnd(32, "c");
const run = vi.hoisted(() => vi.fn());
vi.mock("@/server/crm/crm.worker", async (orig) => ({ ...(await orig<typeof import("@/server/crm/crm.worker")>()), runCrmWorker: run }));

function req(method: "GET" | "POST", headers: Record<string, string> = {}) {
  return new NextRequest("http://localhost/api/jobs/crm-worker", { method, headers });
}

describe("crm-worker job route", () => {
  beforeEach(() => {
    run.mockReset();
    vi.stubEnv("CRON_SECRET", CRON);
    resetEnvCache();
  });
  afterEach(() => {
    vi.unstubAllEnvs();
    resetEnvCache();
  });

  it("refuses a call without the cron secret", async () => {
    const { GET, POST } = await import("../crm-worker/route");
    expect((await GET(req("GET"), undefined as never)).status).toBe(401);
    expect((await POST(req("POST", { authorization: `Bearer ${"x".repeat(32)}` }), undefined as never)).status).toBe(401);
    expect(run).not.toHaveBeenCalled();
  });

  it("is off by default: skipped, the worker never runs", async () => {
    const { GET, POST } = await import("../crm-worker/route");
    const res = await GET(req("GET", { authorization: `Bearer ${CRON}` }), undefined as never);
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ ok: true, skipped: "crm sync off" });
    expect(await (await POST(req("POST", { "x-cron-secret": CRON }), undefined as never)).json()).toMatchObject({ skipped: "crm sync off" });
    expect(run).not.toHaveBeenCalled();
  });

  it("switched on but not fully configured: skipped, the worker never runs", async () => {
    vi.stubEnv("CRM_SYNC_ENABLED", "true");
    vi.stubEnv("APP_ENV", "staging");
    vi.stubEnv("CRM_BITRIX_ENV", "test");
    vi.stubEnv("CRM_BITRIX_PORTAL_HOST", "outlyy-fake.bitrix24.test");
    resetEnvCache();
    const { GET } = await import("../crm-worker/route");
    const res = await GET(req("GET", { authorization: `Bearer ${CRON}` }), undefined as never);
    expect(await res.json()).toMatchObject({ ok: true, skipped: "crm not configured" });
    expect(run).not.toHaveBeenCalled();
  });

  it("any value other than exactly \"true\" keeps it off", async () => {
    vi.stubEnv("CRM_SYNC_ENABLED", "TRUE");
    resetEnvCache();
    const { GET } = await import("../crm-worker/route");
    expect(await (await GET(req("GET", { authorization: `Bearer ${CRON}` }), undefined as never)).json()).toMatchObject({ skipped: "crm sync off" });
  });
});
