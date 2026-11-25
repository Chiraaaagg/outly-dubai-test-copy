import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createHash } from "node:crypto";
import { assertDisposableDb, dbEnabled, runId, syntheticPhone } from "@/server/__tests__/helpers/fixtures";
import { cleanupBusinessRows, db, forbidNetwork, makeOrder, publishedProduct, type SeedProduct } from "@/server/__tests__/security/_mercury-fixtures";
import { uuidv7 } from "@/server/lib/ids";

/**
 * Guest capability grants against the disposable database (TKT-5, doc 22
 * §26 F39): hash-only storage, supersession, the bounded POST exchange, the
 * signed access cookie re-checked on every resolve, and revocation.
 */

const run = runId();
const sha = (s: string) => createHash("sha256").update(s).digest("hex");
const DAY = 24 * 3600_000;

type Prisma = Awaited<ReturnType<typeof db>>;
let prisma: Prisma;
let svc: typeof import("@/server/services/capability.service");
let product: SeedProduct;
const orders: { id: string; reference: string }[] = [];

async function order(label: string, serviceDates: string[]) {
  const o = await makeOrder(run, { leadPhone: syntheticPhone(run, 10 + orders.length), label });
  for (const d of serviceDates) {
    await prisma.orderItem.create({
      data: {
        id: uuidv7(),
        orderId: o.id,
        productId: product.id,
        titleSnapshot: `zz-sec-${run} item`,
        tierSnapshot: product.tier,
        slugSnapshot: product.slug,
        kindSnapshot: "activity",
        confirmationSnapshot: "instant",
        fulfilmentModeSnapshot: "instant",
        freeCancellationHoursSnapshot: 24,
        durationMinutesSnapshot: 60,
        serviceDate: new Date(`${d}T00:00:00.000Z`),
        pax: { adult: 1 },
        unitInr: 1_000n,
        unitAed: 45n,
        totalInr: 1_000n,
        totalAed: 45n,
      },
    });
  }
  orders.push(o);
  return o;
}

