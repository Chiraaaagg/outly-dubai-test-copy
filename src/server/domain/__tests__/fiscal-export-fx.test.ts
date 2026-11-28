import { describe, expect, it } from "vitest";
import { csvText, dubaiPeriodOf, exportCsv, periodBounds, periodLabel, plainAmount, previousPeriod, EXPORT_COLUMNS } from "../fiscal-export-csv";
import { cbuaeRateFrom, inrToAedMinor, parseAedPerInr } from "../fiscal-fx";

/**
 * Group C pre-launch round 2: the accountant's monthly CSV (owner decision
 * C-P4) and the INR → AED conversion at the CBUAE rate (C-P1). Pure; synthetic
 * values only.
 */
describe("monthly accountant CSV (C-P4)", () => {
  it("one row per line, credit notes negative, buyer blank when erased, RFC 4180 quoting and a formula guard", () => {
    const { csv, lineCount } = exportCsv([
      {
        displayNumber: "TEST-INV-000001",
        docType: "tax_invoice",
        issueReason: "money",
        issueDate: "2026-11-28",
        supplyDate: "2026-11-28",
        orderReference: "OUT-000001",
        buyerName: 'Asha "A" Specimen, Jr',
        lines: [
          { description: "Specimen Desert Safari", variant: "Standard", vatCategory: "standard", netMinor: "38095", vatMinor: "1905", grossMinor: "40000" },
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
        buyerName: null,
        lines: [{ description: "=HYPERLINK(1)", variant: null, vatCategory: "exempt", netMinor: "2000", vatMinor: "0", grossMinor: "2000" }],
      },
    ]);
    expect(lineCount).toBe(3);
    const rows = csv.split("\r\n");
    expect(rows[0]).toBe(EXPORT_COLUMNS.join(","));
    expect(rows[1]).toBe('TEST-INV-000001,Tax invoice (simplified),2026-11-28,2026-11-28,OUT-000001,"Asha ""A"" Specimen, Jr",Specimen Desert Safari · Standard,standard,380.95,19.05,400.00,AED');
    expect(rows[2]).toContain(",-38.10,-1.90,-40.00,AED");
    expect(rows[3]).toBe("TEST-CN-000001,Tax credit note,2026-11-29,2026-11-29,OUT-000001,,'=HYPERLINK(1),exempt,-20.00,0.00,-20.00,AED");
    expect(rows[4]).toBe("");
    expect(exportCsv([]).csv).toBe(`${EXPORT_COLUMNS.join(",")}\r\n`);
  });

  it("labels the reissue documents, formats amounts plainly, guards text", () => {
    const csv = exportCsv([
      { displayNumber: "INV-000002", docType: "tax_invoice", issueReason: "reissue_full", issueDate: "2026-12-01", supplyDate: "2026-11-28", orderReference: "OUT-1", buyerName: "Specimen Trading LLC", lines: [{ description: "X", variant: null, vatCategory: "standard", netMinor: "100", vatMinor: "5", grossMinor: "105" }] },
      { displayNumber: "CN-000002", docType: "tax_credit_note", issueReason: "reissue_cancel", issueDate: "2026-12-01", supplyDate: "2026-12-01", orderReference: "OUT-1", buyerName: null, lines: [{ description: "X", variant: null, vatCategory: "standard", netMinor: "100", vatMinor: "5", grossMinor: "105" }] },
    ]).csv;
    expect(csv).toContain("INV-000002,Full tax invoice,");
    expect(csv).toContain("CN-000002,Tax credit note (reissue),");
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
    for (const bad of ["", "0.4350", "0.004", "23.0", "0.04350000001", "abc", null, undefined]) expect(parseAedPerInr(bad), String(bad)).toBeNull();
  });

  it("converts paise to fils half up, sign kept", () => {
    // INR 1,000.00 × 0.0435 = AED 43.50.
    expect(inrToAedMinor(100000n, "0.04350000")).toBe(4350n);
    // 1 paisa × 0.0435 = 0.0435 fils → 0; 12 paise → 0.522 → 1.
    expect(inrToAedMinor(1n, "0.04350000")).toBe(0n);
    expect(inrToAedMinor(12n, "0.04350000")).toBe(1n);
    expect(inrToAedMinor(-100000n, "0.04350000")).toBe(-4350n);
    expect(() => inrToAedMinor(1n, "1.5")).toThrow(RangeError);
  });

  it("reads a stored rate only when its source is CBUAE", () => {
    expect(cbuaeRateFrom("2026-11-28", { aedPerInr: "0.0435", source: "CBUAE" })).toEqual({ date: "2026-11-28", aedPerInr: "0.04350000", source: "CBUAE" });
    expect(cbuaeRateFrom("2026-11-28", { aedPerInr: "0.0435", source: "ECB" })).toBeNull();
    expect(cbuaeRateFrom("2026-11-28", null)).toBeNull();
  });
});
