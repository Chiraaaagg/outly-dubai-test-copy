import { describe, expect, it } from "vitest";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import {
  assertSafeCrmPayload,
  GENERIC_LINE,
  lineTotalMinor,
  mapDeal,
  marginAedMinor,
  orderStage,
  revenueFromPayments,
  snapshotHash,
  type CrmOrderFacts,
  type CrmPaymentFacts,
} from "@/server/crm/crm.mapping";
import { CRM_FIELD_KEYS } from "@/server/crm/crm.config";
import type { DealFields } from "@/server/crm/bitrix.client";
import { directOrderState, FAKE_SITE, fakeConfig, fieldCode, inquiryState, subjectId, TEST_CONTACT } from "./_memory-store";

/**
 * Deal mapping (doc 29 §5.4, §5.5, §8.8; doc 29d; batches C1, C2a): the 12
 * stages from verified state only, revenue = verified captures and
 * staff-recorded payments minus verified refunds, the OUTLYY custom fields,
 * the customer's details on the deal only when allowed, margin as one AED
 * amount, and the payload guard against anything outside the allowlist.
 */

const uf = (fields: DealFields, key: (typeof CRM_FIELD_KEYS)[number]) => fields[fieldCode(key)];

const cfg = fakeConfig();

const order = (over: Partial<CrmOrderFacts>): CrmOrderFacts => ({
  reference: "OUT-4829135",
  status: "paid",
  currency: "AED",
  authorised: true,
  capturedMinor: 0n,
  refundedMinor: 0n,
  items: [{ title: "Dhow cruise", serviceDate: "2026-12-03", totalMinor: 18_000n, status: "pending", needsDocument: true, documentReady: false }],
  ...over,
});

