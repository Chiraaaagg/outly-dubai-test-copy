/*
 * Ticket Confirmation Card, imported from 21st.dev.
 * Author: ravikatiyar162. Source: https://21st.dev/@ravikatiyar162/components/ticket-confirmation-card
 * (demo id 6492), retrieved 12 Nov 2026.
 * Licence: the owner holds a licence for this component (owner decision,
 * 12 Nov 2026). 21st.dev states no licence (empty field); the owner's licence
 * covers it.
 * Ported from the prototype's edited copy,
 * docs/checkout-redesign-review/components/ticket-confirmation-card/outly/component.tsx
 * (original: ../component.tsx in the same folder).
 *
 * Edits carried over from the prototype copy (recorded in components/SOURCES.md):
 *   - copy: heading and sub-line became props; labels "Reference", "Paid",
 *     "When (Dubai time)"; amount in AED; date in Asia/Dubai with the weekday;
 *     the payment-card row shows the meeting point through the component's
 *     existing `icon` prop (falls back to the original mark);
 *   - owner decision d: the barcode is replaced by the text passed as
 *     `barcodeValue` ("Show the voucher PDF at the jetty"); nothing scannable;
 *   - owner decision c: confetti once per page session (sessionStorage, module
 *     flag fallback), never with prefers-reduced-motion; OUTLYY colours;
 *   - typography: reference in tabular numerals instead of monospace;
 *   - approved structural edit (owner, 12 Nov 2026): the card heading is h2.
 * Edits for the app (docs/checkout-redesign-review/notes/batch2-components.md):
 *   - "use client"; the unused Barcode function is removed (nothing renders it);
 *   - copy (part B): `currency` prop (default "AED") instead of the fixed
 *     "AED " prefix, because an order can settle in INR;
 *   - review fixes (part B): confetti positions drawn once per mount
 *     (useState), not on every re-render; the barcode-replacement line and its
 *     dashed rule render only when `barcodeValue` is not empty;
 *     the once-per-session check (`confettiAllowed`) and its record
 *     (`markConfettiPlayed`, when the confetti starts, so StrictMode's double
 *     effect run cannot use it up) exported for their test;
 *   - typing: TicketProps omits the HTML `title` attribute, which clashed with
 *     the ReactNode `title` prop the prototype copy added;
 *   - brand colours: card = paper, text = ink-900, muted-foreground = ink-600,
 *     muted = shell, primary tint = sun-500/10 with sun-700 check, cut-outs =
 *     sand, dashed line = ink-200, shadow-lg = shadow-lift; radius = --radius-card;
 *   - entrance: the tw-animate-css classes (animate-in fade-in-0 zoom-in-95 /
 *     zoom-in-50 / zoom-in-75) were first written with the app's own `pop-in`
 *     keyframe; post-payment A5 replaced them with the `[data-entrance]`
 *     entrance described below (what ships is in the A5 fix round 2 notes).
 * Edits for open-dated tickets (doc 29 §8.5, Batch 5; same component, no new
 * import): optional `dateOnly` (the date without a time, under `dateLabel`),
 * `details` (the validity line, the ticket types and the non-refundable
 * statement) and `action` (the secure download), each rendered only when
 * given, so the existing voucher card is unchanged.
 * Repair for post-payment batch A5 (owner approval 27 Nov 2026; same
 * component, no new import; 20-status-ui.md §2, §7):
 *   - one card per booked item (the page renders several): `headingLevel`
 *     (h2 alone, h3 under the page's section heading); `amount` optional,
 *     because the projection has no per-item price; the amount is grouped
 *     (12,345.00) and wraps under the reference on a narrow screen;
 *   - the celebration is the page's decision, once per order reference: the
 *     confetti is `ConfettiBurst`, rendered once by the page, with
 *     `celebrationAllowed(reference)` / `markCelebrated(reference)` replacing
 *     the one global per-tab key; it is removed when its last piece has
 *     finished falling (was a fixed 6 s against pieces lasting up to 7 s);
 *     its `fall` keyframe moved from an injected <style> to globals.css
 *     (`confetti-fall`);
 *   - entrance: `entrance` plays it once, when the card is actually in view
 *     (IntersectionObserver), and reports that moment (`onEntranceStart`) so
 *     the page starts the confetti then. The server render and every fallback
 *     show the final state: the card is hidden for its entrance only on the
 *     client, only before it is painted or while it is off-screen, and never
 *     with reduced motion (globals.css `ticket-enter`, `[data-entrance]`);
 *   - phones and 200% zoom: padding p-5 sm:p-8; the cut-outs are clipped to
 *     half circles inside the card (overflow hidden) instead of hanging 16px
 *     outside it, which caused sideways scroll at 320 px; `last4Digits` may be
 *     a node (the pickup line).
 * A5 fix round 2 (animation reviews 99a/99b; owner decision 27 Nov 2026,
 * "celebrate only on fresh confirmation"):
 *   - the page decides per card: the entrance and the confetti play only for
 *     a card that became booked during this page load, or right after the
 *     Stripe return (`?result=success`). Later visits show the final card at
 *     once. The per-tab sessionStorage gate is gone; an in-memory set keeps
 *     it to one burst per order per load, and no browser storage is used;
 *   - what ships (globals.css): the card `ticket-enter` 320 ms
 *     `--ease-out-soft`; one badge part, `pop-in` 280 ms `--ease-spring` at
 *     +140 ms (the check part is gone); cards entering in the same observer
 *     callback are staggered 60 ms in visual order (`--entrance-delay`);
 *     `data-entrance` is removed when the badge's animation ends;
 *   - trigger: one IntersectionObserver per card list, threshold 0 with a
 *     15% bottom margin (any height of card), plus failsafes: focus inside
 *     the card reveals it at once, and a once-a-second check plays it if it
 *     is on screen while the observer has not fired. Server HTML is never
 *     hidden; it only reports the moment when it comes into view;
 *   - confetti: pieces start just above the top edge, wait at most 0.6 s,
 *     hold full opacity to 75% of the fall, each with its own start angle,
 *     signed spin, sideways drift and (for half of them) a tumble axis, set
 *     as variables on the piece itself; 40 pieces on a 360 px screen up to
 *     100 from 1200 px; colour tokens; layer z-[5] (behind the card), hidden
 *     in print; the page starts it only while the tab is visible.
 */
