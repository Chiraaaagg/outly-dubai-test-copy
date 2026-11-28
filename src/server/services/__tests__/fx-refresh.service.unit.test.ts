import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createFxRefreshService, fetchUsdInr, type FetchLike, type FxStore } from "../fx-refresh.service";
import { createMarginService, FX_INR_PER_AED_SETTING_KEY, MARGIN_COST_INPUTS_SETTING_KEY, type FxInput } from "../margin.service";
import { DEFAULT_FX_BAND, FRANKFURTER_LATEST_URL } from "../../domain/fx";
import { SYSTEM_ACTOR, type Actor } from "../../lib/actor";
import { log } from "../../lib/logger";

/**
 * The live FX refresh (doc 22 §32.16) with an in-memory settings row, a fixed
 * clock and an injected fetch: nothing here reaches the network or a
 * database. Every rate is synthetic or the documented example.
 */

vi.mock("../readiness.service", () => ({ readinessService: { reevaluateAfterSetting: vi.fn() } }));
vi.mock("../approval.service", () => ({ verifyStepUp: vi.fn() }));
vi.mock("../../repositories/settings.repo", () => ({ settingsRepo: { get: vi.fn(), invalidate: vi.fn() } }));

const NOW = new Date("2026-11-03T06:15:00.000Z");
const H48 = 48 * 3600_000;

const ADMIN: Actor = { type: "admin", id: "00000000-0000-7000-8000-000000000001", roles: ["admin"], permissions: new Set(["pricing.edit"]) };
const VIEWER: Actor = { type: "admin", id: "00000000-0000-7000-8000-000000000002", roles: ["readonly"], permissions: new Set(["reports.view"]) };

function answer(inr: unknown = 94.75, date = "2026-11-02", extra: Record<string, unknown> = {}) {
  return JSON.stringify({ amount: 1.0, base: "USD", date, rates: { INR: inr }, ...extra });
}

function okFetch(body: string, init: ResponseInit = { status: 200 }): FetchLike & { calls: { url: string; init: RequestInit }[] } {
  const calls: { url: string; init: RequestInit }[] = [];
  const f = (async (url: string, req: RequestInit) => {
    calls.push({ url, init: req });
    return new Response(body, { headers: { "content-type": "application/json" }, ...init });
  }) as FetchLike & { calls: typeof calls };
  f.calls = calls;
  return f;
}

/** Never answers; rejects with the signal's reason when the timeout aborts it, like a real fetch. */
const hangingFetch: FetchLike = (_url, init) =>
  new Promise((_resolve, reject) => {
    init.signal?.addEventListener("abort", () => reject(init.signal?.reason));
  });

function row(over: Partial<FxInput> = {}): FxInput {
  return { version: 7, inrPerAed: "26.10", source: "synthetic earlier rate", recordedAt: "2026-11-02T18:15:00.000Z", expiresAt: "2026-11-04T18:15:00.000Z", ...over };
}

interface Harness {
  current: unknown;
  writes: { next: FxInput; actor: Actor; reason: string }[];
  refusals: { actor: Actor; detail: Record<string, unknown> }[];
  reevaluated: string[];
  stepUps: string[];
  cacheDrops: number;
  reads: number;
}

