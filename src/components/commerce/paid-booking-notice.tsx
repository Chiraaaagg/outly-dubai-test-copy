"use client";

import { useEffect, useState, type ReactNode } from "react";
import { CheckCircle2, Clock } from "lucide-react";
import { ButtonLink } from "@/components/ui/button";
import { EmptyState } from "@/components/ui/primitives";
import { fetchOrderStatus } from "@/lib/api/order-status";
import { readPaidMarker, resolvePaidBooking, type PaidBookingNotice } from "@/lib/paid-booking";

/**
 * The empty `/checkout` and `/cart` after a paid booking (production fix,
 * 28 Nov 2026; marker rules in src/lib/paid-booking.ts).
 *
 * When this tab's status page emptied a paid cart in the last 24 hours, the
 * page asks the server about that order before it says anything. While it
 * asks, the page's own skeleton shows; when the server says the payment
 * arrived, the booking replaces the generic empty state; in every other case
 * (no marker, an order this browser may not see, an unpaid or ended order, a
 * failed or slow request) the page's usual empty state shows, unchanged.
 *
 * Accessibility: the title is a heading (its level chosen by the page); focus
 * is never moved; one polite status line says what is happening, so a screen
 * reader hears the booking when it replaces the skeleton. No analytics here
 * (PRV-4): the reference never leaves this tab except to the status API.
 */

/** After this long without an answer the usual empty state shows, and a late answer is ignored. */
const CHECK_TIMEOUT_MS = 8_000;

type HeadingLevel = "h1" | "h2" | "h3";
export type PaidBookingPhase = "checking" | "notice" | "none";

export function PaidBookingEmptyState({ notice, headingAs }: { notice: PaidBookingNotice; headingAs?: HeadingLevel }) {
  return (
    <EmptyState
      headingAs={headingAs}
      icon={notice.confirmed ? <CheckCircle2 className="h-6 w-6" /> : <Clock className="h-6 w-6" />}
      title={notice.title}
      body={notice.body}
      action={<ButtonLink href={notice.href}>View booking</ButtonLink>}
      secondary={
        <ButtonLink href="/search" variant="outline">
          Browse experiences
        </ButtonLink>
      }
    />
  );
}

/** What the empty page shows in each phase. Pure, so it renders in tests without a browser. */
export function EmptyCartView({
  phase,
  notice,
  fallback,
  skeleton,
  headingAs,
}: {
  phase: PaidBookingPhase;
  notice: PaidBookingNotice | null;
  fallback: ReactNode;
  skeleton: ReactNode;
  headingAs?: HeadingLevel;
}) {
  const shown = phase === "notice" && notice ? notice : null;
  return (
    <>
      <p className="sr-only" role="status" aria-live="polite" aria-atomic="true" data-testid="paid-booking-status">
        {phase === "checking" ? "Checking your recent booking." : shown ? shown.title : ""}
      </p>
      {phase === "checking" ? skeleton : shown ? <PaidBookingEmptyState notice={shown} headingAs={headingAs} /> : fallback}
    </>
  );
}

/** The empty cart state, or the booking this tab just paid for when the server confirms the payment. */
export function EmptyCartOrPaidBooking({ fallback, skeleton, headingAs }: { fallback: ReactNode; skeleton: ReactNode; headingAs?: HeadingLevel }) {
  // Read once: this component mounts only on the client, once the cart has loaded and is empty.
  const [marker] = useState(() => readPaidMarker());
  const [result, setResult] = useState<{ notice: PaidBookingNotice | null } | null>(null);

  useEffect(() => {
    if (!marker) return;
    let settled = false;
    const settle = (notice: PaidBookingNotice | null) => {
      if (settled) return;
      settled = true;
      setResult({ notice });
    };
    const timer = window.setTimeout(() => settle(null), CHECK_TIMEOUT_MS);
    void resolvePaidBooking(marker, fetchOrderStatus).then(settle);
    return () => {
      settled = true;
      window.clearTimeout(timer);
    };
  }, [marker]);

  const phase: PaidBookingPhase = !marker ? "none" : !result ? "checking" : result.notice ? "notice" : "none";
  return <EmptyCartView phase={phase} notice={result?.notice ?? null} fallback={fallback} skeleton={skeleton} headingAs={headingAs} />;
}
