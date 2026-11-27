import type { Metadata } from "next";
import { PageView } from "@/components/analytics/page-view";
import { WhatsAppCard } from "@/components/commerce/whatsapp";
import { Accordion } from "@/components/ui/accordion";
import { Breadcrumbs, SectionHeading } from "@/components/ui/primitives";
import type { Faq } from "@/lib/types";
import { serializeJsonLd } from "@/lib/json-ld";

export const metadata: Metadata = {
  title: "Frequently Asked Questions",
  description:
    "Find out how OUTLYY checks dates and prices, which listings offer pickup or meal options, and how tickets, cancellation and refunds work.",
  alternates: { canonical: "/faq" },
};

const SECTIONS: { id: string; title: string; kicker: string; faqs: Faq[] }[] = [
  {
    id: "inquiry",
    kicker: "How it works",
    title: "Requesting availability & price",
    faqs: [
      {
        q: "Why do some listings ask me to enquire?",
        a: "For inquiry experiences, we ask the operator to check your date and price before you pay. Where instant booking is available, you can continue to checkout from the listing.",
      },
      {
        q: "How fast will I hear back?",
        a: "We reply on WhatsApp. Our team works from 10 am to 6 pm Gulf Standard Time, Monday to Saturday. Check your inquiry confirmation for its expected reply time.",
      },
      {
        q: "Does the price change?",
        a: "An inquiry price is an estimate until we check your date and options with the operator. If the total changes, we’ll tell you why before you decide whether to pay.",
      },
      {
        q: "How do I pay?",
        a: "Once we’ve confirmed the price and you decide to go ahead, follow the payment instructions in the WhatsApp conversation.",
      },
    ],
  },
  {
    id: "pricing",
    kicker: "Money",
    title: "Pricing & fees",
    faqs: [
      {
        q: "Is the price I see really the price I pay?",
        a: "For an inquiry, we confirm the amount before you pay. For instant booking, check the total at checkout. Extras you choose can change it.",
      },
      {
        q: "Why are your prices sometimes higher than the gate price?",
        a: "Compare the ticket type, what it includes and the cancellation terms. Venue and OUTLYY prices can differ.",
      },
      {
        q: "Do you show prices in AED?",
        a: "Yes. Choose AED in the currency menu to view prices in dirhams. Check the payment currency before you pay.",
      },
      {
        q: "What is TCS and will I be charged it?",
        a: "Tax Collected at Source applies to certain overseas travel purchases made from India. Where it applies we show it as a clearly labelled line before payment, with a help link explaining that it is refundable against your income tax return. It is never hidden inside another number.",
      },
    ],
  },
  {
    id: "payments",
    kicker: "Paying",
    title: "Payments",
    faqs: [
      {
        q: "Which payment methods do you accept?",
        a: "Instant checkout takes card payment. For an inquiry, confirm which methods you can use when we send the payment instructions.",
      },
      {
        q: "My UPI payment failed but the money left my account.",
        a: "If a payment fails but your account shows a debit, check your booking status before paying again. Contact support if the status is unclear.",
      },
      {
        q: "Can I pay a deposit instead of the full amount?",
        a: "Check the payment instructions for the amount due. If you need to split a payment, ask our team which options are available.",
      },
      {
        q: "Do you store my card details?",
        a: "For instant checkout, enter your card details on Stripe’s payment page.",
      },
    ],
  },
  {
    id: "food",
    kicker: "Eating",
    title: "Food & dietary requirements",
    faqs: [
      {
        q: "Is Jain food genuinely available?",
        a: "Check the experience for a Jain meal option. Share your requirements when you enquire so we can confirm what the kitchen offers and how much notice it needs.",
      },
      {
        q: "What if my dietary requirement isn't met on the day?",
        a: "If your confirmed meal is missing, use the contact details on your voucher. Tell us what was agreed and what was served.",
      },
      {
        q: "Is 'vegetarian available' the same everywhere?",
        a: "No, and that's why we describe it specifically on each page. On some camps it's a separate live-cooking counter with a dozen dishes; on others it's a smaller selection. Where a supplier's vegetarian offering is thin, we say so rather than letting you find out at dinner.",
      },
    ],
  },
  {
    id: "pickup",
    kicker: "Getting there",
    title: "Hotel pickup & transfers",
    faqs: [
      {
        q: "How does hotel pickup work?",
        a: "When pickup is included, provide your hotel or building name. Check your confirmation for the meeting point, time and pickup instructions.",
      },
      {
        q: "What if the driver doesn't turn up?",
        a: "If your pickup hasn’t arrived, use the contact details in your booking instructions. Have your booking reference and pickup location ready.",
      },
      {
        q: "Is my hotel covered?",
        a: "Each activity page lists its own pickup zones. Deira, Bur Dubai, Downtown, Business Bay, Dubai Marina, JBR and Al Barsha are covered on nearly all of them. Palm Jumeirah and outer areas are usually covered but add journey time, and occasionally a supplement, which we show before you pay.",
      },
      {
        q: "Can you arrange a wheelchair-accessible vehicle?",
        a: "Ask us before booking so we can check the vehicle and venue access for your group.",
      },
    ],
  },
  {
    id: "vouchers",
    kicker: "Your ticket",
    title: "Vouchers & confirmation",
    faqs: [
      {
        q: "How quickly do I get my voucher?",
        a: "After an instant booking, check your confirmation for how to get your ticket. If it hasn’t arrived, check your booking status.",
      },
      {
        q: "What happens while the operator checks my date?",
        a: "We contact the operator to check the date. If they can’t confirm it, we’ll let you know so you can consider another date or experience.",
      },
      {
        q: "Will my voucher work without internet?",
        a: "Yes, once you've opened it. It stays available offline, which matters because you'll often be opening it in a car park on roaming data.",
      },
    ],
  },
  {
    id: "cancellations",
    kicker: "Changing plans",
    title: "Cancellations & refunds",
    faqs: [
      {
        q: "How do I cancel?",
        a: "Open Manage booking with your reference and the contact details used to book. Check the cancellation options and terms for your booking.",
      },
      {
        q: "How long do refunds take?",
        a: "When a refund is due, it goes back to your original payment method. Your bank or card provider can affect when it appears.",
      },
      {
        q: "Can I change the date instead?",
        a: "Request a different date through support. A change depends on the operator’s terms, availability and any applicable fee.",
      },
    ],
  },
];

