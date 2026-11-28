/**
 * Group C synthetic specimens (doc 93 §6; owner answers O1, O2, O6, Q13).
 *
 *   npx tsx scripts/specimens/group-c.ts [outDir]
 *
 * Writes labelled SYNTHETIC specimens to a git-ignored folder (default
 * `.specimens/group-c/`): the combined "Tax invoice / Receipt" and two credit
 * notes, the branded entry PDF made from a synthetic supplier tickets PDF (and
 * that synthetic source), the cover-page fallback, the booking confirmation,
 * and the payment email as HTML with and without the invoice line.
 *
 * Everything is fake: "Asha Specimen", `OUT-000000`, "Specimen Desert Safari",
 * bracketed seller placeholders, QR codes encoding `SPECIMEN-NOT-VALID-<n>`.
 * Every page carries "SPECIMEN — not valid for entry" and "SPECIMEN — layout
 * pending owner design". No database, no network, no supplier call; nothing
 * real is read or attached.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { splitDiscount, splitInclusive, totalsOf, VAT_RULE, formatMinor, vatRateBasisPoints, vatRateLabel, type VatCategory } from "../../src/server/domain/vat";
import { renderFiscalPdf } from "../../src/server/documents/generated/fiscal/render";
import type { FiscalLine, FiscalSeller, FiscalSnapshot } from "../../src/server/documents/generated/fiscal/snapshot";
import { buildCoverPage, generateEntryDocument, type EntryView } from "../../src/server/documents/generated/entry/entry-pdf";
import { createZxingDecoder } from "../../src/server/documents/generated/entry/code-decoder";
import { syntheticSupplierPdf } from "../../src/server/documents/generated/specimen/synthetic-supplier";
import { renderBookingConfirmationSpecimen } from "../../src/server/documents/generated/specimen/booking-confirmation";
import { renderPaymentReceived } from "../../src/server/notifications/templates";
import { validatePdf } from "../../src/server/documents/pdf";

const NOT_FOR_ENTRY = "SPECIMEN — not valid for entry";
const NOT_FISCAL = "SPECIMEN — not a tax invoice, not a receipt, not a credit note";
const DATE = new Date("2027-02-14T10:05:00Z");

const seller: FiscalSeller = {
  legalName: "[Legal name]",
  tradingName: "OUTLYY",
  trn: "[TRN]",
  address: "[Registered address]",
  licence: null,
  supportEmail: "support@example.com",
  phone: null,
  placeholder: true,
};

function line(id: string, description: string, variant: string | null, serviceDate: string, guests: string, grossMinor: bigint, category: VatCategory = "standard"): FiscalLine {
  const sp = splitInclusive(grossMinor, category);
  return { orderItemId: id, lineKind: "item", description, variant, serviceDate, guests, vatCategory: category, rateLabel: vatRateLabel(category), rateBasisPoints: vatRateBasisPoints(category), discountMinor: "0", netMinor: String(sp.netMinor), vatMinor: String(sp.vatMinor), grossMinor: String(sp.grossMinor) };
}

/** A5: an item's discount as its own negative line, right after the item. */
function discountLine(item: FiscalLine, discountMinor: bigint): FiscalLine {
  const d = splitDiscount(discountMinor, item.vatCategory);
  return { ...item, lineKind: "discount", description: "Discount", variant: item.description, guests: "", netMinor: String(d.netMinor), vatMinor: String(d.vatMinor), grossMinor: String(d.grossMinor) };
}

function totals(lines: FiscalLine[]) {
  const t = totalsOf(lines.map((l) => ({ grossMinor: BigInt(l.grossMinor), netMinor: BigInt(l.netMinor), vatMinor: BigInt(l.vatMinor), category: l.vatCategory })));
  return { netMinor: String(t.netMinor), vatMinor: String(t.vatMinor), grossMinor: String(t.grossMinor), byRate: t.byRate.map((r) => ({ label: r.label, basisPoints: r.basisPoints, netMinor: String(r.netMinor), vatMinor: String(r.vatMinor) })) };
}

