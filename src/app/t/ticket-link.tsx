"use client";

import { useRouter } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import { Ticket } from "lucide-react";
import { Button, ButtonLink } from "@/components/ui/button";
import { Alert, Card, Skeleton } from "@/components/ui/primitives";
import { exchangeTicketToken, OrderRequestError } from "@/lib/api/order-status";
import { tokenFromHash } from "./token";

type Phase = "starting" | "ready" | "opening" | "missing" | "invalid" | "rate_limited" | "unreachable" | "opened_no_reference";

/**
 * The `/t` landing (TKT-5, F39).
 *
 *  1. On mount: read `location.hash`, keep the token in memory only (a ref,
 *     never state, storage or a URL), and remove it from the address bar
 *     with `history.replaceState`, so it is not left in history, a bookmark
 *     or a screenshot of the address bar.
 *  2. Nothing is sent until the visitor presses "Open my booking". Then, and
 *     only then, the token is POSTed to `/api/tickets/exchange`
 *     (same-origin, cookies) and the browser moves to `/booking/<reference>`.
 *  3. An expired or invalid link gets a plain message and the recovery
 *     route (`/manage-booking`).
 *
 * No analytics, no prefetch of the exchange, no auto-submit.
 */
export function TicketLinkLanding() {
  const router = useRouter();
  const token = useRef<string | null>(null);
  const read = useRef(false);
  const [phase, setPhase] = useState<Phase>("starting");
  const headingRef = useRef<HTMLHeadingElement>(null);
  const firstRender = useRef(true);

  useEffect(() => {
    // Strict mode runs effects twice; the fragment is read and removed once.
    if (read.current) return;
    read.current = true;
    const found = tokenFromHash(window.location.hash);
    if (window.location.hash) {
      window.history.replaceState(window.history.state, "", `${window.location.pathname}${window.location.search}`);
    }
    token.current = found;
    setPhase(found ? "ready" : "missing");
  }, []);

  // Move focus to the new heading when the outcome changes (not on first paint).
  useEffect(() => {
    if (firstRender.current) {
      firstRender.current = false;
      return;
    }
    if (phase !== "starting" && phase !== "ready" && phase !== "opening") headingRef.current?.focus();
  }, [phase]);

  const open = async () => {
    const value = token.current;
    if (!value || phase === "opening") return;
    setPhase("opening");
    try {
      const result = await exchangeTicketToken(value);
      if (!result.ok) {
        token.current = null;
        setPhase("invalid");
        return;
      }
      token.current = null;
      if (!result.reference) {
        setPhase("opened_no_reference");
        return;
      }
      router.replace(`/booking/${encodeURIComponent(result.reference)}`);
    } catch (e) {
      setPhase(e instanceof OrderRequestError && e.kind === "rate_limited" ? "rate_limited" : "unreachable");
    }
  };

  if (phase === "starting") {
    return (
      <div className="mx-auto max-w-xl">
        <Skeleton className="h-56 w-full rounded-[var(--radius-tile)]" />
      </div>
    );
  }

  if (phase === "ready" || phase === "opening" || phase === "unreachable" || phase === "rate_limited") {
    return (
      <div className="mx-auto max-w-xl">
        <Card className="p-6 sm:p-8">
          <span aria-hidden="true" className="mb-4 flex h-12 w-12 items-center justify-center rounded-full bg-sun-100 text-sun-600">
            <Ticket className="h-6 w-6" />
          </span>
          <h1 ref={headingRef} tabIndex={-1} className="text-[1.75rem] outline-none sm:text-3xl">
            Open your booking
          </h1>
          <p className="mt-2 text-[0.95rem] leading-relaxed text-ink-600">
            This link opens your booking on this device. Press the button to continue.
          </p>
          {phase === "unreachable" && (
            <Alert tone="warning" className="mt-4" title="We couldn't reach OUTLYY">
              Check your connection and press the button again. A link can be opened a few times, so trying again is safe.
            </Alert>
          )}
          {phase === "rate_limited" && (
            <Alert tone="warning" className="mt-4" title="Too many attempts">
              Wait a few minutes, then press the button again.
            </Alert>
          )}
          <Button
            size="lg"
            block
            className="mt-6"
            loading={phase === "opening"}
            loadingLabel="Opening your booking…"
            onClick={() => void open()}
            data-testid="open-booking"
          >
            Open my booking
          </Button>
        </Card>
      </div>
    );
  }

  if (phase === "opened_no_reference") {
    return (
      <div className="mx-auto max-w-xl">
        <Card className="p-6 sm:p-8">
          <h1 ref={headingRef} tabIndex={-1} className="text-[1.75rem] outline-none sm:text-3xl">
            Your link worked
          </h1>
          <p className="mt-2 text-[0.95rem] leading-relaxed text-ink-600">
            We couldn&apos;t open the booking page from here. Find your booking with its reference and the phone number or email you
            booked with.
          </p>
          <ButtonLink href="/manage-booking" size="lg" className="mt-6">
            Find my booking
          </ButtonLink>
        </Card>
      </div>
    );
  }

  // missing or invalid
  return (
    <div className="mx-auto max-w-xl">
      <Card className="p-6 sm:p-8" >
        <h1 ref={headingRef} tabIndex={-1} className="text-[1.75rem] outline-none sm:text-3xl">
          This link has expired or isn&apos;t valid
        </h1>
        <p className="mt-2 text-[0.95rem] leading-relaxed text-ink-600">
          Booking links work for a limited time. You can still see your booking: confirm it is yours with its reference and the phone
          number or email you booked with, and we&apos;ll send you a code.
        </p>
        <div className="mt-6 flex flex-wrap gap-2">
          <ButtonLink href="/manage-booking" size="lg">
            Find my booking
          </ButtonLink>
          <ButtonLink href="/login?next=%2Faccount%2Fbookings" size="lg" variant="outline">
            Sign in to My trips
          </ButtonLink>
        </div>
      </Card>
    </div>
  );
}
