import { describe, expect, it } from "vitest";
import { BITRIX_CLOUD_SUFFIXES, crmConfigFrom, crmConfigProblems, crmScopeFrom, CRM_FIELD_KEYS, CRM_STAGE_KEYS } from "@/server/crm/crm.config";
import { fakeEnv, FAKE_OWNER, FAKE_SECRET, FAKE_SITE, FAKE_USER, fieldCode } from "./_memory-store";

/**
 * CRM configuration guard rails (doc 29 §5.2, §6.4 "Environments", §6.5):
 * the pinned host, the production pairing, the shared portal's funnel 0,
 * stage ids of the configured funnel only, and no secret in any message.
 * C2a: the `.bitrix24.in` portal, the 12 stages without "Negotiating", the
 * 20 field codes, the default owner and the admin link origin, each failing
 * closed.
 */

const prodEnv = { APP_ENV: "production" as const, VERCEL_ENV: "production", CRM_BITRIX_ENV: "production" as const, CRM_BITRIX_PORTAL_HOST: "outlyy-dubai.bitrix24.in" };

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

  it("accepts the OUTLYY portal on .bitrix24.in (G1); still refuses any other domain, a look-alike or a sub-path", () => {
    expect(BITRIX_CLOUD_SUFFIXES).toContain(".bitrix24.in");
    expect(crmConfigFrom(fakeEnv(prodEnv))).toMatchObject({ portal: "outlyy-dubai.bitrix24.in", environment: "production" });
    for (const host of ["outlyy.bitrix24.in.example.com", "outlyy-bitrix24.in", "outlyy.bitrix24.io", "bitrix24.in", "outlyy.bitrix24.in:443"]) {
      expect(crmScopeFrom(fakeEnv({ ...prodEnv, CRM_BITRIX_PORTAL_HOST: host })), host).toBeNull();
    }
  });

  it("the stage map has exactly the 12 stages, without negotiating (G2)", () => {
    expect(CRM_STAGE_KEYS).toHaveLength(12);
    expect(CRM_STAGE_KEYS).not.toContain("negotiating");
    const keys = CRM_STAGE_KEYS.map((k) => `${k}=C7:${k.toUpperCase()}`);
    expect(crmConfigProblems(fakeEnv({ CRM_BITRIX_STAGE_IDS: [...keys, "negotiating=C7:NEGOTIATING"].join(",") })).join("; ")).toContain("unknown stage key 'negotiating'");
    expect(crmConfigProblems(fakeEnv({ CRM_BITRIX_STAGE_IDS: keys.slice(0, 11).join(",") })).join("; ")).toContain("refunded is missing");
    expect(crmConfigProblems(fakeEnv())).toEqual([]);
  });

  it("every one of the 20 OUTLYY field codes is required, of the UF_CRM_ shape, once each (G3); missing ⇒ no config", () => {
    const pairs = CRM_FIELD_KEYS.map((k) => `${k}=${fieldCode(k)}`);
    expect(crmConfigFrom(fakeEnv())!.fieldCodes).toEqual(Object.fromEntries(CRM_FIELD_KEYS.map((k) => [k, fieldCode(k)])));
    const cases: [string | undefined, string][] = [
      [undefined, "CRM_BITRIX_FIELD_CODES is missing"],
      [pairs.slice(1).join(","), "reference is missing"],
      [[...pairs.slice(1), "reference=UF_CRM_MARGIN"].join(","), "share one field code"],
      [[...pairs.slice(1), "reference=TITLE"].join(","), "reference must be a custom deal field code"],
      [[...pairs, "net_cost=UF_CRM_NET"].join(","), "unknown field key 'net_cost'"],
      [[...pairs, "reference=UF_CRM_REFERENCE"].join(","), "reference is given twice"],
    ];
    for (const [raw, message] of cases) {
      const e = fakeEnv({ CRM_BITRIX_FIELD_CODES: raw });
      expect(crmConfigFrom(e), message).toBeNull();
      expect(crmConfigProblems(e).join("; ")).toContain(message);
    }
  });

  it("a default deal owner is required: a numeric user id that is not the service account (G4)", () => {
    expect(crmConfigFrom(fakeEnv())!.defaultOwnerId).toBe(Number(FAKE_OWNER));
    for (const [v, message] of [
      [undefined, "CRM_BITRIX_DEFAULT_OWNER_ID is missing"],
      ["lead", "numeric user id"],
      ["0", "numeric user id"],
      [FAKE_USER, "must not be the service account"],
    ] as const) {
      expect(crmConfigFrom(fakeEnv({ CRM_BITRIX_DEFAULT_OWNER_ID: v })), String(v)).toBeNull();
      expect(crmConfigProblems(fakeEnv({ CRM_BITRIX_DEFAULT_OWNER_ID: v })).join("; ")).toContain(message);
    }
  });

  it("the admin link origin: https, a bare origin, never localhost for the production portal (G16)", () => {
    expect(crmConfigFrom(fakeEnv())!.adminBaseUrl).toBe(FAKE_SITE);
    expect(crmConfigFrom(fakeEnv({ NEXT_PUBLIC_SITE_URL: "http://localhost:3000" }))!.adminBaseUrl).toBe("http://localhost:3000");
    for (const [over, message] of [
      [{ NEXT_PUBLIC_SITE_URL: undefined }, "NEXT_PUBLIC_SITE_URL is missing"],
      [{ NEXT_PUBLIC_SITE_URL: "not a url" }, "not a URL"],
      [{ NEXT_PUBLIC_SITE_URL: `${FAKE_SITE}/admin?t=abc` }, "bare origin"],
      [{ NEXT_PUBLIC_SITE_URL: "http://admin.outlyy.test" }, "must be https"],
      [{ ...prodEnv, NEXT_PUBLIC_SITE_URL: "http://localhost:3000" }, "must be https"],
      [{ ...prodEnv, NEXT_PUBLIC_SITE_URL: "https://localhost" }, "must not be localhost"],
    ] as const) {
      expect(crmConfigFrom(fakeEnv(over)), message).toBeNull();
      expect(crmConfigProblems(fakeEnv(over)).join("; ")).toContain(message);
    }
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
