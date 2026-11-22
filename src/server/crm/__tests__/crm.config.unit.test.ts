import { describe, expect, it } from "vitest";
import { crmConfigFrom, crmConfigProblems, crmScopeFrom, CRM_STAGE_KEYS } from "@/server/crm/crm.config";
import { fakeEnv, FAKE_SECRET } from "./_memory-store";

/**
 * CRM configuration guard rails (doc 29 §5.2, §6.4 "Environments", §6.5):
 * the pinned host, the production pairing, the shared portal's funnel 0,
 * stage ids of the configured funnel only, and no secret in any message.
 */

describe("CRM config", () => {
  it("accepts the synthetic fake portal outside production", () => {
    const c = crmConfigFrom(fakeEnv());
    expect(c).toMatchObject({ environment: "staging", portal: "outlyy-fake.bitrix24.test", portalKind: "test", originatorId: "outlyy-staging", categoryId: 7, timeoutMs: 5_000 });
    expect(Object.keys(c!.stageIds).sort()).toEqual([...CRM_STAGE_KEYS].sort());
  });

  it("no portal host: no scope, so nothing is enqueued, and no config", () => {
    const e = fakeEnv({ CRM_BITRIX_PORTAL_HOST: undefined });
    expect(crmScopeFrom(e)).toBeNull();
    expect(crmConfigFrom(e)).toBeNull();
  });

  it("a scope needs only a valid host and pairing; delivery needs everything", () => {
    const e = fakeEnv({ CRM_BITRIX_WEBHOOK_SECRET: undefined, CRM_BITRIX_STAGE_IDS: undefined });
    expect(crmScopeFrom(e)).toEqual({ environment: "staging", portal: "outlyy-fake.bitrix24.test" });
    expect(crmConfigFrom(e)).toBeNull();
  });

  it.each([
    ["a production portal outside production", { CRM_BITRIX_ENV: "production" as const, CRM_BITRIX_PORTAL_HOST: "outlyy.bitrix24.com" }, "only allowed when APP_ENV=production"],
    ["a production portal on a preview deployment", { APP_ENV: "production" as const, VERCEL_ENV: "preview", CRM_BITRIX_ENV: "production" as const, CRM_BITRIX_PORTAL_HOST: "outlyy.bitrix24.com" }, "VERCEL_ENV=production"],
    ["a test portal in production", { APP_ENV: "production" as const, CRM_BITRIX_ENV: "test" as const, CRM_BITRIX_PORTAL_HOST: "outlyy.bitrix24.com" }, "must not use a test CRM portal"],
    ["a .test host in production", { APP_ENV: "production" as const, VERCEL_ENV: "production", CRM_BITRIX_ENV: "production" as const }, "not allowed when APP_ENV=production"],
    ["a host off the Bitrix24 cloud domains", { CRM_BITRIX_PORTAL_HOST: "portal.example.com" }, "must be on"],
    ["a URL instead of a host", { CRM_BITRIX_PORTAL_HOST: "https://outlyy.bitrix24.com/rest" }, "bare host name"],
    ["a host with credentials", { CRM_BITRIX_PORTAL_HOST: ["user", "outlyy.bitrix24.com"].join("@") }, "bare host name"],
    ["no portal kind", { CRM_BITRIX_ENV: undefined }, "CRM_BITRIX_ENV must be"],
  ])("refuses %s", (_label, over, message) => {
    const e = fakeEnv(over);
    expect(crmScopeFrom(e)).toBeNull();
    expect(crmConfigFrom(e)).toBeNull();
    expect(crmConfigProblems(e).join("; ")).toContain(message);
  });

  it("accepts the production portal only with APP_ENV=production on Vercel production", () => {
    const e = fakeEnv({ APP_ENV: "production", VERCEL_ENV: "production", CRM_BITRIX_ENV: "production", CRM_BITRIX_PORTAL_HOST: "outlyy.bitrix24.com" });
    expect(crmConfigFrom(e)).toMatchObject({ environment: "production", originatorId: "outlyy-production", portalKind: "production" });
  });

  it("refuses funnel 0, the other business's pipeline on the shared portal", () => {
    const e = fakeEnv({ CRM_BITRIX_DEAL_CATEGORY_ID: "0", CRM_BITRIX_STAGE_IDS: CRM_STAGE_KEYS.map((k) => `${k}=C0:${k.toUpperCase()}`).join(",") });
    expect(crmConfigFrom(e)).toBeNull();
    expect(crmConfigProblems(e).join("; ")).toContain("must not be 0");
  });

  it("refuses a stage of another funnel, a missing stage and a shared stage id", () => {
    const keys = CRM_STAGE_KEYS.map((k) => `${k}=C7:${k.toUpperCase()}`);
    const otherFunnel = fakeEnv({ CRM_BITRIX_STAGE_IDS: [...keys.slice(1), "new_inquiry=NEW"].join(",") });
    expect(crmConfigProblems(otherFunnel).join("; ")).toContain("new_inquiry must be a stage of funnel 7");
    const missing = fakeEnv({ CRM_BITRIX_STAGE_IDS: keys.slice(1).join(",") });
    expect(crmConfigProblems(missing).join("; ")).toContain("new_inquiry is missing");
    const shared = fakeEnv({ CRM_BITRIX_STAGE_IDS: [...keys.slice(1), "new_inquiry=C7:ASSIGNED"].join(",") });
    expect(crmConfigProblems(shared).join("; ")).toContain("share one stage id");
  });

  it("never echoes the webhook secret", () => {
    const e = fakeEnv({ CRM_BITRIX_WEBHOOK_SECRET: `${FAKE_SECRET}/bad`, CRM_BITRIX_WEBHOOK_USER_ID: "x" });
    const problems = crmConfigProblems(e).join("; ");
    expect(problems).toContain("unexpected shape");
    expect(problems).not.toContain(FAKE_SECRET);
  });

  it("bounds the request timeout", () => {
    expect(crmConfigProblems(fakeEnv({ CRM_BITRIX_TIMEOUT_MS: 60_000 })).join("; ")).toContain("CRM_BITRIX_TIMEOUT_MS");
  });
});
