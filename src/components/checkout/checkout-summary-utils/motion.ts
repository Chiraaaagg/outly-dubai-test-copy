/*
 * Motion helpers from the astralyx-ui repository (author astralyxdev), used by
 * the imported Checkout Summary component and its Fmt helper. MIT (see
 * docs/checkout-redesign-review/components/checkout-summary/author-source/LICENSE).
 * Source: https://github.com/astralyxdev/astralyx-ui/blob/main/src/lib/motion.ts
 * at commit 64a2e43c3edaa84b9ab97c787828c8f6f90064f7 (21st.dev did not ship it).
 * Licence: the owner holds a licence for the Checkout Summary component
 * (owner decision, 12 Nov 2026).
 *
 * Edits: only the exports Checkout Summary and Fmt use are kept (enterFade,
 * motionDuration, usePrefersReducedMotion, useCountUp and their private
 * helpers), copied unchanged; the rest of the file (overlay, grow, stagger,
 * useGrowIn, useCountUpText ...) is left out. `enterFade` needs the
 * `ax-fade-in` keyframe in globals.css (see
 * docs/checkout-redesign-review/notes/batch2-components.md); without it the
 * summary simply appears.
 */
'use client'

import {
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from 'react'

/**
 * The kit's motion contract.
 *
 * ---------------------------------------------------------------------------
 * Rule: motion reports state, it does not decorate.
 *
 * Every animation here answers a question the user just asked — *did my click
 * land*, *where did this panel come from*, *which way is this number moving*.
 * Nothing loops, nothing bounces, and nothing moves an element that was already
 * on screen and unchanged. If an animation would still be running when the next
 * one starts, it is too slow.
 * ---------------------------------------------------------------------------
 *
 * Composed the same way `styles.ts` is: components reach for a token rather
 * than spelling out their own timing, so the whole kit can be re-tuned from one
 * file. Durations live here twice — once as milliseconds for the JS-driven
 * tweens, once inside the class tokens for the CSS-driven ones — because
 * Tailwind reads source text and a duration built by interpolation generates no
 * CSS at all. Keep the two in step.
 *
 * Everything degrades to nothing under `prefers-reduced-motion: reduce`: the
 * class tokens are written with `motion-safe:` / `motion-reduce:` variants, and
 * the hooks jump straight to their final value.
 */

/**
 * `useLayoutEffect`, minus the server warning.
 *
 * The count-up hooks need to write their starting value before the browser
 * paints, or the first frame shows the destination and the animation reads as a
 * glitch. On the server there is no paint, so `useEffect` is the honest
 * fallback — it simply never runs.
 */
const useIsomorphicLayoutEffect =
  typeof window === 'undefined' ? useEffect : useLayoutEffect

/**
 * Durations, in milliseconds, for anything driven from JavaScript.
 *
 * The class tokens below use the same numbers. `fast` is a press or a colour
 * change — short enough that it reads as a response rather than an animation.
 * `count` is longer than everything else on purpose: a number that lands
 * instantly was never worth animating.
 */
export const motionDuration = {
  fast: 150,
  base: 200,
  slow: 400,
  count: 800,
} as const

/**
 * The quietest entrance there is: opacity, nothing else.
 *
 * The kit's default for a component root — a card, a table, a panel, a chart —
 * so that content *arrives* instead of being there already, without any of it
 * moving. Cheap enough to wear everywhere: one composited property, one time,
 * on mount.
 *
 * Its own keyframe rather than `animate-in fade-in-0`, because that one sets
 * `transform` too and a root element is the worst possible place to grow a
 * containing block; see `ax-fade-in` in `index.css`.
 */
export const enterFade = 'motion-safe:animate-[ax-fade-in_250ms_ease-out]'

/** The media query, or `null` where there is no `matchMedia` to ask. */
function reducedMotionQuery() {
  return typeof window !== 'undefined' && typeof window.matchMedia === 'function'
    ? window.matchMedia('(prefers-reduced-motion: reduce)')
    : null
}

/**
 * Whether the user has asked for less motion. Re-reads on change.
 *
 * Read once during the first render rather than in an effect: an effect runs
 * after the first paint, so someone who asked for no motion would get exactly
 * one animation before being obeyed. Nothing rendered depends on the answer at
 * that point — the tweens all start at their final value — so this cannot
 * produce a hydration mismatch.
 */
export function usePrefersReducedMotion() {
  const [reduced, setReduced] = useState(() => reducedMotionQuery()?.matches ?? false)

  useEffect(() => {
    const query = reducedMotionQuery()
    if (!query) return

    const onChange = () => setReduced(query.matches)
    onChange()

    query.addEventListener('change', onChange)
    return () => query.removeEventListener('change', onChange)
  }, [])

  return reduced
}

/** How many decimal places a number is *written* with, capped at four. */
function decimalsOf(value: number) {
  if (!Number.isFinite(value)) return 0
  const written = String(value).split('.')[1]
  return written ? Math.min(written.length, 4) : 0
}

type CountOptions = {
  /** Milliseconds. Defaults to `motionDuration.count`. */
  duration?: number
  /** Decimal places to hold on to. Defaults to however `value` is written. */
  decimals?: number
  /** Skip the tween and track `value` directly. */
  disabled?: boolean
}

/**
 * Tween a number towards its value, and return where it currently is.
 *
 * Runs on mount — counting up from zero — and again whenever the value moves,
 * always from wherever the last run got to, so a value that changes twice in
 * quick succession never jumps backwards to start again.
 *
 * The initial render returns `value`, not zero, and the tween's first frame is
 * written in a layout effect. That ordering matters for a prerendered page:
 * the HTML on disk carries the real number — which is what a crawler, a
 * text-only reader and this site's own markdown twins get — while a browser
 * with JavaScript rewinds it and counts before it paints.
 *
 * Not a spring, not an easing curve with overshoot: `1 - (1 - t)³` starts fast
 * and settles, which is how a number that is *arriving* should behave. Anything
 * that overshoots renders digits the value never had.
 */
export function useCountUp(value: number, options: CountOptions = {}) {
  const { duration = motionDuration.count, decimals, disabled = false } = options
  const reduced = usePrefersReducedMotion()
  const places = decimals ?? decimalsOf(value)
  const [shown, setShown] = useState(value)

  // Where the next run starts. Held in a ref rather than derived from `shown`
  // so an interrupted tween resumes from the frame it actually painted.
  const from = useRef(0)

  const still = disabled || reduced || !Number.isFinite(value)

  useIsomorphicLayoutEffect(() => {
    if (still) {
      from.current = value
      setShown(value)
      return
    }

    const start = from.current
    if (start === value) {
      setShown(value)
      return
    }

    const round = 10 ** places
    let frame = 0
    let began = 0

    const step = (now: number) => {
      began ||= now
      const t = Math.min(1, (now - began) / duration)
      const eased = 1 - (1 - t) ** 3
      const at = t === 1 ? value : start + (value - start) * eased

      from.current = at
      setShown(Math.round(at * round) / round)

      if (t < 1) frame = requestAnimationFrame(step)
    }

    frame = requestAnimationFrame(step)
    return () => cancelAnimationFrame(frame)
  }, [value, duration, places, still])

  return shown
}
