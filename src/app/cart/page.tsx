"use client";

import Link from "next/link";
import { useEffect, useMemo, useState } from "react";
import { AlertTriangle, Send, Sparkles, Trash2 } from "lucide-react";
import { useApp } from "@/components/providers/app-provider";
import { ActivityCard } from "@/components/commerce/activity-card";
import { WhatsAppButton, WhatsAppCard } from "@/components/commerce/whatsapp";
import { EmptyCartOrPaidBooking } from "@/components/commerce/paid-booking-notice";
import { ConfirmFirstNote, IndicativePriceNote, ResponsePromise } from "@/components/commerce/inquiry-ui";
import { cartGoesToInquiry } from "@/lib/pricing";
import { fetchFulfilmentModes } from "@/lib/api";
import { Alert, Breadcrumbs, Card, EmptyState, SectionHeading } from "@/components/ui/primitives";
import { Button, ButtonLink } from "@/components/ui/button";
import { Scene } from "@/components/ui/scene";
import { Badge } from "@/components/ui/badge";
import { useCatalog } from "@/lib/catalog/client";
import type { CartItem } from "@/lib/types";
import { cancellationPolicyBeforeQuote, formatDateKey, formatDateLong, formatDuration, paxLabel, priceIn } from "@/lib/utils";

/**
 * INQUIRY CART / TRIP BUILDER (PRD §5.5 → pivot plan §2.1 Cart row)
 *
 * Not a standard e-commerce cart. Persona A is buying an itinerary, not a
 * ticket — so this is a chronological trip timeline with time-conflict
 * detection (AC-CART-01) and at least one relevant upsell (AC-CART-02).
 *
 * Inquiry Mode changes three things and keeps the rest:
 *  - prices are labelled indicative. No price-hold timer in either mode:
 *    nothing holds a price until the checkout's server quote (10 minutes,
 *    from the review step), so a timer here would not be true (CO-18);
 *  - the CTA is "Send inquiry" → /inquiry, or "Continue to checkout" when
 *    every item is instant-mode and within the per-order item cap, the same
 *    rule /checkout applies (`cartGoesToInquiry`).
 *    Whether it can be paid is then the server's call (release switch,
 *    readiness, quote; doc 22 §32.34, CO-03);
 *  - the whole trip can be handed to WhatsApp in one tap.
 * Cart shape is unchanged, so it feeds either path.
 *
 * The mode stored with each cart item is a hint, never the decision (PRD-1):
 * on load the cart refreshes every item from the public modes endpoint and
 * tells the visitor when one changed or is no longer sold (PRD-26). The
 * server quote re-checks everything again before any payment.
 */
