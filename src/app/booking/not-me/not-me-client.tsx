"use client";

import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { Alert, Card } from "@/components/ui/primitives";
import { disputeAccountLink, SignInError } from "@/lib/api";
import { tokenFromHash } from "@/app/t/token";

/**
 * The "This was not me" landing (Group B). The token is read from the
 * fragment once, kept in memory only and removed from the address bar; it is
 * sent only when the person presses the button, so a mail scanner that opens
 * the link changes nothing. The server answers the same for a valid, used or
 * expired link, so the page says what happens without claiming which.
 */
type State = "ready" | "missing" | "sending" | "done" | "failed" | "limited";

export function NotMeLanding() {
  const token = useRef<string | null>(null);
  const [state, setState] = useState<State>("ready");

  useEffect(() => {
    const found = tokenFromHash(window.location.hash);
    if (window.location.hash) window.history.replaceState(window.history.state, "", window.location.pathname);
    token.current = found;
    if (!found) setState("missing");
  }, []);

  const send = async () => {
    if (!token.current) return;
    setState("sending");
    try {
      await disputeAccountLink(token.current);
      token.current = null;
      setState("done");
    } catch (err) {
      setState(err instanceof SignInError && err.reason === "RATE_LIMITED" ? "limited" : "failed");
    }
  };

  return (
    <Card className="mx-auto max-w-lg p-5 sm:p-6">
      <h1 className="text-2xl">Remove this booking from an account</h1>
      {state === "done" ? (
        <div className="mt-3 space-y-3 text-[0.95rem] leading-relaxed text-ink-700">
          <Alert tone="success" role="status">
            Done. If this link was still valid, the booking is no longer in that account, and our team has been told.
          </Alert>
          <p>Your own booking links and emails keep working. If anything looks wrong, reply to the booking email and we will look into it.</p>
          <Link href="/manage-booking" className="font-bold text-sun-700 underline underline-offset-2">
            Find my booking
          </Link>
        </div>
      ) : state === "missing" ? (
        <div className="mt-3 space-y-3">
          <Alert tone="warning">This link is incomplete. Open it again from the email, or reply to that email and we will remove the booking for you.</Alert>
        </div>
      ) : (
        <div className="mt-3 space-y-4 text-[0.95rem] leading-relaxed text-ink-700">
          <p>We emailed you because a booking made with your email was added to an OUTLYY account. If you did not sign in to that account, remove the booking from it here.</p>
          <p>The booking itself is not cancelled, and your booking links keep working. Our team will check the account.</p>
          {state === "failed" && <Alert tone="danger">We couldn&apos;t do that just now. Try again in a moment.</Alert>}
          {state === "limited" && <Alert tone="warning">Too many tries from this connection. Wait a few minutes and try again.</Alert>}
          <Button type="button" block size="lg" variant="danger" loading={state === "sending"} loadingLabel="Removing…" onClick={() => void send()}>
            This was not me: remove it
          </Button>
        </div>
      )}
    </Card>
  );
}
