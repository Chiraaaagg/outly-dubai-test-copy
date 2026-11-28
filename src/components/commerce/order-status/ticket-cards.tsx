"use client";

import { Users } from "lucide-react";
import { DownloadLink } from "@/components/checkout/download-button";
import type { CustomerItemStatus, CustomerOrderStatus } from "@/lib/customer-status";
import { describeFile } from "@/lib/customer-status";
import { ticketTypeLine } from "@/lib/ticket-validity";
import type { ReturnHint } from "@/lib/checkout-return";
import { cn } from "@/lib/utils";
import { BOOKED_ITEM_STATES, documentWord, dubaiClock, ORDER_WORD, type DocumentWord } from "./presenters";
import { AnimatedTicket, EntranceGroup } from "./ticket-confirmation-card";

/**
 * Post-payment batch A5: one Ticket Confirmation Card per booked item.
 *
 * An item gets a card when its own state says the operator has confirmed it
 * (`BOOKED_ITEM_STATES`), whatever the order's state (a partly booked order
 * shows cards for its booked items). Each card picks its variant from the
 * projection: a start time ("HH:mm") shows date and time; an open-dated
 * ticket shows the visit date, its validity and types; anything else (a
 * free-text time such as an agent's "21:00 sailing") falls back to the date,
 * with the time as given. A known pickup is named in the card. The order total
 * is shown only on a single-item order (the projection has no per-item price).
 *
 * Each card carries its own item's protected downloads (`/api/tickets/documents/<id>`,
 * re-checked on every request) and says, in the card, when the file is still
 * being prepared or is ready but locked on this browser.
 *
 * A5 fix round 2 (review 99a, finding 1): one structure for any number of
 * cards, always `<ul><li key={orderItemId}>` (only the heading and the second
 * grid column depend on the count), so a card the customer has seen is never
 * remounted, and never enters again, when another item is confirmed.
 */

/** "Download tickets" / "Download voucher"; the activity when several cards or files share the page. */
export function downloadLabel(kind: "tickets_pdf" | "voucher_pdf", title: string | null): string {
  const base = kind === "tickets_pdf" ? "Download tickets" : "Download voucher";
  return title ? `${base}: ${title}` : base;
}

/**
 * Whether this card celebrates on this page load (owner decision, 27 Nov
 * 2026: only a fresh confirmation). Yes when the item became booked while the
 * page was open (it was not booked in the status the page loaded with), or
 * right after the Stripe return (`?result=success`). A later visit, a new tab
 * or the emailed link shows the final card at once, with no confetti.
 */
export function celebratesOnThisLoad(orderItemId: string, bookedAtLoad: ReadonlySet<string>, returnHint: ReturnHint | null): boolean {
  return returnHint === "success" || !bookedAtLoad.has(orderItemId);
}

/** The items that get a card, in page order. */
export function bookedItems(items: readonly CustomerItemStatus[]): CustomerItemStatus[] {
  return items.filter((i) => BOOKED_ITEM_STATES.includes(i.state));
}

type Variant = "timed" | "open_dated" | "date_only";

export function cardVariant(item: Pick<CustomerItemStatus, "timeslot" | "ticket">): Variant {
  if (item.timeslot && /^\d{2}:\d{2}$/.test(item.timeslot)) return "timed";
  if (item.ticket) return "open_dated";
  return "date_only";
}

/**
 * The line in the card's foot (the source's barcode area): what to do with
 * the file, or where it stands. Empty when there is nothing true to say.
 */
export function cardFootText(item: CustomerItemStatus, canDownload: boolean, word: DocumentWord = documentWord(item)): string {
  const { noun, is, it } = ORDER_WORD[word];
  const listed = item.tickets.documents.length > 0;
  switch (item.tickets.fulfilment) {
    case "issued":
      if (listed) {
        if (cardVariant(item) === "open_dated") return "";
        return item.pickup ? `Have the ${noun} PDF ready at pickup.` : `Show the ${noun} PDF at the meeting point.`;
      }
      return canDownload
        ? `Your ${noun} ${is} being prepared. ${word === "tickets" ? "They appear" : "It appears"} here when ready.`
        : `Your ${noun} ${is} ready. Confirm it's you above to download ${it}.`;
    case "ticket_pending":
      return `Your ${noun} ${is} being prepared. ${word === "tickets" ? "They appear" : "It appears"} here when ready.`;
    case "attention":
      return `We're having trouble getting your ${noun} from the operator. Our team is on it.`;
    default:
      return "";
  }
}

function serviceInstant(item: CustomerItemStatus, variant: Variant): Date {
  return variant === "timed" ? new Date(`${item.serviceDate}T${item.timeslot}:00+04:00`) : new Date(`${item.serviceDate}T12:00:00+04:00`);
}

