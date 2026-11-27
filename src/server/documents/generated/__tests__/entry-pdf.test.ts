import { describe, expect, it } from "vitest";
import { PDFDocument, rgb } from "@cantoo/pdf-lib";
import { validatePdf } from "../../pdf";
import { createZxingDecoder } from "../entry/code-decoder";
import { locateCodes } from "../entry/code-locator";
import { buildEntryPdf, generateEntryDocument, verifyEntryPdf, type EntryView } from "../entry/entry-pdf";
import { imageDraws, multiply, boundsOf } from "../entry/pdf-walk";
import { LAYOUT_PENDING_BAND } from "../layout/plain";
import { qrPng, syntheticSupplierPdf } from "../specimen/synthetic-supplier";
import { pdfText } from "./pdf-text";

/**
 * Group C branded entry PDF (doc 93 §2; answer 15; O11 one page per guest;
 * O12 tickets first). Only SYNTHETIC supplier PDFs built here, with QR codes
 * that encode `SPECIMEN-NOT-VALID-<n>`: no real or TEST supplier file exists
 * in this repository, and none is fetched.
 */

const MAX = 10 * 1024 * 1024;
const DATE = new Date("2027-02-14T00:00:00Z");
const view: EntryView = {
  kind: "tickets",
  activity: "Specimen Monorail Ticket",
  variant: null,
  dateLabel: "Sat, 21 Feb 2027",
  timeLabel: "Any time on the day, within opening hours",
  guestsLabel: "2 adults, 2 children",
  leadGuest: "Asha Specimen",
  bookingReference: "OUT-000000",
  operatorReference: "000000",
  validity: "Valid until 30 Jun 2027",
  where: null,
  goodToKnow: [],
  nonRefundable: true,
  support: "support@example.com",
  sourceLine: "version 1 · fingerprint aaaaaaaa…bbbbbbbb",
};

async function sourceCodes(bytes: Uint8Array, decoder = createZxingDecoder()) {
  return { decoder, located: await locateCodes(await PDFDocument.load(bytes), decoder) };
}

