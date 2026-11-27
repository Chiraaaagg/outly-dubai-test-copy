import type { PDFDocument } from "@cantoo/pdf-lib";
import type { CodeDecoder } from "./code-decoder";
import { imagePixels, padAndScale } from "./image-pixels";
import { imageDraws, type Box } from "./pdf-walk";

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
 */

export interface LocatedCode {
  pageIndex: number;
  /** Page-space bounds of the image that carries the code. */
  box: Box;
  /** sha256 of the image stream bytes as stored: equal in source and output proves a byte-for-byte copy. */
  rawSha256: string;
  format: string;
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

export async function locateCodes(doc: PDFDocument, decoder: CodeDecoder): Promise<LocateResult> {
  const draws = imageDraws(doc);
  const codes: LocatedCode[] = [];
  const undecodable: LocateResult["undecodable"] = [];
  const partlyVisible: LocateResult["partlyVisible"] = [];
  const cache = new Map<string, { format: string; digest: string }[] | string>();
  for (const d of draws) {
    if (!d.visible) continue;
    if (Math.min(d.box.w, d.box.h) < MIN_CODE_SIDE_PT) continue;
    if (!d.stream || !d.rawSha256) {
      undecodable.push({ pageIndex: d.pageIndex, reason: "inline_image" });
      continue;
    }
    let found = cache.get(d.rawSha256);
    if (found === undefined) {
      const px = imagePixels(doc.context, d.stream);
      if (!px.ok) found = px.reason;
      else {
        try {
          found = await decoder.decode(padAndScale(px.image));
        } catch {
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
    codes.push({ pageIndex: d.pageIndex, box: d.box, rawSha256: d.rawSha256, format: found[0].format, digest: found[0].digest });
  }
  codes.sort((a, b) => a.pageIndex - b.pageIndex || b.box.y + b.box.h - (a.box.y + a.box.h) || a.box.x - b.box.x);
  return { codes, undecodable, partlyVisible };
}
