import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createHash, randomBytes } from "node:crypto";
import { createServer, type Server } from "node:http";
import { createLocalJWKSet, exportJWK, generateKeyPair, SignJWT } from "jose";
import { apiRequest, assertDisposableDb, dbEnabled, params, runId, syntheticPhone } from "../../__tests__/helpers/fixtures";
import { db, makeOrder } from "../../__tests__/security/_mercury-fixtures";
import { uuidv7 } from "../../lib/ids";
import { resetEnvCache } from "../../lib/env";
import { startFakeSupabase, type FakeSupabase } from "../../auth/__tests__/fake-supabase-auth";
import { hookSecretKey, signHookPayload } from "../../auth/auth-hook";

/**
 * Group B on the disposable PostgreSQL 17: the migration's guarantees, the
 * routes end to end against a fake Supabase Auth server (loopback; never the
 * real Supabase, Google, Cloudflare or Resend), the hook gate, the attach
 * rules (owner Q10 a and b), the cap, "this was not me", the closed account,
 * phone linking (Q9), Google on our own callback (Q-B1), and staff separation.
 * Synthetic rows only, tagged with the run id.
 */

const run = runId();
const sha = (s: string) => createHash("sha256").update(s).digest("hex");
const CTX = params({});
type Prisma = Awaited<ReturnType<typeof db>>;
let prisma: Prisma;
let fake: FakeSupabase;
let google: { server: Server; url: string; sign: (claims: Record<string, unknown>) => Promise<string>; nextIdToken: string | null };
let ipN = 0;
const ip = () => `10.${(ipN >> 8) & 255}.${ipN++ & 255}.${run.charCodeAt(0) % 200}`;
const BEFORE_SECRET = `v1,whsec_${randomBytes(32).toString("base64")}`;
const GOOGLE_CLIENT = "test-client.apps.googleusercontent.com";

type Routes = {
  start: typeof import("@/app/api/auth/email/start/route");
  verify: typeof import("@/app/api/auth/email/verify/route");
  hook: typeof import("@/app/api/auth/hooks/send-email/route");
  before: typeof import("@/app/api/auth/hooks/before-user-created/route");
  dispute: typeof import("@/app/api/orders/account-link/dispute/route");
  gStart: typeof import("@/app/api/auth/google/start/route");
  gCallback: typeof import("@/app/api/auth/google/callback/route");
};
let r: Routes;

const email = (label: string) => `zz-sec-${run}-${label}@outlyy.test`;
/** Addresses of the tests added in the pre-launch fix round (re-review 103c): synthetic, `@example.com` only. */
const exampleEmail = (label: string) => `zz-sec-${run}-${label}@example.com`;

/** The signed start cookie (`name=value`) a start answer set, or null (review 103 finding 8). */
function startCookieOf(res: Response): string | null {
  const m = /((?:__Host-)?outlyy_email_start=[^;]+)/.exec(res.headers.get("set-cookie") ?? "");
  return m ? m[1] : null;
}

const joinCookies = (...c: (string | null | undefined)[]) => c.filter(Boolean).join("; ") || undefined;

async function startCode(address: string, headers: Record<string, string> = { "x-forwarded-for": ip() }) {
  return r.start.POST(apiRequest("/api/auth/email/start", { body: { email: address }, headers }), CTX);
}

async function signIn(address: string, opts: { cookie?: string; code?: string } = {}) {
  const headers = { "x-forwarded-for": ip() };
  const s = await startCode(address, headers);
  if (s.status !== 200) return { status: s.status, body: await s.json(), cookie: null as string | null };
  const code = opts.code ?? fake.codes.get(address.toLowerCase())!;
  const v = await r.verify.POST(apiRequest("/api/auth/email/verify", { body: { email: address, code }, cookie: joinCookies(opts.cookie, startCookieOf(s)), headers }), CTX);
  // The attach notices run after the response (finding 5); wait for them so the checks below see their rows.
  await (await import("../customer-identity.service")).accountNoticesSettledForTests();
  const setCookie = v.headers.get("set-cookie") ?? "";
  const m = /outlyy_customer_session=([^;]+)/.exec(setCookie);
  return { status: v.status, body: await v.json(), cookie: m ? `outlyy_customer_session=${m[1]}` : null };
}

/**
 * A guest session with a known token, and its cookie. A negative `expiresInMs`
 * makes a session that was created two hours earlier and has already expired
 * (`gs_expiry_check` requires expires_at > created_at).
 */
async function guestSession(expiresInMs = 3_600_000) {
  const token = randomBytes(32).toString("base64url");
  const id = uuidv7();
  const expiresAt = new Date(Date.now() + expiresInMs);
  const createdAt = new Date(Math.min(Date.now(), expiresAt.getTime() - 2 * 3_600_000));
  await prisma.guestSession.create({ data: { id, tokenHash: sha(token), createdAt, expiresAt } });
  return { id, cookie: `outlyy_guest_session=${token}` };
}

/** A paid order made from a guest quote, with an order-bound verification of `channel` for `contact`. */
async function guestOrder(label: string, opts: { channel?: "email" | "phone"; contact?: string; bind?: boolean; guestSessionId?: string; customerId?: string | null } = {}) {
  const o = await makeOrder(run, { leadPhone: syntheticPhone(run, 10 + (ipN % 80)), label, customerId: opts.customerId ?? null });
  const gs = opts.guestSessionId ?? (await guestSession()).id;
  const quoteId = uuidv7();
  const bind = opts.bind ?? true;
  await prisma.quote.create({
    data: { id: quoteId, fingerprint: sha(`q:${run}:${quoteId}`), ownerKind: "guest", guestSessionId: gs, currency: "AED", totalMinor: 45n, lines: [], request: { lines: [] }, status: bind ? "used" : "active", usedByOrderId: bind ? o.id : null, expiresAt: new Date(Date.now() + 600_000) },
  });
  const channel = opts.channel ?? "email";
  const contact = opts.contact ?? (channel === "email" ? email(label) : syntheticPhone(run, 90));
  await prisma.orderContactVerification.create({
    data: { id: uuidv7(), quoteId, orderId: bind ? o.id : null, channel, contactHash: sha(contact), method: channel === "phone" ? "otp_sms" : "email_code", verifiedAt: new Date() },
  });
  return o;
}

async function customerOf(orderId: string) {
  return (await prisma.order.findUniqueOrThrow({ where: { id: orderId }, select: { customerId: true } })).customerId;
}

async function identityCustomer(address: string) {
  const i = await prisma.customerIdentity.findFirst({ where: { email: address.toLowerCase() } });
  return i?.customerId ?? null;
}

async function signedHook(path: "send-email" | "before-user-created", body: unknown, secret: string, id = `msg_${randomBytes(6).toString("hex")}`) {
  const raw = JSON.stringify(body);
  const ts = String(Math.floor(Date.now() / 1000));
  const sig = `v1,${signHookPayload(hookSecretKey(secret)!, id, ts, raw)}`;
  const req = apiRequest(`/api/auth/hooks/${path}`, { rawBody: raw, origin: null, headers: { "webhook-id": id, "webhook-timestamp": ts, "webhook-signature": sig } });
  return path === "send-email" ? r.hook.POST(req) : r.before.POST(req);
}