function harness(opts: {
  fetch: FetchLike;
  current?: unknown;
  band?: typeof DEFAULT_FX_BAND | null;
  now?: Date;
  stepUp?: string | null;
  /** Makes the locked write path throw this instead of running. */
  lockError?: unknown;
  reevaluateError?: unknown;
}) {
  const h: Harness = { current: opts.current ?? null, writes: [], refusals: [], reevaluated: [], stepUps: [], cacheDrops: 0, reads: 0 };
  const store: FxStore = {
    async withLockedRow(run) {
      if (opts.lockError) throw opts.lockError;
      return run(h.current, async (next, actor, reason) => {
        h.writes.push({ next, actor, reason });
        h.current = next;
      });
    },
    async read() {
      h.reads += 1;
      return h.current;
    },
    dropCache() {
      h.cacheDrops += 1;
    },
  };
  const svc = createFxRefreshService({
    fetch: opts.fetch,
    timeoutMs: 30,
    now: () => opts.now ?? NOW,
    band: () => (opts.band === undefined ? DEFAULT_FX_BAND : opts.band),
    store,
    async auditRefusal(actor, detail) {
      h.refusals.push({ actor, detail });
    },
    async reevaluate(key) {
      if (opts.reevaluateError) throw opts.reevaluateError;
      h.reevaluated.push(key);
    },
    async stepUp(_actor, code) {
      h.stepUps.push(code);
      return opts.stepUp === undefined ? null : opts.stepUp;
    },
  });
  return { h, svc };
}

let errors: ReturnType<typeof vi.spyOn>;
beforeEach(() => {
  errors = vi.spyOn(log, "error").mockImplementation(() => {});
  vi.spyOn(log, "info").mockImplementation(() => {});
  vi.spyOn(log, "warn").mockImplementation(() => {});
});
afterEach(() => vi.restoreAllMocks());

describe("fetchUsdInr", () => {
  it("makes one GET to exactly the Frankfurter URL, no redirects, uncached, with a timeout signal", async () => {
    const f = okFetch(answer());
    await expect(fetchUsdInr(f)).resolves.toEqual({ ok: true, quote: { date: "2026-11-02", inrPerUsd: "94.75" } });
    expect(f.calls).toHaveLength(1);
    expect(f.calls[0].url).toBe(FRANKFURTER_LATEST_URL);
    expect(new URL(f.calls[0].url)).toMatchObject({ protocol: "https:", host: "api.frankfurter.dev" });
    expect(f.calls[0].init).toMatchObject({ method: "GET", redirect: "error", cache: "no-store" });
    expect(f.calls[0].init.signal).toBeInstanceOf(AbortSignal);
  });

  it.each([
    ["timeout", hangingFetch, "timeout"],
    ["a network error", (async () => { throw new TypeError("fetch failed"); }) as FetchLike, "network"],
    ["a 500", okFetch("oops", { status: 500 }), "http_status"],
    ["a 429", okFetch(answer(), { status: 429 }), "http_status"],
    ["non-JSON", okFetch("<html>maintenance</html>"), "bad_json"],
    ["a wrong shape", okFetch(JSON.stringify({ amount: 1, base: "EUR", date: "2026-11-02", rates: { INR: 94.75 } })), "bad_payload"],
    ["an oversized body", okFetch(answer(94.75, "2026-11-02", { pad: "x".repeat(5000) })), "too_large"],
  ])("reports %s without throwing", async (_label, f, reason) => {
    await expect(fetchUsdInr(f as FetchLike, 30)).resolves.toEqual({ ok: false, reason });
  });

  it("refuses an answer served from another host", async () => {
    const f: FetchLike = async () => {
      const res = new Response(answer());
      Object.defineProperty(res, "url", { value: "https://evil.example/v1/latest" });
      return res;
    };
    await expect(fetchUsdInr(f)).resolves.toEqual({ ok: false, reason: "redirected" });
  });
});

