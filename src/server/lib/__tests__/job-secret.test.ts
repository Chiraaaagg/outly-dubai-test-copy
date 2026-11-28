import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import { hasHealthDetailToken, requireCron, requireJobSecret } from "../http";
import { resetEnvCache } from "../env";
import { isAppError } from "../errors";

/**
 * SEC-8: CRON_SECRET, SUPPLIER_JOB_SECRET and HEALTH_DETAIL_TOKEN each
 * authorise one thing. Synthetic values only.
 */

const CRON = "cron-".padEnd(32, "c");
const JOB = "job-".padEnd(32, "j");
const HEALTH = "health-".padEnd(32, "h");

function req(headers: Record<string, string> = {}) {
  return new NextRequest("http://localhost/api/jobs/supplier-worker", { method: "POST", headers });
}

function code(fn: () => unknown): string | null {
  try {
    fn();
    return null;
  } catch (e) {
    return isAppError(e) ? e.code : String(e);
  }
}

describe("requireJobSecret", () => {
  beforeEach(() => {
    vi.stubEnv("CRON_SECRET", CRON);
    vi.stubEnv("SUPPLIER_JOB_SECRET", JOB);
    vi.stubEnv("HEALTH_DETAIL_TOKEN", HEALTH);
    resetEnvCache();
  });
  afterEach(() => {
    vi.unstubAllEnvs();
    resetEnvCache();
  });

  it("accepts the job secret as bearer or x-job-secret", () => {
    expect(code(() => requireJobSecret(req({ authorization: `Bearer ${JOB}` })))).toBeNull();
    expect(code(() => requireJobSecret(req({ "x-job-secret": JOB })))).toBeNull();
  });

  it("refuses the cron secret, the health token, a wrong value and no value", () => {
    const refused: Record<string, string>[] = [{ authorization: `Bearer ${CRON}` }, { "x-cron-secret": CRON }, { "x-job-secret": CRON }, { authorization: `Bearer ${HEALTH}` }, { "x-job-secret": "wrong" }, {}];
    for (const h of refused) {
      expect(code(() => requireJobSecret(req(h))), JSON.stringify(Object.keys(h))).toBe("UNAUTHORIZED");
    }
  });

  it("is closed (503) when SUPPLIER_JOB_SECRET is unset", () => {
    vi.stubEnv("SUPPLIER_JOB_SECRET", "");
    resetEnvCache();
    expect(code(() => requireJobSecret(req({ authorization: `Bearer ${JOB}` })))).toBe("NOT_CONFIGURED");
  });

  it("is closed when SUPPLIER_JOB_SECRET equals CRON_SECRET", () => {
    vi.stubEnv("SUPPLIER_JOB_SECRET", CRON);
    resetEnvCache();
    expect(code(() => requireJobSecret(req({ authorization: `Bearer ${CRON}` })))).toBe("NOT_CONFIGURED");
  });

  it("the job secret does not pass requireCron", () => {
    expect(code(() => requireCron(req({ authorization: `Bearer ${JOB}` })))).toBe("UNAUTHORIZED");
  });
});

describe("hasHealthDetailToken", () => {
  beforeEach(() => {
    vi.stubEnv("CRON_SECRET", CRON);
    vi.stubEnv("HEALTH_DETAIL_TOKEN", HEALTH);
    resetEnvCache();
  });
  afterEach(() => {
    vi.unstubAllEnvs();
    resetEnvCache();
  });

  it("is true only for the health token", () => {
    expect(hasHealthDetailToken(req({ authorization: `Bearer ${HEALTH}` }))).toBe(true);
    expect(hasHealthDetailToken(req({ "x-health-token": HEALTH }))).toBe(true);
    expect(hasHealthDetailToken(req({ authorization: `Bearer ${CRON}` }))).toBe(false);
    expect(hasHealthDetailToken(req({ "x-cron-secret": CRON }))).toBe(false);
    expect(hasHealthDetailToken(req())).toBe(false);
  });

  it("is false when the token is unset or equals CRON_SECRET", () => {
    vi.stubEnv("HEALTH_DETAIL_TOKEN", "");
    resetEnvCache();
    expect(hasHealthDetailToken(req({ authorization: `Bearer ${HEALTH}` }))).toBe(false);
    vi.stubEnv("HEALTH_DETAIL_TOKEN", CRON);
    resetEnvCache();
    expect(hasHealthDetailToken(req({ authorization: `Bearer ${CRON}` }))).toBe(false);
  });
});
