import { readFileSync } from "node:fs";
import { join } from "node:path";
import { createElement as h } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { EmptyCartView } from "@/components/commerce/paid-booking-notice";
import { EmptyState } from "@/components/ui/primitives";
import { resolvePaidBooking, type PaidBookingNotice } from "@/lib/paid-booking";

/**
 * The empty /checkout and /cart after a paid booking (production fix,
 * 28 Nov 2026). The checkout page is a large client component with no render
 * harness, so the branch is rendered through `EmptyCartView` (what each phase
 * shows) fed by `resolvePaidBooking` (what the server said), and the pages'
 * wiring is pinned on the source. Synthetic references; no network.
 */

const REF = "OUT-123455";
const MARKER = { reference: REF, paidAt: Date.UTC(2026, 10, 28, 12, 0, 0) };
const read = (path: string) => readFileSync(join(process.cwd(), path), "utf8");

function memory() {
  const m = new Map<string, string>();
  return { getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => void m.set(k, v), removeItem: (k: string) => void m.delete(k) };
}

const GENERIC = h(EmptyState, { illustration: "cart", title: "Nothing to check out yet", body: "Your trip is empty." });
const SKELETON = h("div", { className: "skeleton h-96 w-full", "data-testid": "skeleton" });

function view(phase: "checking" | "notice" | "none", notice: PaidBookingNotice | null): string {
  return renderToStaticMarkup(h(EmptyCartView, { phase, notice, fallback: GENERIC, skeleton: SKELETON, headingAs: "h1" }));
}

/** The branch as the page runs it: the marker (or none), the server's answer, then the view. */
async function emptyCheckout(marker: typeof MARKER | null, server: { reference: string; state: string } | null | "fails"): Promise<string> {
  const notice = await resolvePaidBooking(
    marker,
    async () => {
      if (server === "fails") throw new Error("offline");
      return server;
    },
    memory(),
  );
  return view(!marker ? "none" : notice ? "notice" : "none", notice);
}

describe("empty checkout after a paid booking", () => {
  it("marker and a visible confirmed order: the booking, not the empty trip", async () => {
    const html = await emptyCheckout(MARKER, { reference: REF, state: "confirmed" });
    expect(html).toContain(`<h1 class="text-lg">Your booking ${REF} is confirmed</h1>`);
    expect(html).toContain("You&#x27;ve already paid for this trip, so your cart is empty.");
    expect(html).toMatch(new RegExp(`<a[^>]*href="/booking/${REF}"[^>]*>View booking</a>`));
    expect(html).toMatch(/<a[^>]*href="\/search"[^>]*>Browse experiences<\/a>/);
    expect(html.indexOf("View booking")).toBeLessThan(html.indexOf("Browse experiences"));
    expect(html).not.toContain("Nothing to check out yet");
    // The polite status line names the booking; nothing takes focus.
    expect(html).toMatch(new RegExp(`role="status" aria-live="polite"[^>]*>Your booking ${REF} is confirmed</p>`));
    expect(html).not.toMatch(/autofocus|tabindex/i);
  });

  it("marker and an order still being booked: we're confirming it", async () => {
    const html = await emptyCheckout(MARKER, { reference: REF, state: "booking_processing" });
    expect(html).toContain(`We&#x27;re confirming your booking ${REF}`);
    expect(html).toContain("View booking");
  });

  it("marker and an order this browser may not see: the usual empty state", async () => {
    const html = await emptyCheckout(MARKER, null);
    expect(html).toContain("Nothing to check out yet");
    expect(html).not.toContain(REF);
    expect(html).not.toContain("already paid");
  });

  it("marker and an order that was not paid: the usual empty state", async () => {
    for (const state of ["awaiting_payment", "payment_failed", "refunded", "cancelled"]) {
      const html = await emptyCheckout(MARKER, { reference: REF, state });
      expect(html, state).toContain("Nothing to check out yet");
      expect(html, state).not.toContain("already paid");
    }
  });

  it("marker and a failed request: the usual empty state", async () => {
    const html = await emptyCheckout(MARKER, "fails");
    expect(html).toContain("Nothing to check out yet");
    expect(html).not.toContain("already paid");
  });

  it("no marker: the usual empty state", async () => {
    const html = await emptyCheckout(null, { reference: REF, state: "confirmed" });
    expect(html).toContain("Nothing to check out yet");
    expect(html).not.toContain(REF);
  });

  it("while the status loads: the skeleton, and it says so politely", () => {
    const html = view("checking", null);
    expect(html).toContain('data-testid="skeleton"');
    expect(html).toContain("Checking your recent booking.");
    expect(html).not.toContain("Nothing to check out yet");
    expect(html).not.toContain("already paid");
  });
});

describe("the pages use it", () => {
  it("/checkout keeps its empty state as the fallback and its skeleton while checking", () => {
    const src = read("src/app/checkout/page.tsx");
    expect(src).toContain("<EmptyCartOrPaidBooking");
    expect(src).toContain('headingAs="h1"');
    expect(src).toContain('title="Nothing to check out yet"');
    expect(src).toContain('skeleton={<div className="skeleton h-96 w-full rounded-[var(--radius-tile)]" />}');
  });

  it("/cart shows the same notice", () => {
    const src = read("src/app/cart/page.tsx");
    expect(src).toContain("<EmptyCartOrPaidBooking");
    expect(src).toContain('title="Your trip is empty"');
  });

  it("the status page writes the marker only where it clears the paid cart", () => {
    const src = read("src/components/commerce/order-status/order-status-view.tsx");
    expect(src).toMatch(/shouldClearPaidCart\([^)]*\)\)\) \{\s*clearCart\(\);[\s\S]{0,200}writePaidMarker\(status\.reference\);\s*\}/);
    expect(src.match(/writePaidMarker\(/g)).toHaveLength(1);
  });

  it("the notice sends no analytics (PRV-4)", () => {
    for (const f of ["src/components/commerce/paid-booking-notice.tsx", "src/lib/paid-booking.ts"]) {
      const src = read(f);
      expect(src, f).not.toMatch(/from\s+["']@\/lib\/analytics["']|\btrack\(|from\s+["']@\/lib\/api["']/);
    }
  });
});
