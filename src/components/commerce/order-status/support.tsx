import { WhatsAppGlyph } from "@/components/commerce/whatsapp";
import { ButtonLink } from "@/components/ui/button";
import { EmptyState } from "@/components/ui/primitives";
import { whatsAppUrl, type WhatsAppIntent } from "@/lib/whatsapp";

/**
 * Support pieces for the private order pages (`/t`, `/booking`,
 * `/manage-booking`, `/voucher`).
 *
 * `SupportLink` is the WhatsApp button's look as a plain link: it opens the
 * same pre-filled chat but logs no analytics event, because these pages send
 * nothing about an order to the event pipeline (PRV-4). The booking
 * reference goes only into the message the customer chooses to send.
 */
export function SupportLink({
  intent = "booking_support",
  reference,
  label = "Message us on WhatsApp",
  size = "md",
  className,
}: {
  intent?: WhatsAppIntent;
  reference?: string;
  label?: string;
  size?: "sm" | "md" | "lg";
  className?: string;
}) {
  return (
    <ButtonLink
      href={whatsAppUrl({ intent, bookingReference: reference })}
      target="_blank"
      rel="noopener noreferrer"
      prefetch={false}
      variant="whatsapp"
      size={size}
      className={className}
    >
      <WhatsAppGlyph className="h-[1.15rem] w-[1.15rem] shrink-0" />
      {label}
      <span className="sr-only"> (opens WhatsApp in a new tab)</span>
    </ButtonLink>
  );
}

/**
 * The neutral state for any order this browser may not see, or no order at
 * all. It never repeats the reference and never says whether one exists: a
 * real order without access, a typo and an unknown reference all look the
 * same (doc 22 §26 F23).
 */
export function FindYourBooking({ title = "Find your booking", headingLevel = 1, note }: { title?: string; headingLevel?: 1 | 2; note?: React.ReactNode }) {
  const Heading = headingLevel === 1 ? "h1" : "h2";
  return (
    <div className="mx-auto max-w-2xl" data-testid="find-your-booking">
      <Heading className="mb-4 text-[1.75rem] sm:text-3xl">{title}</Heading>
      {/* One neutral sentence from the page (the Stripe return hint, CO-08); never a claim about this order. */}
      {note}
      <EmptyState
        illustration="bookings"
        title="We can't show a booking on this page"
        body="To see a booking, confirm it is yours with its reference and the phone number or email you booked with. If our team arranged your trip, sign in with the phone number you gave us to see it in My trips."
        action={<ButtonLink href="/manage-booking">Find my booking</ButtonLink>}
        secondary={
          <ButtonLink href="/login?next=%2Faccount%2Fbookings" variant="outline">
            Sign in to My trips
          </ButtonLink>
        }
      />
      <div className="mt-6 flex flex-col items-start gap-2 text-sm text-ink-600 sm:flex-row sm:items-center">
        <span>Can&apos;t find it?</span>
        <SupportLink size="sm" label="Ask us on WhatsApp" />
      </div>
    </div>
  );
}
