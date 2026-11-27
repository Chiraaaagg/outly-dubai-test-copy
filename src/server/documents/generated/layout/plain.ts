import { PDFDocument, PDFFont, PDFPage, StandardFonts, rgb, degrees } from "@cantoo/pdf-lib";

/**
 * The deliberately plain structural layout for every OUTLYY-drawn PDF
 * (doc 93 §4; owner answer O2).
 *
 * The owner will send 21st.dev component links for the real look (O2): this
 * layout does NOT attempt a brand design. It draws the fields in a readable
 * order with the standard Helvetica faces, black on white, and marks every
 * page "SPECIMEN — layout pending owner design". It is isolated behind the
 * layout interfaces (`FiscalLayout`, `EntryLayout`) so the owner's design can
 * replace it without touching numbering, snapshots, VAT or the code-area
 * copy. The standard fonts need no font file; the brand fonts arrive with the
 * owner's design (doc 93 §4.2).
 *
 * Text is drawn in WinAnsi: a character outside it (Devanagari, Arabic, emoji)
 * is replaced by "?" and reported through `PlainWriter.replacedChars`, so the
 * caller can flag the document for staff instead of silently dropping it
 * (doc 93 §4.2).
 */

export const LAYOUT_PENDING_BAND = "SPECIMEN — layout pending owner design";

/** A4 portrait in points. */
export const A4 = { width: 595.28, height: 841.89 } as const;
export const MARGIN = 51; // 18 mm

const INK = rgb(0.078, 0.063, 0.122); // #14101F
const INK_600 = rgb(0.341, 0.29, 0.443); // #574A71
const RULE = rgb(0.8, 0.8, 0.8);
const DANGER = rgb(0.725, 0.11, 0.11); // #B91C1C

/** Characters WinAnsi can draw beyond printable ASCII (Latin-1 plus the cp1252 extras). */
const WIN_ANSI_EXTRA = new Set("€‚ƒ„…†‡ˆ‰Š‹ŒŽ‘’“”•–—˜™š›œžŸ");

export function toWinAnsi(text: string): { text: string; replaced: number } {
  let replaced = 0;
  let out = "";
  for (const ch of text.normalize("NFC")) {
    const c = ch.codePointAt(0)!;
    if (ch === "\n" || ch === "\t") out += " ";
    else if ((c >= 0x20 && c <= 0x7e) || (c >= 0xa0 && c <= 0xff) || WIN_ANSI_EXTRA.has(ch)) out += ch;
    else {
      out += "?";
      replaced++;
    }
  }
  return { text: out, replaced };
}

export interface PlainWriterOptions {
  title: string;
  /** Extra red bands on every page under the layout band, e.g. "TEST — not a tax invoice". */
  bands?: string[];
  /** Fixed for byte-stable output (doc 93 §2.2 "Deterministic output"). */
  date: Date;
  subject?: string;
  keywords?: string[];
}

/** A small cursor-based writer: one column, top to bottom, new page on overflow. */
export class PlainWriter {
  readonly doc: PDFDocument;
  private regular!: PDFFont;
  private bold!: PDFFont;
  page!: PDFPage;
  y = 0;
  replacedChars = 0;
  private readonly opts: PlainWriterOptions;

  private constructor(doc: PDFDocument, opts: PlainWriterOptions) {
    this.doc = doc;
    this.opts = opts;
  }

  static async create(opts: PlainWriterOptions): Promise<PlainWriter> {
    const doc = await PDFDocument.create({ updateMetadata: false });
    const w = new PlainWriter(doc, opts);
    w.regular = await doc.embedFont(StandardFonts.Helvetica);
    w.bold = await doc.embedFont(StandardFonts.HelveticaBold);
    doc.setTitle(toWinAnsi(opts.title).text, { showInWindowTitleBar: true });
    doc.setLanguage("en");
    doc.setProducer("OUTLYY documents (plain layout)");
    doc.setCreator("OUTLYY");
    if (opts.subject) doc.setSubject(toWinAnsi(opts.subject).text);
    if (opts.keywords?.length) doc.setKeywords(opts.keywords.map((k) => toWinAnsi(k).text));
    doc.setCreationDate(opts.date);
    doc.setModificationDate(opts.date);
    w.newPage();
    return w;
  }

