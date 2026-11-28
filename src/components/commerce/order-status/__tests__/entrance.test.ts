import { readFileSync } from "node:fs";
import { createElement as h } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import type { CustomerItemStatus, CustomerOrderStatus } from "@/lib/customer-status";
import { attachEntrance, createEntranceObserver, ENTRANCE_FAILSAFE_MS, ENTRANCE_OBSERVER_OPTIONS, ENTRANCE_STAGGER_MS } from "../ticket-confirmation-card";
import { BookedItemCards, celebratesOnThisLoad } from "../ticket-cards";

/**
 * The ticket card entrance after A5 fix round 2 (review 99a) and the owner
 * decision of 27 Nov 2026 ("celebrate only on fresh confirmation"). The unit
 * suite has no DOM, so the observer, the element and the timers are fakes
 * with the browser's shapes; the markup checks use the server render.
 * Synthetic values only.
 */

// --- fakes --------------------------------------------------------------------

type Listener = (e: { target: unknown }) => void;

function fakeCard() {
  const listeners = new Map<string, Set<Listener>>();
  const badge = { id: "badge" };
  const styleProps = new Map<string, string>();
  const el = {
    dataset: {} as Record<string, string | undefined>,
    style: {
      setProperty: (k: string, v: string) => void styleProps.set(k, v),
      removeProperty: (k: string) => {
        styleProps.delete(k);
        return "";
      },
    },
    addEventListener: (type: string, fn: Listener) => {
      if (!listeners.has(type)) listeners.set(type, new Set());
      listeners.get(type)!.add(fn);
    },
    removeEventListener: (type: string, fn: Listener) => void listeners.get(type)?.delete(fn),
    querySelector: (sel: string) => (sel.includes("badge") ? badge : null),
    getBoundingClientRect: () => ({ top: 0, bottom: 100 }),
  };
  const fire = (type: string, target: unknown = el) => {
    for (const fn of [...(listeners.get(type) ?? [])]) fn({ target });
  };
  return { el, badge, styleProps, fire, listeners };
}

function fakeObserver() {
  const observed = new Set<unknown>();
  let callback: ((entries: never[]) => void) | null = null;
  let options: IntersectionObserverInit | null = null;
  let made = 0;
  const host = createEntranceObserver((cb, opts) => {
    made += 1;
    callback = cb as never;
    options = opts;
    return { observe: (el) => void observed.add(el), unobserve: (el) => void observed.delete(el) };
  });
  /** One observer callback; each entry is [element, top, left]. */
  const enter = (...cards: [unknown, number, number][]) =>
    callback?.(cards.map(([target, top, left]) => ({ target, isIntersecting: true, boundingClientRect: { top, left } })) as never[]);
  return { host, observed, enter, options: () => options, made: () => made };
}

function fakeTimers() {
  let next: (() => void) | null = null;
  return {
    setTimer: (fn: () => void, ms: number) => {
      expect(ms).toBe(ENTRANCE_FAILSAFE_MS);
      next = fn;
      return 1;
    },
    clearTimer: () => {
      next = null;
    },
    tick: () => {
      const fn = next;
      next = null;
      fn?.();
    },
    pending: () => next !== null,
  };
}

const asEl = (el: unknown) => el as Parameters<typeof attachEntrance>[0];

// --- trigger --------------------------------------------------------------------

describe("entrance trigger (finding 2)", () => {
  it("one observer at threshold 0 with a bottom margin, so a card of any height can enter", () => {
    expect(ENTRANCE_OBSERVER_OPTIONS.threshold).toBe(0);
    expect(ENTRANCE_OBSERVER_OPTIONS.rootMargin).toMatch(/^0px 0px -\d+% 0px$/);
    const io = fakeObserver();
    const a = fakeCard();
    const b = fakeCard();
    io.host.observe(a.el as never, () => {});
    io.host.observe(b.el as never, () => {});
    expect(io.made()).toBe(1);
    expect(io.options()).toBe(ENTRANCE_OBSERVER_OPTIONS);
  });

  it("a client-mounted card waits hidden, then plays when it enters, and reports the moment once", () => {
    const io = fakeObserver();
    const t = fakeTimers();
    const card = fakeCard();
    const onStart = vi.fn();
    attachEntrance(asEl(card.el), { host: io.host, hydrated: false, onStart, onScreen: () => false, ...t });
    expect(card.el.dataset.entrance).toBe("pending");
    expect(onStart).not.toHaveBeenCalled();
    io.enter([card.el, 10, 0]);
    expect(card.el.dataset.entrance).toBe("play");
    expect(card.styleProps.get("--entrance-delay")).toBe("0ms");
    expect(onStart).toHaveBeenCalledTimes(1);
    expect(t.pending()).toBe(false);
    io.enter([card.el, 10, 0]);
    expect(onStart).toHaveBeenCalledTimes(1);
  });
});

