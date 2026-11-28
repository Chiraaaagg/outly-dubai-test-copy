import type { Metadata } from "next";
import { OrderStatusView } from "@/components/commerce/order-status/order-status-view";
import { FindYourBooking } from "@/components/commerce/order-status/support";
import { Breadcrumbs } from "@/components/ui/primitives";
import { readReturnHint } from "@/lib/checkout-return";
import { isValidReference, normaliseReference } from "@/lib/reference";
import { loadCustomerOrderStatusFromCookies } from "@/server/services/order-status.service";

export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "Your booking",
  robots: { index: false, follow: false },
  referrer: "no-referrer",
};

/**
 * ORDER STATUS (doc 22 §23 B5, PRD-15, PRD-17)
 *
 * Server state only. The page asks `loadCustomerOrderStatusFromCookies` for
 * the projection this browser may see: the signed-in owner, the guest
 * session that placed it, or a ticket-access grant from the `/t` link or
 * the recovery code. Anything else, including a malformed or unknown
 * reference, renders the same neutral "find your booking" state, which never
 * repeats the reference or says whether it exists.
 *
 * No analytics on this page: no PageView, no reference in any event
 * (PRV-4). Polling, the live region and the cancellation panel are in the
 * `OrderStatusView` client island.
 *
 * `?result=success|cancel` (the Stripe return hint, CO-08) is passed down for
 * wording only; it never changes what the projection says.
 */
export default async function BookingStatusPage({
  params,
  searchParams,
}: {
  params: Promise<{ reference: string }>;
  searchParams?: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { reference: raw } = await params;
  const returnHint = readReturnHint((await searchParams)?.result);
  const reference = normaliseReference(safeDecode(raw));
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
      <Breadcrumbs
        items={[{ label: "Dubai", href: "/" }, { label: "Find my booking", href: "/manage-booking" }, { label: status.reference }]}
        className="mx-auto mb-3 max-w-3xl"
      />
      <OrderStatusView initial={status} returnHint={returnHint} />
    </div>
  );
}

function safeDecode(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return "";
  }
}
