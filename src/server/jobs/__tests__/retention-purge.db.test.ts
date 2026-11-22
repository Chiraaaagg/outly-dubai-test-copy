import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createHash, randomBytes } from "node:crypto";
import { assertDisposableDb, cleanupPeople, createCustomer, createStaff, dbEnabled, runId, syntheticPhone } from "@/server/__tests__/helpers/fixtures";
import { cleanupBusinessRows, db, forbidNetwork, makeOrder } from "@/server/__tests__/security/_mercury-fixtures";
import { uuidv7 } from "@/server/lib/ids";

/**
 * The retention purge on the disposable database (doc 26 §2, Batch 1c): rows
 * past their window go, live rows and rows still inside their window stay,
 * nothing an order still names is touched, and a second run deletes nothing.
 *
 * Isolation: the run's clock is set to 2001, and every row this suite wants
 * purged expired in spring 2001. Every cutoff is therefore in 2001, so rows
 * written by other suites (all in the present) can never match; the "live"
 * rows here expire in 2099. Every value is synthetic and assembled at run
 * time; global fetch is blocked.
 */

const RUN = runId();
const at = (iso: string) => new Date(`${iso}T00:00:00.000Z`);
const hex = () => createHash("sha256").update(randomBytes(16)).digest("hex");
/** The run's clock. Cutoffs: codes and quotes 2001-07-08, sessions 2001-07-14, grants 2001-06-15. */
const NOW = at("2001-07-15");
const OLD = at("2001-05-01");
const CREATED = at("2001-01-01");
const FUTURE = at("2099-01-01");

type Prisma = Awaited<ReturnType<typeof db>>;

