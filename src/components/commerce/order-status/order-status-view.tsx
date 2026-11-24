"use client";

import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from "react";
import { Clock, Lock, RefreshCw, ShieldCheck, Users, WifiOff } from "lucide-react";
import { MotionConfig } from "motion/react";
import { DownloadLink } from "@/components/checkout/download-button";
import { Button, ButtonLink } from "@/components/ui/button";
import { Alert, Card } from "@/components/ui/primitives";
import type { CustomerOrderStatus } from "@/lib/customer-status";
import type { ReturnHint } from "@/lib/checkout-return";
import { fetchOrderStatus, OrderRequestError, removeBrowserAccess } from "@/lib/api/order-status";
import { ticketTypeLine } from "@/lib/ticket-validity";
import { cn, formatDateLong } from "@/lib/utils";
import { rememberBookingForInquiry } from "@/lib/inquiry-handoff";
import { CancellationPanel } from "./cancellation-panel";
import {
  cartFingerprint,
  clearCheckoutDraft,
  clearPaymentHandoff,
  PAYMENT_SETTLED_STATES,
  readCheckoutDraft,
  readPaymentHandoff,
  shouldClearPaidCart,
} from "@/lib/checkout-draft";
import { useOptionalApp } from "@/components/providers/app-provider";
import { resumePayment } from "@/lib/resume-payment";
import { OrderStatus } from "./order-status-tracker";
import { AnimatedTicket } from "./ticket-confirmation-card";
import {
  announcementFor,
  documentLinkText,
  downloadableItems,
  formatMinor,
  lockedVoucherItems,
  pollDelay,
  remedyText,
  stateLabel,
  statusSignature,
  STEP_STATUS_TEXT,
  timelineRows,
  toneForState,
} from "./presenters";
import { RecoveryForm } from "./recovery-form";
import { StatePill } from "./state-pill";
import { DubaiTime } from "./status-timeline";
import { SupportLink } from "./support";
import { TicketList } from "./ticket-list";

type Connection = "ok" | "offline" | "rate_limited" | "lost_access";

/**
 * The customer order status page body (doc 22 §23 B5, PRD-17).
 *
 * Renders the server projection it is given, and nothing it was not given:
 * headline and next step as text, then the one action that state needs
 * (checkout redesign batch 1): "Download voucher" when the voucher is ready
 * and this viewer may download it; "Send me a code" (the existing order-bound
 * recovery, in place) when it is ready but hidden from this browser (CO-02);
 * "Return to payment" while Stripe has not confirmed a payment and this tab
 * made it (CO-06, the same `POST /api/checkout`). Then a payment → booking →
 * voucher (→ refund) timeline, and per item its cancellation statement in the
 * quote's words (CO-01), the voucher list and the cancellation panel.
 *
 * While the projection says it can still change by itself (`pollAfterMs`),
 * this island refreshes it from `GET /api/orders/[reference]/status`. A
 * change of state is announced once in a polite live region; a failed
 * refresh keeps the last known state and shows a non-blocking notice, and
 * the next attempt backs off. A refresh that comes back 404 (the access on
 * this device ended) stops polling and says so; it never blanks the page.
 *
 * Checkout redesign batch 2: the header is the approved Order Status Tracker
 * (the headline as the page's one h1, the next step, the item and amount,
 * and a "Payment → Booking with the operator → Voucher" progress card, each
 * with its state in words from the projection's own steps; one row per
 * activity for a multi-item order), wrapped in `MotionConfig reducedMotion="user"`.
 * The download is the Download Button's look on a real link to the same document, under
 * the same `canDownload` decision; once a single-item booking is confirmed by
 * the operator, the Ticket Confirmation Card follows (no barcode; "Show the
 * voucher PDF at the meeting point" only once a voucher is listed; confetti
 * once per session, never with reduced motion).
 */
/** Whether the page is visible, from `visibilitychange`; the server render assumes it is. */
function subscribeVisibility(onChange: () => void): () => void {
  document.addEventListener("visibilitychange", onChange);
  return () => document.removeEventListener("visibilitychange", onChange);
}
function usePageVisible(): boolean {
  return useSyncExternalStore(
    subscribeVisibility,
    () => document.visibilityState !== "hidden",
    () => true,
  );
}