export default function CartPage() {
  const { cart, removeFromCart, updateCartItem, cartTotalINR, cartTotalAED, currency, hydrated, restored } = useApp();
  const { activities } = useCatalog();
  // The checkout's own rule (mixed carts and over-cap carts go to inquiry); no build-type gate (CO-03, doc 22 §32.34).
  const inquiry = cartGoesToInquiry(cart);
  const nextHref = inquiry ? "/inquiry" : "/checkout";
  const nextLabel = inquiry ? "Send inquiry" : "Continue to checkout";
  // Both figures are authored per currency; AED is never derived from INR (PRD-8).
  const totalMoney = { inr: cartTotalINR, aed: cartTotalAED };
  // PRD-21: instant items in a cart that goes to inquiry are confirmed with the rest, not instantly.
  const mixed = inquiry && cart.some((i) => i.fulfilmentMode === "instant");

  const [modeNotice, setModeNotice] = useState<{ changed: string[]; retired: string[] } | null>(null);
  useEffect(() => {
    if (!hydrated || cart.length === 0) return;
    let alive = true;
    fetchFulfilmentModes()
      .then((modes) => {
        if (!alive) return;
        const changed: string[] = [];
        const retired: string[] = [];
        for (const item of cart) {
          const mode = modes[item.slug];
          if (!mode) retired.push(item.title);
          else if (mode !== item.fulfilmentMode) {
            changed.push(item.title);
            updateCartItem(item.id, { fulfilmentMode: mode });
          }
        }
        setModeNotice(changed.length || retired.length ? { changed, retired } : null);
      })
      // Offline or rate-limited: keep the stored hints; the server re-checks before anything is charged.
      .catch(() => {});
    return () => {
      alive = false;
    };
    // Re-run when items are added or removed, not when a refresh above patches one.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [hydrated, cart.length]);

  const byDate = useMemo(() => {
    const map = new Map<string, CartItem[]>();
    [...cart]
      .sort((a, b) => a.date.localeCompare(b.date) || a.time.localeCompare(b.time))
      .forEach((item) => {
        map.set(item.date, [...(map.get(item.date) ?? []), item]);
      });
    return [...map.entries()];
  }, [cart]);

  // AC-CART-01 — two activities starting within the same window on one date.
  const conflicts = useMemo(() => {
    const out: string[] = [];
    byDate.forEach(([date, items]) => {
      if (items.length < 2) return;
      const hours = items.map((i) => parseInt(i.time.slice(0, 2), 10)).filter((n) => !Number.isNaN(n));
      for (let i = 0; i < hours.length; i++) {
        for (let j = i + 1; j < hours.length; j++) {
          if (Math.abs(hours[i] - hours[j]) < 4) {
            out.push(
              `${items[i].title} and ${items[j].title} both start around ${items[i].time} on ${formatDateLong(date)}.`,
            );
          }
        }
      }
    });
    return out;
  }, [byDate]);

  // AC-CART-02 — a relevant upsell whenever there is something in the cart.
  const suggestions = useMemo(() => {
    if (!cart.length) return [];
    const activityBySlug = (slug: string) => activities.find((a) => a.slug === slug);
    const inCart = new Set(cart.map((i) => i.slug));
    const related = cart
      .flatMap((i) => activityBySlug(i.slug)?.relatedSlugs ?? [])
      .filter((s) => !inCart.has(s));
    const unique = [...new Set(related)];
    return unique
      .map(activityBySlug)
      .filter((a): a is NonNullable<typeof a> => Boolean(a))
      .slice(0, 3);
  }, [cart, activities]);

  const fallbackSuggestions = activities.filter((a) => a.tier === "B").slice(0, 3);

  if (!hydrated) {
    return (
      <div className="container-page py-10">
        <div className="skeleton h-64 w-full rounded-[var(--radius-tile)]" />
      </div>
    );
  }

  return (
    <div className="container-page py-6 pb-28 lg:pb-16">
      <Breadcrumbs items={[{ label: "Dubai", href: "/" }, { label: "Your trip" }]} className="mb-3" />
      <h1 className="text-[1.75rem] sm:text-3xl">Your Dubai trip</h1>
      <p className="mt-1.5 text-[0.95rem] text-ink-600">
        Review your experiences day by day.{" "}
        {inquiry ? "Send one inquiry so we can check your choices with the operators." : "Then book and pay for it in one go."}
      </p>

      {cart.length === 0 ? (
        // The same paid-booking notice as the empty /checkout (src/lib/paid-booking.ts); otherwise the usual state.
        <EmptyCartOrPaidBooking
          key={restored}
          headingAs="h2"
          fallbackMessage="Your trip is empty"
          skeleton={<div className="skeleton h-64 w-full rounded-[var(--radius-tile)]" />}
          fallback={
            <EmptyState
              headingAs="h2"
              illustration="cart"
              icon={<Sparkles className="h-6 w-6" />}
              title="Your trip is empty"
              body="Add an experience to build your trip. Your choices will appear here by date."
              action={<ButtonLink href="/search">Browse experiences</ButtonLink>}
              secondary={
                <ButtonLink href="/collections/first-time-dubai" variant="outline">
                  See the first-timer plan
                </ButtonLink>
              }
            />
          }
        />
      ) : (
        <div className="mt-6 grid grid-safe gap-8 lg:grid-cols-[1.5fr_1fr] lg:items-start">
          <div className="min-w-0">
            {modeNotice && (
              <Alert tone="warning" title="Some items in your trip have changed" className="mb-5" icon={<AlertTriangle className="h-4.5 w-4.5" />}>
                {modeNotice.changed.length > 0 && (
                  <p>
                    {modeNotice.changed.join(", ")} {modeNotice.changed.length === 1 ? "is" : "are"} now confirmed by our team before you pay, so your trip goes as one quick check.
                  </p>
                )}
                {modeNotice.retired.length > 0 && (
                  <p className={modeNotice.changed.length ? "mt-2" : undefined}>
                    {modeNotice.retired.join(", ")} {modeNotice.retired.length === 1 ? "is" : "are"} no longer available. Remove {modeNotice.retired.length === 1 ? "it" : "them"} to send the rest.
                  </p>
                )}
              </Alert>
            )}

            {mixed && (
              <Alert tone="info" title="Your whole trip goes to one quick check" className="mb-5">
                One of these experiences needs a specialist to confirm it, so we confirm everything together. Nothing is charged until you approve the confirmed price.
              </Alert>
            )}

            {conflicts.length > 0 && (
              <Alert
                tone="warning"
                title="Two activities clash"
                className="mb-5"
                icon={<AlertTriangle className="h-4.5 w-4.5" />}
              >
                <ul className="list-disc space-y-1 pl-4">
                  {conflicts.map((c) => (
                    <li key={c}>{c}</li>
                  ))}
                </ul>
                <p className="mt-2">
                  Move one to another day, or{" "}
                  <Link href="/support" className="font-bold underline">
                    ask us to rearrange it
                  </Link>{" "}
                 , most suppliers allow a date change before confirmation.
                </p>
              </Alert>
            )}

            {byDate.map(([date, items]) => (
              <section key={date} className="mb-8" aria-labelledby={`day-${date}`}>
                <h2
                  id={`day-${date}`}
                  className="mb-3 flex items-center gap-2 text-lg"
                >
                  <span className="flex h-8 w-8 items-center justify-center rounded-full bg-sun-100 font-display text-sm font-bold text-sun-700">
                    {items.length}
                  </span>
                  {formatDateLong(date)}
                </h2>
                <ol className="space-y-3">
                  {items.map((item) => (
                    <li key={item.id}>
                      <Card className="flex gap-4 p-4">
                        <Link
                          href={`/${item.kind === "combo" ? "combos" : "activities"}/${item.slug}`}
                          className="h-20 w-24 shrink-0 overflow-hidden rounded-xl"
                        >
                          <Scene src={item.image} alt="" />
                        </Link>
                        <div className="min-w-0 flex-1">
                          <div className="flex items-start justify-between gap-3">
                            <div className="min-w-0">
                              <Link
                                href={`/${item.kind === "combo" ? "combos" : "activities"}/${item.slug}`}
                                className="text-[0.975rem] font-bold leading-snug text-ink-900 hover:underline"
                              >
                                {item.title}
                              </Link>
                              <p className="mt-0.5 text-xs text-ink-500">
                                {item.time}
                                {item.durationMinutes
                                  ? ` · ${formatDuration(item.durationMinutes)}`
                                  : ""}
                                {item.variantName ? ` · ${item.variantName}` : ""}
                              </p>
                              <p className="mt-0.5 text-xs text-ink-500">{paxLabel(item.pax)}</p>
                            </div>
                            <button
                              type="button"
                              onClick={() => removeFromCart(item.id)}
                              className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full text-ink-500 hover:bg-ink-100 hover:text-[var(--color-danger)]"
                            >
                              <Trash2 className="h-4 w-4" />
                              <span className="sr-only">Remove {item.title}</span>
                            </button>
                          </div>
                          <div className="mt-2 flex flex-wrap items-center justify-between gap-2">
                            <div className="flex flex-wrap gap-1.5">
                              {item.fulfilmentMode === "instant" && !inquiry ? (
                                <Badge tone="trust" size="sm">
                                  Instant confirmation
                                </Badge>
                              ) : (
                                <Badge tone="trust" size="sm">
                                  Confirmed before you pay
                                </Badge>
                              )}
                              {inquiry && item.freeCancellationHours > 0 && (
                                <Badge tone="trust" size="sm">
                                  Free cancellation · {item.freeCancellationHours}h
                                </Badge>
                              )}
                            </div>
                            <p className="font-display text-lg font-bold tnum text-ink-900">
                              {priceIn(item.total, currency)}
                            </p>
                          </div>
                          {!inquiry && (
                            // Before a quote: the operator's policy, in the same words as the activity page (CO-01).
                            <p className="mt-2 text-xs text-ink-600" data-testid="cart-cancellation-policy">
                              {cancellationPolicyBeforeQuote(item.freeCancellationHours, { openDatedTicket: item.openDatedTicket })}
                            </p>
                          )}
                        </div>
                      </Card>
                    </li>
                  ))}
                </ol>
              </section>
            ))}

            <section aria-labelledby="add-more">
              <SectionHeading
                id="add-more"
                kicker="Goes well with what you've picked"
                title="Add to the same inquiry"
                sub="Take a look at other experiences you could add to your trip."
              />
              <div className="grid gap-4 sm:grid-cols-3">
                {(suggestions.length ? suggestions : fallbackSuggestions).map((a, i) => (
                  <ActivityCard
                    key={a.slug}
                    activity={a}
                    layout="compact"
                    position={i + 1}
                    source="cart_upsell"
                  />
                ))}
              </div>
            </section>
          </div>

          <aside className="lg:sticky lg:top-28">
            <Card className="p-5">
              <h2 className="text-lg">Trip summary</h2>
              <ul className="mt-3 space-y-2 text-sm">
                {cart.map((item) => (
                  <li key={item.id} className="flex justify-between gap-3">
                    <span className="min-w-0 text-ink-600">
                      <span className="line-clamp-1">{item.title}</span>
                      <span className="block text-2xs text-ink-500">{paxLabel(item.pax)}</span>
                    </span>
                    <span className="shrink-0 font-semibold tnum">
                      {priceIn(item.total, currency)}
                    </span>
                  </li>
                ))}
              </ul>
              <div className="mt-3 flex justify-between border-t border-ink-200 pt-3">
                <span className="font-bold">{inquiry ? "Estimated total" : "Total"}</span>
                <span className="font-display text-xl font-bold tnum">{priceIn(totalMoney, currency)}</span>
              </div>
              <p className="mt-1 text-xs font-semibold text-[var(--color-success)]">
                Review your total again before you pay.
              </p>
              {inquiry && <IndicativePriceNote className="mt-2" />}

              <ButtonLink href={nextHref} block size="lg" className="mt-4">
                {inquiry && <Send className="h-[1.15rem] w-[1.15rem]" />}
                {nextLabel}
              </ButtonLink>
              {inquiry && (
                <>
                  <WhatsAppButton
                    block
                    size="lg"
                    className="mt-2"
                    label="Price this trip on WhatsApp"
                    context={{
                      intent: "inquiry",
                      items: cart.map((c) => `${c.title} · ${formatDateKey(c.date)} · ${paxLabel(c.pax)}`),
                      priceLabel: priceIn(totalMoney, currency),
                      placement: "cart",
                    }}
                  />
                  <ResponsePromise className="mt-3 justify-center" />
                  <ConfirmFirstNote className="mt-1 justify-center text-center" />
                </>
              )}
              <Button
                variant="ghost"
                block
                size="sm"
                className="mt-1.5"
                onClick={() => window.history.back()}
              >
                Keep browsing
              </Button>
            </Card>

            {!inquiry && (
              <WhatsAppCard
                className="mt-4"
                context={{
                  intent: "group",
                  question: `My trip: ${cart.map((c) => c.title).join(" / ")}`,
                  placement: "cart",
                }}
                title="Want us to check this plan?"
                body="Ask us to check how the dates and pickups fit together."
              />
            )}
          </aside>
        </div>
      )}

      {/* Sticky mobile CTA: item count + indicative total + primary (pivot §4.2). */}
      {cart.length > 0 && (
        <div className="fixed inset-x-0 bottom-0 z-40 border-t border-ink-200 bg-paper/97 px-4 pb-[max(0.75rem,env(safe-area-inset-bottom))] pt-3 shadow-[var(--shadow-sticky)] backdrop-blur lg:hidden">
          <div className="flex items-center gap-3">
            <div className="min-w-0 flex-1">
              <p className="text-2xs font-semibold text-ink-500">
                {cart.length} {cart.length === 1 ? "activity" : "activities"} · {inquiry ? "indicative" : "total"}
              </p>
              <p className="font-display text-lg font-bold leading-tight tnum text-ink-900">
                {priceIn(totalMoney, currency)}
              </p>
            </div>
            <ButtonLink href={nextHref} size="md">
              {nextLabel}
            </ButtonLink>
          </div>
        </div>
      )}
    </div>
  );
}
