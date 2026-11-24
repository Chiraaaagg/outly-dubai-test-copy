import { NextRequest } from "next/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resetEnvCache } from "@/server/lib/env";

/**
 * /api/jobs/booking-tick (checkout redesign batch 4, CO-38): the cron secret
 * runs the payments step and then the supplier worker's scheduled run, in
 * that order. A payments step that throws does not skip the worker, and the
 * worker still applies its own guards: mutations only with an explicit
 * control row that is not an emergency stop, never more than `paid_only`,
 * with the provider-verified evidence ports. The engine and the payments
 * step are replaced; synthetic secrets only.
 */

const state = vi.hoisted(() => ({
  order: [] as string[],
  runs: [] as Record<string, unknown>[],
  budgets: [] as Array<{ budgetMs: number; mutationBudgetMs?: number }>,
  paymentsCaps: [] as Array<number | undefined>,
  paymentsThrows: false,
  paymentsTakeMs: 0,
  documentRuns: 0,
  reconciles: 0,
  control: { explicit: false, control: { paused: false, scope: "new_sales" } } as { explicit: boolean; control: { paused: boolean; scope: string } },
}));

const evidence = vi.hoisted(() => ({ capturedFor: async () => null }));
const evidenceInTx = vi.hoisted(() => () => ({ capturedFor: async () => null }));
vi.mock("@/server/payments/evidence", () => ({ dbPaymentEvidence: evidence, paymentEvidenceFrom: evidenceInTx }));

vi.mock("@/server/jobs/payments-job", () => ({
  PAYMENTS_STEP_CAP_MS: 45_000,
  runPaymentsJob: vi.fn(async (opts: { capMs?: number } = {}) => {
    state.order.push("payments");
    state.paymentsCaps.push(opts.capMs);
    // Slow, not throwing: the clock moves on as a slow Stripe would make it.
    if (state.paymentsTakeMs) vi.setSystemTime(Date.now() + state.paymentsTakeMs);
    if (state.paymentsThrows) throw new Error("synthetic payments failure");
    return { processed: 1, failed: 0, sagas: 0, cancellations: { visited: 0, refunded: 0, refused: 0, failed: 0 } };
  }),
}));

vi.mock("@/server/services/supplier-booking.service", () => ({
  TRAVELDESK_SUPPLIER_CODE: "traveldesk",
  MUTATION_START_MARGIN_MS: 30_000,
  bookingAccountId: (environment: string, pinned: string | null) => pinned ?? (environment === "test" ? "default" : null),
  readControl: vi.fn(async () => state.control),
  supplierBookingService: {
    runDueJobs: vi.fn(async (deps: Record<string, unknown>, opts: { budgetMs: number; mutationBudgetMs?: number }) => {
      state.order.push("supplier");
      state.runs.push(deps);
      state.budgets.push(opts);
      return { holder: "w", processed: [] };
    }),
    reconcile: vi.fn(async () => {
      state.reconciles++;
      return { issues: [] };
    }),
  },
}));

vi.mock("@/server/services/document.service", () => ({
  documentService: {
    runDue: vi.fn(async () => {
      state.documentRuns++;
      return { swept: 0, attention: 0, claimed: 0, processed: [], outOfTime: false, audited: { checked: 0, refetching: 0 } };
    }),
    runForBooking: vi.fn(),
  },
}));
vi.mock("@/server/services/key-rewrap.service", () => ({
  REWRAP_BUDGET_PER_TICK: 1,
  keyRewrapService: {
    run: vi.fn(async () => {
      state.documentRuns++;
      return {};
    }),
  },
}));

const CRON = "cron-".padEnd(32, "c");

type JobGet = { GET: (r: NextRequest, c: never) => Promise<Response> };
/** The scheduled GETs the release switch gates. */
const SCHEDULED: Record<"booking-tick" | "documents-tick" | "supplier-reconcile", () => Promise<JobGet>> = {
  "booking-tick": () => import("../booking-tick/route"),
  "documents-tick": () => import("../documents-tick/route"),
  "supplier-reconcile": () => import("../supplier-reconcile/route"),
};

function req(headers: Record<string, string> = {}) {
  return new NextRequest("http://localhost/api/jobs/booking-tick", { method: "GET", headers });
}