describe.skipIf(!dbEnabled)("capability grants (TKT-5)", () => {
  beforeAll(async () => {
    assertDisposableDb();
    forbidNetwork();
    prisma = await db();
    svc = await import("@/server/services/capability.service");
    product = await publishedProduct();
  });

  afterAll(async () => {
    if (!prisma) return;
    await prisma.guestCapabilityGrant.deleteMany({ where: { orderId: { in: orders.map((o) => o.id) } } });
    await cleanupBusinessRows(run);
  });

  it("stores the token only as its SHA-256; keepForRetry adds a v2 ciphertext, never plaintext", async () => {
    const o = await order("hash", ["2030-01-15"]);
    const now = new Date();
    const plain = await svc.capabilityService.mint(prisma, { orderId: o.id, purpose: "view_status", issuedFor: "status_notification" }, now);
    expect(plain.token).toMatch(/^[A-Za-z0-9_-]{43}$/); // 32 random bytes
    const row = await prisma.guestCapabilityGrant.findUniqueOrThrow({ where: { id: plain.grantId } });
    expect(row.tokenHash).toBe(sha(plain.token));
    expect(row.tokenCiphertext).toBeNull();
    expect(JSON.stringify(row)).not.toContain(plain.token);

    const kept = await svc.capabilityService.mint(prisma, { orderId: o.id, purpose: "download_tickets", issuedFor: "ticket_notification", keepForRetry: true }, now);
    const keptRow = await prisma.guestCapabilityGrant.findUniqueOrThrow({ where: { id: kept.grantId } });
    expect(keptRow.tokenCiphertext).toMatch(/^v2\.capability_tokens\./);
    expect(JSON.stringify(keptRow)).not.toContain(kept.token);
    expect(await svc.capabilityService.tokenForRetry(kept.grantId, now)).toBe(kept.token);
    await svc.capabilityService.clearCiphertext(kept.grantId);
    expect(await svc.capabilityService.tokenForRetry(kept.grantId, now)).toBeNull();
  });

  it("expiry: 30 days after the last service day, at least 7, at most 180", async () => {
    const now = new Date("2029-12-01T10:00:00.000Z");
    expect(svc.grantExpiry("download_tickets", new Date("2030-01-15T00:00:00.000Z"), now).toISOString()).toBe("2030-02-15T00:00:00.000Z");
    expect(svc.grantExpiry("download_tickets", new Date("2029-11-01T00:00:00.000Z"), now).getTime()).toBe(now.getTime() + 7 * DAY);
    expect(svc.grantExpiry("view_status", new Date("2031-01-01T00:00:00.000Z"), now).getTime()).toBe(now.getTime() + 180 * DAY);
    expect(svc.grantExpiry("cancel_request", new Date("2031-01-01T00:00:00.000Z"), now).getTime()).toBe(now.getTime() + 3 * DAY);
    const o = await order("expiry", ["2030-01-10", "2030-01-15"]);
    const g = await svc.capabilityService.mint(prisma, { orderId: o.id, purpose: "download_tickets", issuedFor: "ticket_notification" }, now);
    expect(g.expiresAt.toISOString()).toBe("2030-02-15T00:00:00.000Z");
  });

  it("minting supersedes the live grant of the same order and purpose only", async () => {
    const a = await order("supersede-a", ["2030-01-15"]);
    const b = await order("supersede-b", ["2030-01-15"]);
    const first = await svc.capabilityService.mint(prisma, { orderId: a.id, purpose: "download_tickets", issuedFor: "ticket_notification", keepForRetry: true });
    const status = await svc.capabilityService.mint(prisma, { orderId: a.id, purpose: "view_status", issuedFor: "status_notification" });
    const other = await svc.capabilityService.mint(prisma, { orderId: b.id, purpose: "download_tickets", issuedFor: "ticket_notification" });
    const second = await svc.capabilityService.mint(prisma, { orderId: a.id, purpose: "download_tickets", issuedFor: "staff_resend" });

    const rows = await prisma.guestCapabilityGrant.findMany({ where: { id: { in: [first.grantId, status.grantId, other.grantId, second.grantId] } } });
    const by = Object.fromEntries(rows.map((r) => [r.id, r]));
    expect(by[first.grantId].revokeReason).toBe("superseded");
    expect(by[first.grantId].tokenCiphertext).toBeNull();
    expect(by[status.grantId].revokedAt).toBeNull();
    expect(by[other.grantId].revokedAt).toBeNull();
    expect(by[second.grantId].revokedAt).toBeNull();
    expect((await svc.capabilityService.exchange(first.token)).ok).toBe(false);
    expect((await svc.capabilityService.exchange(second.token)).ok).toBe(true);
  });

  it("a recovery grant (B5, F23) is never superseded by a later message, but staff revocation still ends it", async () => {
    const a = await order("recovery-kept", ["2030-01-15"]);
    const t0 = new Date();
    const recovered = await svc.capabilityService.mint(prisma, { orderId: a.id, purpose: "download_tickets", issuedFor: "recovery", supersede: "after_sent" }, t0);
    const t1 = new Date(t0.getTime() + 1000);
    const resend = await svc.capabilityService.mint(prisma, { orderId: a.id, purpose: "download_tickets", issuedFor: "staff_resend", supersede: "after_sent" }, t1);
    expect(await svc.capabilityService.supersedePrevious(prisma, resend.grantId, t1)).toBe(0);
    await svc.capabilityService.mint(prisma, { orderId: a.id, purpose: "download_tickets", issuedFor: "ticket_notification" }, new Date(t1.getTime() + 1000));
    expect((await prisma.guestCapabilityGrant.findUniqueOrThrow({ where: { id: recovered.grantId } })).revokedAt).toBeNull();
    expect(await svc.capabilityService.revoke(prisma, recovered.grantId, "staff")).toBe(true);
    // The widened check (migrations 20261102130000, 20261112120000) names exactly the five origins.
    const [check] = await prisma.$queryRaw<{ def: string }[]>`
      SELECT pg_get_constraintdef(oid) AS def FROM pg_constraint WHERE conname = 'guest_capability_grants_issued_for_check'`;
    for (const v of ["ticket_notification", "status_notification", "staff_resend", "recovery", "checkout"]) expect(check.def).toContain(`'${v}'`);
    expect(check.def.match(/'[a-z_]+'/g)).toHaveLength(5);
    // At most one checkout grant per order (batch 3): a partial unique index.
    const [index] = await prisma.$queryRaw<{ def: string }[]>`
      SELECT indexdef AS def FROM pg_indexes WHERE indexname = 'guest_capability_grants_one_checkout'`;
    expect(index.def).toMatch(/UNIQUE INDEX .* \(order_id\) WHERE \(issued_for = 'checkout'::text\)/);
  });

  it("after_sent mints without revoking; supersedePrevious then revokes only older live grants of the same order and purpose (R-B4-4)", async () => {
    const a = await order("after-sent-a", ["2030-01-15"]);
    const b = await order("after-sent-b", ["2030-01-15"]);
    const t0 = new Date();
    const old = await svc.capabilityService.mint(prisma, { orderId: a.id, purpose: "download_tickets", issuedFor: "ticket_notification", keepForRetry: true }, t0);
    const status = await svc.capabilityService.mint(prisma, { orderId: a.id, purpose: "view_status", issuedFor: "status_notification" }, t0);
    const other = await svc.capabilityService.mint(prisma, { orderId: b.id, purpose: "download_tickets", issuedFor: "ticket_notification" }, t0);
    const t1 = new Date(t0.getTime() + 1000);
    const fresh = await svc.capabilityService.mint(prisma, { orderId: a.id, purpose: "download_tickets", issuedFor: "staff_resend", supersede: "after_sent" }, t1);
    // Until the new message is sent, both links work.
    expect((await prisma.guestCapabilityGrant.findUniqueOrThrow({ where: { id: old.grantId } })).revokedAt).toBeNull();
    const later = await svc.capabilityService.mint(prisma, { orderId: a.id, purpose: "download_tickets", issuedFor: "staff_resend", supersede: "after_sent" }, new Date(t1.getTime() + 1000));

    expect(await svc.capabilityService.supersedePrevious(prisma, fresh.grantId, t1)).toBe(1);
    const rows = Object.fromEntries((await prisma.guestCapabilityGrant.findMany({ where: { id: { in: [old.grantId, status.grantId, other.grantId, fresh.grantId, later.grantId] } } })).map((r) => [r.id, r]));
    expect(rows[old.grantId]).toMatchObject({ revokeReason: "superseded", tokenCiphertext: null });
    expect(rows[status.grantId].revokedAt).toBeNull();
    expect(rows[other.grantId].revokedAt).toBeNull();
    expect(rows[fresh.grantId].revokedAt).toBeNull();
    expect(rows[later.grantId].revokedAt, "a grant created after it is never touched").toBeNull();
    // Idempotent; and a grant that is no longer live supersedes nothing.
    expect(await svc.capabilityService.supersedePrevious(prisma, fresh.grantId, t1)).toBe(0);
    await svc.capabilityService.revoke(prisma, later.grantId, "staff");
    expect(await svc.capabilityService.supersedePrevious(prisma, later.grantId)).toBe(0);
    expect((await prisma.guestCapabilityGrant.findUniqueOrThrow({ where: { id: fresh.grantId } })).revokedAt).toBeNull();
    expect(await svc.capabilityService.supersedePrevious(prisma, uuidv7())).toBe(0);
  });

  it("one access cookie holds grants for several orders; each resolves for its own order only and revocation is immediate (R-B4-11)", async () => {
    const a = await order("multi-a", ["2030-01-15"]);
    const b = await order("multi-b", ["2030-01-15"]);
    const now = new Date();
    const ga = await svc.capabilityService.mint(prisma, { orderId: a.id, purpose: "download_tickets", issuedFor: "ticket_notification" }, now);
    const gb = await svc.capabilityService.mint(prisma, { orderId: b.id, purpose: "view_status", issuedFor: "status_notification" }, now);
    const ea = await svc.capabilityService.exchange(ga.token, now);
    const eb = await svc.capabilityService.exchange(gb.token, now);
    if (!ea.ok || !eb.ok) throw new Error("exchange refused");
    expect(ea.orderId).toBe(a.id);
    const one = svc.addAccessEntry(undefined, ea.cookieValue, now)!;
    const both = svc.addAccessEntry(one.value, eb.cookieValue, now)!;
    expect(both.value).not.toContain(a.id);
    expect(both.value).not.toContain(b.id);

    expect((await svc.capabilityService.resolveAccessForOrder(both.value, a.id, now)).map((g) => [g.grantId, g.purpose])).toEqual([[ga.grantId, "download_tickets"]]);
    expect((await svc.capabilityService.resolveAccessForOrder(both.value, b.id, now)).map((g) => g.grantId)).toEqual([gb.grantId]);
    expect(await svc.capabilityService.resolveAccessForOrder(both.value, uuidv7(), now)).toEqual([]);
    expect((await svc.capabilityService.resolveAccess(both.value, now))?.grantId, "the newest live entry").toBe(gb.grantId);

    await svc.capabilityService.revoke(prisma, ga.grantId, "staff", now);
    expect(await svc.capabilityService.resolveAccessForOrder(both.value, a.id, now)).toEqual([]);
    expect(await svc.capabilityService.resolveAccessForOrder(both.value, b.id, now)).toHaveLength(1);
  });

  it("exchange: counts, records the first exchange and signs a cookie of at most 12 hours", async () => {
    const o = await order("exchange", ["2030-01-15"]);
    const now = new Date();
    const g = await svc.capabilityService.mint(prisma, { orderId: o.id, purpose: "download_tickets", issuedFor: "ticket_notification" }, now);
    const r = await svc.capabilityService.exchange(g.token, now);
    if (!r.ok) throw new Error("exchange refused");
    expect(r.expiresAt.getTime()).toBe(now.getTime() + 12 * 3600_000);
    expect(r.cookieValue).not.toContain(g.token);
    expect(r.cookieValue).not.toContain(o.id);
    const row = await prisma.guestCapabilityGrant.findUniqueOrThrow({ where: { id: g.grantId } });
    expect(row.exchangeCount).toBe(1);
    expect(row.exchangedAt?.getTime()).toBe(now.getTime());

    const later = new Date(now.getTime() + 60_000);
    expect((await svc.capabilityService.exchange(g.token, later)).ok).toBe(true);
    const row2 = await prisma.guestCapabilityGrant.findUniqueOrThrow({ where: { id: g.grantId } });
    expect(row2.exchangeCount).toBe(2);
    expect(row2.exchangedAt?.getTime()).toBe(now.getTime()); // first exchange only

    const access = await svc.capabilityService.resolveAccess(r.cookieValue, later);
    expect(access).toMatchObject({ grantId: g.grantId, orderId: o.id, purpose: "download_tickets" });
    // The cookie expires; a tampered one never resolves.
    expect(await svc.capabilityService.resolveAccess(r.cookieValue, new Date(now.getTime() + 12 * 3600_000 + 1000))).toBeNull();
    const parts = r.cookieValue.split(".");
    expect(await svc.capabilityService.resolveAccess([parts[0], parts[1], String(Number(parts[2]) + 3600), parts[3]].join("."), later)).toBeNull();
    expect(await svc.capabilityService.resolveAccess([parts[0], uuidv7(), parts[2], parts[3]].join("."), later)).toBeNull();
    expect(await svc.capabilityService.resolveAccess("garbage", later)).toBeNull();
  });

  it("the access session never outlives the grant", async () => {
    const o = await order("short", ["2030-01-15"]);
    const now = new Date();
    const g = await svc.capabilityService.mint(prisma, { orderId: o.id, purpose: "download_tickets", issuedFor: "ticket_notification" }, now);
    // Shortening is allowed by the guard; extending is not.
    await prisma.guestCapabilityGrant.update({ where: { id: g.grantId }, data: { expiresAt: new Date(now.getTime() + 3600_000) } });
    await expect(prisma.guestCapabilityGrant.update({ where: { id: g.grantId }, data: { expiresAt: new Date(now.getTime() + 400 * DAY) } })).rejects.toThrow();
    const r = await svc.capabilityService.exchange(g.token, now);
    expect(r.ok && r.expiresAt.getTime()).toBe(now.getTime() + 3600_000);
  });

  it("unknown, malformed, expired, revoked and used-up tokens all get the same refusal", async () => {
    const o = await order("refuse", ["2030-01-15"]);
    const now = new Date();
    const expired = await svc.capabilityService.mint(prisma, { orderId: o.id, purpose: "view_status", issuedFor: "status_notification" }, now);
    const revoked = await svc.capabilityService.mint(prisma, { orderId: o.id, purpose: "download_tickets", issuedFor: "ticket_notification" }, now);
    const used = await svc.capabilityService.mint(prisma, { orderId: o.id, purpose: "cancel_request", issuedFor: "status_notification" }, now);
    await svc.capabilityService.revoke(prisma, revoked.grantId, "staff", now);
    await prisma.guestCapabilityGrant.update({ where: { id: used.grantId }, data: { exchangeCount: svc.CAPABILITY_LIMITS.maxExchanges } });
    const afterExpiry = new Date(expired.expiresAt.getTime() + 1);

    const results = [
      await svc.capabilityService.exchange("A".repeat(43), now),
      await svc.capabilityService.exchange("not a token", now),
      await svc.capabilityService.exchange(12345, now),
      await svc.capabilityService.exchange(expired.token, afterExpiry),
      await svc.capabilityService.exchange(revoked.token, now),
      await svc.capabilityService.exchange(used.token, now),
    ];
    for (const r of results) expect(r).toEqual({ ok: false });
    const usedRow = await prisma.guestCapabilityGrant.findUniqueOrThrow({ where: { id: used.grantId } });
    expect(usedRow.exchangeCount).toBe(svc.CAPABILITY_LIMITS.maxExchanges);
    expect(usedRow.exchangedAt).toBeNull();
  });

  it("concurrent exchanges cannot pass the cap", async () => {
    const o = await order("race", ["2030-01-15"]);
    const g = await svc.capabilityService.mint(prisma, { orderId: o.id, purpose: "download_tickets", issuedFor: "ticket_notification" });
    await prisma.guestCapabilityGrant.update({ where: { id: g.grantId }, data: { exchangeCount: svc.CAPABILITY_LIMITS.maxExchanges - 1 } });
    const results = await Promise.all(Array.from({ length: 6 }, () => svc.capabilityService.exchange(g.token)));
    expect(results.filter((r) => r.ok)).toHaveLength(1);
    expect((await prisma.guestCapabilityGrant.findUniqueOrThrow({ where: { id: g.grantId } })).exchangeCount).toBe(svc.CAPABILITY_LIMITS.maxExchanges);
  });

  it("revocation takes effect on the next resolve, and a revoked grant stays revoked", async () => {
    const o = await order("revoke", ["2030-01-15"]);
    const g = await svc.capabilityService.mint(prisma, { orderId: o.id, purpose: "download_tickets", issuedFor: "ticket_notification" });
    const r = await svc.capabilityService.exchange(g.token);
    if (!r.ok) throw new Error("exchange refused");
    expect(await svc.capabilityService.resolveAccess(r.cookieValue)).not.toBeNull();
    expect(await svc.capabilityService.revoke(prisma, g.grantId, "staff")).toBe(true);
    expect(await svc.capabilityService.revoke(prisma, g.grantId, "staff")).toBe(false);
    expect(await svc.capabilityService.resolveAccess(r.cookieValue)).toBeNull();
    await expect(prisma.guestCapabilityGrant.update({ where: { id: g.grantId }, data: { revokedAt: null, revokeReason: null } })).rejects.toThrow();
  });

  it("revokeAllForOrders revokes live grants and drops every kept token (erasure)", async () => {
    const a = await order("erase-a", ["2030-01-15"]);
    const b = await order("erase-b", ["2030-01-15"]);
    const a1 = await svc.capabilityService.mint(prisma, { orderId: a.id, purpose: "download_tickets", issuedFor: "ticket_notification", keepForRetry: true });
    const a2 = await svc.capabilityService.mint(prisma, { orderId: a.id, purpose: "view_status", issuedFor: "status_notification", keepForRetry: true });
    const b1 = await svc.capabilityService.mint(prisma, { orderId: b.id, purpose: "download_tickets", issuedFor: "ticket_notification", keepForRetry: true });
    expect(await svc.capabilityService.revokeAllForOrders(prisma, [a.id], "erasure")).toBe(2);
    const rows = await prisma.guestCapabilityGrant.findMany({ where: { id: { in: [a1.grantId, a2.grantId, b1.grantId] } } });
    for (const row of rows) {
      if (row.orderId === a.id) {
        expect(row.revokeReason).toBe("erasure");
        expect(row.tokenCiphertext).toBeNull();
      } else {
        expect(row.revokedAt).toBeNull();
        expect(row.tokenCiphertext).not.toBeNull();
      }
    }
    expect(await svc.capabilityService.revokeAllForOrders(prisma, [], "erasure")).toBe(0);
  });

  it("mint inside a caller's transaction rolls back with it", async () => {
    const o = await order("tx", ["2030-01-15"]);
    const live = await svc.capabilityService.mint(prisma, { orderId: o.id, purpose: "download_tickets", issuedFor: "ticket_notification" });
    let minted = "";
    await expect(
      prisma.$transaction(async (tx) => {
        minted = (await svc.capabilityService.mint(tx, { orderId: o.id, purpose: "download_tickets", issuedFor: "staff_resend" })).grantId;
        throw new Error("caller rolls back");
      }),
    ).rejects.toThrow("caller rolls back");
    expect(await prisma.guestCapabilityGrant.findUnique({ where: { id: minted } })).toBeNull();
    expect((await prisma.guestCapabilityGrant.findUniqueOrThrow({ where: { id: live.grantId } })).revokedAt).toBeNull();
  });
});