function snapshot(partial: Partial<FiscalSnapshot> & Pick<FiscalSnapshot, "docType" | "displayNumber" | "lines">): FiscalSnapshot {
  return {
    environment: "test",
    issuedAt: DATE.toISOString(),
    supplyDate: "2027-02-14",
    currency: "AED",
    orderReference: "OUT-000000",
    seller,
    totals: totals(partial.lines),
    moneyAt: DATE.toISOString(),
    paymentMethodLabel: "Card",
    refersTo: null,
    refundReasonLabel: null,
    vatRule: VAT_RULE,
    vatRuleConfirmed: false,
    templateVersion: 1,
    ...partial,
  };
}

async function main() {
  const out = path.resolve(process.argv[2] ?? ".specimens/group-c");
  mkdirSync(out, { recursive: true });
  const written: string[] = [];
  const save = (name: string, bytes: Uint8Array | string) => {
    if (!name.startsWith("SPECIMEN-")) throw new Error("specimen file names start with SPECIMEN-");
    if (typeof bytes !== "string") {
      const v = validatePdf(bytes, { maxBytes: 10 * 1024 * 1024 });
      if (!v.ok) throw new Error(`${name}: validator refused (${v.reason})`);
    }
    writeFileSync(path.join(out, name), bytes);
    written.push(name);
  };
  const party = { buyerName: "Asha Specimen" };
  const fiscalBands = [NOT_FOR_ENTRY, NOT_FISCAL];

  // 1. Combined "Tax Invoice / Receipt" (O1, A3), two lines: a standard-rated tour and an exempt transport ticket (A6).
  const inv = [line("item-1", "Specimen Desert Safari", "Standard, hotel pickup", "2027-02-20", "2 adults", 40000n), line("item-2", "Specimen Monorail Ticket", null, "2027-02-21", "2 adults", 2000n, "exempt")];
  save("SPECIMEN-tax-invoice-receipt.pdf", (await renderFiscalPdf(snapshot({ docType: "tax_invoice", displayNumber: "TEST-INV-000001", lines: inv }), party, undefined, fiscalBands)).bytes);

  // 1b. With a discount (A5): the item at its full price and the discount as its own negative line.
  const discItem = line("item-1", "Specimen Desert Safari", "Standard, hotel pickup", "2027-02-20", "2 adults", 40000n);
  const disc = [discItem, discountLine(discItem, 4000n)];
  save("SPECIMEN-tax-invoice-receipt-discount.pdf", (await renderFiscalPdf(snapshot({ docType: "tax_invoice", displayNumber: "TEST-INV-000002", lines: disc }), party, undefined, fiscalBands)).bytes);

  // 2. Credit notes: full item refund, partial refund (fee kept).
  const refersTo = { displayNumber: "TEST-INV-000001", issuedAt: DATE.toISOString() };
  const full = [{ ...inv[0], note: "Full refund" }];
  save(
    "SPECIMEN-tax-credit-note-full.pdf",
    (await renderFiscalPdf(snapshot({ docType: "tax_credit_note", displayNumber: "TEST-CN-000001", lines: full, refersTo, refundReasonLabel: "Cancelled by the guest", moneyAt: "2027-02-18T08:00:00Z", issuedAt: "2027-02-18T08:02:00Z" }), party, undefined, fiscalBands)).bytes,
  );
  const partSplit = splitInclusive(30000n, "standard");
  const partial = [{ ...inv[0], netMinor: String(partSplit.netMinor), vatMinor: String(partSplit.vatMinor), grossMinor: String(partSplit.grossMinor), note: "Partial refund" }];
  save(
    "SPECIMEN-tax-credit-note-partial.pdf",
    (await renderFiscalPdf(snapshot({ docType: "tax_credit_note", displayNumber: "TEST-CN-000002", lines: partial, refersTo, refundReasonLabel: "Cancelled by the guest", moneyAt: "2027-02-18T08:00:00Z", issuedAt: "2027-02-18T08:02:00Z" }), party, undefined, fiscalBands)).bytes,
  );

  // 3. Branded entry PDF from a SYNTHETIC supplier tickets PDF (four guests, one code per supplier page).
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
    where: "Specimen Station, Specimen Island",
    goodToKnow: ["Specimen line: carry photo ID."],
    nonRefundable: true,
    support: "support@example.com",
    sourceLine: "version 1 · fingerprint 00000000…00000000 (synthetic)",
    bands: [NOT_FOR_ENTRY],
  };
  const supplier = await syntheticSupplierPdf({ layout: [1, 1, 1, 1], decoy: true });
  save("SPECIMEN-synthetic-supplier-tickets.pdf", supplier);
  const entry = await generateEntryDocument(supplier, view, createZxingDecoder(), { date: DATE, expectedUnits: 4, maxBytes: 10 * 1024 * 1024 });
  if (entry.kind !== "entry_pdf") throw new Error(`entry specimen fell back: ${entry.kind} ${"reason" in entry ? entry.reason : ""}`);
  save("SPECIMEN-entry-tickets.pdf", entry.bytes);

  // 3b. Several codes on one supplier page: still one guest page per code.
  const supplierShared = await syntheticSupplierPdf({ layout: [3] });
  const shared = await generateEntryDocument(supplierShared, { ...view, guestsLabel: "3 adults" }, createZxingDecoder(), { date: DATE, expectedUnits: 3, maxBytes: 10 * 1024 * 1024 });
  if (shared.kind !== "entry_pdf") throw new Error(`shared-page specimen fell back: ${shared.kind}`);
  save("SPECIMEN-entry-tickets-shared-page.pdf", shared.bytes);

  // 4. Cover-page fallback (no code found).
  save("SPECIMEN-entry-cover-only.pdf", await buildCoverPage({ ...view, kind: "voucher", activity: "Specimen Desert Safari", where: "Pickup from Specimen Hotel, time will be confirmed by the operator", nonRefundable: false, bands: [NOT_FOR_ENTRY, "SPECIMEN — synthetic stand-in, real voucher layout MISSING"] }, { date: DATE }));

  // 5. Booking confirmation (O6: specimen only; the owner's PDF reference is awaited).
  save(
    "SPECIMEN-booking-confirmation.pdf",
    await renderBookingConfirmationSpecimen(
      {
        reference: "OUT-000000",
        bands: [NOT_FOR_ENTRY, "SPECIMEN — owner's PDF design reference awaited (O6)"],
        items: [
          { title: "Specimen Desert Safari", state: "Confirmed", when: "Fri, 20 Feb 2027 · 15:00 Dubai time", guests: "2 adults", where: "Pickup from Specimen Hotel, time to be confirmed", terms: "Free cancellation until 19 Feb 2027, 15:00 Dubai time" },
          { title: "Specimen Monorail Ticket", state: "Tickets being prepared", when: "Sat, 21 Feb 2027 · open-dated · valid until 30 Jun 2027", guests: "2 adults", terms: "Non-refundable once issued" },
        ],
        paidLine: `Paid AED ${formatMinor(42000n)} by card on 14 Feb 2027. Tax invoice / Receipt TEST-INV-000001.`,
        support: "support@example.com",
      },
      DATE,
    ),
  );

  // 6. Payment email (no link, O7), without and with the attached invoice line (O8).
  const banner = `<div style="background:#B91C1C;color:#fff;font:700 13px/1.4 sans-serif;padding:8px 12px;text-align:center">${NOT_FOR_ENTRY} · SPECIMEN — layout pending owner design</div>`;
  const ctx = {
    firstName: "Asha",
    orderReference: "OUT-000000",
    amountLabel: "AED 420.00",
    paidOnLabel: "14 Feb 2027",
    methodLabel: "card",
    items: [
      { title: "Specimen Desert Safari", dateLabel: "20 Feb 2027", guests: "2 adults" },
      { title: "Specimen Monorail Ticket", dateLabel: "21 Feb 2027", guests: "2 adults" },
    ],
    supportEmail: "support@example.com",
  };
  const withBanner = (html: string) => html.replace("<body", "<body data-specimen=\"true\"").replace(/(<body[^>]*>)/, `$1${banner}`);
  save("SPECIMEN-payment-received-email.html", withBanner(renderPaymentReceived(ctx).html!));
  save("SPECIMEN-payment-received-email-with-invoice.html", withBanner(renderPaymentReceived({ ...ctx, invoice: { displayNumber: "TEST-INV-000001" } }).html!));

  console.log(`Wrote ${written.length} synthetic specimens to ${out}:\n${written.map((w) => `  ${w}`).join("\n")}`);
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
