import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { assertBootEnv, env, resetEnvCache } from "../env";

function stubMinimalEnv() {
  // Minimal valid environment; nothing connects to this URL.
  vi.stubEnv("DATABASE_URL", "postgresql://unit@127.0.0.1:1/none");
  vi.stubEnv("AUTH_JWT_SECRET", "u".repeat(32));
  vi.stubEnv("AUTH_COOKIE_SECRET", "c".repeat(32));
  resetEnvCache();
}

/**
 * The instant-activation release switch: on only for the exact string "true".
 * Any other value is off and logged once, and never makes env() throw for
 * the whole app (review CR-12).
 */
describe("env INSTANT_RELEASE_ENABLED", () => {
  let warn: { mock: { calls: unknown[][] }; mockRestore(): void };

  beforeEach(() => {
    stubMinimalEnv();
    warn = vi.spyOn(console, "warn").mockImplementation(() => {});
  });

  afterEach(() => {
    warn.mockRestore();
    vi.unstubAllEnvs();
    resetEnvCache();
  });

  const switchWarnings = () => warn.mock.calls.filter((c) => String(c[0]).includes("env.release_switch_invalid"));

  it("defaults to false when unset or empty, without a warning", () => {
    vi.stubEnv("INSTANT_RELEASE_ENABLED", undefined);
    expect(env().INSTANT_RELEASE_ENABLED).toBe(false);
    resetEnvCache();
    vi.stubEnv("INSTANT_RELEASE_ENABLED", "");
    expect(env().INSTANT_RELEASE_ENABLED).toBe(false);
    expect(switchWarnings()).toEqual([]);
  });

  it('is true only for "true" and false for "false"', () => {
    vi.stubEnv("INSTANT_RELEASE_ENABLED", "true");
    expect(env().INSTANT_RELEASE_ENABLED).toBe(true);
    resetEnvCache();
    vi.stubEnv("INSTANT_RELEASE_ENABLED", "false");
    expect(env().INSTANT_RELEASE_ENABLED).toBe(false);
    expect(switchWarnings()).toEqual([]);
  });

  it.each(["1", "0", "yes", "TRUE", "True", " true", "on"])("treats %j as false with a warning, and env() still loads", (value) => {
    vi.stubEnv("INSTANT_RELEASE_ENABLED", value);
    expect(() => env()).not.toThrow();
    expect(env().INSTANT_RELEASE_ENABLED).toBe(false);
    const logged = switchWarnings();
    expect(logged).toHaveLength(1);
    // The log names the variable, never its value.
    expect(String(logged[0][0])).toContain("INSTANT_RELEASE_ENABLED");
    expect(String(logged[0][0])).not.toContain(JSON.stringify(value));
  });

  it("warns once per process, not on every validation", () => {
    vi.stubEnv("INSTANT_RELEASE_ENABLED", "TRUE");
    env();
    // A second validation without a reset must not log again.
    env();
    expect(switchWarnings()).toHaveLength(1);
  });
});

/** SEC-8: the new secrets are optional, and a value shared with CRON_SECRET is reported. */
describe("env SUPPLIER_JOB_SECRET and HEALTH_DETAIL_TOKEN", () => {
  beforeEach(stubMinimalEnv);
  afterEach(() => {
    vi.unstubAllEnvs();
    resetEnvCache();
  });

  it("are optional: unset or blank means undefined", () => {
    vi.stubEnv("SUPPLIER_JOB_SECRET", "");
    vi.stubEnv("HEALTH_DETAIL_TOKEN", "  ");
    expect(env().SUPPLIER_JOB_SECRET).toBeUndefined();
    expect(env().HEALTH_DETAIL_TOKEN).toBeUndefined();
  });

  it("assertBootEnv flags a secret shared with CRON_SECRET", () => {
    vi.stubEnv("CRON_SECRET", "s".repeat(24));
    vi.stubEnv("SUPPLIER_JOB_SECRET", "s".repeat(24));
    vi.stubEnv("HEALTH_DETAIL_TOKEN", "s".repeat(24));
    const problems = assertBootEnv();
    expect(problems.some((p) => p.startsWith("SUPPLIER_JOB_SECRET equals CRON_SECRET"))).toBe(true);
    expect(problems.some((p) => p.startsWith("HEALTH_DETAIL_TOKEN equals CRON_SECRET"))).toBe(true);
    // No problem text carries a secret value.
    expect(problems.join("\n")).not.toContain("s".repeat(24));
  });
});