describe("branded entry PDF (switch-off backbone, synthetic sources only)", () => {
  it("matrix maths: cm then form matrix, bounds of the unit square", () => {
    const m = multiply([2, 0, 0, 2, 0, 0], [1, 0, 0, 1, 10, 20]);
    expect(m).toEqual([2, 0, 0, 2, 10, 20]);
    expect(boundsOf([100, 0, 0, 50, 30, 40], 0, 0, 1, 1)).toEqual({ x: 30, y: 40, w: 100, h: 50 });
  });

  it("finds one code per synthetic guest page and ignores a decoy image", async () => {
    const src = await syntheticSupplierPdf({ layout: [1, 1, 1, 1], decoy: true });
    const { located } = await sourceCodes(src);
    expect(located.codes).toHaveLength(4);
    expect(located.codes.map((c) => c.pageIndex)).toEqual([0, 1, 2, 3]);
    expect(new Set(located.codes.map((c) => c.digest)).size).toBe(4);
    expect(located.codes.every((c) => c.format === "QRCode")).toBe(true);
    // The digest is a keyed hash, never the value.
    expect(JSON.stringify(located)).not.toContain("SPECIMEN-NOT-VALID");
  }, 60_000);

  it("four guests: a summary page then one page per guest, codes copied byte for byte at scale 1.0, verified", async () => {
    const src = await syntheticSupplierPdf({ layout: [1, 1, 1, 1], decoy: true });
    const decoder = createZxingDecoder();
    const out = await generateEntryDocument(src, view, decoder, { date: DATE, expectedUnits: 4, maxBytes: MAX });
    expect(out.kind).toBe("entry_pdf");
    if (out.kind !== "entry_pdf") return;
    expect(out.codes).toBe(4);
    expect(validatePdf(out.bytes, { maxBytes: MAX }).ok).toBe(true);
    const pages = await pdfText(out.bytes);
    expect(pages).toHaveLength(5);
    expect(pages[0]).toContain("Your tickets · 4");
    for (let i = 1; i <= 4; i++) {
      expect(pages[i]).toContain(`Ticket ${i} of 4`);
      expect(pages[i]).toContain(LAYOUT_PENDING_BAND);
    }
    // Image streams in the output are the supplier's exact bytes; nothing was re-encoded.
    const srcDraws = imageDraws(await PDFDocument.load(src)).filter((d) => d.box.w >= 24);
    const outDraws = imageDraws(await PDFDocument.load(out.bytes)).filter((d) => d.visible && d.box.w >= 24);
    expect(outDraws.map((d) => d.rawSha256)).toEqual(srcDraws.map((d) => d.rawSha256));
    expect(outDraws.map((d) => Math.round(d.box.w))).toEqual(srcDraws.map((d) => Math.round(d.box.w)));
    // Byte-stable: the same input gives the same file.
    const again = await generateEntryDocument(src, view, createZxingDecoder(), { date: DATE, expectedUnits: 4, maxBytes: MAX });
    expect(again.kind === "entry_pdf" && Buffer.compare(Buffer.from(again.bytes), Buffer.from(out.bytes))).toBe(0);
  }, 120_000);

  it("several codes on one supplier page still give one guest page each, with no neighbour visible", async () => {
    const src = await syntheticSupplierPdf({ layout: [3, 2] });
    const out = await generateEntryDocument(src, { ...view, guestsLabel: "5 adults" }, createZxingDecoder(), { date: DATE, expectedUnits: 5, maxBytes: MAX });
    expect(out.kind).toBe("entry_pdf");
    if (out.kind === "entry_pdf") expect(await pdfText(out.bytes)).toHaveLength(6);
  }, 120_000);

  it("one guest: one page, no summary", async () => {
    const src = await syntheticSupplierPdf({ layout: [1] });
    const out = await generateEntryDocument(src, view, createZxingDecoder(), { date: DATE, expectedUnits: 1, maxBytes: MAX });
    expect(out.kind).toBe("entry_pdf");
    if (out.kind === "entry_pdf") {
      const pages = await pdfText(out.bytes);
      expect(pages).toHaveLength(1);
      expect(pages[0]).toContain("Ticket 1 of 1");
    }
  }, 60_000);

  it("no code found: the cover page only, which says the operator's PDF is the entry document", async () => {
    const doc = await PDFDocument.create();
    doc.addPage().drawText("SYNTHETIC supplier voucher without any code");
    const src = await doc.save({ useObjectStreams: false });
    const out = await generateEntryDocument(src, { ...view, kind: "voucher" }, createZxingDecoder(), { date: DATE, expectedUnits: null, maxBytes: MAX });
    expect(out.kind).toBe("cover_page");
    if (out.kind === "cover_page") {
      expect(out.reason).toBe("no_code_found");
      expect((await pdfText(out.bytes))[0]).toContain("Your entry document is the operator's PDF.");
    }
  }, 60_000);

  it("a code drawn as vector paths is not found (no renderer): cover page, never a guess", async () => {
    const doc = await PDFDocument.create();
    const page = doc.addPage();
    // A QR-like pattern drawn with rectangles: only a page renderer could read it, and none is built.
    for (let y = 0; y < 21; y++) for (let x = 0; x < 21; x++) if ((x * 7 + y * 3) % 5 < 2 || (x < 7 && y < 7)) page.drawRectangle({ x: 100 + x * 4, y: 400 + y * 4, width: 4, height: 4, color: rgb(0, 0, 0) });
    const out = await generateEntryDocument(await doc.save({ useObjectStreams: false }), view, createZxingDecoder(), { date: DATE, expectedUnits: 1, maxBytes: MAX });
    expect(out.kind).toBe("cover_page");
  }, 60_000);

  it("falls back to the operator's PDF alone when the code count differs from the units issued, or a code repeats", async () => {
    const src = await syntheticSupplierPdf({ layout: [1, 1] });
    expect(await generateEntryDocument(src, view, createZxingDecoder(), { date: DATE, expectedUnits: 3, maxBytes: MAX })).toEqual({ kind: "none", reason: "code_count_mismatch" });
    const dup = await syntheticSupplierPdf({ layout: [1, 1], prefix: "SPECIMEN-SAME" });
    // Same prefix still numbers the codes; build a real duplicate by drawing one image twice.
    const doc = await PDFDocument.load(dup);
    const img = await doc.embedPng(await qrPng("SPECIMEN-DUPLICATE"));
    doc.getPages()[0].drawImage(img, { x: 300, y: 200, width: 120, height: 120 });
    doc.getPages()[1].drawImage(img, { x: 300, y: 200, width: 120, height: 120 });
    const twice = await doc.save({ useObjectStreams: false });
    expect(await generateEntryDocument(twice, view, createZxingDecoder(), { date: DATE, expectedUnits: 4, maxBytes: MAX })).toEqual({ kind: "none", reason: "duplicate_code" });
  }, 120_000);

  it("verification refuses an output whose code was swapped, and a source that is not a PDF", async () => {
    const src = await syntheticSupplierPdf({ layout: [1] });
    const other = await syntheticSupplierPdf({ layout: [1], prefix: "SPECIMEN-OTHER" });
    const { decoder, located } = await sourceCodes(src);
    // Build the branded file from the OTHER source but verify it against the first one's codes.
    const otherDoc = await PDFDocument.load(other);
    const otherCodes = (await locateCodes(otherDoc, decoder)).codes;
    const built = await buildEntryPdf(otherDoc, otherCodes, view, { date: DATE });
    expect(built.ok).toBe(true);
    if (built.ok) {
      const v = await verifyEntryPdf(located.codes, built.bytes, decoder, { maxBytes: MAX });
      expect(v.ok).toBe(false);
      expect(["code_bytes_changed", "decoded_value_changed"]).toContain((v as { reason: string }).reason);
    }
    expect(await generateEntryDocument(new TextEncoder().encode("<html>not a pdf</html>"), view, createZxingDecoder(), { date: DATE, expectedUnits: 1, maxBytes: MAX })).toEqual({ kind: "none", reason: "source_unreadable" });
  }, 120_000);

  it("never scales a code area down: one too wide for the page is refused", async () => {
    const doc = await PDFDocument.create();
    const page = doc.addPage([1200, 1200]);
    page.drawImage(await doc.embedPng(await qrPng("SPECIMEN-HUGE", { scale: 8 })), { x: 50, y: 50, width: 600, height: 600 });
    const out = await generateEntryDocument(await doc.save({ useObjectStreams: false }), view, createZxingDecoder(), { date: DATE, expectedUnits: 1, maxBytes: MAX });
    expect(out).toEqual({ kind: "none", reason: "code_area_too_large" });
  }, 60_000);
});
