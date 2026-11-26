import { NextRequest } from "next/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resetEnvCache } from "@/server/lib/env";
import { SYSTEM_ACTOR } from "@/server/lib/actor";

/**
 * /api/jobs/fx-refresh is server to server only: the scheduled GET and the
 * manual POST both need CRON_SECRET, exactly like the other job routes, and
 * a refused call never reaches the refresh. The service is replaced; secrets
 * are synthetic.
 */

const refresh = vi.hoisted(() => vi.fn());
vi.mock("@/server/services/fx-refresh.service", () => ({ fxRefreshService: { refresh } }));

const CRON = "cron-".padEnd(32, "c");

function req(method: "GET" | "POST", headers: Record<string, string> = {}) {
  return new NextRequest("http://localhost/api/jobs/fx-refresh", { method, headers });
}

describe("fx-refresh job route", () => {
  beforeEach(() => {
    refresh.mockReset();
    refresh.mockResolvedValue({ status: "written", version: 2, inrPerAed: "26.32" });
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
    ["a wrong header", { "x-cron-secret": "nope" }],
    ["the cron secret under another header", { "x-job-secret": CRON }],
  ])("refuses %s with 401 and does not refresh", async (_label, headers) => {
    const { GET, POST } = await import("../fx-refresh/route");
    expect((await GET(req("GET", headers), undefined as never)).status).toBe(401);
    expect((await POST(req("POST", headers), undefined as never)).status).toBe(401);
    expect(refresh).not.toHaveBeenCalled();
  });

  it("is disabled (503) when CRON_SECRET is unset, whatever is sent", async () => {
    vi.stubEnv("CRON_SECRET", "");
    resetEnvCache();
    const { GET } = await import("../fx-refresh/route");
    expect((await GET(req("GET", { authorization: "Bearer " }), undefined as never)).status).toBe(503);
    expect(refresh).not.toHaveBeenCalled();
  });

  it("runs as the system actor with the cron secret, by bearer or header", async () => {
    const { GET, POST } = await import("../fx-refresh/route");
    const res = await GET(req("GET", { authorization: `Bearer ${CRON}` }), undefined as never);
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ ok: true, status: "written", inrPerAed: "26.32" });
    expect((await POST(req("POST", { "x-cron-secret": CRON }), undefined as never)).status).toBe(200);
    expect(refresh.mock.calls).toEqual([
      [SYSTEM_ACTOR, { trigger: "cron" }],
      [SYSTEM_ACTOR, { trigger: "cron" }],
    ]);
  });

  it("answers 409 for a guard refusal and 502 for a source failure", async () => {
    const { GET } = await import("../fx-refresh/route");
    refresh.mockResolvedValueOnce({ status: "refused", reasons: ["jump_too_large"] });
    const refused = await GET(req("GET", { authorization: `Bearer ${CRON}` }), undefined as never);
    expect(refused.status).toBe(409);
    expect(await refused.json()).toMatchObject({ ok: false, reasons: ["jump_too_large"] });
    refresh.mockResolvedValueOnce({ status: "failed", reason: "timeout" });
    expect((await GET(req("GET", { authorization: `Bearer ${CRON}` }), undefined as never)).status).toBe(502);
  });
});