describe("failsafe reveal (finding 2)", () => {
  it("focus inside a waiting card shows it at once", () => {
    const io = fakeObserver();
    const t = fakeTimers();
    const card = fakeCard();
    const onStart = vi.fn();
    attachEntrance(asEl(card.el), { host: io.host, hydrated: false, onStart, onScreen: () => false, ...t });
    card.fire("focusin");
    expect(card.el.dataset.entrance).toBeUndefined();
    expect(onStart).toHaveBeenCalledTimes(1);
    expect(io.observed.size).toBe(0);
    expect(t.pending()).toBe(false);
  });

  it("a card on screen whose observer never fired plays at the next check; off screen it keeps waiting", () => {
    const io = fakeObserver();
    const t = fakeTimers();
    const card = fakeCard();
    let visible = false;
    attachEntrance(asEl(card.el), { host: io.host, hydrated: false, onScreen: () => visible, ...t });
    t.tick();
    expect(card.el.dataset.entrance).toBe("pending");
    expect(t.pending()).toBe(true);
    visible = true;
    t.tick();
    expect(card.el.dataset.entrance).toBe("play");
    expect(t.pending()).toBe(false);
  });

  it("an interrupted entrance (unmount, StrictMode) never leaves the card hidden", () => {
    const io = fakeObserver();
    const t = fakeTimers();
    const card = fakeCard();
    const detach = attachEntrance(asEl(card.el), { host: io.host, hydrated: false, onScreen: () => false, ...t });
    expect(detach()).toBe("unfinished");
    expect(card.el.dataset.entrance).toBeUndefined();
    expect(io.observed.size).toBe(0);
    expect(t.pending()).toBe(false);
  });

  it("the hidden state is only ever opacity on [data-entrance=pending], and print and reduced motion show the card", () => {
    const css = readFileSync(new URL("../../../../app/globals.css", import.meta.url), "utf8");
    expect(css).toMatch(/\[data-entrance="pending"\]\s*\{\s*opacity:\s*0;/);
    expect(css.split("@media print").slice(1).some((b) => /\[data-entrance\]\s*\{[^}]*opacity:\s*1\s*!important/.test(b))).toBe(true);
    expect(css.split("@media (prefers-reduced-motion: reduce)").slice(1).some((b) => /\[data-entrance\]\s*\{[^}]*opacity:\s*1\s*!important/.test(b))).toBe(true);
  });
});

describe("stagger and clean-up (findings 5-8)", () => {
  it("cards entering in the same callback are staggered 60 ms in screen order; a later card starts at 0", () => {
    const io = fakeObserver();
    const left = fakeCard();
    const right = fakeCard();
    const later = fakeCard();
    for (const c of [right, left, later]) attachEntrance(asEl(c.el), { host: io.host, hydrated: false, onScreen: () => false, ...fakeTimers() });
    io.enter([right.el, 100, 400], [left.el, 100, 0]);
    expect(left.styleProps.get("--entrance-delay")).toBe("0ms");
    expect(right.styleProps.get("--entrance-delay")).toBe(`${ENTRANCE_STAGGER_MS}ms`);
    io.enter([later.el, 900, 0]);
    expect(later.styleProps.get("--entrance-delay")).toBe("0ms");
  });

  it("the entrance marker goes when the badge's animation ends, not the card's", () => {
    const io = fakeObserver();
    const card = fakeCard();
    attachEntrance(asEl(card.el), { host: io.host, hydrated: false, onScreen: () => false, ...fakeTimers() });
    io.enter([card.el, 0, 0]);
    card.fire("animationend", card.el);
    expect(card.el.dataset.entrance).toBe("play");
    card.fire("animationend", card.badge);
    expect(card.el.dataset.entrance).toBeUndefined();
    expect(card.styleProps.has("--entrance-delay")).toBe(false);
    expect(card.listeners.get("animationend")?.size ?? 0).toBe(0);
  });

  it("a cancelled animation (reduced motion switched on, print) also leaves the resting state", () => {
    const io = fakeObserver();
    const card = fakeCard();
    attachEntrance(asEl(card.el), { host: io.host, hydrated: false, onScreen: () => false, ...fakeTimers() });
    io.enter([card.el, 0, 0]);
    card.fire("animationcancel", card.el);
    expect(card.el.dataset.entrance).toBeUndefined();
  });

  it("globals.css: card 320 ms, one badge part on the pop-in token at +140 ms, no check part, the stagger delay", () => {
    const css = readFileSync(new URL("../../../../app/globals.css", import.meta.url), "utf8");
    expect(css).toMatch(/\[data-entrance="play"\]\s*\{\s*animation:\s*ticket-enter 320ms var\(--ease-out-soft\) var\(--entrance-delay, 0ms\) both;/);
    expect(css).toMatch(
      /\[data-entrance="play"\] \[data-entrance-part="badge"\]\s*\{\s*animation:\s*pop-in 280ms var\(--ease-spring\) calc\(var\(--entrance-delay, 0ms\) \+ 140ms\) both;/,
    );
    expect(css).not.toContain('data-entrance-part="check"');
  });
});

// --- page decision ----------------------------------------------------------------

describe("celebrate only on fresh confirmation (owner decision 27 Nov 2026; finding 3)", () => {
  const atLoad = new Set(["a"]);

  it("already confirmed when the page loaded: final card, no entrance, no confetti", () => {
    expect(celebratesOnThisLoad("a", atLoad, null)).toBe(false);
    expect(celebratesOnThisLoad("a", atLoad, "cancel")).toBe(false);
  });

  it("confirmed by a poll during this load: the card enters and the confetti plays", () => {
    expect(celebratesOnThisLoad("b", atLoad, null)).toBe(true);
    // The chain: the card enters, reports the moment, and the page starts the burst.
    const io = fakeObserver();
    const card = fakeCard();
    const startCelebration = vi.fn();
    attachEntrance(asEl(card.el), { host: io.host, hydrated: false, onStart: startCelebration, onScreen: () => false, ...fakeTimers() });
    io.enter([card.el, 0, 0]);
    expect(card.el.dataset.entrance).toBe("play");
    expect(startCelebration).toHaveBeenCalledTimes(1);
  });

  it("right after the Stripe return: celebrates even a card booked before the page loaded", () => {
    expect(celebratesOnThisLoad("a", atLoad, "success")).toBe(true);
  });

  it("server HTML that celebrates (Stripe return, hard load) is never hidden: it only reports the moment in view", () => {
    const io = fakeObserver();
    const card = fakeCard();
    const onStart = vi.fn();
    attachEntrance(asEl(card.el), { host: io.host, hydrated: true, onStart, onScreen: () => true, ...fakeTimers() });
    expect(card.el.dataset.entrance).toBeUndefined();
    io.enter([card.el, 0, 0]);
    expect(card.el.dataset.entrance).toBeUndefined();
    expect(onStart).toHaveBeenCalledTimes(1);
  });
});

// --- structure ----------------------------------------------------------------

function item(id: string, title: string): CustomerItemStatus {
  return {
    orderItemId: id,
    title,
    serviceDate: "2030-01-15",
    timeslot: "21:00",
    paxLabel: "1 adult",
    state: "confirmed",
    tickets: { fulfilment: "issued", documents: [] },
    refundUntilUtc: null,
    cancellationTerms: null,
    cancellation: { kind: "none" },
  };
}

function cards(items: CustomerItemStatus[]): string {
  const status = {
    reference: "OUT-00000001",
    currency: "AED",
    canDownload: true,
    steps: { booking: { status: "done", label: "Booked", at: "2030-01-01T10:41:00.000Z" } },
    items,
  } as unknown as Pick<CustomerOrderStatus, "reference" | "currency" | "canDownload" | "steps" | "items">;
  return renderToStaticMarkup(h(BookedItemCards, { status, items, amount: null, entrance: () => true }));
}

/** The element path from the section to each card: tags only, so a remount-causing change shows up. */
function pathToCards(html: string): string[] {
  const tags = [...html.matchAll(/<(\/?)(section|ul|li|h2|div)\b([^>]*)>/g)];
  const stack: string[] = [];
  const paths: string[] = [];
  for (const [, close, tag, attrs] of tags) {
    if (close) {
      stack.pop();
      continue;
    }
    if (attrs.includes('data-testid="ticket-card"')) paths.push([...stack, "card"].join(">"));
    stack.push(tag);
  }
  return paths;
}

describe("one structure for any number of cards (finding 1)", () => {
  it("one card and two cards sit at the same place, so the first never remounts or re-enters when a second confirms", () => {
    const one = cards([item("a", "Dhow cruise dinner")]);
    const two = cards([item("a", "Dhow cruise dinner"), item("b", "Desert safari")]);
    expect(pathToCards(one)).toEqual(["section>ul>li>card"]);
    expect(pathToCards(two)).toEqual(["section>ul>li>card", "section>ul>li>card"]);
    // Only the heading and the second column depend on the count.
    expect(one).not.toContain("Confirmed activities");
    expect(one).toContain('aria-label="Booking confirmation"');
    expect(one).not.toContain("md:grid-cols-2");
    expect(two).toContain(">Confirmed activities</h2>");
    expect(two).toContain("md:grid-cols-2");
    // The server render is the final state either way.
    expect(two).not.toContain("data-entrance=");
  });
});