describe.skipIf(!dbEnabled)("retention purge on the database", () => {
  let prisma: Prisma;
  let mod: typeof import("../retention-purge");
  const ids = {
    otp: {} as Record<string, string>,
    customerSession: {} as Record<string, string>,
    adminSession: {} as Record<string, string>,
    guest: {} as Record<string, string>,
    quote: {} as Record<string, string>,
    ocv: {} as Record<string, string>,
    grant: {} as Record<string, string>,
  };

  async function otp(label: string, expiresAt: Date) {
    const id = uuidv7();
    await prisma.otpChallenge.create({ data: { id, phoneE164: `ocv:v1:${uuidv7()}:phone:${hex()}`, codeHash: hex(), expiresAt, createdAt: CREATED } });
    ids.otp[label] = id;
  }
  async function guestSession(label: string, expiresAt: Date) {
    const id = uuidv7();
    await prisma.guestSession.create({ data: { id, tokenHash: hex(), createdAt: CREATED, expiresAt } });
    ids.guest[label] = id;
    return id;
  }
  async function quote(label: string, guestSessionId: string, expiresAt: Date, usedByOrderId?: string) {
    const id = uuidv7();
    await prisma.quote.create({
      data: {
        id,
        fingerprint: hex(),
        ownerKind: "guest",
        guestSessionId,
        currency: "AED",
        totalMinor: 0n,
        lines: [],
        request: {},
        status: usedByOrderId ? "used" : "expired",
        usedByOrderId: usedByOrderId ?? null,
        createdAt: CREATED,
        expiresAt,
      },
    });
    ids.quote[label] = id;
    return id;
  }
  async function ocv(label: string, quoteId: string, orderId: string | null) {
    const id = uuidv7();
    await prisma.orderContactVerification.create({ data: { id, quoteId, orderId, channel: "phone", contactHash: hex(), method: "otp_sms", verifiedAt: CREATED, createdAt: CREATED } });
    ids.ocv[label] = id;
  }
  async function grant(label: string, orderId: string, issuedFor: string, expiresAt: Date, revokedAt: Date | null = null) {
    const id = uuidv7();
    await prisma.guestCapabilityGrant.create({
      data: { id, tokenHash: hex(), orderId, purpose: "download_tickets", issuedFor, expiresAt, revokedAt, revokeReason: revokedAt ? "staff" : null, createdAt: CREATED },
    });
    ids.grant[label] = id;
  }

  beforeAll(async () => {
    assertDisposableDb();
    forbidNetwork();
    prisma = await db();
    mod = await import("../retention-purge");

    // One-time codes: expired before the window, inside the window (2001-07-10 > 07-08), live.
    await otp("old", OLD);
    await otp("inWindow", at("2001-07-10"));
    await otp("live", FUTURE);

    // Sessions: one expired and one live of each kind.
    const customer = await createCustomer(RUN, syntheticPhone(RUN, 1));
    ids.customerSession.live = customer.sessionId;
    ids.customerSession.old = uuidv7();
    await prisma.customerSession.create({ data: { id: ids.customerSession.old, customerId: customer.id, tokenHash: hex(), expiresAt: OLD, createdAt: CREATED } });
    const staff = await createStaff(RUN, "retention", ["agent"]);
    ids.adminSession.live = staff.sessionId;
    ids.adminSession.old = uuidv7();
    await prisma.adminSession.create({ data: { id: ids.adminSession.old, adminUserId: staff.id, refreshHash: hex(), expiresAt: OLD, createdAt: CREATED } });

    // Quotes and guest sessions.
    const order = await makeOrder(RUN, { leadPhone: syntheticPhone(RUN, 2), label: "retention-a" });
    const gsOrphan = await guestSession("orphan", OLD); // no quote: purged
    void gsOrphan;
    const gsAbandoned = await guestSession("abandoned", OLD); // its only quote is purged in the same run: purged
    const gsOrdered = await guestSession("ordered", OLD); // named by a used quote: kept
    await guestSession("live", FUTURE);
    const abandoned = await quote("abandoned", gsAbandoned, OLD);
    await ocv("unbound", abandoned, null);
    const used = await quote("used", gsOrdered, OLD, order.id);
    await ocv("bound", used, order.id);
    await quote("inWindow", gsOrdered, at("2001-07-10"));
    await quote("live", gsOrdered, FUTURE);

    // Grants on two orders (one checkout grant per order).
    const order2 = await makeOrder(RUN, { leadPhone: syntheticPhone(RUN, 3), label: "retention-b" });
    await grant("expired", order.id, "ticket_notification", OLD);
    await grant("revoked", order.id, "status_notification", FUTURE, OLD);
    await grant("checkoutRevoked", order.id, "checkout", FUTURE, OLD);
    await grant("checkoutExpired", order2.id, "checkout", OLD);
    await grant("inWindow", order.id, "staff_resend", at("2001-07-01"));
    await grant("live", order.id, "recovery", FUTURE);
  });

  afterAll(async () => {
    if (!prisma) return;
    await prisma.guestCapabilityGrant.deleteMany({ where: { id: { in: Object.values(ids.grant) } } });
    await prisma.orderContactVerification.deleteMany({ where: { id: { in: Object.values(ids.ocv) } } });
    await prisma.quote.deleteMany({ where: { id: { in: Object.values(ids.quote) } } });
    await prisma.guestSession.deleteMany({ where: { id: { in: Object.values(ids.guest) } } });
    await prisma.otpChallenge.deleteMany({ where: { id: { in: Object.values(ids.otp) } } });
    await cleanupBusinessRows(RUN);
    await cleanupPeople(RUN);
  });

  const exists = {
    otp: async (id: string) => (await prisma.otpChallenge.count({ where: { id } })) === 1,
    customerSession: async (id: string) => (await prisma.customerSession.count({ where: { id } })) === 1,
    adminSession: async (id: string) => (await prisma.adminSession.count({ where: { id } })) === 1,
    guest: async (id: string) => (await prisma.guestSession.count({ where: { id } })) === 1,
    quote: async (id: string) => (await prisma.quote.count({ where: { id } })) === 1,
    ocv: async (id: string) => (await prisma.orderContactVerification.count({ where: { id } })) === 1,
    grant: async (id: string) => (await prisma.guestCapabilityGrant.count({ where: { id } })) === 1,
  };

  it("deletes only rows past their window, in small batches, and leaves every live row", async () => {
    const out = await mod.runRetentionPurge({ now: () => NOW, batchSize: 1, maxBatches: 50 });
    expect(out.ok).toBe(true);
    for (const cls of mod.PURGE_CLASSES) expect(out.classes[cls].complete, cls).toBe(true);

    expect(await exists.otp(ids.otp.old)).toBe(false);
    expect(await exists.otp(ids.otp.inWindow)).toBe(true);
    expect(await exists.otp(ids.otp.live)).toBe(true);

    expect(await exists.customerSession(ids.customerSession.old)).toBe(false);
    expect(await exists.customerSession(ids.customerSession.live)).toBe(true);
    expect(await exists.adminSession(ids.adminSession.old)).toBe(false);
    expect(await exists.adminSession(ids.adminSession.live)).toBe(true);

    expect(await exists.grant(ids.grant.expired)).toBe(false);
    expect(await exists.grant(ids.grant.revoked)).toBe(false);
    expect(await exists.grant(ids.grant.checkoutExpired)).toBe(false);
    expect(await exists.grant(ids.grant.checkoutRevoked), "a revoked checkout grant stays until it expires").toBe(true);
    expect(await exists.grant(ids.grant.inWindow)).toBe(true);
    expect(await exists.grant(ids.grant.live)).toBe(true);

    expect(await exists.ocv(ids.ocv.unbound)).toBe(false);
    expect(await exists.quote(ids.quote.abandoned)).toBe(false);
    expect(await exists.ocv(ids.ocv.bound), "an order's verification stays").toBe(true);
    expect(await exists.quote(ids.quote.used), "an order's quote stays").toBe(true);
    expect(await exists.quote(ids.quote.inWindow)).toBe(true);
    expect(await exists.quote(ids.quote.live)).toBe(true);

    expect(await exists.guest(ids.guest.orphan)).toBe(false);
    expect(await exists.guest(ids.guest.abandoned)).toBe(false);
    expect(await exists.guest(ids.guest.ordered), "a session behind an order's quote stays").toBe(true);
    expect(await exists.guest(ids.guest.live)).toBe(true);
  });

  it("is idempotent: a second run deletes nothing of this suite's rows", async () => {
    const before = await Promise.all(Object.values(ids.grant).map((id) => exists.grant(id)));
    const out = await mod.runRetentionPurge({ now: () => NOW });
    expect(out.ok).toBe(true);
    for (const cls of mod.PURGE_CLASSES) expect(out.classes[cls].deleted, cls).toBe(0);
    expect(await Promise.all(Object.values(ids.grant).map((id) => exists.grant(id)))).toEqual(before);
  });
});