  font(bold = false): PDFFont {
    return bold ? this.bold : this.regular;
  }

  private clean(text: string): string {
    const r = toWinAnsi(text);
    this.replacedChars += r.replaced;
    return r.text;
  }

  newPage(): PDFPage {
    this.page = this.doc.addPage([A4.width, A4.height]);
    this.y = A4.height - MARGIN;
    // Bands first: every page says what it is before anything else.
    this.band(LAYOUT_PENDING_BAND);
    for (const b of this.opts.bands ?? []) this.band(b);
    this.watermark(LAYOUT_PENDING_BAND);
    this.y -= 6;
    return this.page;
  }

  /** Space left above the bottom margin and the footer line. */
  get room(): number {
    return this.y - (MARGIN + 18);
  }

  ensure(height: number): void {
    if (this.room < height) this.newPage();
  }

  private band(text: string): void {
    const size = 9;
    const h = 16;
    this.page.drawRectangle({ x: MARGIN, y: this.y - h, width: A4.width - 2 * MARGIN, height: h, borderColor: DANGER, borderWidth: 1 });
    this.page.drawText(this.clean(text), { x: MARGIN + 6, y: this.y - h + 5, size, font: this.bold, color: DANGER });
    this.y -= h + 4;
  }

  private watermark(text: string): void {
    const size = 30;
    const t = this.clean(text);
    const w = this.regular.widthOfTextAtSize(t, size);
    const a = (35 * Math.PI) / 180;
    // Behind the content, low contrast, diagonal, centred; entry pages paint the code area pure white over it.
    this.page.drawText(t, { x: (A4.width - w * Math.cos(a)) / 2, y: (A4.height - w * Math.sin(a)) / 2, size, font: this.regular, color: rgb(0.93, 0.93, 0.93), rotate: degrees(35) });
  }

  heading(text: string, size = 16): void {
    this.ensure(size + 10);
    this.page.drawText(this.clean(text), { x: MARGIN, y: this.y - size, size, font: this.bold, color: INK });
    this.y -= size + 8;
  }

  /** A line of text, wrapped to the column. */
  text(text: string, opts: { size?: number; bold?: boolean; muted?: boolean; indent?: number } = {}): void {
    const size = opts.size ?? 10;
    const font = opts.bold ? this.bold : this.regular;
    const x = MARGIN + (opts.indent ?? 0);
    for (const line of this.wrap(this.clean(text), font, size, A4.width - MARGIN - x)) {
      this.ensure(size + 4);
      this.page.drawText(line, { x, y: this.y - size, size, font, color: opts.muted ? INK_600 : INK });
      this.y -= size + 4;
    }
  }

  /** "Label    value" pairs in two columns. */
  fields(rows: readonly (readonly [string, string])[], opts: { labelWidth?: number; size?: number } = {}): void {
    const size = opts.size ?? 10;
    const lw = opts.labelWidth ?? 140;
    for (const [label, value] of rows) {
      const lines = this.wrap(this.clean(value), this.regular, size, A4.width - 2 * MARGIN - lw);
      this.ensure((size + 4) * Math.max(1, lines.length));
      this.page.drawText(this.clean(label), { x: MARGIN, y: this.y - size, size, font: this.bold, color: INK_600 });
      for (const [i, line] of lines.entries()) {
        this.page.drawText(line, { x: MARGIN + lw, y: this.y - size - i * (size + 4), size, font: this.regular, color: INK });
      }
      this.y -= (size + 4) * Math.max(1, lines.length);
    }
  }

