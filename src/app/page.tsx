import type { Metadata } from "next";
import Link from "next/link";
import { ArrowRight, Clock3, Sparkles } from "lucide-react";
import { PageView } from "@/components/analytics/page-view";
import { ActivityCard } from "@/components/commerce/activity-card";
import { toCard } from "@/lib/catalog/card";
import { CategoryCard, CollectionCard, ComboCard } from "@/components/commerce/cards";
import { QuickChips } from "@/components/commerce/quick-chips";
import { HeroSearch } from "@/components/commerce/search-box";
import { HowItWorks } from "@/components/commerce/inquiry-ui";
import { SisterBrandReviews } from "@/components/commerce/sister-reviews";
import {
  SocialProofStrip,
  TrustMarquee,
  WhyOutlyy,
} from "@/components/commerce/trust";
import { FloatingWhatsApp, WhatsAppCard } from "@/components/commerce/whatsapp";
import { Accordion } from "@/components/ui/accordion";
import { ButtonLink } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { SectionHeading } from "@/components/ui/primitives";
import { Rail, RailItem } from "@/components/ui/rail";
import { Scene } from "@/components/ui/scene";
import { getActivities, getCategories } from "@/lib/catalog/server";
import { collections } from "@/lib/data/collections";
import { combos } from "@/lib/data/combos";
import type { Faq } from "@/lib/types";
import { Amount } from "@/components/commerce/price";
import { serializeJsonLd } from "@/lib/json-ld";

export const metadata: Metadata = {
  title: "Dubai Experiences, Tours & Tickets | OUTLYY",
  description:
    "Find Dubai experiences worth going out for, from desert safaris to dinner cruises. Browse tours, attractions and tickets, then check options for your dates.",
  alternates: { canonical: "/" },
};

/**
 * HOMEPAGE
 *
 * Job (PRD §5.1): establish trust in under 5 seconds, route to intent in
 * under 15.
 *
 * Merchandising rule enforced below: Tier A attraction tickets may appear in
 * the category grid but never in positions 1–8 of a hero rail (AC-HP-05).
 * Hero real estate belongs to Tier B and C — the margin and take-rate tiers.
 */

const HOME_FAQS: Faq[] = [
  {
    q: "Is the price I see the price I pay?",
    a: "An inquiry starts with an estimated price. We confirm the total before you pay. For instant booking, review the total at checkout. Selected extras can change the total.",
  },
  {
    q: "Can I pay with UPI?",
    a: "Instant checkout uses card payment. For an inquiry, ask which methods are available when we confirm your booking details.",
  },
  {
    q: "Is pure vegetarian and Jain food actually available?",
    a: "Check listings marked for vegetarian or Jain meals and request your meal when you enquire. Tell us about any requirements so we can confirm the options and notice period with the operator.",
  },
  {
    q: "Why do some experiences ask me to enquire?",
    a: "For inquiry experiences, we check your date and the exact price with the operator, then reply on WhatsApp. You can decide whether to go ahead once you have the details.",
  },
  {
    q: "How quickly do I get my ticket?",
    a: "After you pay, check your booking confirmation for ticket delivery details. If your experience starts with an inquiry, we’ll confirm availability and the price before you pay.",
  },
  {
    q: "What if I'd rather just talk to someone?",
    a: "Message us on WhatsApp with the experience and dates you’re considering. Our hours are 10 am to 6 pm Gulf Standard Time, Monday to Saturday.",
  },
  {
    q: "Can older travellers go on a desert safari?",
    a: "Check whether the plan includes dune bashing, and ask the operator about gentler options, seating and any age or mobility restrictions before you book.",
  },
];

export const revalidate = 60;