"use client";

import * as React from "react";
import { cn } from "@/lib/utils";

// --- SVG Icons ---

const CheckCircleIcon = (props: React.SVGProps<SVGSVGElement>) => (
  <svg
    {...props}
    xmlns="http://www.w3.org/2000/svg"
    width="24"
    height="24"
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth="2"
    strokeLinecap="round"
    strokeLinejoin="round"
  >
    <path d="M22 11.08V12a10 10 0 1 1-5.93-9.14" />
    <polyline points="22 4 12 14.01 9 11.01" />
  </svg>
);

const MastercardIcon = (props: React.SVGProps<SVGSVGElement>) => (
    <svg
        {...props}
        xmlns="http://www.w3.org/2000/svg"
        viewBox="0 0 24 24"
        width="36"
        height="24"
    >
        <circle cx="8" cy="12" r="7" fill="#EA001B"></circle>
        <circle cx="16" cy="12" r="7" fill="#F79E1B" fillOpacity="0.8"></circle>
    </svg>
);


// --- Helper Components ---

const DashedLine = () => (
  <div
    className="w-full border-t-2 border-dashed border-ink-200"
    aria-hidden="true"
  />
);

const CONFETTI_MIN = 40;
const CONFETTI_MAX = 100;
// OUTLYY colour tokens (globals.css); the values were these tokens' hex before A5 fix round 2.
const CONFETTI_COLORS = [
  "var(--color-sun-500)",
  "var(--color-lagoon-500)",
  "var(--color-sunset-500)",
  "var(--color-dune-400)",
  "var(--color-ink-700)",
  "var(--color-sun-300)",
];

/** Pieces for a screen this wide: about 40 on a 360 px phone, 100 from 1200 px (review 99b: no curtain on phones). */
export function confettiCount(width: number): number {
  if (!Number.isFinite(width) || width <= 0) return CONFETTI_MIN;
  return Math.round(Math.min(CONFETTI_MAX, Math.max(CONFETTI_MIN, width / 12)));
}

