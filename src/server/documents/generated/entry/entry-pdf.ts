import { PDFDocument, rgb } from "@cantoo/pdf-lib";
import { validatePdf } from "../../pdf";
import { A4, MARGIN, PlainWriter } from "../layout/plain";
import type { CodeDecoder } from "./code-decoder";
import { locateCodes, type LocatedCode } from "./code-locator";
import { intersect, type Box } from "./pdf-walk";

/**
 * The OUTLYY-branded entry PDF (doc 93 §2; answer 15; owner answers O11,
 * O12): OUTLYY draws everything on the page except the code. The code area is
 * the supplier's own page region, embedded as a PDF Form XObject clipped to
 * the code and its quiet zone, and drawn at scale 1.0. The image stream (or
 * vector paths, or glyphs) inside it is copied byte for byte; nothing is
 * decoded, redrawn or resampled. One page per guest (O11), in the order the
 * supplier printed the codes; a summary page first when there are several.
 *
 * Every result is verified before it is accepted (`verifyEntryPdf`): the
 * output passes the strict PDF validator, shows exactly one fully visible code
 * per guest page, and each code's image bytes and decoded value equal the
 * supplier's. Any doubt means no branded file: the operator's PDF stays the
 * entry document (doc 93 §2.6).
 *
 * The page layout is the plain structural layout (O2: the owner's 21st.dev
 * design replaces `EntryLayout` later without touching the code-area copy).
 */

export interface EntryView {
  /** "tickets" | "voucher": the wording of the instructions. */
  kind: "tickets" | "voucher";
  activity: string;
  variant: string | null;
  dateLabel: string;
  timeLabel: string;
  guestsLabel: string;
  leadGuest: string | null;
  bookingReference: string;
  operatorReference: string | null;
  validity: string | null;
  where: string | null;
  goodToKnow: string[];
  nonRefundable: boolean;
  support: string;
  /** "version 1 · fingerprint 3f9a1c2b…0c21b9d4" (doc 93 §2.5). */
  sourceLine: string;
  /** Extra red bands on every page (specimens: "SPECIMEN — not valid for entry"). */
  bands?: string[];
}

export interface EntryLayout {
  templateVersion: number;
}

export const plainEntryLayout: EntryLayout = { templateVersion: 1 };

/** Clear space kept around the supplier's own quiet zone, in points (12 mm, doc 93 §5.4). */
export const CODE_CLEAR_PT = 34;
/** Quiet zone taken from the supplier page around the code image: a fraction of its side, at least 8 pt. */
function quietZone(box: Box): number {
  return Math.max(8, Math.ceil(Math.max(box.w, box.h) * 0.12));
}

function howTo(view: EntryView, guestPages: number): string[] {
  if (view.kind === "tickets") {
    return [
      guestPages > 1 ? `Each guest has one page with one code: pages 2 to ${guestPages + 1}.` : "Your code is on this page.",
      "Show the code on your phone or printed. Each code is scanned once.",
      ...(view.validity ? [view.validity] : []),
      "Carry photo ID.",
    ];
  }
  return ["Show this voucher at the meeting point or to the driver.", "Arrive 15 minutes early.", "Carry photo ID."];
}

function details(w: PlainWriter, view: EntryView): void {
  w.heading(view.activity, 16);
  if (view.variant) w.text(view.variant, { muted: true });
  w.text(`${view.dateLabel} · ${view.timeLabel}`);
  w.gap(4);
  const rows: [string, string][] = [["Guests", view.guestsLabel]];
  if (view.leadGuest) rows.push(["Lead guest", view.leadGuest]);
  rows.push(["Booking", view.bookingReference]);
  if (view.operatorReference) rows.push(["Operator booking no.", view.operatorReference]);
  if (view.where) rows.push(["Where", view.where]);
  w.fields(rows);
}

function footerLine(view: EntryView): string {
  return `Help: ${view.support} · Made from the operator's document, ${view.sourceLine}`;
}

async function writer(view: EntryView, title: string, date: Date): Promise<PlainWriter> {
  return PlainWriter.create({ title, bands: view.bands, date, subject: `Entry document ${view.bookingReference}`, keywords: ["OUTLYY", view.bookingReference] });
}

