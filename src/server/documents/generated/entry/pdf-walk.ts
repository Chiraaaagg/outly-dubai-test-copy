import { createHash } from "node:crypto";
import { constants as zlibConstants, inflateSync } from "node:zlib";
import { PDFArray, PDFDict, PDFDocument, PDFName, PDFNumber, PDFRawStream, PDFRef, PDFStream, type PDFObject, type PDFContext } from "@cantoo/pdf-lib";

/**
 * Structural walk of a PDF page (doc 93 §2.2 "structural locator"): every
 * image a page paints, where it lands on the page, and the image's stream
 * exactly as stored. No rendering, no native code.
 *
 * The walk reads the page's content streams, follows `q`/`Q`/`cm` for the
 * current transformation, and on `Do` resolves the XObject: an image is
 * recorded with its page-space box; a form is entered with its own `Matrix`,
 * `Resources` and `BBox` (the clip is kept as an axis-aligned box, which is
 * all the region embed produces). Inline images (`BI … ID … EI`) are skipped
 * over and recorded as not decodable.
 *
 * Hostile input (review finding 12): one budget is shared by the whole
 * document, not per stream: operators, form visits and inflated bytes are
 * counted across every page and every nesting level, and a wall-clock
 * deadline is checked in the loops. Content streams are inflated with Node's
 * zlib under an output cap (only FlateDecode or unfiltered content is
 * accepted), and each decoded stream is cached, so a form drawn many times is
 * inflated once. Any limit reached throws `WalkLimitError`; the caller then
 * makes no branded file (the operator's PDF stays the entry document).
 */