export interface ConfettiPiece {
  /** Horizontal start, % of the viewport width. */
  left: number;
  /** Extra start height above the top edge, in vh (the piece always starts fully above it). */
  top: number;
  /** Start angle, degrees. */
  rotate: number;
  /** Signed turn over the fall, degrees: 360 to 900 either way. */
  spin: number;
  /** Sideways drift over the fall, vw: up to 15 either way. */
  drift: number;
  /** Half the pieces tumble on a tilted axis (paper), the rest turn flat. */
  tumble: boolean;
  /** Seconds. */
  duration: number;
  /** Seconds, at most 0.6 so the burst lands with the card. */
  delay: number;
}

/** One random set of pieces. Exported for its test: the burst must last as long as its slowest piece. */
export function drawConfetti(count = CONFETTI_MAX, random: () => number = Math.random): ConfettiPiece[] {
  return Array.from({ length: count }, () => ({
    left: random() * 100,
    top: random() * 4,
    rotate: random() * 360,
    spin: (random() < 0.5 ? -1 : 1) * (360 + random() * 540),
    drift: (random() * 2 - 1) * 15,
    tumble: random() < 0.5,
    duration: 2.5 + random() * 2.5,
    delay: random() * 0.6,
  }));
}

/** How long a burst lasts: until its last piece has finished falling, plus a frame. */
export function confettiLifetimeMs(pieces: ReadonlyArray<{ duration: number; delay: number }>): number {
  const longest = pieces.reduce((max, p) => Math.max(max, p.delay + p.duration), 0);
  return Math.ceil(longest * 1000) + 100;
}

/** The inline style of one piece: placement, colour, and its own variables for the `confetti-fall` keyframe. */
export function confettiPieceStyle(piece: ConfettiPiece, index: number): React.CSSProperties {
  return {
    left: `${piece.left}%`,
    top: `calc(-1.25rem - ${piece.top}vh)`,
    backgroundColor: CONFETTI_COLORS[index % CONFETTI_COLORS.length],
    // On each piece, never on the container: a variable on the parent would restyle every piece.
    "--r0": `${piece.rotate}deg`,
    "--spin": `${piece.spin}deg`,
    "--drift": `${piece.drift}vw`,
    "--axis": piece.tumble ? "1, 0.5, 0.3" : "0, 0, 1",
    animation: `confetti-fall ${piece.duration}s linear ${piece.delay}s both`,
  } as React.CSSProperties;
}

/**
 * The confetti, once per order (owner decision c, post-payment A5). Rendered
 * by the page, never by each card, so several cards make one celebration.
 * Decorative and hidden from assistive technology; `onDone` fires when the
 * slowest piece has landed, and the page then removes it. Behind the card
 * (z-[5] under its z-10), never printed.
 */
export function ConfettiBurst({ onDone }: { onDone?: () => void }) {
  // Drawn once per mount (review fix, part B): the status page re-renders on every poll, and new
  // random positions each time would restart the pieces mid-fall.
  const [pieces] = React.useState(() => drawConfetti(confettiCount(typeof window === "undefined" ? 0 : window.innerWidth)));
  const done = React.useRef(onDone);
  React.useEffect(() => {
    done.current = onDone;
  }, [onDone]);
  React.useEffect(() => {
    const timer = setTimeout(() => done.current?.(), confettiLifetimeMs(pieces));
    return () => clearTimeout(timer);
  }, [pieces]);

  return (
    <div className="fixed inset-0 z-[5] pointer-events-none overflow-hidden print:hidden" aria-hidden="true" data-testid="confetti">
      {pieces.map((piece, i) => (
        <div key={i} className="absolute w-2 h-4" style={confettiPieceStyle(piece, i)} />
      ))}
    </div>
  );
}


// Once per order reference per page load, and never with reduced motion
// (owner decision c). Whether a load celebrates at all is the page's call
// (owner decision 27 Nov 2026: only a fresh confirmation, `celebratesOnThisLoad`
// in ticket-cards.tsx); this in-memory set only stops a second burst within
// the load (several cards, StrictMode). Nothing is written to browser storage.
// Recorded only when the confetti actually starts (follow-up D): under React
// StrictMode the mount effect runs twice and the first run is cancelled.
const celebratedThisLoad = new Set<string>();