/** The ticket card's rows for an open-dated ticket: validity, the tickets per type (combo offers list each type), non-refundable. */
export function TicketFacts({ ticket }: { ticket: NonNullable<CustomerItemStatus["ticket"]> }) {
  return (
    <>
      {ticket.validUntil && ticket.validityCopy ? (
        <p>
          <time dateTime={ticket.validUntil}>{ticket.validityCopy}</time>
        </p>
      ) : null}
      {ticket.validityConcern ? <p className="text-ink-900">{ticket.validityConcern}</p> : null}
      {ticket.types.length > 0 && (
        <ul aria-label="Tickets issued" className="list-disc pl-5">
          {ticket.types.map((t) => (
            <li key={t.label}>{ticketTypeLine(t)}</li>
          ))}
        </ul>
      )}
      <p className="font-semibold text-ink-900">{ticket.nonRefundableCopy}</p>
    </>
  );
}

export function BookedItemCards({
  status,
  items,
  amount,
  entrance,
  onEntranceStart,
}: {
  status: Pick<CustomerOrderStatus, "reference" | "currency" | "canDownload" | "steps" | "items">;
  /** The booked items (`bookedItems`). */
  items: CustomerItemStatus[];
  /** The order total in major units, for a single-item order; null otherwise. */
  amount: number | null;
  /** Whether a card celebrates (`celebratesOnThisLoad`): its entrance plays when it comes into view. */
  entrance: (orderItemId: string) => boolean;
  onEntranceStart?: () => void;
}) {
  if (items.length === 0) return null;
  const several = items.length > 1;
  const canDownload = status.canDownload !== false;
  const singleOrder = status.items.length === 1;

  const cards = items.map((item) => {
    const variant = cardVariant(item);
    const word = documentWord(item);
    const docs = item.tickets.documents;
    const confirmedAt = singleOrder && status.steps.booking.at ? dubaiClock(status.steps.booking.at) : "";
    const where = item.pickup ? (
      <>
        Pickup at <span className="tnum font-semibold text-ink-900">{item.pickup.time}</span> Dubai time
        {item.pickup.hotel ? <span className="block break-words">{item.pickup.hotel}</span> : null}
      </>
    ) : variant === "open_dated" ? (
      `Show the ${ORDER_WORD[word].noun} PDF at the entrance.`
    ) : (
      `Where to go is on your ${ORDER_WORD[word].noun}.`
    );
    const details =
      variant === "open_dated" && item.ticket ? (
        <TicketFacts ticket={item.ticket} />
      ) : variant === "date_only" && item.timeslot ? (
        <p>
          <span className="font-semibold text-ink-900">Time: </span>
          {item.timeslot}
        </p>
      ) : null;
    const action =
      docs.length > 0 ? (
        <div className="flex flex-col gap-2" data-testid="ticket-card-download">
          {docs.map((doc, n) => {
            const fileId = `card-file-${doc.id}`;
            const numbered = docs.length > 1 ? `, ${n + 1} of ${docs.length}` : "";
            return (
              <div key={doc.id} className="space-y-1">
                {/* The visible label stays short so the key never wraps past its height on a phone; the
                    activity is in the accessible name, so several cards' downloads are told apart. */}
                <DownloadLink href={doc.href} rel="noreferrer" className="h-auto min-h-12 w-full py-2.5 text-center" aria-describedby={fileId}>
                  {downloadLabel(doc.kind, null)}
                  {numbered}
                  {several ? <span className="sr-only">: {item.title}</span> : null}
                </DownloadLink>
                <p id={fileId} className="text-center text-sm text-ink-600">
                  {describeFile(doc.contentType, doc.byteSize)}
                </p>
              </div>
            );
          })}
        </div>
      ) : null;

    const card = (
      <AnimatedTicket
        className="mx-auto"
        headingLevel={several ? 3 : 2}
        title={item.title}
        subtitle={confirmedAt ? `Confirmed by the operator at ${confirmedAt} Dubai time.` : "Confirmed by the operator."}
        ticketId={status.reference}
        amount={singleOrder ? amount : null}
        currency={status.currency}
        date={serviceInstant(item, variant)}
        dateOnly={variant !== "timed"}
        dateLabel={variant === "open_dated" ? "Visit date" : variant === "date_only" ? "Date" : undefined}
        cardHolder={item.paxLabel}
        last4Digits={where}
        icon={<Users aria-hidden="true" className="size-6 shrink-0 text-sun-700" />}
        barcodeValue={cardFootText(item, canDownload, word)}
        details={details}
        action={action}
        entrance={entrance(item.orderItemId)}
        onEntranceStart={onEntranceStart}
        data-testid="ticket-card"
        data-item-id={item.orderItemId}
        data-variant={variant}
      />
    );
    return { id: item.orderItemId, card };
  });

  return (
    <section
      {...(several ? { "aria-labelledby": "confirmation-heading" } : { "aria-label": "Booking confirmation" })}
      className="mt-8"
      data-testid="booking-confirmation"
    >
      {several ? (
        <h2 id="confirmation-heading" className="mb-4 text-xl">
          Confirmed activities
        </h2>
      ) : null}
      {/* Top-aligned, never stretched: a stretched ticket would move its cut-outs off its dashed line. The
          same list for one card or several (fix round 2): a second card arriving never remounts the first. */}
      <EntranceGroup>
        <ul className={cn("grid grid-cols-1 items-start gap-6 px-2", several && "md:grid-cols-2")}>
          {cards.map(({ id, card }) => (
            <li key={id}>{card}</li>
          ))}
        </ul>
      </EntranceGroup>
    </section>
  );
}
