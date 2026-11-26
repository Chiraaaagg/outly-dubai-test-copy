import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { apiRequest, assertDisposableDb, cleanupPeople, createCustomer, dbEnabled, params, runId, syntheticPhone, type CustomerFixture } from "../helpers/fixtures";
import { cleanupBusinessRows, db, forbidNetwork, publishedProduct } from "../security/_mercury-fixtures";
import { cleanupCustomerRows, guestSession, instantOrder, setupCustomerFixtures, type CustomerFixtures, type InstantOrder } from "./customer-fixtures";
import { resetEnvCache } from "@/server/lib/env";
import { uuidv7 } from "@/server/lib/ids";

/**
 * Order recovery (F23) through the real routes and the disposable database:
 *
 *  - a contact matching the order's bound, verified contact gets a code (log
 *    and stand-in adapters only; email under the challenge id as the
 *    idempotency key) and the verify grants access in this browser, added
 *    beside any grant it already holds;
 *  - a wrong contact and an unknown reference send nothing and get the same
 *    answer shape, no sooner than the timing floor;
 *  - every verify failure is the same 400 CODE_INVALID; a code is single use;
 *  - limits fail closed; decoys cannot use up the shared (per-order and
 *    global) budgets, and a match over them is dropped silently (R-B5-3);
 *    verifies have a daily cap (R-B5-9);
 *  - customer sign-in refuses a recovery challenge; no log line carries the
 *    contact or the code.
 */

const state = vi.hoisted(() => ({ storeDown: false, exhausted: [] as string[] }));

vi.mock("@/server/lib/rate-limit", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/server/lib/rate-limit")>();
  const { Errors } = await import("@/server/lib/errors");
  return {
    ...actual,
    rateLimit: async (o: Parameters<typeof actual.rateLimit>[0]) => {
      if (state.storeDown) return { allowed: false, remaining: 0, retryAfterSeconds: 30, limit: o.limit, storeUnavailable: true };
      // A budget a test declares used up (simulated: the real buckets are not filled).
      if (state.exhausted.some((prefix) => o.key.startsWith(prefix))) return { allowed: false, remaining: 0, retryAfterSeconds: 30, limit: o.limit };
      return actual.rateLimit(o);
    },
    enforceRateLimit: async (o: Parameters<typeof actual.enforceRateLimit>[0]) => {
      if (state.storeDown) throw Errors.unavailable(30);
      return actual.enforceRateLimit(o);
    },
  };
});

const run = runId();
let ipN = Number.parseInt(run.slice(-4), 16) % 50_000;
const nextIp = () => `198.19.${Math.floor(ipN / 250) % 250}.${(ipN++ % 250) + 1}`;
const savedEnv = { ...process.env };
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

type Prisma = Awaited<ReturnType<typeof db>>;
let prisma: Prisma;
let fx: CustomerFixtures;
let owner: CustomerFixture;
let emailOrder: InstantOrder;
let phoneOrder: InstantOrder;
let limitOrder: InstantOrder;
const EMAIL = () => `zz-sec-${run}-recover@outlyy.test`;
const PHONE = () => syntheticPhone(run, 81);

const startRoute = () => import("@/app/api/recovery/start/route");
const verifyRoute = () => import("@/app/api/recovery/verify/route");
const statusRoute = () => import("@/app/api/orders/[reference]/status/route");

async function start(body: Record<string, unknown>, ip: string = nextIp()) {
  const { POST } = await startRoute();
  const t0 = Date.now();
  const res = await POST(apiRequest("/api/recovery/start", { body, headers: { "x-real-ip": ip } }), params({}));
  return { res, ms: Date.now() - t0 };
}

async function verify(body: unknown, cookie?: string) {
  const { POST } = await verifyRoute();
  return POST(apiRequest("/api/recovery/verify", { body, cookie, headers: { "x-real-ip": nextIp() } }), params({}));
}