/** Booked by the operator: the states that show the confirmation card. */
const BOOKED_STATES: CustomerOrderStatus["state"][] = ["confirmed_ticket_pending", "confirmed"];

/** "14:43" in Dubai time. */
function dubaiClockOf(iso: string): string {
  const ms = Date.parse(iso);
  if (!Number.isFinite(ms)) return "";
  return new Intl.DateTimeFormat("en-GB", { timeZone: "Asia/Dubai", hour: "2-digit", minute: "2-digit", hour12: false }).format(new Date(ms));
}

/** Major units of a minor-unit string, or null when it is unreadable: never a wrong figure (as `formatMinor`). */
function majorOf(minor: string): number | null {
  return /^\d+$/.test(minor) ? Number(BigInt(minor)) / 100 : null;
}

export function OrderStatusView({ initial, returnHint = null }: { initial: CustomerOrderStatus; returnHint?: ReturnHint | null }) {
  const [status, setStatus] = useState(initial);
  const [announcement, setAnnouncement] = useState("");
  const [connection, setConnection] = useState<Connection>("ok");
  const [attempt, setAttempt] = useState(0);
  const [checking, setChecking] = useState(false);
  const previous = useRef<CustomerOrderStatus>(initial);
  const failures = useRef(0);
  const inFlight = useRef(false);
  const visible = usePageVisible();
  // Polling clock (CO-09): when the last refresh finished, and when the page last saw anything change.
  const lastFetchAt = useRef<number | null>(null);
  const lastChangeAt = useRef<number | null>(null);
  // A 429's Retry-After (review fix 6): the next refresh waits at least this long.
  const retryAfter = useRef<number | undefined>(undefined);

  const refresh = useCallback(async () => {
    if (inFlight.current) return;
    inFlight.current = true;
    setChecking(true);
    try {
      const next = await fetchOrderStatus(previous.current.reference);
      if (!next) {
        setConnection("lost_access");
        return;
      }
      const message = announcementFor(previous.current, next);
      if (message) setAnnouncement(message);
      if (statusSignature(next) !== statusSignature(previous.current)) lastChangeAt.current = Date.now();
      previous.current = next;
      failures.current = 0;
      retryAfter.current = undefined;
      setStatus(next);
      setConnection("ok");
    } catch (e) {
      failures.current += 1;
      retryAfter.current = e instanceof OrderRequestError ? e.retryAfterMs : undefined;
      setConnection(e instanceof OrderRequestError && e.kind === "rate_limited" ? "rate_limited" : "offline");
    } finally {
      inFlight.current = false;
      lastFetchAt.current = Date.now();
      setChecking(false);
      setAttempt((n) => n + 1);
    }
  }, []);

  // Poll while the server says the state can still change on its own (`pollAfterMs`, CO-09): at the
  // server's cadence, slower while nothing changes and after failures (`pollDelay`), and not at all while
  // the tab is hidden. Back in view, the wait already spent counts, so switching tabs never polls faster.
  useEffect(() => {
    if (!visible || status.pollAfterMs === null || connection === "lost_access") return;
    const now = Date.now();
    lastFetchAt.current ??= now;
    lastChangeAt.current ??= now;
    const delay = pollDelay(status.pollAfterMs, failures.current, now - lastChangeAt.current, { retryAfterMs: retryAfter.current, random: Math.random() });
    const timer = window.setTimeout(() => void refresh(), Math.max(0, delay - (now - lastFetchAt.current)));
    return () => window.clearTimeout(timer);
  }, [status, connection, attempt, refresh, visible]);

  // Back online: refresh at once instead of waiting out the back-off.
  useEffect(() => {
    const onOnline = () => {
      if (connection === "offline") void refresh();
    };
    window.addEventListener("online", onOnline);
    return () => window.removeEventListener("online", onOnline);
  }, [connection, refresh]);

  // Once the payment has arrived (or the order is over), this tab's checkout draft and hand-off are spent,
  // and the cart lines it paid for leave the cart (CO-19), only if the cart is still exactly those lines.
  const app = useOptionalApp();
  const cartLoaded = app ? app.hydrated : true;
  const cart = app?.cart;
  const clearCart = app?.clearCart;
  useEffect(() => {
    if (!PAYMENT_SETTLED_STATES.includes(status.state)) return;
    clearCheckoutDraft();
    // The cart loads from storage after the first render: decide on it (and spend the hand-off) once it has.
    if (!cartLoaded) return;
    const handoff = readPaymentHandoff();
    if (handoff?.reference !== status.reference) return;
    if (cart && clearCart && shouldClearPaidCart(handoff, status.reference, status.state, cartFingerprint(cart))) clearCart();
    clearPaymentHandoff();
  }, [status.state, status.reference, cartLoaded, cart, clearCart]);

  const downloads = downloadableItems(status);
  const allDocs = downloads.flatMap((i) => i.tickets.documents.map((doc) => ({ item: i, doc })));
  const locked = lockedVoucherItems(status);
  const remedy = status.deadlines.remedyAtUtc ? remedyText(status.deadlines.remedyKind, status.items.length > 1) : null;
  const multi = status.items.length > 1;
  const paidMajor = majorOf(status.totalMinor);
  const firstItem = status.items[0];
  const trackerItem = {
    imageUrl: "/brand/outlyy-mark.svg",
    name: multi ? `${status.items.length} activities` : (firstItem?.title ?? "Your booking"),
    details: multi
      ? status.items.map((i) => formatDateLong(i.serviceDate)).filter((d, n, all) => all.indexOf(d) === n).join(" · ")
      : firstItem
        ? [formatDateLong(firstItem.serviceDate), firstItem.timeslot, firstItem.paxLabel].filter(Boolean).join(" · ")
        : "",
    price: paidMajor,
  };
  // Single item: the projection's own steps, in the contract's words. Several: one row per activity.
  const trackerRows = multi
    ? status.items.map((i) => ({ label: i.title, value: stateLabel(i.state) }))
    : // Neutral row names ("Payment", "Booking with the operator", "Voucher") with the state in words, so a
      // row never reads as done when it is not (review fix 3).
      timelineRows(status.steps).map((row) => ({ label: row.title, value: STEP_STATUS_TEXT[row.step.status] }));
  // The confirmation card: a single item the operator has confirmed, with a start time to show.
  const ticketItem = !multi && BOOKED_STATES.includes(status.state) && firstItem?.timeslot && /^\d{2}:\d{2}$/.test(firstItem.timeslot) ? firstItem : null;
  const ticketDate = ticketItem ? new Date(`${ticketItem.serviceDate}T${ticketItem.timeslot}:00+04:00`) : null;
  // Doc 29 Batch 5: an open-dated ticket has no start time; the card shows the visit date, the validity and the download.
  const openTicketItem = !multi && !ticketItem && BOOKED_STATES.includes(status.state) && firstItem?.ticket ? firstItem : null;
  const openTicketDate = openTicketItem ? new Date(`${openTicketItem.serviceDate}T12:00:00+04:00`) : null;
  const openTicketDocs = openTicketItem ? allDocs.filter((d) => d.item.orderItemId === openTicketItem.orderItemId) : [];

  // After an unlock the "Send me a code" form is gone: focus moves to the download that replaced it.
  const focusDownloads = useRef(false);
  const downloadsRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (focusDownloads.current && allDocs.length > 0) {
      focusDownloads.current = false;
      downloadsRef.current?.focus();
    }
  }, [allDocs.length]);

  return (
    <div className="mx-auto max-w-3xl" data-testid="order-status-page">
      {/* One polite announcement per change of state (criterion 3). */}
      <p className="sr-only" role="status" aria-live="polite" aria-atomic="true" data-testid="status-announcer">
        {announcement}
      </p>

      {connection === "offline" && (
        <Alert
          tone="warning"
          className="mt-4"
          icon={<WifiOff className="h-4.5 w-4.5" />}
          title="We can't reach OUTLYY right now"
          action={
            <Button size="sm" variant="outline" loading={checking} loadingLabel="Checking…" onClick={() => void refresh()}>
              <RefreshCw className="h-4 w-4" aria-hidden="true" /> Check again
            </Button>
          }
        >
          This page shows the last status we loaded. We&apos;ll keep trying in the background.
        </Alert>
      )}
      {connection === "rate_limited" && (
        <Alert tone="warning" className="mt-4" title="Checking less often for a moment">
          This page shows the last status we loaded. We&apos;ll check again shortly.
        </Alert>
      )}
      {connection === "lost_access" && (
        <Alert
          tone="info"
          className="mt-4"
          title="This page can't update any more"
          action={
            <ButtonLink href="/manage-booking" size="sm" variant="outline">
              Find my booking
            </ButtonLink>
          }
        >
          Access to this booking on this device has ended, so the details below may be out of date. Confirm it is yours again to see
          the latest.
        </Alert>
      )}

      <section aria-label="Booking status" className="mt-2" data-testid="order-status" data-state={status.state}>
        {/* Framer Motion follows the visitor's reduced-motion setting only inside this (design contract). */}
        <MotionConfig reducedMotion="user">
          <OrderStatus
            className="p-0 sm:p-0"
            illustrationUrl="/brand/outlyy-mark.svg"
            statusTitle={status.headline}
            statusDescription={status.nextStep}
            item={trackerItem}
            summaryTitle={multi ? "Your activities" : "Progress"}
            summary={trackerRows}
            trackingStatus={`Ref ${status.reference} · updated ${dubaiClockOf(status.updatedAt)} Dubai time`}
            currency={status.currency}
          />
        </MotionConfig>

        {/* Doc 29 Batch 6 (owner decision d): the existing inquiry route, after an external hold too short to book online. */}
        {status.inquiryHref && (
          <div className="mx-auto mt-4 flex max-w-md justify-center" data-testid="send-to-team">
            <ButtonLink href={status.inquiryHref} size="sm" onClick={() => rememberBookingForInquiry(status.reference)}>
              Send it to our team
            </ButtonLink>
          </div>
        )}

        {allDocs.length > 0 && (
          <div
            ref={downloadsRef}
            tabIndex={-1}
            className="mx-auto mt-4 flex max-w-md flex-col gap-3 outline-none focus-visible:outline-3 focus-visible:outline-offset-2 focus-visible:outline-ink-800"
            data-testid="voucher-actions"
          >
            {allDocs.map(({ item, doc }) => {
              const fileId = `voucher-file-${doc.id}`;
              return (
                <div key={doc.id} className="space-y-1.5">
                  {/* A real link (review fix 5): the browser handles the file, a refused one shows its own
                      answer, it works without JavaScript and opens in a new tab. The route re-checks access. */}
                  <DownloadLink
                    href={doc.href}
                    rel="noreferrer"
                    className="w-full"
                    label={downloadLabel(doc.kind, allDocs.length > 1 ? item.title : null)}
                    aria-describedby={fileId}
                  />
                  <p id={fileId} className="text-sm text-ink-600">
                    {documentLinkText(doc, allDocs.map((d) => d.doc)).file}
                  </p>
                </div>
              );
            })}
          </div>
        )}
        {locked.length > 0 && (
          <div className="mx-auto max-w-md">
            <VoucherUnlock
              reference={status.reference}
              onUnlocked={() => {
                focusDownloads.current = true;
                void refresh();
              }}
            />
          </div>
        )}
        {status.state === "awaiting_payment" && (
          <div className="mx-auto max-w-md">
            <ReturnToPayment reference={status.reference} hint={returnHint} />
          </div>
        )}
        <p className="mx-auto mt-3 max-w-md text-xs text-ink-600">
          Last updated <DubaiTime iso={status.updatedAt} />
        </p>
      </section>

      {ticketItem && ticketDate && paidMajor !== null && (
        <section aria-label="Booking confirmation" className="mt-8 px-2" data-testid="booking-confirmation">
          <AnimatedTicket
            className="mx-auto"
            title={ticketItem.title}
            subtitle={
              status.steps.booking.at
                ? `Confirmed by the operator at ${dubaiClockOf(status.steps.booking.at)} Dubai time.`
                : "Confirmed by the operator."
            }
            ticketId={status.reference}
            amount={paidMajor}
            currency={status.currency}
            date={ticketDate}
            cardHolder={ticketItem.paxLabel}
            last4Digits="Where to go is on your voucher."
            icon={<Users aria-hidden="true" className="size-6 shrink-0 text-sun-700" />}
            // Only once this viewer has the voucher, and wherever the activity starts (review fix 4).
            barcodeValue={allDocs.length > 0 ? "Show the voucher PDF at the meeting point" : ""}
          />
        </section>
      )}

      {openTicketItem?.ticket && openTicketDate && paidMajor !== null && (
        <section aria-label="Booking confirmation" className="mt-8 px-2" data-testid="booking-confirmation">
          <AnimatedTicket
            className="mx-auto"
            title={openTicketItem.title}
            subtitle={
              status.steps.booking.at
                ? `Confirmed by the operator at ${dubaiClockOf(status.steps.booking.at)} Dubai time.`
                : "Confirmed by the operator."
            }
            ticketId={status.reference}
            amount={paidMajor}
            currency={status.currency}
            date={openTicketDate}
            dateOnly
            dateLabel="Visit date"
            cardHolder={openTicketItem.paxLabel}
            last4Digits="Show the tickets PDF at the entrance."
            icon={<Users aria-hidden="true" className="size-6 shrink-0 text-sun-700" />}
            barcodeValue=""
            details={<TicketFacts ticket={openTicketItem.ticket} />}
            action={
              openTicketDocs.length > 0 ? (
                <div className="flex flex-col gap-2" data-testid="ticket-card-download">
                  {openTicketDocs.map(({ doc }) => (
                    <DownloadLink key={doc.id} href={doc.href} rel="noreferrer" className="w-full" label={downloadLabel(doc.kind, null)} />
                  ))}
                </div>
              ) : null
            }
          />
        </section>
      )}

      {/* TKT-8 (doc 22 B5): the time the remedy runs by itself. It can still move when the saga's own
          deadline moves; a fixed time from authorisation needs a server change (CO-05, reported). */}
      {remedy && status.deadlines.remedyAtUtc && (
        <section aria-labelledby="deadlines-heading" className="mt-5">
          <h2 id="deadlines-heading" className="mb-2 text-xl">
            Deadline
          </h2>
          <p className="text-sm leading-relaxed text-ink-700" data-testid="remedy-deadline">
            <span className="font-bold text-ink-900">Confirmation deadline: </span>
            <DubaiTime iso={status.deadlines.remedyAtUtc} className="font-semibold text-ink-900" />. {remedy}
          </p>
        </section>
      )}

      <section aria-labelledby="items-heading" className="mt-6">
        <h2 id="items-heading" className="mb-3 text-xl">
          What you booked
        </h2>
        <ul className="space-y-4">
          {status.items.map((item, index) => {
            const ticketsHeading = `tickets-${index}`;
            return (
              <Card as="li" key={item.orderItemId} className="p-5">
                <div data-testid="order-item" data-item-state={item.state}>
                  <div className="flex flex-wrap items-start justify-between gap-2">
                    <h3 className="min-w-0 text-lg leading-snug">{item.title}</h3>
                    <StatePill state={item.state} tone={toneForState(item.state)} size="sm" />
                  </div>
                  <dl className="mt-3 grid grid-cols-1 gap-3 text-sm sm:grid-cols-3">
                    <div>
                      <dt className="text-2xs font-bold uppercase tracking-wide text-ink-500">Date</dt>
                      <dd className="font-semibold text-ink-900">{formatDateLong(item.serviceDate)}</dd>
                    </div>
                    {item.timeslot && (
                      <div>
                        <dt className="text-2xs font-bold uppercase tracking-wide text-ink-500">Time</dt>
                        <dd className="font-semibold text-ink-900">{item.timeslot}</dd>
                      </div>
                    )}
                    {/* Doc 29 §8.7: the pickup time the operator returned for this booking. */}
                    {item.pickup && (
                      <div data-testid="pickup-time">
                        <dt className="text-2xs font-bold uppercase tracking-wide text-ink-500">Pickup</dt>
                        <dd className="font-semibold text-ink-900">
                          <span className="tnum">{item.pickup.time}</span> Dubai time
                          {item.pickup.hotel ? <span className="block font-normal text-ink-700">{item.pickup.hotel}</span> : null}
                        </dd>
                      </div>
                    )}
                    <div>
                      <dt className="text-2xs font-bold uppercase tracking-wide text-ink-500">Guests</dt>
                      <dd className="font-semibold text-ink-900">{item.paxLabel}</dd>
                    </div>
                  </dl>
                  {item.cancellationTerms && (
                    <p className="mt-3 flex gap-2 text-sm text-ink-700" data-testid="cancellation-terms">
                      <ShieldCheck className="mt-0.5 h-4 w-4 shrink-0 text-lagoon-700" aria-hidden="true" />
                      <span>{item.cancellationTerms}</span>
                    </p>
                  )}
                  {/* Doc 29 Batch 6: an external supplier's booking says, in every state, that its confirmation can take a few minutes. */}
                  {item.externalConfirmation && (
                    <p className="mt-2 flex gap-2 text-sm text-ink-700" data-testid="external-confirmation">
                      <Clock className="mt-0.5 h-4 w-4 shrink-0 text-ink-500" aria-hidden="true" />
                      <span>{item.externalConfirmation}</span>
                    </p>
                  )}
                  {item.ticket && (item.ticket.validityCopy || item.ticket.types.length > 0 || item.ticket.validityConcern) && (
                    <div className="mt-2 space-y-1 text-sm text-ink-700" data-testid="ticket-validity">
                      {item.ticket.validUntil && item.ticket.validityCopy ? <time dateTime={item.ticket.validUntil}>{item.ticket.validityCopy}</time> : null}
                      {item.ticket.validityConcern ? <p className="text-ink-900">{item.ticket.validityConcern}</p> : null}
                      {item.ticket.types.length > 0 && (
                        <ul aria-label="Tickets issued" className="list-disc pl-5">
                          {item.ticket.types.map((t) => (
                            <li key={t.label}>{ticketTypeLine(t)}</li>
                          ))}
                        </ul>
                      )}
                    </div>
                  )}

                  <div className="mt-4 border-t border-dashed border-ink-300 pt-4">
                    <h4 id={ticketsHeading} className="text-[0.95rem] font-bold text-ink-900">
                      Voucher
                    </h4>
                    {item.pickup && (
                      <p className="mt-1 text-sm text-ink-700" data-testid="voucher-pickup">
                        Be ready for pickup at <span className="tnum font-semibold text-ink-900">{item.pickup.time}</span> Dubai time
                        {item.pickup.hotel ? <> at {item.pickup.hotel}</> : null}.
                      </p>
                    )}
                    <TicketList
                      tickets={item.tickets}
                      itemState={item.state}
                      canDownload={status.canDownload !== false}
                      headingId={ticketsHeading}
                      className="mt-1.5"
                    />
                  </div>

                  {item.cancellation.kind !== "none" && (
                    <div className="mt-4 border-t border-dashed border-ink-300 pt-4">
                      <h4 className="mb-1.5 text-[0.95rem] font-bold text-ink-900">Cancellation</h4>
                      <CancellationPanel
                        reference={status.reference}
                        orderItemId={item.orderItemId}
                        view={item.cancellation}
                        itemTitle={item.title}
                        onChanged={() => void refresh()}
                      />
                    </div>
                  )}
                </div>
              </Card>
            );
          })}
        </ul>
        <p className="mt-4 text-sm text-ink-700">
          Total <span className="font-bold tnum text-ink-900">{formatMinor(status.totalMinor, status.currency)}</span>
          <span className="text-ink-500">
            {" "}
            · placed <DubaiTime iso={status.placedAt} />
          </span>
        </p>
      </section>

      <Card className="mt-6 p-5">
        <h2 className="text-lg">Need help with this booking?</h2>
        <p className="mt-1.5 text-sm leading-relaxed text-ink-600">
          Message us with your reference and we&apos;ll look at it with you.
        </p>
        <div className="mt-3 flex flex-wrap gap-2">
          <SupportLink reference={status.reference} size="sm" />
          <ButtonLink href="/manage-booking" variant="outline" size="sm">
            Find another booking
          </ButtonLink>
        </div>
        {status.canRemoveBrowserAccess && <RemoveBrowserAccess reference={status.reference} />}
      </Card>
    </div>
  );
}

