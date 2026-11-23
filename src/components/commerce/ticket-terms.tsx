import { TICKET_NON_REFUNDABLE_STATEMENT } from "@/lib/utils";

/**
 * The open-dated ticket terms on a product page (doc 29 Batch 5): the ticket
 * is valid until the operator's date, which the server quote shows before
 * payment (the page has no live stock read), and it is non-refundable once
 * issued. Built from existing typography only; no new component import.
 */
export function TicketTerms({ className }: { className?: string }) {
  return (
    <div className={className ?? "mt-3 space-y-1.5 text-sm leading-relaxed text-ink-700"} data-testid="ticket-terms">
      <p>
        <span className="font-bold text-ink-900">Open-dated ticket.</span> Valid until the date the operator sets; we show it with
        your price before you pay.
      </p>
      <p className="font-bold text-ink-900">{TICKET_NON_REFUNDABLE_STATEMENT}</p>
      <p className="text-xs text-ink-500">Issued tickets can&apos;t be cancelled online. If something goes wrong, message us with your reference.</p>
    </div>
  );
}