/**
 * FAQ — the objection-handling page.
 *
 * Grouped by the six things that actually stop an Indian traveller from
 * booking. Every answer is written to be usable as-is by a WhatsApp agent,
 * which keeps the site and the humans saying the same thing.
 */
export default function FaqPage() {
  return (
    <div className="container-page py-6 pb-20">
      <PageView pageType="faq" />
      <div className="mx-auto max-w-3xl">
        <Breadcrumbs items={[{ label: "Dubai", href: "/" }, { label: "FAQ" }]} className="mb-3" />
        <h1 className="text-[1.75rem] sm:text-3xl">Frequently asked questions</h1>
        <p className="mt-1.5 text-[0.95rem] text-ink-600">
          How prices, payment, pickup, tickets and cancellations work when you book a Dubai experience.
        </p>

        <nav aria-label="FAQ sections" className="mt-6 flex flex-wrap gap-2">
          {SECTIONS.map((s) => (
            <a
              key={s.id}
              href={`#${s.id}`}
              className="rounded-full border border-ink-300 bg-paper px-3.5 py-2 text-sm font-semibold text-ink-700 hover:border-ink-900"
            >
              {s.title}
            </a>
          ))}
        </nav>

        {SECTIONS.map((s) => (
          <section key={s.id} id={s.id} className="mt-10 scroll-mt-32">
            <SectionHeading kicker={s.kicker} title={s.title} />
            <Accordion items={s.faqs} defaultOpen={-1} />
          </section>
        ))}

        <WhatsAppCard
          className="mt-10"
          context={{ intent: "general", placement: "faq" }}
          title="Still not answered?"
          body="Ask us on WhatsApp. Our hours are 10 am to 6 pm Gulf Standard Time, Monday to Saturday."
        />
      </div>

      <script
        type="application/ld+json"
        dangerouslySetInnerHTML={{
          __html: serializeJsonLd({
            "@context": "https://schema.org",
            "@type": "FAQPage",
            mainEntity: SECTIONS.flatMap((s) =>
              s.faqs.map((f) => ({
                "@type": "Question",
                name: f.q,
                acceptedAnswer: { "@type": "Answer", text: f.a },
              })),
            ),
          }),
        }}
      />
    </div>
  );
}
