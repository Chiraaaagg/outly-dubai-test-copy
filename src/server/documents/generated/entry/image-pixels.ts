import { inflateSync } from "node:zlib";
import { PDFArray, PDFBool, PDFDict, PDFName, PDFNumber, PDFRawStream, PDFRef, type PDFContext, type PDFObject } from "@cantoo/pdf-lib";

/**
 * Pixels of an image XObject, for VERIFICATION ONLY (doc 93 §2.2 method C is
 * rejected for the delivered file and used only to verify). Nothing decoded
 * here is ever written into a PDF: the branded file carries the original
 * stream bytes untouched.
 *
 * Supported: FlateDecode or unfiltered, 1 or 8 bits per component, DeviceGray,
 * DeviceRGB, ICCBased with 1 or 3 components, an `ImageMask` stencil, and a
 * `Decode` array that inverts. PNG predictors (DecodeParms Predictor ≥ 10)
 * are undone. Anything else (DCT/JPEG, JBIG2, CCITT, Indexed, CMYK, 16-bit)
 * answers `unsupported` with a reason, and the caller treats the image as
 * "no code found" (doc 93 §2.6): the operator's PDF stays the entry document.
 */

export interface Rgba {
  width: number;
  height: number;
  data: Uint8ClampedArray;
}

export type PixelResult = { ok: true; image: Rgba } | { ok: false; reason: string };

/**
 * Largest image decoded for verification: 4 million pixels (16 MB of RGBA).
 * A code image is far smaller; the cap bounds memory on hostile input (review finding 12).
 */
export const MAX_PIXELS = 4_000_000;

function lookup(ctx: PDFContext, o: PDFObject | undefined): PDFObject | undefined {
  return o instanceof PDFRef ? ctx.lookup(o) : o;
}

function num(ctx: PDFContext, d: PDFDict, key: string): number | null {
  const v = lookup(ctx, d.get(PDFName.of(key)));
  return v instanceof PDFNumber ? v.asNumber() : null;
}

function filters(ctx: PDFContext, d: PDFDict): string[] {
  const f = lookup(ctx, d.get(PDFName.of("Filter")));
  if (!f) return [];
  if (f instanceof PDFName) return [f.decodeText()];
  if (f instanceof PDFArray) {
    const out: string[] = [];
    for (let i = 0; i < f.size(); i++) {
      const x = lookup(ctx, f.get(i));
      if (x instanceof PDFName) out.push(x.decodeText());
    }
    return out;
  }
  return ["?"];
}

function components(ctx: PDFContext, cs: PDFObject | undefined): number | null {
  const c = lookup(ctx, cs);
  if (c instanceof PDFName) {
    const n = c.decodeText();
    return n === "DeviceGray" || n === "G" ? 1 : n === "DeviceRGB" || n === "RGB" ? 3 : null;
  }
  if (c instanceof PDFArray && c.size() >= 2) {
    const kind = lookup(ctx, c.get(0));
    if (kind instanceof PDFName && kind.decodeText() === "ICCBased") {
      const s = lookup(ctx, c.get(1));
      if (s instanceof PDFRawStream) {
        const n = num(ctx, s.dict, "N");
        return n === 1 || n === 3 ? n : null;
      }
    }
    if (kind instanceof PDFName && kind.decodeText() === "CalGray") return 1;
    if (kind instanceof PDFName && kind.decodeText() === "CalRGB") return 3;
  }
  return null;
}

/** Undo PNG row predictors (DecodeParms Predictor 10–15). */
function unpredict(data: Uint8Array, rowBytes: number, bpp: number, rows: number): Uint8Array | null {
  const out = new Uint8Array(rowBytes * rows);
  let prev = new Uint8Array(rowBytes);
  for (let r = 0; r < rows; r++) {
    const off = r * (rowBytes + 1);
    if (off + rowBytes + 1 > data.length) return null;
    const type = data[off];
    const row = data.subarray(off + 1, off + 1 + rowBytes);
    const cur = out.subarray(r * rowBytes, (r + 1) * rowBytes);
    for (let i = 0; i < rowBytes; i++) {
      const a = i >= bpp ? cur[i - bpp] : 0;
      const b = prev[i];
      const c = i >= bpp ? prev[i - bpp] : 0;
      let v = row[i];
      if (type === 1) v += a;
      else if (type === 2) v += b;
      else if (type === 3) v += (a + b) >> 1;
      else if (type === 4) {
        const p = a + b - c;
        const pa = Math.abs(p - a);
        const pb = Math.abs(p - b);
        const pc = Math.abs(p - c);
        v += pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
      } else if (type !== 0) return null;
      cur[i] = v & 0xff;
    }
    prev = cur;
  }
  return out;
}

