/*
 * Booking Progress Card, adapted from 21st.dev's File Transfer Card.
 * Author: ravikatiyar162. Source: https://21st.dev/@ravikatiyar162/components/file-transfer-card
 * (demo id 8728), retrieved 27 Nov 2026 through the connected 21st.dev MCP
 * (`get_component` 8728). The unedited source is kept beside the other
 * imports: docs/21st-dev/vendor/file-transfer-card.tsx.txt.
 * Licence: the owner's 21st.dev Pro licence (owner statement, 25 Nov 2026).
 *
 * Imported as served, then adapted for post-payment batch A6 (owner approval
 * 27 Nov 2026; 90-approval-package.md §3 A6 and §7; 20-status-ui.md §3.3, §6):
 *   - structure kept: one card; a top row of "from → to" (here the booking
 *     reference → the activity and its date, Dubai calendar day), the
 *     connector of three dots between them, a progress section with its bar
 *     and one line of text, then a details block of label/value rows;
 *   - the percentage bar became an indeterminate bar: nothing knows how long
 *     the payment, the operator or the voucher will take, so there is no
 *     percentage, no countdown, no estimated time and no rate. The bar is
 *     decorative (`aria-hidden`), runs only while the page is still checking
 *     (`active`) and is hidden under reduced motion; the line under it says,
 *     in words, which milestone the booking is on;
 *   - the "Transfer details" rows became the milestones from the projection's
 *     own steps (`progressMilestones` in presenters.ts): checking payment,
 *     payment received with its time, operator confirmation with its time,
 *     tickets or voucher ready. Each row says its state in words; the disc is
 *     decorative. An ordered list, not a nested card (the inner Card became
 *     a tone step, bg-shell);
 *   - removed: the Pause and Cancel buttons (nothing to pause or cancel), the
 *     transfer rate and estimated time rows, the device icons and the WiFi
 *     glyph, and the "Your transfer is encrypted and secure" footer (a claim
 *     the page cannot stand behind here);
 *   - no new dependency: shadcn Card, Button and Progress
 *     (@radix-ui/react-progress) are replaced by the app's own markup and a
 *     CSS bar (globals.css `progress-indeterminate`); lucide icons as before;
 *   - OUTLYY tokens: paper card, 1px ink-200 edge, radius --radius-card, ink
 *     text, shell details block, lagoon bar (trust colour), semantic discs;
 *   - not a live region: the page's one polite region announces changes
 *     (`announcementFor`); this card never takes focus.
 */
import * as React from "react";
import { CalendarDays, Check, Circle, Clock, Minus, ReceiptText, X } from "lucide-react";
import { cn } from "@/lib/utils";
import { isoForTimeElement } from "@/lib/customer-status";
import { currentMilestone, dubaiClock, type Milestone, type MilestoneState } from "./presenters";

export interface BookingProgressCardProps {
  /** The order reference, e.g. "OUT-123456". */
  reference: string;
  /** The activity, or "3 activities". */
  activity: string;
  /** The activity's day (or days), already in words. */
  dateText: string;
  milestones: Milestone[];
  /** Whether the page is still checking by itself (the projection's `pollAfterMs`): the bar runs only then. */
  active: boolean;
  className?: string;
}

const DISC: Record<MilestoneState, string> = {
  done: "bg-[var(--color-success-bg)] text-[var(--color-success)]",
  current: "bg-[var(--color-info-bg)] text-[var(--color-info)]",
  failed: "bg-[var(--color-danger-bg)] text-[var(--color-danger)]",
  waiting: "bg-ink-100 text-ink-500",
  skipped: "bg-ink-100 text-ink-500",
};

const ICON: Record<MilestoneState, React.ReactNode> = {
  done: <Check className="h-3.5 w-3.5" />,
  current: <Clock className="h-3.5 w-3.5" />,
  failed: <X className="h-3.5 w-3.5" />,
  waiting: <Circle className="h-3 w-3" />,
  skipped: <Minus className="h-3.5 w-3.5" />,
};

