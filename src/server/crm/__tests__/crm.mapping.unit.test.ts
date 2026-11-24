import { describe, expect, it } from "vitest";
import { assertSafeCrmPayload, GENERIC_LINE, mapDeal, orderStage, snapshotHash, type CrmOrderFacts } from "@/server/crm/crm.mapping";
import type { DealFields } from "@/server/crm/bitrix.client";
import { directOrderState, fakeConfig, inquiryState, subjectId } from "./_memory-store";

/**
 * Deal mapping (doc 29 §5.4, §5.5, owner decisions 14, 16, 17): stages from
 * verified state only, revenue = captured minus refunded, deal fields from
 * an allowlist, and the payload guard against anything personal or secret.
 */

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
    ["negotiating", "negotiating"],
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

  it("sends exactly the allowlisted deal fields: no contact, margin, cost, link, UTM or status field", () => {
    const m = mapDeal(directOrderState(subjectId(), { authorised: true }), cfg);
    expect(m.visible && Object.keys(m.fields).sort()).toEqual(["categoryId", "currencyId", "isManualOpportunity", "opportunity", "originId", "originatorId", "stageId", "title"]);
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
    expect(a.hash).toBe(snapshotHash(a.fields, a.rows));
  });
});

describe("CRM payload guard", () => {
  const ok: DealFields = {
    title: "OUTLYY INQ-1048213 / OUT-4829135",
    categoryId: 7,
    stageId: "C7:NEW_INQUIRY",
    opportunity: 12.5,
    currencyId: "AED",
    isManualOpportunity: "Y",
    originatorId: "outlyy-staging",
    originId: "inq:00000000-0000-7000-8000-000000000001",
  };
  const row = { productName: "Desert safari + BBQ (2026-12-01)", price: 0, quantity: 1 };

  it("passes the normal shape, with references and service dates", () => {
    expect(() => assertSafeCrmPayload(ok, [row])).not.toThrow();
  });

  it.each([
    ["an email", "Pick up guest.one@example.test", "row_email"],
    ["a phone number", "Call +971 4 000 0000", "row_digits"],
    ["a long digit run", "Booking 9714000000099", "row_digits"],
    ["a recovery or capability token", `Ticket tok ${"Ab".repeat(18)}_-`, "row_token"],
    ["a Stripe id", "Paid with pi_3PqExampleOnly", "row_provider_id"],
    ["a link", "See https://outlyy.example/t#abc", "row_url"],
    ["an erasure marker", "[deleted-0123456789ab]", "row_erased_marker"],
  ])("refuses %s in a product row", (_label, productName, code) => {
    expect(() => assertSafeCrmPayload(ok, [{ ...row, productName }])).toThrow(expect.objectContaining({ kind: "refused", code: `refused:${code}` }));
  });

  it.each([
    ["an extra field", { ...ok, contactId: 5 } as unknown as DealFields, "deal_keys"],
    ["funnel 0", { ...ok, categoryId: 0, stageId: "C0:NEW" }, "category"],
    ["a stage of another funnel", { ...ok, stageId: "C9:NEW" }, "stage"],
    ["a bad origin id", { ...ok, originId: "inq:guest.one@example.test" }, "origin"],
    ["a foreign originator", { ...ok, originatorId: "someone" }, "originator"],
    ["another currency", { ...ok, currencyId: "USD" }, "currency"],
    ["a negative amount", { ...ok, opportunity: -1 }, "opportunity"],
    ["a name in the title", { ...ok, title: "OUTLYY guest.one@example.test" }, "title_email"],
  ])("refuses %s", (_label, fields, code) => {
    expect(() => assertSafeCrmPayload(fields, [row])).toThrow(expect.objectContaining({ code: `refused:${code}` }));
  });

  it("refuses extra row fields and more than 50 rows", () => {
    expect(() => assertSafeCrmPayload(ok, [{ ...row, note: "x" } as never])).toThrow(expect.objectContaining({ code: "refused:row_keys" }));
    expect(() => assertSafeCrmPayload(ok, Array.from({ length: 51 }, () => row))).toThrow(expect.objectContaining({ code: "refused:rows_count" }));
  });
});