describe("CRM deal mapping", () => {
  it.each([
    ["new", "new_inquiry"],
    ["assigned", "assigned"],
    ["contacted", "contacted"],
    ["quoted", "quoted"],
    // Decision C2-7: no "Negotiating" stage; the status maps to "Quoted".
    ["negotiating", "quoted"],
    ["payment_pending", "payment_pending"],
    ["lost", "lost"],
    ["spam", "spam"],
  ])("inquiry %s maps to stage %s of the OUTLYY funnel", (status, stage) => {
    const m = mapDeal(inquiryState(subjectId(), { status }), cfg);
    expect(m).toMatchObject({ visible: true, stage, createAllowed: status !== "spam" });
    if (m.visible) expect(m.fields.stageId).toBe(cfg.stageIds[stage as keyof typeof cfg.stageIds]);
  });

  it.each([
    [{ status: "pending_payment", authorised: false }, null],
    [{ status: "pending_payment", authorised: true }, "payment_pending"],
    [{ status: "payment_failed", authorised: false }, null],
    [{ status: "payment_failed", authorised: true }, "cancelled"],
    [{ status: "paid" }, "paid_awaiting_supplier"],
    [{ status: "supplier_pending" }, "paid_awaiting_supplier"],
    [{ status: "confirmed", items: [{ title: "x", serviceDate: null, totalMinor: 1n, status: "confirmed", needsDocument: true, documentReady: false }] }, "confirmed_tickets_pending"],
    [{ status: "confirmed", items: [{ title: "x", serviceDate: null, totalMinor: 1n, status: "confirmed", needsDocument: true, documentReady: true }] }, "fulfilled"],
    [{ status: "confirmed", items: [{ title: "x", serviceDate: null, totalMinor: 1n, status: "confirmed", needsDocument: false }] }, "fulfilled"],
    [{ status: "completed" }, "fulfilled"],
    [{ status: "cancelled" }, "cancelled"],
    [{ status: "refunded" }, "refunded"],
  ])("order case %#", (over, stage) => {
    expect(orderStage(order(over as Partial<CrmOrderFacts>))).toBe(stage);
  });

  it("an inquiry that converted keeps its deal and takes the order's stage, reference and revenue", () => {
    const s = inquiryState(subjectId(), { status: "won" });
    s.order = order({ status: "confirmed", capturedMinor: 18_000n, refundedMinor: 3_000n, items: [{ title: "Dhow cruise", serviceDate: "2026-12-03", totalMinor: 18_000n, status: "confirmed", needsDocument: false }] });
    const m = mapDeal(s, cfg);
    expect(m).toMatchObject({ visible: true, stage: "fulfilled" });
    if (!m.visible) return;
    expect(m.fields).toMatchObject({ title: "OUTLYY INQ-1048213 / OUT-4829135", opportunity: 150, currencyId: "AED", originId: `inq:${s.subject.id}` });
    expect(m.rows).toEqual([{ productName: "Dhow cruise (2026-12-03)", price: 180, quantity: 1 }]);
  });

  it("revenue is never negative and is zero before capture", () => {
    const m = mapDeal(directOrderState(subjectId(), { authorised: true, capturedMinor: 1_000n, refundedMinor: 5_000n }), cfg);
    expect(m.visible && m.fields.opportunity).toBe(0);
  });

  it("never makes a deal for an abandoned cart, an erased subject, a missing row or an unpaid direct order", () => {
    expect(mapDeal(inquiryState(subjectId(), { source: "abandoned_cart" }), cfg)).toEqual({ visible: false, reason: "abandoned_cart" });
    expect(mapDeal({ ...inquiryState(subjectId()), erased: true }, cfg)).toEqual({ visible: false, reason: "erased" });
    expect(mapDeal({ subject: { type: "order", id: subjectId() }, exists: false, erased: false, inquiry: null, order: null }, cfg)).toEqual({ visible: false, reason: "missing" });
    expect(mapDeal(directOrderState(subjectId()), cfg)).toEqual({ visible: false, reason: "not_authorised" });
  });

  it("sends exactly the allowlisted deal fields: the eight standard ones and the 20 OUTLYY fields; the owner on create only", () => {
    const m = mapDeal(directOrderState(subjectId(), { authorised: true }), cfg);
    if (!m.visible) throw new Error("expected visible");
    const standard = ["categoryId", "currencyId", "isManualOpportunity", "opportunity", "originId", "originatorId", "stageId", "title"];
    expect(Object.keys(m.fields).sort()).toEqual([...standard, ...CRM_FIELD_KEYS.map(fieldCode)].sort());
    expect(Object.keys(m.createFields).sort()).toEqual([...standard, ...CRM_FIELD_KEYS.map(fieldCode), "assignedById"].sort());
    expect(m.createFields.assignedById).toBe(cfg.defaultOwnerId);
    expect(m.fields.assignedById).toBeUndefined();
  });

  it("a line without a catalogue name gets the generic label, never free text (review R14)", () => {
    const m = mapDeal(inquiryState(subjectId(), { items: [{ title: null, serviceDate: "2026-12-01" }, { title: null, serviceDate: null }] }), cfg);
    expect(m.visible && m.rows.map((r) => r.productName)).toEqual([`${GENERIC_LINE} (2026-12-01)`, GENERIC_LINE]);
  });

  it("drops rejected and cancelled lines and strips control characters", () => {
    const s = directOrderState(subjectId(), { authorised: true, status: "partially_confirmed" });
    s.order!.items = [
      { title: "Line\none", serviceDate: "2026-12-04", totalMinor: 100n, status: "confirmed", needsDocument: false },
      { title: "Refunded line", serviceDate: "2026-12-04", totalMinor: 100n, status: "rejected", needsDocument: false },
    ];
    const m = mapDeal(s, cfg);
    expect(m.visible && m.rows).toEqual([{ productName: "Line one (2026-12-04)", price: 1, quantity: 1 }]);
  });

  it("the hash changes with the pushed shape and only with it", () => {
    const a = mapDeal(inquiryState("00000000-0000-7000-8000-00000000aaaa"), cfg);
    const b = mapDeal(inquiryState("00000000-0000-7000-8000-00000000aaaa"), cfg);
    const c = mapDeal(inquiryState("00000000-0000-7000-8000-00000000aaaa", { status: "quoted" }), cfg);
    if (!a.visible || !b.visible || !c.visible) throw new Error("expected visible");
    expect(a.hash).toBe(b.hash);
    expect(a.hash).not.toBe(c.hash);
    expect(a.hash).toBe(snapshotHash(a.fields, a.rows, fieldCode("as_of")));
  });

  it("the \"as of\" time is the push time and is left out of the hash, so an unchanged subject is not re-pushed", () => {
    const id = subjectId();
    const a = mapDeal(inquiryState(id), cfg, { now: new Date("2026-11-24T10:00:00.000Z") });
    const b = mapDeal(inquiryState(id), cfg, { now: new Date("2026-11-25T11:30:00.000Z") });
    if (!a.visible || !b.visible) throw new Error("expected visible");
    expect(uf(a.fields, "as_of")).toBe("2026-11-24T10:00:00.000Z");
    expect(uf(b.fields, "as_of")).toBe("2026-11-25T11:30:00.000Z");
    expect(a.hash).toBe(b.hash);
  });
});

