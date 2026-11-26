import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createHash } from "node:crypto";
import { uuidv7 } from "../../lib/ids";
import { assertDisposableDb, assertDisposableDbLive } from "../../__tests__/helpers/target-guard";
import { QUOTE_TTL_MS, type QuoteLineRequest, type QuoteRequest, type QuoteSnapshot, type SupplierQuoteResult } from "../../quotes/contracts";
import { assessReadiness, READINESS_RULES_VERSION } from "../readiness.service";
import { fakeMargin, mapping, product, PRODUCT_ID } from "./_b2-fakes";

/**
 * The quote store against the disposable test database (target guard), with
 * the real `prismaQuoteStore` and fakes for readiness inputs, the supplier and
 * margin (CR-B2-2). JSONB hands the stored request back with its keys
 * reordered; a re-quote of the same cart by the same owner must still match
 * it. Synthetic figures only. Every row is removed in afterAll.
 */

const enabled = Boolean(process.env.DATABASE_URL);
const NOW = new Date("2026-11-01T08:00:00Z");

const okSupplier: SupplierQuoteResult = {
  ok: true,
  slotRef: "17@09:00",
  netAedMinor: 30_000n,
  netUsdMinor: null,
  checkedAt: NOW.toISOString(),
  capacity: "limited",
  seatsLeft: 8,
  cutoffUtc: "2026-11-02T03:00:00Z",
  issuesTicketsAtConfirm: "yes",
  supplierFreeCancellationUntilUtc: null,
  ticketValidUntil: null,
};

function line(over: Partial<QuoteLineRequest> = {}): QuoteLineRequest {
  return { productId: PRODUCT_ID, variantId: "shared", serviceDate: "2026-11-02", slotRef: "17@09:00", units: { adult: 2, child: 1 }, addonIds: [], pickup: null, ...over };
}
const request = (over: Partial<QuoteLineRequest> = {}): QuoteRequest => ({ lines: [line(over)], currency: "AED", couponCode: null });

describe.skipIf(!enabled)("prismaQuoteStore (CR-B2-2)", () => {
  let prisma: typeof import("../../lib/db").prisma;
  let mod: typeof import("../quote.service");
  const guests: string[] = [];
  let now = NOW;

  beforeAll(async () => {
    assertDisposableDb();
    ({ prisma } = await import("../../lib/db"));
    await assertDisposableDbLive(prisma);
    mod = await import("../quote.service");
  });

  afterAll(async () => {
    if (prisma) {
      await prisma.quote.deleteMany({ where: { guestSessionId: { in: guests } } });
      await prisma.guestSession.deleteMany({ where: { id: { in: guests } } });
      await prisma.$disconnect();
    }
  });

  async function guest(): Promise<QuoteSnapshot["owner"]> {
    const id = uuidv7();
    guests.push(id);
    await prisma.guestSession.create({ data: { id, tokenHash: createHash("sha256").update(`zz-test-${id}`).digest("hex"), createdAt: NOW, expiresAt: new Date(NOW.getTime() + 86_400_000) } });
    return { kind: "guest", guestSessionId: id };
  }

  function service() {
    const margin = fakeMargin();
    return mod.createQuoteService({
      readiness: {
        async assess(productId) {
          const a = await assessReadiness({ product: product(), mappings: [mapping({ accountId: "synthetic-account" })], releaseEnabled: true, margin });
          return { ...a, result: { productId, requested: a.requested, effective: a.effective, reasons: a.reasons, readinessVersion: READINESS_RULES_VERSION, evaluatedAt: now.toISOString() } };
        },
        reevaluate: async () => null,
      },
      supplierQuote: { quote: async () => okSupplier },
      margin,
      store: mod.prismaQuoteStore,
      isFirstBooking: async () => false,
      instantOrderCap: async () => ({ capAedMinor: 1_000_000_000, inrPerAed: "25.00" }),
      now: () => now,
    });
  }

  const statuses = async (owner: QuoteSnapshot["owner"]) =>
    (await prisma.quote.findMany({ where: { guestSessionId: owner.kind === "guest" ? owner.guestSessionId : undefined }, orderBy: { createdAt: "asc" }, select: { id: true, status: true, fingerprint: true } })).map(
      (r) => r.status,
    );

  it("the same cart quoted again by the same owner supersedes the active quote instead of a 409", async () => {
    now = NOW;
    const owner = await guest();
    const svc = service();
    const first = await svc.create(owner, request());
    expect(first.ok).toBe(true);
    // JSONB really did reorder the keys the comparison reads back.
    const stored = await prisma.quote.findFirstOrThrow({ where: { guestSessionId: owner.kind === "guest" ? owner.guestSessionId : "" }, select: { request: true } });
    expect(Object.keys((stored.request as { lines: Record<string, unknown>[] }).lines[0])).not.toEqual(Object.keys(mod.canonicalRequest(request()).lines[0]));
    // CR-B2-12: the stored line keeps the supplier account it was checked against and the coupon version (none here).
    const row = await prisma.quote.findFirstOrThrow({ where: { guestSessionId: owner.kind === "guest" ? owner.guestSessionId : "" }, select: { lines: true } });
    expect((row.lines as Record<string, unknown>[])[0]).toMatchObject({ supplierAccountId: "synthetic-account", couponVersion: null });

    now = new Date(NOW.getTime() + 1_000);
    const second = await svc.create(owner, request());
    expect(second.ok && first.ok && second.quoteId !== first.quoteId).toBe(true);
    expect(await statuses(owner)).toEqual(["superseded", "active"]);
  });

  it("after the expiry the active row is marked expired and a new quote is written", async () => {
    now = NOW;
    const owner = await guest();
    const svc = service();
    await svc.create(owner, request());
    now = new Date(NOW.getTime() + QUOTE_TTL_MS + 1);
    expect((await svc.create(owner, request())).ok).toBe(true);
    expect(await statuses(owner)).toEqual(["expired", "active"]);
  });

  it("a changed cart is a new quote under a new fingerprint; different content under the same fingerprint is still a 409", async () => {
    now = NOW;
    const owner = await guest();
    const svc = service();
    const a = await svc.create(owner, request());
    now = new Date(NOW.getTime() + 1_000);
    const b = await svc.create(owner, request({ units: { adult: 3 } }));
    expect(a.ok && b.ok && a.fingerprint !== b.fingerprint).toBe(true);
    expect(await statuses(owner)).toEqual(["active", "active"]);

    // The design's conflict: an active row under this fingerprint whose stored content differs.
    if (!a.ok) throw new Error("expected a quote");
    await prisma.quote.update({ where: { id: a.quoteId }, data: { request: JSON.parse(JSON.stringify({ ...mod.canonicalRequest(request()), couponCode: "TAMPERED" })) } });
    await expect(svc.create(owner, request())).rejects.toMatchObject({ status: 409 });
  });
});
