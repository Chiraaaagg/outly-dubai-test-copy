import { NextRequest } from "next/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resetEnvCache } from "@/server/lib/env";

/**
 * SEC-8 on the supplier job routes: the scheduled GET (cron secret) runs
 * recovery and read jobs, and from B3 only the payment-backed reserves and
 * paid confirms of order-item attempts (`paid_only`), so a cron secret alone
 * can never cause a drill reserve or confirm, a create or a cancel to be sent. A manual POST needs the job secret as
 * well. Both send anything only when an operator wrote the control row and it
 * is not an emergency stop, and both read provider-verified payment evidence.
 * The engine and the evidence port are replaced; synthetic secrets only.
 */

const state = vi.hoisted(() => ({
  runs: [] as Record<string, unknown>[],
  control: { explicit: false, control: { paused: false, scope: "new_sales" } } as { explicit: boolean; control: { paused: boolean; scope: string } },
}));

const evidence = vi.hoisted(() => ({ capturedFor: async () => null }));
const evidenceInTx = vi.hoisted(() => () => ({ capturedFor: async () => null }));
vi.mock("@/server/payments/evidence", () => ({ dbPaymentEvidence: evidence, paymentEvidenceFrom: evidenceInTx }));

vi.mock("@/server/services/supplier-booking.service", () => ({
  TRAVELDESK_SUPPLIER_CODE: "traveldesk",
  bookingAccountId: (environment: string, pinned: string | null) => pinned ?? (environment === "test" ? "default" : null),
  readControl: vi.fn(async () => state.control),
  supplierBookingService: {
    runDueJobs: vi.fn(async (deps: Record<string, unknown>) => {
      state.runs.push(deps);
      return { holder: "w", processed: [] };
    }),
    reconcile: vi.fn(async () => ({ issues: [] })),
  },
}));

const CRON = "cron-".padEnd(32, "c");
const JOB = "job-".padEnd(32, "j");

function req(method: "GET" | "POST", headers: Record<string, string>) {
  return new NextRequest("http://localhost/api/jobs/supplier-worker", { method, headers });
}

describe("supplier job routes (SEC-8)", () => {
  beforeEach(() => {
    state.runs = [];
    state.control = { explicit: false, control: { paused: false, scope: "new_sales" } };
    vi.stubEnv("CRON_SECRET", CRON);
    vi.stubEnv("SUPPLIER_JOB_SECRET", JOB);
    vi.stubEnv("SUPPLIER_ADAPTER_TRAVELDESK", "live");
    vi.stubEnv("TRAVELDESK_ENV", "test");
    vi.stubEnv("TRAVELDESK_API_BASE_URL", "https://testapi.traveldesk.me/public/b2b/v1");
    vi.stubEnv("TRAVELDESK_API_KEY", "synthetic-test-key");
    resetEnvCache();
  });
  afterEach(() => {
    vi.unstubAllEnvs();
    resetEnvCache();
  });

  it("the scheduled GET runs payment-backed mutations at most, and only with an explicit control row that is not an emergency stop (B3)", async () => {
    const { GET } = await import("../supplier-worker/route");
    const call = () => GET(req("GET", { authorization: `Bearer ${CRON}` }), undefined as never);
    expect((await call()).status).toBe(200);
    state.control = { explicit: true, control: { paused: true, scope: "all_writes" } };
    await call();
    state.control = { explicit: true, control: { paused: true, scope: "new_sales" } };
    await call();
    state.control = { explicit: true, control: { paused: false, scope: "new_sales" } };
    await call();
    // Never `true`: drill mutations, creates and cancels stay manual-POST-only.
    expect(state.runs.map((r) => r.mutations)).toEqual([false, false, "paid_only", "paid_only"]);
    expect(state.runs[3]).toMatchObject({ environment: "test", accountId: "default" });
    expect(state.runs.every((r) => r.payments === evidence && r.paymentsInTx === evidenceInTx)).toBe(true);
  });

  it("a POST with only the cron secret is refused and runs nothing", async () => {
    const { POST } = await import("../supplier-worker/route");
    const res = await POST(req("POST", { authorization: `Bearer ${CRON}` }), undefined as never);
    expect(res.status).toBe(401);
    expect(state.runs).toHaveLength(0);
  });

  it("a manual POST sends mutations only with an explicit control row that is not an emergency stop", async () => {
    const { POST } = await import("../supplier-worker/route");
    const call = () => POST(req("POST", { "x-cron-secret": CRON, "x-job-secret": JOB }), undefined as never);
    expect((await call()).status).toBe(200);
    state.control = { explicit: true, control: { paused: true, scope: "all_writes" } };
    await call();
    state.control = { explicit: true, control: { paused: true, scope: "new_sales" } };
    await call();
    state.control = { explicit: true, control: { paused: false, scope: "new_sales" } };
    await call();
    expect(state.runs.map((r) => r.mutations)).toEqual([false, false, true, true]);
    expect(state.runs.every((r) => r.payments === evidence && r.paymentsInTx === evidenceInTx)).toBe(true);
  });

  it("the reconcile POST needs the job secret too", async () => {
    const { POST, GET } = await import("../supplier-reconcile/route");
    expect((await POST(req("POST", { authorization: `Bearer ${CRON}` }), undefined as never)).status).toBe(401);
    expect((await GET(req("GET", { authorization: `Bearer ${CRON}` }), undefined as never)).status).toBe(200);
  });
});
