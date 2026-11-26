"use client";

import { useRouter } from "next/navigation";
import { useEffect, useId, useRef, useState } from "react";
import { CalendarDays, Check, Lock, ShieldCheck } from "lucide-react";
import { useApp } from "@/components/providers/app-provider";
import { Button } from "@/components/ui/button";
import { DatePickerSheet, DateStrip, GuestSelector, TimeSlots } from "./pickers";
import { TimeSlotPicker } from "./time-slot-picker";
import { PaymentMethods } from "./trust";
import { WhatsAppButton } from "./whatsapp";
import { ConfirmFirstNote, IndicativePriceNote, ResponsePromise } from "./inquiry-ui";
import { track } from "@/lib/analytics";
import { ctaFor } from "@/lib/cta";
import { computeBreakdown, guestOptionSwitch, guestRowsFor, toCartItem, variantById } from "@/lib/pricing";
import { guestRowAges, paxForAges } from "@/lib/pax-ages";
import { fetchStartTimes, type StartTimesAnswer } from "@/lib/api/start-times";
import { dateOnlyStartView } from "@/lib/start-time-retry";
import { startMark } from "@/lib/perf-mark";
import { useAbortableRead } from "@/lib/use-abortable-read";
import type { Activity, PaxCount } from "@/lib/types";
import { EMPTY_PAX, TICKET_NON_REFUNDABLE_STATEMENT, cancellationPolicyBeforeQuote, cn, dubaiToday, formatDateKey, paxBillable, priceIn } from "@/lib/utils";

/**
 * BookingWidget — the ADP's conversion engine, now mode-aware.
 *
 * `activity.fulfilmentMode` decides one thing (pivot plan §2.1, §4.4):
 *
 *   inquiry → no availability call, price labelled indicative, primary CTA
 *             "Check availability & price" → cart → /inquiry. No "spots left",
 *             no price-lock timer, no instant-confirmation claim.
 *   instant → "Book now" → /checkout. Availability, cutoff and the price are
 *             checked by the server quote when the visitor continues
 *             (PRD-1, PRD-6); the widget no longer shows invented sold-out
 *             marks or spot counts from the old deterministic mock.
 *
 * Both rails keep equal weight in both modes: "Ask on WhatsApp" is identical,
 * so a mixed catalogue renders coherently. The instant path is gated, not
 * deleted — flipping a SKU brings it back with no code change (§8.1 item 5).
 *
 * The two objection-handling lines beside the CTA ("why can't I just book",
 * "how long will this take") come straight from §3.4.
 *
 * Start times (doc 29 Batch 2). An instant product asks
 * `/api/catalog/start-times` for the chosen date (one abortable read per
 * date, kept for a minute). When its offer sells as listed starts, the
 * answer's times replace the stored chips in the Time Slot Picker, with
 * their availability marks; any other answer, a failure or a busy budget
 * keeps the stored chips, and the quote decides as before. Guest rows follow
 * the offer: no Seniors row without a senior price (owner decision 5).
 * `retimeItemId` (from checkout's "Choose another time") restores that cart
 * line, says its time is gone and moves focus to the times; the new choice
 * replaces the line.
 */
