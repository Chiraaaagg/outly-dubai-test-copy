"use client";

import Link from "next/link";
import { Suspense, useEffect, useState } from "react";
import { useSearchParams } from "next/navigation";
import { Sparkles } from "lucide-react";
import { useApp } from "@/components/providers/app-provider";
import { InquiryForm } from "@/components/commerce/inquiry-form";
import { IndicativePriceNote } from "@/components/commerce/inquiry-ui";
import { TrustSummary } from "@/components/commerce/trust";
import { ButtonLink } from "@/components/ui/button";
import { Alert, Breadcrumbs, Card, EmptyState, Skeleton } from "@/components/ui/primitives";
import { Scene } from "@/components/ui/scene";
import { siteConfig } from "@/lib/site-config";
import { formatDateKey, paxLabel, priceIn } from "@/lib/utils";
import { readCheckoutDraft } from "@/lib/checkout-draft";
import { inquiryNotesFromBooking, inquiryReasonText, parseInquiryReason, forgetBookingForInquiry, readBookingForInquiry, type InquiryReason } from "@/lib/inquiry-handoff";
import { fetchOrderStatus } from "@/lib/api/order-status";

/**
 * INQUIRY PAGE — replaces checkout as the cart's terminal step in inquiry mode.
 *
 * Layout adapted from 21st.dev "Contact 01 — Project Inquiry Form"
 * (@shadcnspace/contact-01): a 12-column grid with the form beside contact
 * details and trust signals, so credibility sits in the same viewport as the
 * ask. Column split inverted (form 7 / trust 5) because here the form is the
 * primary object, not the contact details. Zero new dependencies.
 *
 * /checkout is not deleted — it is gated by `cartRequiresInquiry` and returns
 * for instant-mode carts (pivot §2.2, §8.1 item 5).
 */
export default function InquiryPage() {
  return (
    <Suspense
      fallback={
        <div className="container-page py-10">
          <Skeleton className="h-96 w-full rounded-[var(--radius-tile)]" />
        </div>
      }
    >
      <InquiryInner />
    </Suspense>
  );
}