describe("fxRefreshService.refresh", () => {
  it("writes the documented example as a new version: 94.75 → 26.32, recordedAt now, expiresAt +48 h, source text", async () => {
    const { h, svc } = harness({ fetch: okFetch(answer()), current: row() });
    const out = await svc.refresh(SYSTEM_ACTOR, { trigger: "cron" });
    expect(out).toMatchObject({ status: "written", version: 8, inrPerAed: "26.32", previous: "26.10", changed: true, jumpAccepted: false });
    expect(h.writes).toEqual([
      {
        next: {
          version: 8,
          inrPerAed: "26.32",
          source: "ECB via Frankfurter 2026-11-02, USD/INR 94.75 ÷ 3.6725 × 1.02",
          recordedAt: NOW.toISOString(),
          expiresAt: new Date(NOW.getTime() + H48).toISOString(),
        },
        actor: SYSTEM_ACTOR,
        reason: "fx_refresh:cron",
      },
    ]);
    expect(h.cacheDrops).toBe(1);
    expect(h.reevaluated).toEqual([FX_INR_PER_AED_SETTING_KEY]);
  });

  it("first write: no stored row ⇒ version 1, band check only", async () => {
    const { h, svc } = harness({ fetch: okFetch(answer()) });
    await expect(svc.refresh(SYSTEM_ACTOR, { trigger: "cron" })).resolves.toMatchObject({ status: "written", version: 1, previous: null, changed: true });
    expect(h.reevaluated).toHaveLength(1);
  });

  it("a malformed stored row is replaced, continuing its version number", async () => {
    const { h, svc } = harness({ fetch: okFetch(answer()), current: { version: 4, inrPerAed: "about 26" } });
    await expect(svc.refresh(SYSTEM_ACTOR, { trigger: "cron" })).resolves.toMatchObject({ status: "written", version: 5, previous: null });
    expect(h.writes).toHaveLength(1);
  });

  it("idempotent: an unchanged rate still writes a new version that extends the expiry, without re-running readiness", async () => {
    const { h, svc } = harness({ fetch: okFetch(answer()), current: row({ inrPerAed: "26.32" }) });
    const out = await svc.refresh(SYSTEM_ACTOR, { trigger: "cron" });
    expect(out).toMatchObject({ status: "written", version: 8, inrPerAed: "26.32", previous: "26.32", changed: false });
    expect(h.writes[0].next.expiresAt).toBe(new Date(NOW.getTime() + H48).toISOString());
    expect(h.reevaluated).toEqual([]);
  });

  it("an unchanged rate over an expired row re-runs readiness: the row became usable again", async () => {
    const { h, svc } = harness({ fetch: okFetch(answer()), current: row({ inrPerAed: "26.32", expiresAt: "2026-11-03T00:00:00.000Z" }) });
    await expect(svc.refresh(SYSTEM_ACTOR, { trigger: "cron" })).resolves.toMatchObject({ status: "written", changed: false });
    expect(h.reevaluated).toEqual([FX_INR_PER_AED_SETTING_KEY]);
  });

  it.each([
    ["out of the band", { fetch: okFetch(answer(200)), current: null }, ["out_of_band"], true],
    ["a narrower configured band", { fetch: okFetch(answer()), current: null, band: { minHundredths: 2700n, maxHundredths: 3000n } }, ["out_of_band"], true],
    ["a jump above 5% from the stored row", { fetch: okFetch(answer()), current: row({ inrPerAed: "24.00" }) }, ["jump_too_large"], false],
    ["a jump above 5% from an expired row", { fetch: okFetch(answer()), current: row({ inrPerAed: "24.00", recordedAt: "2026-10-30T00:00:00.000Z", expiresAt: "2026-11-01T00:00:00.000Z" }) }, ["jump_too_large"], true],
    ["an ECB date 5 days old", { fetch: okFetch(answer(94.75, "2026-10-29")), current: row() }, ["source_stale"], false],
    ["an ECB date in the future", { fetch: okFetch(answer(94.75, "2026-11-04")), current: row() }, ["source_date_in_future"], false],
  ] as const)("refuses %s, keeps the old row, logs an error and audits the refusal", async (_label, opts, reasons, lapsed) => {
    const before = structuredClone(opts.current);
    const { h, svc } = harness(opts as Parameters<typeof harness>[0]);
    const out = await svc.refresh(SYSTEM_ACTOR, { trigger: "cron" });
    expect(out).toMatchObject({ status: "refused", reasons });
    expect(h.writes).toEqual([]);
    expect(h.current).toEqual(before);
    // Readiness re-runs only because the stored row is missing or expired, never for the refused rate.
    expect(h.reevaluated).toEqual(lapsed ? [FX_INR_PER_AED_SETTING_KEY] : []);
    expect(h.refusals).toEqual([{ actor: SYSTEM_ACTOR, detail: expect.objectContaining({ reasons, trigger: "cron" }) }]);
    expect(errors).toHaveBeenCalledWith("fx.refresh_refused", expect.objectContaining({ reasons }));
  });

  it("reports the move on a refused jump: 24.00 → 26.32 is 9.67%", async () => {
    const { svc } = harness({ fetch: okFetch(answer()), current: row({ inrPerAed: "24.00" }) });
    await expect(svc.refresh(SYSTEM_ACTOR, { trigger: "cron" })).resolves.toEqual({
      status: "refused",
      reasons: ["jump_too_large"],
      computed: "26.32",
      previous: "24.00",
      moveBps: 967,
      sourceDate: "2026-11-02",
    });
  });

  it.each([
    ["a timeout", hangingFetch, "timeout"],
    ["bad JSON", okFetch("{not json"), "bad_json"],
    ["a wrong payload", okFetch(answer("94.75")), "bad_payload"],
    ["an HTTP error", okFetch("", { status: 503 }), "http_status"],
  ])("%s leaves the row unchanged and audits nothing", async (_label, f, reason) => {
    const current = row();
    const { h, svc } = harness({ fetch: f as FetchLike, current });
    await expect(svc.refresh(SYSTEM_ACTOR, { trigger: "cron" })).resolves.toEqual({ status: "failed", reason });
    expect(h.writes).toEqual([]);
    expect(h.current).toBe(current);
    expect(h.refusals).toEqual([]);
    expect(errors).toHaveBeenCalledWith("fx.refresh_failed", { reason, trigger: "cron" });
  });

  it("an invalid band configuration refuses before any fetch", async () => {
    const f = okFetch(answer());
    const { h, svc } = harness({ fetch: f, current: row(), band: null });
    await expect(svc.refresh(SYSTEM_ACTOR, { trigger: "cron" })).resolves.toEqual({ status: "failed", reason: "band_config_invalid" });
    expect(f.calls).toEqual([]);
    expect(h.writes).toEqual([]);
  });

  it("the cron trigger can never accept a jump", async () => {
    const { h, svc } = harness({ fetch: okFetch(answer()), current: row({ inrPerAed: "24.00" }) });
    await expect(svc.refresh(SYSTEM_ACTOR, { trigger: "cron", acceptJumpTo: "26.32" })).resolves.toMatchObject({ status: "refused", reasons: ["jump_too_large"] });
    expect(h.writes).toEqual([]);
  });
});