export function BookingWidget({
  activity,
  className,
  compact,
  initialDate,
  retimeItemId,
}: {
  activity: Activity;
  className?: string;
  compact?: boolean;
  initialDate?: string;
  /** A cart line whose start time the quote refused (`retimeHrefFor`, src/lib/start-time-retry.ts). */
  retimeItemId?: string;
}) {
  const router = useRouter();
  const { currency, addToCart, removeFromCart, cart, toast } = useApp();
  const inquiryMode = activity.fulfilmentMode !== "instant";
  const cta = ctaFor(activity.fulfilmentMode, { quoteOnly: activity.quoteOnly });

  // Service dates are Dubai calendar days (PRD-18), whatever the visitor's own time zone.
  const [date, setDate] = useState(initialDate ?? dubaiToday());
  const [time, setTime] = useState<string | undefined>(activity.timeSlots[0]);
  const [pax, setPax] = useState<PaxCount>(EMPTY_PAX);
  const [variantId, setVariantId] = useState(
    variantById(activity)?.id ?? activity.variants[0]?.id,
  );
  const [addOnIds, setAddOnIds] = useState<string[]>([]);
  const [dateOpen, setDateOpen] = useState(false);

  const [submitting, setSubmitting] = useState(false);
  /** Why the times need the visitor's attention: the cart line's time is gone, or no time is chosen yet. */
  const [timeNotice, setTimeNotice] = useState<string | null>(null);
  const timesRef = useRef<HTMLDivElement>(null);
  const [focusTimes, setFocusTimes] = useState(false);
  const timesUid = useId();
  const timeLabelId = `${timesUid}-label`;
  const timeNoticeId = `${timesUid}-notice`;

  // Checkout sent the visitor back because the quote refused this line's start time: restore the line once.
  const retimeItem = retimeItemId ? cart.find((i) => i.id === retimeItemId && i.slug === activity.slug && i.kind === "activity") : undefined;
  const [restored, setRestored] = useState<string | null>(null);
  // The option the guest rows' ages were last read for (review 102 N4-02); see `guestOptionSwitch` below.
  const [ageNotice, setAgeNotice] = useState<string | null>(null);
  const [agesVariant, setAgesVariant] = useState(variantId);
  if (retimeItem && restored !== retimeItem.id) {
    setRestored(retimeItem.id);
    setDate(retimeItem.date);
    setPax(retimeItem.pax);
    // A restored line's guests were chosen on its own option: not an option switch, so no ages notice (re-review R1).
    if (retimeItem.variantId) {
      setVariantId(retimeItem.variantId);
      setAgesVariant(retimeItem.variantId);
    }
    setAgeNotice(null);
    setAddOnIds(retimeItem.addOnIds);
    setTime(undefined);
    // Neutral: the quote also refuses a start with fewer seats than the party, not only a sold-out one.
    setTimeNotice(`The ${retimeItem.time} start can't be booked for your group on ${formatDateKey(retimeItem.date)}. Choose another time.`);
    setFocusTimes(true);
  }

  // Guest rows follow the offer (owner decision 5): no Seniors row without a senior price.
  const guestRows = guestRowsFor(activity, variantId);
  // Ages follow the selected option (doc 30 N4, D22): its own child and infant ages, else the page's.
  const guestAges = guestRowAges(variantById(activity, variantId));
  // Review 102 N4-02, N4-06: switching option says when the ages behind a count already set change, or a row closes;
  // a closed row's count is dropped from the party itself, so switching back never brings it back unseen.
  const sw = guestOptionSwitch(activity, agesVariant, variantId, pax);
  if (sw) {
    setAgesVariant(variantId);
    setAgeNotice(sw.notice);
    if (sw.pax !== pax) setPax(sw.pax);
  }
  const shownPax: PaxCount = paxForAges(guestRows.includes("senior") || pax.senior === 0 ? pax : { ...pax, senior: 0 }, guestAges);

  // Listed start times for the date (Batch 2). Inquiry products never ask: their times are preferences.
  const readKey = !inquiryMode && activity.productId && variantId ? `${activity.productId}|${variantId}|${date}` : null;
  const startTimes = useAbortableRead<StartTimesAnswer>(readKey, async (signal) => {
    const done = startMark("times_for_date");
    try {
      return await fetchStartTimes({ productId: activity.productId!, variantId: variantId!, date }, signal);
    } finally {
      done();
    }
  });
  const listed = startTimes.status === "ready" && startTimes.data.source === "supplier" ? startTimes.data : null;
  // Doc 29 Batch 7 (owner decision c): a date-only offer with one start on this date. Its time, when a real one, is shown before payment.
  const dateOnlyAnswer = startTimes.status === "ready" && startTimes.data.source === "date_only" ? startTimes.data : null;
  // Review 92 B7-11, B7-13: never shown as a pickup time; a date the quote would refuse, or the start just refused, blocks.
  const dateOnlyView = dateOnlyAnswer
    ? dateOnlyStartView({
        startsAt: dateOnlyAnswer.startsAt,
        status: dateOnlyAnswer.status,
        pickup: activity.pickupIncluded,
        date,
        retime: retimeItem ? { date: retimeItem.date, time: retimeItem.time } : null,
      })
    : null;
  const dateOnlyStart = dateOnlyAnswer && dateOnlyView && !dateOnlyView.blocked ? (dateOnlyAnswer.startsAt ?? undefined) : undefined;
  // Once this variant answered with listed starts, later dates show the picker's own loading state.
  // Keyed by variant: another variant that is simply not listed shows its stored times with no "live times" line.
  const [listedVariant, setListedVariant] = useState<string | null>(null);
  if (listed && variantId && listedVariant !== variantId) setListedVariant(variantId);
  const listedProduct = !!variantId && listedVariant === variantId;
  const pickerTimes = listed
    ? listed.times.map((t) => ({ time: t.time, status: t.status }))
    : null;
  const pickerLoading = listedProduct && startTimes.status === "loading";
  const usableTime = (t: string | undefined) => !!t && !!pickerTimes?.some((x) => x.time === t && (x.status === "available" || x.status === "limited"));
  // With listed times on screen, only a time they offer counts as chosen; while a date's times load, none does.
  // Without listed times, only one of the page's own times counts: a time picked from another date's listed starts
  // never carries over to a date that lists none (doc 29 Batch 7: a date-only offer shows times only on some dates).
  const chosenTime = pickerLoading ? undefined : pickerTimes ? (usableTime(time) ? time : undefined) : time !== undefined && activity.timeSlots.includes(time) ? time : undefined;
  // The live times could not be read (busy, unavailable, an error); a variant that is not listed is not a fallback.
  const timesFellBack =
    listedProduct && (startTimes.status === "error" || (startTimes.status === "ready" && startTimes.data.source === "stored" && startTimes.data.reason !== "not_listed"));

  useEffect(() => {
    // Wait for this date's answer, so focus lands on the times that will stay on screen.
    if (!focusTimes || startTimes.status === "loading") return;
    const el = timesRef.current;
    // No times on screen (every one unusable): drop the request, so a later date does not pull focus.
    if (!el) {
      setFocusTimes(false);
      return;
    }
    el.scrollIntoView({ block: "center" });
    // Onto the time to choose (the checked one, else the first usable), not the group around it.
    const target =
      el.querySelector<HTMLElement>('[role="radio"][tabindex="0"]') ??
      el.querySelector<HTMLElement>('button[aria-pressed="true"]') ??
      el.querySelector<HTMLElement>("button:not([disabled])") ??
      el;
    target.focus({ preventScroll: true });
    setFocusTimes(false);
  }, [focusTimes, startTimes.status]);

  const breakdown = computeBreakdown(activity, shownPax, variantId, addOnIds);
  const variant = variantById(activity, variantId);

  const proceed = async () => {
    // Listed times on screen, or a line sent back for a new time: a time must be chosen, never assumed.
    // A date-only date the quote would refuse, or the start just refused: another date must be chosen.
    if (dateOnlyView?.blocked) {
      setFocusTimes(true);
      return;
    }
    // A date-only date with one start needs no choice, even for a line sent back for a new time.
    if (!chosenTime && (pickerTimes || pickerLoading || (retimeItem && !dateOnlyAnswer))) {
      setTimeNotice("Choose a start time first.");
      setFocusTimes(true);
      return;
    }
    setSubmitting(true);
    const item = toCartItem(activity, {
      date,
      time: chosenTime ?? dateOnlyStart ?? activity.timeSlots[0] ?? "Flexible",
      pax: shownPax,
      variantId,
      addOnIds,
    });
    // A line sent back from checkout is replaced, not duplicated.
    if (retimeItem && retimeItem.id !== item.id) removeFromCart(retimeItem.id);
    addToCart(item);

    if (inquiryMode) {
      track("inquiry_item_added", {
        activity_slug: activity.slug,
        tier: activity.tier,
        value: item.total.inr,
        currency: "INR",
        selected_date: date,
        fulfilment_mode: "inquiry",
      });
    } else {
      track("checkout_started", {
        activity_slug: activity.slug,
        tier: activity.tier,
        value: item.total.inr,
        currency: "INR",
        selected_date: date,
        rail: "self_serve",
        fulfilment_mode: "instant",
      });
    }
    toast({
      tone: "success",
      title: inquiryMode ? "Added to your inquiry" : "Added to your trip",
      body: `${activity.title} · ${formatDateKey(date)}`,
      action: { label: "View trip", href: "/cart" },
    });
    router.push(cta.route);
  };

  /* Tier D — quote only (AC-ADP-06). Unchanged by the pivot. */
  if (activity.quoteOnly) {
    return (
      <div
        className={cn(
          "rounded-[var(--radius-tile)] border border-ink-200 bg-paper p-5 shadow-[var(--shadow-lift)]",
          className,
        )}
      >
        <p className="text-xs font-bold uppercase tracking-wide text-ink-500">From</p>
        <p className="font-display text-3xl font-bold tnum text-ink-900">
          {priceIn(activity.price.adult, currency)}
        </p>
        <p className="mt-2 text-sm leading-relaxed text-ink-600">
          Priced per booking, not per person, so the honest number depends on your date, group and
          route. Send us the details and you&apos;ll have a firm all-in quote within two hours during
          working hours.
        </p>
        <div className="mt-4 space-y-2">
          <Button block size="lg" onClick={() => router.push(`/concierge?sku=${activity.slug}`)}>
            Request a quote
          </Button>
          <WhatsAppButton
            block
            size="lg"
            context={{
              intent: "concierge",
              activityTitle: activity.title,
              activityUrl: `https://outlyy.com/activities/${activity.slug}`,
              placement: "adp_quote",
            }}
            label="Speak to a trip designer"
          />
        </div>
        <p className="mt-3 flex items-center gap-1.5 text-xs text-ink-500">
          <ShieldCheck className="h-3.5 w-3.5 text-lagoon-500" />
          A named coordinator handles the booking end to end.
        </p>
      </div>
    );
  }

  return (
    <div
      className={cn(
        "rounded-[var(--radius-tile)] border border-ink-200 bg-paper shadow-[var(--shadow-lift)]",
        className,
      )}
    >
      <div className="border-b border-ink-200 p-5">
        <div className="flex items-end justify-between gap-3">
          <div>
            <p className="text-xs font-bold uppercase tracking-wide text-ink-500">
              {inquiryMode ? "Indicative total" : paxBillable(shownPax) > 1 ? "Total for your group" : "Total"}
              {paxBillable(shownPax) > 1 && inquiryMode ? ` · ${paxBillable(shownPax)} guests` : ""}
            </p>
            <p className="font-display text-3xl font-bold tnum text-ink-900">
              {priceIn(breakdown.total, currency)}
            </p>
            <p className="mt-0.5 text-xs font-semibold text-[var(--color-success)]">
              All taxes and fees included
            </p>
          </div>
          {breakdown.savings && breakdown.savings.inr > 0 && (
            <div className="rounded-[var(--radius-control)] bg-sunset-50 px-3 py-2 text-right">
              <p className="text-2xs font-bold uppercase tracking-wide text-sunset-600">You save</p>
              <p className="font-display text-lg font-bold tnum text-sunset-600">
                {priceIn(breakdown.savings, currency)}
              </p>
            </div>
          )}
        </div>
        {inquiryMode && <IndicativePriceNote className="mt-2" />}
      </div>

      <div className="space-y-5 p-5">
        {/* Variants */}
        {activity.variants.length > 1 && (
          <fieldset>
            <legend className="mb-2 text-sm font-bold text-ink-900">Choose your option</legend>
            <div className="space-y-2">
              {activity.variants.map((v) => {
                const selected = v.id === variantId;
                return (
                  <label
                    key={v.id}
                    className={cn(
                      "flex cursor-pointer gap-3 rounded-[var(--radius-control)] border p-3 transition-colors",
                      selected ? "border-ink-900 bg-shell" : "border-ink-200 hover:border-ink-400",
                      v.soldOut && "cursor-not-allowed opacity-50",
                    )}
                  >
                    <input
                      type="radio"
                      name="variant"
                      value={v.id}
                      checked={selected}
                      disabled={v.soldOut}
                      onChange={() => {
                        setVariantId(v.id);
                        track("variant_selected", {
                          activity_slug: activity.slug,
                          filters: v.name,
                        });
                      }}
                      className="mt-1 h-4 w-4 shrink-0 accent-ink-900"
                    />
                    <span className="min-w-0 flex-1">
                      <span className="flex flex-wrap items-baseline justify-between gap-2">
                        <span className="text-sm font-bold text-ink-900">{v.name}</span>
                        <span className="text-sm font-bold tnum text-ink-700">
                          {v.delta.inr === 0
                            ? "Included"
                            : `+${priceIn(v.delta, currency)}${v.isPrivate ? "" : " pp"}`}
                        </span>
                      </span>
                      <span className="mt-0.5 block text-xs leading-snug text-ink-600">
                        {v.blurb}
                      </span>
                      {v.accessibilityNote && (
                        <span className="mt-1 block text-xs font-semibold text-[var(--color-success)]">
                          {v.accessibilityNote}
                        </span>
                      )}
                    </span>
                  </label>
                );
              })}
            </div>
          </fieldset>
        )}

        {/* Date: no availability marks in either mode until a real calendar
            exists (PRD-6); nothing is asserted that has not been checked. */}
        <div>
          <div className="mb-2 flex items-center justify-between">
            <p className="text-sm font-bold text-ink-900">
              {inquiryMode ? "Preferred date" : "Pick a date"}
            </p>
            <button
              type="button"
              onClick={() => setDateOpen(true)}
              className="flex items-center gap-1.5 text-xs font-bold text-sun-700 underline underline-offset-2"
            >
              <CalendarDays className="h-3.5 w-3.5" />
              Open calendar
            </button>
          </div>
          <DateStrip value={date} onChange={setDate} />
          {inquiryMode ? (
            <p className="mt-2 text-xs text-ink-500">
              Not fixed yet? Pick your best guess, you can mark dates flexible on the next step.
            </p>
          ) : (
            <p className="mt-2 text-xs text-ink-500">
              We check live availability and the final price for this date when you continue. Nothing is charged before you confirm.
            </p>
          )}
          {/* Doc 29 §3.5 "valid-until note" (review 86 B5-03): the page has no live stock read, so the validity is stated, not guessed. */}
          {activity.openDatedTicket ? (
            <p className="mt-1.5 text-xs text-ink-500" data-testid="ticket-date-note">
              Tickets are valid until a date the operator sets. If your visit date is later, we say so when you continue, before anything is charged.
            </p>
          ) : null}
        </div>

        {/* ---- Time: the supplier's listed starts for the date when the offer sells that way
            (Batch 2), otherwise the listing's slots with no availability claims ---- */}
        {dateOnlyView && !pickerTimes && (dateOnlyView.line || dateOnlyView.note) ? (
          <div ref={dateOnlyView.blocked ? timesRef : undefined} tabIndex={dateOnlyView.blocked ? -1 : undefined} className="outline-none" data-testid="date-only-start">
            {dateOnlyView.line ? (
              dateOnlyView.blocked ? (
                <p role="status" className="rounded-[var(--radius-control)] bg-sun-50 p-3 text-xs font-semibold leading-relaxed text-sun-800">
                  {dateOnlyView.line}
                </p>
              ) : (
                <p className="text-sm text-ink-900">
                  <span className="font-bold">{dateOnlyView.line}</span> <span className="text-ink-600">Dubai time</span>
                </p>
              )
            ) : null}
            {dateOnlyView.note ? <p className="mt-1 text-xs text-ink-600">{dateOnlyView.note}</p> : null}
          </div>
        ) : null}
        {pickerTimes || pickerLoading ? (
          <div>
            <p id={timeLabelId} className="mb-2 text-sm font-bold text-ink-900">
              {activity.pickupIncluded ? "Pickup time" : "Start time"}
            </p>
            <TimeNotice id={timeNoticeId} text={timeNotice} />
            <TimeSlotPicker
              date={date}
              slots={pickerTimes ?? []}
              loading={pickerLoading}
              value={chosenTime}
              groupRef={timesRef}
              labelledBy={timeLabelId}
              describedBy={timeNotice ? timeNoticeId : undefined}
              onValueChange={(t) => {
                setTime(t);
                setTimeNotice(null);
                track("time_selected", { selected_time: t });
              }}
              note={
                startTimes.slow ? (
                  <p className="text-xs text-ink-600">This is taking longer than usual. You can still continue, or ask us on WhatsApp.</p>
                ) : listed ? (
                  <p className="text-xs text-ink-500">
                    Checked with the operator at <span className="tnum">{asOfDubai(listed.checkedAt)}</span>. We check this time again before you pay.
                  </p>
                ) : null
              }
            />
          </div>
        ) : (
          activity.timeSlots.length > 1 && (
            <div>
              <p id={timeLabelId} className="mb-2 text-sm font-bold text-ink-900">
                {inquiryMode
                  ? activity.pickupIncluded ? "Preferred pickup time" : "Preferred start time"
                  : activity.pickupIncluded ? "Pickup time" : "Start time"}
              </p>
              <TimeNotice id={timeNoticeId} text={timeNotice} />
              <div
                ref={timesRef}
                role="group"
                aria-labelledby={timeLabelId}
                aria-describedby={timeNotice ? timeNoticeId : undefined}
                tabIndex={-1}
                className="outline-none"
              >
                <TimeSlots
                  slots={activity.timeSlots.map((t) => ({ time: t, status: "available" }))}
                  value={time}
                  onChange={(t) => {
                    setTime(t);
                    setTimeNotice(null);
                  }}
                />
              </div>
              {timesFellBack && (
                <p className="mt-2 text-xs text-ink-500">Live times aren&apos;t available right now. We check your time with the operator when you continue.</p>
              )}
            </div>
          )
        )}

        {/* Guests: rows follow the offer (owner decision 5) */}
        <div>
          <p className="mb-1 text-sm font-bold text-ink-900">Guests</p>
          <GuestSelector
            value={shownPax}
            onChange={(next) => {
              setPax(next);
              setAgeNotice(null);
            }}
            rows={guestRows}
            ages={guestAges}
            notice={ageNotice}
          />
        </div>

        {/* Add-ons */}
        {activity.addOns.length > 0 && (
          <fieldset>
            <legend className="mb-2 text-sm font-bold text-ink-900">
              {inquiryMode ? "Interested in adding" : "Add to your booking"}
            </legend>
            <div className="space-y-2">
              {activity.addOns.map((a) => {
                const checked = addOnIds.includes(a.id);
                return (
                  <label
                    key={a.id}
                    className={cn(
                      "flex cursor-pointer items-start gap-3 rounded-[var(--radius-control)] border p-3 transition-colors",
                      checked ? "border-ink-900 bg-shell" : "border-ink-200 hover:border-ink-400",
                    )}
                  >
                    <input
                      type="checkbox"
                      checked={checked}
                      onChange={() =>
                        setAddOnIds((prev) =>
                          prev.includes(a.id) ? prev.filter((x) => x !== a.id) : [...prev, a.id],
                        )
                      }
                      className="mt-0.5 h-4 w-4 shrink-0 rounded accent-ink-900"
                    />
                    <span className="min-w-0 flex-1">
                      <span className="flex flex-wrap items-baseline justify-between gap-2">
                        <span className="text-sm font-bold text-ink-900">{a.name}</span>
                        <span className="text-sm font-bold tnum text-ink-700">
                          {a.price.inr === 0 ? "Free" : `+${priceIn(a.price, currency)}`}
                        </span>
                      </span>
                      <span className="mt-0.5 block text-xs leading-snug text-ink-600">
                        {a.description}
                      </span>
                    </span>
                  </label>
                );
              })}
            </div>
          </fieldset>
        )}

        {/* Breakdown */}
        {!compact && (
          <div className="rounded-[var(--radius-control)] bg-shell p-3.5">
            <ul className="space-y-1.5 text-sm">
              {breakdown.lines.map((line, i) => (
                <li key={`${line.label}-${i}`} className="flex justify-between gap-3">
                  <span className="text-ink-600">
                    {line.label}
                    {line.detail && (
                      <span className="block text-2xs text-ink-500">
                        {line.unit ? `${priceIn(line.unit, currency)} ` : ""}
                        {line.detail}
                      </span>
                    )}
                  </span>
                  <span className="shrink-0 font-semibold tnum text-ink-900">
                    {line.amount.inr === 0 ? "Free" : priceIn(line.amount, currency)}
                  </span>
                </li>
              ))}
            </ul>
            <div className="mt-2.5 flex justify-between border-t border-ink-200 pt-2.5 text-[0.95rem] font-bold">
              <span>{inquiryMode ? "Indicative total" : "Total"}</span>
              <span className="tnum">{priceIn(breakdown.total, currency)}</span>
            </div>
          </div>
        )}

        {/* CTAs, both rails, equal weight, in both modes */}
        <div className="space-y-2">
          <Button
            block
            size="lg"
            loading={submitting}
            loadingLabel={inquiryMode ? "Adding…" : "Adding to your trip…"}
            onClick={proceed}
          >
            {cta.primary}
          </Button>
          <WhatsAppButton
            block
            size="lg"
            context={{
              intent: paxBillable(shownPax) >= 5 ? "group" : "activity",
              activityTitle: `${activity.title}${variant ? `, ${variant.name}` : ""}`,
              activityUrl: `https://outlyy.com/activities/${activity.slug}`,
              date: formatDateKey(date),
              time: chosenTime,
              pax: shownPax,
              priceLabel: priceIn(breakdown.total, currency),
              placement: "adp_widget",
            }}
          />
        </div>

        <div className="space-y-2 text-xs text-ink-600">
          {inquiryMode ? (
            <>
              <ResponsePromise />
              <ConfirmFirstNote />
            </>
          ) : null}
          <p className="flex items-start gap-1.5">
            <Check className="mt-0.5 h-3.5 w-3.5 shrink-0 text-[var(--color-success)]" />
            {activity.openDatedTicket
              ? // Doc 29 §4.4 (review 86 B5-03): issued tickets are never refunded, in either mode.
                TICKET_NON_REFUNDABLE_STATEMENT
              : activity.freeCancellationHours <= 0
                ? "This booking is non-refundable once confirmed."
                : inquiryMode
                  ? `Free cancellation up to ${activity.freeCancellationHours} hours before you go.`
                  : // Instant: before a quote, the catalogue figure as the operator's policy; the quote's
                    // exact statement replaces it at review (CO-01, the same words as the trip and checkout).
                    cancellationPolicyBeforeQuote(activity.freeCancellationHours)}
          </p>
          {inquiryMode ? (
            <div className="pt-1">
              <p className="mb-1 text-2xs font-bold uppercase tracking-wide text-ink-500">When you pay</p>
              <PaymentMethods />
            </div>
          ) : (
            // Instant products are paid by card on Stripe's page only (CO-12): no UPI or wallet marks here.
            <p className="flex items-center gap-1.5">
              <Lock className="h-3.5 w-3.5 shrink-0 text-lagoon-500" />
              Pay by card on Stripe&apos;s secure page.
            </p>
          )}
        </div>
      </div>

      <DatePickerSheet
        open={dateOpen}
        onClose={() => setDateOpen(false)}
        value={date}
        onChange={setDate}
      />
    </div>
  );
}