function reducedMotion(): boolean {
  return typeof window !== "undefined" && Boolean(window.matchMedia?.("(prefers-reduced-motion: reduce)").matches);
}

export function celebrationAllowed(reference: string): boolean {
  if (typeof window === "undefined" || !reference) return false;
  if (reducedMotion()) return false;
  return !celebratedThisLoad.has(reference);
}

export function markCelebrated(reference: string): void {
  celebratedThisLoad.add(reference);
}

type VisibilityTarget = Pick<Document, "visibilityState" | "addEventListener" | "removeEventListener">;

/**
 * Runs `fn` now if the page is visible, otherwise once, on the first
 * `visibilitychange` that makes it visible (review 99b: a payment return that
 * loads in a background tab must not spend the celebration unseen). Returns a
 * cancel function.
 */
export function whenVisible(doc: VisibilityTarget, fn: () => void): () => void {
  if (doc.visibilityState === "visible") {
    fn();
    return () => {};
  }
  const onChange = () => {
    if (doc.visibilityState !== "visible") return;
    doc.removeEventListener("visibilitychange", onChange);
    fn();
  };
  doc.addEventListener("visibilitychange", onChange);
  return () => doc.removeEventListener("visibilitychange", onChange);
}

// --- Entrance ---

/** The bottom share of the viewport a card must clear before it enters. */
const ENTRANCE_BOTTOM_MARGIN = 0.15;
/** Fires when the card's top edge is 15% into the viewport, whatever the card's height (review 99a, finding 2). */
export const ENTRANCE_OBSERVER_OPTIONS: IntersectionObserverInit = { threshold: 0, rootMargin: `0px 0px -${ENTRANCE_BOTTOM_MARGIN * 100}% 0px` };
/** Between cards that enter in the same observer callback (review 99a, finding 7). */
export const ENTRANCE_STAGGER_MS = 60;
/** How often a waiting card checks that it is not on screen with the observer silent (failsafe). */
export const ENTRANCE_FAILSAFE_MS = 1000;

type EntryLike = Pick<IntersectionObserverEntry, "isIntersecting" | "target"> & {
  boundingClientRect: Pick<DOMRectReadOnly, "top" | "left">;
};
type ObserverLike = { observe(el: Element): void; unobserve(el: Element): void };
type ObserverFactory = (callback: (entries: EntryLike[]) => void, options: IntersectionObserverInit) => ObserverLike;

/** One observer shared by the cards of a list, so cards entering together are staggered by their order on screen. */
export interface EntranceHost {
  /** Calls `onEnter(index)` once, `index` being the card's place among the cards entering in the same callback. Returns a cancel. */
  observe(el: Element, onEnter: (index: number) => void): () => void;
}

const browserObserver: ObserverFactory = (callback, options) =>
  new IntersectionObserver((entries) => callback(entries), options);

export function createEntranceObserver(make: ObserverFactory = browserObserver): EntranceHost {
  let io: ObserverLike | null = null;
  const waiting = new Map<Element, (index: number) => void>();
  const observer = () =>
    (io ??= make((entries) => {
      const entering = entries
        .filter((e) => e.isIntersecting && waiting.has(e.target))
        .sort((a, b) => a.boundingClientRect.top - b.boundingClientRect.top || a.boundingClientRect.left - b.boundingClientRect.left);
      entering.forEach((e, index) => {
        const onEnter = waiting.get(e.target);
        waiting.delete(e.target);
        io?.unobserve(e.target);
        onEnter?.(index);
      });
    }, ENTRANCE_OBSERVER_OPTIONS));
  return {
    observe(el, onEnter) {
      waiting.set(el, onEnter);
      observer().observe(el);
      return () => {
        if (waiting.delete(el)) io?.unobserve(el);
      };
    },
  };
}

type EntranceElement = Pick<HTMLElement, "dataset" | "style" | "addEventListener" | "removeEventListener" | "querySelector" | "getBoundingClientRect">;

