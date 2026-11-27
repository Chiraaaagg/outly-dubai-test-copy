import { describe, expect, it } from "vitest";
import { splitInclusive, totalsOf, VAT_RULE } from "../../../domain/vat";
import { validatePdf } from "../../pdf";
import { renderFiscalPdf } from "../fiscal/render";
import { fiscalView, isFiscalSnapshot, refundReasonLabel, dubaiIsoDate, type FiscalLine, type FiscalSnapshot } from "../fiscal/snapshot";
import { LAYOUT_PENDING_BAND, toWinAnsi } from "../layout/plain";
import { pdfText } from "./pdf-text";

/**
 * Group C fiscal renderer (doc 93 §1.2, §5.1, §5.3; O1 one combined
 * "Tax invoice / Receipt" marked PAID; O4 no provider id; O5 no INR line).
 * Synthetic values only.
 */

function line(id: string, gross: bigint, over: Partial<FiscalLine> = {}): FiscalLine {
  const s = splitInclusive(gross, "standard");
  return { orderItemId: id, description: "Specimen Desert Safari", variant: "Standard", serviceDate: "2027-02-20", guests: "2 adults", vatCategory: "standard", rateLabel: "5%", rateBasisPoints: 500, discountMinor: "0", netMinor: String(s.netMinor), vatMinor: String(s.vatMinor), grossMinor: String(s.grossMinor), ...over };
}

function snapshot(over: Partial<FiscalSnapshot> = {}): FiscalSnapshot {
  const lines = over.lines ?? [line("a", 40000n), line("b", 2000n, { description: "Specimen Monorail Ticket", variant: null })];
  const t = totalsOf(lines.map((l) => ({ grossMinor: BigInt(l.grossMinor), netMinor: BigInt(l.netMinor), vatMinor: BigInt(l.vatMinor), category: "standard" as const })));
  return {
    docType: "tax_invoice",
    displayNumber: "TEST-INV-000123",
    environment: "test",
    issuedAt: "2027-02-14T10:05:00.000Z",
    supplyDate: "2027-02-14",
    currency: "AED",
    orderReference: "OUT-000000",
    seller: { legalName: "[Legal name]", tradingName: "OUTLYY", trn: "[TRN]", address: "[Registered address]", licence: null, supportEmail: "support@example.com", phone: null, placeholder: true },
    lines,
    totals: { netMinor: String(t.netMinor), vatMinor: String(t.vatMinor), grossMinor: String(t.grossMinor), byRate: t.byRate.map((r) => ({ label: r.label, basisPoints: r.basisPoints, netMinor: String(r.netMinor), vatMinor: String(r.vatMinor) })) },
    moneyAt: "2027-02-14T10:05:00.000Z",
    paymentMethodLabel: "Card",
    refersTo: null,
    refundReasonLabel: null,
    vatRule: VAT_RULE,
    vatRuleConfirmed: false,
    templateVersion: 1,
    ...over,
  };
}