/** `HH:mm` in Dubai for an "as of" line; the visitor's own clock never decides it. */
/**
 * Why the times need attention. The live region stays mounted (empty when
 * there is nothing to say), so a notice is announced when its text arrives;
 * the radio group also points at it with `aria-describedby`.
 */
function TimeNotice({ id, text }: { id: string; text: string | null }) {
  return (
    <div role="status" aria-live="polite">
      {text ? (
        <p id={id} className="mb-2 rounded-[var(--radius-control)] bg-sun-50 p-3 text-xs font-semibold leading-relaxed text-sun-800">
          {text}
        </p>
      ) : null}
    </div>
  );
}

function asOfDubai(iso: string): string {
  return new Date(iso).toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit", hour12: false, timeZone: "Asia/Dubai" });
}

/**
 * Sticky mobile bar. Content changes with mode (pivot §2.1 Mobile row: the
 * interaction model is already right; only the copy changes).
 */
export function StickyBookingBar({ activity }: { activity: Activity }) {
  const { currency } = useApp();
  const [visible, setVisible] = useState(false);
  const cta = ctaFor(activity.fulfilmentMode, { quoteOnly: activity.quoteOnly });

  useEffect(() => {
    const onScroll = () => setVisible(window.scrollY > 520);
    onScroll();
    window.addEventListener("scroll", onScroll, { passive: true });
    return () => window.removeEventListener("scroll", onScroll);
  }, []);

  return (
    <div
      className={cn(
        "fixed inset-x-0 bottom-0 z-40 border-t border-ink-200 bg-paper/97 px-4 pb-[max(0.75rem,env(safe-area-inset-bottom))] pt-3 shadow-[var(--shadow-sticky)] backdrop-blur transition-transform duration-200 lg:hidden",
        visible ? "translate-y-0" : "translate-y-full",
      )}
    >
      <div className="flex items-center gap-3">
        <div className="min-w-0 flex-1">
          <p className="truncate text-2xs font-semibold text-ink-500">
            {activity.quoteOnly ? "From" : "From, all-in"}
          </p>
          <p className="font-display text-lg font-bold leading-tight tnum text-ink-900">
            {priceIn(activity.price.adult, currency)}
            <span className="ml-1 text-2xs font-medium text-ink-500">per adult</span>
          </p>
        </div>
        <WhatsAppButton
          size="md"
          label="Ask"
          context={{
            intent: "activity",
            activityTitle: activity.title,
            activityUrl: `https://outlyy.com/activities/${activity.slug}`,
            placement: "sticky_bar",
          }}
        />
        <Button
          size="md"
          onClick={() => {
            document.getElementById("book")?.scrollIntoView({ behavior: "smooth", block: "start" });
          }}
        >
          {cta.primaryShort}
        </Button>
      </div>
    </div>
  );
}