describe("CRM custom fields (C2a: G3, G5, G6, G16)", () => {
  const now = new Date("2026-11-24T10:00:00.000Z");

  it("an inquiry deal: reference, environment, plain admin link, customer details, indicative amount, consent flags", () => {
    const id = subjectId();
    const m = mapDeal(inquiryState(id), cfg, { now });
    if (!m.visible) throw new Error("expected visible");
    expect(Object.fromEntries(CRM_FIELD_KEYS.map((k) => [k, uf(m.fields, k)]))).toEqual({
      reference: "INQ-1048213",
      environment: "staging",
      admin_link: `${FAKE_SITE}/admin/inquiries/${id}`,
      customer_name: TEST_CONTACT.name,
      customer_phone: TEST_CONTACT.phone,
      customer_email: TEST_CONTACT.email,
      payment_status: "",
      supplier_booking_status: "",
      ticket_status: "",
      refund_status: "",
      refund_amount: "",
      travel_date: "2026-12-01",
      item_summary: "1 requested",
      as_of: "2026-11-24T10:00:00.000Z",
      indicative_amount: 180,
      margin: "",
      consent_marketing_email: "Y",
      consent_marketing_email_at: "2026-11-20T09:30:00.000Z",
      consent_marketing_whatsapp: "N",
      consent_marketing_whatsapp_at: "",
    });
    // Contact data only in its own fields: not in the title or the rows.
    expect(m.fields.title).not.toContain(TEST_CONTACT.name);
    expect(JSON.stringify(m.rows)).not.toContain(TEST_CONTACT.phone);
    expect(() => assertSafeCrmPayload(m.fields, m.rows, cfg)).not.toThrow();
    expect(() => assertSafeCrmPayload(m.createFields, m.rows, cfg, { create: true })).not.toThrow();
  });

  it("an order deal: status words, refund amount, margin in AED, admin link to the booking", () => {
    const s = directOrderState(subjectId(), { authorised: true, status: "partially_confirmed", capturedMinor: 43_000n, refundedMinor: 18_000n, marginAedMinor: 4_250n });
    s.order!.items = [
      { title: "Burj Khalifa At the Top", serviceDate: "2026-12-05", totalMinor: 25_000n, status: "confirmed", needsDocument: true, documentReady: true },
      { title: "Dhow cruise", serviceDate: "2026-12-02", totalMinor: 18_000n, status: "rejected", needsDocument: true, documentReady: false },
    ];
    const m = mapDeal(s, cfg, { now });
    if (!m.visible) throw new Error("expected visible");
    expect(m.fields.opportunity).toBe(250);
    expect({
      payment: uf(m.fields, "payment_status"),
      supplier: uf(m.fields, "supplier_booking_status"),
      ticket: uf(m.fields, "ticket_status"),
      refund: uf(m.fields, "refund_status"),
      refundAmount: uf(m.fields, "refund_amount"),
      travel: uf(m.fields, "travel_date"),
      summary: uf(m.fields, "item_summary"),
      margin: uf(m.fields, "margin"),
      indicative: uf(m.fields, "indicative_amount"),
      link: uf(m.fields, "admin_link"),
    }).toEqual({
      payment: "partially_refunded",
      supplier: "partially_confirmed",
      ticket: "issued",
      refund: "partially_refunded",
      refundAmount: 180,
      travel: "2026-12-05",
      summary: "1 confirmed, 1 not supplied",
      margin: 42.5,
      indicative: 250,
      link: `${FAKE_SITE}/admin/bookings/OUT-4829135`,
    });
    expect(() => assertSafeCrmPayload(m.fields, m.rows, cfg)).not.toThrow();
  });

  it.each([
    [{}, "not_paid", "pending", "pending", "none"],
    [{ authorised: true }, "authorised", "pending", "pending", "none"],
    [{ authorised: true, capturedMinor: 25_000n }, "paid", "pending", "pending", "none"],
    [{ authorised: true, capturedMinor: 25_000n, refundPending: true }, "paid", "pending", "pending", "pending"],
    [{ authorised: true, status: "refunded", capturedMinor: 25_000n, refundedMinor: 25_000n }, "refunded", "pending", "pending", "refunded"],
  ])("order status words %#", (over, payment, supplier, ticket, refund) => {
    const s = directOrderState(subjectId(), { status: "paid", ...over });
    const m = mapDeal(s, cfg);
    if (!m.visible) throw new Error("expected visible");
    expect([uf(m.fields, "payment_status"), uf(m.fields, "supplier_booking_status"), uf(m.fields, "ticket_status"), uf(m.fields, "refund_status")]).toEqual([payment, supplier, ticket, refund]);
  });

  it("margin is empty, never 0, while a cost is unknown", () => {
    const m = mapDeal(directOrderState(subjectId(), { authorised: true, marginAedMinor: null }), cfg);
    expect(m.visible && uf(m.fields, "margin")).toBe("");
    const line = (over: Partial<{ status: string; netCostAed: bigint; totalAed: bigint }> = {}) => ({ status: "confirmed", totalAed: 25_000n, totalInr: 0n, chargedCurrency: "AED", chargedAmountMinor: 24_000n, netCostAed: 20_000n, ...over });
    expect(marginAedMinor([line()])).toBe(4_000n);
    expect(marginAedMinor([line(), line({ netCostAed: 0n })])).toBeNull();
    // A rejected line's unknown cost does not hide the margin of the lines that were sold.
    expect(marginAedMinor([line(), line({ status: "rejected", netCostAed: 0n })])).toBe(4_000n);
    expect(marginAedMinor([])).toBeNull();
    expect(lineTotalMinor({ totalAed: 25_000n, totalInr: 0n, chargedCurrency: null, chargedAmountMinor: null }, "AED")).toBe(25_000n);
  });

  it("customer details only while allowed: never on a spam deal, never when absent, never in a wrong shape", () => {
    const blank = (m: ReturnType<typeof mapDeal>) => (m.visible ? [uf(m.fields, "customer_name"), uf(m.fields, "customer_phone"), uf(m.fields, "customer_email")] : null);
    expect(blank(mapDeal(inquiryState(subjectId(), { status: "spam" }), cfg))).toEqual(["", "", ""]);
    expect(blank(mapDeal(inquiryState(subjectId(), { contact: null }), cfg))).toEqual(["", "", ""]);
    const typedIn = { name: ["write to", ["me", "example.invalid"].join("@")].join(" "), phone: "04 000 1234", email: "not an address" };
    expect(blank(mapDeal(inquiryState(subjectId(), { contact: typedIn }), cfg))).toEqual(["", "", ""]);
    // The consent flags go with the details: a deal without them says "N".
    const m = mapDeal(inquiryState(subjectId(), { status: "spam" }), cfg);
    expect(m.visible && [uf(m.fields, "consent_marketing_email"), uf(m.fields, "consent_marketing_email_at")]).toEqual(["N", ""]);
    // Anonymous visitors and abandoned carts never become deals at all.
    expect(mapDeal(inquiryState(subjectId(), { source: "abandoned_cart" }), cfg)).toEqual({ visible: false, reason: "abandoned_cart" });
    expect(mapDeal(directOrderState(subjectId()), cfg)).toEqual({ visible: false, reason: "not_authorised" });
  });
});