export function imagePixels(ctx: PDFContext, stream: PDFRawStream): PixelResult {
  const d = stream.dict;
  const width = num(ctx, d, "Width");
  const height = num(ctx, d, "Height");
  if (!width || !height || width < 1 || height < 1 || width * height > MAX_PIXELS) return { ok: false, reason: "bad_size" };
  const f = filters(ctx, d);
  if (f.some((x) => x !== "FlateDecode" && x !== "Fl")) return { ok: false, reason: `filter_${f.join("_").toLowerCase().replace(/[^a-z0-9_]/g, "")}` };
  const mask = lookup(ctx, d.get(PDFName.of("ImageMask")));
  const isMask = mask instanceof PDFBool && mask.asBoolean();
  const bpc = isMask ? 1 : num(ctx, d, "BitsPerComponent");
  const comps = isMask ? 1 : components(ctx, d.get(PDFName.of("ColorSpace")));
  if (comps === null) return { ok: false, reason: "colour_space" };
  if (bpc !== 1 && bpc !== 8) return { ok: false, reason: "bits_per_component" };

  let raw: Uint8Array = stream.getContents();
  if (f.length) {
    try {
      raw = inflateSync(raw, { maxOutputLength: MAX_PIXELS * 4 });
    } catch {
      return { ok: false, reason: "inflate" };
    }
  }
  const rowBytes = Math.ceil((width * comps * bpc) / 8);
  const parms = lookup(ctx, d.get(PDFName.of("DecodeParms")));
  const predictor = parms instanceof PDFDict ? num(ctx, parms, "Predictor") : null;
  if (predictor && predictor >= 10) {
    const u = unpredict(raw, rowBytes, Math.max(1, Math.ceil((comps * bpc) / 8)), height);
    if (!u) return { ok: false, reason: "predictor" };
    raw = u;
  } else if (predictor && predictor !== 1) return { ok: false, reason: "predictor" };
  if (raw.length < rowBytes * height) return { ok: false, reason: "short_data" };

  // Decode array: [1 0] inverts (ImageMask default is [0 1]: 0 paints).
  const dec = lookup(ctx, d.get(PDFName.of("Decode")));
  let invert = false;
  if (dec instanceof PDFArray && dec.size() >= 2) {
    const d0 = lookup(ctx, dec.get(0));
    const d1 = lookup(ctx, dec.get(1));
    invert = d0 instanceof PDFNumber && d1 instanceof PDFNumber && d0.asNumber() > d1.asNumber();
  }

  const out = new Uint8ClampedArray(width * height * 4);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      let r: number, g: number, b: number;
      if (bpc === 1) {
        const bit = (raw[y * rowBytes + (x >> 3)] >> (7 - (x & 7))) & 1;
        // A stencil paints where the sample is 0 (black ink on white paper); a 1-bit gray image is 0 = black.
        let v = bit ? 255 : 0;
        if (invert) v = 255 - v;
        r = g = b = v;
      } else if (comps === 1) {
        let v = raw[y * rowBytes + x];
        if (invert) v = 255 - v;
        r = g = b = v;
      } else {
        const o = y * rowBytes + x * 3;
        r = raw[o];
        g = raw[o + 1];
        b = raw[o + 2];
        if (invert) {
          r = 255 - r;
          g = 255 - g;
          b = 255 - b;
        }
      }
      const p = (y * width + x) * 4;
      out[p] = r;
      out[p + 1] = g;
      out[p + 2] = b;
      out[p + 3] = 255;
    }
  }
  return { ok: true, image: { width, height, data: out } };
}

/**
 * The image on a white margin, scaled up by an integer factor (nearest
 * neighbour) so a code drawn at one pixel per module, with its quiet zone on
 * the page rather than in the image, is still readable by the decoder.
 */
export function padAndScale(img: Rgba, opts: { minSide?: number; marginFraction?: number } = {}): Rgba {
  const minSide = opts.minSide ?? 480;
  const margin = Math.max(4, Math.ceil(Math.max(img.width, img.height) * (opts.marginFraction ?? 0.15)));
  const factor = Math.max(1, Math.min(16, Math.ceil(minSide / Math.max(img.width, img.height))));
  const w = (img.width + 2 * margin) * factor;
  const h = (img.height + 2 * margin) * factor;
  if (w * h > MAX_PIXELS) return img;
  const out = new Uint8ClampedArray(w * h * 4).fill(255);
  for (let y = 0; y < img.height; y++) {
    for (let x = 0; x < img.width; x++) {
      const s = (y * img.width + x) * 4;
      for (let dy = 0; dy < factor; dy++) {
        const row = ((y + margin) * factor + dy) * w;
        for (let dx = 0; dx < factor; dx++) {
          const t = (row + (x + margin) * factor + dx) * 4;
          out[t] = img.data[s];
          out[t + 1] = img.data[s + 1];
          out[t + 2] = img.data[s + 2];
        }
      }
    }
  }
  return { width: w, height: h, data: out };
}
