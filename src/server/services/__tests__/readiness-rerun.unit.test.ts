import { describe, expect, it, vi } from "vitest";
import { SYSTEM_ACTOR, type Actor } from "@/server/lib/actor";
import { READINESS_RULES_VERSION } from "../readiness.service";
import { rerunReadiness, type ReadinessRerunDeps } from "../readiness-rerun.service";

/**
 * Admin "Re-run readiness" (doc 29 §9.4): permission, staff only, a fresh
 * authenticator code, readiness over every instant candidate with no
 * supplier call, one audit row with counts only. Synthetic ids only.
 */

const STAFF = "01a1a638-5840-75c9-97d4-1543fbf8df19";
const admin = (permissions: string[] = ["suppliers.manage"]): Actor => ({ type: "admin", id: STAFF, roles: ["admin"], permissions: new Set(permissions) });

function deps(over: Partial<ReadinessRerunDeps> = {}) {
  const calls = { reevaluated: [] as string[][], audits: [] as unknown[][] };
  const d: ReadinessRerunDeps = {
    stepUp: async () => null,
    listCandidates: async () => ["p1", "p2", "p3"],
    reevaluateMany: async (ids) => {
      calls.reevaluated.push(ids);
    },
    verdicts: async () => [{ effectiveMode: "instant" }, { effectiveMode: "inquiry" }, { effectiveMode: "instant" }],
    audit: (async (...args: unknown[]) => {
      calls.audits.push(args);
    }) as never,
    now: (() => {
      let t = 1_000;
      return () => (t += 250);
    })(),
    ...over,
  };
  return { d, calls };
}

describe("re-run readiness (doc 29 §9.4)", () => {
  it("re-evaluates every instant candidate and audits the counts once", async () => {
    const { d, calls } = deps();
    const r = await rerunReadiness(admin(), "123456", d);
    expect(r).toEqual({ candidates: 3, instant: 2, inquiry: 1, rulesVersion: READINESS_RULES_VERSION, durationMs: 250 });
    expect(calls.reevaluated).toEqual([["p1", "p2", "p3"]]);
    expect(calls.audits).toHaveLength(1);
    const [actor, action, entity, change] = calls.audits[0] as [Actor, string, unknown, { after: unknown; reason: string }];
    expect(actor.id).toBe(STAFF);
    expect(action).toBe("readiness.rerun");
    expect(entity).toEqual({ type: "readiness", id: "instant_candidates" });
    expect(change.after).toEqual(r);
  });

  it("with no candidates it reads no verdicts and still audits", async () => {
    const verdicts = vi.fn(async () => []);
    const { d, calls } = deps({ listCandidates: async () => [], verdicts });
    expect(await rerunReadiness(admin(), "123456", d)).toMatchObject({ candidates: 0, instant: 0, inquiry: 0 });
    expect(verdicts).not.toHaveBeenCalled();
    expect(calls.audits).toHaveLength(1);
  });

  it("needs suppliers.manage, a staff actor and an accepted code before anything runs", async () => {
    const { d, calls } = deps();
    await expect(rerunReadiness(admin([]), "123456", d)).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(rerunReadiness(SYSTEM_ACTOR, "123456", d)).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(rerunReadiness(admin(), undefined, d)).rejects.toMatchObject({ code: "VALIDATION_FAILED" });
    const refused = deps({ stepUp: async () => "replayed" });
    await expect(rerunReadiness(admin(), "123456", refused.d)).rejects.toMatchObject({ code: "VALIDATION_FAILED" });
    expect(calls.reevaluated).toEqual([]);
    expect(refused.calls.reevaluated).toEqual([]);
    expect(calls.audits).toEqual([]);
  });
});