describe("CRM revenue (owner answer Q4, gap G12)", () => {
  const pay = (over: Partial<CrmPaymentFacts>): CrmPaymentFacts => ({
    source: "gateway_verified",
    status: "captured",
    currency: "AED",
    amountMinor: 0n,
    capturedMinor: 0n,
    refundedMinor: 0n,
    authorizedAt: null,
    refunds: [],
    ...over,
  });

  it("a payment recorded by staff in OUTLYY admin counts the same as a Stripe capture", () => {
    expect(revenueFromPayments([pay({ source: "manual", amountMinor: 30_000n })], "AED")).toEqual({ capturedMinor: 30_000n, refundedMinor: 0n, authorised: true, refundPending: false });
    expect(revenueFromPayments([pay({ capturedMinor: 30_000n })], "AED")).toMatchObject({ capturedMinor: 30_000n, authorised: true });
    expect(revenueFromPayments([pay({ capturedMinor: 10_000n }), pay({ source: "manual", amountMinor: 5_000n })], "AED").capturedMinor).toBe(15_000n);
  });

  it("minus verified refunds: the payment's refunded total or its settled refund rows, never below zero", () => {
    expect(revenueFromPayments([pay({ capturedMinor: 30_000n, refundedMinor: 12_000n })], "AED")).toMatchObject({ capturedMinor: 30_000n, refundedMinor: 12_000n });
    const staff = pay({ source: "manual", status: "partially_refunded", amountMinor: 30_000n, refunds: [{ status: "succeeded", amountMinor: 8_000n }, { status: "failed", amountMinor: 9_000n }] });
    expect(revenueFromPayments([staff], "AED")).toMatchObject({ capturedMinor: 30_000n, refundedMinor: 8_000n, refundPending: false });
    expect(revenueFromPayments([pay({ capturedMinor: 1_000n, refundedMinor: 5_000n })], "AED").refundedMinor).toBe(1_000n);
    // An open refund is reported, but not deducted until it settles.
    expect(revenueFromPayments([pay({ capturedMinor: 30_000n, refunds: [{ status: "requested", amountMinor: 30_000n }] })], "AED")).toMatchObject({ refundedMinor: 0n, refundPending: true });
  });

  it("never counts an unverified or untaken payment, or one in another currency", () => {
    expect(revenueFromPayments([pay({ source: "gateway", capturedMinor: 30_000n })], "AED")).toMatchObject({ capturedMinor: 0n, authorised: false });
    expect(revenueFromPayments([pay({ source: "manual", status: "failed", amountMinor: 30_000n })], "AED")).toMatchObject({ capturedMinor: 0n, authorised: false });
    expect(revenueFromPayments([pay({ source: "manual", amountMinor: 30_000n, currency: "INR" })], "AED").capturedMinor).toBe(0n);
    // A provider authorisation alone makes the deal visible at zero revenue.
    expect(revenueFromPayments([pay({ status: "authorized", authorizedAt: new Date() })], "AED")).toMatchObject({ capturedMinor: 0n, authorised: true });
  });
});

