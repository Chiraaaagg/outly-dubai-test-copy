import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createHmac } from "node:crypto";
import type { NextRequest } from "next/server";
import {
  apiRequest,
  assertDisposableDb,
  cleanupPeople,
  createCustomer,
  createStaff,
  dbEnabled,
  params,
  runId,
  syntheticPhone,
  type CustomerFixture,
  type StaffFixture,
} from "../helpers/fixtures";
import { ROUTES, type Auth, type RouteCase } from "./_route-table";
import { cleanupBusinessRows, makeOrder } from "./_mercury-fixtures";

/**
 * H04 — every cookie-authenticated mutation route, and every public JSON
 * mutation route, called directly as a route handler:
 *
 *   - foreign Origin, `Origin: null`, no Origin, and `Sec-Fetch-Site:
 *     cross-site` → 403, even with a valid session cookie;
 *   - same origin but `text/plain`, urlencoded or multipart → 415 on every
 *     JSON route (form encodings are what a cross-site <form> can send);
 *   - representative same-origin JSON calls still succeed;
 *   - the deliberate exceptions still work: `/api/events` takes a
 *     same-origin text/plain beacon, the WhatsApp webhook takes a signed
 *     request with no Origin, cron jobs take the secret with no Origin.
 *
 * What this does NOT claim: these are handcrafted requests. A real browser
 * cannot drop or forge `Origin` on a cross-site POST, so "missing Origin"
 * here is a non-browser client, not a CSRF exploit; it is refused because
 * nothing about it proves it came from our pages.
 */

const run = runId();
const savedTrust = process.env.TRUST_PROXY_IP_HEADERS;
const runOctet = (Number.parseInt(run.slice(-2), 16) % 200) + 20;
/** Unique trusted IP per run so IP-keyed limits (lookup, OTP) start empty. */
const IP = `198.19.${runOctet}.9`;

type Handler = (req: NextRequest, ctx: { params: Promise<Record<string, string>> }) => Promise<Response>;

let admin: StaffFixture;
let target: StaffFixture;
let customer: CustomerFixture;
let prisma: typeof import("@/server/lib/db").prisma;

function cookieFor(auth: Auth): string | undefined {
  if (auth === "admin") return admin.cookie;
  if (auth === "customer") return customer.cookie;
  return undefined;
}

async function call(rc: RouteCase, opts: Parameters<typeof apiRequest>[1] = {}): Promise<Response> {
  const mod = await rc.load();
  const fn = mod[rc.method] as Handler;
  const headers = { "x-real-ip": IP, ...(opts.headers ?? {}) };
  return fn(apiRequest(rc.path, { method: rc.method, cookie: cookieFor(rc.auth), ...opts, headers }), params(rc.params ?? {}));
}

