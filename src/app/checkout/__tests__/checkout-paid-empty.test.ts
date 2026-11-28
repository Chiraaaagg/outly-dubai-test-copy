import { readFileSync } from "node:fs";
import { join } from "node:path";
import { createElement as h } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { EmptyCartView, type PaidBookingPhase } from "@/components/commerce/paid-booking-notice";
import { EmptyState } from "@/components/ui/primitives";
import { resolvePaidBooking, type NoticeStatus, type PaidBookingNotice } from "@/lib/paid-booking";

/**
 * The empty /checkout and /cart after a paid booking (production fix,
 * 28 Nov 2026; review 116). The checkout page is a large client component
 * with no render harness, so the branch is rendered through `EmptyCartView`
 * (what each phase shows) fed by `resolvePaidBooking` (what the server said).
 * The timing of the mounted component (8 second fallback, late answer,
 * unmount) is tested on `startPaidBookingCheck` in
 * src/lib/__tests__/paid-booking.test.ts, and the real pages in
 * e2e/checkout-paid-empty.spec.ts. The pages' wiring is pinned on the source.
 * Synthetic references; no network.
 */

const REF = "OUT-123455";
const MARKER = { reference: REF, paidAt: Date.UTC(2026, 10, 28, 12, 0, 0) };
const FALLBACK_TITLE = "Nothing to check out yet";
const read = (path: string) => readFileSync(join(process.cwd(), path), "utf8");

function memory() {
  const m = new Map<string, string>();
  return { getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => void m.set(k, v), removeItem: (k: string) => void m.delete(k) };
}

function st(state: string, payment = "done"): NoticeStatus {
  return { reference: REF, state, steps: { payment: { status: payment } } };
}

const GENERIC = h(EmptyState, { headingAs: "h1", illustration: "cart", title: FALLBACK_TITLE, body: "Your trip is empty." });
const SKELETON = h("div", { className: "skeleton h-96 w-full", "data-testid": "skeleton" });

function view(phase: PaidBookingPhase, notice: PaidBookingNotice | null): string {
  return renderToStaticMarkup(h(EmptyCartView, { phase, notice, fallback: GENERIC, fallbackMessage: FALLBACK_TITLE, skeleton: SKELETON, headingAs: "h1" }));
}

/** The branch as the page runs it: the marker (or none), the server's answer, then the view. */
async function emptyCheckout(marker: typeof MARKER | null, server: NoticeStatus | null | "fails"): Promise<string> {
  const notice = await resolvePaidBooking(
    marker,
    async () => {
      if (server === "fails") throw new Error("offline");
      return server;
    },
    memory(),
  );
  return view(!marker ? "none" : notice ? "notice" : "fallback", notice);
}

describe("empty checkout after a paid booking", () => {
  it("marker and a visible confirmed, paid order: the booking, not the empty trip", async () => {
    const html = await emptyCheckout(MARKER, st("confirmed"));
    expect(html).toContain(`<h1 class="text-lg">Your booking ${REF} is confirmed</h1>`);
    expect(html).toContain("You&#x27;ve already paid for this trip, so your cart is empty.");
    expect(html).toMatch(new RegExp(`<a[^>]*href="/booking/${REF}"[^>]*>View booking</a>`));
    expect(html).toMatch(/<a[^>]*href="\/search"[^>]*>Browse experiences<\/a>/);
    expect(html.indexOf("View booking")).toBeLessThan(html.indexOf("Browse experiences"));
    expect(html).not.toContain(FALLBACK_TITLE);
    // The polite status line names the booking; nothing takes focus.
    expect(html).toMatch(new RegExp(`role="status" aria-live="polite"[^>]*>Your booking ${REF} is confirmed</p>`));
    expect(html).not.toMatch(/autofocus|tabindex/i);
  });

  it("marker and an order still being booked, payment not yet confirmed: no payment claimed", async () => {
    const html = await emptyCheckout(MARKER, st("payment_processing", "in_progress"));
    expect(html).toContain(`We&#x27;re confirming your booking ${REF}`);
    expect(html).toContain("We&#x27;re still confirming your payment and booking.");
    expect(html).not.toContain("already paid");
    expect(html).toContain("View booking");
  });

  it("marker and a partly booked order: its own words", async () => {
    const html = await emptyCheckout(MARKER, st("partially_fulfilled"));
    expect(html).toContain(`Part of your booking ${REF} is confirmed`);
    expect(html).not.toContain("already paid");
  });

  it("marker and an order this browser may not see: the usual empty state, announced", async () => {
    const html = await emptyCheckout(MARKER, null);
    expect(html).toContain(`<h1 class="text-lg">${FALLBACK_TITLE}</h1>`);
    expect(html).toMatch(new RegExp(`role="status"[^>]*>${FALLBACK_TITLE}</p>`));
    expect(html).not.toContain(REF);
    expect(html).not.toContain("already paid");
  });

  it("marker and an unpaid order: the usual empty state", async () => {
    for (const state of ["awaiting_payment", "payment_failed"]) {
      const html = await emptyCheckout(MARKER, st(state, "in_progress"));
      expect(html, state).toContain(FALLBACK_TITLE);
      expect(html, state).not.toContain("already paid");
    }
  });

  it("marker and a failed request: the usual empty state", async () => {
    const html = await emptyCheckout(MARKER, "fails");
    expect(html).toContain(FALLBACK_TITLE);
    expect(html).not.toContain("already paid");
  });

  it("no marker: the usual empty state, and no status line", async () => {
    const html = await emptyCheckout(null, st("confirmed"));
    expect(html).toContain(FALLBACK_TITLE);
    expect(html).not.toContain(REF);
    expect(html).not.toContain('role="status"');
  });

  it("while the status loads: the skeleton, and it says so politely", () => {
    const html = view("checking", null);
    expect(html).toContain('data-testid="skeleton"');
    expect(html).toContain("Checking your recent booking.");
    expect(html).not.toContain(FALLBACK_TITLE);
    expect(html).not.toContain("already paid");
  });
});

