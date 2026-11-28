/*
 * Centered Social Login (Login 16), imported from 21st.dev.
 * Author: ln-dev7. Source: https://21st.dev/@ln-dev7/components/login-16
 * (demo id 26896), retrieved 27 Nov 2026 through the connected 21st.dev MCP
 * (get_component 26896).
 * Licence: 21st.dev Pro licence (owner).
 * Unedited reference copy: docs/21st-dev/vendor/login-16.tsx.txt.
 * Recorded in THIRD-PARTY-NOTICES.md.
 *
 * Adaptations for OUTLYY (Group B, side-session plan 92 §6):
 *   - structure kept: a narrow centred column, the heading and one line, the
 *     provider button(s) stacked first, then the email form, then the small
 *     print; it renders inside the existing /login page beside the Dubai
 *     scene instead of owning the whole viewport (`min-h-dvh` dropped);
 *   - copy: OUTLYY heading and line; the placeholder "blockus" logo removed
 *     (the site header already carries the OUTLYY mark);
 *   - providers: only the ones the server says work are passed in (no Apple
 *     at launch, owner Q12); the Google button is a real link to our own
 *     start route, not a `type="button"` placeholder; Google's "G" kept as
 *     an inline SVG (from the original's data URI) with `aria-hidden`;
 *   - the email + password form and "Forgot?" removed: the form slot takes
 *     the email-code form (two steps on one card) or the phone form;
 *   - the separator: the original's uppercase, letter-spaced "or" between
 *     two hairlines (@radix-ui/react-separator) became a sentence-case lead
 *     line above the email form, shown only when a provider button is also
 *     present; no new dependency;
 *   - "New here? Create an account" removed: the first sign-in creates the
 *     account, and the terms line says so;
 *   - tokens: shadcn `border-border bg-card text-muted-foreground` mapped onto
 *     OUTLYY ink/paper/sun; `rounded-xl` onto `--radius-control`; 48px
 *     controls (touch target and 16px text so iOS does not zoom); hover only
 *     where hover exists; press feedback on `:active`; no tap flash.
 */
import type { ReactNode } from "react";
import { cn } from "@/lib/utils";

export function Login16({ title, intro, providers, children, footer, className }: { title: string; intro: ReactNode; providers?: ReactNode; children?: ReactNode; footer?: ReactNode; className?: string }) {
  return (
    <section aria-labelledby="login-title" className={cn("w-full", className)}>
      <div className="flex flex-col gap-2">
        <h1 id="login-title" className="text-[1.75rem] leading-tight sm:text-3xl">
          {title}
        </h1>
        <div className="max-w-[60ch] text-[0.95rem] leading-relaxed text-ink-700">{intro}</div>
      </div>
      {providers && <div className="mt-6 flex flex-col gap-3">{providers}</div>}
      {children && <div className="mt-6">{children}</div>}
      {footer && <div className="mt-5">{footer}</div>}
    </section>
  );
}

/** Google's "G", from the original's data URI, as inline SVG. */
function GoogleMark() {
  return (
    <svg viewBox="0 0 256 262" className="h-5 w-5 shrink-0" aria-hidden="true" focusable="false">
      <path fill="#4285f4" d="M255.878 133.451c0-10.734-.871-18.567-2.756-26.69H130.55v48.448h71.947c-1.45 12.04-9.283 30.172-26.69 42.356l-.244 1.622l38.755 30.023l2.685.268c24.659-22.774 38.875-56.282 38.875-96.027" />
      <path fill="#34a853" d="M130.55 261.1c35.248 0 64.839-11.605 86.453-31.622l-41.196-31.913c-11.024 7.688-25.82 13.055-45.257 13.055c-34.523 0-63.824-22.773-74.269-54.25l-1.531.13l-40.298 31.187l-.527 1.465C35.393 231.798 79.49 261.1 130.55 261.1" />
      <path fill="#fbbc05" d="M56.281 156.37c-2.756-8.123-4.351-16.827-4.351-25.82c0-8.994 1.595-17.697 4.206-25.82l-.073-1.73L15.26 71.312l-1.335.635C5.077 89.644 0 109.517 0 130.55s5.077 40.905 13.925 58.602z" />
      <path fill="#eb4335" d="M130.55 50.479c24.514 0 41.05 10.589 50.479 19.438l36.844-35.974C195.245 12.91 165.798 0 130.55 0C79.49 0 35.393 29.301 13.925 71.947l42.211 32.783c10.59-31.477 39.891-54.251 74.414-54.251" />
    </svg>
  );
}

/**
 * "Continue with Google": a top-level navigation to our own start route
 * (owner Q-B1: Google's screen then names this site). A plain `<a>`, never a
 * prefetching link: the route sets a cookie and redirects.
 */
export function GoogleButton({ next }: { next: string }) {
  return (
    <a
      href={`/api/auth/google/start?next=${encodeURIComponent(next)}`}
      className="inline-flex min-h-12 w-full select-none items-center justify-center gap-2.5 rounded-[var(--radius-control)] border border-ink-300 bg-white px-4 text-base font-semibold text-ink-900 transition-[background-color,transform] duration-150 [-webkit-tap-highlight-color:transparent] active:translate-y-px active:bg-shell hover:border-ink-500 hover:bg-shell"
    >
      <GoogleMark />
      Continue with Google
    </a>
  );
}
