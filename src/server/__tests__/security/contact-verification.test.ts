import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { createHash } from "node:crypto";
import { assertDisposableDb, cleanupPeople, createCustomer, dbEnabled, runId, syntheticPhone, type CustomerFixture } from "../helpers/fixtures";
import { cleanupBusinessRows, db, forbidNetwork, makeOrder } from "./_mercury-fixtures";
import { uuidv7 } from "../../lib/ids";
import type { QuoteSnapshot } from "../../quotes/contracts";

/**
 * Order-bound contact verification (doc 22 §23 B2, TKT-4, F54, F57) against
 * the disposable database, with the log SMS adapter and a log-only email
 * stand-in. Synthetic numbers, addresses and amounts only.
 *
 * Covers: the happy path for both channels, no customer row ever created,
 * only the contact hash stored, owner binding, decoy answers, attempt cap,
 * single use, quote expiry, per-IP and per-owner limits ahead of the global
 * counter, per-quote and per-contact limits (checkout's own, never sign-in's),
 * fail-closed limiter, the non-production allowlist, sign-in and checkout
 * each refusing the other's challenge, and binding to the order.
 */

const state = vi.hoisted(() => ({ storeDown: false }));

vi.mock("../../lib/rate-limit", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../lib/rate-limit")>();
  const { Errors } = await import("../../lib/errors");
  return {
    ...actual,
    rateLimit: async (o: Parameters<typeof actual.rateLimit>[0]) =>
      state.storeDown ? { allowed: false, remaining: 0, retryAfterSeconds: 30, limit: o.limit, storeUnavailable: true } : actual.rateLimit(o),
    enforceRateLimit: async (o: Parameters<typeof actual.enforceRateLimit>[0]) => {
      if (state.storeDown) throw Errors.unavailable(30);
      return actual.enforceRateLimit(o);
    },
  };
});

const run = runId();
const sha = (s: string) => createHash("sha256").update(s).digest("hex");
type Prisma = Awaited<ReturnType<typeof db>>;
type Owner = QuoteSnapshot["owner"];

let prisma: Prisma;
let svc: typeof import("../../services/contact-verification.service").contactVerificationService;
let guests: typeof import("../../services/guest-session.service").guestSessionService;
let customer: CustomerFixture;
const quoteIds: string[] = [];
const guestIds: string[] = [];
let phoneN = 70;
let emailN = 0;
// Start each run at a different point of the address range, so per-IP buckets left by an
// earlier run inside the same 15-minute window are not reused.
let ipN = Number.parseInt(run.slice(-4), 16) % 50_000;

const nextPhone = () => syntheticPhone(run, phoneN++);
const nextEmail = () => `zz-sec-${run}-${emailN++}@outlyy.test`;
/** A fresh documentation-range IP per call, so the per-IP limit only bites in the test that aims at it. */
const nextIp = () => `198.18.${Math.floor(ipN / 250) % 250}.${(ipN++ % 250) + 1}`;

async function guestOwner(): Promise<Owner> {
  const g = await guests.create();
  guestIds.push(g.guestSessionId);
  return guests.owner(g);
}

async function makeQuote(owner: Owner, opts: { expired?: boolean; status?: string; usedByOrderId?: string } = {}) {
  const id = uuidv7();
  const now = Date.now();
  await prisma.quote.create({
    data: {
      id,
      fingerprint: sha(`quote:${run}:${id}`),
      ownerKind: owner.kind,
      customerId: owner.kind === "customer" ? owner.customerId : null,
      guestSessionId: owner.kind === "guest" ? owner.guestSessionId : null,
      currency: "AED",
      totalMinor: 10_000n,
      lines: [],
      request: { lines: [] },
      status: opts.status ?? "active",
      usedByOrderId: opts.usedByOrderId ?? null,
      createdAt: new Date(now - 3_600_000),
      expiresAt: new Date(opts.expired ? now - 1_000 : now + 600_000),
    },
  });
  quoteIds.push(id);
  return id;
}

