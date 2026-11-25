import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { apiRequest, assertDisposableDb, dbEnabled, params, runId, syntheticPhone } from "../helpers/fixtures";
import { cleanupBusinessRows, db, forbidNetwork, leadTag, makeInquiry, publishedProduct, type InquiryFixture, type SeedProduct } from "../security/_mercury-fixtures";

/**
 * Inquiry receipt (B5 stop condition, review R-B5-5): the inquiry
 * confirmation page says "Got it" only after GET /api/inquiries/receipt
 * confirms that this browser submitted that inquiry. Everything else is one
 * uniform 404 that never confirms a reference exists.
 */

const run = runId();
let product: SeedProduct;
let a: InquiryFixture;
let b: InquiryFixture;
let phoneSeq = 0;

const receiptRoute = () => import("@/app/api/inquiries/receipt/route");
const createRoute = () => import("@/app/api/inquiries/route");
const service = () => import("@/server/services/inquiry-receipt.service");

async function receipt(ref: string, cookie?: string) {
  const { GET } = await receiptRoute();
  return GET(apiRequest(`/api/inquiries/receipt?ref=${encodeURIComponent(ref)}`, { method: "GET", cookie, origin: null }), params({}));
}

async function cookieFor(inquiryId: string, now?: Date) {
  const signed = (await service()).inquiryReceipt.sign(inquiryId, now);
  expect(signed).not.toBeNull();
  return `outlyy_inquiry_receipt=${signed!.value}`;
}

describe.skipIf(!dbEnabled)("inquiry receipt (R-B5-5)", () => {
  beforeAll(async () => {
    await assertDisposableDb();
    forbidNetwork();
    product = await publishedProduct();
    a = await makeInquiry(run, { leadPhone: syntheticPhone(run, ++phoneSeq), product, label: "a" });
    b = await makeInquiry(run, { leadPhone: syntheticPhone(run, ++phoneSeq), product, label: "b" });
  });
  afterAll(async () => {
    if (dbEnabled) await cleanupBusinessRows(run);
  });

  it("confirms only the inquiry the receipt names, with private headers and no details", async () => {
    const res = await receipt(a.reference, await cookieFor(a.id));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ received: true, reference: a.reference });
    expect(res.headers.get("cache-control")).toBe("private, no-store");
    expect(res.headers.get("referrer-policy")).toBe("no-referrer");
  });

  it("another reference, no cookie, a forged, expired or tampered receipt, and a bad reference are the same 404", async () => {
    const good = await cookieFor(a.id);
    const expired = await cookieFor(a.id, new Date(Date.now() - 25 * 3600_000));
    const tampered = good.replace(a.id, b.id);
    const cases: [string, string | undefined][] = [
      [b.reference, good],
      [a.reference, undefined],
      [a.reference, expired],
      [a.reference, tampered],
      [a.reference, "outlyy_inquiry_receipt=v1.not-a-receipt"],
      ["INQ-000000", good],
      ["OUT-10000017", good],
    ];
    const bodies = new Set<string>();
    for (const [ref, cookie] of cases) {
      const res = await receipt(ref, cookie);
      expect(res.status, `${ref} ${cookie?.slice(0, 40)}`).toBe(404);
      bodies.add(await res.text());
    }
    expect(bodies.size).toBe(1);
  });

  it("POST /api/inquiries sets the receipt for the inquiry it created, and only that one", async () => {
    const { POST } = await createRoute();
    const phone = syntheticPhone(run, ++phoneSeq);
    const res = await POST(
      apiRequest("/api/inquiries", {
        body: {
          items: [
            {
              id: `${product.slug}-2027-02-01-10:00-std`,
              kind: "activity",
              slug: product.slug,
              title: product.title,
              image: "",
              date: "2027-02-01",
              time: "10:00",
              pax: { adult: 2, child: 0, infant: 0, senior: 0 },
              addOnIds: [],
              unit: { inr: 1, aed: 1 },
              total: { inr: 2, aed: 2 },
              confirmation: "manual",
              fulfilmentMode: "inquiry",
              freeCancellationHours: 24,
              durationMinutes: 60,
            },
          ],
          leadName: `${leadTag(run)} receipt`,
          leadPhone: phone.replace(/^\+91/, ""),
          countryCode: "+91",
          datesFlexible: false,
          currency: "INR",
          source: "inquiry_form",
          whatsappConsent: true,
          startedAt: Date.now() - 120_000,
        },
      }),
      params({}),
    );
    expect(res.status).toBe(201);
    const created = (await res.json()) as { reference: string };
    const setCookie = res.headers.get("set-cookie") ?? "";
    const match = /outlyy_inquiry_receipt=([^;]+)/.exec(setCookie);
    expect(match).not.toBeNull();
    expect(setCookie.toLowerCase()).toContain("httponly");
    expect(setCookie.toLowerCase()).toContain("samesite=strict");
    const cookie = `outlyy_inquiry_receipt=${match![1]}`;
    expect((await receipt(created.reference, cookie)).status).toBe(200);
    expect((await receipt(a.reference, cookie)).status).toBe(404);
    // The cookie names the inquiry id only: no reference, phone or name.
    const prisma = await db();
    const row = await prisma.inquiry.findUniqueOrThrow({ where: { reference: created.reference }, select: { id: true } });
    expect(match![1].split(".")[1]).toBe(row.id);
    expect(match![1]).not.toContain(created.reference);
    expect(match![1]).not.toContain(phone.slice(-6));
  });
});