describe.skipIf(!dbEnabled)("Group B: customer sign-in on Supabase Auth (disposable database)", () => {
  beforeAll(async () => {
    assertDisposableDb();
    prisma = await db();
    // Supabase also calls our Before User Created hook when `/otp` creates a user (re-review 103b, finding 7).
    fake = await startFakeSupabase({ beforeUserCreatedHookSecret: BEFORE_SECRET });

    // Fake Google token endpoint and keys (loopback).
    const { publicKey, privateKey } = await generateKeyPair("RS256");
    const keys = createLocalJWKSet({ keys: [{ ...(await exportJWK(publicKey)), kid: "g1", alg: "RS256" }] });
    const sign = (claims: Record<string, unknown>) => new SignJWT(claims).setProtectedHeader({ alg: "RS256", kid: "g1" }).setIssuer("https://accounts.google.com").setAudience(GOOGLE_CLIENT).setSubject(String(claims.sub ?? "g-sub")).setIssuedAt().setExpirationTime("10m").sign(privateKey);
    const gServer = createServer((req, res) => {
      res.writeHead(google.nextIdToken ? 200 : 400, { "content-type": "application/json" });
      res.end(JSON.stringify(google.nextIdToken ? { id_token: google.nextIdToken, access_token: "discarded" } : { error: "invalid_grant" }));
    });
    await new Promise<void>((res) => gServer.listen(0, "127.0.0.1", () => res()));
    const addr = gServer.address();
    google = { server: gServer, url: `http://127.0.0.1:${typeof addr === "object" && addr ? addr.port : 0}/token`, sign, nextIdToken: null };
    const { setGoogleEndpointsForTests } = await import("../../auth/google-oauth");
    setGoogleEndpointsForTests({ token: google.url, keys });

    vi.stubEnv("CUSTOMER_SUPABASE_AUTH_ENABLED", "true");
    vi.stubEnv("CUSTOMER_OAUTH_ENABLED", "true");
    vi.stubEnv("SUPABASE_URL", fake.url);
    vi.stubEnv("SUPABASE_PUBLISHABLE_KEY", "sb_publishable_test_only");
    vi.stubEnv("SUPABASE_AUTH_SEND_EMAIL_HOOK_SECRET", fake.sendEmailHookSecret);
    vi.stubEnv("SUPABASE_AUTH_BEFORE_USER_CREATED_HOOK_SECRET", BEFORE_SECRET);
    vi.stubEnv("GOOGLE_OAUTH_CLIENT_ID", GOOGLE_CLIENT);
    vi.stubEnv("GOOGLE_OAUTH_CLIENT_SECRET", "test-only-google-secret");
    vi.stubEnv("TRUST_PROXY_IP_HEADERS", "true");
    vi.stubEnv("NOTIFICATION_RECIPIENT_ALLOWLIST", "@outlyy.test");
    vi.stubEnv("RESEND_API_KEY", "");
    vi.stubEnv("TURNSTILE_SECRET_KEY", "");
    vi.stubEnv("NEXT_PUBLIC_TURNSTILE_SITE_KEY", "");
    resetEnvCache();

    r = {
      start: await import("@/app/api/auth/email/start/route"),
      verify: await import("@/app/api/auth/email/verify/route"),
      hook: await import("@/app/api/auth/hooks/send-email/route"),
      before: await import("@/app/api/auth/hooks/before-user-created/route"),
      dispute: await import("@/app/api/orders/account-link/dispute/route"),
      gStart: await import("@/app/api/auth/google/start/route"),
      gCallback: await import("@/app/api/auth/google/callback/route"),
    };
    // Supabase calls our Send Email hook inside its own /otp, as the hosted service does.
    fake.onSendEmail = async (body, headers) => (await r.hook.POST(apiRequest("/api/auth/hooks/send-email", { rawBody: body, origin: null, headers }))).status;
    // And our Before User Created hook when it would create a user: every first sign-in below proves our start's claim.
    fake.onBeforeUserCreated = async (body, headers) => (await r.before.POST(apiRequest("/api/auth/hooks/before-user-created", { rawBody: body, origin: null, headers }))).status;
  });

  // The global sign-in limits (30 an hour, the daily code budget) are shared by every test in this file:
  // each test starts from empty global buckets so the suite is not limited by its own earlier tests.
  beforeEach(async () => {
    await prisma.rateLimitBucket.deleteMany({ where: { key: { startsWith: "auth_email_start:global" } } });
  });

  afterAll(async () => {
    await fake?.close();
    await new Promise<void>((res) => google?.server.close(() => res()));
    (await import("../../auth/google-oauth")).setGoogleEndpointsForTests(null);
    vi.unstubAllEnvs();
    resetEnvCache();
  });

  /* ------------------------------------------------------------ migration */

  describe("migration 20261130120000", () => {
    it("new tables have RLS on and no API-role privileges", async () => {
      const rows = await prisma.$queryRaw<{ relname: string; rls: boolean }[]>`
        SELECT c.relname, c.relrowsecurity AS rls FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE n.nspname = 'public' AND c.relname IN ('customer_identities', 'customer_auth_intents', 'order_account_links', 'email_send_counters') ORDER BY 1`;
      expect(rows.map((x) => x.relname)).toEqual(["customer_auth_intents", "customer_identities", "email_send_counters", "order_account_links"]);
      expect(rows.every((x) => x.rls)).toBe(true);
      const grants = await prisma.$queryRaw<{ n: bigint }[]>`
        SELECT count(*)::bigint AS n FROM information_schema.role_table_grants
        WHERE table_schema = 'public' AND grantee IN ('anon', 'authenticated') AND table_name IN ('customer_identities', 'customer_auth_intents', 'order_account_links', 'email_send_counters')`;
      expect(Number(grants[0].n)).toBe(0);
    });

    it("trigger functions are not executable by PUBLIC or the API roles", async () => {
      const rows = await prisma.$queryRaw<{ n: bigint }[]>`
        SELECT count(*)::bigint AS n FROM pg_proc p JOIN pg_namespace ns ON ns.oid = p.pronamespace
        WHERE ns.nspname = 'public' AND p.prorettype = 'trigger'::regtype
          AND (has_function_privilege('anon', p.oid, 'EXECUTE') OR has_function_privilege('authenticated', p.oid, 'EXECUTE'))`;
      expect(Number(rows[0].n)).toBe(0);
    });

    it("phone is optional: two phone-less customers, a duplicate phone still refused", async () => {
      await prisma.customer.create({ data: { id: uuidv7(), phoneE164: null, fullName: `zz-sec-${run}` } });
      await prisma.customer.create({ data: { id: uuidv7(), phoneE164: null, fullName: `zz-sec-${run}` } });
      const phone = syntheticPhone(run, 1);
      await prisma.customer.create({ data: { id: uuidv7(), phoneE164: phone, fullName: `zz-sec-${run}` } });
      await expect(prisma.customer.create({ data: { id: uuidv7(), phoneE164: phone, fullName: `zz-sec-${run}` } })).rejects.toThrow();
    });

    it("ops_alerts takes the new entity kinds; link constraints hold", async () => {
      for (const kind of ["order_account_link", "customer", "email_volume"]) {
        await prisma.opsAlert.create({ data: { id: uuidv7(), entityKind: kind, entityId: `zz-${run}-${kind}`, reason: "test", incidentAt: new Date(), handledAt: new Date() } });
      }
      await prisma.opsAlert.deleteMany({ where: { entityId: { startsWith: `zz-${run}-` } } });
      const o = await guestOrder("constraints");
      const c = await prisma.customer.create({ data: { id: uuidv7(), fullName: `zz-sec-${run}` } });
      const base = { orderId: o.id, customerId: c.id };
      await expect(prisma.orderAccountLink.create({ data: { id: uuidv7(), ...base, rule: "verified_email" } })).rejects.toThrow();
      await expect(prisma.orderAccountLink.create({ data: { id: uuidv7(), ...base, rule: "staff", detachedAt: new Date() } })).rejects.toThrow();
      await prisma.orderAccountLink.create({ data: { id: uuidv7(), ...base, rule: "staff" } });
      await expect(prisma.orderAccountLink.create({ data: { id: uuidv7(), ...base, rule: "staff" } })).rejects.toThrow();
      await prisma.orderAccountLink.updateMany({ where: base, data: { detachedAt: new Date(), detachReason: "staff" } });
      await prisma.orderAccountLink.create({ data: { id: uuidv7(), ...base, rule: "staff" } });
    });
  });

  /* ------------------------------------------------------------ email code and the hook gate */

  describe("email code through the routes and the Send Email hook", () => {
    it("first sign-in creates a phone-less customer and identity; the second maps to the same one", async () => {
      const before = await prisma.emailSendCounter.aggregate({ _sum: { count: true }, where: { kind: "signin_code" } });
      const a = await signIn(email("first"));
      expect(a.status).toBe(200);
      expect(a.cookie).toBeTruthy();
      expect(a.body.customer.phoneE164).toBeNull();
      expect(a.body.customer.emailMasked).toMatch(/^z•••@outlyy\.test$/);
      const id1 = await identityCustomer(email("first"));
      const b = await signIn(email("first"));
      expect(b.status).toBe(200);
      expect(await identityCustomer(email("first"))).toBe(id1);
      expect(await prisma.customerIdentity.count({ where: { email: email("first") } })).toBe(1);
      const after = await prisma.emailSendCounter.aggregate({ _sum: { count: true }, where: { kind: "signin_code" } });
      expect((after._sum.count ?? 0) - (before._sum.count ?? 0)).toBe(2);
      // Tokens never reach the browser: the body carries no Supabase token and only our cookies are set.
      expect(JSON.stringify(b.body)).not.toMatch(/access_token|refresh_token|eyJ/);
      // The Supabase session was signed out after use.
      expect(fake.requests.filter((x) => x.path.startsWith("/logout")).length).toBeGreaterThanOrEqual(2);
    });

    it("a wrong code is CODE_INVALID and opens nothing", async () => {
      const res = await signIn(email("wrong"), { code: "000001" });
      expect(res.status).toBe(422);
      expect(res.body.error.details.reason).toBe("CODE_INVALID");
      expect(res.cookie).toBeNull();
    });

    it("an invalid address is EMAIL_INVALID; the answer never says whether an account exists", async () => {
      const res = await r.start.POST(apiRequest("/api/auth/email/start", { body: { email: "nope" }, headers: { "x-forwarded-for": ip() } }), CTX);
      expect((await res.json()).error.details.reason).toBe("EMAIL_INVALID");
      const known = await r.start.POST(apiRequest("/api/auth/email/start", { body: { email: email("first") }, headers: { "x-forwarded-for": ip() } }), CTX);
      const unknown = await r.start.POST(apiRequest("/api/auth/email/start", { body: { email: email("never-seen") }, headers: { "x-forwarded-for": ip() } }), CTX);
      expect(known.status).toBe(200);
      expect(await known.json()).toEqual(await unknown.json());
    });

    it("per-address limit: the fourth code in 15 minutes is RATE_LIMITED", async () => {
      const address = email("limited");
      for (let i = 0; i < 3; i++) expect((await r.start.POST(apiRequest("/api/auth/email/start", { body: { email: address }, headers: { "x-forwarded-for": ip() } }), CTX)).status).toBe(200);
      const fourth = await r.start.POST(apiRequest("/api/auth/email/start", { body: { email: address }, headers: { "x-forwarded-for": ip() } }), CTX);
      expect(fourth.status).toBe(429);
      expect((await fourth.json()).error.details.reason).toBe("RATE_LIMITED");
    });

    it("daily code budget, global hour and per-IP day: RATE_LIMITED once spent; a site-wide refusal says so and offers Google (finding 3, re-review 103b N1)", async () => {
      const svc = await import("../customer-identity.service");
      const { hashIp } = await import("../../lib/crypto");
      // An injected clock: the pre-filled buckets and the route's charges fall in the same windows even if the run
      // crosses UTC midnight or the top of an hour.
      const at = new Date();
      svc.setIdentityClockForTests(() => at);
      try {
        const DAY_MS = 86_400_000;
        const HOUR_MS = 3_600_000;
        const windowStart = new Date(Math.floor(at.getTime() / DAY_MS) * DAY_MS);
        const expiresAt = new Date(windowStart.getTime() + DAY_MS);
        // The default plan cap is 100 a day: sign-in codes get 40 of it.
        expect(svc.signInCodeDailyBudget(100)).toBe(40);
        await prisma.rateLimitBucket.create({ data: { key: "auth_email_start:global_day", windowStart, count: svc.signInCodeDailyBudget(100), expiresAt } });
        const spent = await startCode(email("budget"));
        expect(spent.status).toBe(429);
        const spentDetails = (await spent.json()).error.details;
        expect(spentDetails).toMatchObject({ reason: "RATE_LIMITED", scope: "site", alternative: "google" });
        // The hourly site-wide charge this refused request took was given back.
        const hourStart = new Date(Math.floor(at.getTime() / HOUR_MS) * HOUR_MS);
        expect((await prisma.rateLimitBucket.findUnique({ where: { key_windowStart: { key: "auth_email_start:global", windowStart: hourStart } } }))?.count ?? 0).toBe(0);
        await prisma.rateLimitBucket.deleteMany({ where: { key: "auth_email_start:global_day" } });

        // The refused request above left this hour's row at count 0 (charges are given back, not deleted): set it, do not insert.
        await prisma.rateLimitBucket.upsert({
          where: { key_windowStart: { key: "auth_email_start:global", windowStart: hourStart } },
          create: { key: "auth_email_start:global", windowStart: hourStart, count: 30, expiresAt: new Date(hourStart.getTime() + HOUR_MS) },
          update: { count: 30 },
        });
        const hourSpent = await startCode(email("budget-hour"));
        expect(hourSpent.status).toBe(429);
        expect((await hourSpent.json()).error.details).toMatchObject({ reason: "RATE_LIMITED", scope: "site" });
        await prisma.rateLimitBucket.deleteMany({ where: { key: "auth_email_start:global" } });

        const addr = ip();
        await prisma.rateLimitBucket.upsert({
          where: { key_windowStart: { key: `auth_email_start:ip_day:${hashIp(addr)}`, windowStart } },
          create: { key: `auth_email_start:ip_day:${hashIp(addr)}`, windowStart, count: 20, expiresAt },
          update: { count: 20 },
        });
        const ipSpent = await startCode(email("ip-day"), { "x-forwarded-for": addr });
        expect(ipSpent.status).toBe(429);
        const ipDetails = (await ipSpent.json()).error.details;
        expect(ipDetails.reason).toBe("RATE_LIMITED");
        expect(ipDetails.scope).toBeUndefined();
        expect(ipDetails.alternative).toBe("google");
        // Another IP is not affected.
        expect((await startCode(email("ip-day"))).status).toBe(200);
      } finally {
        svc.setIdentityClockForTests(null);
      }
    });

    it("a Supabase /otp that sent nothing gives the site-wide limits back; a hook timeout or 5xx keeps them; our own /otp timeout answers as sent (re-review 103b N1, 103c D3, finding 13)", async () => {
      const svc = await import("../customer-identity.service");
      const { supabaseAuthClient, SupabaseAuthError } = await import("../../auth/supabase-auth.client");
      const at = new Date();
      svc.setIdentityClockForTests(() => at);
      const count = async (key: string, seconds: number) => {
        const ms = seconds * 1000;
        const row = await prisma.rateLimitBucket.findUnique({ where: { key_windowStart: { key, windowStart: new Date(Math.floor(at.getTime() / ms) * ms) } } });
        return row?.count ?? 0;
      };
      try {
        // Our hook refused (Supabase answers with a hook error code that is not a timeout): nothing was sent.
        fake.failNext("/otp", 403, { code: 403, error_code: "hook_rejected", msg: "x" });
        expect((await startCode(email("release-fail"))).status).toBe(503);
        expect(await count("auth_email_start:global", 3600)).toBe(0);
        expect(await count("auth_email_start:global_day", 86_400)).toBe(0);
        // The per-address charge stays: failing requests still cannot repeat without bound.
        expect(await count(`auth_email_start:email:${sha(email("release-fail")).slice(0, 32)}`, 900)).toBe(1);
        // Supabase's own rate limit: refused before the hook.
        fake.failNext("/otp", 429, { code: 429, error_code: "over_email_send_rate_limit", msg: "x" });
        expect((await startCode(exampleEmail("release-429"))).status).toBe(429);
        expect(await count("auth_email_start:global_day", 86_400)).toBe(0);

        // A hook timeout or another 5xx may come after our hook handed the code to Resend: the charge stays (D3).
        fake.failNext("/otp", 500, { code: 500, error_code: "hook_timeout_after_retry", msg: "x" });
        expect((await startCode(exampleEmail("keep-hook-timeout"))).status).toBe(503);
        expect(await count("auth_email_start:global", 3600)).toBe(1);
        expect(await count("auth_email_start:global_day", 86_400)).toBe(1);
        fake.failNext("/otp", 500, { code: 500, error_code: "unexpected_failure", msg: "x" });
        expect((await startCode(exampleEmail("keep-5xx"))).status).toBe(503);
        expect(await count("auth_email_start:global_day", 86_400)).toBe(2);
        // A transport error (the connection dropped, Supabase may have finished): kept too.
        svc.setIdentityDepsForTests({
          client: {
            ...supabaseAuthClient,
            sendEmailOtp: async () => {
              throw new SupabaseAuthError("unavailable", null, null, false);
            },
          },
        });
        expect((await startCode(exampleEmail("keep-transport"))).status).toBe(503);
        expect(await count("auth_email_start:global_day", 86_400)).toBe(3);
        svc.setIdentityDepsForTests(null);

        expect((await startCode(email("release-ok"))).status).toBe(200);
        expect(await count("auth_email_start:global", 3600)).toBe(4);
        expect(await count("auth_email_start:global_day", 86_400)).toBe(4);

        // Our own 5-second ceiling: the hook may have sent the code, so the answer is "sent", the intent is kept,
        // the start cookie is set and the budget stays charged.
        svc.setIdentityDepsForTests({
          client: {
            ...supabaseAuthClient,
            sendEmailOtp: async () => {
              throw new SupabaseAuthError("unavailable", null, null, true);
            },
          },
        });
        const timedOut = await startCode(email("otp-timeout"));
        expect(timedOut.status).toBe(200);
        expect(await timedOut.json()).toEqual({ expiresInSeconds: 600, resendAfterSeconds: 60 });
        expect(startCookieOf(timedOut)).toBeTruthy();
        expect(await prisma.customerAuthIntent.count({ where: { contactHash: sha(email("otp-timeout")), consumedAt: null } })).toBe(1);
        expect(await count("auth_email_start:global_day", 86_400)).toBe(5);
      } finally {
        svc.setIdentityDepsForTests(null);
        svc.setIdentityClockForTests(null);
      }
    });

    it("staff alert at 80 % of today's code budget and when it is spent, on a fixed clock (re-review 103b N1)", async () => {
      const { signInCodeBudgetIncidents } = await import("../account-alerts");
      const at = new Date("2031-03-04T23:59:30Z");
      const day = new Date("2031-03-04T00:00:00Z");
      const where = { key: "auth_email_start:global_day", windowStart: day };
      await prisma.rateLimitBucket.deleteMany({ where });
      try {
        expect(await signInCodeBudgetIncidents(at)).toEqual([]);
        await prisma.rateLimitBucket.create({ data: { ...where, count: 32, expiresAt: new Date(day.getTime() + 86_400_000) } });
        expect((await signInCodeBudgetIncidents(at)).map((i) => [i.kind, i.entityKind, i.entityId, i.reason, i.raisedAt.toISOString()])).toEqual([
          ["signin_code_budget", "email_volume", "signin_budget:2031-03-04", "signin_code_budget_80pct", day.toISOString()],
        ]);
        await prisma.rateLimitBucket.updateMany({ where, data: { count: 40 } });
        expect((await signInCodeBudgetIncidents(at)).map((i) => i.reason)).toEqual(["signin_code_budget_80pct", "signin_code_budget_spent"]);
        // The next UTC day starts from nothing.
        expect(await signInCodeBudgetIncidents(new Date("2031-03-05T00:00:01Z"))).toEqual([]);
      } finally {
        await prisma.rateLimitBucket.deleteMany({ where });
      }
    });

    it("verify needs this browser's start cookie for that address; attempts are counted per start (finding 8)", async () => {
      const a = await startCode(email("cookie-a"));
      const b = await startCode(email("cookie-b"));
      const cookieA = startCookieOf(a)!;
      expect(cookieA).toBeTruthy();
      expect(a.headers.get("set-cookie")).toMatch(/HttpOnly/i);
      const verify = (address: string, code: string, cookie?: string | null) =>
        r.verify.POST(apiRequest("/api/auth/email/verify", { body: { email: address, code }, cookie: cookie ?? undefined, headers: { "x-forwarded-for": ip() } }), CTX);
      const codeA = fake.codes.get(email("cookie-a"))!;
      const none = await verify(email("cookie-a"), codeA);
      expect((await none.json()).error.details.reason).toBe("CODE_EXPIRED");
      const other = await verify(email("cookie-a"), codeA, startCookieOf(b));
      expect((await other.json()).error.details.reason).toBe("CODE_EXPIRED");
      // Nothing above reached Supabase or spent the code.
      expect(fake.codes.get(email("cookie-a"))).toBe(codeA);
      const wrong = codeA === "000000" ? "000001" : "000000";
      for (let i = 0; i < 5; i++) expect((await (await verify(email("cookie-a"), wrong, cookieA)).json()).error.details.reason).toBe("CODE_INVALID");
      const sixth = await verify(email("cookie-a"), codeA, cookieA);
      expect(sixth.status).toBe(429);
      // A fresh start in the owner's browser still works: the address itself is not locked out.
      const again = await startCode(email("cookie-a"));
      const ok = await verify(email("cookie-a"), fake.codes.get(email("cookie-a"))!, startCookieOf(again));
      expect(ok.status).toBe(200);
      expect(ok.headers.get("set-cookie")).toMatch(/outlyy_email_start=;/);
    });

    it("verify attempts per start are not reset by a window edge (re-review 103b N2)", async () => {
      const svc = await import("../customer-identity.service");
      const t0 = new Date();
      svc.setIdentityClockForTests(() => t0);
      try {
        const s = await startCode(email("straddle"));
        const cookie = startCookieOf(s);
        const code = fake.codes.get(email("straddle"))!;
        const wrong = code === "000000" ? "000001" : "000000";
        const verify = (c: string) => r.verify.POST(apiRequest("/api/auth/email/verify", { body: { email: email("straddle"), code: c }, cookie: cookie ?? undefined, headers: { "x-forwarded-for": ip() } }), CTX);
        for (let i = 0; i < 5; i++) expect((await (await verify(wrong)).json()).error.details.reason).toBe("CODE_INVALID");
        // Fifteen minutes on: every fixed 15-minute window has turned over, but this start's five tries are spent.
        const later = new Date(t0.getTime() + 15 * 60_000);
        svc.setIdentityClockForTests(() => later);
        expect((await verify(code)).status).toBe(429);
      } finally {
        svc.setIdentityClockForTests(null);
      }
    });

    it("a failed Supabase /otp retires our intent (finding 9)", async () => {
      fake.failNext("/otp", 500, { code: 500, error_code: "unexpected_failure", msg: "x" });
      const res = await startCode(email("otp-fails"));
      expect(res.status).toBe(503);
      expect((await res.json()).error.details.reason).toBe("DELIVERY_FAILED");
      expect(await prisma.customerAuthIntent.count({ where: { contactHash: sha(email("otp-fails")), consumedAt: null } })).toBe(0);
    });

    it("the hook sends nothing without our intent, refuses a replay, a bad signature and other action types", async () => {
      const body = (address: string, action = "magiclink") => ({ user: { id: uuidv7(), email: address }, email_data: { token: "123456", email_action_type: action } });
      expect((await signedHook("send-email", body(email("no-intent")), fake.sendEmailHookSecret)).status).toBe(403);
      const { customerIdentityRepo } = await import("../../repositories/customer-identity.repo");
      await customerIdentityRepo.createIntent({ channel: "email", contactHash: sha(email("intent")), now: new Date(), ttlMs: 120_000 });
      expect((await signedHook("send-email", body(email("intent"), "recovery"), fake.sendEmailHookSecret)).status).toBe(403);
      const id = `msg_${randomBytes(6).toString("hex")}`;
      expect((await signedHook("send-email", body(email("intent")), fake.sendEmailHookSecret, id)).status).toBe(200);
      // Same delivery again, and a fresh delivery for the now-consumed intent: both refused.
      expect((await signedHook("send-email", body(email("intent")), fake.sendEmailHookSecret, id)).status).toBe(403);
      expect((await signedHook("send-email", body(email("intent")), fake.sendEmailHookSecret)).status).toBe(403);
      expect((await signedHook("send-email", body(email("intent")), `v1,whsec_${randomBytes(32).toString("base64")}`)).status).toBe(401);
      // Expired intent.
      await prisma.customerAuthIntent.create({ data: { id: uuidv7(), channel: "email", contactHash: sha(email("stale")), createdAt: new Date(Date.now() - 600_000), expiresAt: new Date(Date.now() - 1000) } });
      expect((await signedHook("send-email", body(email("stale")), fake.sendEmailHookSecret)).status).toBe(403);
    });

    it("Before User Created: Google allowed, email only with a live intent, everything else refused", async () => {
      const u = (address: string, provider: string) => ({ user: { email: address, app_metadata: { provider } } });
      expect((await signedHook("before-user-created", u(email("g"), "google"), BEFORE_SECRET)).status).toBe(200);
      expect((await signedHook("before-user-created", u(email("pw"), "email"), BEFORE_SECRET)).status).toBe(403);
      expect((await signedHook("before-user-created", { user: { phone: ["971", "50", "0000000"].join(""), app_metadata: { provider: "phone" } } }, BEFORE_SECRET)).status).toBe(403);
      const { customerIdentityRepo } = await import("../../repositories/customer-identity.repo");
      const { signupClaimFor } = await import("../customer-identity.service");
      const intentId = await customerIdentityRepo.createIntent({ channel: "email", contactHash: sha(email("allowed")), now: new Date(), ttlMs: 120_000 });
      const claimed = (address: string, claim?: string) => ({ user: { email: address, app_metadata: { provider: "email" }, user_metadata: claim ? { outlyy_signup_claim: claim } : {} } });
      // A direct `/signup` for an address with a live intent of ours, but without our start's claim: refused,
      // whether it arrives before or after our own `/otp` (re-review 103b, finding 7).
      expect((await signedHook("before-user-created", u(email("allowed"), "email"), BEFORE_SECRET)).status).toBe(403);
      expect((await signedHook("before-user-created", claimed(email("allowed"), signupClaimFor(uuidv7())), BEFORE_SECRET)).status).toBe(403);
      expect((await signedHook("before-user-created", claimed(email("allowed"), signupClaimFor(intentId)), BEFORE_SECRET)).status).toBe(200);
      expect((await signedHook("before-user-created", claimed(email("allowed"), signupClaimFor(intentId)), fake.sendEmailHookSecret)).status).toBe(401);
      // One creation per intent (finding 7): a second creation for the same intent is refused.
      expect((await signedHook("before-user-created", claimed(email("allowed"), signupClaimFor(intentId)), BEFORE_SECRET)).status).toBe(403);
    });

    it("our start route sends its signup claim to /otp, and the creation passes our hook (re-review 103b, finding 7)", async () => {
      const { signupClaimFor } = await import("../customer-identity.service");
      const res = await startCode(email("claim-sent"));
      expect(res.status).toBe(200);
      const intent = await prisma.customerAuthIntent.findFirstOrThrow({ where: { contactHash: sha(email("claim-sent")) }, orderBy: { createdAt: "desc" } });
      const otp = [...fake.requests].reverse().find((x) => x.path.startsWith("/otp"))!;
      expect((otp.body as { data?: { outlyy_signup_claim?: string } }).data?.outlyy_signup_claim).toBe(signupClaimFor(intent.id));
      expect([...fake.users.values()].some((x) => x.email === email("claim-sent"))).toBe(true);
    });

    /* ---- re-review 103c: the signup claim's visibility and safety valve (D1), and two starts (D2) */

    const withClaim = (address: string, claim?: string) => ({ user: { email: address, app_metadata: { provider: "email" }, user_metadata: claim ? { outlyy_signup_claim: claim } : {} } });
    const markerCount = async (intentId: string) => (await prisma.rateLimitBucket.findUnique({ where: { key_windowStart: { key: `auth_hook:claim_missing:${intentId}`, windowStart: new Date(0) } } }))?.count ?? 0;

    it("claim missing: our own start is refused, an error event is logged and staff get signup_claim_missing, once a day (re-review 103c D1)", async () => {
      const svc = await import("../customer-identity.service");
      const { supabaseAuthClient } = await import("../../auth/supabase-auth.client");
      const { signupClaimIncidents } = await import("../account-alerts");
      const { log } = await import("../../lib/logger");
      const at = new Date();
      const day = new Date(Math.floor(at.getTime() / 86_400_000) * 86_400_000);
      const bucket = { key: "auth_signup_claim_missing:day", windowStart: day };
      await prisma.rateLimitBucket.deleteMany({ where: bucket });
      const errors = vi.spyOn(log, "error");
      svc.setIdentityClockForTests(() => at);
      // Supabase drops our `/otp` `data`: the hook is handed a new user without the claim.
      svc.setIdentityDepsForTests({ client: { ...supabaseAuthClient, sendEmailOtp: (address: string) => supabaseAuthClient.sendEmailOtp(address) } });
      try {
        expect(await signupClaimIncidents(at)).toEqual([]);
        const address = exampleEmail("claim-missing");
        const res = await startCode(address);
        expect(res.status).toBe(503);
        expect((await res.json()).error.details.reason).toBe("DELIVERY_FAILED");
        expect([...fake.users.values()].some((u) => u.email === address)).toBe(false);
        const intent = await prisma.customerAuthIntent.findFirstOrThrow({ where: { contactHash: sha(address) }, orderBy: { createdAt: "desc" } });
        expect(await markerCount(intent.id)).toBe(1);
        expect(errors).toHaveBeenCalledWith("customer.identity_signup_claim_missing", expect.anything());
        const incidents = await signupClaimIncidents(at);
        expect(incidents.map((i) => [i.kind, i.entityKind, i.entityId, i.reason, i.raisedAt.toISOString()])).toEqual([
          ["signup_claim_missing", "email_volume", `signup_claim:${day.toISOString().slice(0, 10)}`, "signup_claim_missing", day.toISOString()],
        ]);
        // A second refusal the same day is counted, and stays one incident (one alert a day).
        expect((await startCode(exampleEmail("claim-missing-2"))).status).toBe(503);
        expect((await prisma.rateLimitBucket.findUniqueOrThrow({ where: { key_windowStart: bucket } })).count).toBe(2);
        expect(await signupClaimIncidents(at)).toHaveLength(1);
      } finally {
        errors.mockRestore();
        svc.setIdentityDepsForTests(null);
        svc.setIdentityClockForTests(null);
        await prisma.rateLimitBucket.deleteMany({ where: bucket });
      }
    });

    it("claim mismatch and claim missing are told apart; only a missing claim leaves the marker; neither spends the creation (re-review 103c D1)", async () => {
      const { customerIdentityRepo } = await import("../../repositories/customer-identity.repo");
      const { signupClaimFor } = await import("../customer-identity.service");
      const { log } = await import("../../lib/logger");
      const warns = vi.spyOn(log, "warn");
      try {
        const address = exampleEmail("claim-mismatch");
        const intentId = await customerIdentityRepo.createIntent({ channel: "email", contactHash: sha(address), now: new Date(), ttlMs: 120_000 });
        expect((await signedHook("before-user-created", withClaim(address, signupClaimFor(uuidv7())), BEFORE_SECRET)).status).toBe(403);
        expect(warns).toHaveBeenCalledWith("customer.identity_hook_refused", expect.objectContaining({ hook: "before_user_created", reason: "claim_mismatch" }));
        expect(await markerCount(intentId)).toBe(0);
        expect((await signedHook("before-user-created", withClaim(address), BEFORE_SECRET)).status).toBe(403);
        expect(warns).toHaveBeenCalledWith("customer.identity_hook_refused", expect.objectContaining({ hook: "before_user_created", reason: "claim_missing" }));
        expect(await markerCount(intentId)).toBe(1);
        expect((await signedHook("before-user-created", withClaim(address, signupClaimFor(intentId)), BEFORE_SECRET)).status).toBe(200);
      } finally {
        warns.mockRestore();
      }
    });

    it("CUSTOMER_SIGNUP_CLAIM_RELAXED with our intent: no claim compare, the intent's single creation still spent (re-review 103c D1)", async () => {
      vi.stubEnv("CUSTOMER_SIGNUP_CLAIM_RELAXED", "true");
      resetEnvCache();
      const svc = await import("../customer-identity.service");
      const { supabaseAuthClient } = await import("../../auth/supabase-auth.client");
      const { customerIdentityRepo } = await import("../../repositories/customer-identity.repo");
      try {
        const address = exampleEmail("relaxed");
        await customerIdentityRepo.createIntent({ channel: "email", contactHash: sha(address), now: new Date(), ttlMs: 120_000 });
        expect((await signedHook("before-user-created", withClaim(address), BEFORE_SECRET)).status).toBe(200);
        // Once per intent, claim or no claim.
        expect((await signedHook("before-user-created", withClaim(address, svc.signupClaimFor(uuidv7())), BEFORE_SECRET)).status).toBe(403);
        expect((await signedHook("before-user-created", withClaim(address), BEFORE_SECRET)).status).toBe(403);

        // End to end: Supabase drops our `/otp` `data`, and the first sign-in still goes through our start.
        svc.setIdentityDepsForTests({ client: { ...supabaseAuthClient, sendEmailOtp: (a: string) => supabaseAuthClient.sendEmailOtp(a) } });
        const routed = exampleEmail("relaxed-route");
        expect((await startCode(routed)).status).toBe(200);
        expect([...fake.users.values()].some((u) => u.email === routed)).toBe(true);
      } finally {
        svc.setIdentityDepsForTests(null);
        vi.stubEnv("CUSTOMER_SIGNUP_CLAIM_RELAXED", "");
        resetEnvCache();
      }
    });

    it("CUSTOMER_SIGNUP_CLAIM_RELAXED without a live intent of ours from the last 2 minutes: a direct /signup stays refused (re-review 103c D1)", async () => {
      vi.stubEnv("CUSTOMER_SIGNUP_CLAIM_RELAXED", "true");
      resetEnvCache();
      const { customerIdentityRepo } = await import("../../repositories/customer-identity.repo");
      try {
        // No intent at all.
        expect((await signedHook("before-user-created", withClaim(exampleEmail("relaxed-none")), BEFORE_SECRET)).status).toBe(403);
        // Only a retired intent (its `/otp` failed).
        const retired = exampleEmail("relaxed-retired");
        const id = await customerIdentityRepo.createIntent({ channel: "email", contactHash: sha(retired), now: new Date(), ttlMs: 120_000 });
        await customerIdentityRepo.retireIntent(id, new Date());
        expect((await signedHook("before-user-created", withClaim(retired), BEFORE_SECRET)).status).toBe(403);
        // An unexpired intent created more than 2 minutes ago, and an expired one.
        const old = exampleEmail("relaxed-old");
        await prisma.customerAuthIntent.create({ data: { id: uuidv7(), channel: "email", contactHash: sha(old), createdAt: new Date(Date.now() - 3 * 60_000), expiresAt: new Date(Date.now() + 60_000) } });
        expect((await signedHook("before-user-created", withClaim(old), BEFORE_SECRET)).status).toBe(403);
        const expired = exampleEmail("relaxed-expired");
        await prisma.customerAuthIntent.create({ data: { id: uuidv7(), channel: "email", contactHash: sha(expired), createdAt: new Date(Date.now() - 60_000), expiresAt: new Date(Date.now() - 1000) } });
        expect((await signedHook("before-user-created", withClaim(expired), BEFORE_SECRET)).status).toBe(403);
      } finally {
        vi.stubEnv("CUSTOMER_SIGNUP_CLAIM_RELAXED", "");
        resetEnvCache();
      }
    });

    it("two starts before the hook: the first start's creation still passes with its own claim, once (re-review 103c D2)", async () => {
      const { customerIdentityRepo } = await import("../../repositories/customer-identity.repo");
      const { signupClaimFor } = await import("../customer-identity.service");
      const address = exampleEmail("two-starts");
      const first = await customerIdentityRepo.createIntent({ channel: "email", contactHash: sha(address), now: new Date(), ttlMs: 120_000 });
      const second = await customerIdentityRepo.createIntent({ channel: "email", contactHash: sha(address), now: new Date(), ttlMs: 120_000 });
      // The second start retired the first intent (one live intent per address) …
      expect((await prisma.customerAuthIntent.findUniqueOrThrow({ where: { id: first } })).consumedAt).not.toBeNull();
      // … and Supabase's hook for the first start's `/otp` arrives only now, with the first claim: allowed, once.
      expect((await signedHook("before-user-created", withClaim(address, signupClaimFor(first)), BEFORE_SECRET)).status).toBe(200);
      expect((await signedHook("before-user-created", withClaim(address, signupClaimFor(first)), BEFORE_SECRET)).status).toBe(403);
      expect((await signedHook("before-user-created", withClaim(address, signupClaimFor(second)), BEFORE_SECRET)).status).toBe(200);
      // An intent created more than 2 minutes ago never matches.
      const stale = uuidv7();
      await prisma.customerAuthIntent.create({ data: { id: stale, channel: "email", contactHash: sha(address), createdAt: new Date(Date.now() - 3 * 60_000), expiresAt: new Date(Date.now() + 60_000) } });
      expect((await signedHook("before-user-created", withClaim(address, signupClaimFor(stale)), BEFORE_SECRET)).status).toBe(403);
    });

    it("hooks answer 404 while the sign-in is off", async () => {
      vi.stubEnv("CUSTOMER_SUPABASE_AUTH_ENABLED", "false");
      resetEnvCache();
      expect((await signedHook("send-email", {}, fake.sendEmailHookSecret)).status).toBe(404);
      const s = await r.start.POST(apiRequest("/api/auth/email/start", { body: { email: email("off") }, headers: { "x-forwarded-for": ip() } }), CTX);
      expect((await s.json()).error.details.reason).toBe("NOT_CONFIGURED");
      vi.stubEnv("CUSTOMER_SUPABASE_AUTH_ENABLED", "true");
      resetEnvCache();
    });

    it("a closed account is refused with ACCOUNT_CLOSED and no session", async () => {
      await signIn(email("closed"));
      const cid = (await identityCustomer(email("closed")))!;
      await prisma.customer.update({ where: { id: cid }, data: { deletedAt: new Date() } });
      const res = await signIn(email("closed"));
      expect(res.status).toBe(401);
      expect(res.body.error.details.reason).toBe("ACCOUNT_CLOSED");
      expect(res.cookie).toBeNull();
    });

    it("an existing phone account is never linked while CUSTOMER_PHONE_LINK_ENABLED is off (finding 4)", async () => {
      const phone = syntheticPhone(run, 2);
      const existing = await prisma.customer.create({ data: { id: uuidv7(), phoneE164: phone, fullName: `zz-sec-${run}` } });
      // First start creates the Supabase user; give it a confirmed phone and a phone identity, then sign in.
      await startCode(email("phone"));
      const user = [...fake.users.values()].find((u) => u.email === email("phone"))!;
      user.phone = phone.slice(1);
      user.phoneConfirmedAt = new Date().toISOString();
      user.identities.push({ provider: "phone", identity_data: { phone: phone.slice(1) } });
      const { customerIdentityRepo } = await import("../../repositories/customer-identity.repo");
      await customerIdentityRepo.createIntent({ channel: "phone", contactHash: sha(phone), now: new Date(), ttlMs: 120_000 });
      const res = await signIn(email("phone"));
      expect(res.status).toBe(200);
      expect(await identityCustomer(email("phone"))).not.toBe(existing.id);
    });

    it("with the switch on, a phone links only on a Supabase phone identity plus our own phone intent (Q9, finding 4)", async () => {
      vi.stubEnv("CUSTOMER_PHONE_LINK_ENABLED", "true");
      resetEnvCache();
      try {
        const { customerIdentityRepo } = await import("../../repositories/customer-identity.repo");
        const setUp = async (label: string, n: number, opts: { identity: boolean; confirmed: boolean; intent: boolean }) => {
          const phone = syntheticPhone(run, n);
          const existing = await prisma.customer.create({ data: { id: uuidv7(), phoneE164: phone, fullName: `zz-sec-${run}` } });
          await startCode(email(label));
          const u = [...fake.users.values()].find((x) => x.email === email(label))!;
          // A phone set through `PUT /user` on an email user, without a phone identity, is the attack shape.
          u.phone = phone.slice(1);
          u.phoneConfirmedAt = opts.confirmed ? new Date().toISOString() : null;
          if (opts.identity) u.identities.push({ provider: "phone", identity_data: { phone: phone.slice(1) } });
          if (opts.intent) await customerIdentityRepo.createIntent({ channel: "phone", contactHash: sha(phone), now: new Date(), ttlMs: 120_000 });
          const res = await signIn(email(label));
          expect(res.status).toBe(200);
          return { existing, linked: (await identityCustomer(email(label))) === existing.id };
        };
        expect((await setUp("phone-ok", 3, { identity: true, confirmed: true, intent: true })).linked).toBe(true);
        expect((await setUp("phone-no-identity", 4, { identity: false, confirmed: true, intent: true })).linked).toBe(false);
        expect((await setUp("phone-no-intent", 5, { identity: true, confirmed: true, intent: false })).linked).toBe(false);
        expect((await setUp("phone-unconfirmed", 6, { identity: true, confirmed: false, intent: true })).linked).toBe(false);
      } finally {
        vi.stubEnv("CUSTOMER_PHONE_LINK_ENABLED", "");
        resetEnvCache();
      }
    });

    it("a customer session never passes staff authentication", async () => {
      const res = await signIn(email("staff-check"));
      const { authService } = await import("../auth.service");
      await expect(authService.requireRequest(apiRequest("/api/admin/users", { cookie: res.cookie! }))).rejects.toThrow();
    });
  });

  /* ------------------------------------------------------------ attach rules */

  describe("attach rules (owner Q10)", () => {
    it("rule (a): the order's bound email verification equals the verified email → attached, audited, notice sent", async () => {
      const o = await guestOrder("rule-a");
      const res = await signIn(email("rule-a"));
      expect(res.body.attachedOrders).toBe(1);
      const cid = await identityCustomer(email("rule-a"));
      expect(await customerOf(o.id)).toBe(cid);
      const link = await prisma.orderAccountLink.findFirstOrThrow({ where: { orderId: o.id } });
      expect(link.rule).toBe("verified_email");
      expect(link.disputeTokenHash).toMatch(/^[0-9a-f]{64}$/);
      expect(link.disputeTokenCiphertext).toBeNull(); // the notice's outcome is known
      const n = await prisma.notification.findFirstOrThrow({ where: { orderId: o.id, event: "ACCOUNT_BOOKING_ATTACHED" } });
      expect(n.status).toBe("sent");
      expect(n.recipient).toBe(email("rule-a"));
      expect(JSON.stringify(n.payload)).not.toMatch(/token/i);
      expect(await prisma.auditLog.count({ where: { action: "customer.order_attached", entityId: o.id } })).toBe(1);
    });

    it("rule (a) never matches a typed email, an unbound verification, a variant address or another customer's order", async () => {
      const typed = await guestOrder("typed", { contact: email("someone-else") }); // lead_email is email("typed"), verified contact differs
      const unbound = await guestOrder("unbound", { bind: false });
      const plus = await guestOrder("plus", { contact: email("plus").replace("@", "+x@") });
      const owner = await prisma.customer.create({ data: { id: uuidv7(), fullName: `zz-sec-${run}` } });
      const taken = await guestOrder("taken", { customerId: owner.id });
      for (const label of ["typed", "unbound", "plus", "taken"]) await signIn(email(label));
      expect(await customerOf(typed.id)).toBeNull();
      expect(await customerOf(unbound.id)).toBeNull();
      expect(await customerOf(plus.id)).toBeNull();
      expect(await customerOf(taken.id)).toBe(owner.id);
    });

    it("rule (b): the same browser's guest session that paid → attached to whoever signs in there, notice to the order's verified email", async () => {
      const gs = await guestSession();
      const o = await guestOrder("rule-b", { guestSessionId: gs.id });
      const res = await signIn(email("rule-b-other-person"), { cookie: gs.cookie });
      expect(res.body.attachedOrders).toBe(1);
      expect(await customerOf(o.id)).toBe(await identityCustomer(email("rule-b-other-person")));
      const link = await prisma.orderAccountLink.findFirstOrThrow({ where: { orderId: o.id } });
      expect(link.rule).toBe("guest_session");
      const n = await prisma.notification.findFirstOrThrow({ where: { orderId: o.id, event: "ACCOUNT_BOOKING_ATTACHED" } });
      expect(n.recipient).toBe(email("rule-b"));
    });

    it("rule (b) refuses an expired session, another session, and a phone-only verification", async () => {
      const old = await guestSession(-1000);
      const expired = await guestOrder("b-expired", { guestSessionId: old.id });
      await signIn(email("b-expired-signer"), { cookie: old.cookie });
      expect(await customerOf(expired.id)).toBeNull();
      const mine = await guestSession();
      const theirs = await guestSession();
      const foreign = await guestOrder("b-foreign", { guestSessionId: theirs.id });
      const phoneOnly = await guestOrder("b-phone", { guestSessionId: mine.id, channel: "phone" });
      await signIn(email("b-mine-signer"), { cookie: mine.cookie });
      expect(await customerOf(foreign.id)).toBeNull();
      expect(await customerOf(phoneOnly.id)).toBeNull();
    });

    it("two sign-ins racing for the same order: one link, one owner", async () => {
      const gs = await guestSession();
      const o = await guestOrder("race", { guestSessionId: gs.id });
      const starts = new Map<string, string | null>();
      for (const l of ["race-1", "race-2"]) starts.set(l, startCookieOf(await startCode(email(l))));
      const go = (l: string) => r.verify.POST(apiRequest("/api/auth/email/verify", { body: { email: email(l), code: fake.codes.get(email(l)) }, cookie: joinCookies(gs.cookie, starts.get(l)), headers: { "x-forwarded-for": ip() } }), CTX);
      await Promise.all([go("race-1"), go("race-2")]);
      await (await import("../customer-identity.service")).accountNoticesSettledForTests();
      expect(await prisma.orderAccountLink.count({ where: { orderId: o.id, detachedAt: null } })).toBe(1);
      const owner = await customerOf(o.id);
      expect([await identityCustomer(email("race-1")), await identityCustomer(email("race-2"))]).toContain(owner);
    });

    it("more than 20 matching orders: none attached, staff alerted", async () => {
      for (let i = 0; i < 21; i++) await guestOrder(`cap-${i}`, { contact: email("cap") });
      const res = await signIn(email("cap"));
      expect(res.status).toBe(200);
      expect(res.body.attachedOrders).toBe(0);
      const cid = (await identityCustomer(email("cap")))!;
      expect(await prisma.order.count({ where: { customerId: cid } })).toBe(0);
      const { accountIncidents } = await import("../account-alerts");
      const incidents = await accountIncidents(new Date(Date.now() - 3_600_000), new Date());
      expect(incidents.some((i) => i.kind === "account_attach_capped" && i.entityId === cid)).toBe(true);
      // The audit row names the limit that fired (re-review 103c D8).
      expect((await prisma.auditLog.findFirstOrThrow({ where: { entityType: "customer_attach_cap", entityId: cid } })).after).toMatchObject({ candidates: ">20", limit: "attached" });
      // A later sign-in the same day records the cap once, not again (finding 12).
      await signIn(email("cap"));
      expect(await prisma.auditLog.count({ where: { entityType: "customer_attach_cap", entityId: cid } })).toBe(1);
    });

    it("an order with an open link is never a candidate, and the sign-in still succeeds (finding 12)", async () => {
      const o = await guestOrder("open-link");
      const holder = await prisma.customer.create({ data: { id: uuidv7(), fullName: `zz-sec-${run}` } });
      await prisma.orderAccountLink.create({ data: { id: uuidv7(), orderId: o.id, customerId: holder.id, rule: "staff" } });
      const res = await signIn(email("open-link"));
      expect(res.status).toBe(200);
      expect(res.body.attachedOrders).toBe(0);
      expect(await customerOf(o.id)).toBeNull();
      expect(await prisma.orderAccountLink.count({ where: { orderId: o.id, detachedAt: null } })).toBe(1);
    });

    it("without the capability key ring: rule (b) does not attach; rule (a) attaches and its failed notice alerts staff (finding 5)", async () => {
      const { setKeyRingsForTests } = await import("../../lib/crypto");
      const since = new Date(Date.now() - 60_000);
      setKeyRingsForTests({ capability_tokens: null });
      try {
        const gs = await guestSession();
        const b = await guestOrder("nokey-b", { guestSessionId: gs.id });
        const resB = await signIn(email("nokey-b-other-person"), { cookie: gs.cookie });
        expect(resB.status).toBe(200);
        expect(resB.body.attachedOrders).toBe(0);
        expect(await customerOf(b.id)).toBeNull();

        const a = await guestOrder("nokey-a");
        const resA = await signIn(email("nokey-a"));
        expect(resA.body.attachedOrders).toBe(1);
        const link = await prisma.orderAccountLink.findFirstOrThrow({ where: { orderId: a.id } });
        const n = await prisma.notification.findFirstOrThrow({ where: { orderId: a.id, event: "ACCOUNT_BOOKING_ATTACHED" } });
        expect(n.status).toBe("failed");
        const { accountIncidents } = await import("../account-alerts");
        const incidents = await accountIncidents(since, new Date());
        expect(incidents.some((i) => i.kind === "account_attach_notice_failed" && i.entityId === link.id && i.reason === "attach_notice_failed" && i.orderReference === a.reference)).toBe(true);
      } finally {
        setKeyRingsForTests(null);
      }
    });

    it("an attach whose notice row was never written alerts staff after 15 minutes (finding 5)", async () => {
      const o = await guestOrder("notice-missing");
      const holder = await prisma.customer.create({ data: { id: uuidv7(), fullName: `zz-sec-${run}` } });
      await prisma.order.update({ where: { id: o.id }, data: { customerId: holder.id } });
      const linkId = uuidv7();
      await prisma.orderAccountLink.create({ data: { id: linkId, orderId: o.id, customerId: holder.id, rule: "guest_session", attachedAt: new Date(Date.now() - 20 * 60_000) } });
      const { accountIncidents } = await import("../account-alerts");
      const incidents = await accountIncidents(new Date(Date.now() - 3_600_000), new Date());
      expect(incidents.some((i) => i.kind === "account_attach_notice_failed" && i.entityId === linkId && i.reason === "attach_notice_missing")).toBe(true);
    });

    it("the notice row is written before the response; only the send waits (re-review 103b N4)", async () => {
      const o = await guestOrder("queued-first");
      const headers = { "x-forwarded-for": ip() };
      const s = await startCode(email("queued-first"), headers);
      const v = await r.verify.POST(apiRequest("/api/auth/email/verify", { body: { email: email("queued-first"), code: fake.codes.get(email("queued-first")) }, cookie: startCookieOf(s) ?? undefined, headers }), CTX);
      expect(v.status).toBe(200);
      // Not waiting for the deferred send: the queued row and its link to the attach already exist.
      const link = await prisma.orderAccountLink.findFirstOrThrow({ where: { orderId: o.id } });
      expect(link.notificationId).toBeTruthy();
      expect(await prisma.notification.count({ where: { id: link.notificationId!, event: "ACCOUNT_BOOKING_ATTACHED" } })).toBe(1);
      await (await import("../customer-identity.service")).accountNoticesSettledForTests();
      expect((await prisma.notification.findUniqueOrThrow({ where: { id: link.notificationId! } })).status).toBe("sent");
    });

    it("the deferred send renews the row's claim first, and skips a row the outbox sweep has taken (re-review 103c D4)", async () => {
      const { notificationService } = await import("../notification.service");
      const holder = await prisma.customer.create({ data: { id: uuidv7(), fullName: `zz-sec-${run}` } });
      const queue = async (label: string) => {
        const o = await guestOrder(label);
        await prisma.order.update({ where: { id: o.id }, data: { customerId: holder.id } });
        const linkId = uuidv7();
        await prisma.orderAccountLink.create({ data: { id: linkId, orderId: o.id, customerId: holder.id, rule: "guest_session", attachedAt: new Date() } });
        const q = await notificationService.queueAccountLinkNotice({ linkId, orderId: o.id, recipient: exampleEmail(label) });
        if (!q || "duplicate" in q) throw new Error("expected a queued notice row");
        return q;
      };

      // The sweep claimed the row while this request's earlier sends were running: it is the sweep's to send.
      const taken = await queue("claim-taken");
      const sweepClaim = new Date(Date.now() + 125_000);
      await prisma.notification.update({ where: { id: taken.row.id }, data: { lockedUntil: sweepClaim, attempt: { increment: 1 } } });
      const skipped = await notificationService.sendQueuedAccountLinkNotice(taken);
      expect(skipped?.outcome).toBe("queued");
      const untouched = await prisma.notification.findUniqueOrThrow({ where: { id: taken.row.id } });
      expect(untouched.status).toBe("queued");
      expect(untouched.lockedUntil?.getTime()).toBe(sweepClaim.getTime());
      expect(untouched.attempt).toBe(2);

      // The claim taken at queue time has lapsed, but nobody else took the row: renewed, then attempted.
      const lapsed = await queue("claim-lapsed");
      const past = new Date(Date.now() - 1000);
      await prisma.notification.update({ where: { id: lapsed.row.id }, data: { lockedUntil: past } });
      const sent = await notificationService.sendQueuedAccountLinkNotice({ ...lapsed, claimUntil: past });
      expect(sent?.outcome).not.toBe("queued");
      expect((await prisma.notification.findUniqueOrThrow({ where: { id: lapsed.row.id } })).status).not.toBe("queued");
    });

    it("notice alerts: a suppressed notice counts as not sent; failed notices of detached links never hide a new failure (re-review 103b N5, N7)", async () => {
      const { accountIncidents } = await import("../account-alerts");
      const holder = await prisma.customer.create({ data: { id: uuidv7(), fullName: `zz-sec-${run}` } });
      const now = new Date();
      // More than one page of old failures (the first build read the oldest 100), all on detached links.
      const filler = await guestOrder("alerts-filler");
      const old = new Date(now.getTime() - 30 * 60_000);
      const fillerIds = Array.from({ length: 120 }, () => uuidv7());
      await prisma.notification.createMany({
        data: fillerIds.map((id) => ({ id, event: "ACCOUNT_BOOKING_ATTACHED", channel: "email" as const, recipient: email("alerts-filler"), orderId: filler.id, status: "failed" as const, providerError: "definite:x", attempt: 1, createdAt: old, failedAt: old })),
      });
      await prisma.orderAccountLink.createMany({ data: fillerIds.map((id) => ({ id: uuidv7(), orderId: filler.id, customerId: holder.id, rule: "staff", detachedAt: old, detachReason: "staff", notificationId: id })) });

      const attachWith = async (label: string, n: { status: "failed" | "suppressed"; providerError?: string; suppressedReason?: string; at: Date }) => {
        const o = await guestOrder(label);
        const nid = uuidv7();
        await prisma.notification.create({
          data: { id: nid, event: "ACCOUNT_BOOKING_ATTACHED", channel: "email", recipient: email(label), orderId: o.id, status: n.status, providerError: n.providerError ?? null, suppressedReason: n.suppressedReason ?? null, attempt: 1, createdAt: n.at, failedAt: n.status === "failed" ? n.at : null },
        });
        const linkId = uuidv7();
        await prisma.orderAccountLink.create({ data: { id: linkId, orderId: o.id, customerId: holder.id, rule: "guest_session", attachedAt: n.at, notificationId: nid } });
        return linkId;
      };
      const recent = new Date(now.getTime() - 60_000);
      const failed = await attachWith("alerts-failed", { status: "failed", providerError: "definite:invalid_recipient", at: recent });
      const optedOut = await attachWith("alerts-opted-out", { status: "suppressed", suppressedReason: "opted_out", at: recent });
      const allowlisted = await attachWith("alerts-allowlist", { status: "suppressed", suppressedReason: "non_production_allowlist", at: recent });

      const incidents = (await accountIncidents(new Date(now.getTime() - 10 * 60_000), new Date())).filter((i) => i.kind === "account_attach_notice_failed");
      const ids = incidents.map((i) => i.entityId);
      expect(ids).toContain(failed);
      expect(ids).toContain(optedOut);
      expect(ids).not.toContain(allowlisted);
    });

    it('"this was not me": detaches once, alerts staff, uniform answers, never re-attaches', async () => {
      const o = await guestOrder("dispute");
      await signIn(email("dispute"));
      const cid = await identityCustomer(email("dispute"));
      expect(await customerOf(o.id)).toBe(cid);
      const token = randomBytes(32).toString("base64url");
      await prisma.orderAccountLink.updateMany({ where: { orderId: o.id }, data: { disputeTokenHash: sha(token) } });
      const post = (t: string) => r.dispute.POST(apiRequest("/api/orders/account-link/dispute", { body: { token: t }, headers: { "x-forwarded-for": ip() } }), CTX);
      const wrong = await post(randomBytes(32).toString("base64url"));
      expect(await wrong.json()).toEqual({ ok: true });
      expect(await customerOf(o.id)).toBe(cid);
      const ok = await post(token);
      expect(await ok.json()).toEqual({ ok: true });
      expect(await customerOf(o.id)).toBeNull();
      const link = await prisma.orderAccountLink.findFirstOrThrow({ where: { orderId: o.id } });
      expect(link.detachReason).toBe("not_me");
      // The account is not signed out (Q-B4): its sessions stay live.
      expect(await prisma.customerSession.count({ where: { customerId: cid!, revokedAt: null } })).toBeGreaterThan(0);
      const again = await post(token);
      expect(await again.json()).toEqual({ ok: true });
      expect(await prisma.auditLog.count({ where: { action: "customer.order_detached", entityId: o.id } })).toBe(1);
      const { accountIncidents } = await import("../account-alerts");
      const incidents = await accountIncidents(new Date(Date.now() - 3_600_000), new Date());
      expect(incidents.some((i) => i.kind === "account_attach_disputed" && i.entityId === link.id && i.orderReference === o.reference)).toBe(true);
      await signIn(email("dispute"));
      expect(await customerOf(o.id)).toBeNull();
    });

    it("an expired not-me token changes nothing", async () => {
      const o = await guestOrder("dispute-old");
      await signIn(email("dispute-old"));
      const token = randomBytes(32).toString("base64url");
      await prisma.orderAccountLink.updateMany({ where: { orderId: o.id }, data: { disputeTokenHash: sha(token), disputeExpiresAt: new Date(Date.now() - 1000) } });
      await r.dispute.POST(apiRequest("/api/orders/account-link/dispute", { body: { token }, headers: { "x-forwarded-for": ip() } }), CTX);
      expect(await customerOf(o.id)).not.toBeNull();
    });
  });

  /* ------------------------------------------------------------ Google on our own callback */

  describe("Google on outlyy.com's own callback (Q-B1)", () => {
    async function start(next = "/account/bookings") {
      const res = await r.gStart.GET(apiRequest(`/api/auth/google/start?next=${encodeURIComponent(next)}`, { origin: null }), CTX);
      const loc = new URL(res.headers.get("location")!);
      const cookie = /(outlyy_oauth=[^;]+)/.exec(res.headers.get("set-cookie") ?? "")![1];
      return { res, loc, cookie };
    }

    it("start redirects to Google with our callback and sets the round-trip cookie", async () => {
      const { res, loc } = await start();
      expect(res.status).toBe(303);
      expect(loc.hostname).toBe("accounts.google.com");
      expect(loc.searchParams.get("redirect_uri")).toBe("http://localhost:3000/api/auth/google/callback");
      expect(res.headers.get("set-cookie")).toMatch(/HttpOnly/i);
    });

    it("callback: verified Google email → OUTLYY session, same customer as the email code for that address, next honoured", async () => {
      await signIn(email("google-same"));
      const before = await identityCustomer(email("google-same"));
      const { loc, cookie } = await start("/account/bookings");
      google.nextIdToken = await google.sign({ sub: "g-1", email: email("google-same"), email_verified: true, nonce: loc.searchParams.get("nonce") });
      const cb = await r.gCallback.GET(apiRequest(`/api/auth/google/callback?code=abc&state=${loc.searchParams.get("state")}`, { origin: null, cookie }), CTX);
      expect(cb.status).toBe(303);
      expect(new URL(cb.headers.get("location")!).pathname).toBe("/account/bookings");
      expect(cb.headers.get("set-cookie")).toMatch(/outlyy_customer_session=/);
      expect(await identityCustomer(email("google-same"))).toBe(before);
      const last = [...fake.requests].reverse().find((x) => x.path.startsWith("/token"))!;
      expect((last.body as { nonce: string }).nonce).not.toBe(loc.searchParams.get("nonce")); // raw nonce to Supabase, hashed to Google
    });

    it("cancel, a state mismatch, a missing cookie and an unverified email all land on /login with a short code", async () => {
      const cancel = await r.gCallback.GET(apiRequest("/api/auth/google/callback?error=access_denied", { origin: null }), CTX);
      expect(cancel.headers.get("location")).toMatch(/\/login\?e=google_cancelled$/);
      const { loc, cookie } = await start();
      const bad = await r.gCallback.GET(apiRequest(`/api/auth/google/callback?code=abc&state=forged`, { origin: null, cookie }), CTX);
      expect(bad.headers.get("location")).toMatch(/\/login\?e=google_failed$/);
      const noCookie = await r.gCallback.GET(apiRequest(`/api/auth/google/callback?code=abc&state=${loc.searchParams.get("state")}`, { origin: null }), CTX);
      expect(noCookie.headers.get("location")).toMatch(/\/login\?e=google_failed$/);
      google.nextIdToken = await google.sign({ sub: "g-2", email: email("g-unverified"), email_verified: false, nonce: loc.searchParams.get("nonce") });
      const unverified = await r.gCallback.GET(apiRequest(`/api/auth/google/callback?code=abc&state=${loc.searchParams.get("state")}`, { origin: null, cookie }), CTX);
      expect(unverified.headers.get("location")).toMatch(/\/login\?e=google_failed$/);
      expect(unverified.headers.get("set-cookie")).not.toMatch(/outlyy_customer_session=[^;]/);
    });
  });

  /* ------------------------------------------------------------ owner-only pilot */

  describe("owner-only pilot (CUSTOMER_AUTH_PILOT_EMAILS)", () => {
    const owner = () => exampleEmail("pilot-owner");
    beforeAll(() => {
      // Upper case and spaces in the list: compared trimmed and lower-cased.
      vi.stubEnv("CUSTOMER_AUTH_PILOT_EMAILS", ` ${owner().toUpperCase()} , zz-other-pilot@example.com`);
      resetEnvCache();
    });
    afterAll(() => {
      vi.stubEnv("CUSTOMER_AUTH_PILOT_EMAILS", "");
      resetEnvCache();
    });

    it("email: a code only for a listed address; any other address gets the same answer, and nothing is sent or charged site-wide", async () => {
      const svc = await import("../customer-identity.service");
      const at = new Date();
      svc.setIdentityClockForTests(() => at);
      const dayCount = async () => {
        const ms = 86_400_000;
        return (await prisma.rateLimitBucket.findUnique({ where: { key_windowStart: { key: "auth_email_start:global_day", windowStart: new Date(Math.floor(at.getTime() / ms) * ms) } } }))?.count ?? 0;
      };
      try {
        const stranger = exampleEmail("pilot-stranger");
        const otpBefore = fake.requests.filter((x) => x.path.startsWith("/otp")).length;
        const refused = await startCode(stranger);
        expect(refused.status).toBe(200);
        const refusedBody = await refused.json();
        expect(startCookieOf(refused)).toBeTruthy();
        expect(fake.requests.filter((x) => x.path.startsWith("/otp")).length).toBe(otpBefore);
        expect(await prisma.customerAuthIntent.count({ where: { contactHash: sha(stranger) } })).toBe(0);
        expect(await dayCount()).toBe(0);

        // The listed address, typed in another case: sent, with exactly the same answer.
        const ok = await startCode(owner().toUpperCase());
        expect(ok.status).toBe(200);
        expect(await ok.json()).toEqual(refusedBody);
        expect(fake.codes.get(owner().toLowerCase())).toBeTruthy();
        expect(await dayCount()).toBe(1);
      } finally {
        svc.setIdentityClockForTests(null);
      }
    });

    it("Google: starts only with ?pilot=1, and a Google email outside the list creates or links nothing", async () => {
      const plain = await r.gStart.GET(apiRequest("/api/auth/google/start?next=%2Faccount%2Fbookings", { origin: null }), CTX);
      expect(plain.headers.get("location")).toMatch(/\/login\?e=not_configured$/);
      const go = async () => {
        const res = await r.gStart.GET(apiRequest("/api/auth/google/start?next=%2Faccount%2Fbookings&pilot=1", { origin: null }), CTX);
        expect(res.status).toBe(303);
        const loc = new URL(res.headers.get("location")!);
        expect(loc.hostname).toBe("accounts.google.com");
        return { loc, cookie: /(outlyy_oauth=[^;]+)/.exec(res.headers.get("set-cookie") ?? "")![1] };
      };
      const callback = (f: { loc: URL; cookie: string }) => r.gCallback.GET(apiRequest(`/api/auth/google/callback?code=abc&state=${f.loc.searchParams.get("state")}`, { origin: null, cookie: f.cookie }), CTX);

      const stranger = exampleEmail("pilot-google-stranger");
      const a = await go();
      google.nextIdToken = await google.sign({ sub: `g-${run}-stranger`, email: stranger, email_verified: true, nonce: a.loc.searchParams.get("nonce") });
      const tokenCalls = fake.requests.filter((x) => x.path.startsWith("/token")).length;
      const refused = await callback(a);
      expect(refused.headers.get("location")).toMatch(/\/login\?e=not_configured$/);
      expect(refused.headers.get("set-cookie") ?? "").not.toMatch(/outlyy_customer_session=[^;]/);
      // Refused before Supabase was asked to sign the Google user in, and before our tail: nothing created or linked.
      expect(fake.requests.filter((x) => x.path.startsWith("/token")).length).toBe(tokenCalls);
      expect(await prisma.customerIdentity.count({ where: { email: stranger.toLowerCase() } })).toBe(0);

      const b = await go();
      google.nextIdToken = await google.sign({ sub: `g-${run}-owner`, email: owner(), email_verified: true, nonce: b.loc.searchParams.get("nonce") });
      const ok = await callback(b);
      expect(new URL(ok.headers.get("location")!).pathname).toBe("/account/bookings");
      expect(ok.headers.get("set-cookie")).toMatch(/outlyy_customer_session=/);
    });
  });

  /* ------------------------------------------------------------ retention */

  it("retention purges expired auth intents", async () => {
    const id = uuidv7();
    await prisma.customerAuthIntent.create({ data: { id, channel: "email", contactHash: sha(`old-${run}`), createdAt: new Date(Date.now() - 3 * 86_400_000), expiresAt: new Date(Date.now() - 3 * 86_400_000 + 120_000) } });
    const { prismaPurgeStore, purgeCutoff } = await import("../../jobs/retention-purge");
    await prismaPurgeStore.purgeBatch("customer_auth_intents", purgeCutoff("customer_auth_intents", new Date()), 500);
    expect(await prisma.customerAuthIntent.findUnique({ where: { id } })).toBeNull();
  });
});
