import type { PDFDocument } from "@cantoo/pdf-lib";
import { DecoderUnavailableError, type CodeDecoder, type DecodedCode } from "./code-decoder";
import { imagePixels, padAndScale } from "./image-pixels";
import { imageDraws, WalkBudget, type Box } from "./pdf-walk";

/**
 * Finds the codes on the pages of a PDF (doc 93 §2.2, two layers):
 *
 *  1. structural: every image the page paints and where (`pdf-walk.ts`);
 *  2. decode: the image's own pixels are read by the barcode decoder.
 *
 * A code is accepted only where the decoder reads exactly one code in an
 * image that is fully visible on the page. Images the decoder cannot read
 * (JPEG, JBIG2, vector-drawn or font-drawn codes) are reported as not
 * decodable and never accepted: the caller then treats the file as "no code
 * found" (doc 93 §2.6). Finding codes drawn as vector paths needs a page
 * renderer (`PageRenderer`), which needs a native canvas and is not built.
 *
 * Codes are returned in the order the supplier printed them: page, then top
 * to bottom, then left to right (doc 93 §2.3: guest pages are not re-sorted).
 *
 * A reader fault (`DecoderUnavailableError`: the WebAssembly reader missing or
 * failing) is NOT an undecodable image: it is thrown to the caller as a job
 * fault, so no permanent fallback is recorded for the file (review finding 13).
 * The walk and the decode share one budget and deadline (finding 12).
 */

export interface LocatedCode {
  pageIndex: number;
  /** Page-space bounds of the image that carries the code. */
  box: Box;
  /** sha256 of the image stream bytes as stored: equal in source and output proves a byte-for-byte copy. */
  rawSha256: string;
  format: string;
  /** Symbology family of `format`; every code of one file must share it (review finding 4). */
  symbology: string;
  /** Keyed hash of the decoded value (comparison key of the decoder instance). Never the value. */
  digest: string;
}

export interface LocateResult {
  codes: LocatedCode[];
  /** Images large enough to be a code that the decoder could not read, with a short reason. */
  undecodable: { pageIndex: number; reason: string }[];
  /** Decodable images only partly visible (clipped by a form): a page showing part of another code is refused. */
  partlyVisible: { pageIndex: number }[];
}

/** Images decoded per document at most (the budget's deadline also applies). */
export const MAX_DECODES_PER_DOCUMENT = 64;

/**
 * Future seam (not built): render a page region to pixels so vector or
 * font-drawn codes can be found and compared. Needs `pdfjs-dist` plus a canvas
 * (`@napi-rs/canvas`, a native module): per the Group C brief this stops at the
 * interface. With no renderer, such codes count as "no code found".
 */
export interface PageRenderer {
  renderRegion(pdf: Uint8Array, pageIndex: number, box: Box, dpi: number): Promise<{ width: number; height: number; data: Uint8ClampedArray }>;
}

/** Smallest side (points) an image must have to be considered a code: about 8.5 mm. */
export const MIN_CODE_SIDE_PT = 24;

const fully = (box: Box, visible: Box | null) => !!visible && Math.abs(visible.w - box.w) < 0.01 && Math.abs(visible.h - box.h) < 0.01;

export async function locateCodes(doc: PDFDocument, decoder: CodeDecoder, budget: WalkBudget = new WalkBudget()): Promise<LocateResult> {
  const draws = imageDraws(doc, budget);
  let decodes = 0;
  const codes: LocatedCode[] = [];
  const undecodable: LocateResult["undecodable"] = [];
  const partlyVisible: LocateResult["partlyVisible"] = [];
  const cache = new Map<string, DecodedCode[] | string>();
  for (const d of draws) {
    if (!d.visible) continue;
    if (Math.min(d.box.w, d.box.h) < MIN_CODE_SIDE_PT) continue;
    if (!d.stream || !d.rawSha256) {
      undecodable.push({ pageIndex: d.pageIndex, reason: "inline_image" });
      continue;
    }
    let found = cache.get(d.rawSha256);
    if (found === undefined) {
      budget.checkTime();
      if (++decodes > MAX_DECODES_PER_DOCUMENT) throw new Error("too_many_images");
      const px = imagePixels(doc.context, d.stream);
      if (!px.ok) found = px.reason;
      else {
        try {
          found = await decoder.decode(padAndScale(px.image));
        } catch (e) {
          // A reader fault is the job's problem, never this file's: it propagates.
          if (e instanceof DecoderUnavailableError) throw e;
          found = "decoder_error";
        }
      }
      cache.set(d.rawSha256, found);
    }
    if (typeof found === "string") {
      undecodable.push({ pageIndex: d.pageIndex, reason: found });
      continue;
    }
    if (found.length !== 1) {
      if (found.length > 1) undecodable.push({ pageIndex: d.pageIndex, reason: "several_codes_in_one_image" });
      continue;
    }
    if (!fully(d.box, d.visible)) {
      partlyVisible.push({ pageIndex: d.pageIndex });
      continue;
    }
    codes.push({ pageIndex: d.pageIndex, box: d.box, rawSha256: d.rawSha256, format: found[0].format, symbology: found[0].symbology, digest: found[0].digest });
  }
  codes.sort((a, b) => a.pageIndex - b.pageIndex || b.box.y + b.box.h - (a.box.y + a.box.h) || a.box.x - b.box.x);
  return { codes, undecodable, partlyVisible };
}
