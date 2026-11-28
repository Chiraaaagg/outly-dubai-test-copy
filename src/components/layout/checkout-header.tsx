"use client";

import { useId, useState } from "react";
import { useRouter } from "next/navigation";
import { Lock } from "lucide-react";
import { useApp } from "@/components/providers/app-provider";
import { WhatsAppGlyph } from "@/components/commerce/whatsapp";
import { Button } from "@/components/ui/button";
import { openWhatsApp } from "@/lib/whatsapp";
import { Wordmark } from "./logo";
import { CookieSettingsLink } from "./cookie-settings-link";
import { SiteLink as Link } from "@/components/ui/site-link";

/**
 * The enclosed checkout header (checkout redesign batch 2, CO-23, CO-28).
 *
 * Inside /checkout the storefront header (trust bar, search, category bar,
 * cart and account) and the footer sitemap are replaced by three things: the
 * OUTLYY logo, "Secure checkout" in lagoon with a lock, and Help on WhatsApp.
 * Leaving stays possible: the logo first asks "Leave checkout? Your details
 * are kept." (the trip is in localStorage and the details in this tab's
 * sessionStorage draft, so both survive the trip home).
 */
export function CheckoutHeader() {
  const router = useRouter();
  const { cart } = useApp();
  const [asking, setAsking] = useState(false);
  const leaveId = useId();

  return (
    <>
      <a
        href="#main"
        className="sr-only focus:not-sr-only focus:absolute focus:left-4 focus:top-4 focus:z-[100] focus:rounded-lg focus:bg-ink-900 focus:px-4 focus:py-2.5 focus:text-sm focus:font-bold focus:text-white"
      >
        Skip to content
      </a>
      <header className="border-b border-ink-200 bg-paper" data-testid="checkout-header">
        <div className="mx-auto flex h-16 max-w-[68rem] items-center gap-3 px-4 sm:px-6">
          <button
            type="button"
            className="-ml-1 flex min-h-11 items-center rounded-lg px-1"
            aria-label="OUTLYY home: leave checkout"
            aria-expanded={asking}
            aria-controls={leaveId}
            onClick={() => setAsking((v) => !v)}
          >
            <Wordmark className="h-6 w-auto sm:h-7" />
          </button>
          <div className="ml-auto flex items-center gap-1 sm:gap-3">
            <span className="hidden items-center gap-1.5 text-sm font-semibold text-lagoon-700 min-[380px]:inline-flex">
              <Lock aria-hidden="true" className="size-4" strokeWidth={2.5} />
              Secure checkout
            </span>
            <button
              type="button"
              onClick={() =>
                openWhatsApp({
                  intent: "checkout_help",
                  question: cart.length ? `I'm booking: ${cart.map((c) => c.title).join(" / ")}` : undefined,
                  placement: "checkout_header",
                })
              }
              className="inline-flex min-h-11 items-center gap-2 rounded-lg px-2 text-sm font-semibold text-ink-900"
            >
              <span aria-hidden="true" className="grid size-6 place-items-center rounded-full bg-whatsapp text-ink-900">
                <WhatsAppGlyph className="size-3.5" />
              </span>
              Help
              <span className="sr-only"> on WhatsApp</span>
            </button>
          </div>
        </div>
        {asking ? (
          <div id={leaveId} className="border-t border-ink-200 bg-shell">
            <div className="mx-auto flex max-w-[68rem] flex-wrap items-center gap-x-4 gap-y-2 px-4 py-3 sm:px-6">
              <p className="font-semibold text-ink-900">Leave checkout? Your details are kept.</p>
              <div className="flex gap-2">
                <Button variant="outline" size="md" onClick={() => setAsking(false)}>
                  Stay
                </Button>
                <Button
                  variant="ghost"
                  size="md"
                  className="underline underline-offset-4"
                  onClick={() => {
                    setAsking(false);
                    router.push("/");
                  }}
                >
                  Leave checkout
                </Button>
              </div>
            </div>
          </div>
        ) : null}
      </header>
    </>
  );
}

/**
 * The enclosed checkout's footer (review fix 11): no sitemap, but the legal
 * links and the consent setting stay one tap away, as on every other page.
 */
export function CheckoutFooter() {
  const link = "inline-flex min-h-11 items-center underline underline-offset-4 hover:text-ink-900";
  return (
    <footer className="mt-10 border-t border-ink-200 bg-paper" data-testid="checkout-footer">
      <div className="mx-auto flex max-w-[68rem] flex-wrap items-center gap-x-5 gap-y-1 px-4 py-3 text-sm text-ink-600 sm:px-6">
        <Link href="/privacy" className={link}>
          Privacy
        </Link>
        <Link href="/terms" className={link}>
          Terms
        </Link>
        <Link href="/cancellation-policy" className={link}>
          Cancellation policy
        </Link>
        <CookieSettingsLink className={link} />
      </div>
    </footer>
  );
}
