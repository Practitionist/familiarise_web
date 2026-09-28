/**
 * Shared motion vocabulary.
 *
 * Until now every motion variant in this app was re-declared inline at each
 * call site — `app/use-cases/UseCaseSections.tsx` has a `fadeUp` const, and
 * ~43 components hand-roll the same `whileInView` + `viewport={{ once: true }}`
 * pair. That made the durations a per-file decision, so the surface reads as
 * slightly different motion on every page.
 *
 * These are the house values, matching the range already in use across
 * `components/home/*` and `app/dashboard/*` (0.3–0.6s, 10–30px offsets,
 * `easeOut`-ish). Import from here instead of inventing new numbers.
 *
 * ── reduced motion ──────────────────────────────────────────────────────────
 * Motion is only disabled when the OS asks. That is enforced by wrapping a
 * surface in <MotionConfig reducedMotion="user"> — see
 * `components/onboarding/OnboardingShell.tsx` and the two marketing layouts,
 * which set it once at the layout so a newly added animated block cannot miss
 * it. Under that boundary framer-motion drops transform animations and keeps
 * opacity, so content still cross-fades rather than jumping.
 *
 * It does NOT cover CSS keyframes. Those have to be neutralised explicitly in
 * the `prefers-reduced-motion` block at the bottom of `app/globals.css`. When
 * adding an entrance animation there, settle it to its VISIBLE end state rather
 * than merely stopping it, and watch the delay: `animation-fill-mode: both`
 * holds the invisible first frame for the whole `animation-delay`, so
 * shortening the duration alone leaves later staggered groups stuck at
 * `opacity: 0`.
 */

import type { TargetAndTransition, Transition } from "framer-motion";

/** One shared easing curve. The house motion is decelerating, not linear or
 *  springy — it reads as "settling into place" rather than "bouncing". */
const EASE = [0.32, 0.72, 0, 1] as const;

/** Durations, in seconds. Kept short: this is a form, not a showcase. */
const DURATION = {
  /** Micro-feedback — selection, checkbox, focus. */
  fast: 0.18,
  /** The step-to-step transition. Long enough to read as directional. */
  step: 0.28,
  /** Entrance of a group of fields. */
  enter: 0.45,
} as const;

const SPRING_SOFT: Transition = {
  type: "spring",
  stiffness: 260,
  damping: 30,
  mass: 0.9,
};

/**
 * A wizard step entering. Paired with `stepExit` via <AnimatePresence
 * mode="wait">, and keyed on the step key so the direction of travel is
 * visible: forward slides up from below, back slides down from above.
 *
 * These return a single animation TARGET, not a `Variants` record — they are
 * spread into the `hidden` / `exit` slots of the caller's variant map, so a
 * `Variants` here would be a record nested inside a record and would not
 * typecheck against `Variant`.
 */
export const stepEnter = (direction: 1 | -1): TargetAndTransition => ({
  opacity: 0,
  y: direction * 16,
});

export const stepExit = (direction: 1 | -1): TargetAndTransition => ({
  opacity: 0,
  y: direction * -16,
});

/** The settled state a step animates to. */
export const stepVisible: TargetAndTransition = { opacity: 1, y: 0 };

export const stepTransition: Transition = {
  duration: DURATION.step,
  ease: EASE,
};

/**
 * The stepper's active indicator. `layoutId` lets a single element travel
 * between steps instead of cross-fading two of them, so the eye can follow
 * where "you are" moved to. Must be used inside a `LayoutGroup` (or at a
 * common ancestor) for the shared-layout measurement to be meaningful.
 */
export const indicatorTransition: Transition = { ...SPRING_SOFT };