/** The download's visible name: tickets for a tickets PDF (doc 29 Batch 5), voucher otherwise; the activity when several files are listed. */
function downloadLabel(kind: "tickets_pdf" | "voucher_pdf", title: string | null): string {
  const base = kind === "tickets_pdf" ? "Download tickets" : "Download voucher";
  return title ? `${base}: ${title}` : base;
}

/** The ticket card's rows for an open-dated ticket: validity, the tickets per type (combo offers list each type), non-refundable. */
function TicketFacts({ ticket }: { ticket: NonNullable<CustomerOrderStatus["items"][number]["ticket"]> }) {
  return (
    <>
      {ticket.validUntil && ticket.validityCopy ? (
        <p>
          <time dateTime={ticket.validUntil}>{ticket.validityCopy}</time>
        </p>
      ) : null}
      {ticket.validityConcern ? <p className="text-ink-900">{ticket.validityConcern}</p> : null}
      {ticket.types.length > 0 && (
        <ul aria-label="Tickets issued" className="list-disc pl-5">
          {ticket.types.map((t) => (
            <li key={t.label}>{ticketTypeLine(t)}</li>
          ))}
        </ul>
      )}
      <p className="font-semibold text-ink-900">{ticket.nonRefundableCopy}</p>
    </>
  );
}

