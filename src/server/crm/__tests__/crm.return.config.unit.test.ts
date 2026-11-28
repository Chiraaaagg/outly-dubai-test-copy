import { describe, expect, it } from "vitest";
import { crmReturnConfigFrom, crmReturnProblems, parseStaffMap } from "@/server/crm/crm.return.config";
import { crmReturnIncident } from "@/server/crm/crm.return.alerts";
import { FAKE_OWNER, fakeConfig } from "./_memory-store";
import { STAFF, STAFF_MAP } from "./_return-harness";

/**
 * Return path settings (C3ab, doc 29e §3.8, §4.1, §10; owner answer 4): off
 * by default, fail closed on any bad value, and a staff map of ids only.
 */

const cfg = fakeConfig();
const lead = STAFF.lead.id;

describe("CRM_RETURN_PATH, CRM_RETURN_ACCEPT, CRM_BITRIX_STAFF_MAP", () => {
  it("is off by default and when the mode is not one of off, observe, enforce", () => {
    expect(crmReturnConfigFrom({}, cfg)).toMatchObject({ mode: "off", accept: false });
    expect(crmReturnConfigFrom({ CRM_RETURN_PATH: "on" }, cfg).mode).toBe("off");
    expect(crmReturnProblems({ CRM_RETURN_PATH: "ENFORCE" }, cfg)).toEqual(["CRM_RETURN_PATH must be off, observe or enforce"]);
    expect(crmReturnConfigFrom({ CRM_RETURN_PATH: "observe" }, cfg)).toMatchObject({ mode: "observe", accept: false });
  });

  it("accepts only in enforce, with acceptance on and a valid map", () => {
    expect(crmReturnConfigFrom({ CRM_RETURN_PATH: "enforce", CRM_RETURN_ACCEPT: true, CRM_BITRIX_STAFF_MAP: STAFF_MAP }, cfg).accept).toBe(true);
    expect(crmReturnConfigFrom({ CRM_RETURN_PATH: "observe", CRM_RETURN_ACCEPT: true, CRM_BITRIX_STAFF_MAP: STAFF_MAP }, cfg).accept).toBe(false);
    expect(crmReturnConfigFrom({ CRM_RETURN_PATH: "enforce", CRM_BITRIX_STAFF_MAP: STAFF_MAP }, cfg).accept).toBe(false);
    // Acceptance switched on without a map: the whole return path stays off (fail closed).
    expect(crmReturnConfigFrom({ CRM_RETURN_PATH: "enforce", CRM_RETURN_ACCEPT: true }, cfg).mode).toBe("off");
  });

  it("refuses a malformed map without echoing its values", () => {
    const bad = (raw: string) => parseStaffMap(raw, cfg).problems;
    expect(bad(`${FAKE_OWNER}=${lead}`)).toEqual([]);
    expect(bad(`x=${lead}`)[0]).toMatch(/pair 1 must start with a Bitrix24 user id/);
    expect(bad(`${FAKE_OWNER}=someone`)[0]).toMatch(/pair 1 must end with an OUTLYY staff id/);
    expect(bad(`${FAKE_OWNER}=${lead},${FAKE_OWNER}=${STAFF.a.id}`)).toEqual(["CRM_BITRIX_STAFF_MAP: pair 2 repeats a Bitrix24 user id"]);
    expect(bad(`${FAKE_OWNER}=${lead},31=${lead}`)).toEqual(["CRM_BITRIX_STAFF_MAP: pair 2 repeats an OUTLYY staff id"]);
    expect(bad(`${FAKE_OWNER}=${lead},${cfg.webhookUserId}=${STAFF.a.id}`)).toEqual(["CRM_BITRIX_STAFF_MAP: pair 2 names the service account"]);
    expect(bad(`31=${STAFF.a.id}`)).toEqual(["CRM_BITRIX_STAFF_MAP must include the default deal owner (CRM_BITRIX_DEFAULT_OWNER_ID)"]);
    for (const p of bad(`x=${lead},${FAKE_OWNER}=someone`)) expect(p).not.toMatch(/someone|x=/);
  });
});

describe("return path ops alert", () => {
  it("a finding becomes one crm_return_path incident with ids only", () => {
    const at = new Date("2026-11-22T08:00:00Z");
    expect(crmReturnIncident({ kind: "crm_twin", subject_key: "deal:812", environment: "production", raised_at: at })).toMatchObject({ kind: "crm_return_path", entityKind: "crm_subject", entityId: "deal:812", reason: "crm_twin", adminPath: "/admin" });
    expect(crmReturnIncident({ kind: "crm_portal_fingerprint_mismatch", subject_key: "portal", environment: "production", raised_at: at }).entityId).toBe("portal:production");
    expect(crmReturnIncident({ kind: "crm_deal_not_visible", subject_key: `inquiry:${lead}`, environment: "production", raised_at: at }).adminPath).toBe(`/admin/inquiries/${lead}`);
  });
});
