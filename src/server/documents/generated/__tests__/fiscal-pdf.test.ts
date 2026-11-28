import { describe, expect, it } from "vitest";
import { splitDiscount, splitInclusive, totalsOf, VAT_RULE, type VatCategory } from "../../../domain/vat";
import { validatePdf } from "../../pdf";
import { renderFiscalPdf } from "../fiscal/render";
import { fiscalView, isFiscalSnapshot, refundReasonLabel, dubaiIsoDate, type FiscalLine, type FiscalSnapshot } from "../fiscal/snapshot";
import { LAYOUT_PENDING_BAND, toWinAnsi } from "../layout/plain";
import { plainFiscalLayout } from "../fiscal/render";
import { isRealSellerText, isRealTrn, sellerFrom } from "../fiscal/seller";
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
  const t = totalsOf(lines.map((l) => ({ grossMinor: BigInt(l.grossMinor), netMinor: BigInt(l.netMinor), vatMinor: BigInt(l.vatMinor), category: l.vatCategory })));
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
  it("draws the combined Tax Invoice / Receipt (A3) marked PAID, byte-stable, accepted by the strict validator", async () => {
    const a = await renderFiscalPdf(snapshot(), { buyerName: "Asha Specimen" });
    const b = await renderFiscalPdf(snapshot(), { buyerName: "Asha Specimen" });
    expect(Buffer.compare(Buffer.from(a.bytes), Buffer.from(b.bytes))).toBe(0);
    expect(validatePdf(a.bytes, { maxBytes: 10 * 1024 * 1024 }).ok).toBe(true);
    expect(a.templateVersion).toBe(1);
    const [text] = await pdfText(a.bytes);
    for (const s of ["Tax Invoice / Receipt", "TEST-INV-000123", "PAID", "OUT-000000", "Asha Specimen", "[Legal name]", "[TRN]", "Total excluding VAT", "VAT 5%", "AED 420.00", "AED 20.00", "380.95", "19.05", "It is not your entry ticket", LAYOUT_PENDING_BAND]) {
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
    for (const s of ["Tax Credit Note", "TEST-CN-000007", "TEST-INV-000123", "Cancelled by the guest", "Partial refund", "Total credited", "Of which VAT", "Refunded to the original card"]) expect(text, s).toContain(s);
    expect(text).not.toContain("PAID ");
  });

  it("shows the discount column only when a line has a discount", () => {
    expect(fiscalView(snapshot(), null).columns.map((c) => c.label)).not.toContain("Discount");
    const v = fiscalView(snapshot({ lines: [line("a", 36000n, { discountMinor: "4000" })] }), null);
    expect(v.columns.map((c) => c.label)).toContain("Discount");
    expect(v.rows[0]).toContain("40.00");
  });

  it("A5: a discount is its own negative line, drawn and totalled; a snapshot never has a negative item line", async () => {
    const item = line("a", 40000n);
    const d = splitDiscount(4000n, "standard");
    const disc: FiscalLine = { ...item, lineKind: "discount", description: "Discount", variant: "Specimen Desert Safari", guests: "", netMinor: String(d.netMinor), vatMinor: String(d.vatMinor), grossMinor: String(d.grossMinor) };
    const snap = snapshot({ lines: [{ ...item, lineKind: "item" }, disc] });
    expect(isFiscalSnapshot(snap)).toBe(true);
    expect(snap.totals).toMatchObject({ grossMinor: "36000", vatMinor: "1715" });
    const [text] = await pdfText((await renderFiscalPdf(snap, null)).bytes);
    for (const s of ["Discount", "-40.00", "-1.90", "AED 360.00", "AED 17.15"]) expect(text, s).toContain(s);
    expect(isFiscalSnapshot(snapshot({ lines: [{ ...item, grossMinor: "-1" }] }))).toBe(false);
    expect(isFiscalSnapshot(snapshot({ lines: [{ ...disc, grossMinor: "1" }] }))).toBe(false);
  });

  it("A6: an exempt line carries no VAT and says Exempt on the line and in the totals", async () => {
    const exempt = (id: string, gross: bigint): FiscalLine => {
      const cat: VatCategory = "exempt";
      const sp = splitInclusive(gross, cat);
      return { ...line(id, gross), description: "Specimen Monorail Ticket", variant: null, vatCategory: cat, rateLabel: "Exempt", rateBasisPoints: 0, netMinor: String(sp.netMinor), vatMinor: String(sp.vatMinor), grossMinor: String(sp.grossMinor) };
    };
    const mixed = fiscalView(snapshot({ lines: [line("a", 40000n), exempt("b", 2000n)] }), null);
    expect(mixed.rows[1]).toContain("Exempt");
    expect(mixed.totals).toContainEqual(["Exempt supplies, no VAT", "AED 20.00"]);
    expect(mixed.totals).toContainEqual(["VAT 5%", "AED 19.05"]);
    const only = fiscalView(snapshot({ lines: [exempt("b", 2000n)] }), null);
    expect(only.totals.find(([k]) => k.startsWith("VAT "))).toBeUndefined();
    expect(only.notes).toContain("All amounts in UAE dirhams (AED). No VAT is charged on this document.");
    const [text] = await pdfText((await renderFiscalPdf(snapshot({ lines: [exempt("b", 2000n)] }), null)).bytes);
    expect(text).toContain("Exempt");
  });

  it("review 109c N6: an erased buyer prints a neutral line, never a marker or the old name", () => {
    const v = fiscalView(snapshot(), { buyerName: null, erased: true });
    expect(v.booking).toContainEqual(["Customer", "Private customer"]);
    expect(JSON.stringify(v)).not.toMatch(/deleted-/);
  });

  it("C-P2: a full tax invoice is headed Tax Invoice and prints the buyer's name, address and TRN; its cancelling credit note says no money was refunded", async () => {
    const trn = ["1", "0".repeat(13), "7"].join("");
    const full = snapshot({ displayNumber: "TEST-INV-000124", invoiceType: "full", reissue: { kind: "full", replacesNumber: "TEST-INV-000123", cancelledBy: "TEST-CN-000009" } });
    const v = fiscalView(full, { buyerName: "Specimen Trading LLC", buyerTrn: trn, buyerAddress: "Specimen Tower, Dubai" });
    expect(v.title).toBe("Tax Invoice");
    expect(v.booking).toEqual(expect.arrayContaining([["Customer", "Specimen Trading LLC"], ["Customer address", "Specimen Tower, Dubai"], ["Customer TRN", trn]]));
    expect(v.booking).toContainEqual(["Replaces", "Simplified tax invoice TEST-INV-000123, cancelled by credit note TEST-CN-000009"]);
    const [text] = await pdfText((await renderFiscalPdf(full, { buyerName: "Specimen Trading LLC", buyerTrn: trn, buyerAddress: "Specimen Tower, Dubai" })).bytes);
    for (const t of ["Tax Invoice", "Specimen Trading LLC", trn, "Date of supply", "PAID"]) expect(text, t).toContain(t);
    const cancel = fiscalView(
      snapshot({ docType: "tax_credit_note", displayNumber: "TEST-CN-000009", refersTo: { displayNumber: "TEST-INV-000123", issuedAt: "2027-02-14T10:05:00.000Z" }, refundReasonLabel: "Reissued as a full tax invoice", reissue: { kind: "cancel", replacementNumber: "TEST-INV-000124" } }),
      { buyerName: "Asha Specimen" },
    );
    expect(cancel.notes[0]).toBe("Cancels simplified tax invoice TEST-INV-000123, reissued as full tax invoice TEST-INV-000124.");
    expect(cancel.notes).toContain("No money was refunded.");
    expect(cancel.notes.join(" ")).not.toMatch(/Refunded to/);
  });

  it("C-P1: an INR-paid line keeps its INR source for audit, but nothing INR is printed", async () => {
    const src = { currency: "INR" as const, grossMinor: "919540", aedPerInr: "0.04350000", rateDate: "2027-02-14", rateSource: "CBUAE" as const };
    const snap = snapshot({ lines: [line("a", 40000n, { source: src })], fx: { from: "INR", aedPerInr: "0.04350000", rateDate: "2027-02-14", source: "CBUAE" } });
    expect(isFiscalSnapshot(snap)).toBe(true);
    const text = (await pdfText((await renderFiscalPdf(snap, null)).bytes)).join("\n");
    expect(text).not.toMatch(/INR|9,195|0\.0435|CBUAE/);
    expect(text).toContain("AED 400.00");
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

  it("a credit note's reason line is printed whole on its own line, never split by wrapping", async () => {
    const cn = snapshot({
      docType: "tax_credit_note",
      displayNumber: "TEST-CN-000008",
      lines: [line("a", 30000n, { description: "Specimen Desert Safari with a long enough title to wrap in the column", note: "Partial refund" })],
      refersTo: { displayNumber: "TEST-INV-000123", issuedAt: "2027-02-14T10:05:00.000Z" },
      refundReasonLabel: refundReasonLabel("customer_cancel_request"),
    });
    const [text] = await pdfText((await renderFiscalPdf(cn, null)).bytes);
    expect(text.split("\n")).toContain("Partial refund");
    expect(fiscalView(cn, null).rows[0][0]).toMatch(/\nPartial refund$/);
  });

  it("the plain layout is not a production layout (finding 5)", () => {
    expect(plainFiscalLayout.productionReady).toBe(false);
  });

  it("seller details: stand-ins and malformed values count as placeholders (finding 18)", () => {
    // TRN-shaped values are built at run time (the public CI copy is scanned for long digit runs).
    const trn = ["1", "0".repeat(13), "3"].join("");
    const real = { FISCAL_SELLER_LEGAL_NAME: "Specimen Legal Name LLC", FISCAL_SELLER_TRN: trn, FISCAL_SELLER_ADDRESS: "Specimen Street, Dubai" };
    expect(sellerFrom(real).placeholder).toBe(false);
    expect(sellerFrom({}).placeholder).toBe(true);
    for (const name of ["TBC", "tbd", "[Legal name]", "N/A", "xxx", "Placeholder", "ab", "1234"]) {
      expect(isRealSellerText(name, 3), name).toBe(false);
      expect(sellerFrom({ ...real, FISCAL_SELLER_LEGAL_NAME: name }).placeholder, name).toBe(true);
    }
    expect(sellerFrom({ ...real, FISCAL_SELLER_ADDRESS: "Dubai" }).placeholder).toBe(true);
    expect(isRealTrn("0".repeat(15))).toBe(false);
    expect(isRealTrn(trn.slice(1))).toBe(false);
    expect(isRealTrn(trn)).toBe(true);
    expect(sellerFrom({ ...real, FISCAL_SELLER_TRN: "1".repeat(15) }).placeholder).toBe(true);
    expect(sellerFrom({ ...real, FISCAL_SELLER_LICENCE: "1234567" }).licence).toBe("1234567");
  });

  it("dates are Dubai calendar dates", () => {
    expect(dubaiIsoDate(new Date("2027-02-14T20:30:00Z"))).toBe("2027-02-15");
    expect(dubaiIsoDate(new Date("2027-02-14T19:59:00Z"))).toBe("2027-02-14");
  });
});