describe("booking-tick job route", () => {
  beforeEach(() => {
    state.order = [];
    state.runs = [];
    state.budgets = [];
    state.paymentsCaps = [];
    state.paymentsThrows = false;
    state.paymentsTakeMs = 0;
    state.documentRuns = 0;
    state.reconciles = 0;
    state.control = { explicit: false, control: { paused: false, scope: "new_sales" } };
    vi.stubEnv("CRON_SECRET", CRON);
    vi.stubEnv("SCHEDULED_BOOKING_JOBS_ENABLED", "true");
    vi.stubEnv("SUPPLIER_ADAPTER_TRAVELDESK", "live");
    vi.stubEnv("TRAVELDESK_ENV", "test");
    vi.stubEnv("TRAVELDESK_API_BASE_URL", "https://testapi.traveldesk.me/public/b2b/v1");
    vi.stubEnv("TRAVELDESK_API_KEY", "synthetic-test-key");
    resetEnvCache();
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllEnvs();
    resetEnvCache();
  });

  it.each([
    ["no secret", {}],
    ["a wrong bearer", { authorization: `Bearer ${"x".repeat(32)}` }],
    ["the cron secret under another header", { "x-job-secret": CRON }],
  ])("refuses %s with 401 and runs nothing", async (_label, headers) => {
    const { GET } = await import("../booking-tick/route");
    expect((await GET(req(headers), undefined as never)).status).toBe(401);
    expect(state.order).toEqual([]);
  });

  it("GET only: no manual POST that could widen the supplier step", async () => {
    const mod = (await import("../booking-tick/route")) as Record<string, unknown>;
    expect(Object.keys(mod).filter((k) => ["GET", "POST", "PUT", "PATCH", "DELETE"].includes(k))).toEqual(["GET"]);
  });

  it("runs payments, then the supplier worker's scheduled run, inside the route's time budget", async () => {
    const { GET, maxDuration } = await import("../booking-tick/route");
    const res = await GET(req({ authorization: `Bearer ${CRON}` }), undefined as never);
    expect(res.status).toBe(200);
    expect(state.order).toEqual(["payments", "supplier"]);
    expect(state.paymentsCaps).toEqual([45_000]);
    expect(state.budgets[0].budgetMs).toBeGreaterThan(0);
    expect(state.budgets[0].budgetMs).toBeLessThanOrEqual((maxDuration - 30) * 1000);
    expect(state.budgets[0].mutationBudgetMs).toBe((maxDuration - 30) * 1000);
    const body = await res.json();
    expect(body).toMatchObject({ ok: true, payments: { ok: true, processed: 1 }, supplier: { ok: true, environment: "test", mutations: false } });
  });

  it("a payments step that throws still runs the worker, with every one of its guards, and answers 500 with a code", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    state.paymentsThrows = true;
    const { GET } = await import("../booking-tick/route");
    const call = () => GET(req({ authorization: `Bearer ${CRON}` }), undefined as never);
    const first = await call();
    expect(first.status).toBe(500);
    const body = await first.json();
    expect(body).toMatchObject({ ok: false, payments: { ok: false, error: "internal" }, supplier: { ok: true } });
    expect(JSON.stringify(body)).not.toContain("synthetic payments failure");
    state.control = { explicit: true, control: { paused: true, scope: "all_writes" } };
    await call();
    state.control = { explicit: true, control: { paused: false, scope: "new_sales" } };
    await call();
    expect(state.order).toEqual(["payments", "supplier", "payments", "supplier", "payments", "supplier"]);
    // The control row decides, as on the worker's own GET: never `true`, emergency stop means none.
    expect(state.runs.map((r) => r.mutations)).toEqual([false, false, "paid_only"]);
    expect(state.runs.every((r) => r.payments === evidence && r.paymentsInTx === evidenceInTx)).toBe(true);
  });

  it("a slow payments step (45 s, not throwing) still leaves the worker its full mutation window, with mutations allowed by the control row", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    state.paymentsTakeMs = 45_000;
    state.control = { explicit: true, control: { paused: false, scope: "new_sales" } };
    const { GET } = await import("../booking-tick/route");
    const res = await GET(req({ authorization: `Bearer ${CRON}` }), undefined as never);
    expect(res.status).toBe(200);
    expect(state.runs[0].mutations).toBe("paid_only");
    // The engine sends a mutation only with mutationTimeout + 30 s (180 s) of this left: a 90 s window, as a standalone worker run.
    expect(state.budgets[0]).toEqual({ budgetMs: 225_000, mutationBudgetMs: 270_000 });
  });

  describe("release switch SCHEDULED_BOOKING_JOBS_ENABLED (review fix 4)", () => {
    for (const value of [undefined, "", "false", "TRUE", "1", "yes"]) {
      it(`${JSON.stringify(value)}: the scheduled GETs of booking-tick, documents-tick and supplier-reconcile answer skipped and touch nothing`, async () => {
        if (value === undefined) vi.stubEnv("SCHEDULED_BOOKING_JOBS_ENABLED", undefined as unknown as string);
        else vi.stubEnv("SCHEDULED_BOOKING_JOBS_ENABLED", value);
        resetEnvCache();
        vi.spyOn(console, "warn").mockImplementation(() => {});
        const auth = { authorization: `Bearer ${CRON}` };
        for (const path of ["booking-tick", "documents-tick", "supplier-reconcile"] as const) {
          const mod = await SCHEDULED[path]();
          const res = await mod.GET(req(auth), undefined as never);
          expect(res.status, path).toBe(200);
          expect(await res.json(), path).toMatchObject({ ok: true, skipped: "scheduled booking jobs off" });
        }
        expect(state.order).toEqual([]);
        expect(state.documentRuns).toBe(0);
        expect(state.reconciles).toBe(0);
      });
    }

    it("the switch never bypasses the cron secret", async () => {
      vi.stubEnv("SCHEDULED_BOOKING_JOBS_ENABLED", "false");
      resetEnvCache();
      for (const path of ["booking-tick", "documents-tick", "supplier-reconcile"] as const) {
        const mod = await SCHEDULED[path]();
        expect((await mod.GET(req({}), undefined as never)).status, path).toBe(401);
      }
    });

    it("on (exactly \"true\"): every scheduled GET runs; the manual POSTs were never gated", async () => {
      const auth = { authorization: `Bearer ${CRON}` };
      for (const path of ["booking-tick", "documents-tick", "supplier-reconcile"] as const) {
        const mod = await SCHEDULED[path]();
        expect((await mod.GET(req(auth), undefined as never)).status, path).toBe(200);
      }
      expect(state.order).toEqual(["payments", "supplier"]);
      expect(state.documentRuns).toBeGreaterThan(0);
      expect(state.reconciles).toBe(1);
      vi.stubEnv("SCHEDULED_BOOKING_JOBS_ENABLED", "false");
      resetEnvCache();
      state.documentRuns = 0;
      const docs = await import("../documents-tick/route");
      expect((await docs.POST(req(auth), undefined as never)).status).toBe(200);
      expect(state.documentRuns).toBeGreaterThan(0);
    });
  });

  it("follow-up 2: the booking tick fetches vouchers right after a confirm; the supplier-worker routes do not (as at HEAD)", async () => {
    const { setDocumentStoreForTests } = await import("@/server/documents/store");
    const { MemoryDocumentStore } = await import("@/server/documents/memory-store");
    setDocumentStoreForTests(new MemoryDocumentStore());
    vi.stubEnv("SUPPLIER_JOB_SECRET", "job-".padEnd(32, "j"));
    resetEnvCache();
    try {
      const tick = await import("../booking-tick/route");
      await tick.GET(req({ authorization: `Bearer ${CRON}` }), undefined as never);
      const worker = await import("../supplier-worker/route");
      await worker.GET(req({ authorization: `Bearer ${CRON}` }), undefined as never);
      await worker.POST(new NextRequest("http://localhost/api/jobs/supplier-worker", { method: "POST", headers: { "x-cron-secret": CRON, "x-job-secret": "job-".padEnd(32, "j") } }), undefined as never);
      expect(state.runs).toHaveLength(3);
      expect(typeof state.runs[0].afterConfirmed).toBe("function");
      expect(state.runs[1].afterConfirmed).toBeUndefined();
      expect(state.runs[2].afterConfirmed).toBeUndefined();
    } finally {
      setDocumentStoreForTests(undefined);
    }
  });
});