export const BookingProgressCard = ({ reference, activity, dateText, milestones, active, className }: BookingProgressCardProps) => {
  const now = currentMilestone(milestones);
  const running = active && now !== null;
  return (
    <section
      aria-labelledby="booking-progress-title"
      className={cn("w-full max-w-md mx-auto overflow-hidden rounded-[var(--radius-card)] border border-ink-200 bg-paper text-ink-900", className)}
      data-testid="booking-progress"
    >
      <div className="p-4 sm:p-6">
        <h2 id="booking-progress-title" className="text-center text-lg font-semibold">
          Booking progress
        </h2>

        {/* Booking → activity (the source's "Sending from → Sending to" row). */}
        <div className="mt-5 grid grid-cols-[minmax(0,1fr)_auto_minmax(0,1fr)] items-start gap-2 text-center text-sm">
          <div className="flex min-w-0 flex-col items-center gap-1.5">
            <ReceiptText className="h-7 w-7 text-ink-500" aria-hidden="true" />
            <span className="text-xs text-ink-600">Booking</span>
            <p className="font-semibold tnum break-all">{reference}</p>
          </div>
          <div className="flex items-center gap-1 pt-3" aria-hidden="true">
            {[0, 1, 2].map((n) => (
              <span
                key={n}
                className={cn("h-1 w-1 rounded-full bg-lagoon-600", running && "motion-safe:animate-pulse")}
                style={running ? { animationDelay: `${(n - 2) * 150}ms` } : undefined}
              />
            ))}
          </div>
          <div className="flex min-w-0 flex-col items-center gap-1.5">
            <CalendarDays className="h-7 w-7 text-ink-500" aria-hidden="true" />
            <span className="text-xs text-ink-600">{dateText || "Activity"}</span>
            <p className="font-semibold break-words [overflow-wrap:anywhere]">{activity}</p>
          </div>
        </div>

        {/* The bar says only "still going"; the words under it say where. */}
        <div className="mt-6">
          {running && (
            <div className="relative h-2 w-full overflow-hidden rounded-full bg-ink-100 motion-reduce:hidden" aria-hidden="true" data-testid="progress-bar">
              <div className="progress-indeterminate absolute inset-y-0 left-0 w-2/5 rounded-full bg-lagoon-600" />
            </div>
          )}
          <p className="mt-2 text-center text-sm text-ink-700" data-testid="progress-now">
            {now ? (
              <>
                Now: <span className="font-semibold text-ink-900">{now.title}</span>
              </>
            ) : (
              "Every step is done."
            )}
          </p>
        </div>

        {/* Milestones (the source's "Transfer details" rows): the projection's own steps, in order. */}
        <ol className="mt-5 space-y-3 rounded-[var(--radius-card)] bg-shell p-4 text-sm">
          {milestones.map((m) => (
            <li key={m.key} className="flex gap-3" data-milestone={m.key} data-state={m.state} aria-current={m.state === "current" ? "step" : undefined}>
              <span className={cn("mt-0.5 flex h-6 w-6 shrink-0 items-center justify-center rounded-full", DISC[m.state])} aria-hidden="true">
                {ICON[m.state]}
              </span>
              <div className="min-w-0 flex-1">
                <p className="flex flex-wrap items-baseline justify-between gap-x-3">
                  <span className="font-semibold text-ink-900">{m.title}</span>
                  <span className="text-ink-600">
                    {m.at && dubaiClock(m.at) ? (
                      <time dateTime={isoForTimeElement(m.at)} className="tnum">
                        {dubaiClock(m.at)} Dubai time
                      </time>
                    ) : (
                      m.stateText
                    )}
                  </span>
                </p>
                {m.at && dubaiClock(m.at) ? <span className="sr-only">{m.stateText}. </span> : null}
                {m.detail && <p className="mt-0.5 text-ink-700">{m.detail}</p>}
              </div>
            </li>
          ))}
        </ol>
      </div>
    </section>
  );
};