describe("the pages use it", () => {
  it("/checkout: the notice and its own empty state share the h1, with the same skeleton", () => {
    const src = read("src/app/checkout/page.tsx");
    expect(src).toContain("<EmptyCartOrPaidBooking");
    expect(src).toMatch(/<EmptyCartOrPaidBooking\s+key=\{restored\}\s+headingAs="h1"\s+fallbackMessage="Nothing to check out yet"/);
    expect(src).toMatch(/<EmptyState\s+headingAs="h1"\s+illustration="cart"\s+title="Nothing to check out yet"/);
    expect(src).toContain('skeleton={<div className="skeleton h-96 w-full rounded-[var(--radius-tile)]" />}');
  });

  it("/cart: the same notice, both at h2 under the page h1", () => {
    const src = read("src/app/cart/page.tsx");
    expect(src).toMatch(/<EmptyCartOrPaidBooking\s+key=\{restored\}\s+headingAs="h2"\s+fallbackMessage="Your trip is empty"/);
    expect(src).toMatch(/<EmptyState\s+headingAs="h2"\s+illustration="cart"/);
  });

  it("the status page writes the marker only where it clears the paid cart", () => {
    const src = read("src/components/commerce/order-status/order-status-view.tsx");
    const clearAt = src.indexOf("clearCart();");
    const writeAt = src.indexOf("writePaidMarker(status.reference);");
    expect(clearAt).toBeGreaterThan(src.indexOf("shouldClearPaidCart(handoff"));
    expect(writeAt).toBeGreaterThan(clearAt);
    expect(src.slice(clearAt, writeAt)).not.toContain("}");
    expect(src.match(/writePaidMarker\(/g)).toHaveLength(1);
  });

  it("a new cart or a new payment drops the marker (review 116 D2)", () => {
    const provider = read("src/components/providers/app-provider.tsx");
    const add = provider.slice(provider.indexOf("const addToCart = useCallback("), provider.indexOf("const removeFromCart"));
    expect(add).toContain("clearPaidMarker();");
    const checkout = read("src/app/checkout/page.tsx");
    expect(checkout).toMatch(/clearPaidMarker\(\);\s*writeOrderHint\(r\.orderReference\);/);
  });

  it("a back-forward cache restore reads the cart again and re-runs the checks (review 116 D3)", () => {
    const provider = read("src/components/providers/app-provider.tsx");
    expect(provider).toMatch(/if \(!e\.persisted\) return;\s*const stored = read<CartItem\[\]>\(KEYS\.cart, \[\]\);/);
    expect(provider).toContain("setRestored((n) => n + 1);");
    const checkout = read("src/app/checkout/page.tsx");
    expect(checkout).toMatch(/void checkHandoff\(\);\s*\/\/ eslint-disable-next-line react-hooks\/exhaustive-deps\s*\}, \[hydrated, restored\]\);/);
  });

  it("links into /booking/<reference> from measured pages are full page loads (review 116 D4, PRV-4)", () => {
    for (const f of ["src/app/checkout/page.tsx", "src/app/account/_components/order-row.tsx", "src/components/commerce/paid-booking-notice.tsx"]) {
      const src = read(f);
      expect(src, f).not.toMatch(/<ButtonLink[^>]*href=\{`\/booking\//);
      expect(src, f).not.toMatch(/<ButtonLink[^>]*href=\{notice\.href\}/);
    }
    expect(read("src/app/checkout/page.tsx").match(/<PrivateButtonLink href=\{`\/booking\//g)).toHaveLength(2);
    expect(read("src/components/commerce/paid-booking-notice.tsx")).toContain("<PrivateButtonLink href={notice.href}>View booking</PrivateButtonLink>");
    const button = read("src/components/ui/button.tsx");
    expect(button).toMatch(/export function PrivateButtonLink[\s\S]*?<a \{\.\.\.rest\} href=\{href\}/);
  });

  it("the notice sends no analytics (PRV-4)", () => {
    for (const f of ["src/components/commerce/paid-booking-notice.tsx", "src/lib/paid-booking.ts"]) {
      const src = read(f);
      expect(src, f).not.toMatch(/from\s+["']@\/lib\/analytics["']|\btrack\(|from\s+["']@\/lib\/api["']/);
    }
  });
});