describe("CRM payload guard", () => {
  const base = mapDeal(inquiryState("00000000-0000-7000-8000-000000000001"), cfg, { now: new Date("2026-11-24T10:00:00.000Z") });
  if (!base.visible) throw new Error("expected visible");
  const ok: DealFields = base.fields;
  const row = { productName: "Desert safari + BBQ (2026-12-01)", price: 0, quantity: 1 };
  const withUf = (key: (typeof CRM_FIELD_KEYS)[number], v: string | number): DealFields => ({ ...ok, [fieldCode(key)]: v });

  it("passes the normal shape, with references, service dates and the customer's details in their own fields", () => {
    expect(() => assertSafeCrmPayload(ok, [row], cfg)).not.toThrow();
  });

  it.each([
    ["an email", `Pick up ${["guest.one", "example.test"].join("@")}`, "row_email"],
    ["a phone number", "Call +971 4 000 0000", "row_digits"],
    ["a long digit run", "Booking 9714000000099", "row_digits"],
    ["a recovery or capability token", `Ticket tok ${"Ab".repeat(18)}_-`, "row_token"],
    ["a Stripe id", ["Paid with pi", "3PqExampleOnly"].join("_"), "row_provider_id"],
    ["a link", "See https://outlyy.example/t#abc", "row_url"],
    ["an erasure marker", "[deleted-0123456789ab]", "row_erased_marker"],
  ])("refuses %s in a product row", (_label, productName, code) => {
    expect(() => assertSafeCrmPayload(ok, [{ ...row, productName }], cfg)).toThrow(expect.objectContaining({ kind: "refused", code: `refused:${code}` }));
  });

  it.each([
    ["an extra field", { ...ok, contactId: 5 } as unknown as DealFields, "deal_keys"],
    ["a net cost field", { ...ok, UF_CRM_NET_COST: 100 } as DealFields, "deal_keys"],
    ["a missing OUTLYY field", (({ [fieldCode("margin")]: _m, ...rest }) => rest)(ok) as DealFields, "deal_keys"],
    ["the owner on an update", { ...ok, assignedById: 23 }, "deal_keys"],
    ["funnel 0", { ...ok, categoryId: 0, stageId: "C0:NEW" }, "category"],
    ["a stage of another funnel", { ...ok, stageId: "C9:NEW" }, "stage"],
    ["a bad origin id", { ...ok, originId: `inq:${["guest.one", "example.test"].join("@")}` }, "origin"],
    ["a foreign originator", { ...ok, originatorId: "someone" }, "originator"],
    ["another currency", { ...ok, currencyId: "USD" }, "currency"],
    ["a negative amount", { ...ok, opportunity: -1 }, "opportunity"],
    ["a name in the title", { ...ok, title: `OUTLYY ${["guest.one", "example.test"].join("@")}` }, "title_email"],
  ])("refuses %s", (_label, fields, code) => {
    expect(() => assertSafeCrmPayload(fields, [row], cfg)).toThrow(expect.objectContaining({ code: `refused:${code}` }));
  });

  it.each([
    ["a token in the name", "customer_name", `Guest ${"Zx".repeat(20)}`, "uf_customer_name_token"],
    ["a Stripe id in the name", "customer_name", ["Guest pi", "3PqExampleOnly"].join("_"), "uf_customer_name_provider_id"],
    ["a link in the name", "customer_name", "www.example.invalid", "uf_customer_name_url"],
    ["an erased name", "customer_name", "[deleted-0123456789ab]", "uf_customer_name_erased_marker"],
    ["a phone not in E.164", "customer_phone", "04 000 1234", "uf_customer_phone"],
    ["two addresses in the email", "customer_email", [["a", "b.invalid"].join("@"), ["c", "d.invalid"].join("@")].join(","), "uf_customer_email"],
    ["a token in the item summary", "item_summary", `2 confirmed ${"Q".repeat(40)}`, "uf_item_summary"],
    ["a phone in a status field", "payment_status", "+97140001234", "uf_payment_status"],
    ["free text in the reference", "reference", "INQ-1048213 call me", "uf_reference"],
    ["another environment", "environment", "production", "uf_environment"],
    ["a token in the admin link", "admin_link", `${FAKE_SITE}/admin/inquiries/00000000-0000-7000-8000-000000000001?t=abc`, "uf_admin_link"],
    ["an admin link on another site", "admin_link", "https://elsewhere.invalid/admin/inquiries/00000000-0000-7000-8000-000000000001", "uf_admin_link"],
    ["a capability path in the admin link", "admin_link", `${FAKE_SITE}/orders/OUT-4829135/access`, "uf_admin_link"],
    ["a text margin", "margin", "about 40", "uf_margin"],
    ["a negative refund amount", "refund_amount", -5, "uf_refund_amount"],
    ["a consent flag that is not Y or N", "consent_marketing_email", "yes", "uf_consent_marketing_email"],
    ["a consent time that is not an instant", "consent_marketing_whatsapp_at", "yesterday", "uf_consent_marketing_whatsapp_at"],
    ["no as-of time", "as_of", "", "uf_as_of"],
  ] as const)("refuses %s", (_label, key, value, code) => {
    expect(() => assertSafeCrmPayload(withUf(key, value), [row], cfg)).toThrow(expect.objectContaining({ code: `refused:${code}` }));
  });

  it("the owner only on a create, and only the configured one", () => {
    expect(() => assertSafeCrmPayload({ ...ok, assignedById: cfg.defaultOwnerId }, [row], cfg, { create: true })).not.toThrow();
    expect(() => assertSafeCrmPayload({ ...ok, assignedById: 99 }, [row], cfg, { create: true })).toThrow(expect.objectContaining({ code: "refused:owner" }));
    expect(() => assertSafeCrmPayload(ok, [row], cfg, { create: true })).toThrow(expect.objectContaining({ code: "refused:deal_keys" }));
  });

  it("refuses extra row fields and more than 50 rows", () => {
    expect(() => assertSafeCrmPayload(ok, [{ ...row, note: "x" } as never], cfg)).toThrow(expect.objectContaining({ code: "refused:row_keys" }));
    expect(() => assertSafeCrmPayload(ok, Array.from({ length: 51 }, () => row), cfg)).toThrow(expect.objectContaining({ code: "refused:rows_count" }));
  });
});