/**
 * Voucher ready, but this browser may not download it (CO-02): say so, and
 * start the existing order-bound recovery in place. The code goes only to the
 * order's verified contact; a correct code adds the same `download_tickets`
 * access as Find my booking, and the page refreshes to show the download. No
 * account, no document link before that.
 */
function VoucherUnlock({ reference, onUnlocked }: { reference: string; onUnlocked: () => void }) {
  const [open, setOpen] = useState(false);
  const [phone, setPhone] = useState<{ countryCode: string; phone: string } | undefined>(undefined);
  return (
    <div className="mt-4" data-testid="voucher-unlock">
      {open ? (
        <RecoveryForm
          unlock={{
            reference,
            phone,
            onRecovered: () => {
              setOpen(false);
              onUnlocked();
            },
          }}
        />
      ) : (
        <>
          <Button
            size="lg"
            className="w-full sm:w-auto"
            onClick={() => {
              const draft = readCheckoutDraft();
              setPhone(draft?.phone ? { countryCode: draft.countryCode, phone: draft.phone } : undefined);
              setOpen(true);
            }}
          >
            Send me a code
          </Button>
          <p className="mt-2 flex gap-2 text-sm text-ink-700">
            <Lock className="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" />
            We send a 6-digit code to the mobile number or email you booked with. No account or password needed.
          </p>
        </>
      )}
    </div>
  );
}