export interface EntranceOptions {
  host: EntranceHost;
  /** Server HTML being hydrated: it was painted before any script, so it is never hidden; the moment is only reported. */
  hydrated: boolean;
  onStart?: () => void;
  /** Whether the card is on screen in a visible tab (the failsafe's test). */
  onScreen?: (el: EntranceElement) => boolean;
  setTimer?: (fn: () => void, ms: number) => unknown;
  clearTimer?: (id: unknown) => void;
}

/** The observer's own test (same bottom margin), so the failsafe never plays a card the observer would still hold. */
function cardOnScreen(el: EntranceElement): boolean {
  if (typeof document !== "undefined" && document.visibilityState === "hidden") return false;
  const box = el.getBoundingClientRect();
  return box.top < window.innerHeight * (1 - ENTRANCE_BOTTOM_MARGIN) && box.bottom > 0;
}

/**
 * The entrance of one card, on its element's attributes only (no React state).
 * Returns a detach function, which says whether the entrance had already
 * started ("started") or may be attached again ("unfinished").
 *
 *  - hydrated server HTML: never hidden; `onStart` when it comes into view;
 *  - otherwise: `data-entrance="pending"` (before paint) and then "play" with
 *    `--entrance-delay` when it comes into view; `onStart` then. Failsafes:
 *    focus inside the card reveals it at once (no animation), and every
 *    `ENTRANCE_FAILSAFE_MS` a card still pending that is on screen plays;
 *  - the attribute and the delay are removed when the badge's animation ends
 *    (or any of the card's animations is cancelled), so the resting card is
 *    the attribute-less server state.
 */
export function attachEntrance(el: EntranceElement, opts: EntranceOptions): () => "started" | "unfinished" {
  const onScreen = opts.onScreen ?? cardOnScreen;
  const setTimer = opts.setTimer ?? ((fn: () => void, ms: number) => setTimeout(fn, ms));
  const clearTimer = opts.clearTimer ?? ((id: unknown) => clearTimeout(id as ReturnType<typeof setTimeout>));
  let started = false;

  if (opts.hydrated) {
    const cancel = opts.host.observe(el as unknown as Element, () => {
      started = true;
      opts.onStart?.();
    });
    return () => {
      cancel();
      return started ? "started" : "unfinished";
    };
  }

  const badge = el.querySelector('[data-entrance-part="badge"]');
  let timer: unknown = null;
  let cancelObserve: () => void = () => {};

  const finish = () => {
    el.removeEventListener("animationend", onEnd);
    el.removeEventListener("animationcancel", onCancel);
    delete el.dataset.entrance;
    el.style.removeProperty("--entrance-delay");
  };
  const onEnd = (e: Event) => {
    if (e.target === (badge ?? el)) finish();
  };
  const onCancel = () => finish();

  const stopWaiting = () => {
    cancelObserve();
    if (timer !== null) clearTimer(timer);
    timer = null;
    el.removeEventListener("focusin", onFocus);
  };
  const begin = (play: boolean, index: number) => {
    if (started) return;
    started = true;
    stopWaiting();
    if (play) {
      el.style.setProperty("--entrance-delay", `${index * ENTRANCE_STAGGER_MS}ms`);
      el.addEventListener("animationend", onEnd);
      el.addEventListener("animationcancel", onCancel);
      el.dataset.entrance = "play";
    } else {
      delete el.dataset.entrance;
    }
    opts.onStart?.();
  };
  const onFocus = () => begin(false, 0);
  const check = () => {
    timer = null;
    if (started) return;
    if (onScreen(el)) begin(true, 0);
    else timer = setTimer(check, ENTRANCE_FAILSAFE_MS);
  };

  el.dataset.entrance = "pending";
  el.addEventListener("focusin", onFocus);
  cancelObserve = opts.host.observe(el as unknown as Element, (index) => begin(true, index));
  timer = setTimer(check, ENTRANCE_FAILSAFE_MS);

  return () => {
    stopWaiting();
    if (!started) {
      // An interrupted entrance (unmount, StrictMode's second run) never leaves the card hidden, and may run again.
      delete el.dataset.entrance;
      return "unfinished";
    }
    if (el.dataset.entrance === "play") finish();
    return "started";
  };
}

