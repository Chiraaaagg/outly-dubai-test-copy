import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { PDFDocument, StandardFonts, rgb } from "@cantoo/pdf-lib";

/**
 * SYNTHETIC "supplier" PDFs for tests and specimens only (doc 93 §6 stage 2):
 * a stand-in for an operator's tickets PDF, with one QR code per guest that
 * encodes a labelled synthetic value (`SPECIMEN-NOT-VALID-<n>`), so the
 * lossless code-area path is exercised without any real code. Every page says
 * "SYNTHETIC SUPPLIER PDF — SPECIMEN — not valid for entry". Never imported by
 * a route or job.
 *
 * The QR images come from the `zxing-wasm` writer, loaded from the installed
 * package (never fetched).
 */

type ZxingWriter = typeof import("zxing-wasm/writer");
let writer: Promise<ZxingWriter> | null = null;

async function loadWriter(): Promise<ZxingWriter> {
  writer ??= (async () => {
    const mod = (await import("zxing-wasm/writer")) as ZxingWriter;
    const require = createRequire(import.meta.url);
    const bin = readFileSync(require.resolve("zxing-wasm/writer/zxing_writer.wasm"));
    await mod.prepareZXingModule({ overrides: { wasmBinary: bin.buffer.slice(bin.byteOffset, bin.byteOffset + bin.byteLength) as ArrayBuffer }, fireImmediately: true });
    return mod;
  })();
  return writer;
}

/** PNG bytes of a QR code for `text`. */
export async function qrPng(text: string, opts: { scale?: number } = {}): Promise<Uint8Array> {
  const z = await loadWriter();
  const r = await z.writeBarcode(text, { format: "QRCode", scale: opts.scale ?? 4, addQuietZones: false });
  if (r.error || !r.image) throw new Error(`qrPng: ${r.error || "no image"}`);
  return new Uint8Array(await r.image.arrayBuffer());
}

export interface SyntheticSupplierOptions {
  /** Codes per page; one page per entry. [1,1,1,1] = four pages with one code each; [4] = four codes on one page. */
  layout: number[];
  /** Code side in points. */
  side?: number;
  /** Draw a decoy image (not a code) on every page. */
  decoy?: boolean;
  /** Value prefix; the default is clearly not a real code. */
  prefix?: string;
}

export const SYNTHETIC_BAND = "SYNTHETIC SUPPLIER PDF — SPECIMEN — not valid for entry";

export async function syntheticSupplierPdf(opts: SyntheticSupplierOptions): Promise<Uint8Array> {
  const doc = await PDFDocument.create({ updateMetadata: false });
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const bold = await doc.embedFont(StandardFonts.HelveticaBold);
  const fixed = new Date("2027-02-01T00:00:00Z");
  doc.setTitle("SPECIMEN synthetic supplier tickets");
  doc.setCreationDate(fixed);
  doc.setModificationDate(fixed);
  const side = opts.side ?? 120;
  let n = 0;
  for (const count of opts.layout) {
    const page = doc.addPage([595.28, 841.89]);
    page.drawText(SYNTHETIC_BAND, { x: 40, y: 800, size: 10, font: bold, color: rgb(0.7, 0.1, 0.1) });
    page.drawText("Specimen Operator LLC · Ticket voucher", { x: 40, y: 780, size: 12, font });
    if (opts.decoy) {
      // A wide flat image that is not a code (a logo stand-in).
      const png = await qrPng("decoy", { scale: 1 });
      const img = await doc.embedPng(png);
      page.drawRectangle({ x: 40, y: 700, width: 200, height: 30, color: rgb(0.85, 0.85, 0.9) });
      page.drawImage(img, { x: 450, y: 760, width: 10, height: 10 });
    }
    for (let i = 0; i < count; i++) {
      n++;
      const value = `${opts.prefix ?? "SPECIMEN-NOT-VALID"}-${n}`;
      const img = await doc.embedPng(await qrPng(value));
      const col = i % 2;
      const row = Math.floor(i / 2);
      const x = 60 + col * (side + 120);
      const y = 560 - row * (side + 110);
      page.drawImage(img, { x, y, width: side, height: side });
      page.drawText(`Ticket ${n} · Adult · SPECIMEN`, { x, y: y - 16, size: 9, font });
    }
  }
  return doc.save({ useObjectStreams: false });
}