async function status(reference: string, cookie?: string) {
  const { GET } = await statusRoute();
  return GET(apiRequest(`/api/orders/${reference}/status`, { cookie, headers: { "x-real-ip": nextIp() } }), params({ reference }));
}

function accessCookie(res: Response): string | null {
  const set = res.headers.getSetCookie().find((c) => c.startsWith("outlyy_ticket_access="));
  return set ? set.split(";")[0] : null;
}

/** Email goes to a stand-in that records the message; it answers like the idempotent adapter. */
async function emailSpy() {
  const { emailAdapter } = await import("@/server/notifications/email.adapter");
  vi.spyOn(emailAdapter, "provider").mockReturnValue("log");
  return vi.spyOn(emailAdapter, "send").mockImplementation((async (_msg: unknown, opts?: { idempotencyKey: string }) => ({ kind: "sent", providerId: `fake-${opts?.idempotencyKey}` })) as never);
}

function codeIn(text: string): string | null {
  return /\b(\d{6})\b/.exec(text)?.[1] ?? null;
}

const logged: string[] = [];

describe.skipIf(!dbEnabled)("order recovery (F23)", () => {
  beforeAll(async () => {
    assertDisposableDb();
    forbidNetwork();
    process.env.TRUST_PROXY_IP_HEADERS = "true";
    delete process.env.RESEND_API_KEY;
    resetEnvCache();
    prisma = await db();
    // Hermetic (R-B5-15): only this suite uses the `rcv_` buckets; start from empty ones so an earlier run in the same window cannot interfere.
    await prisma.$executeRaw`DELETE FROM rate_limit_buckets WHERE bucket_key LIKE 'rcv\_%'`;
    fx = await setupCustomerFixtures(prisma, run, await publishedProduct());
    owner = await createCustomer(run, syntheticPhone(run, 80));
    const g = await guestSession(prisma, fx);
    emailOrder = await instantOrder(prisma, run, fx, { label: "rec-email", owner: { kind: "guest", guestSessionId: g.id }, sagaState: "fulfilled", capturedMinor: 45_000n, bookingState: "confirmed", verified: { channel: "email", contact: EMAIL() } });
    phoneOrder = await instantOrder(prisma, run, fx, { label: "rec-phone", owner: { kind: "customer", customerId: owner.id }, sagaState: "fulfilled", capturedMinor: 45_000n, bookingState: "confirmed", verified: { channel: "phone", contact: PHONE() } });
    limitOrder = await instantOrder(prisma, run, fx, { label: "rec-limit", owner: { kind: "guest", guestSessionId: g.id }, sagaState: "session_created", verified: { channel: "email", contact: `zz-sec-${run}-limit@outlyy.test` } });
    const { log } = await import("@/server/lib/logger");
    for (const level of ["info", "warn", "error", "debug"] as const) {
      const original = log[level].bind(log);
      vi.spyOn(log, level).mockImplementation((msg: string, fields?: Record<string, unknown>) => {
        logged.push(JSON.stringify({ msg, fields }));
        original(msg, fields);
      });
    }
  });

  afterAll(async () => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    process.env = { ...savedEnv };
    resetEnvCache();
    if (!prisma) return;
    await cleanupCustomerRows(prisma, fx);
    await cleanupBusinessRows(run);
    await cleanupPeople(run);
  });

  it("a matching email gets a code under the challenge id as idempotency key; verify grants access beside an existing grant", async () => {
    const send = await emailSpy();
    const { res, ms } = await start({ reference: emailOrder.reference.toLowerCase(), channel: "email", contact: ` ${EMAIL().toUpperCase()} ` });
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("private, no-store");
    const { challengeId } = await res.json();
    expect(challengeId).toMatch(UUID);
    expect(ms).toBeGreaterThanOrEqual(290);
    await vi.waitFor(() => expect(send).toHaveBeenCalledTimes(1));
    const [msg, opts] = send.mock.calls[0] as unknown as [{ to: string; text: string }, { idempotencyKey: string }];
    expect(msg.to).toBe(EMAIL());
    expect(opts).toEqual({ idempotencyKey: challengeId });
    const code = codeIn(msg.text)!;
    const row = await prisma.otpChallenge.findUniqueOrThrow({ where: { id: challengeId } });
    expect(row.phoneE164).toMatch(new RegExp(`^rcv:v1:${emailOrder.id}:email:[0-9a-f]{64}$`));
    expect(row.codeHash).not.toContain(code);

    // The browser already holds a grant for another order: recovery adds, never replaces.
    const { capabilityService } = await import("@/server/services/capability.service");
    const other = await capabilityService.mint(prisma, { orderId: phoneOrder.id, purpose: "view_status", issuedFor: "status_notification" });
    const otherExchange = await capabilityService.exchange(other.token);
    if (!otherExchange.ok) throw new Error("exchange refused");
    const before = `outlyy_ticket_access=${otherExchange.cookieValue}`;
    const emailedLink = await capabilityService.mint(prisma, { orderId: emailOrder.id, purpose: "download_tickets", issuedFor: "ticket_notification" });

    const ok = await verify({ challengeId, code }, before);
    expect(ok.status).toBe(200);
    expect(await ok.json()).toEqual({ reference: emailOrder.reference });
    const cookie = accessCookie(ok)!;
    expect(cookie.split("=")[1].split("~")).toHaveLength(2);
    const set = ok.headers.getSetCookie().find((c) => c.startsWith("outlyy_ticket_access="))!;
    expect(set).toMatch(/HttpOnly/i);
    expect(set).toMatch(/SameSite=Strict/i);
    expect((await status(emailOrder.reference, cookie)).status).toBe(200);
    expect((await status(phoneOrder.reference, cookie)).status).toBe(200);
    const body = await (await status(emailOrder.reference, cookie)).json();
    expect(body.items[0].tickets).toBeDefined();

    // The grant is for this order only, minted without superseding the emailed link.
    const grants = await prisma.guestCapabilityGrant.findMany({ where: { orderId: emailOrder.id } });
    expect(grants.find((g) => g.id === emailedLink.grantId)?.revokedAt).toBeNull();
    expect(grants.filter((g) => g.purpose === "download_tickets" && g.revokedAt === null)).toHaveLength(2);

    // Single use: the same code again is the uniform refusal.
    const replay = await verify({ challengeId, code });
    expect(replay.status).toBe(400);
    expect(await replay.json()).toMatchObject({ error: { code: "CODE_INVALID" } });
  });

  it("a matching phone gets a code through the log adapter; customer sign-in refuses the recovery challenge", async () => {
    const { log } = await import("@/server/lib/logger");
    const { res } = await start({ reference: phoneOrder.reference, channel: "phone", contact: PHONE() });
    const { challengeId } = await res.json();
    let code: string | null = null;
    await vi.waitFor(() => {
      const line = vi.mocked(log.debug).mock.calls.find(([m]) => String(m).startsWith("sms.log_adapter.otp_code"));
      code = line ? String((line[1] as { devOtpCode?: string }).devOtpCode) : null;
      expect(code).toMatch(/^\d{6}$/);
    });
    const { customerAuthService } = await import("@/server/services/customer-auth.service");
    await expect(customerAuthService.verifyOtp({ challengeId, code: code!, ip: nextIp() })).rejects.toMatchObject({ code: "NOT_FOUND" });
    expect(await prisma.customer.count({ where: { phoneE164: { startsWith: "rcv:" } } })).toBe(0);
    const ok = await verify({ challengeId, code });
    expect(ok.status).toBe(200);
    expect(await ok.json()).toEqual({ reference: phoneOrder.reference });
  });

  it("a wrong contact and an unknown reference send nothing, write nothing and get the same answer", async () => {
    const send = await emailSpy();
    send.mockClear();
    const decoys = [
      await start({ reference: emailOrder.reference, channel: "email", contact: `zz-sec-${run}-someone-else@outlyy.test` }),
      await start({ reference: emailOrder.reference, channel: "phone", contact: PHONE() }),
      await start({ reference: "OUT-10000017", channel: "email", contact: EMAIL() }),
      await start({ reference: "nonsense", channel: "email", contact: EMAIL() }),
    ];
    const ids: string[] = [];
    for (const { res, ms } of decoys) {
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(Object.keys(body)).toEqual(["challengeId"]);
      expect(body.challengeId).toMatch(UUID);
      expect(ms, "decoys answer no sooner than a real start").toBeGreaterThanOrEqual(290);
      ids.push(body.challengeId);
    }
    await new Promise((r) => setTimeout(r, 50));
    expect(send).not.toHaveBeenCalled();
    expect(await prisma.otpChallenge.count({ where: { id: { in: ids } } })).toBe(0);
    // A decoy id verifies like any wrong code.
    const res = await verify({ challengeId: ids[0], code: "123456" });
    expect(res.status).toBe(400);
  });

  it("verifies with unknown challenge ids never charge the global verify budget (R-B5-3 recheck)", async () => {
    const globalCount = async () =>
      (await prisma.rateLimitBucket.aggregate({ where: { key: "rcv_verify:global" }, _sum: { count: true } }))._sum.count ?? 0;
    const before = await globalCount();
    for (let i = 0; i < 40; i++) expect((await verify({ challengeId: uuidv7(), code: "123456" })).status).toBe(400);
    expect(await globalCount()).toBe(before);
  });

  it("every verify failure is the same 400 CODE_INVALID", async () => {
    const send = await emailSpy();
    send.mockClear();
    const { res } = await start({ reference: limitOrder.reference, channel: "email", contact: `zz-sec-${run}-limit@outlyy.test` });
    const { challengeId } = await res.json();
    await vi.waitFor(() => expect(send).toHaveBeenCalledTimes(1));
    const code = codeIn((send.mock.calls[0][0] as { text: string }).text)!;
    const wrong = String((Number(code) + 1) % 1_000_000).padStart(6, "0");
    const answers: string[] = [];
    for (const body of [{ challengeId, code: wrong }, { challengeId: uuidv7(), code }, { challengeId: "x", code }, { challengeId, code: "12" }, { challengeId }, { challengeId, code, extra: 1 }]) {
      const r = await verify(body);
      expect(r.status, JSON.stringify(body)).toBe(400);
      expect(accessCookie(r)).toBeNull();
      answers.push(await r.text());
    }
    expect(new Set(answers).size).toBe(1);
    expect(JSON.parse(answers[0])).toMatchObject({ error: { code: "CODE_INVALID" } });
    // The right code still works after a wrong one (attempts are capped, not burned by one miss).
    expect((await verify({ challengeId, code })).status).toBe(200);
  });

  it("limits fail closed: start refuses and verify answers CODE_INVALID while the store is down", async () => {
    state.storeDown = true;
    try {
      const { res } = await start({ reference: emailOrder.reference, channel: "email", contact: EMAIL() });
      expect(res.status).toBe(503);
      expect((await verify({ challengeId: uuidv7(), code: "123456" })).status).toBe(400);
    } finally {
      state.storeDown = false;
    }
  });

  it("30 IPs of decoys against a reference do not block that customer's real recovery (R-B5-3)", async () => {
    const g = await guestSession(prisma, fx);
    const victimEmail = `zz-sec-${run}-victim@outlyy.test`;
    const victim = await instantOrder(prisma, run, fx, { label: "rec-victim", owner: { kind: "guest", guestSessionId: g.id }, sagaState: "fulfilled", capturedMinor: 45_000n, bookingState: "confirmed", verified: { channel: "email", contact: victimEmail } });
    const send = await emailSpy();
    send.mockClear();
    const octet = (Number.parseInt(run.slice(-2), 16) % 200) + 20;
    // 30 IPs × 10 decoys = 300, the whole global window budget had decoys been charged to it.
    const chains = Array.from({ length: 30 }, async (_v, ip) => {
      const out: number[] = [];
      for (let i = 0; i < 10; i++) out.push((await start({ reference: victim.reference, channel: "email", contact: `zz-sec-${run}-decoy-${ip}-${i}@outlyy.test` }, `198.20.${octet}.${ip + 1}`)).res.status);
      return out;
    });
    const statuses = (await Promise.all(chains)).flat();
    expect(statuses.every((s) => s === 200)).toBe(true);
    expect(send).not.toHaveBeenCalled();

    const { res } = await start({ reference: victim.reference, channel: "email", contact: victimEmail });
    expect(res.status).toBe(200);
    const { challengeId } = await res.json();
    await vi.waitFor(() => expect(send).toHaveBeenCalledTimes(1));
    expect(await prisma.otpChallenge.findUnique({ where: { id: challengeId } })).not.toBeNull();
  }, 60_000);

  it("a match over the shared per-order or global budget is dropped silently: same answer, nothing sent, an alert logged", async () => {
    const send = await emailSpy();
    for (const prefix of ["rcv_start:order:", "rcv_start:global"]) {
      send.mockClear();
      state.exhausted = [prefix];
      const before = logged.length;
      try {
        const { res, ms } = await start({ reference: emailOrder.reference, channel: "email", contact: EMAIL() });
        expect(res.status, prefix).toBe(200);
        const body = await res.json();
        expect(Object.keys(body)).toEqual(["challengeId"]);
        expect(body.challengeId).toMatch(UUID);
        expect(ms).toBeGreaterThanOrEqual(290);
        await new Promise((r) => setTimeout(r, 50));
        expect(send).not.toHaveBeenCalled();
        expect(await prisma.otpChallenge.count({ where: { id: body.challengeId } })).toBe(0);
        expect(logged.slice(before).some((l) => l.includes("recovery.start_budget_exhausted"))).toBe(true);
      } finally {
        state.exhausted = [];
      }
    }
  });

  it("a daily verify cap per order and per contact fails closed with the same refusal (R-B5-9)", async () => {
    const g = await guestSession(prisma, fx);
    const contact = `zz-sec-${run}-daily@outlyy.test`;
    const o = await instantOrder(prisma, run, fx, { label: "rec-daily", owner: { kind: "guest", guestSessionId: g.id }, sagaState: "fulfilled", capturedMinor: 45_000n, bookingState: "confirmed", verified: { channel: "email", contact } });
    const send = await emailSpy();
    send.mockClear();
    const { res } = await start({ reference: o.reference, channel: "email", contact });
    const { challengeId } = await res.json();
    await vi.waitFor(() => expect(send).toHaveBeenCalledTimes(1));
    const code = codeIn((send.mock.calls[0][0] as { text: string }).text)!;
    const wrong = await (await verify({ challengeId, code: String((Number(code) + 1) % 1_000_000).padStart(6, "0") })).text();
    for (const prefix of ["rcv_verify:order_day:", "rcv_verify:contact_day:"]) {
      state.exhausted = [prefix];
      try {
        const capped = await verify({ challengeId, code });
        expect(capped.status, prefix).toBe(400);
        expect(await capped.text()).toBe(wrong);
        expect(accessCookie(capped)).toBeNull();
      } finally {
        state.exhausted = [];
      }
    }
    expect((await verify({ challengeId, code })).status).toBe(200);
  });

  it("no log line carried the contact or a code", () => {
    const text = logged.join("\n");
    expect(text.length).toBeGreaterThan(0);
    expect(text).not.toContain(EMAIL());
    expect(text).not.toContain(PHONE());
    expect(text.replace(/"devOtpCode":"\d{6}"/g, "")).not.toMatch(/"code":"\d{6}"/);
  });
});