/** The cover page alone: the fallback when no code was found (doc 93 §2.6, §5.5). */
export async function buildCoverPage(view: EntryView, opts: { date: Date }): Promise<Uint8Array> {
  const w = await writer(view, `OUTLYY ${view.kind} ${view.bookingReference}`, opts.date);
  details(w, view);
  w.rule();
  w.text("HOW TO USE", { bold: true, size: 9, muted: true });
  howTo(view, 0).forEach((l, i) => w.text(`${i + 1}. ${l}`));
  if (view.goodToKnow.length) {
    w.gap(4);
    w.text("GOOD TO KNOW", { bold: true, size: 9, muted: true });
    view.goodToKnow.slice(0, 4).forEach((l) => w.text(l));
  }
  if (view.nonRefundable) w.text("Non-refundable once issued.", { bold: true });
  w.gap(6);
  w.box(["Your entry document is the operator's PDF.", "Download it from your booking page and show it at the entrance."], { bold: true });
  w.finish(footerLine(view));
  return w.save();
}

export type BuildResult = { ok: true; bytes: Uint8Array } | { ok: false; reason: string };

/** Draws the summary page (several guests) and one guest page per code. Does not verify. */
export async function buildEntryPdf(source: PDFDocument, codes: readonly LocatedCode[], view: EntryView, opts: { date: Date }): Promise<BuildResult> {
  if (!codes.length) return { ok: false, reason: "no_code_found" };
  const total = codes.length;
  const w = await writer(view, `OUTLYY ${view.kind} ${view.bookingReference}`, opts.date);
  if (total > 1) {
    w.heading(`Your ${view.kind} · ${total}`, 12);
    details(w, view);
    w.rule();
    w.text("HOW TO USE", { bold: true, size: 9, muted: true });
    howTo(view, total).forEach((l, i) => w.text(`${i + 1}. ${l}`));
    if (view.goodToKnow.length) {
      w.gap(4);
      w.text("GOOD TO KNOW", { bold: true, size: 9, muted: true });
      view.goodToKnow.slice(0, 4).forEach((l) => w.text(l));
    }
  }
  const srcPages = source.getPages();
  for (const [i, code] of codes.entries()) {
    if (total > 1 || i > 0) w.newPage();
    w.heading(`${view.kind === "tickets" ? "Ticket" : "Voucher"} ${i + 1} of ${total}`, 12);
    details(w, view);
    if (view.validity) w.text(view.validity, { size: 9 });

    const page = srcPages[code.pageIndex];
    const mb = page.getMediaBox();
    const q = quietZone(code.box);
    const region = intersect({ x: code.box.x - q, y: code.box.y - q, w: code.box.w + 2 * q, h: code.box.h + 2 * q }, { x: mb.x, y: mb.y, w: mb.width, h: mb.height });
    if (!region) return { ok: false, reason: "code_outside_page" };
    const need = region.h + 2 * CODE_CLEAR_PT + 40;
    if (region.w + 2 * CODE_CLEAR_PT > A4.width - 2 * MARGIN) return { ok: false, reason: "code_area_too_large" };
    if (w.room < need) {
      // Never scaled down: a code area that does not fit below the details gets the next page to itself.
      w.newPage();
      w.heading(`${view.kind === "tickets" ? "Ticket" : "Voucher"} ${i + 1} of ${total} (continued)`, 12);
      if (w.room < need) return { ok: false, reason: "code_area_too_large" };
    }
    const embedded = await w.doc.embedPage(page, { left: region.x, bottom: region.y, right: region.x + region.w, top: region.y + region.h });
    const x = (A4.width - region.w) / 2;
    const y = w.y - CODE_CLEAR_PT - region.h;
    // Pure white under the clear space and the code area: nothing of ours (watermark, tint) shows through.
    w.page.drawRectangle({ x: x - CODE_CLEAR_PT, y: y - CODE_CLEAR_PT, width: region.w + 2 * CODE_CLEAR_PT, height: region.h + 2 * CODE_CLEAR_PT, color: rgb(1, 1, 1) });
    // Scale 1.0: no width or height given, so the region is drawn at its own size.
    w.page.drawPage(embedded, { x, y });
    w.y = y - CODE_CLEAR_PT;
    w.text(view.kind === "tickets" ? "Show this code at the entrance. One scan per guest." : "Show this code to the operator.", { size: 9 });
    if (view.nonRefundable) w.text("Non-refundable once issued.", { size: 9, bold: true });
  }
  w.finish(footerLine(view));
  return { ok: true, bytes: await w.save() };
}