describe.skipIf(!dbEnabled)("H04 origin and media type on mutation routes", () => {
  beforeAll(async () => {
    assertDisposableDb();
    process.env.TRUST_PROXY_IP_HEADERS = "true";
    prisma = (await import("@/server/lib/db")).prisma;
    admin = await createStaff(run, "admin", ["admin"]);
    target = await createStaff(run, "target", ["agent"]);
    customer = await createCustomer(run, syntheticPhone(run, 1));
  });

  afterAll(async () => {
    if (savedTrust === undefined) delete process.env.TRUST_PROXY_IP_HEADERS;
    else process.env.TRUST_PROXY_IP_HEADERS = savedTrust;
    if (prisma) {
      await prisma.guestCapabilityGrant.deleteMany({ where: { order: { leadName: { startsWith: `zz-sec-${run}` } } } });
      await cleanupBusinessRows(run);
      await cleanupPeople(run);
    }
  });

  describe.each(ROUTES.map((r) => [`${r.method} ${r.path}`, r] as const))("%s", (_label, rc) => {
    const body = rc.body === "none" ? undefined : {};
    it.each([
      ["foreign Origin", { origin: "https://evil.example" }],
      ["Origin: null", { origin: "null" }],
      ["no Origin", { origin: null }],
      ["lookalike Origin", { origin: "https://localhost:3000.evil.example" }],
      ["allowed Origin but Sec-Fetch-Site: cross-site", { headers: { "sec-fetch-site": "cross-site" } }],
    ] as const)("%s → 403", async (_l, o) => {
      const res = await call(rc, { body, ...o });
      expect(res.status).toBe(403);
    });

    if (rc.body !== "none") {
      it.each([
        ["text/plain", "text/plain;charset=UTF-8", '{"a":1}'],
        ["urlencoded form", "application/x-www-form-urlencoded", "a=1"],
        ["multipart form", "multipart/form-data; boundary=zzsec", '--zzsec\r\nContent-Disposition: form-data; name="a"\r\n\r\n1\r\n--zzsec--\r\n'],
      ] as const)("same origin, %s body → 415", async (label, contentType, rawBody) => {
        const res = await call(rc, { rawBody, contentType });
        if (label === "multipart form" && rc.multipartAllowed) {
          // CSV upload: multipart is the accepted format here; the form lacks a file.
          expect(res.status).toBe(422);
          return;
        }
        expect(res.status).toBe(415);
      });
    }
  });

  describe("no state change on refusal (real fixtures)", () => {
    const usersRoute = ROUTES.find((r) => r.file === "admin/users")!;
    const userRoute = ROUTES.find((r) => r.file === "admin/users/[id]")!;
    const meRoute = ROUTES.find((r) => r.file === "me" && r.method === "PATCH")!;
    const inquiriesRoute = ROUTES.find((r) => r.file === "inquiries")!;
    const adminLogout = ROUTES.find((r) => r.file === "admin/auth/logout")!;

    it("creating a staff user: refused requests create nothing", async () => {
      const before = await prisma.adminUser.count();
      const body = { email: `zz-sec-${run}-csrf@outlyy.test`, fullName: "Should Not Exist", roles: ["readonly"] };
      expect((await call(usersRoute, { body, origin: "https://evil.example" })).status).toBe(403);
      expect((await call(usersRoute, { body, origin: null })).status).toBe(403);
      expect((await call(usersRoute, { rawBody: JSON.stringify(body), contentType: "text/plain" })).status).toBe(415);
      expect(await prisma.adminUser.count()).toBe(before);
    });

    it("suspending another staff user: refused requests leave them active with live sessions", async () => {
      const rc = { ...userRoute, params: { id: target.id }, path: `/api/admin/users/${target.id}` };
      const body = { status: "suspended" };
      expect((await call(rc, { body, origin: "null" })).status).toBe(403);
      expect((await call(rc, { body, headers: { "sec-fetch-site": "cross-site" } })).status).toBe(403);
      expect((await call(rc, { rawBody: "status=suspended", contentType: "application/x-www-form-urlencoded" })).status).toBe(415);
      const row = await prisma.adminUser.findUnique({ where: { id: target.id } });
      expect(row?.status).toBe("active");
      const session = await prisma.adminSession.findUnique({ where: { id: target.sessionId } });
      expect(session?.revokedAt).toBeNull();
    });

    it("editing the customer profile: refused requests change nothing; same-origin JSON succeeds", async () => {
      expect((await call(meRoute, { body: { hotel: "CSRF Hotel" }, origin: "https://evil.example" })).status).toBe(403);
      expect((await call(meRoute, { rawBody: "hotel=CSRF+Hotel", contentType: "application/x-www-form-urlencoded" })).status).toBe(415);
      expect((await prisma.customer.findUnique({ where: { id: customer.id } }))?.hotel).toBeNull();
      const ok = await call(meRoute, { body: { hotel: `zz-sec-${run} hotel` } });
      expect(ok.status).toBe(200);
      expect((await prisma.customer.findUnique({ where: { id: customer.id } }))?.hotel).toBe(`zz-sec-${run} hotel`);
    });

    it("submitting an inquiry as a form or text creates nothing", async () => {
      const before = await prisma.inquiry.count();
      const res = await call(inquiriesRoute, { rawBody: JSON.stringify({ leadName: "zz", leadPhone: "9999999999", countryCode: "IN", items: [] }), contentType: "text/plain" });
      expect(res.status).toBe(415);
      expect(await prisma.inquiry.count()).toBe(before);
    });

    it("staff logout: a cross-site request does not revoke the session; same-origin does", async () => {
      const victim = await createStaff(run, "logout", ["readonly"]);
      const rc = { ...adminLogout, auth: "public" as Auth };
      expect((await call(rc, { cookie: victim.cookie, origin: "https://evil.example" })).status).toBe(403);
      expect((await prisma.adminSession.findUnique({ where: { id: victim.sessionId } }))?.revokedAt).toBeNull();
      expect((await call(rc, { cookie: victim.cookie })).status).toBe(200);
      expect((await prisma.adminSession.findUnique({ where: { id: victim.sessionId } }))?.revokedAt).not.toBeNull();
    });

    it("same-origin JSON staff-user creation succeeds", async () => {
      const res = await call(usersRoute, { body: { email: `zz-sec-${run}-created@outlyy.test`, fullName: "Fixture Created", roles: ["readonly"] } });
      expect(res.status).toBe(201);
      expect(await prisma.adminUser.count({ where: { email: `zz-sec-${run}-created@outlyy.test` } })).toBe(1);
    });

    it("ticket exchange: refused requests consume nothing; same-origin JSON exchanges once", async () => {
      const rc = ROUTES.find((r) => r.file === "tickets/exchange")!;
      const { capabilityService } = await import("@/server/services/capability.service");
      const order = await makeOrder(run, { leadPhone: syntheticPhone(run, 2), label: "om-exchange" });
      const g = await capabilityService.mint(prisma, { orderId: order.id, purpose: "download_tickets", issuedFor: "ticket_notification" });
      const body = { token: g.token };
      expect((await call(rc, { body, origin: "https://evil.example" })).status).toBe(403);
      expect((await call(rc, { body, origin: null })).status).toBe(403);
      expect((await call(rc, { body, headers: { "sec-fetch-site": "cross-site" } })).status).toBe(403);
      expect((await call(rc, { rawBody: `token=${g.token}`, contentType: "application/x-www-form-urlencoded" })).status).toBe(415);
      expect((await prisma.guestCapabilityGrant.findUniqueOrThrow({ where: { id: g.grantId } })).exchangeCount).toBe(0);
      const ok = await call(rc, { body });
      expect(ok.status).toBe(200);
      expect((await prisma.guestCapabilityGrant.findUniqueOrThrow({ where: { id: g.grantId } })).exchangeCount).toBe(1);
    });

    it("an empty optional body is still accepted where the route allows it", async () => {
      const rc = ROUTES.find((r) => r.file === "me/delete-request")!;
      const res = await call(rc, { rawBody: "", contentType: null });
      expect(res.status).toBe(200);
    });
  });

  describe("deliberate exceptions", () => {
    it("/api/events accepts a same-origin text/plain beacon", async () => {
      const { POST } = await import("@/app/api/events/route");
      const res = await POST(apiRequest("/api/events", { rawBody: JSON.stringify([{ event: "page_view", event_id: `zz-sec-${run}-om`, page_path: "/" }]), contentType: "text/plain;charset=UTF-8", headers: { "x-real-ip": IP } }), params({}));
      expect(res.status).toBe(204);
      await prisma.analyticsEvent.deleteMany({ where: { eventId: `zz-sec-${run}-om` } });
    });

    it("the WhatsApp webhook accepts a correctly signed request with no Origin", async () => {
      const secret = process.env.WHATSAPP_WEBHOOK_SECRET;
      expect(secret, "test env must define a local WHATSAPP_WEBHOOK_SECRET").toBeTruthy();
      const { POST } = await import("@/app/api/webhooks/whatsapp/route");
      const body = JSON.stringify({ object: "whatsapp_business_account", entry: [], note: `zz-sec-${run}-om` });
      const sig = `sha256=${createHmac("sha256", secret!).update(body).digest("hex")}`;
      const res = await POST(apiRequest("/api/webhooks/whatsapp", { rawBody: body, origin: null, headers: { "x-hub-signature-256": sig } }));
      expect(res.status).toBe(200);
      await prisma.webhookEvent.deleteMany({ where: { payload: { path: ["note"], equals: `zz-sec-${run}-om` } } });
    });

    it("cron jobs accept the secret with no Origin, and refuse without it", async () => {
      const secret = process.env.CRON_SECRET;
      expect(secret, "test env must define a local CRON_SECRET").toBeTruthy();
      const { POST } = await import("@/app/api/jobs/inquiry-sweep/route");
      const denied = await POST(apiRequest("/api/jobs/inquiry-sweep", { method: "POST", origin: null }), params({}));
      expect(denied.status).toBe(401);
      const ok = await POST(apiRequest("/api/jobs/inquiry-sweep", { method: "POST", origin: null, headers: { authorization: `Bearer ${secret}` } }), params({}));
      expect(ok.status).toBe(200);
    });
  });
});
