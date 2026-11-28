import type { Metadata, Viewport } from "next";
import { Bricolage_Grotesque, Plus_Jakarta_Sans } from "next/font/google";
import { Header } from "@/components/layout/header";
import { Footer } from "@/components/layout/footer";
import { AppProvider } from "@/components/providers/app-provider";
import { Toaster } from "@/components/ui/toaster";
import "./globals.css";
import { GoogleAnalytics } from "@/components/analytics/google-analytics";
import { CookieBanner } from "@/components/layout/cookie-banner";
import { StorefrontOnly } from "@/components/layout/storefront-only";
import { CURRENCY_BOOTSTRAP_SCRIPT } from "@/lib/currency";
import { googleTagBootstrap, googleTagSrc } from "@/lib/google-tag";
import { gaMeasurementId } from "@/lib/ga-config";

/**
 * Type pairing:
 *  Bricolage Grotesque — display. Slightly quirky, high-contrast, modern. It
 *    carries the "playful but not childish" half of the brief.
 *  Plus Jakarta Sans — body. Warm, wide apertures, excellent at 14–16px on
 *    mid-range Android, which is the device this product is designed for.
 * Both are variable fonts loaded with `display: swap`, subset to latin.
 */
const display = Bricolage_Grotesque({
  subsets: ["latin", "latin-ext"],
  variable: "--font-bricolage",
  display: "swap",
  weight: ["600", "700", "800"],
});

const body = Plus_Jakarta_Sans({
  subsets: ["latin", "latin-ext"],
  variable: "--font-jakarta",
  display: "swap",
});

export const metadata: Metadata = {
  metadataBase: new URL("https://outlyy.com"),
  title: {
    default: "OUTLYY | Dubai Experiences, Tours & Tickets",
    template: "%s | OUTLYY",
  },
  description:
    "Find Dubai attractions, tours and things to do. Browse by hotel pickup or Jain and vegetarian options, then check availability for your dates.",
  openGraph: {
    type: "website",
    siteName: "OUTLYY",
    locale: "en_IN",
  },
  alternates: {
    canonical: "/",
    languages: { "en-IN": "/", "en-AE": "/?currency=AED" },
  },
  robots: { index: true, follow: true },
};

export const viewport: Viewport = {
  themeColor: "#FFF8F0",
  width: "device-width",
  initialScale: 1,
  viewportFit: "cover",
};

/** One name for the GA4 id across the tag, the CSP and the forwarder (src/lib/ga-config.ts). */
const GA_ID = gaMeasurementId();

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    // `suppressHydrationWarning` covers this element's own attributes and nothing
    // else — children still report mismatches normally. It is required because
    // the script below writes `data-ccy` here before React hydrates, so the
    // server HTML and the live DOM genuinely differ by that one attribute.
    <html lang="en-IN" className={`${display.variable} ${body.variable}`} suppressHydrationWarning>
      <head>
        {/*
          Sets data-ccy from the currency cookie before the first paint, so a
          statically prerendered page shows the visitor's currency with no
          flash and no layout shift. React diffs attributes on the hydration
          root, so this is the mismatch `suppressHydrationWarning` above exists
          to allow. See src/lib/currency.ts.
        */}
        <script dangerouslySetInnerHTML={{ __html: CURRENCY_BOOTSTRAP_SCRIPT }} />

        {/*
          Google tag (gtag.js) — one per page, in the head, on every page, which
          is both what Google's instructions say and what their verifier looks
          for. The consent defaults are queued first and deliberately so; see
          src/lib/google-tag.ts for why the gate moved from "do not load" to
          "load denied". No measurement id configured means no tag at all,
          rather than a preview deployment polluting production analytics.
        */}
        {GA_ID && (
          <>
            <script dangerouslySetInnerHTML={{ __html: googleTagBootstrap(GA_ID) }} />
            <script async src={googleTagSrc(GA_ID)} />
          </>
        )}
      </head>
      <body>
        <AppProvider>
          <Header />
          <main id="main">{children}</main>
          <Footer />
          <CookieBanner />
          {/* Storefront only: staff screens carry customer PII and are never measured. */}
          <StorefrontOnly>
            <GoogleAnalytics />
          </StorefrontOnly>
          <Toaster />
        </AppProvider>
      </body>
    </html>
  );
}