function InquiryInner() {
  const { cart, currency, hydrated } = useApp();
  // The reason comes from the router's search params, not window.location: after checkout's
  // router.replace the new page can render before the address bar changes (e2e, final run).
  const params = useSearchParams();
  // Doc 29 Batch 6: the booking status page sends a released external hold here too (`from=booking`).
  const from = params.get("from");
  const reason = from === "checkout" || from === "booking" ? parseInquiryReason(params.get("reason")) : null;
  // From checkout (CO-07): why the trip came here, and the details already typed in this tab. Read once on
  // the client; nothing below renders before `hydrated`, so the server and client markup agree.
  const [draftInitial] = useState<{ name: string; phone: string; countryCode: string; email: string } | undefined>(() => {
    if (typeof window === "undefined") return undefined;
    const draft = readCheckoutDraft();
    return draft ? { name: draft.fullName, phone: draft.phone, countryCode: draft.countryCode, email: draft.email } : undefined;
  });
  const fromCheckout: { reason: InquiryReason | null; initial?: typeof draftInitial } = { reason, initial: draftInitial };
  // Doc 29 Batch 6 (review 89 B6-16, B6-21): from the status page, the released booking's reference comes through this
  // tab's sessionStorage (never the URL), and its activity, date and guests are read through the access-checked status
  // API (this browser must already see the order) and filled into the form.
  const [orderRef] = useState<string | null>(() => (from === "booking" && typeof window !== "undefined" ? readBookingForInquiry() : null));
  const [fromBooking, setFromBooking] = useState<{ notes: string; date: string } | null | undefined>(orderRef ? undefined : null);
  useEffect(() => {
    if (!orderRef) return;
    forgetBookingForInquiry();
    let live = true;
    fetchOrderStatus(orderRef)
      .then((s) => {
        const notes = s ? inquiryNotesFromBooking({ reference: s.reference, items: s.items }) : null;
        if (live) setFromBooking(s && notes ? { notes, date: s.items[0].serviceDate } : null);
      })
      .catch(() => live && setFromBooking(null));
    return () => {
      live = false;
    };
  }, [orderRef]);
  const total = cart.reduce(
    (sum, i) => ({ inr: sum.inr + i.total.inr, aed: sum.aed + i.total.aed }),
    { inr: 0, aed: 0 },
  );

  if (!hydrated || fromBooking === undefined) {
    return (
      <div className="container-page py-10">
        <Skeleton className="h-96 w-full rounded-[var(--radius-tile)]" />
      </div>
    );
  }

  return (
    <div className="container-page py-6 pb-24">
      <Breadcrumbs
        items={[
          { label: "Dubai", href: "/" },
          { label: "Your trip", href: "/cart" },
          { label: "Request availability & price" },
        ]}
        className="mb-3"
      />

      <div className="mb-6 max-w-2xl">
        <h1 className="text-[1.75rem] sm:text-3xl">Request availability &amp; price</h1>
        <p className="mt-1.5 hidden text-[0.95rem] leading-relaxed text-ink-600 sm:block">
          Two fields and thirty seconds. A named person confirms with the operator and replies on
          WhatsApp in about 30 minutes, with the exact price. Nothing is charged until you say yes.
        </p>
      </div>

      {fromCheckout.reason && (
        <div className="mb-5 max-w-2xl" data-testid="inquiry-reason">
          <Alert tone="info" title="Why this trip is with our team">
            {inquiryReasonText(fromCheckout.reason)} Nothing has been charged.
            {fromCheckout.initial ? " The details you typed at checkout are filled in below." : ""}
            {fromBooking ? " The activity, date and guests of your booking are filled in below." : ""}
          </Alert>
        </div>
      )}

      {cart.length === 0 ? (
        <div className="grid grid-safe gap-8 lg:grid-cols-[1.4fr_1fr] lg:items-start">
          <Card className="p-5 sm:p-6">
            {!fromBooking && (
              <p className="mb-4 flex items-center gap-2 rounded-[var(--radius-control)] bg-shell p-3 text-sm text-ink-700">
                <Sparkles className="h-4 w-4 shrink-0 text-sun-500" aria-hidden="true" />
                Nothing picked yet? That&apos;s fine, tell us your dates and group and we&apos;ll
                suggest a plan.
              </p>
            )}
            <InquiryForm items={[]} initial={fromCheckout.initial} initialNotes={fromBooking?.notes} initialDate={fromBooking?.date} />
          </Card>
          <Sidebar />
        </div>
      ) : (
        <div className="grid grid-safe gap-8 lg:grid-cols-[1.4fr_1fr] lg:items-start">
          <Card className="p-5 sm:p-6">
            <InquiryForm items={cart} initial={fromCheckout.initial} />
          </Card>

          <aside className="space-y-4 lg:sticky lg:top-28">
            <Card className="p-5">
              <h2 className="text-lg">Your trip</h2>
              <ul className="mt-3 divide-y divide-ink-200">
                {cart.map((item) => (
                  <li key={item.id} className="flex gap-3 py-3">
                    <span className="h-14 w-16 shrink-0 overflow-hidden rounded-lg">
                      <Scene src={item.image} alt="" />
                    </span>
                    <div className="min-w-0 flex-1">
                      <p className="line-clamp-2 text-sm font-bold leading-snug text-ink-900">
                        {item.title}
                      </p>
                      <p className="text-xs text-ink-500">
                        {formatDateKey(item.date)} · {paxLabel(item.pax)}
                      </p>
                    </div>
                    <p className="shrink-0 text-sm font-bold tnum">{priceIn(item.total, currency)}</p>
                  </li>
                ))}
              </ul>
              <div className="mt-3 flex items-baseline justify-between border-t border-ink-200 pt-3">
                <span className="text-sm font-bold">Estimated total</span>
                <span className="font-display text-xl font-bold tnum">{priceIn(total, currency)}</span>
              </div>
              <IndicativePriceNote className="mt-2" />
              <Link
                href="/cart"
                className="mt-3 inline-block text-xs font-bold text-sun-700 underline underline-offset-2"
              >
                Edit trip
              </Link>
            </Card>
            <Sidebar compact />
          </aside>
        </div>
      )}

      {cart.length === 0 && (
        <div className="mt-8">
          <EmptyState
          illustration="cart"
            title="Or start from the catalogue"
            body="Add one or more experiences and they'll appear here, pre-filled with your dates and guests."
            action={<ButtonLink href="/search">Browse experiences</ButtonLink>}
          />
        </div>
      )}
    </div>
  );
}

/**
 * Shift coverage shown instead of named agents (audit X04): the names were
 * mock data, and a real specialist is only assigned once the inquiry exists.
 */
const SHIFTS: { initials: string; name: string; sub: string }[] = [
  { initials: "AE", name: "Dubai desk", sub: siteConfig.supportHours },
];

function Sidebar({ compact }: { compact?: boolean }) {
  return (
    <div className="space-y-4">
      <Card className="p-5">
        <h2 className="text-lg">Who replies</h2>
        <p className="mt-1 text-sm text-ink-600">
          Our team reviews inquiries during {siteConfig.supportHours}. Check your confirmation for the
          expected reply time.
        </p>
        <div className="mt-3 space-y-2">
          {SHIFTS.map((s) => (
            <div
              key={s.name}
              className={`flex items-center gap-3.5 rounded-[var(--radius-card)] border border-ink-200 bg-paper ${compact ? "p-3" : "p-4"}`}
            >
              <span
                aria-hidden="true"
                className="flex h-12 w-12 shrink-0 items-center justify-center rounded-full bg-sun-100 font-display text-base font-bold text-sun-800 ring-2 ring-sun-200"
              >
                {s.initials}
              </span>
              <div className="min-w-0 flex-1">
                <p className="text-[0.95rem] font-bold leading-tight text-ink-900">{s.name}</p>
                <p className="text-xs text-ink-600 tnum">{s.sub}</p>
              </div>
            </div>
          ))}
        </div>
      </Card>
      <Card className="p-5">
        <h2 className="mb-3 text-[0.95rem]">Why ask OUTLYY</h2>
        <TrustSummary />
      </Card>
    </div>
  );
}
