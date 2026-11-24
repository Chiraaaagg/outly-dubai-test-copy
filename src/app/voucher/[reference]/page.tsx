import type { Metadata } from "next";
import { FindYourBooking, SupportLink } from "@/components/commerce/order-status/support";
import { StatePill } from "@/components/commerce/order-status/state-pill";
import { TicketList } from "@/components/commerce/order-status/ticket-list";
import { toneForState } from "@/components/commerce/order-status/presenters";
import { ButtonLink } from "@/components/ui/button";
import { Breadcrumbs, Card } from "@/components/ui/primitives";
import { isValidReference, normaliseReference } from "@/lib/reference";
import { formatDateLong } from "@/lib/utils";
import { loadCustomerOrderStatusFromCookies } from "@/server/services/order-status.service";

export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "Your tickets",
  robots: { index: false, follow: false },
  referrer: "no-referrer",
};

/**
 * TICKETS FOR ONE BOOKING (doc 22 §23 B5, PRD-15)
 *
 * The old page drew a voucher from fixture data with a decorative QR that no
 * gate could scan. This one shows only what the server holds: for an order
 * this browser may see, each item's ticket state and its downloadable files
 * (the operator's own documents, streamed through
 * `/api/tickets/documents/<id>` with ownership re-checked on every
 * download). Anything else is the neutral "find your booking" state.
 *
 * No analytics on this page (PRV-4).
 */
export default async function VoucherPage({ params }: { params: Promise<{ reference: string }> }) {
  const { reference: raw } = await params;
  const reference = normaliseReference(raw);
  const status = isValidReference(reference, "OUT") ? await loadCustomerOrderStatusFromCookies(reference) : null;

  if (!status) {
    return (
      <div className="container-page py-8 pb-20">
        <FindYourBooking />
      </div>
    );
  }

  return (
    <div className="container-page py-6 pb-20">
      <div className="mx-auto max-w-3xl">
        <Breadcrumbs
          items={[{ label: "Dubai", href: "/" }, { label: status.reference, href: `/booking/${status.reference}` }, { label: "Tickets" }]}
          className="mb-3"
        />
        <h1 className="text-[1.75rem] sm:text-3xl">Your tickets</h1>
        <p className="mt-1 text-sm text-ink-600">
          Booking <strong className="font-display font-bold tnum text-ink-900">{status.reference}</strong>. {status.headline}
        </p>

        <ul className="mt-6 space-y-4">
          {status.items.map((item, index) => {
            const headingId = `voucher-tickets-${index}`;
            return (
              <Card as="li" key={item.orderItemId} className="p-5">
                <div className="flex flex-wrap items-start justify-between gap-2">
                  <h2 id={headingId} className="min-w-0 text-lg leading-snug">
                    {item.title}
                  </h2>
                  <StatePill state={item.state} tone={toneForState(item.state)} size="sm" />
                </div>
                <p className="mt-1 text-sm text-ink-600">
                  {formatDateLong(item.serviceDate)}
                  {item.timeslot ? ` · ${item.timeslot}` : ""} · {item.paxLabel}
                </p>
                <TicketList tickets={item.tickets} headingId={headingId} className="mt-3" />
              </Card>
            );
          })}
        </ul>

        <div className="mt-6 flex flex-wrap gap-2">
          <ButtonLink href={`/booking/${status.reference}`} variant="outline" size="md">
            See the full booking status
          </ButtonLink>
          <SupportLink reference={status.reference} size="md" label="Ask us on WhatsApp" />
        </div>
      </div>
    </div>
  );
}
