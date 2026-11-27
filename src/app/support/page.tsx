import type { Metadata } from "next";
import Link from "next/link";
import {
  CalendarX2,
  CreditCard,
  FileText,
  MessageCircle,
  Phone,
  Ticket,
  Truck,
  Utensils,
} from "lucide-react";
import { PageView } from "@/components/analytics/page-view";
import { WhatsAppCard } from "@/components/commerce/whatsapp";
import { ButtonLink } from "@/components/ui/button";
import { Breadcrumbs, Card, SectionHeading } from "@/components/ui/primitives";
import { emergencyDisplay, emergencyHref, whatsappDisplay } from "@/lib/site-config";
import { SUPPORT_HOURS } from "@/lib/whatsapp";

export const metadata: Metadata = {
  title: "Help & Support",
  description:
    "Find support for an OUTLYY booking, ticket, date change, cancellation or payment.",
  alternates: { canonical: "/support" },
};

const TASKS = [
  {
    icon: Ticket,
    title: "Find my booking or voucher",
    body: "Reference plus the phone or email you booked with. No account needed.",
    href: "/manage-booking",
    cta: "Find my booking",
  },
  {
    icon: CalendarX2,
    title: "Cancel or change a date",
    body: "Open your booking to see the changes or cancellations it allows. Check the terms before you confirm.",
    href: "/manage-booking",
    cta: "Manage booking",
  },
  {
    icon: Truck,
    title: "My driver hasn't arrived",
    body: "Use the contact details in your booking instructions and share your reference and pickup location.",
    href: "/faq#pickup",
    cta: "Pickup help",
  },
  {
    icon: Utensils,
    title: "Dietary requirement wasn't met",
    body: "Contact us while you’re at the venue and share what was confirmed and what was served.",
    href: "/faq#food",
    cta: "Read the policy",
  },
  {
    icon: CreditCard,
    title: "Payment problem",
    body: "If you see a failed or duplicate payment, check your booking status and contact support before paying again.",
    href: "/faq#payments",
    cta: "Payment FAQs",
  },
  {
    icon: FileText,
    title: "GST invoice",
    body: "Contact us with your booking reference and ask which invoice details we can provide.",
    href: "/contact",
    cta: "Request an invoice",
  },
];

/**
 * HELP CENTRE — tiered support (PRD §5.14)
 *
 * Self-serve first (this page), WhatsApp second, phone for high-value and
 * imminent bookings, and a 24/7 emergency number on every voucher. The tiers
 * are shown in that order because the fastest resolution for most of these is
 * a page, not a conversation.
 */
export default function SupportPage() {
  const wa = whatsappDisplay();
  const emergency = emergencyDisplay();
  const emergencyTel = emergencyHref();
  const channelCount = 1 + (emergency ? 2 : 0);
  return (
    <div className="container-page py-6 pb-20">
      <PageView pageType="support" />
      <div className="mx-auto max-w-4xl">
        <Breadcrumbs items={[{ label: "Dubai", href: "/" }, { label: "Help" }]} className="mb-3" />
        <h1 className="text-[1.75rem] sm:text-3xl">How can we help?</h1>
        <p className="mt-1.5 text-[0.95rem] text-ink-600">
          Find your booking, check your options or contact our team on WhatsApp.
        </p>

        <section className="mt-8" aria-labelledby="tasks">
          <SectionHeading id="tasks" kicker="Fastest route" title="Manage your booking" />
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
            {TASKS.map((t) => (
              <Card key={t.title} className="flex flex-col p-5">
                <t.icon className="mb-2 h-5 w-5 text-sun-500" aria-hidden="true" />
                <h3 className="text-[1.02rem] leading-snug">{t.title}</h3>
                <p className="mt-1.5 flex-1 text-sm leading-relaxed text-ink-600">{t.body}</p>
                <Link
                  href={t.href}
                  className="mt-3 text-sm font-bold text-sun-700 underline underline-offset-2"
                >
                  {t.cta}
                </Link>
              </Card>
            ))}
          </div>
        </section>

        <section className="mt-10" aria-labelledby="channels">
          <SectionHeading
            id="channels"
            kicker="When you need a person"
            title="How to reach us"
            sub={
              channelCount === 3
                ? "Choose the contact option that fits what you need."
                : "One channel, a real person on the other end."
            }
          />
          <div className={`grid gap-4 ${channelCount === 3 ? "sm:grid-cols-3" : "sm:max-w-md"}`}>
            <Card className="p-5">
              <MessageCircle className="mb-2 h-5 w-5 text-whatsapp" aria-hidden="true" />
              <h3 className="text-[1.02rem]">WhatsApp</h3>
              <p className="mt-1.5 text-sm leading-relaxed text-ink-600">
                Our team is available from {SUPPORT_HOURS}.
              </p>
              {wa && <p className="mt-2 font-bold text-ink-900">{wa}</p>}
            </Card>
            {emergency && emergencyTel && (
              <>
                <Card className="p-5">
                  <Phone className="mb-2 h-5 w-5 text-sun-500" aria-hidden="true" />
                  <h3 className="text-[1.02rem]">Phone</h3>
                  <p className="mt-1.5 text-sm leading-relaxed text-ink-600">
                    For bookings over ₹25,000, all private experiences, and anything within 48 hours
                    of travel.
                  </p>
                  <a href={emergencyTel} className="mt-2 block font-bold text-ink-900 underline">
                    {emergency}
                  </a>
                </Card>
                <Card className="border-[color-mix(in_oklab,var(--color-danger)_25%,white)] p-5">
                  <Phone className="mb-2 h-5 w-5 text-[var(--color-danger)]" aria-hidden="true" />
                  <h3 className="text-[1.02rem]">Urgent booking help</h3>
                  <p className="mt-1.5 text-sm leading-relaxed text-ink-600">
                    Check your ticket or booking instructions for urgent contact details if a driver hasn’t arrived or you have trouble at the entrance.
                  </p>
                  <a href={emergencyTel} className="mt-2 block font-bold text-ink-900 underline">
                    {emergency}
                  </a>
                </Card>
              </>
            )}
          </div>
        </section>

        <WhatsAppCard
          className="mt-10"
          context={{ intent: "booking_support", placement: "support" }}
          title="Tell us what's happened"
          body="Send your booking reference and a short description of what happened."
        />

        <div className="mt-8 flex flex-wrap gap-2">
          <ButtonLink href="/faq" variant="outline">
            Read all FAQs
          </ButtonLink>
          <ButtonLink href="/contact" variant="outline">
            Contact form
          </ButtonLink>
          <ButtonLink href="/cancellation-policy" variant="outline">
            Cancellation policy
          </ButtonLink>
        </div>
      </div>
    </div>
  );
}
