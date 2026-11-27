import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
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

async function signIn(address: string, opts: { cookie?: string; code?: string } = {}) {
  const headers = { "x-forwarded-for": ip() };
  const s = await r.start.POST(apiRequest("/api/auth/email/start", { body: { email: address }, headers }), CTX);
  if (s.status !== 200) return { status: s.status, body: await s.json(), cookie: null as string | null };
  const code = opts.code ?? fake.codes.get(address.toLowerCase())!;
  const v = await r.verify.POST(apiRequest("/api/auth/email/verify", { body: { email: address, code }, cookie: opts.cookie, headers }), CTX);
  const setCookie = v.headers.get("set-cookie") ?? "";
  const m = /outlyy_customer_session=([^;]+)/.exec(setCookie);
  return { status: v.status, body: await v.json(), cookie: m ? `outlyy_customer_session=${m[1]}` : null };
}

/** A guest session with a known token, and its cookie. */
async function guestSession(expiresInMs = 3_600_000) {
  const token = randomBytes(32).toString("base64url");
  const id = uuidv7();
  await prisma.guestSession.create({ data: { id, tokenHash: sha(token), expiresAt: new Date(Date.now() + expiresInMs) } });
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
    fake = await startFakeSupabase();

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
      await customerIdentityRepo.createIntent({ channel: "email", contactHash: sha(email("allowed")), now: new Date(), ttlMs: 120_000 });
      expect((await signedHook("before-user-created", u(email("allowed"), "email"), BEFORE_SECRET)).status).toBe(200);
      expect((await signedHook("before-user-created", u(email("allowed"), "email"), fake.sendEmailHookSecret)).status).toBe(401);
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

    it("an existing phone account is linked only when Supabase confirmed that phone (Q9)", async () => {
      const phone = syntheticPhone(run, 2);
      const existing = await prisma.customer.create({ data: { id: uuidv7(), phoneE164: phone, fullName: `zz-sec-${run}` } });
      // First sign-in creates the Supabase user; give it a confirmed phone, then sign in on a fresh identity.
      await r.start.POST(apiRequest("/api/auth/email/start", { body: { email: email("phone") }, headers: { "x-forwarded-for": ip() } }), CTX);
      const user = [...fake.users.values()].find((u) => u.email === email("phone"))!;
      user.phone = phone.slice(1);
      user.phoneConfirmedAt = new Date().toISOString();
      const res = await signIn(email("phone"));
      expect(res.status).toBe(200);
      expect(await identityCustomer(email("phone"))).toBe(existing.id);

      // An unconfirmed phone links nothing.
      const phone2 = syntheticPhone(run, 3);
      const other = await prisma.customer.create({ data: { id: uuidv7(), phoneE164: phone2, fullName: `zz-sec-${run}` } });
      await r.start.POST(apiRequest("/api/auth/email/start", { body: { email: email("phone2") }, headers: { "x-forwarded-for": ip() } }), CTX);
      const u2 = [...fake.users.values()].find((u) => u.email === email("phone2"))!;
      u2.phone = phone2.slice(1);
      u2.phoneConfirmedAt = null;
      await signIn(email("phone2"));
      expect(await identityCustomer(email("phone2"))).not.toBe(other.id);
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
      for (const l of ["race-1", "race-2"]) await r.start.POST(apiRequest("/api/auth/email/start", { body: { email: email(l) }, headers: { "x-forwarded-for": ip() } }), CTX);
      const go = (l: string) => r.verify.POST(apiRequest("/api/auth/email/verify", { body: { email: email(l), code: fake.codes.get(email(l)) }, cookie: gs.cookie, headers: { "x-forwarded-for": ip() } }), CTX);
      await Promise.all([go("race-1"), go("race-2")]);
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

  /* ------------------------------------------------------------ retention */

  it("retention purges expired auth intents", async () => {
    const id = uuidv7();
    await prisma.customerAuthIntent.create({ data: { id, channel: "email", contactHash: sha(`old-${run}`), createdAt: new Date(Date.now() - 3 * 86_400_000), expiresAt: new Date(Date.now() - 3 * 86_400_000 + 120_000) } });
    const { prismaPurgeStore, purgeCutoff } = await import("../../jobs/retention-purge");
    await prismaPurgeStore.purgeBatch("customer_auth_intents", purgeCutoff("customer_auth_intents", new Date()), 500);
    expect(await prisma.customerAuthIntent.findUnique({ where: { id } })).toBeNull();
  });
});