/** Starts a phone challenge and reads the code from the log adapter's dev-only line. */
async function startPhone(quoteId: string, owner: Owner, phone: string) {
  const { log } = await import("../../lib/logger");
  const debug = vi.spyOn(log, "debug");
  try {
    const { challengeId } = await svc.start({ ip: nextIp(), quoteId, channel: "phone", contact: phone, owner });
    const logged = debug.mock.calls.find(([m]) => String(m).startsWith("sms.log_adapter.otp_code"));
    return { challengeId, code: logged ? String((logged[1] as { devOtpCode?: string }).devOtpCode) : null };
  } finally {
    debug.mockRestore();
  }
}

/** Email goes through a stand-in that records the message instead of any provider. */
async function startEmail(quoteId: string, owner: Owner, email: string) {
  const { emailAdapter } = await import("../../notifications/email.adapter");
  const provider = vi.spyOn(emailAdapter, "provider").mockReturnValue("log");
  // The idempotent outbox path (TKT-6): a typed outcome, never a throw.
  const send = vi.spyOn(emailAdapter, "send").mockImplementation((async (_msg: unknown, opts?: { idempotencyKey: string }) => ({ kind: "sent", providerId: `log-${opts?.idempotencyKey}` })) as never);
  try {
    const { challengeId } = await svc.start({ ip: nextIp(), quoteId, channel: "email", contact: email, owner });
    const text = send.mock.calls[0]?.[0].text ?? "";
    // Sent under the challenge id as the provider idempotency key, so a retry can never send a second email.
    if (send.mock.calls.length) expect((send.mock.calls[0] as unknown[])[1]).toEqual({ idempotencyKey: challengeId });
    return { challengeId, code: /\b(\d{6})\b/.exec(text)?.[1] ?? null, sent: send.mock.calls.length };
  } finally {
    provider.mockRestore();
    send.mockRestore();
  }
}

const wrongCode = (code: string) => String((Number(code) + 1) % 1_000_000).padStart(6, "0");

