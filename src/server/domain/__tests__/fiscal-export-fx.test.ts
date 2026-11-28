import { describe, expect, it } from "vitest";
import { csvText, dubaiPeriodOf, exportCsv, periodBounds, periodLabel, plainAmount, previousPeriod, EXPORT_COLUMNS, UTF8_BOM } from "../fiscal-export-csv";
import { cbuaeRateFrom, inrToAedMinor, parseAedPerInr, RATE_JUMP_CONFIRM_BPS, rateMoveBps } from "../fiscal-fx";

/**
 * Group C pre-launch round 2: the accountant's monthly CSV (owner decision
 * C-P4) and the INR → AED conversion at the CBUAE rate (C-P1). Pure; synthetic
 * values only.
 */
describe("monthly accountant CSV (C-P4)", () => {
  it("one row per line, credit notes negative, no consumer name, a credit note names its invoice, BOM, RFC 4180 quoting and a formula guard", () => {
    const { csv, lineCount } = exportCsv([
      {
        displayNumber: "TEST-INV-000001",
        docType: "tax_invoice",
        issueReason: "money",
        issueDate: "2026-11-28",
        supplyDate: "2026-11-28",
        orderReference: "OUT-000001",
        refersTo: null,
        buyerLegalName: null,
        buyerTrn: null,
        lines: [
          { description: "Specimen Desert Safari", variant: "Standard, sunset", vatCategory: "standard", netMinor: "38095", vatMinor: "1905", grossMinor: "40000" },
          { description: "Discount", variant: "Specimen Desert Safari", vatCategory: "standard", netMinor: "-3810", vatMinor: "-190", grossMinor: "-4000" },
        ],
      },
      {
        displayNumber: "TEST-CN-000001",
        docType: "tax_credit_note",
        issueReason: "money",
        issueDate: "2026-11-29",
        supplyDate: "2026-11-29",
        orderReference: "OUT-000001",
        refersTo: "TEST-INV-000001",
        buyerLegalName: null,
        buyerTrn: null,
        lines: [{ description: "=HYPERLINK(1)", variant: null, vatCategory: "exempt", netMinor: "2000", vatMinor: "0", grossMinor: "2000" }],
      },
    ]);
    expect(lineCount).toBe(3);
    expect(csv.startsWith(UTF8_BOM)).toBe(true);
    const rows = csv.slice(UTF8_BOM.length).split("\r\n");
    expect(rows[0]).toBe(EXPORT_COLUMNS.join(","));
    expect(rows[0]).toBe("Document number,Type,Issue date,Date of supply,Order reference,Refers to,Buyer legal name,Buyer TRN,Line description,VAT category,Net,VAT,Gross,Currency");
    expect(rows[1]).toBe('TEST-INV-000001,Tax invoice (simplified),2026-11-28,2026-11-28,OUT-000001,,,,"Specimen Desert Safari · Standard, sunset",standard,380.95,19.05,400.00,AED');
    expect(rows[2]).toContain(",-38.10,-1.90,-40.00,AED");
    expect(rows[3]).toBe("TEST-CN-000001,Tax credit note,2026-11-29,2026-11-29,OUT-000001,TEST-INV-000001,,,'=HYPERLINK(1),exempt,-20.00,0.00,-20.00,AED");
    expect(rows[4]).toBe("");
    expect(exportCsv([]).csv).toBe(`${UTF8_BOM}${EXPORT_COLUMNS.join(",")}\r\n`);
  });

  it("labels the reissue documents and carries the business buyer of a full tax invoice; formats amounts plainly, guards text", () => {
    const trn = ["1", "0".repeat(13), "7"].join("");
    const csv = exportCsv([
      { displayNumber: "INV-000002", docType: "tax_invoice", issueReason: "reissue_full", issueDate: "2026-12-01", supplyDate: "2026-11-28", orderReference: "OUT-1", refersTo: null, buyerLegalName: "Specimen Trading LLC", buyerTrn: trn, lines: [{ description: "X", variant: null, vatCategory: "standard", netMinor: "100", vatMinor: "5", grossMinor: "105" }] },
      { displayNumber: "CN-000002", docType: "tax_credit_note", issueReason: "reissue_cancel", issueDate: "2026-12-01", supplyDate: "2026-12-01", orderReference: "OUT-1", refersTo: "INV-000001", buyerLegalName: null, buyerTrn: null, lines: [{ description: "X", variant: null, vatCategory: "standard", netMinor: "100", vatMinor: "5", grossMinor: "105" }] },
    ]).csv;
    expect(csv).toContain(`INV-000002,Full tax invoice,2026-12-01,2026-11-28,OUT-1,,Specimen Trading LLC,${trn},X,standard,1.00,0.05,1.05,AED`);
    expect(csv).toContain("CN-000002,Tax credit note (reissue),2026-12-01,2026-12-01,OUT-1,INV-000001,,,X,");
    expect(plainAmount(123456789n)).toBe("1234567.89");
    expect(plainAmount(-5n)).toBe("-0.05");
    expect(csvText("+1")).toBe("'+1");
    expect(csvText("@x")).toBe("'@x");
    expect(csvText("plain")).toBe("plain");
  });

  it("periods follow the Dubai calendar", () => {
    // 30 Nov 2026 21:00 UTC is 1 Dec 01:00 in Dubai.
    expect(dubaiPeriodOf(new Date("2026-11-30T21:00:00Z"))).toBe("2026-12");
    expect(dubaiPeriodOf(new Date("2026-11-30T19:59:59Z"))).toBe("2026-11");
    expect(previousPeriod("2027-01")).toBe("2026-12");
    expect(previousPeriod("2026-12")).toBe("2026-11");
    expect(periodBounds("2026-11")).toEqual({ from: new Date("2026-10-31T20:00:00Z"), to: new Date("2026-11-30T20:00:00Z") });
    expect(periodBounds("2026-12").to).toEqual(new Date("2026-12-31T20:00:00Z"));
    expect(periodLabel("2026-11")).toBe("November 2026");
  });
});

