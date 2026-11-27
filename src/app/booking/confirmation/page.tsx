"use client";

import { useRouter, useSearchParams } from "next/navigation";
import { Suspense, useCallback, useEffect, useRef, useState } from "react";
import { RefreshCw } from "lucide-react";
import { FindYourBooking } from "@/components/commerce/order-status/support";
import { clearLegacyOrderData, clearOrderHints, pickReference, readOrderHint } from "@/components/commerce/order-status/order-hint";
import { Button } from "@/components/ui/button";
import { Alert, Skeleton } from "@/components/ui/primitives";
import { fetchOrderStatus } from "@/lib/api/order-status";
import { readReturnHint, withReturnHint, type ReturnHint } from "@/lib/checkout-return";

/**
 * GATEWAY RETURN (doc 22 §23 B5, PRD-15, PRV-4)
 *
 * The payment gateway sends the browser back here with no reference it can
 * be trusted with. This page never decides that anything succeeded: not
 * from the URL, not from storage. It takes a well-formed `?ref=` or the
 * reference the checkout left in `sessionStorage` (the reference only, no
 * personal details), asks the status API about it, and
 *
 *   - visible to this browser → replaces itself with `/booking/<reference>`,
 *     the order's status page, which shows the real projection;
 *   - not visible, or no reference → the neutral "find your booking" state;
 *   - the network failed → says so and offers a retry, claiming nothing.
 *
 * No analytics on this page (PRV-4). Snapshots older builds kept in
 * `sessionStorage` (traveller details, items) are deleted on load.
 *
 * Stripe returns here with `?result=success` or `?result=cancel` (checkout
 * redesign batch 3, CO-08). That hint only picks words: one sentence above
 * the neutral state, and it is passed on to the status page, which uses it
 * for the "Return to payment" wording while the server says the payment is
 * still awaited. It never decides what is shown.
 */
export default function ConfirmationPage() {
  return (
    <Suspense fallback={<Checking />}>
      <ConfirmationInner />
    </Suspense>
  );
}

function Checking() {
  return (
    <div className="container-page py-10 pb-20">
      <div className="mx-auto max-w-2xl" role="status" aria-live="polite">
        <h1 className="text-[1.75rem] sm:text-3xl">Checking your booking</h1>
        <p className="mt-2 text-sm text-ink-600">We&apos;re asking our system for the latest status. This usually takes a moment.</p>
        <Skeleton className="mt-6 h-48 w-full rounded-[var(--radius-tile)]" />
      </div>
    </div>
  );
}

type Phase = "checking" | "not_visible" | "unreachable";

function ConfirmationInner() {
  const params = useSearchParams();
  const router = useRouter();
  const [phase, setPhase] = useState<Phase>("checking");
  const errorRef = useRef<HTMLHeadingElement>(null);
  const queryRef = params.get("ref");
  const hint = readReturnHint(params.get("result"));

  const check = useCallback(async () => {
    clearLegacyOrderData();
    const reference = pickReference(queryRef, readOrderHint());
    if (!reference) {
      setPhase("not_visible");
      return;
    }
    setPhase("checking");
    try {
      const status = await fetchOrderStatus(reference);
      if (!status) {
        setPhase("not_visible");
        return;
      }
      clearOrderHints();
      router.replace(withReturnHint(`/booking/${encodeURIComponent(status.reference)}`, hint));
    } catch {
      setPhase("unreachable");
    }
  }, [queryRef, hint, router]);

  useEffect(() => {
    void check();
  }, [check]);

  useEffect(() => {
    if (phase === "unreachable") errorRef.current?.focus();
  }, [phase]);

  if (phase === "checking") return <Checking />;

  if (phase === "unreachable") {
    return (
      <div className="container-page py-10 pb-20">
        <div className="mx-auto max-w-2xl">
          <h1 ref={errorRef} tabIndex={-1} className="text-[1.75rem] outline-none sm:text-3xl">
            We couldn&apos;t check your booking
          </h1>
          <Alert
            tone="warning"
            className="mt-4"
            title="We couldn't reach OUTLYY just now"
            action={
              <Button size="sm" variant="outline" onClick={() => void check()}>
                <RefreshCw className="h-4 w-4" aria-hidden="true" /> Try again
              </Button>
            }
          >
            Check your connection and try again. Don&apos;t pay a second time: if a payment went through, it is attached to your
            booking and its status will show here.
          </Alert>
        </div>
      </div>
    );
  }

  return (
    <div className="container-page py-8 pb-20">
      <FindYourBooking note={hint ? <ReturnNote hint={hint} /> : undefined} />
    </div>
  );
}

/**
 * One sentence for a customer Stripe just sent back, when this browser cannot
 * show the booking (a new tab, another browser, cleared storage). Worded so it
 * is true whatever happened: the hint is not evidence of a payment or of none.
 */
function ReturnNote({ hint }: { hint: ReturnHint }) {
  return (
    <p className="mb-4 text-sm leading-relaxed text-ink-700" data-testid="return-note">
      {hint === "cancel"
        ? "You left Stripe's payment page. If you paid before leaving, don't pay again: the payment is attached to your booking."
        : "If you've just paid, your payment is attached to your booking. Don't pay again: find your booking below to see its status."}
    </p>
  );
}