// True only while React hydrates server HTML; false for a card mounted later (a poll that turned the order booked).
const noSubscription = () => () => {};
function useHydrating(): boolean {
  return React.useSyncExternalStore(noSubscription, () => false, () => true);
}

const useIsomorphicLayoutEffect = typeof window === "undefined" ? React.useEffect : React.useLayoutEffect;

const EntranceContext = React.createContext<EntranceHost | null>(null);

/** One shared observer for the cards inside (review 99a, finding 7). Created lazily, only in a browser. */
export function EntranceGroup({ children }: { children: React.ReactNode }) {
  const [host] = React.useState<EntranceHost | null>(() => (typeof IntersectionObserver === "undefined" ? null : createEntranceObserver()));
  return <EntranceContext.Provider value={host}>{children}</EntranceContext.Provider>;
}

/** The card's entrance (post-payment A5): see `attachEntrance`. Nothing with reduced motion or without IntersectionObserver. */
function useEntrance(ref: React.RefObject<HTMLDivElement | null>, enabled: boolean, onStart?: () => void) {
  const hydrating = useHydrating();
  const wasHydrating = React.useRef(hydrating);
  const shared = React.useContext(EntranceContext);
  const decided = React.useRef(false);
  const start = React.useRef(onStart);
  React.useEffect(() => {
    start.current = onStart;
  }, [onStart]);

  useIsomorphicLayoutEffect(() => {
    const el = ref.current;
    if (!enabled || decided.current || !el || reducedMotion() || typeof IntersectionObserver === "undefined") return;
    decided.current = true;
    const detach = attachEntrance(el, {
      host: shared ?? createEntranceObserver(),
      hydrated: wasHydrating.current,
      onStart: () => start.current?.(),
    });
    return () => {
      if (detach() === "unfinished") decided.current = false;
    };
  }, [enabled, ref, shared]);
}

// --- Main Ticket Component ---

export interface TicketProps extends Omit<React.HTMLAttributes<HTMLDivElement>, "title"> {
  ticketId: string;
  /** Major units, or null/absent to leave the "Paid" cell out (A5: the projection has no per-item price). */
  amount?: number | null;
  date: Date;
  cardHolder: string;
  last4Digits: React.ReactNode;
  barcodeValue: string;
  icon?: React.ReactNode;
  title?: React.ReactNode;
  subtitle?: React.ReactNode;
  /** Currency code printed before the amount (copy edit, part B: INR orders exist). */
  currency?: string;
  /** Batch 5: show the date only (an open-dated ticket has no start time). */
  dateOnly?: boolean;
  /** Label above the date; defaults to "When (Dubai time)". */
  dateLabel?: string;
  /** Batch 5: extra rows under the date (validity, ticket types, non-refundable statement). */
  details?: React.ReactNode;
  /** Batch 5: the secure download action, shown at the foot of the card. */
  action?: React.ReactNode;
  /** A5: h2 for a card on its own, h3 under the page's section heading. */
  headingLevel?: 2 | 3;
  /** A5: this card celebrates (the page's call: a fresh confirmation only); the entrance plays once, when it comes into view. */
  entrance?: boolean;
  /** A5: called when the entrance starts, or, for server HTML (never hidden), when it comes into view. */
  onEntranceStart?: () => void;
}