export type VerifyResult = { ok: true } | { ok: false; reason: string };

/**
 * The output must carry the source's codes, unchanged, one per guest page
 * (doc 93 §2.2 "Verification"). Uses the same decoder instance as the source
 * locate, so the keyed digests are comparable.
 */
export async function verifyEntryPdf(sourceCodes: readonly LocatedCode[], output: Uint8Array, decoder: CodeDecoder, opts: { maxBytes: number }): Promise<VerifyResult> {
  const verdict = validatePdf(output, { maxBytes: opts.maxBytes });
  if (!verdict.ok) return { ok: false, reason: `validator_${verdict.reason}` };
  const doc = await PDFDocument.load(output, { updateMetadata: false });
  const found = await locateCodes(doc, decoder);
  if (found.partlyVisible.length) return { ok: false, reason: "neighbour_code_visible" };
  if (found.codes.length !== sourceCodes.length) return { ok: false, reason: "code_count_changed" };
  const perPage = new Map<number, number>();
  for (const c of found.codes) perPage.set(c.pageIndex, (perPage.get(c.pageIndex) ?? 0) + 1);
  if ([...perPage.values()].some((n) => n !== 1)) return { ok: false, reason: "not_one_code_per_page" };
  for (const [i, c] of found.codes.entries()) {
    const s = sourceCodes[i];
    if (c.rawSha256 !== s.rawSha256) return { ok: false, reason: "code_bytes_changed" };
    if (c.digest !== s.digest || c.format !== s.format) return { ok: false, reason: "decoded_value_changed" };
    if (Math.abs(c.box.w - s.box.w) > 0.01 || Math.abs(c.box.h - s.box.h) > 0.01) return { ok: false, reason: "code_scaled" };
  }
  return { ok: true };
}

export type EntryOutcome =
  | { kind: "entry_pdf"; bytes: Uint8Array; codes: number }
  | { kind: "cover_page"; bytes: Uint8Array; reason: "no_code_found" }
  | { kind: "none"; reason: string };

/**
 * The whole step for one supplier PDF: locate, check the count, build,
 * verify; or the cover page when no code was found; or nothing (the
 * operator's PDF only) on any other doubt.
 */
export async function generateEntryDocument(
  sourceBytes: Uint8Array,
  view: EntryView,
  decoder: CodeDecoder,
  opts: { date: Date; expectedUnits: number | null; maxBytes: number },
): Promise<EntryOutcome> {
  let source: PDFDocument;
  try {
    source = await PDFDocument.load(sourceBytes, { updateMetadata: false });
  } catch {
    return { kind: "none", reason: "source_unreadable" };
  }
  let located;
  try {
    located = await locateCodes(source, decoder);
  } catch {
    return { kind: "none", reason: "locate_error" };
  }
  if (!located.codes.length) {
    const bytes = await buildCoverPage(view, { date: opts.date });
    const v = validatePdf(bytes, { maxBytes: opts.maxBytes });
    return v.ok ? { kind: "cover_page", bytes, reason: "no_code_found" } : { kind: "none", reason: `validator_${v.reason}` };
  }
  if (opts.expectedUnits !== null && located.codes.length !== opts.expectedUnits) return { kind: "none", reason: "code_count_mismatch" };
  if (new Set(located.codes.map((c) => c.digest)).size !== located.codes.length) return { kind: "none", reason: "duplicate_code" };
  let built: BuildResult;
  try {
    built = await buildEntryPdf(source, located.codes, view, { date: opts.date });
  } catch {
    return { kind: "none", reason: "build_error" };
  }
  if (!built.ok) return { kind: "none", reason: built.reason };
  const verified = await verifyEntryPdf(located.codes, built.bytes, decoder, { maxBytes: opts.maxBytes }).catch(() => ({ ok: false as const, reason: "verify_error" }));
  if (!verified.ok) return { kind: "none", reason: verified.reason };
  return { kind: "entry_pdf", bytes: built.bytes, codes: located.codes.length };
}
