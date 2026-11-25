import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Quote budget alert (review 82; quote-budget-alert.ts): the pure incident
 * rule, the token wrapper and the never-throw recording. The SQL episode
 * upsert and the sweep read are covered in the db suite
 * (ops-alert.service.test.ts). Synthetic codes only.
 */

const h = vi.hoisted(() => ({
  queryRaw: vi.fn(),
  log: { error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() },
}));
vi.mock("../../lib/db", () => ({ prisma: { $queryRaw: h.queryRaw } }));
vi.mock("../../lib/logger", () => ({ log: h.log }));

const { alertingQuoteToken, quoteBudgetIncident, quoteBudgetRefusalKey, recordQuoteBudgetRefusal, QUOTE_BUDGET_EPISODE_GAP_MS } = await import("../quote-budget-alert");
const { incidentContext, OPS_INCIDENT_TITLES } = await import("../ops-alert.service");
const { renderTemplate } = await import("@/server/notifications/templates");

const H = 3_600_000;
const now = new Date("2026-11-24T10:00:00.000Z");
const since = new Date(now.getTime() - 72 * H);
const episode = (over: Record<string, unknown> = {}) => ({ supplier: "traveldesk", environment: "production", account: "4321", episodeStart: new Date(now.getTime() - 5 * 60_000), ...over });

beforeEach(() => {
  h.queryRaw.mockReset();
  for (const f of Object.values(h.log)) f.mockReset();
});

describe("quote budget alert: thresholds", () => {
  it("an episode ends after ten minutes without a refusal", () => {
    expect(QUOTE_BUDGET_EPISODE_GAP_MS).toBe(10 * 60_000);
    expect(quoteBudgetRefusalKey("traveldesk", "test", "default")).toBe("supplier_quote_refusals.traveldesk.test.default");
  });
});

describe("quote budget alert: the incident", () => {
  it("one incident per episode, raised at its first refusal, on the supplier account; codes only", () => {
    const i = quoteBudgetIncident(episode(), since, now);
    expect(i).toMatchObject({
      kind: "quote_budget_refused",
      entityKind: "supplier_account",
      entityId: "traveldesk.quote_budget.production.4321",
      reason: "quote_budget_spent",
      orderId: null,
      orderReference: null,
      bookingId: null,
      adminPath: "/admin/suppliers/traveldesk",
    });
    expect(i!.raisedAt).toEqual(episode().episodeStart);
  });

  it("only inside the sweep window", () => {
    expect(quoteBudgetIncident(episode({ episodeStart: new Date(since.getTime() - 1) }), since, now)).toBeNull();
    expect(quoteBudgetIncident(episode({ episodeStart: new Date(now.getTime() + 1) }), since, now)).toBeNull();
    expect(quoteBudgetIncident(episode({ episodeStart: new Date("not a date") }), since, now)).toBeNull();
  });

  it("refuses names that are not code-shaped, so no free text reaches an alert", () => {
    expect(quoteBudgetIncident(episode({ account: "has space" }), since, now)).toBeNull();
    expect(quoteBudgetIncident(episode({ supplier: null }), since, now)).toBeNull();
    expect(quoteBudgetIncident(episode({ environment: 7 }), since, now)).toBeNull();
  });

  it("the email names the incident and the entity, never a customer or an amount", () => {
    const r = renderTemplate("OPS_INCIDENT_ALERT", "email", incidentContext(quoteBudgetIncident(episode(), since, now)!, "https://outlyy.com") as never);
    expect(r.subject).toBe(`[OUTLY ALERT] ${OPS_INCIDENT_TITLES.quote_budget_refused}`);
    expect(r.text).toContain("Reason: quote_budget_spent");
    expect(r.text).toContain("Entity: supplier_account:traveldesk.quote_budget.production.4321");
    expect(r.text).toContain("Admin: https://outlyy.com/admin/suppliers/traveldesk");
    expect(r.text).not.toMatch(/AED|INR|@/);
  });
});

describe("quote budget alert: recording", () => {
  it("records only refused tokens and returns the token's answer unchanged", async () => {
    const record = vi.fn(async () => {});
    const answers = [true, false];
    const take = alertingQuoteToken(async () => answers.shift()!, record);
    expect(await take("traveldesk", "test", "default")).toBe(true);
    expect(record).not.toHaveBeenCalled();
    expect(await take("traveldesk", "test", "default")).toBe(false);
    expect(record).toHaveBeenCalledWith("traveldesk", "test", "default");
  });

  it("writes one warn line with codes and the episode count", async () => {
    const start = new Date("2026-11-24T09:58:00.000Z");
    h.queryRaw.mockResolvedValueOnce([{ count: 3, episode_start: start }]);
    await recordQuoteBudgetRefusal("traveldesk", "production", "4321");
    expect(h.queryRaw).toHaveBeenCalledTimes(1);
    expect(h.log.warn).toHaveBeenCalledWith("supplier.quote_budget_refused", { supplier: "traveldesk", environment: "production", refusals: 3, episodeStart: start.toISOString() });
  });

  it("never throws: a failed write is logged and the refusal stands", async () => {
    h.queryRaw.mockRejectedValueOnce(new Error("connection lost"));
    await expect(recordQuoteBudgetRefusal("traveldesk", "test", "default")).resolves.toBeUndefined();
    expect(h.log.error).toHaveBeenCalledWith("supplier.quote_budget_record_failed", expect.anything());
    const take = alertingQuoteToken(async () => false, recordQuoteBudgetRefusal);
    h.queryRaw.mockRejectedValueOnce(new Error("connection lost"));
    expect(await take("traveldesk", "test", "default")).toBe(false);
  });
});