  rule(): void {
    this.ensure(8);
    this.page.drawLine({ start: { x: MARGIN, y: this.y - 3 }, end: { x: A4.width - MARGIN, y: this.y - 3 }, thickness: 0.75, color: RULE });
    this.y -= 8;
  }

  gap(h = 8): void {
    this.y -= h;
  }

  /** A simple table: header row in bold, right-aligned numeric columns. Widths are fractions of the column. */
  table(cols: readonly { label: string; width: number; align?: "left" | "right" }[], rows: readonly (readonly string[])[], size = 9): void {
    const total = A4.width - 2 * MARGIN;
    const xs: number[] = [];
    let acc = MARGIN;
    for (const c of cols) {
      xs.push(acc);
      acc += c.width * total;
    }
    const drawRow = (cells: readonly string[], bold: boolean) => {
      const wrapped = cells.map((cell, i) => this.wrap(this.clean(cell), bold ? this.bold : this.regular, size, cols[i].width * total - 6));
      const h = Math.max(...wrapped.map((w) => w.length)) * (size + 3) + 3;
      this.ensure(h);
      wrapped.forEach((lines, i) => {
        const font = bold ? this.bold : this.regular;
        lines.forEach((line, j) => {
          const w = font.widthOfTextAtSize(line, size);
          const x = cols[i].align === "right" ? xs[i] + cols[i].width * total - 4 - w : xs[i];
          this.page.drawText(line, { x, y: this.y - size - j * (size + 3), size, font, color: INK });
        });
      });
      this.y -= h;
    };
    drawRow(cols.map((c) => c.label), true);
    this.rule();
    for (const r of rows) drawRow(r, false);
    this.rule();
  }

  /** A bordered box with lines of text inside. */
  box(lines: readonly string[], opts: { bold?: boolean; size?: number } = {}): void {
    const size = opts.size ?? 10;
    const font = opts.bold ? this.bold : this.regular;
    const wrapped = lines.flatMap((l) => this.wrap(this.clean(l), font, size, A4.width - 2 * MARGIN - 16));
    const h = wrapped.length * (size + 4) + 12;
    this.ensure(h);
    this.page.drawRectangle({ x: MARGIN, y: this.y - h, width: A4.width - 2 * MARGIN, height: h, borderColor: INK, borderWidth: 1 });
    wrapped.forEach((line, i) => this.page.drawText(line, { x: MARGIN + 8, y: this.y - 8 - size - i * (size + 4), size, font, color: INK }));
    this.y -= h + 6;
  }

  /** Writes "Page n of m" and a footer line on every page. Call once, last. */
  finish(footer: string): void {
    const pages = this.doc.getPages();
    const f = this.clean(footer);
    pages.forEach((p, i) => {
      const label = `${f}   Page ${i + 1} of ${pages.length}`;
      p.drawText(label, { x: MARGIN, y: MARGIN - 14, size: 8, font: this.regular, color: INK_600 });
    });
  }

  async save(): Promise<Uint8Array> {
    // No object streams: every dictionary stays visible to the strict validator (src/server/documents/pdf.ts).
    return this.doc.save({ useObjectStreams: false, addDefaultPage: false, updateFieldAppearances: false });
  }

  private wrap(text: string, font: PDFFont, size: number, width: number): string[] {
    if (!text) return [""];
    const words = text.split(/ +/);
    const lines: string[] = [];
    let line = "";
    for (const word of words) {
      const next = line ? `${line} ${word}` : word;
      if (font.widthOfTextAtSize(next, size) <= width) {
        line = next;
        continue;
      }
      if (line) lines.push(line);
      // A single word longer than the column is cut, never overflowed.
      let w = word;
      while (font.widthOfTextAtSize(w, size) > width && w.length > 1) {
        let cut = w.length - 1;
        while (cut > 1 && font.widthOfTextAtSize(w.slice(0, cut), size) > width) cut--;
        lines.push(w.slice(0, cut));
        w = w.slice(cut);
      }
      line = w;
    }
    if (line) lines.push(line);
    return lines;
  }
}