describe("fiscal PDF (plain layout, switch-off backbone)", () => {
  it("draws the combined Tax invoice / Receipt marked PAID, byte-stable, accepted by the strict validator", async () => {
    const a = await renderFiscalPdf(snapshot(), { buyerName: "Asha Specimen" });
    const b = await renderFiscalPdf(snapshot(), { buyerName: "Asha Specimen" });
    expect(Buffer.compare(Buffer.from(a.bytes), Buffer.from(b.bytes))).toBe(0);
    expect(validatePdf(a.bytes, { maxBytes: 10 * 1024 * 1024 }).ok).toBe(true);
    expect(a.templateVersion).toBe(1);
    const [text] = await pdfText(a.bytes);
    for (const s of ["Tax invoice / Receipt", "TEST-INV-000123", "PAID", "OUT-000000", "Asha Specimen", "[Legal name]", "[TRN]", "Total excluding VAT", "VAT 5%", "AED 420.00", "AED 20.00", "380.95", "19.05", "It is not your entry ticket", LAYOUT_PENDING_BAND]) {
      expect(text, s).toContain(s);
    }
  });

  it("every page says what it is: layout pending, TEST, VAT unconfirmed, placeholder seller", async () => {
    const lines = Array.from({ length: 40 }, (_, i) => line(`l${i}`, 1000n + BigInt(i), { description: `Specimen line ${i} with a fairly long activity title that wraps onto a second line` }));
    const out = await renderFiscalPdf(snapshot({ lines }), null);
    const pages = await pdfText(out.bytes);
    expect(pages.length).toBeGreaterThan(1);
    for (const p of pages) {
      expect(p).toContain(LAYOUT_PENDING_BAND);
      expect(p).toContain("TEST — not a tax invoice");
      expect(p).toContain("UNCONFIRMED");
      expect(p).toContain("placeholders");
      expect(p).toMatch(/Page \d+ of \d+/);
    }
  });

  it("prints no provider id, no INR value, no net cost or margin", async () => {
    const out = await renderFiscalPdf(snapshot(), { buyerName: "Asha Specimen" });
    const text = (await pdfText(out.bytes)).join("\n");
    expect(text).not.toMatch(/₹|INR|pi_|ch_|re_|stripe|margin|net cost/i);
    const v = fiscalView(snapshot(), null);
    expect(JSON.stringify(v)).not.toMatch(/INR|stripe|margin/i);
    expect(v.booking.find(([k]) => k === "Customer")).toBeUndefined();
  });

  it("a credit note names its invoice, the reason in plain words, and the VAT credited", async () => {
    const cn = snapshot({
      docType: "tax_credit_note",
      displayNumber: "TEST-CN-000007",
      lines: [line("a", 30000n, { note: "Partial refund" })],
      refersTo: { displayNumber: "TEST-INV-000123", issuedAt: "2027-02-14T10:05:00.000Z" },
      refundReasonLabel: refundReasonLabel("customer_cancel_request"),
      moneyAt: "2027-02-18T08:00:00.000Z",
    });
    const [text] = await pdfText((await renderFiscalPdf(cn, { buyerName: null })).bytes);
    for (const s of ["Tax credit note", "TEST-CN-000007", "TEST-INV-000123", "Cancelled by the guest", "Partial refund", "Total credited", "Of which VAT", "Refunded to the original card"]) expect(text, s).toContain(s);
    expect(text).not.toContain("PAID ");
  });

  it("shows the discount column only when a line has a discount", () => {
    expect(fiscalView(snapshot(), null).columns.map((c) => c.label)).not.toContain("Discount");
    const v = fiscalView(snapshot({ lines: [line("a", 36000n, { discountMinor: "4000" })] }), null);
    expect(v.columns.map((c) => c.label)).toContain("Discount");
    expect(v.rows[0]).toContain("40.00");
  });

  it("replaces characters the standard font cannot draw, and counts them for staff", async () => {
    expect(toWinAnsi("Asha Specimen")).toEqual({ text: "Asha Specimen", replaced: 0 });
    expect(toWinAnsi("आशा 😀")).toEqual({ text: "??? ?", replaced: 4 });
    const out = await renderFiscalPdf(snapshot(), { buyerName: "आशा Specimen" });
    expect(out.replacedChars).toBe(3);
    expect(validatePdf(out.bytes, { maxBytes: 10 * 1024 * 1024 }).ok).toBe(true);
  });

  it("checks a stored snapshot before drawing", () => {
    expect(isFiscalSnapshot(snapshot())).toBe(true);
    expect(isFiscalSnapshot({ ...snapshot(), currency: "INR" })).toBe(false);
    expect(isFiscalSnapshot({ ...snapshot(), lines: [] })).toBe(false);
    expect(isFiscalSnapshot({ ...snapshot(), lines: [{ ...line("a", 1n), vatCategory: "vat5" }] })).toBe(false);
    expect(isFiscalSnapshot(null)).toBe(false);
  });

  it("dates are Dubai calendar dates", () => {
    expect(dubaiIsoDate(new Date("2027-02-14T20:30:00Z"))).toBe("2027-02-15");
    expect(dubaiIsoDate(new Date("2027-02-14T19:59:00Z"))).toBe("2027-02-14");
  });
});
