import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { randomBytes } from "node:crypto";
import { apiRequest, assertDisposableDb, dbEnabled } from "../helpers/fixtures";

/**
 * G08/H16: the public health check must not describe the deployment's
 * security configuration. SEC-8: the texts need HEALTH_DETAIL_TOKEN; the cron
 * secret never unlocks them.
 */
describe.skipIf(!dbEnabled)("GET /api/health", () => {
  let resetEnvCache: () => void;
  const token = randomBytes(24).toString("hex");

  beforeAll(async () => {
    assertDisposableDb();
    ({ resetEnvCache } = await import("@/server/lib/env"));
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    resetEnvCache();
  });

  async function get(headers: Record<string, string> = {}) {
    const { GET } = await import("@/app/api/health/route");
    return GET(apiRequest("/api/health", { origin: null, headers }));
  }

  it("gives anonymous callers status and a warning count only", async () => {
    const res = await get();
    const body = await res.json();
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(body).toMatchObject({ status: "ok", db: "ok" });
    expect(typeof body.warningCount).toBe("number");
    expect(body).not.toHaveProperty("warnings");
  });

  it("refuses the warning texts for the cron secret, even with a detail token configured", async () => {
    vi.stubEnv("HEALTH_DETAIL_TOKEN", token);
    resetEnvCache();
    const secret = process.env.CRON_SECRET;
    expect(secret, "test env must define a local CRON_SECRET").toBeTruthy();
    expect(await (await get({ authorization: `Bearer ${secret}` })).json()).not.toHaveProperty("warnings");
    expect(await (await get({ "x-cron-secret": secret! })).json()).not.toHaveProperty("warnings");
  });

  it("refuses a wrong token, and every token while HEALTH_DETAIL_TOKEN is unset", async () => {
    vi.stubEnv("HEALTH_DETAIL_TOKEN", token);
    resetEnvCache();
    expect(await (await get({ authorization: "Bearer not-the-token" })).json()).not.toHaveProperty("warnings");
    vi.stubEnv("HEALTH_DETAIL_TOKEN", "");
    resetEnvCache();
    expect(await (await get({ authorization: `Bearer ${token}` })).json()).not.toHaveProperty("warnings");
  });

  it("refuses a detail token that equals the cron secret", async () => {
    vi.stubEnv("HEALTH_DETAIL_TOKEN", process.env.CRON_SECRET!);
    resetEnvCache();
    expect(await (await get({ authorization: `Bearer ${process.env.CRON_SECRET}` })).json()).not.toHaveProperty("warnings");
  });

  it("returns the warning texts for the detail token (bearer or x-health-token)", async () => {
    vi.stubEnv("HEALTH_DETAIL_TOKEN", token);
    resetEnvCache();
    const variants: Record<string, string>[] = [{ authorization: `Bearer ${token}` }, { "x-health-token": token }];
    for (const headers of variants) {
      const ok = await (await get(headers)).json();
      expect(Array.isArray(ok.warnings)).toBe(true);
      expect(ok.warnings.length).toBe(ok.warningCount);
    }
  });
});