describe("an expired or missing rate re-runs readiness on runs that write nothing", () => {
  const EXPIRED = row({ recordedAt: "2026-11-01T06:00:00.000Z", expiresAt: "2026-11-03T06:00:00.000Z" });

  const paths = [
    ["a timeout", { fetch: hangingFetch }],
    ["bad JSON", { fetch: okFetch("{not json") }],
    ["an HTTP error", { fetch: okFetch("", { status: 503 }) }],
    ["a guard refusal", { fetch: okFetch(answer(200)) }],
    ["an invalid band", { fetch: okFetch(answer()), band: null }],
  ] as const;

  it.each(paths)("%s with an expired row: readiness re-runs, the row is neither written nor extended", async (_label, opts) => {
    const current = structuredClone(EXPIRED);
    const { h, svc } = harness({ ...(opts as Partial<Parameters<typeof harness>[0]>), fetch: opts.fetch, current });
    const out = await svc.refresh(SYSTEM_ACTOR, { trigger: "cron" });
    expect(out.status).not.toBe("written");
    expect(h.reevaluated).toEqual([FX_INR_PER_AED_SETTING_KEY]);
    expect(h.cacheDrops).toBe(1);
    expect(h.writes).toEqual([]);
    expect(h.current).toBe(current);
    expect(h.current).toEqual(EXPIRED);
  });

  it.each(paths)("%s with no row at all: readiness re-runs and nothing is written", async (_label, opts) => {
    const { h, svc } = harness({ ...(opts as Partial<Parameters<typeof harness>[0]>), fetch: opts.fetch, current: null });
    await svc.refresh(SYSTEM_ACTOR, { trigger: "cron" });
    expect(h.reevaluated).toEqual([FX_INR_PER_AED_SETTING_KEY]);
    expect(h.writes).toEqual([]);
    expect(h.current).toBeNull();
  });

  it.each(paths)("%s with a valid row: readiness is left alone", async (_label, opts) => {
    const { h, svc } = harness({ ...(opts as Partial<Parameters<typeof harness>[0]>), fetch: opts.fetch, current: row() });
    await svc.refresh(SYSTEM_ACTOR, { trigger: "cron" });
    expect(h.reevaluated).toEqual([]);
    expect(h.cacheDrops).toBe(0);
  });

  it("the expiry instant itself counts as lapsed (expiresAt is exclusive, like the margin service)", async () => {
    const { h, svc } = harness({ fetch: hangingFetch, current: row({ expiresAt: NOW.toISOString() }) });
    await svc.refresh(SYSTEM_ACTOR, { trigger: "cron" });
    expect(h.reevaluated).toEqual([FX_INR_PER_AED_SETTING_KEY]);
  });

  // A database error from the locked write. A write conflict (P2002/P2034) is mapped to `failed` instead and takes the non-written path.
  it("an unexpected error still re-runs readiness before it propagates", async () => {
    const { h, svc } = harness({ fetch: okFetch(answer()), current: EXPIRED, lockError: new Error("database gone") });
    await expect(svc.refresh(SYSTEM_ACTOR, { trigger: "cron" })).rejects.toThrow("database gone");
    expect(h.reevaluated).toEqual([FX_INR_PER_AED_SETTING_KEY]);
    expect(h.writes).toEqual([]);
  });

  it("a failing re-run is logged and never turns the outcome into an error", async () => {
    const { h, svc } = harness({ fetch: hangingFetch, current: EXPIRED, reevaluateError: new Error("candidates unavailable") });
    await expect(svc.refresh(SYSTEM_ACTOR, { trigger: "cron" })).resolves.toEqual({ status: "failed", reason: "timeout" });
    expect(errors).toHaveBeenCalledWith("fx.lapsed_rerun_failed", expect.objectContaining({ trigger: "cron" }));
    expect(h.writes).toEqual([]);
  });

  it("a successful write after a lapse re-runs readiness once, from the write path", async () => {
    const { h, svc } = harness({ fetch: okFetch(answer()), current: row({ inrPerAed: "26.32", recordedAt: "2026-11-01T06:00:00.000Z", expiresAt: "2026-11-03T06:00:00.000Z" }) });
    await expect(svc.refresh(SYSTEM_ACTOR, { trigger: "cron" })).resolves.toMatchObject({ status: "written", changed: false });
    expect(h.reevaluated).toEqual([FX_INR_PER_AED_SETTING_KEY]);
    expect(h.reads).toBe(0);
  });
});

