import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { createHash } from "node:crypto";
import {
  apiRequest,
  assertDisposableDb,
  cleanupPeople,
  createCustomer,
  dbEnabled,
  params,
  runId,
  syntheticPhone,
  type CustomerFixture,
} from "../helpers/fixtures";
import { cleanupBusinessRows, db, forbidNetwork, makeOrder, publishedProduct, type SeedProduct } from "./_mercury-fixtures";
import { uuidv7 } from "../../lib/ids";

/**
 * TKT-4 / F54: the typed phone on an instant-checkout order does not prove who
 * bought it. Phone linking at sign-in, `/api/me/orders` and `/api/me/export`
 * reach such an order only through an order-bound phone verification whose
 * hash is the verifying customer's phone. Assisted (legacy) orders keep the
 * existing phone rule. Synthetic numbers and amounts only.
 *
 * Cast: A checks out as a guest and types B's number P; B owns P and signs
 * in. O is an earlier account that already owns history on P. A recycled
 * number R is signed in for the first time by its new holder N.
 */

const run = runId();
const NO_CTX = params({});
const sha = (s: string) => createHash("sha256").update(s).digest("hex");
type Prisma = Awaited<ReturnType<typeof db>>;

let prisma: Prisma;
let product: SeedProduct;
let B: CustomerFixture;
let O: CustomerFixture;
const P = syntheticPhone(run, 81);
const Q = syntheticPhone(run, 82); // A's own number
const R = syntheticPhone(run, 83); // recycled
const quoteIds: string[] = [];
const guestIds: string[] = [];
const o: Record<string, string> = {};

async function addItem(orderId: string, origin: "instant_checkout" | "assisted_conversion") {
  const instant = origin === "instant_checkout";
  await prisma.orderItem.create({
    data: {
      id: uuidv7(),
      orderId,
      productId: product.id,
      titleSnapshot: `zz-sec-${run} item`,
      tierSnapshot: product.tier,
      slugSnapshot: product.slug,
      kindSnapshot: "activity",
      confirmationSnapshot: instant ? "instant" : "manual",
      fulfilmentModeSnapshot: instant ? "instant" : "inquiry",
      freeCancellationHoursSnapshot: 24,
      durationMinutesSnapshot: 60,
      serviceDate: new Date("2030-01-15T00:00:00.000Z"),
      pax: { adult: 1 },
      unitInr: 1_000n,
      unitAed: 45n,
      totalInr: 1_000n,
      totalAed: 45n,
      fulfilmentOrigin: origin,
    },
  });
}

/** A used guest quote for the order and, when `bind`, a verification row bound to it. */
async function verification(orderId: string, channel: "phone" | "email", contact: string, bind = true) {
  const guestSessionId = uuidv7();
  const now = Date.now();
  await prisma.guestSession.create({ data: { id: guestSessionId, tokenHash: sha(`gs:${run}:${guestSessionId}`), expiresAt: new Date(now + 3_600_000) } });
  guestIds.push(guestSessionId);
  const quoteId = uuidv7();
  await prisma.quote.create({
    data: {
      id: quoteId,
      fingerprint: sha(`q:${run}:${quoteId}`),
      ownerKind: "guest",
      guestSessionId,
      currency: "AED",
      totalMinor: 45n,
      lines: [],
      request: { lines: [] },
      status: bind ? "used" : "active",
      usedByOrderId: bind ? orderId : null,
      expiresAt: new Date(now + 600_000),
    },
  });
  quoteIds.push(quoteId);
  await prisma.orderContactVerification.create({
    data: {
      id: uuidv7(),
      quoteId,
      orderId: bind ? orderId : null,
      channel,
      contactHash: sha(contact),
      method: channel === "phone" ? "otp_sms" : "email_code",
      verifiedAt: new Date(now),
    },
  });
}

async function order(label: string, opts: { phone?: string; customerId?: string; items: Array<"instant_checkout" | "assisted_conversion"> }) {
  const created = await makeOrder(run, { leadPhone: opts.phone ?? P, customerId: opts.customerId ?? null, label });
  for (const origin of opts.items) await addItem(created.id, origin);
  o[label] = created.id;
  return created.id;
}

const ids = (rows: Array<{ id: string }>) => rows.map((r) => r.id).sort();
const pick = (...labels: string[]) => labels.map((l) => o[l]).sort();