describe.skipIf(!dbEnabled)("contact verification (TKT-4, B2)", () => {
  beforeAll(async () => {
    assertDisposableDb();
    forbidNetwork();
    prisma = await db();
    // Checkout counters only (never sign-in): earlier runs in the same window would
    // otherwise accumulate in the shared global buckets. Disposable database only.
    await prisma.rateLimitBucket.deleteMany({ where: { key: { startsWith: "ocv_" } } });
    svc = (await import("../../services/contact-verification.service")).contactVerificationService;
    guests = (await import("../../services/guest-session.service")).guestSessionService;
    customer = await createCustomer(run, syntheticPhone(run, 69));
  });

  afterEach(() => {
    state.storeDown = false;
  });

  afterAll(async () => {
    vi.unstubAllGlobals();
    await prisma.orderContactVerification.deleteMany({ where: { quoteId: { in: quoteIds } } });
    for (const id of quoteIds) await prisma.otpChallenge.deleteMany({ where: { phoneE164: { startsWith: `ocv:v1:${id}:` } } });
    await prisma.quote.deleteMany({ where: { id: { in: quoteIds } } });
    await prisma.guestSession.deleteMany({ where: { id: { in: guestIds } } });
    await cleanupBusinessRows(run);
    await cleanupPeople(run);
  });

  it("phone: verifies for the quote owner, stores only the hash, and creates no customer", async () => {
    const owner = await guestOwner();
    const quoteId = await makeQuote(owner);
    const phone = nextPhone();
    const customersBefore = await prisma.customer.count();

    const { challengeId, code } = await startPhone(quoteId, owner, phone);
    expect(code).toMatch(/^\d{6}$/);
    const challenge = await prisma.otpChallenge.findUniqueOrThrow({ where: { id: challengeId } });
    expect(challenge.phoneE164).toBe(`ocv:v1:${quoteId}:phone:${sha(phone)}`);
    expect(challenge.phoneE164).not.toContain(phone.slice(1));

    const v = await svc.verify({ ip: nextIp(), challengeId, code: code!, owner });
    expect(v).toMatchObject({ quoteId, channel: "phone", contactHash: sha(phone), method: "otp_sms" });
    const row = await prisma.orderContactVerification.findUniqueOrThrow({ where: { quoteId_channel: { quoteId, channel: "phone" } } });
    expect(row.orderId).toBeNull();
    expect(JSON.stringify(row)).not.toContain(phone.slice(1));

    expect(await prisma.customer.count()).toBe(customersBefore);
    expect(await prisma.customer.count({ where: { phoneE164: phone } })).toBe(0);
    await expect(svc.forQuote(quoteId)).resolves.toEqual([v]);
  });

  it("email: method email_code, contact normalised before hashing", async () => {
    const owner: Owner = { kind: "customer", customerId: customer.id };
    const quoteId = await makeQuote(owner);
    const email = nextEmail();
    const { challengeId, code, sent } = await startEmail(quoteId, owner, `  ${email.toUpperCase()} `);
    expect(sent).toBe(1);
    const v = await svc.verify({ ip: nextIp(), challengeId, code: code!, owner });
    expect(v).toMatchObject({ channel: "email", method: "email_code", contactHash: sha(email) });
  });

  it("another owner's quote, an unknown quote or an expired quote gets a decoy id and nothing is sent", async () => {
    const owner = await guestOwner();
    const stranger = await guestOwner();
    const quoteId = await makeQuote(owner);
    const expired = await makeQuote(owner, { expired: true });

    for (const [q, who] of [[quoteId, stranger], [uuidv7(), owner], [expired, owner]] as const) {
      const r = await startPhone(q, who, nextPhone());
      expect(r.code).toBeNull();
      expect(await prisma.otpChallenge.findUnique({ where: { id: r.challengeId } })).toBeNull();
      await expect(svc.verify({ ip: nextIp(), challengeId: r.challengeId, code: "123456", owner: who })).resolves.toEqual({ refused: "invalid" });
    }
    // A revoked guest session no longer owns its quote.
    const revokedOwner = await guestOwner();
    const q2 = await makeQuote(revokedOwner);
    await guests.revokeById((revokedOwner as { guestSessionId: string }).guestSessionId);
    expect((await startPhone(q2, revokedOwner, nextPhone())).code).toBeNull();
  });

  it("verify is bound to the owner: the right code from another owner is refused", async () => {
    const owner = await guestOwner();
    const quoteId = await makeQuote(owner);
    const { challengeId, code } = await startPhone(quoteId, owner, nextPhone());
    await expect(svc.verify({ ip: nextIp(), challengeId, code: code!, owner: await guestOwner() })).resolves.toEqual({ refused: "invalid" });
    await expect(svc.verify({ ip: nextIp(), challengeId, code: code!, owner: { kind: "customer", customerId: customer.id } })).resolves.toEqual({ refused: "invalid" });
    expect(await prisma.orderContactVerification.count({ where: { quoteId } })).toBe(0);
    await expect(svc.verify({ ip: nextIp(), challengeId, code: code!, owner })).resolves.toMatchObject({ quoteId });
  });

  it("wrong codes count against the attempt cap; a correct code after the cap is refused", async () => {
    const { env } = await import("../../lib/env");
    const max = env().OTP_MAX_ATTEMPTS || 5;
    const owner = await guestOwner();
    const quoteId = await makeQuote(owner);
    const { challengeId, code } = await startPhone(quoteId, owner, nextPhone());
    for (let i = 0; i < max; i++) await expect(svc.verify({ ip: nextIp(), challengeId, code: wrongCode(code!), owner })).resolves.toEqual({ refused: "invalid" });
    await expect(svc.verify({ ip: nextIp(), challengeId, code: code!, owner })).resolves.toEqual({ refused: "rate_limited" });
    expect(await prisma.orderContactVerification.count({ where: { quoteId } })).toBe(0);
  });

  it("a code is single use, and a new challenge retires the previous one", async () => {
    const owner = await guestOwner();
    const quoteId = await makeQuote(owner);
    const phone = nextPhone();
    const first = await startPhone(quoteId, owner, phone);
    const second = await startPhone(quoteId, owner, phone);
    await expect(svc.verify({ ip: nextIp(), challengeId: first.challengeId, code: first.code!, owner })).resolves.toEqual({ refused: "invalid" });
    await expect(svc.verify({ ip: nextIp(), challengeId: second.challengeId, code: second.code!, owner })).resolves.toMatchObject({ quoteId });
    await expect(svc.verify({ ip: nextIp(), challengeId: second.challengeId, code: second.code!, owner })).resolves.toEqual({ refused: "invalid" });
  });

  it("a quote that expires or is superseded after the code was sent answers `expired`", async () => {
    const owner = await guestOwner();
    const quoteId = await makeQuote(owner);
    const { challengeId, code } = await startPhone(quoteId, owner, nextPhone());
    await prisma.quote.update({ where: { id: quoteId }, data: { status: "superseded" } });
    await expect(svc.verify({ ip: nextIp(), challengeId, code: code!, owner })).resolves.toEqual({ refused: "expired" });
  });

  it("per-quote start limit", async () => {
    const owner = await guestOwner();
    const quoteId = await makeQuote(owner);
    for (let i = 0; i < 5; i++) expect((await startEmail(quoteId, owner, nextEmail())).sent).toBe(1);
    await expect(startEmail(quoteId, owner, nextEmail())).rejects.toMatchObject({ code: "RATE_LIMITED" });
  });

  it("per-contact start limit across quotes, in checkout's own namespace, separate from sign-in", async () => {
    const { env } = await import("../../lib/env");
    const { rateLimit } = await import("../../lib/rate-limit");
    const limit = env().OTP_RATE_LIMIT_PER_PHONE_PER_15MIN;
    let owner = await guestOwner();
    const email = nextEmail();
    for (let i = 0; i < limit; i++) expect((await startEmail(await makeQuote(owner), owner, email)).sent).toBe(1);
    await expect(startEmail(await makeQuote(owner), owner, email)).rejects.toMatchObject({ code: "RATE_LIMITED" });

    // Checkout codes to a phone never spend its sign-in budget...
    owner = await guestOwner();
    const phone = nextPhone();
    const signInKey = `otp_request:phone:${sha(phone).slice(0, 16)}`;
    for (let i = 0; i < limit; i++) expect((await startPhone(await makeQuote(owner), owner, phone)).code).not.toBeNull();
    await expect(startPhone(await makeQuote(owner), owner, phone)).rejects.toMatchObject({ code: "RATE_LIMITED" });
    expect((await rateLimit({ key: signInKey, limit, windowSeconds: 900 })).remaining).toBe(limit - 1);

    // ...and a phone that used up its sign-in budget can still verify at checkout.
    owner = await guestOwner();
    const other = nextPhone();
    for (let i = 0; i < limit; i++) await rateLimit({ key: `otp_request:phone:${sha(other).slice(0, 16)}`, limit, windowSeconds: 900 });
    expect((await startPhone(await makeQuote(owner), owner, other)).code).not.toBeNull();
  });

  it("a decoy start (another owner's or an unknown quote) spends no per-contact or per-quote budget", async () => {
    const { env } = await import("../../lib/env");
    const limit = env().OTP_RATE_LIMIT_PER_PHONE_PER_15MIN;
    const victim = await guestOwner();
    const quoteId = await makeQuote(victim);
    const phone = nextPhone();
    for (let i = 0; i < limit + 6; i++) {
      const attacker = await guestOwner();
      await svc.start({ ip: nextIp(), quoteId: i % 2 ? quoteId : uuidv7(), channel: "phone", contact: phone, owner: attacker });
    }
    expect((await startPhone(quoteId, victim, phone)).code).not.toBeNull();
  });

  it("per-IP and per-owner limits refuse before the global counter is charged", async () => {
    const windowStart = () => new Date(Math.floor(Date.now() / 900_000) * 900_000);
    const globalCount = async () =>
      (await prisma.rateLimitBucket.findUnique({ where: { key_windowStart: { key: "ocv_start:global", windowStart: windowStart() } } }))?.count ?? 0;
    const decoy = () => ({ quoteId: uuidv7(), channel: "email" as const, contact: nextEmail() });
    const stranger = (): Owner => ({ kind: "guest", guestSessionId: uuidv7() });

    // One IP, many owners.
    const ip = nextIp();
    for (let i = 0; i < 20; i++) await svc.start({ ...decoy(), ip, owner: stranger() });
    let before = await globalCount();
    await expect(svc.start({ ...decoy(), ip, owner: stranger() })).rejects.toMatchObject({ code: "RATE_LIMITED" });
    expect(await globalCount()).toBe(before);

    // One owner, many IPs.
    const owner = stranger();
    for (let i = 0; i < 10; i++) await svc.start({ ...decoy(), ip: nextIp(), owner });
    before = await globalCount();
    await expect(svc.start({ ...decoy(), ip: nextIp(), owner })).rejects.toMatchObject({ code: "RATE_LIMITED" });
    expect(await globalCount()).toBe(before);

    // verify: the same order, answered as `rate_limited`.
    const vip = nextIp();
    for (let i = 0; i < 30; i++) await svc.verify({ ip: vip, challengeId: uuidv7(), code: "123456", owner: stranger() });
    await expect(svc.verify({ ip: vip, challengeId: uuidv7(), code: "123456", owner: stranger() })).resolves.toEqual({ refused: "rate_limited" });
    const vowner = stranger();
    for (let i = 0; i < 30; i++) await svc.verify({ ip: nextIp(), challengeId: uuidv7(), code: "123456", owner: vowner });
    await expect(svc.verify({ ip: nextIp(), challengeId: uuidv7(), code: "123456", owner: vowner })).resolves.toEqual({ refused: "rate_limited" });
  });

  it("fails closed when the limiter store is down", async () => {
    const owner = await guestOwner();
    const quoteId = await makeQuote(owner);
    const { challengeId, code } = await startPhone(quoteId, owner, nextPhone());
    state.storeDown = true;
    await expect(startPhone(quoteId, owner, nextPhone())).rejects.toMatchObject({ code: "UNAVAILABLE" });
    await expect(svc.verify({ ip: nextIp(), challengeId, code: code!, owner })).resolves.toEqual({ refused: "rate_limited" });
    expect(await prisma.orderContactVerification.count({ where: { quoteId } })).toBe(0);
  });

  it("outside production a real provider sends only to allowlisted recipients", async () => {
    const { emailAdapter } = await import("../../notifications/email.adapter");
    const provider = vi.spyOn(emailAdapter, "provider").mockReturnValue("resend");
    const send = vi.spyOn(emailAdapter, "send").mockRejectedValue(new Error("must not send"));
    try {
      const owner = await guestOwner();
      const quoteId = await makeQuote(owner);
      const { challengeId } = await svc.start({ ip: nextIp(), quoteId, channel: "email", contact: `zz-sec-${run}@not-allowlisted.invalid`, owner });
      expect(send).not.toHaveBeenCalled();
      expect(await prisma.otpChallenge.findUnique({ where: { id: challengeId } })).not.toBeNull();
    } finally {
      provider.mockRestore();
      send.mockRestore();
    }
  });

  it("a failed send retires the code (F57)", async () => {
    const { emailAdapter } = await import("../../notifications/email.adapter");
    const provider = vi.spyOn(emailAdapter, "provider").mockReturnValue("log");
    const send = vi.spyOn(emailAdapter, "send").mockRejectedValue(new Error("provider down"));
    const { customerRepo } = await import("../../repositories/customer.repo");
    const retire = vi.spyOn(customerRepo, "consumeChallenge");
    const { log } = await import("../../lib/logger");
    const logError = vi.spyOn(log, "error");
    try {
      const owner = await guestOwner();
      const quoteId = await makeQuote(owner);
      const outcome = await svc.start({ ip: nextIp(), quoteId, channel: "email", contact: nextEmail(), owner }).then(
        (r) => ({ resolved: r }),
        (e: { code?: string; message?: string }) => ({ code: e.code, message: e.message }),
      );
      // A RATE_LIMITED code means a shared bucket ran out; a resolved decoy id means the quote or guest was not live.
      expect(outcome, `start must fail with the send error; send called ${send.mock.calls.length} time(s)`).toMatchObject({ code: "error" });
      const rows = await prisma.otpChallenge.findMany({ where: { phoneE164: { startsWith: `ocv:v1:${quoteId}:` } }, select: { createdAt: true, consumedAt: true } });
      const retired = await Promise.allSettled(retire.mock.results.map((r) => r.value));
      const detail = JSON.stringify({ rows, retired, logged: logError.mock.calls.map(([m]) => m) });
      expect(rows.length, `exactly one challenge row: ${detail}`).toBe(1);
      expect(rows.filter((r) => r.consumedAt === null).length, `the unsent code must be retired: ${detail}`).toBe(0);
    } finally {
      provider.mockRestore();
      send.mockRestore();
      retire.mockRestore();
      logError.mockRestore();
    }
  });

  it("email takes the idempotent path: a definite failure retires the code (F57); an unknown answer is re-sent once under the same key and keeps it", async () => {
    const { emailAdapter } = await import("../../notifications/email.adapter");
    const provider = vi.spyOn(emailAdapter, "provider").mockReturnValue("log");
    const send = vi.spyOn(emailAdapter, "send");
    try {
      send.mockResolvedValue({ kind: "failed", retryable: false, httpStatus: 422, reason: "rejected" } as never);
      const owner = await guestOwner();
      const quoteId = await makeQuote(owner);
      await expect(svc.start({ ip: nextIp(), quoteId, channel: "email", contact: nextEmail(), owner })).rejects.toMatchObject({ code: "error" });
      expect(await prisma.otpChallenge.count({ where: { phoneE164: { startsWith: `ocv:v1:${quoteId}:` }, consumedAt: null } })).toBe(0);

      send.mockReset();
      send.mockResolvedValue({ kind: "unknown", httpStatus: null, reason: "timeout" } as never);
      const owner2 = await guestOwner();
      const quote2 = await makeQuote(owner2);
      const { challengeId } = await svc.start({ ip: nextIp(), quoteId: quote2, channel: "email", contact: nextEmail(), owner: owner2 });
      expect(send).toHaveBeenCalledTimes(2);
      const [first, second] = send.mock.calls as unknown as Array<[{ html: string; text: string }, { idempotencyKey: string }]>;
      expect(first[1]).toEqual({ idempotencyKey: challengeId });
      expect(second[1]).toEqual({ idempotencyKey: challengeId });
      expect(second[0]).toEqual(first[0]);
      expect((await prisma.otpChallenge.findUniqueOrThrow({ where: { id: challengeId } })).consumedAt, "the email may have arrived: the code stays usable").toBeNull();
      // The code is a secret: no notification row carries it.
      const code = /\b(\d{6})\b/.exec(first[0].text)![1];
      const rows = await prisma.$queryRaw<{ n: bigint }[]>`SELECT count(*) AS n FROM notifications WHERE created_at > now() - interval '5 minutes' AND payload::text LIKE ${`%${code}%`}`;
      expect(Number(rows[0].n)).toBe(0);
    } finally {
      provider.mockRestore();
      send.mockRestore();
    }
  });

  it("a transient error while retiring an unsent code is retried, not swallowed (F57)", async () => {
    const { emailAdapter } = await import("../../notifications/email.adapter");
    const { customerRepo } = await import("../../repositories/customer.repo");
    const provider = vi.spyOn(emailAdapter, "provider").mockReturnValue("log");
    const send = vi.spyOn(emailAdapter, "send").mockRejectedValue(new Error("provider down"));
    const retire = vi.spyOn(customerRepo, "consumeChallenge").mockRejectedValueOnce(new Error("simulated pool timeout (test)"));
    try {
      const owner = await guestOwner();
      const quoteId = await makeQuote(owner);
      await expect(svc.start({ ip: nextIp(), quoteId, channel: "email", contact: nextEmail(), owner })).rejects.toMatchObject({ code: "error" });
      expect(retire, "one failed retire and one retry").toHaveBeenCalledTimes(2);
      const open = await prisma.otpChallenge.count({ where: { phoneE164: { startsWith: `ocv:v1:${quoteId}:` }, consumedAt: null } });
      expect(open, "the retry must retire the unsent code").toBe(0);
    } finally {
      provider.mockRestore();
      send.mockRestore();
      retire.mockRestore();
    }
  });

  it("customer sign-in refuses a verification challenge and opens no account", async () => {
    const { customerAuthService } = await import("../../services/customer-auth.service");
    const owner = await guestOwner();
    const quoteId = await makeQuote(owner);
    const phone = nextPhone();
    const { challengeId, code } = await startPhone(quoteId, owner, phone);
    const ip = `198.19.${(Number.parseInt(run.slice(-2), 16) % 200) + 20}.78`;
    await expect(customerAuthService.verifyOtp({ challengeId, code: code!, ip })).rejects.toMatchObject({ code: "NOT_FOUND" });
    expect(await prisma.customer.count({ where: { phoneE164: { in: [phone, `ocv:v1:${quoteId}:phone:${sha(phone)}`] } } })).toBe(0);
    expect(await prisma.customerSession.count({ where: { customer: { phoneE164: phone } } })).toBe(0);
    // The challenge is still usable for what it was issued for.
    await expect(svc.verify({ ip: nextIp(), challengeId, code: code!, owner })).resolves.toMatchObject({ quoteId });
  });

  it("checkout verify refuses a customer sign-in challenge and leaves it untouched", async () => {
    const { customerRepo } = await import("../../repositories/customer.repo");
    const { hashOtp } = await import("../../domain/otp");
    const owner = await guestOwner();
    const quoteId = await makeQuote(owner);
    const phone = nextPhone();
    const id = uuidv7();
    const code = "246813";
    await customerRepo.createChallenge({ id, phoneE164: phone, codeHash: hashOtp(id, code, sha), expiresAt: new Date(Date.now() + 300_000) });
    try {
      await expect(svc.verify({ ip: nextIp(), challengeId: id, code, owner })).resolves.toEqual({ refused: "invalid" });
      const row = await prisma.otpChallenge.findUniqueOrThrow({ where: { id } });
      expect(row.consumedAt).toBeNull();
      expect(row.attempts).toBe(0);
      expect(await prisma.orderContactVerification.count({ where: { quoteId } })).toBe(0);
    } finally {
      await prisma.otpChallenge.deleteMany({ where: { id } });
    }
  });

  it("bindToOrder: only the order that used the quote, idempotent, never a second order", async () => {
    const owner = await guestOwner();
    const quoteId = await makeQuote(owner);
    const { challengeId, code } = await startPhone(quoteId, owner, nextPhone());
    const v = await svc.verify({ ip: nextIp(), challengeId, code: code!, owner });
    if (!("verificationId" in v)) throw new Error("expected a verification");
    const order = await makeOrder(run, { leadPhone: nextPhone(), label: "ocv-bind" });
    const other = await makeOrder(run, { leadPhone: nextPhone(), label: "ocv-other" });

    await expect(prisma.$transaction((tx) => svc.bindToOrder(tx, v.verificationId, order.id))).rejects.toMatchObject({ code: "CONFLICT" });
    await prisma.quote.update({ where: { id: quoteId }, data: { status: "used", usedByOrderId: order.id } });
    await prisma.$transaction((tx) => svc.bindToOrder(tx, v.verificationId, order.id));
    await prisma.$transaction((tx) => svc.bindToOrder(tx, v.verificationId, order.id));
    expect((await prisma.orderContactVerification.findUniqueOrThrow({ where: { id: v.verificationId } })).orderId).toBe(order.id);
    await expect(prisma.$transaction((tx) => svc.bindToOrder(tx, v.verificationId, other.id))).rejects.toMatchObject({ code: "CONFLICT" });
    await expect(prisma.$transaction((tx) => svc.bindToOrder(tx, uuidv7(), order.id))).rejects.toMatchObject({ code: "CONFLICT" });

    // The used quote takes no new challenge, and the spent code stays spent.
    expect((await startPhone(quoteId, owner, nextPhone())).code).toBeNull();
    await expect(svc.verify({ ip: nextIp(), challengeId, code: code!, owner })).resolves.toEqual({ refused: "invalid" });
  });
});