describe("fxRefreshService.refreshManually", () => {
  it("needs pricing.edit", async () => {
    const f = okFetch(answer());
    const { h, svc } = harness({ fetch: f, current: row() });
    await expect(svc.refreshManually(VIEWER, {})).rejects.toMatchObject({ code: "FORBIDDEN" });
    expect(f.calls).toEqual([]);
    expect(h.writes).toEqual([]);
  });

  it("runs the same guards as the job, audited as the admin", async () => {
    const { h, svc } = harness({ fetch: okFetch(answer()), current: row() });
    await expect(svc.refreshManually(ADMIN, {})).resolves.toMatchObject({ status: "written", inrPerAed: "26.32" });
    expect(h.writes[0]).toMatchObject({ actor: ADMIN, reason: "fx_refresh:manual" });
    expect(h.stepUps).toEqual([]);
  });

  it("accepts a jump only with a step-up and the exact rate shown; band and age still apply", async () => {
    const { h, svc } = harness({ fetch: okFetch(answer()), current: row({ inrPerAed: "24.00" }) });
    const out = await svc.refreshManually(ADMIN, { acceptJumpTo: "26.32", totpCode: "123456" });
    expect(out).toMatchObject({ status: "written", inrPerAed: "26.32", previous: "24.00", jumpAccepted: true });
    expect(h.stepUps).toEqual(["123456"]);
    expect(h.writes[0]).toMatchObject({ actor: ADMIN, reason: "fx_refresh:jump_accepted" });
    expect(h.writes[0].next.source).toMatch(/\(jump accepted by admin\)$/);

    const stale = harness({ fetch: okFetch(answer(94.75, "2026-10-20")), current: row({ inrPerAed: "24.00" }) });
    await expect(stale.svc.refreshManually(ADMIN, { acceptJumpTo: "26.32", totpCode: "123456" })).resolves.toMatchObject({ status: "refused", reasons: ["source_stale", "jump_too_large"] });
    expect(stale.h.writes).toEqual([]);
  });

  it("refuses when the fresh rate differs from the one accepted", async () => {
    const { h, svc } = harness({ fetch: okFetch(answer(95.5)), current: row({ inrPerAed: "24.00" }) });
    await expect(svc.refreshManually(ADMIN, { acceptJumpTo: "26.32", totpCode: "123456" })).resolves.toEqual({ status: "failed", reason: "accepted_rate_mismatch" });
    expect(h.writes).toEqual([]);
  });

  it("a refused authenticator code fetches nothing, writes nothing and is audited", async () => {
    const f = okFetch(answer());
    const { h, svc } = harness({ fetch: f, current: row({ inrPerAed: "24.00" }), stepUp: "invalid_code" });
    await expect(svc.refreshManually(ADMIN, { acceptJumpTo: "26.32", totpCode: "000000" })).rejects.toMatchObject({ code: "VALIDATION_FAILED" });
    expect(f.calls).toEqual([]);
    expect(h.writes).toEqual([]);
    expect(h.refusals).toEqual([{ actor: ADMIN, detail: { reasons: ["step_up_required"], stepUp: "invalid_code", trigger: "manual" } }]);
  });
});

