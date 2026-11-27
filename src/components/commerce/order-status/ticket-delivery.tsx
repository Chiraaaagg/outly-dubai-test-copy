"use client";

import { useEffect, useRef, useState } from "react";
import { Mail } from "lucide-react";
import { Button } from "@/components/ui/button";
import type { TicketDeliveryView } from "@/lib/customer-status";
import { isoForTimeElement } from "@/lib/customer-status";
import { cn } from "@/lib/utils";
import { deliveryText, dubaiClock, ORDER_WORD, resendWaitText, type OrderDocumentWord } from "./presenters";
import { resendTickets } from "./resend-tickets";

/**
 * Where the ticket email stands (post-payment A3), and "Email my tickets
 * again" (A4).
 *
 * The words follow `delivery.state` exactly: "sent" only once the provider
 * accepted the message, "delivered" only for a verified provider event. A
 * pending, failed or bounced email says what to do next; the downloads above
 * stay where they are. The recipient is the server's masked form only.
 *
 * The resend button is offered only when the server says this viewer may ask
 * (`canResend`), and it acknowledges at once: a busy label while asking, then
 * one uniform sentence. A limit (from the projection or a 429) disables it
 * with the time it opens again, in Dubai time, and it re-enables by itself at
 * that time. Messages go to the page's one polite live region (`onAnnounce`)
 * and are shown here as plain text; focus never moves.
 */
export function TicketDelivery({
  delivery,
  word,
  canDownload,
  reference,
  onAnnounce,
  onSent,
  onLostAccess,
}: {
  delivery: TicketDeliveryView;
  word: OrderDocumentWord;
  canDownload: boolean;
  reference: string;
  onAnnounce: (message: string) => void;
  onSent?: () => void;
  onLostAccess?: () => void;
}) {
  const text = deliveryText(delivery, word, canDownload);
  const noun = ORDER_WORD[word].noun;
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  const [localWait, setLocalWait] = useState<string | null>(null);
  // The clock is read on the client only (the server render follows the projection as given).
  const [now, setNow] = useState<number | null>(null);
  const inFlight = useRef(false);

  const serverWait = !delivery.canResend ? delivery.resendAvailableAt : null;
  const waits = [localWait, serverWait].filter((t): t is string => Boolean(t) && Number.isFinite(Date.parse(t!)));
  const until = now === null ? waits[0] ?? null : waits.filter((t) => Date.parse(t) > now).sort()[0] ?? null;
  // Offered when the server allows it, or when the only thing holding it back was a time that has passed.
  const offered = delivery.canResend || Boolean(serverWait) || Boolean(localWait);
  const waiting = until !== null;

  // Re-read the clock after mount and again when the earliest wait ends, so the button opens by itself.
  useEffect(() => {
    const next = until ? Math.max(0, Date.parse(until) - Date.now()) + 250 : 0;
    const t = window.setTimeout(() => setNow(Date.now()), Math.min(next, 2_147_000_000));
    return () => window.clearTimeout(t);
  }, [until]);

  const ask = async () => {
    if (inFlight.current || waiting) return;
    inFlight.current = true;
    setBusy(true);
    setNote(null);
    try {
      const r = await resendTickets(reference);
      let message: string;
      switch (r.kind) {
        case "sent":
          message = `We're emailing your ${noun} again${delivery.recipientMasked ? ` to ${delivery.recipientMasked}` : ""}. It can take a few minutes.`;
          setLocalWait(r.availableAt);
          onSent?.();
          break;
        case "limited":
          message = `You've asked for this email several times already. ${resendWaitText(r.availableAt)}`;
          setLocalWait(r.availableAt ?? new Date(Date.now() + 2 * 60_000).toISOString());
          break;
        case "nothing":
          message = `There's nothing to email yet. Your ${noun} appear${word === "voucher" ? "s" : ""} on this page when ready.`;
          break;
        case "gone":
          message = "This page can't send the email any more. Find your booking again to see the latest.";
          onLostAccess?.();
          break;
        default:
          message = "We couldn't reach OUTLYY just now. Try again in a moment.";
      }
      setNote(message);
      onAnnounce(message);
    } finally {
      inFlight.current = false;
      setBusy(false);
      setNow(Date.now());
    }
  };

  return (
    <div className="mx-auto mt-4 max-w-md rounded-[var(--radius-card)] bg-shell p-4 text-sm" data-testid="ticket-delivery" data-delivery-state={delivery.state}>
      <div className="flex gap-3">
        <Mail
          className={cn("mt-0.5 h-4.5 w-4.5 shrink-0", text.tone === "warning" ? "text-[var(--color-warning)]" : text.tone === "success" ? "text-[var(--color-success)]" : "text-ink-600")}
          aria-hidden="true"
        />
        <div className="min-w-0 flex-1">
          <p className="font-semibold text-ink-900 break-words [overflow-wrap:anywhere]" data-testid="delivery-line">
            {text.line}
            {delivery.at && dubaiClock(delivery.at) && (delivery.state === "sent" || delivery.state === "delivered") ? (
              <>
                {" "}
                <time dateTime={isoForTimeElement(delivery.at)} className="font-normal text-ink-600 tnum">
                  ({dubaiClock(delivery.at)} Dubai time)
                </time>
              </>
            ) : null}
          </p>
          {text.next && <p className="mt-1 text-ink-700">{text.next}</p>}

          {offered && (
            <div className="mt-3">
              <Button
                size="sm"
                variant="outline"
                loading={busy}
                loadingLabel="Asking…"
                disabled={waiting}
                aria-describedby={waiting ? "resend-wait" : undefined}
                onClick={() => void ask()}
                data-testid="resend-tickets"
              >
                Email my {noun} again
              </Button>
              {waiting && (
                <p id="resend-wait" className="mt-1.5 text-ink-600" data-testid="resend-wait">
                  {resendWaitText(until)}
                </p>
              )}
            </div>
          )}
          {note && (
            <p className="mt-2 text-ink-700" data-testid="resend-note">
              {note}
            </p>
          )}
        </div>
      </div>
    </div>
  );
}
