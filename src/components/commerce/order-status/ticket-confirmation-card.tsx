/*
 * Ticket Confirmation Card, imported from 21st.dev.
 * Author: ravikatiyar162. Source: https://21st.dev/@ravikatiyar162/components/ticket-confirmation-card
 * (demo id 6492), retrieved 12 Nov 2026.
 * Licence: the owner holds a licence for this component (owner decision,
 * 12 Nov 2026). 21st.dev states no licence (empty field); the owner's licence
 * covers it.
 * Ported from the prototype's edited copy,
 * docs/checkout-redesign-review/components/ticket-confirmation-card/outly/component.tsx
 * (original: ../component.tsx in the same folder).
 *
 * Edits carried over from the prototype copy (recorded in components/SOURCES.md):
 *   - copy: heading and sub-line became props; labels "Reference", "Paid",
 *     "When (Dubai time)"; amount in AED; date in Asia/Dubai with the weekday;
 *     the payment-card row shows the meeting point through the component's
 *     existing `icon` prop (falls back to the original mark);
 *   - owner decision d: the barcode is replaced by the text passed as
 *     `barcodeValue` ("Show the voucher PDF at the jetty"); nothing scannable;
 *   - owner decision c: confetti once per page session (sessionStorage, module
 *     flag fallback), never with prefers-reduced-motion; OUTLYY colours;
 *   - typography: reference in tabular numerals instead of monospace;
 *   - approved structural edit (owner, 12 Nov 2026): the card heading is h2.
 * Edits for the app (docs/checkout-redesign-review/notes/batch2-components.md):
 *   - "use client"; the unused Barcode function is removed (nothing renders it);
 *   - copy (part B): `currency` prop (default "AED") instead of the fixed
 *     "AED " prefix, because an order can settle in INR;
 *   - review fixes (part B): confetti positions drawn once per mount
 *     (useState), not on every re-render; the barcode-replacement line and its
 *     dashed rule render only when `barcodeValue` is not empty;
 *     the once-per-session check (`confettiAllowed`) and its record
 *     (`markConfettiPlayed`, when the confetti starts, so StrictMode's double
 *     effect run cannot use it up) exported for their test;
 *   - typing: TicketProps omits the HTML `title` attribute, which clashed with
 *     the ReactNode `title` prop the prototype copy added;
 *   - brand colours: card = paper, text = ink-900, muted-foreground = ink-600,
 *     muted = shell, primary tint = sun-500/10 with sun-700 check, cut-outs =
 *     sand, dashed line = ink-200, shadow-lg = shadow-lift; radius = --radius-card;
 *   - entrance: the tw-animate-css classes (animate-in fade-in-0 zoom-in-95 /
 *     zoom-in-50 / zoom-in-75, durations and delays) are written with the app's
 *     own `pop-in` keyframe (fade + scale from 94%) at the same 500 ms
 *     durations and 300 / 500 ms delays; the app's reduced-motion rule stops it.
 */
"use client";

import * as React from "react";
import { cn } from "@/lib/utils";

// --- SVG Icons ---

const CheckCircleIcon = (props: React.SVGProps<SVGSVGElement>) => (
  <svg
    {...props}
    xmlns="http://www.w3.org/2000/svg"
    width="24"
    height="24"
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth="2"
    strokeLinecap="round"
    strokeLinejoin="round"
  >
    <path d="M22 11.08V12a10 10 0 1 1-5.93-9.14" />
    <polyline points="22 4 12 14.01 9 11.01" />
  </svg>
);

const MastercardIcon = (props: React.SVGProps<SVGSVGElement>) => (
    <svg
        {...props}
        xmlns="http://www.w3.org/2000/svg"
        viewBox="0 0 24 24"
        width="36"
        height="24"
    >
        <circle cx="8" cy="12" r="7" fill="#EA001B"></circle>
        <circle cx="16" cy="12" r="7" fill="#F79E1B" fillOpacity="0.8"></circle>
    </svg>
);


// --- Helper Components ---

const DashedLine = () => (
  <div
    className="w-full border-t-2 border-dashed border-ink-200"
    aria-hidden="true"
  />
);

const ConfettiExplosion = () => {
  const confettiCount = 100;
  const colors = ["#ff6a13", "#00a6a0", "#f02e63", "#f7b73f", "#3b3054", "#ffa564"];
  // Drawn once per mount (review fix, part B): the status page re-renders on every poll, and new
  // random positions each time would restart the pieces mid-fall.
  const [pieces] = React.useState(() =>
    Array.from({ length: confettiCount }, () => ({
      left: Math.random() * 100,
      top: -20 + Math.random() * 10,
      rotate: Math.random() * 360,
      duration: 2.5 + Math.random() * 2.5,
      delay: Math.random() * 2,
    })),
  );

  return (
    <>
      <style>
        {`
          @keyframes fall {
            0% {
                transform: translateY(-10vh) rotate(0deg);
                opacity: 1;
            }
            100% {
              transform: translateY(110vh) rotate(720deg);
              opacity: 0;
            }
          }
        `}
      </style>
      <div className="fixed inset-0 z-0 pointer-events-none" aria-hidden="true">
        {pieces.map((piece, i) => (
          <div
            key={i}
            className="absolute w-2 h-4"
            style={{
              left: `${piece.left}%`,
              top: `${piece.top}%`,
              backgroundColor: colors[i % colors.length],
              transform: `rotate(${piece.rotate}deg)`,
              animation: `fall ${piece.duration}s ${piece.delay}s linear forwards`,
            }}
          />
        ))}
      </div>
    </>
  );
};