function formatAmount(amount: number, currency: string): string {
  const locale = currency === "INR" ? "en-IN" : "en-GB";
  return `${currency} ${amount.toLocaleString(locale, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

const AnimatedTicket = React.forwardRef<HTMLDivElement, TicketProps>(
  (
    {
      className,
      ticketId,
      amount = null,
      date,
      cardHolder,
      last4Digits,
      barcodeValue,
      icon,
      title = "Your booking is confirmed",
      subtitle = "Confirmed by the operator",
      currency = "AED",
      dateOnly = false,
      dateLabel = "When (Dubai time)",
      details,
      action,
      headingLevel = 2,
      entrance = false,
      onEntranceStart,
      ...props
    },
    ref
  ) => {
    const own = React.useRef<HTMLDivElement | null>(null);
    const setRef = React.useCallback(
      (node: HTMLDivElement | null) => {
        own.current = node;
        if (typeof ref === "function") ref(node);
        else if (ref) ref.current = node;
      },
      [ref],
    );
    useEntrance(own, entrance, onEntranceStart);

    const Heading = headingLevel === 3 ? "h3" : "h2";
    const formattedAmount = amount !== null && Number.isFinite(amount) ? formatAmount(amount, currency) : null;

    const formattedDate = dateOnly
      ? new Intl.DateTimeFormat("en-GB", { timeZone: "Asia/Dubai", weekday: "short", day: "numeric", month: "short", year: "numeric" }).format(date).replace(",", "")
      : new Intl.DateTimeFormat("en-GB", {
          timeZone: "Asia/Dubai",
          weekday: 'short',
          day: 'numeric',
          month: 'short',
          year: 'numeric',
          hour: '2-digit',
          minute: '2-digit',
          hour12: false
        }).format(date).replace(/,(?=[^,]*$)/, ' ·').replace(",", "");

    return (
        <div
          ref={setRef}
          className={cn(
            "relative w-full max-w-sm overflow-hidden bg-paper text-ink-900 rounded-[var(--radius-card)] shadow-lift font-sans z-10",
            className
          )}
          {...props}
        >
          {/* Ticket cut-out effect: half circles, clipped by the card (A5: no sideways scroll on phones). */}
          <div className="absolute -left-4 top-1/2 -translate-y-1/2 w-8 h-8 rounded-full bg-sand" aria-hidden="true" />
          <div className="absolute -right-4 top-1/2 -translate-y-1/2 w-8 h-8 rounded-full bg-sand" aria-hidden="true" />

          <div className="p-5 sm:p-8 flex flex-col items-center text-center">
              <div className="p-3 bg-sun-500/10 rounded-full" data-entrance-part="badge">
                  <CheckCircleIcon aria-hidden="true" className="w-10 h-10 text-sun-700" />
              </div>
              <Heading className="text-2xl font-semibold mt-4 break-words [overflow-wrap:anywhere]">{title}</Heading>
              <p className="text-ink-600 mt-1">
                {subtitle}
              </p>
          </div>

          <div className="px-5 pb-5 sm:px-8 sm:pb-8 space-y-6">
              <DashedLine />

              <div className="flex flex-wrap items-start justify-between gap-x-4 gap-y-3 text-left">
                  <div className="min-w-0">
                      <p className="text-xs text-ink-600 uppercase">Reference</p>
                      <p className="font-medium tabular-nums break-all">{ticketId}</p>
                  </div>
                  {formattedAmount ? (
                    <div className="text-right ml-auto">
                        <p className="text-xs text-ink-600 uppercase">Paid</p>
                        <p className="font-semibold text-lg tabular-nums whitespace-nowrap">{formattedAmount}</p>
                    </div>
                  ) : null}
              </div>

              <div className="text-left">
                  <p className="text-xs text-ink-600 uppercase">{dateLabel}</p>
                  <p className="font-medium tabular-nums">{formattedDate}</p>
              </div>

              {details ? <div className="space-y-1.5 text-left text-sm text-ink-700">{details}</div> : null}

              <div className="bg-shell p-4 rounded-[var(--radius-card)] flex items-center gap-4 text-left">
                  {icon ?? <MastercardIcon />}
                  <div className="min-w-0">
                      <p className="font-semibold">{cardHolder}</p>
                      <div className="text-ink-600 text-sm">{last4Digits}</div>
                  </div>
              </div>

              {/* Barcode replaced (owner decision d): nothing scannable is drawn. The line is shown only
                  when the caller has something true to say there (review fix, part B). */}
              {barcodeValue ? (
                <>
                  <DashedLine />
                  <p className="py-2 text-center text-[0.9375rem] font-semibold text-ink-900">{barcodeValue}</p>
                </>
              ) : null}

              {action ? <div className="relative z-10 text-left">{action}</div> : null}
          </div>
        </div>
    );
  }
);

AnimatedTicket.displayName = "AnimatedTicket";

export { AnimatedTicket };