describe("fail-safe: fx_input_missing after expiry still holds", () => {
  const COSTS = { version: 1, source: "synthetic owner confirmation", recordedAt: "2026-11-01T00:00:00.000Z", lines: [] };
  const POLICY = { version: 1, floorBps: 1500, effectiveFrom: "2026-11-01T00:00:00.000Z" };
  const LINE = { chargedMinor: 1_000_000n, currency: "INR" as const, supplierNetAedMinor: 10_000n, policy: POLICY };

  it("a written rate is used until expiresAt, then INR lines are refused again with no fallback rate", async () => {
    const { h, svc } = harness({ fetch: okFetch(answer()) });
    await svc.refresh(SYSTEM_ACTOR, { trigger: "cron" });
    const written = h.current as FxInput;
    const margin = (now: Date) =>
      createMarginService({ readSetting: async (key) => (key === FX_INR_PER_AED_SETTING_KEY ? written : key === MARGIN_COST_INPUTS_SETTING_KEY ? COSTS : null), now: () => now });

    const inside = await margin(new Date(NOW.getTime() + H48 - 1)).evaluate(LINE);
    expect(inside).toMatchObject({ ok: true, snapshot: { fx: { version: 1, inrPerAed: "26.32" } } });
    await expect(margin(new Date(NOW.getTime() + H48)).evaluate(LINE)).resolves.toEqual({ ok: false, reason: "fx_input_missing" });

    // Refreshes keep failing: the row is not touched, so it lapses on its own.
    const failing = harness({ fetch: hangingFetch, current: written });
    await failing.svc.refresh(SYSTEM_ACTOR, { trigger: "cron" });
    expect(failing.h.current).toBe(written);
  });
});