/**
 * "On a shared computer? Remove access on this browser." (checkout redesign
 * batch 3 security review). Asks once more before acting; the server revokes
 * this browser's checkout download grant, clears its access cookie and ends
 * its guest checkout session. Emailed links and the code to the booking's
 * phone keep working, so the customer can always get back in.
 */
function RemoveBrowserAccess({ reference }: { reference: string }) {
  const [phase, setPhase] = useState<"idle" | "confirm" | "busy" | "failed">("idle");
  const confirmRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (phase === "confirm" || phase === "failed") confirmRef.current?.focus();
  }, [phase]);

  const remove = async () => {
    setPhase("busy");
    try {
      await removeBrowserAccess();
      // This browser no longer sees the booking: the same address now shows the neutral page.
      window.location.replace(`/booking/${encodeURIComponent(reference)}`);
    } catch {
      setPhase("failed");
    }
  };

  return (
    <div className="mt-4 border-t border-dashed border-ink-300 pt-4 text-sm text-ink-700" data-testid="remove-browser-access">
      {phase === "idle" ? (
        <p>
          On a shared computer?{" "}
          <button type="button" className="font-semibold text-ink-900 underline underline-offset-2" onClick={() => setPhase("confirm")}>
            Remove access on this browser
          </button>
        </p>
      ) : (
        <div ref={confirmRef} tabIndex={-1} className="outline-none focus-visible:outline-3 focus-visible:outline-offset-2 focus-visible:outline-ink-800">
          <p>
            This browser will stop showing this booking and its voucher. You can still open it from the email we sent, or with a code
            sent to the phone you booked with.
          </p>
          {phase === "failed" && (
            <p className="mt-2" role="alert">
              We couldn&apos;t remove access just now. Try again in a moment.
            </p>
          )}
          <div className="mt-3 flex flex-wrap gap-2">
            <Button size="sm" variant="outline" loading={phase === "busy"} loadingLabel="Removing access…" onClick={() => void remove()}>
              Remove access
            </Button>
            <Button size="sm" variant="ghost" onClick={() => setPhase("idle")} disabled={phase === "busy"}>
              Keep it
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}

function noSubscription(): () => void {
  return () => {};
}

/**
 * While Stripe has not confirmed a payment (`awaiting_payment`), a customer
 * who left Stripe's page can go back to it (CO-06). Offered only in the tab
 * that started this payment (its hand-off record names this order), and it
 * repeats the same `POST /api/checkout`: the server hands back the same open
 * Stripe page, or says it has closed. It never starts a second payment.
 *
 * Batch 3 (CO-08): when Stripe sent the customer back through its cancel link
 * (`hint === "cancel"`), the block says so first and the button is the plain
 * "Return to payment". The hint only changes these words: the block appears
 * only while the server says `awaiting_payment` and this tab made the payment.
 */
function ReturnToPayment({ reference, hint = null }: { reference: string; hint?: ReturnHint | null }) {
  // Session storage, read on the client only: the server render never offers it.
  const available = useSyncExternalStore(
    noSubscription,
    () => readPaymentHandoff()?.reference === reference,
    () => false,
  );
  const [busy, setBusy] = useState(false);
  const [outcome, setOutcome] = useState<"closed" | "failed" | null>(null);
  const outcomeRef = useRef<HTMLDivElement>(null);

  // The button that was pressed may be gone: the message that replaced it takes focus.
  useEffect(() => {
    if (outcome) outcomeRef.current?.focus();
  }, [outcome]);

  if (!available && !outcome) return null;

  const go = async () => {
    const handoff = readPaymentHandoff();
    if (!handoff || handoff.reference !== reference) return setOutcome("closed");
    setBusy(true);
    setOutcome(null);
    const r = await resumePayment(handoff);
    if (r.kind === "redirect") {
      window.location.assign(r.url);
      return;
    }
    setBusy(false);
    if (r.kind === "closed") clearPaymentHandoff();
    setOutcome(r.kind);
  };

  return (
    <div className="mt-4" data-testid="return-to-payment">
      {outcome === "closed" ? (
        <div ref={outcomeRef} tabIndex={-1} className="outline-none focus-visible:outline-3 focus-visible:outline-offset-2 focus-visible:outline-ink-800">
          {/* The server refused the old page; that says nothing about money, which may still arrive. */}
          <Alert
            tone="info"
            title="That payment page can no longer be used."
            action={
              <ButtonLink href="/checkout" size="sm" variant="outline">
                Back to checkout
              </ButtonLink>
            }
          >
            If you paid on it, don&apos;t pay again: this page shows the payment as soon as Stripe confirms it. If you didn&apos;t, check
            the price again at checkout; your details are kept.
          </Alert>
        </div>
      ) : (
        <>
          {hint === "cancel" && (
            <p className="mb-2 text-sm leading-relaxed text-ink-700" data-testid="left-payment-note">
              You left Stripe&apos;s payment page. If you didn&apos;t pay there, you can go back to the same page.
            </p>
          )}
          <Button variant={hint === "cancel" ? "primary" : "outline"} loading={busy} loadingLabel="Opening the payment page…" onClick={() => void go()}>
            {hint === "cancel" ? "Return to payment" : "I left without paying: return to payment"}
          </Button>
          {outcome === "failed" && (
            <div ref={outcomeRef} tabIndex={-1} className="mt-2 text-sm text-ink-700 outline-none" role="status">
              We couldn&apos;t open the payment page just now. Try again in a moment.
            </div>
          )}
        </>
      )}
    </div>
  );
}