describe("INR to AED at the CBUAE rate (C-P1)", () => {
  it("accepts only a plausible AED-per-INR rate, normalised to 8 places", () => {
    expect(parseAedPerInr("0.0435")).toBe("0.04350000");
    expect(parseAedPerInr(" 0.04351234 ")).toBe("0.04351234");
    // Review 109e S2: the plausible band is 0.0300 to 0.0600, so a real market move never blocks entry.
    expect(parseAedPerInr("0.03")).toBe("0.03000000");
    expect(parseAedPerInr("0.06")).toBe("0.06000000");
    expect(parseAedPerInr("0.0399")).toBe("0.03990000");
    for (const bad of ["", "0.4350", "0.004", "0.0299", "0.06001", "0.02", "0.08", "23.0", "0.04350000001", "abc", null, undefined]) expect(parseAedPerInr(bad), String(bad)).toBeNull();
    // A move of more than 5 % needs a confirmation (basis points of the earlier rate).
    expect(rateMoveBps("0.0435", "0.0436")).toBe(22n);
    expect(rateMoveBps("0.0435", "0.0460")).toBe(574n);
    expect(rateMoveBps("0.0460", "0.0435")).toBe(543n);
    expect(RATE_JUMP_CONFIRM_BPS).toBe(500n);
  });

  it("converts paise to fils half up, sign kept", () => {
    // INR 1,000.00 × 0.0435 = AED 43.50.
    expect(inrToAedMinor(100000n, "0.04350000")).toBe(4350n);
    // 1 paisa × 0.0435 = 0.0435 fils → 0; 12 paise → 0.522 → 1.
    expect(inrToAedMinor(1n, "0.04350000")).toBe(0n);
    expect(inrToAedMinor(12n, "0.04350000")).toBe(1n);
    expect(inrToAedMinor(-100000n, "0.04350000")).toBe(-4350n);
    expect(() => inrToAedMinor(1n, "1.5")).toThrow(RangeError);
    expect(() => inrToAedMinor(1n, "0.07")).toThrow(RangeError);
  });

  it("reads a stored rate only when its source is CBUAE", () => {
    expect(cbuaeRateFrom("2026-11-28", { aedPerInr: "0.0435", source: "CBUAE" })).toEqual({ date: "2026-11-28", aedPerInr: "0.04350000", source: "CBUAE" });
    expect(cbuaeRateFrom("2026-11-28", { aedPerInr: "0.0435", source: "ECB" })).toBeNull();
    expect(cbuaeRateFrom("2026-11-28", null)).toBeNull();
  });
});