export type Matrix = [number, number, number, number, number, number];
export interface Box {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface ImageDraw {
  pageIndex: number;
  /** Where the image lands in page space (axis-aligned bounds). */
  box: Box;
  /** The part of `box` inside every enclosing form's BBox; null when the image is clipped away entirely. */
  visible: Box | null;
  /** The image XObject; null for an inline image. */
  stream: PDFRawStream | null;
  /** sha256 of the stream bytes exactly as stored (still encoded). The lossless check compares these. */
  rawSha256: string | null;
  /** Depth of form nesting the image was drawn from (0 = page content). */
  formDepth: number;
}

const IDENTITY: Matrix = [1, 0, 0, 1, 0, 0];
const MAX_DEPTH = 8;

/** Whole-document limits of one walk (review finding 12). Plain numbers, so a caller (a test) may pass other values. */
export interface WalkLimits {
  maxOps: number;
  maxFormVisits: number;
  maxInflatedBytes: number;
  maxMs: number;
}

export const WALK_LIMITS: Readonly<WalkLimits> = Object.freeze({
  /** Operators across every content stream and form visit of the document. */
  maxOps: 1_000_000,
  /** Form XObject entries across the document (a form drawn N times counts N). */
  maxFormVisits: 2_000,
  /** Bytes of content inflated across the document. */
  maxInflatedBytes: 32 * 1024 * 1024,
  /** Wall-clock time of one walk. */
  maxMs: 10_000,
});

export class WalkLimitError extends Error {
  constructor(readonly reason: "content_too_complex" | "too_many_forms" | "content_too_large" | "content_filter_unsupported" | "content_inflate" | "walk_timeout") {
    super(reason);
    this.name = "WalkLimitError";
  }
}

/** The shared budget of one document walk. */
export class WalkBudget {
  ops = 0;
  formVisits = 0;
  inflatedBytes = 0;
  readonly deadline: number;
  readonly decoded = new Map<PDFObject, Uint8Array>();
  constructor(readonly limits: Readonly<WalkLimits> = WALK_LIMITS, now: number = Date.now()) {
    this.deadline = now + limits.maxMs;
  }
  op(): void {
    if (++this.ops > this.limits.maxOps) throw new WalkLimitError("content_too_complex");
    if ((this.ops & 0xfff) === 0) this.checkTime();
  }
  form(): void {
    if (++this.formVisits > this.limits.maxFormVisits) throw new WalkLimitError("too_many_forms");
    this.checkTime();
  }
  checkTime(): void {
    if (Date.now() > this.deadline) throw new WalkLimitError("walk_timeout");
  }
  /** Room left for inflated bytes; throws when none is left. */
  room(): number {
    const left = this.limits.maxInflatedBytes - this.inflatedBytes;
    if (left <= 0) throw new WalkLimitError("content_too_large");
    return left;
  }
  spend(n: number): void {
    this.inflatedBytes += n;
    if (this.inflatedBytes > this.limits.maxInflatedBytes) throw new WalkLimitError("content_too_large");
  }
}

export function multiply(m: Matrix, n: Matrix): Matrix {
  // m then n: [a b c d e f] row-vector convention used by PDF.
  return [
    m[0] * n[0] + m[1] * n[2],
    m[0] * n[1] + m[1] * n[3],
    m[2] * n[0] + m[3] * n[2],
    m[2] * n[1] + m[3] * n[3],
    m[4] * n[0] + m[5] * n[2] + n[4],
    m[4] * n[1] + m[5] * n[3] + n[5],
  ];
}

function apply(m: Matrix, x: number, y: number): [number, number] {
  return [m[0] * x + m[2] * y + m[4], m[1] * x + m[3] * y + m[5]];
}

/** Axis-aligned bounds of a rectangle under a matrix. */
export function boundsOf(m: Matrix, x0: number, y0: number, x1: number, y1: number): Box {
  const pts = [apply(m, x0, y0), apply(m, x1, y0), apply(m, x0, y1), apply(m, x1, y1)];
  const xs = pts.map((p) => p[0]);
  const ys = pts.map((p) => p[1]);
  const x = Math.min(...xs);
  const y = Math.min(...ys);
  return { x, y, w: Math.max(...xs) - x, h: Math.max(...ys) - y };
}

export function intersect(a: Box | null, b: Box): Box | null {
  if (!a) return null;
  const x = Math.max(a.x, b.x);
  const y = Math.max(a.y, b.y);
  const r = Math.min(a.x + a.w, b.x + b.w);
  const t = Math.min(a.y + a.h, b.y + b.h);
  return r > x && t > y ? { x, y, w: r - x, h: t - y } : null;
}

/* ------------------------------------------------------------ tokeniser */

type Operand = number | string | { name: string } | Operand[] | null;

const WS = new Set([0x00, 0x09, 0x0a, 0x0c, 0x0d, 0x20]);
const DELIM = new Set([0x28, 0x29, 0x3c, 0x3e, 0x5b, 0x5d, 0x7b, 0x7d, 0x2f, 0x25]);

/** Calls `onOp(operator, operands)` for every operator in a content stream. */
export function tokenizeContent(bytes: Uint8Array, onOp: (op: string, args: Operand[]) => void, budget: WalkBudget = new WalkBudget()): void {
  let i = 0;
  const n = bytes.length;
  let args: Operand[] = [];
  const stack: Operand[][] = [];
  const push = (v: Operand) => (stack.length ? stack[stack.length - 1].push(v) : args.push(v));
  while (i < n) {
    const c = bytes[i];
    if (WS.has(c)) {
      i++;
      continue;
    }
    if (c === 0x25) {
      while (i < n && bytes[i] !== 0x0a && bytes[i] !== 0x0d) i++;
      continue;
    }
    if (c === 0x2f) {
      let j = i + 1;
      while (j < n && !WS.has(bytes[j]) && !DELIM.has(bytes[j])) j++;
      push({ name: Buffer.from(bytes.subarray(i + 1, j)).toString("latin1") });
      i = j;
      continue;
    }
    if (c === 0x28) {
      let depth = 1;
      let j = i + 1;
      while (j < n && depth > 0) {
        if (bytes[j] === 0x5c) j += 2;
        else {
          if (bytes[j] === 0x28) depth++;
          else if (bytes[j] === 0x29) depth--;
          j++;
        }
      }
      push("(str)");
      i = j;
      continue;
    }
    if (c === 0x3c && bytes[i + 1] === 0x3c) {
      // Inline dictionary (marked-content properties): skip to the matching >>.
      let depth = 1;
      let j = i + 2;
      while (j < n && depth > 0) {
        if (bytes[j] === 0x3c && bytes[j + 1] === 0x3c) {
          depth++;
          j += 2;
        } else if (bytes[j] === 0x3e && bytes[j + 1] === 0x3e) {
          depth--;
          j += 2;
        } else j++;
      }
      push(null);
      i = j;
      continue;
    }
    if (c === 0x3c) {
      const j = bytes.indexOf(0x3e, i + 1);
      push("(hex)");
      i = j < 0 ? n : j + 1;
      continue;
    }
    if (c === 0x5b) {
      stack.push([]);
      i++;
      continue;
    }
    if (c === 0x5d) {
      const arr = stack.pop() ?? [];
      push(arr);
      i++;
      continue;
    }
    let j = i;
    while (j < n && !WS.has(bytes[j]) && !DELIM.has(bytes[j])) j++;
    if (j === i) {
      i++;
      continue;
    }
    const tok = Buffer.from(bytes.subarray(i, j)).toString("latin1");
    i = j;
    const num = Number(tok);
    if (/^[+-]?(\d+\.?\d*|\.\d+)$/.test(tok) && Number.isFinite(num)) {
      push(num);
      continue;
    }
    budget.op();
    if (tok === "BI") {
      // Inline image: skip the dictionary and data up to a whitespace-delimited EI.
      const id = findSeq(bytes, i, "ID");
      let k = id < 0 ? n : id + 3;
      while (k < n) {
        if (bytes[k] === 0x45 && bytes[k + 1] === 0x49 && WS.has(bytes[k - 1]) && (k + 2 >= n || WS.has(bytes[k + 2]))) break;
        k++;
      }
      onOp("BI", []);
      i = k + 2;
      args = [];
      continue;
    }
    onOp(tok, args);
    args = [];
  }
}

function findSeq(bytes: Uint8Array, from: number, s: string): number {
  const a = s.charCodeAt(0);
  const b = s.charCodeAt(1);
  for (let k = from; k < bytes.length - 1; k++) if (bytes[k] === a && bytes[k + 1] === b && (k === 0 || WS.has(bytes[k - 1]))) return k;
  return -1;
}

/* ------------------------------------------------------------ walk */

function resolve(ctx: PDFContext, o: PDFObject | undefined): PDFObject | undefined {
  return o instanceof PDFRef ? ctx.lookup(o) : o;
}

function numbersOf(ctx: PDFContext, o: PDFObject | undefined): number[] | null {
  const a = resolve(ctx, o);
  if (!(a instanceof PDFArray)) return null;
  const out: number[] = [];
  for (let k = 0; k < a.size(); k++) {
    const v = resolve(ctx, a.get(k));
    if (!(v instanceof PDFNumber)) return null;
    out.push(v.asNumber());
  }
  return out;
}

function filterNames(ctx: PDFContext, dict: PDFDict): string[] | null {
  const f = resolve(ctx, dict.get(PDFName.of("Filter")));
  if (!f) return [];
  if (f instanceof PDFName) return [f.decodeText()];
  if (f instanceof PDFArray) {
    const out: string[] = [];
    for (let k = 0; k < f.size(); k++) {
      const x = resolve(ctx, f.get(k));
      if (!(x instanceof PDFName)) return null;
      out.push(x.decodeText());
    }
    return out;
  }
  return null;
}

/**
 * A content stream's bytes, decoded once per document under the shared cap.
 * Only unfiltered or a single FlateDecode with no predictor: anything else is
 * refused rather than handed to an uncapped decoder.
 */
function streamBytes(ctx: PDFContext, s: PDFObject | undefined, budget: WalkBudget): Uint8Array | null {
  if (!(s instanceof PDFRawStream) && !(s instanceof PDFStream)) return null;
  const cached = budget.decoded.get(s);
  if (cached) return cached;
  let out: Uint8Array;
  if (s instanceof PDFRawStream) {
    const filters = filterNames(ctx, s.dict);
    const parms = resolve(ctx, s.dict.get(PDFName.of("DecodeParms")));
    // DecodeParms as an array (one entry per filter) is allowed by the format; refused rather than misread (re-review N11).
    if (parms instanceof PDFArray) throw new WalkLimitError("content_filter_unsupported");
    const predictor = parms instanceof PDFDict ? resolve(ctx, parms.get(PDFName.of("Predictor"))) : undefined;
    if (!filters || filters.length > 1 || (filters.length === 1 && filters[0] !== "FlateDecode" && filters[0] !== "Fl")) throw new WalkLimitError("content_filter_unsupported");
    if (predictor instanceof PDFNumber && predictor.asNumber() > 1) throw new WalkLimitError("content_filter_unsupported");
    const raw = s.getContents();
    if (filters.length === 0) out = raw;
    else {
      try {
        out = inflateSync(raw, { maxOutputLength: budget.room(), finishFlush: zlibConstants.Z_SYNC_FLUSH });
      } catch (e) {
        if (e instanceof WalkLimitError) throw e;
        throw new WalkLimitError((e as { code?: string })?.code === "ERR_BUFFER_TOO_LARGE" ? "content_too_large" : "content_inflate");
      }
    }
  } else {
    out = s.getContents();
  }
  budget.spend(out.byteLength);
  budget.decoded.set(s, out);
  return out;
}

export function rawSha256(s: PDFRawStream): string {
  return createHash("sha256").update(s.getContents()).digest("hex");
}

function pageContents(ctx: PDFContext, contents: PDFObject | undefined, budget: WalkBudget): Uint8Array[] {
  const c = resolve(ctx, contents);
  if (c instanceof PDFArray) {
    const out: Uint8Array[] = [];
    for (let k = 0; k < c.size(); k++) {
      const b = streamBytes(ctx, resolve(ctx, c.get(k)), budget);
      if (b) out.push(b);
    }
    return out;
  }
  const b = streamBytes(ctx, c, budget);
  return b ? [b] : [];
}

function walkStream(ctx: PDFContext, bytesList: Uint8Array[], resources: PDFDict | undefined, base: Matrix, clip: Box | null, depth: number, pageIndex: number, out: ImageDraw[], budget: WalkBudget): void {
  let ctm: Matrix = base;
  const saved: Matrix[] = [];
  const xobjects = resources ? (resolve(ctx, resources.get(PDFName.of("XObject"))) as PDFDict | undefined) : undefined;
  const handle = (op: string, args: Operand[]) => {
    if (op === "q") saved.push(ctm);
    else if (op === "Q") ctm = saved.pop() ?? base;
    else if (op === "cm" && args.length === 6 && args.every((a) => typeof a === "number")) ctm = multiply(args as Matrix, ctm);
    else if (op === "BI") {
      const box = boundsOf(ctm, 0, 0, 1, 1);
      out.push({ pageIndex, box, visible: intersect(clip, box), stream: null, rawSha256: null, formDepth: depth });
    } else if (op === "Do" && args.length === 1 && args[0] && typeof args[0] === "object" && "name" in args[0]) {
      const name = (args[0] as { name: string }).name;
      const xo = xobjects instanceof PDFDict ? resolve(ctx, xobjects.get(PDFName.of(name))) : undefined;
      if (!(xo instanceof PDFRawStream) && !(xo instanceof PDFStream)) return;
      const subtype = (xo as PDFRawStream).dict.get(PDFName.of("Subtype"));
      if (subtype === PDFName.of("Image") && xo instanceof PDFRawStream) {
        const box = boundsOf(ctm, 0, 0, 1, 1);
        out.push({ pageIndex, box, visible: intersect(clip, box), stream: xo, rawSha256: rawSha256(xo), formDepth: depth });
      } else if (subtype === PDFName.of("Form") && depth < MAX_DEPTH) {
        budget.form();
        const dict = (xo as PDFRawStream).dict;
        const m = (numbersOf(ctx, dict.get(PDFName.of("Matrix"))) as Matrix | null) ?? IDENTITY;
        const formCtm = multiply(m, ctm);
        const bb = numbersOf(ctx, dict.get(PDFName.of("BBox")));
        const formClip = bb && bb.length === 4 ? intersect(clip, boundsOf(formCtm, bb[0], bb[1], bb[2], bb[3])) : clip;
        const res = (resolve(ctx, dict.get(PDFName.of("Resources"))) as PDFDict | undefined) ?? resources;
        const content = streamBytes(ctx, xo, budget);
        if (content) walkStream(ctx, [content], res instanceof PDFDict ? res : undefined, formCtm, formClip, depth + 1, pageIndex, out, budget);
      }
    }
  };
  for (const b of bytesList) tokenizeContent(b, handle, budget);
}

/** Every image each page paints, in content order (page by page), under one shared budget for the document. */
export function imageDraws(doc: PDFDocument, budget: WalkBudget = new WalkBudget()): ImageDraw[] {
  const out: ImageDraw[] = [];
  const ctx = doc.context;
  doc.getPages().forEach((page, pageIndex) => {
    budget.checkTime();
    const { Resources, Contents } = page.node.normalizedEntries();
    const mb = page.getMediaBox();
    const pageBox = { x: mb.x, y: mb.y, w: mb.width, h: mb.height };
    walkStream(ctx, pageContents(ctx, Contents, budget), Resources, IDENTITY, pageBox, 0, pageIndex, out, budget);
  });
  return out;
}
