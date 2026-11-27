import Link from "next/link";
import { RecoveryForm } from "@/components/commerce/order-status/recovery-form";
import { SupportLink } from "@/components/commerce/order-status/support";
import { ButtonLink } from "@/components/ui/button";
import { Alert, Breadcrumbs, Card } from "@/components/ui/primitives";
import { recoveryCodeChannels } from "./recovery-channels";

/**
 * FIND YOUR BOOKING (doc 22 §23 B5, §26 F23)
 *
 * Reference plus the phone number or email used to book. The form sends a
 * one-time code when, and only when, those match the order's verified
 * contact, and always shows the same message either way; the code opens the
 * order's status page on this device. No password, no account.
 *
 * Orders our team arranged are reached by signing in to My trips with the
 * phone number given to the team; that route stays first for them.
 *
 * Post-payment batch A1: the form offers only the channels that can deliver
 * a code right now (`recoveryCodeChannels`, from the server), and the intro
 * names them; never a phone code while texts cannot be sent.
 *
 * No analytics on this page (PRV-4).
 */
export const dynamic = "force-dynamic";

export default async function ManageBookingPage() {
  const channels = await recoveryCodeChannels();
  const contact =
    channels.length > 1 ? "the phone number or email you booked with" : channels[0] === "phone" ? "the phone number you booked with" : "the email you booked with";
  return (
    <div className="container-page py-6 pb-20">
      <div className="mx-auto max-w-2xl">
        <Breadcrumbs items={[{ label: "Dubai", href: "/" }, { label: "Find my booking" }]} className="mb-3" />
        <h1 className="text-[1.75rem] sm:text-3xl">Find your booking</h1>
        <p className="mt-1.5 text-[0.95rem] text-ink-600">
          No account needed. Enter your booking reference and {contact}, and we&apos;ll send you a code to open it.
        </p>

        <Alert tone="info" className="mt-5" title="Booked with our team?">
          <p>
            If you sent an inquiry or our team arranged your trip, sign in with the phone number you gave us. Your confirmed trips
            appear in My trips.
          </p>
          <div className="mt-3 flex flex-wrap gap-2">
            <ButtonLink href="/login?next=%2Faccount%2Fbookings" size="sm">
              Sign in to My trips
            </ButtonLink>
          </div>
        </Alert>

        <RecoveryForm channels={channels} />

        <Card className="mt-6 p-5">
          <h2 className="text-lg">Lost your reference?</h2>
          <p className="mt-1.5 text-sm leading-relaxed text-ink-600">
            Message us the phone number or email you booked with and we&apos;ll help you find it.
          </p>
          <div className="mt-3">
            <SupportLink size="sm" />
          </div>
        </Card>

        <p className="mt-6 text-sm text-ink-600">
          Have an account?{" "}
          <Link href="/login" className="font-bold text-sun-700 underline underline-offset-2">
            Log in
          </Link>{" "}
          to see all your trips in one place.
        </p>
      </div>
    </div>
  );
}