describe.skipIf(!dbEnabled)("TKT-4: instant orders are not reachable by typed phone alone", () => {
  beforeAll(async () => {
    assertDisposableDb();
    forbidNetwork();
    prisma = await db();
    product = await publishedProduct();
    B = await createCustomer(run, P);
    O = await createCustomer(run, syntheticPhone(run, 84));

    // Legacy: assisted and item-less orders on P, unlinked.
    await order("assisted", { items: ["assisted_conversion"] });
    await order("no-items", { items: [] });
    // A's instant orders typed with P.
    await order("instant-unverified", { items: ["instant_checkout"] });
    const emailOnly = await order("instant-email-only", { items: ["instant_checkout"] });
    await verification(emailOnly, "email", `zz-sec-${run}-a@outlyy.test`);
    const otherPhone = await order("instant-other-phone", { items: ["instant_checkout"] });
    await verification(otherPhone, "phone", Q);
    const unbound = await order("instant-unbound", { items: ["instant_checkout"] });
    await verification(unbound, "phone", P, false);
    // Checked out by P's holder: the verification proves it.
    const verified = await order("instant-verified-p", { items: ["instant_checkout", "assisted_conversion"] });
    await verification(verified, "phone", P);
    // O's history on P stays O's.
    await order("old-owner", { customerId: O.id, items: ["assisted_conversion"] });
  });

  afterAll(async () => {
    vi.unstubAllGlobals();
    await prisma.orderContactVerification.deleteMany({ where: { quoteId: { in: quoteIds } } });
    await prisma.quote.deleteMany({ where: { id: { in: quoteIds } } });
    await prisma.guestSession.deleteMany({ where: { id: { in: guestIds } } });
    await cleanupBusinessRows(run);
    await prisma.customer.deleteMany({ where: { phoneE164: R } });
    await cleanupPeople(run);
  });

  it("listOrders: B sees legacy orders and the instant order verified with P, nothing else of A's", async () => {
    const { customerRepo } = await import("../../repositories/customer.repo");
    const rows = await customerRepo.listOrders(B.id, P);
    expect(ids(rows)).toEqual(pick("assisted", "no-items", "instant-verified-p"));
  });

  it("/api/me/orders and /api/me/export apply the same rule", async () => {
    const want = pick("assisted", "no-items", "instant-verified-p");
    const ordersRes = await (await import("@/app/api/me/orders/route")).GET(apiRequest("/api/me/orders", { cookie: B.cookie }), NO_CTX);
    expect(ordersRes.status).toBe(200);
    const { items } = (await ordersRes.json()) as { items: Array<{ id: string }> };
    expect(ids(items)).toEqual(want);

    const exportRes = await (await import("@/app/api/me/export/route")).GET(apiRequest("/api/me/export", { cookie: B.cookie }), NO_CTX);
    expect(exportRes.status).toBe(200);
    const text = await exportRes.text();
    for (const label of ["instant-unverified", "instant-email-only", "instant-other-phone", "instant-unbound", "old-owner"]) expect(text, label).not.toContain(o[label]);
    for (const id of want) expect(text).toContain(id);
  });

  it("linkByPhone links legacy orders and the verified instant order only; O's history does not move", async () => {
    const { customerRepo } = await import("../../repositories/customer.repo");
    const linked = await customerRepo.linkByPhone(B.id, P);
    expect(linked.orders).toBe(3);
    const rows = await prisma.order.findMany({ where: { id: { in: Object.values(o) } }, select: { id: true, customerId: true } });
    const owner = Object.fromEntries(rows.map((r) => [r.id, r.customerId]));
    for (const l of ["assisted", "no-items", "instant-verified-p"]) expect(owner[o[l]], l).toBe(B.id);
    for (const l of ["instant-unverified", "instant-email-only", "instant-other-phone", "instant-unbound"]) expect(owner[o[l]], l).toBeNull();
    expect(owner[o["old-owner"]]).toBe(O.id);
    // Idempotent: nothing more to link.
    expect((await customerRepo.linkByPhone(B.id, P)).orders).toBe(0);
  });

  it("recycled number: the new holder's first sign-in links legacy history only, never the old holder's instant order", async () => {
    await order("recycled-instant", { phone: R, items: ["instant_checkout"] });
    await verification(o["recycled-instant"], "email", `zz-sec-${run}-old@outlyy.test`);
    await order("recycled-legacy", { phone: R, items: ["assisted_conversion"] });

    const { customerAuthService } = await import("../../services/customer-auth.service");
    const { log } = await import("../../lib/logger");
    const ip = `198.19.${(Number.parseInt(run.slice(-2), 16) % 200) + 20}.79`;
    const debug = vi.spyOn(log, "debug");
    const { challengeId } = await customerAuthService.requestOtp({ phone: R.slice(3), countryCode: "+91", ip });
    const logged = debug.mock.calls.find(([m]) => String(m).startsWith("sms.log_adapter.otp_code"));
    debug.mockRestore();
    const code = String((logged?.[1] as { devOtpCode?: string })?.devOtpCode);
    expect(code).toMatch(/^\d{6}$/);

    const signedIn = await customerAuthService.verifyOtp({ challengeId, code, ip });
    const rows = await prisma.order.findMany({ where: { id: { in: [o["recycled-instant"], o["recycled-legacy"]] } }, select: { id: true, customerId: true } });
    const owner = Object.fromEntries(rows.map((r) => [r.id, r.customerId]));
    expect(owner[o["recycled-legacy"]]).toBe(signedIn.customer.id);
    expect(owner[o["recycled-instant"]]).toBeNull();

    const { customerRepo } = await import("../../repositories/customer.repo");
    expect(ids(await customerRepo.listOrders(signedIn.customer.id, R))).toEqual(pick("recycled-legacy"));
  });
});
