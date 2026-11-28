import { createElement as h } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import type { CustomerAuthOptions } from "@/lib/customer-auth-options";

/**
 * /login, Google first with the email code collapsed (owner, 28 Nov 2026;
 * src/components/auth/login-16.tsx). The unit project has no DOM, so the
 * choice of state is tested on the pure rule and the markup on a static
 * render: the collapsed state, the opened state (a sign-in already under
 * way), and the cases where the form must show open because Google does not
 * lead. Clicking and focus need a browser (staging check).
 */

vi.mock("next/navigation", () => ({ useRouter: () => ({ replace: () => {}, refresh: () => {}, push: () => {} }) }));
// A plain anchor in place of the router-aware link: no app router is mounted in a static render.
vi.mock("next/link", async () => {
  const { createElement } = await import("react");
  return { default: ({ href, children, ...rest }: { href: string; children?: unknown } & Record<string, unknown>) => createElement("a", { href, ...rest }, children as never) };
});

const { EMAIL_PANEL_ID, LoginClient, emailPanelMode } = await import("../login-client");

const both: CustomerAuthOptions = { emailCode: true, google: true, phone: false, turnstileSiteKey: null };
const render = (over: Partial<Parameters<typeof LoginClient>[0]> = {}) =>
  renderToStaticMarkup(h(LoginClient, { options: both, next: "/account/bookings", notice: null, inAppBrowser: false, ...over }));

describe("which state the email form starts in", () => {
  it("collapsed behind the toggle only when Google leads; open when it leads or is the only way", () => {
    expect(emailPanelMode({ email: true, googleFirst: true, emailInProgress: false })).toBe("collapsed");
    expect(emailPanelMode({ email: true, googleFirst: true, emailInProgress: true })).toBe("expanded");
    expect(emailPanelMode({ email: true, googleFirst: false, emailInProgress: false })).toBe("open");
    expect(emailPanelMode({ email: false, googleFirst: true, emailInProgress: true })).toBe("none");
  });
});

describe("/login markup", () => {
  it("Google first: the button, its reason, then a collapsed 'Use email instead' that controls a hidden panel", () => {
    const html = render();
    const google = html.indexOf("Continue with Google");
    const reason = html.indexOf("Fastest: no code to wait for.");
    const toggle = html.indexOf("Use email instead");
    const panel = html.indexOf(`id="${EMAIL_PANEL_ID}"`);
    expect(google).toBeGreaterThan(-1);
    expect(google).toBeLessThan(reason);
    expect(reason).toBeLessThan(toggle);
    expect(toggle).toBeLessThan(panel);
    expect(html).toMatch(new RegExp(`<button type="button" aria-expanded="false" aria-controls="${EMAIL_PANEL_ID}"`));
    expect(html).toContain(`<div id="${EMAIL_PANEL_ID}" hidden="">`);
    // The form is not even mounted until it is opened (no robot check loads for a Google sign-in).
    expect(html).not.toContain('id="login-email"');
  });

  it("an email sign-in already under way opens the panel by itself", () => {
    for (const html of [render({ emailInProgress: true }), render({ notice: "google_failed" })]) {
      expect(html).toMatch(new RegExp(`aria-expanded="true" aria-controls="${EMAIL_PANEL_ID}"`));
      expect(html).toContain(`<div id="${EMAIL_PANEL_ID}">`);
      expect(html).toContain('id="login-email"');
    }
  });

  it("without Google, the email form shows open with no toggle; the only way is never hidden", () => {
    const html = render({ options: { ...both, google: false } });
    expect(html).not.toContain("Use email instead");
    expect(html).not.toContain("Continue with Google");
    expect(html).toContain('id="login-email"');
  });

  it("in an in-app browser the email form leads, open, and Google follows it", () => {
    const html = render({ inAppBrowser: true });
    expect(html).not.toContain("Use email instead");
    expect(html.indexOf('id="login-email"')).toBeGreaterThan(-1);
    expect(html.indexOf('id="login-email"')).toBeLessThan(html.indexOf("Continue with Google"));
  });

  it("Google alone: no toggle", () => {
    const html = render({ options: { ...both, emailCode: false } });
    expect(html).toContain("Continue with Google");
    expect(html).not.toContain("Use email instead");
  });

  it("the Google button follows Google's light branding, never OUTLYY's sun; pilot carries on to the start", () => {
    const html = render({ pilot: true });
    const button = /<a href="([^"]+)" class="([^"]+)">/.exec(html.slice(html.lastIndexOf("<a", html.indexOf("Continue with Google"))));
    expect(button).not.toBeNull();
    // The static render escapes `&` in attributes.
    expect(button![1]).toBe("/api/auth/google/start?next=%2Faccount%2Fbookings&amp;pilot=1");
    expect(button![2]).toContain("border-[#747775]");
    expect(button![2]).toContain("bg-[#ffffff]");
    expect(button![2]).toContain("text-[#1f1f1f]");
    expect(button![2]).toContain("min-h-12");
    expect(button![2]).toContain("w-full");
    expect(button![2]).not.toMatch(/sun-/);
  });
});
