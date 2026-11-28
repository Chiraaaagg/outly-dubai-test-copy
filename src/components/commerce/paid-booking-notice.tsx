"use client";

import { useEffect, useState, type ReactNode } from "react";
import { CheckCircle2, Clock, Info } from "lucide-react";
import { ButtonLink, PrivateButtonLink } from "@/components/ui/button";
import { EmptyState } from "@/components/ui/primitives";
import { fetchOrderStatus } from "@/lib/api/order-status";
import { readPaidMarker, startPaidBookingCheck, type PaidBookingKind, type PaidBookingNotice } from "@/lib/paid-booking";

/**
 * The empty `/checkout` and `/cart` after a paid booking (production fix,
 * 28 Nov 2026; marker rules in src/lib/paid-booking.ts).
 *
 * When this tab's status page emptied a paid cart in the last 24 hours, the
 * page asks the server about that order before it says anything. While it
 * asks, the page's own skeleton shows. The server's answer decides the words
 * (`paidBookingNotice`: "paid" only when its payment step is done). In every
 * other case (no marker, an order this browser may not see, an unpaid order,
 * a failed request, or no answer within 8 seconds) the page's usual empty
 * state shows. A good answer that arrives after that still replaces it, and
 * nothing replaces the notice (`startPaidBookingCheck`).
 *
 * "View booking" is a full page load (`PrivateButtonLink`, PRV-4), so the
 * Google tag configured on this measured page never sees the reference.
 *
 * Accessibility: the title is a heading, at the same level as the page's own
 * empty state; focus is never moved. When a check runs, one polite status line
 * says what is happening, then what is shown: the booking, or the usual empty
 * state's title. No analytics here (PRV-4).
 */

type HeadingLevel = "h1" | "h2" | "h3";
/** `none`: no marker, so no check; `fallback`: a check ran and the usual empty state shows. */
export type PaidBookingPhase = "none" | "checking" | "notice" | "fallback";

const ICONS: Record<PaidBookingKind, ReactNode> = {
  confirmed: <CheckCircle2 className="h-6 w-6" />,
  completed: <CheckCircle2 className="h-6 w-6" />,
  partial: <Info className="h-6 w-6" />,
  confirming: <Clock className="h-6 w-6" />,
  recent: <Info className="h-6 w-6" />,
};

export function PaidBookingEmptyState({ notice, headingAs }: { notice: PaidBookingNotice; headingAs?: HeadingLevel }) {
  return (
    <EmptyState
      headingAs={headingAs}
      icon={ICONS[notice.kind]}
      title={notice.title}
      body={notice.body}
      action={<PrivateButtonLink href={notice.href}>View booking</PrivateButtonLink>}
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
  fallbackMessage,
  skeleton,
  headingAs,
}: {
  phase: PaidBookingPhase;
  notice: PaidBookingNotice | null;
  fallback: ReactNode;
  /** The usual empty state's title, announced when a check ends in it. */
  fallbackMessage: string;
  skeleton: ReactNode;
  headingAs?: HeadingLevel;
}) {
  const shown = phase === "notice" && notice ? notice : null;
  const message = phase === "checking" ? "Checking your recent booking." : shown ? shown.title : fallbackMessage;
  return (
    <>
      {phase !== "none" && (
        <p className="sr-only" role="status" aria-live="polite" aria-atomic="true" data-testid="paid-booking-status">
          {message}
        </p>
      )}
      {phase === "checking" ? skeleton : shown ? <PaidBookingEmptyState notice={shown} headingAs={headingAs} /> : fallback}
    </>
  );
}

/** The empty cart state, or the booking this tab just paid for, in the server's words. */
export function EmptyCartOrPaidBooking({
  fallback,
  fallbackMessage,
  skeleton,
  headingAs,
}: {
  fallback: ReactNode;
  fallbackMessage: string;
  skeleton: ReactNode;
  headingAs?: HeadingLevel;
}) {
  // Read once: this component mounts only on the client, once the cart has loaded and is empty. The pages key it
  // by the provider's `restored`, so a back-forward cache restore mounts it again and reads the marker afresh.
  const [marker] = useState(() => readPaidMarker());
  const [result, setResult] = useState<{ notice: PaidBookingNotice | null } | null>(null);

  useEffect(() => {
    if (!marker) return;
    return startPaidBookingCheck(marker, { fetchStatus: fetchOrderStatus, onResult: setResult });
  }, [marker]);

  const phase: PaidBookingPhase = !marker ? "none" : !result ? "checking" : result.notice ? "notice" : "fallback";
  return (
    <EmptyCartView
      phase={phase}
      notice={result?.notice ?? null}
      fallback={fallback}
      fallbackMessage={fallbackMessage}
      skeleton={skeleton}
      headingAs={headingAs}
    />
  );
}