export default async function HomePage() {
  const [activities, categories] = await Promise.all([getActivities(), getCategories()]);

  // A real listing for the hero card, so the figure in the shop window is one
  // a visitor can actually go and find. Prefers a desert safari because that is
  // the image beside it; falls back to whatever the catalogue has.
  const heroExample =
    activities.find((a) => a.categorySlug === "desert-safari") ?? activities[0];
  const activitiesBySlugs = (slugs: string[]) => slugs.map((s) => activities.find((a) => a.slug === s)).filter((a): a is NonNullable<typeof a> => Boolean(a));

  // "Available today & tomorrow" — the last-minute and expat rail.
  // Short-notice rail, chosen by the operator's confirmation type. No mock
  // availability decides membership any more (PRD-6); the rail's copy is a
  // PRD-9 content decision and is unchanged here.
  const lastMinute = activities.filter((a) => a.confirmation === "instant" && !a.quoteOnly).slice(0, 8);

  // Hero rail: Tier B and C only, ordered by demand. AC-HP-05.
  const topExperiences = activities
    .filter((a) => a.tier === "B" || a.tier === "C")
    .sort((a, b) => b.bookedThisMonth - a.bookedThisMonth)
    .slice(0, 8);

  const familyPicks = activitiesBySlugs(
    collections.find((c) => c.slug === "dubai-with-kids")!.activitySlugs,
  ).slice(0, 6);

  const couplePicks = activitiesBySlugs(
    collections.find((c) => c.slug === "dubai-honeymoon")!.activitySlugs,
  ).slice(0, 6);

  const luxuryPicks = activities.filter((a) => a.tier === "D" || a.tier === "C").slice(0, 6);

  const desertPicks = activities.filter((a) => a.categorySlug === "desert-safari");
  const waterPicks = activities.filter((a) => a.categorySlug === "cruises-yachts");

  const countByCategory = (slug: string) =>
    activities.filter((a) => a.categorySlug === slug || a.secondaryCategorySlugs.includes(slug))
      .length;

  return (
    <>
      <PageView pageType="homepage" />

      {/* ------------------------------------------------------------------
        HERO, trust in 5 seconds, intent in 15.
        Primary CTA: Find things to do. Secondary: quick-intent chips.
      ------------------------------------------------------------------ */}
      <section className="sun-wash relative overflow-hidden border-b border-ink-200">
        <div className="container-page relative grid grid-safe gap-8 py-10 lg:grid-cols-[1.05fr_0.95fr] lg:items-center lg:py-16">
          <div className="relative z-10 min-w-0">
            <p className="mb-3 inline-flex items-center gap-2 rounded-full border border-ink-900/10 bg-white/70 px-3 py-1.5 text-xs font-bold text-ink-800 backdrop-blur">
              <Sparkles className="h-3.5 w-3.5 text-sun-600" aria-hidden="true" />
              Things to do in Dubai
            </p>

            <h1 className="text-[2.25rem] leading-[1.05] sm:text-5xl lg:text-[3.4rem]">
              Make a day of Dubai
              <span className="mt-1 block text-sun-600">Find and book Dubai tours, attractions and things to do.</span>
            </h1>

            <p className="mt-4 max-w-xl text-[1.05rem] leading-relaxed text-ink-700">
              Start with the experiences that fit your plans. When a listing asks you to enquire, we
              check your date and price with the operator before you pay.
            </p>

            <div className="mt-6">
              <HeroSearch />
            </div>

            <div className="mt-4">
              <QuickChips />
            </div>
          </div>

          <div className="relative hidden lg:block">
            <div className="relative aspect-[4/3] overflow-hidden rounded-[var(--radius-tile)] border border-ink-900/10 shadow-[var(--shadow-pop)]">
              <Scene src="dune-sunset" alt="Sunset over the red dunes outside Dubai" priority />
            </div>
            {heroExample && (
            <div className="absolute -bottom-5 -left-6 w-56 rounded-[var(--radius-card)] border border-ink-200 bg-paper p-3.5 shadow-[var(--shadow-lift)]">
              <p className="text-2xs font-extrabold uppercase tracking-[0.12em] text-ink-500">
                {heroExample.categorySlug.replace(/-/g, " ")}
              </p>
              <Amount money={heroExample.price.adult} className="mt-1 block font-display text-xl font-bold text-ink-900" />
              <p className="text-2xs text-ink-500">Starting price per adult</p>
            </div>
            )}
            <div className="absolute -right-4 top-8 w-44 rotate-2 rounded-[var(--radius-card)] border border-ink-200 bg-paper p-3 shadow-[var(--shadow-lift)]">
              <p className="text-2xs font-bold text-[var(--color-success)]">Replies on WhatsApp</p>
              <p className="mt-0.5 text-xs leading-snug text-ink-600">
                Ask our team about an experience or date
              </p>
            </div>
          </div>
        </div>
      </section>

      <TrustMarquee />

      {/* ------------------------------------------------------------------
        HOW IT WORKS, the inquiry model explained before the first CTA is met
        (pivot §2.1). 21st.dev "How It Works Steps" (@ln-dev7/how-it-works-09).
      ------------------------------------------------------------------ */}
      <section className="container-page pt-10">
        <HowItWorks />
      </section>

      {/* ------------------------------------------------------------------
        SHORT-NOTICE RAIL (was "Available today & tomorrow"), last-minute + expat. Geo-boosted first
        for UAE visitors in production; static order here.
        Primary CTA: card → ADP. Secondary: see all last-minute.
      ------------------------------------------------------------------ */}
      <section className="container-page py-12" aria-labelledby="last-minute">
        <SectionHeading
          id="last-minute"
          kicker="Planning at short notice?"
          title="Things to do this week"
          sub="Ask us on WhatsApp about your date if you’re looking for something today or tomorrow."
          href="/last-minute-dubai-activities"
          hrefLabel="See last-minute activities"
        />
        <Rail ariaLabel="Experiences for short-notice plans">
          {lastMinute.map((a, i) => (
            <RailItem key={a.slug}>
              <ActivityCard activity={toCard(a)} layout="rail" position={i + 1} source="home_last_minute" />
            </RailItem>
          ))}
        </Rail>
      </section>

      {/* ------------------------------------------------------------------
        TOP EXPERIENCES. Tier B/C only (AC-HP-05). The margin engine.
      ------------------------------------------------------------------ */}
      <section className="container-page py-12" aria-labelledby="top-experiences">
        <SectionHeading
          id="top-experiences"
          kicker="Dubai experiences"
          title="Ideas for your Dubai days"
          sub="Compare experiences and see which ones fit your group."
          href="/search?sort=popularity"
          hrefLabel="See Dubai experiences"
        />
        <Rail ariaLabel="Dubai experience ideas">
          {topExperiences.map((a, i) => (
            <RailItem key={a.slug}>
              <ActivityCard
                activity={toCard(a)}
                layout="rail"
                position={i + 1}
                source="home_top"
                showWhatsApp
              />
            </RailItem>
          ))}
        </Rail>
      </section>

      {/* ------------------------------------------------------------------
        COMBOS. Tier C, the take-rate lever.
      ------------------------------------------------------------------ */}
      <section className="bg-shell py-12" aria-labelledby="combos">
        <div className="container-page">
          <SectionHeading
            id="combos"
            kicker="Multi-experience packages"
            title="Dubai days that go together"
            sub="Open a package to see which experiences it lists and what’s included."
            href="/dubai-attraction-combos"
            hrefLabel="See Dubai packages"
          />
          <Rail ariaLabel="Dubai packages and combos">
            {combos.map((c) => (
              <RailItem key={c.slug}>
                <ComboCard combo={c} layout="rail" />
              </RailItem>
            ))}
          </Rail>
        </div>
      </section>

      {/* ------------------------------------------------------------------
        CATEGORY GRID, the main navigational surface for undecided visitors.
      ------------------------------------------------------------------ */}
      <section className="container-page py-12" aria-labelledby="categories">
        <SectionHeading
          id="categories"
          kicker="Browse by interest"
          title="What are you in the mood for?"
          sub={`Browse ${activities.length} things to do across ${categories.length} categories.`}
        />
        <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
          {categories.map((c) => (
            <CategoryCard
              key={c.slug}
              category={c}
              count={countByCategory(c.slug)}
              className="aspect-[4/5] sm:aspect-[5/4]"
            />
          ))}
        </div>
      </section>

      {/* ------------------------------------------------------------------
        DESERT SAFARI FEATURE, highest-margin, highest-anxiety category, so
        it gets an editorial band rather than another rail.
      ------------------------------------------------------------------ */}
      <section className="container-page py-12" aria-labelledby="desert">
        <div className="overflow-hidden rounded-[var(--radius-tile)] border border-ink-200 bg-paper">
          <div className="grid grid-safe lg:grid-cols-[0.9fr_1.1fr]">
            <div className="relative min-h-[15rem]">
              <Scene src="dune-sunset" alt="Convoy of 4x4s on the Al Lahbab dunes at sunset" />
            </div>
            <div className="p-6 sm:p-8">
              <Badge tone="heat" className="mb-3">
                Desert safaris
              </Badge>
              <h2 id="desert" className="text-2xl sm:text-3xl">
                A desert safari that suits your group
              </h2>
              <p className="mt-3 max-w-xl text-[0.975rem] leading-relaxed text-ink-600">
                Start with pickup, dune bashing and dinner. Check what your safari includes and ask
                about Jain meals or a gentler itinerary before you choose.
              </p>
              <div className="mt-5 flex flex-wrap gap-2.5">
                <ButtonLink href="/lp/desert-safari-dubai">Compare all safaris</ButtonLink>
                <ButtonLink href="/activities/gentle-desert-safari-seniors" variant="outline">
                  See the gentle safari
                </ButtonLink>
              </div>

              <div className="mt-6 grid gap-3 sm:grid-cols-2">
                {desertPicks.slice(0, 2).map((a, i) => (
                  <ActivityCard key={a.slug} activity={toCard(a)} layout="compact" position={i + 1} source="home_desert" />
                ))}
              </div>
            </div>
          </div>
        </div>
      </section>

      {/* ------------------------------------------------------------------
        AUDIENCE COLLECTIONS, family / couple / luxury routing.
      ------------------------------------------------------------------ */}
      <section className="container-page py-12" aria-labelledby="collections">
        <SectionHeading
          id="collections"
          kicker="Sorted by who's coming"
          title="Who are you travelling with?"
          sub="Start with the collection that suits your group."
        />
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
          {collections
            .filter((c) =>
              ["dubai-with-kids", "dubai-honeymoon", "senior-friendly", "luxury-dubai"].includes(
                c.slug,
              ),
            )
            .map((c) => (
              <CollectionCard key={c.slug} collection={c} />
            ))}
        </div>
      </section>

      {/* FAMILY RAIL */}
      <section className="container-page py-12" aria-labelledby="family">
        <SectionHeading
          id="family"
          kicker="Going out with family"
          title="Family-friendly Dubai experiences"
          sub="Check each listing for age limits and for child, infant or senior rates where offered."
          href="/collections/dubai-with-kids"
          hrefLabel="See family experiences"
        />
        <Rail ariaLabel="Family-friendly activities">
          {familyPicks.map((a, i) => (
            <RailItem key={a.slug}>
              <ActivityCard activity={toCard(a)} layout="rail" position={i + 1} source="home_family" />
            </RailItem>
          ))}
        </Rail>
      </section>

      {/* ------------------------------------------------------------------
        CRUISES & YACHTS band
      ------------------------------------------------------------------ */}
      <section className="bg-ink-900 py-12 text-white" aria-labelledby="water">
        <div className="container-page">
          <div className="mb-6 flex flex-wrap items-end justify-between gap-4">
            <div className="max-w-2xl">
              <p className="mb-1 text-xs font-extrabold uppercase tracking-[0.14em] text-dune-300">
                On the water
              </p>
              <h2 id="water" className="text-2xl text-white sm:text-[1.75rem]">
                See Dubai from the water
              </h2>
              <p className="mt-1.5 text-[0.95rem] leading-relaxed text-white/70">
                Look for shared cruises and private charters. Check the listing for group size
                before you choose.
              </p>
            </div>
            <Link
              href="/categories/cruises-yachts"
              className="inline-flex items-center gap-1.5 rounded-full border border-white/25 px-3.5 py-2 text-sm font-semibold text-white hover:bg-white/10"
            >
              All cruises &amp; yachts
              <ArrowRight className="h-4 w-4" />
            </Link>
          </div>
          <Rail ariaLabel="Cruises and yacht experiences">
            {waterPicks.map((a, i) => (
              <RailItem key={a.slug}>
                <ActivityCard activity={toCard(a)} layout="rail" position={i + 1} source="home_water" />
              </RailItem>
            ))}
          </Rail>
        </div>
      </section>

      {/* COUPLE + LUXURY */}
      <section className="container-page py-12" aria-labelledby="couples">
        <SectionHeading
          id="couples"
          kicker="For two"
          title="Couple &amp; honeymoon experiences"
          sub="Start here when you’re planning a day or evening together."
          href="/collections/dubai-honeymoon"
          hrefLabel="See experiences for two"
        />
        <Rail ariaLabel="Couple and honeymoon experiences">
          {couplePicks.map((a, i) => (
            <RailItem key={a.slug}>
              <ActivityCard activity={toCard(a)} layout="rail" position={i + 1} source="home_couples" />
            </RailItem>
          ))}
        </Rail>
      </section>

      <section className="container-page py-12" aria-labelledby="luxury">
        <SectionHeading
          id="luxury"
          kicker="Private tours and premium outings"
          title="Premium &amp; private experiences"
          sub="Explore charters, helicopter flights and other outings. Open a listing to check its options or request a quote where offered."
          href="/categories/luxury-experiences"
          hrefLabel="See premium experiences"
        />
        <Rail ariaLabel="Luxury experiences">
          {luxuryPicks.map((a, i) => (
            <RailItem key={a.slug}>
              <ActivityCard activity={toCard(a)} layout="rail" position={i + 1} source="home_luxury" />
            </RailItem>
          ))}
        </Rail>
      </section>

      {/* ------------------------------------------------------------------
        SEASONAL MODULE, truthful, dated, and it changes.
      ------------------------------------------------------------------ */}
      <section className="container-page py-12" aria-labelledby="seasonal">
        <div className="grid gap-4 lg:grid-cols-2">
          <div className="night-wash relative overflow-hidden rounded-[var(--radius-tile)] p-6 text-white sm:p-8">
            <Badge tone="premium" className="mb-3 border-white/20 bg-white/10 text-dune-200">
              <Clock3 className="h-3.5 w-3.5" /> Winter ideas
            </Badge>
            <h2 id="seasonal" className="text-2xl text-white">
              Plan a winter day in Dubai
            </h2>
            <p className="mt-2 max-w-md text-[0.95rem] leading-relaxed text-white/75">
              Planning a winter visit? Consider an afternoon in the desert, a visit to Global
              Village or a walk through Miracle Garden. Check opening dates before you make plans.
            </p>
            <ButtonLink href="/collections/first-time-dubai" className="mt-5">
              See the first-timer plan
            </ButtonLink>
          </div>

          <div className="grid gap-4 sm:grid-cols-2">
            <Link
              href="/dubai-activities-with-upi"
              className="flex flex-col justify-between rounded-[var(--radius-tile)] border border-ink-200 bg-paper p-5 transition-transform [@media(hover:hover)]:hover:-translate-y-0.5"
            >
              <span className="text-2xl" aria-hidden="true">
                ₹
              </span>
              <span>
                <span className="block text-lg font-bold text-ink-900">Check UPI options</span>
                <span className="mt-1 block text-sm text-ink-600">
                  Ask which payment methods are available for your booking before you pay.
                </span>
              </span>
            </Link>
            <Link
              href="/dubai-activities-with-hotel-pickup"
              className="flex flex-col justify-between rounded-[var(--radius-tile)] border border-ink-200 bg-paper p-5 transition-transform [@media(hover:hover)]:hover:-translate-y-0.5"
            >
              <span className="text-2xl" aria-hidden="true">
                🚐
              </span>
              <span>
                <span className="block text-lg font-bold text-ink-900">Experiences with hotel pickup</span>
                <span className="mt-1 block text-sm text-ink-600">
                  Check your listing for eligible hotels and pickup instructions.
                </span>
              </span>
            </Link>
            <Link
              href="/collections/jain-veg-friendly"
              className="flex flex-col justify-between rounded-[var(--radius-tile)] border border-ink-200 bg-paper p-5 transition-transform [@media(hover:hover)]:hover:-translate-y-0.5"
            >
              <span className="text-2xl" aria-hidden="true">
                🌿
              </span>
              <span>
                <span className="block text-lg font-bold text-ink-900">Jain &amp; pure veg</span>
                <span className="mt-1 block text-sm text-ink-600">
                  Ask about Jain and pure vegetarian meals when you enquire.
                </span>
              </span>
            </Link>
            <Link
              href="/concierge"
              className="flex flex-col justify-between rounded-[var(--radius-tile)] border border-ink-200 bg-paper p-5 transition-transform [@media(hover:hover)]:hover:-translate-y-0.5"
            >
              <span className="text-2xl" aria-hidden="true">
                ✨
              </span>
              <span>
                <span className="block text-lg font-bold text-ink-900">Request a trip plan</span>
                <span className="mt-1 block text-sm text-ink-600">
                  Share your plans with our trip team and ask for a quote.
                </span>
              </span>
            </Link>
          </div>
        </div>
      </section>

      {/* ------------------------------------------------------------------
        SOCIAL PROOF
      ------------------------------------------------------------------ */}
      <section className="bg-shell py-12">
        <div className="container-page">
          <SocialProofStrip className="mb-8" />
          <SisterBrandReviews limit={6} />
        </div>
      </section>

      {/* ------------------------------------------------------------------
        WHY OUTLYY + FAQ + WHATSAPP
      ------------------------------------------------------------------ */}
      <section className="container-page py-12" aria-labelledby="why-outlyy">
        <SectionHeading
          id="why-outlyy"
          kicker="Booking with OUTLYY"
          title="Know what you’re booking"
          sub="Check what your experience includes, how its price is confirmed and what happens if plans change."
        />
        <WhyOutlyy />
      </section>

      <section className="container-page pb-12" aria-labelledby="faq">
        <div className="grid grid-safe gap-8 lg:grid-cols-[0.85fr_1.15fr]">
          <div>
            <SectionHeading
              id="faq"
              kicker="Before you book"
              title="Questions about booking"
              sub="Have another question? Ask us on WhatsApp."
            />
            <WhatsAppCard
              context={{ intent: "general", placement: "homepage_faq" }}
              className="hidden lg:block"
            />
          </div>
          <Accordion items={HOME_FAQS} />
        </div>
      </section>

      <section className="container-page pb-16 lg:hidden">
        <WhatsAppCard context={{ intent: "general", placement: "homepage_footer" }} />
      </section>

      <FloatingWhatsApp context={{ intent: "general", placement: "homepage" }} />

      {/* Structured data: Organization + the FAQ block above (PRD §7). */}
      <script
        type="application/ld+json"
        dangerouslySetInnerHTML={{
          __html: serializeJsonLd({
            "@context": "https://schema.org",
            "@graph": [
              {
                "@type": "Organization",
                name: "OUTLYY",
                url: "https://outlyy.com",
                description:
                  "OUTLYY helps travellers explore Dubai tours, attractions and activities, with operator checks for experiences booked by inquiry.",
                areaServed: ["IN", "AE"],
                contactPoint: {
                  "@type": "ContactPoint",
                  contactType: "customer support",
                  availableLanguage: ["English", "Hindi"],
                  telephone: "+971-4-000-0000",
                },
              },
              {
                "@type": "FAQPage",
                mainEntity: HOME_FAQS.map((f) => ({
                  "@type": "Question",
                  name: f.q,
                  acceptedAnswer: { "@type": "Answer", text: f.a },
                })),
              },
            ],
          }),
        }}
      />
    </>
  );
}
