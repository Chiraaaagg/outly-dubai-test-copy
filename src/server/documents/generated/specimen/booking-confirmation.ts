import { PlainWriter } from "../layout/plain";

/**
 * Booking confirmation / itinerary: SPECIMEN ONLY (doc 93 §3.3, §5.6; owner
 * answer O6: the owner will send a PDF design reference). Order level, one
 * block per item, the sentence "This is not your entry ticket" under the
 * title, a payment summary line that points to the tax invoice. Drawn by the
 * plain structural layout; never generated for a real order.
 */

export interface BookingConfirmationSpecimen {
  reference: string;
  items: { title: string; state: string; when: string; guests: string; where?: string; terms: string }[];
  paidLine: string;
  support: string;
  bands: string[];
}

export async function renderBookingConfirmationSpecimen(s: BookingConfirmationSpecimen, date: Date): Promise<Uint8Array> {
  const w = await PlainWriter.create({ title: `SPECIMEN Booking confirmation ${s.reference}`, bands: s.bands, date, subject: "Booking confirmation (specimen)" });
  w.heading("Booking confirmation", 18);
  w.fields([
    ["Booking", s.reference],
    ["Status", "Paid"],
  ]);
  w.box(["This is not your entry ticket."], { bold: true });
  s.items.forEach((it, i) => {
    w.rule();
    w.text(`${i + 1}  ${it.title}`, { bold: true, size: 11 });
    w.fields([
      ["State", it.state],
      ["When", it.when],
      ["Guests", it.guests],
      ...(it.where ? ([["Where", it.where]] as [string, string][]) : []),
      ["Cancellation", it.terms],
    ]);
  });
  w.rule();
  w.text(s.paidLine);
  w.finish(`Help: ${s.support}`);
  return w.save();
}