/**
 * The never-sent list (doc 29 §5.5) at its source: the snapshot reads no
 * column that could carry it. A select key added for any of these must be a
 * deliberate, reviewed change to this list.
 */
const SNAPSHOT = path.join(process.cwd(), "src/server/crm/crm.snapshot.ts");
describe.skipIf(!existsSync(SNAPSHOT))("CRM snapshot never reads the never-sent columns", () => {
  const src = readFileSync(SNAPSHOT, "utf8");
  const selected = new Set([...src.matchAll(/\b([a-zA-Z]+): (?:true|\{)/g)].map((m) => m[1]));

  it.each([
    "titleSnapshot",
    "hotel",
    "pickupZone",
    "pickupHotelId",
    "pickupHotelNameSnapshot",
    "dietary",
    "specialRequests",
    "pax",
    "ipHash",
    "userAgent",
    "spamSignals",
    "attribution",
    "gatewayPaymentId",
    "gatewayOrderId",
    "paymentLinkId",
    "paymentLinkUrl",
    "providerOrderId",
    "providerAccountId",
    "idempotencyKey",
    "failureReason",
    "marginSnapshot",
    "evidence",
    "notes",
    "ticketCodes",
    "capabilityGrants",
    "verifications",
  ])("%s", (column) => {
    expect(selected.has(column)).toBe(false);
  });

  it("the scan sees the snapshot's select keys", () => {
    for (const k of ["leadName", "leadPhone", "leadEmail", "capturedMinor", "refunds"]) expect(selected.has(k), k).toBe(true);
  });

  it("reads net cost only for the margin, never into a returned fact", () => {
    expect(selected.has("netCostAed")).toBe(true);
    expect(src).not.toMatch(/netCostAed: i\.netCostAed|netCost(?:Aed)?Minor:/);
  });
});
