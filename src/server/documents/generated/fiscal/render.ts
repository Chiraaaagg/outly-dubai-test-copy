import { PlainWriter } from "../layout/plain";
import { fiscalView, type FiscalParty, type FiscalSnapshot, type FiscalView } from "./snapshot";

/**
 * Fiscal document renderer: a snapshot in, PDF bytes out (doc 93 §4, §5.1,
 * §5.3; owner answer O1: one combined "Tax invoice / Receipt" marked PAID).
 *
 * The layout is a replaceable part (`FiscalLayout`). Today's is the plain
 * structural layout, marked on every page "SPECIMEN — layout pending owner
 * design" (O2). The owner's 21st.dev-based design replaces `plainFiscalLayout`
 * only; numbering, snapshots and VAT never move. A new layout gets a new
 * `templateVersion`, so a stored file always says which layout drew it.
 *
 * Deterministic: the same snapshot gives the same bytes (fixed dates, no
 * random ids), so a re-draw after a lost object has the same checksum.
 */

export interface FiscalLayout {
  templateVersion: number;
  /**
   * False while the layout is the plain "SPECIMEN — layout pending owner design" one: a
   * production document is refused (`layout_pending`, review finding 5) until the owner's design replaces it.
   */
  productionReady: boolean;
  render(view: FiscalView, opts: { date: Date }): Promise<{ bytes: Uint8Array; replacedChars: number }>;
}

export const plainFiscalLayout: FiscalLayout = {
  templateVersion: 1,
  productionReady: false,
  async render(view, opts) {
    const w = await PlainWriter.create({ title: view.metaTitle, bands: view.bands, date: opts.date, subject: view.title, keywords: ["OUTLYY", view.number] });
    w.heading(view.title, 18);
    w.fields([
      [view.numberLabel, view.number],
      ["Date", view.issueDate],
      ...(view.statusWord ? ([["Status", view.statusWord]] as [string, string][]) : []),
    ]);
    w.rule();
    w.text("SELLER", { bold: true, size: 9, muted: true });
    w.fields(view.seller);
    w.gap(4);
    w.text("BOOKING", { bold: true, size: 9, muted: true });
    w.fields(view.booking);
    w.rule();
    w.table(view.columns, view.rows);
    w.fields(view.totals, { labelWidth: 300 });
    w.gap(6);
    for (const n of view.notes) w.text(n, { size: 9 });
    w.finish(view.footer);
    return { bytes: await w.save(), replacedChars: w.replacedChars };
  },
};

export async function renderFiscalPdf(
  snapshot: FiscalSnapshot,
  party: FiscalParty | null,
  layout: FiscalLayout = plainFiscalLayout,
  /** Specimens only: bands printed first on every page ("SPECIMEN — not valid for entry"). */
  extraBands: readonly string[] = [],
): Promise<{ bytes: Uint8Array; replacedChars: number; templateVersion: number }> {
  const base = fiscalView(snapshot, party);
  const view = { ...base, bands: [...extraBands, ...base.bands], metaTitle: extraBands.length ? `SPECIMEN ${base.metaTitle}` : base.metaTitle };
  const out = await layout.render(view, { date: new Date(snapshot.issuedAt) });
  return { ...out, templateVersion: layout.templateVersion };
}
