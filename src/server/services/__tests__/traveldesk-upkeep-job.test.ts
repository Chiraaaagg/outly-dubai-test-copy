import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

/** Doc 30 N3 (review 108 NR-01): the upkeep job's state and its ops alert after consecutive incomplete runs. */
describe("upkeep job state and alert", async () => {
  const { nextUpkeepState, upkeepIncompleteIncident, UPKEEP_ALERT_AFTER } = await import("../traveldesk-upkeep-job");
  const t = (h: number) => new Date(Date.UTC(2026, 10, 26, h));

  it("counts consecutive incomplete runs, resets on a finished one, and alerts at the threshold", () => {
    const a = nextUpkeepState(null, "r1", false, t(1));
    expect(a).toMatchObject({ consecutiveIncomplete: 1, alertAt: null });
    expect(upkeepIncompleteIncident("test", a, t(0), t(2))).toBeNull();
    const b = nextUpkeepState(a, "r2", false, t(3));
    expect(b.consecutiveIncomplete).toBe(UPKEEP_ALERT_AFTER);
    const i = upkeepIncompleteIncident("test", b, t(0), t(4));
    expect(i).toMatchObject({ kind: "upkeep_incomplete", entityKind: "supplier_account", reason: "upkeep_incomplete", raisedAt: t(3) });
    // A third incomplete run keeps the first alert time (dedup by raise time); a finished run clears it.
    expect(nextUpkeepState(b, "r3", false, t(5)).alertAt).toBe(b.alertAt);
    const c = nextUpkeepState(b, "r3", true, t(6));
    expect(c).toMatchObject({ complete: true, consecutiveIncomplete: 0, alertAt: null });
    expect(upkeepIncompleteIncident("test", c, t(0), t(7))).toBeNull();
    // Outside the sweep window: nothing.
    expect(upkeepIncompleteIncident("test", b, t(4), t(5))).toBeNull();
  });
});