// Once per page session, and never with reduced motion (owner decision c).
// Checked when the card mounts, but recorded only when the confetti actually
// starts (follow-up D): under React StrictMode the mount effect runs twice and
// the first run's timer is cancelled, so recording on the check would mean it
// never played.
let confettiPlayedThisLoad = false;
const CONFETTI_KEY = "outlyy-confetti-played";

export function confettiAllowed(): boolean {
  if (typeof window === "undefined") return false;
  if (window.matchMedia?.("(prefers-reduced-motion: reduce)").matches) return false;
  if (confettiPlayedThisLoad) return false;
  try {
    if (window.sessionStorage.getItem(CONFETTI_KEY) === "1") return false;
  } catch {
    /* storage blocked: the module flag still limits it to once per load */
  }
  return true;
}

export function markConfettiPlayed(): void {
  confettiPlayedThisLoad = true;
  try {
    window.sessionStorage.setItem(CONFETTI_KEY, "1");
  } catch {
    /* storage blocked */
  }
}

// --- Main Ticket Component ---

export interface TicketProps extends Omit<React.HTMLAttributes<HTMLDivElement>, "title"> {
  ticketId: string;
  amount: number;
  date: Date;
  cardHolder: string;
  last4Digits: string;
  barcodeValue: string;
  icon?: React.ReactNode;
  title?: React.ReactNode;
  subtitle?: React.ReactNode;
  /** Currency code printed before the amount (copy edit, part B: INR orders exist). */
  currency?: string;
}

const AnimatedTicket = React.forwardRef<HTMLDivElement, TicketProps>(
  (
    {
      className,
      ticketId,
      amount,
      date,
      cardHolder,
      last4Digits,
      barcodeValue,
      icon,
      title = "Your booking is confirmed",
      subtitle = "Confirmed by the operator",
      currency = "AED",
      ...props
    },
    ref
  ) => {
    const [showConfetti, setShowConfetti] = React.useState(false);

    React.useEffect(() => {
      if (!confettiAllowed()) return;
      const mountTimer = setTimeout(() => {
        markConfettiPlayed();
        setShowConfetti(true);
      }, 100);
      const unmountTimer = setTimeout(() => setShowConfetti(false), 6000);
      return () => {
        clearTimeout(mountTimer);
        clearTimeout(unmountTimer);
      };
    }, []);

    const formattedAmount = `${currency} ${amount.toFixed(2)}`;

    const formattedDate = new Intl.DateTimeFormat("en-GB", {
      timeZone: "Asia/Dubai",
      weekday: 'short',
      day: 'numeric',
      month: 'short',
      year: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
      hour12: false
    }).format(date).replace(/,(?=[^,]*$)/, ' ·');

    return (
      <>
        {showConfetti && <ConfettiExplosion />}
        <div
          ref={ref}
          className={cn(
            "relative w-full max-w-sm bg-paper text-ink-900 rounded-[var(--radius-card)] shadow-lift font-sans z-10",
            "animate-[pop-in_500ms_var(--ease-out-soft)_both]",
            className
          )}
          {...props}
        >
          {/* Ticket cut-out effect */}
          <div className="absolute -left-4 top-1/2 -translate-y-1/2 w-8 h-8 rounded-full bg-sand" />
          <div className="absolute -right-4 top-1/2 -translate-y-1/2 w-8 h-8 rounded-full bg-sand" />

          <div className="p-8 flex flex-col items-center text-center">
              <div className="p-3 bg-sun-500/10 rounded-full animate-[pop-in_500ms_var(--ease-out-soft)_300ms_both]">
                  <CheckCircleIcon className="w-10 h-10 text-sun-700 animate-[pop-in_500ms_var(--ease-out-soft)_500ms_both]" />
              </div>
              <h2 className="text-2xl font-semibold mt-4">{title}</h2>
              <p className="text-ink-600 mt-1">
                {subtitle}
              </p>
          </div>

          <div className="px-8 pb-8 space-y-6">
              <DashedLine />

              <div className="grid grid-cols-2 gap-4 text-left">
                  <div>
                      <p className="text-xs text-ink-600 uppercase">Reference</p>
                      <p className="font-medium tabular-nums">{ticketId}</p>
                  </div>
                  <div className="text-right">
                      <p className="text-xs text-ink-600 uppercase">Paid</p>
                      <p className="font-semibold text-lg tabular-nums whitespace-nowrap">{formattedAmount}</p>
                  </div>
              </div>

              <div>
                  <p className="text-xs text-ink-600 uppercase">When (Dubai time)</p>
                  <p className="font-medium tabular-nums">{formattedDate}</p>
              </div>

              <div className="bg-shell p-4 rounded-[var(--radius-card)] flex items-center space-x-4">
                  {icon ?? <MastercardIcon />}
                  <div>
                      <p className="font-semibold">{cardHolder}</p>
                      <p className="text-ink-600 text-sm">{last4Digits}</p>
                  </div>
              </div>

              {/* Barcode replaced (owner decision d): nothing scannable is drawn. The line is shown only
                  when the caller has something true to say there (review fix, part B). */}
              {barcodeValue ? (
                <>
                  <DashedLine />
                  <p className="py-2 text-center text-[0.9375rem] font-semibold text-ink-900">{barcodeValue}</p>
                </>
              ) : null}
          </div>
        </div>
      </>
    );
  }
);

AnimatedTicket.displayName = "AnimatedTicket";

export { AnimatedTicket };
