"use client";

/**
 * The onboarding wizard's page shell.
 *
 * Two things here are load-bearing, and both were previously implicit.
 *
 * ── 1. The dark scope ──────────────────────────────────────────────────────
 * The design direction is a dark canvas. This app already ships a COMPLETE
 * `.dark` token block in `globals.css` (`--background: 0 0% 4%`,
 * `--primary: 0 0% 98%`, `--muted-foreground: 0 0% 65%`, …) and roughly 370
 * `dark:` utility usages — but nothing ever sets the `.dark` class, so the
 * whole system is dormant and every dark surface has to be hand-written.
 *
 * Mounting this route inside a `.dark` scope activates the real token system
 * instead: the stepper, the progress bar, `Card`, `Input` and every other
 * shared primitive resolve to their dark values with no `dark:` variant and no
 * per-component override. That is what makes this a token decision rather
 * than a pile of CSS — and it means promoting `.dark` to an app-wide theme
 * later is a matter of deleting one class, not untangling a special route.
 *
 * If you later add a real theme toggle, this component is where it goes:
 * replace the literal `"dark"` with the resolved theme class.
 *
 * ── 2. The sticky offset ───────────────────────────────────────────────────
 * The root layout renders `MaintenanceBanner` (fixed, `z-[10001]`) and
 * `AnnouncementBar` (fixed, `z-[1001]`) above this route, and body carries
 * `padding-top: var(--maintenance-banner-height)`. The old header used a bare
 * `sticky top-0`, so it pinned to the viewport top and slid UNDER the fixed
 * banner instead of stacking below it. `top-maintenance` is the existing
 * utility for exactly this; the announcement bar is accounted for on top of it.
 */

import { MotionConfig } from "framer-motion";
import { cn } from "@/utils/tailwind";
import type { ReactNode } from "react";

interface OnboardingShellProps {
  /** Sticky bar: brand mark, step counter, sign out. */
  header: ReactNode;
  /** Progress stepper. */
  stepper?: ReactNode;
  /** The step card itself. */
  children: ReactNode;
  /** Centred help affordance under the card. */
  footer?: ReactNode;
  className?: string;
  /** The weekly-slot grid needs more room than a reading-width card. */
  wide?: boolean;
}

export function OnboardingShell({
  header,
  stepper,
  children,
  footer,
  className,
  wide,
}: OnboardingShellProps) {
  return (
    // `dark` is the whole point — see the note above. `relative` + `isolate`
    // contain the absolutely-positioned decorative layers below so they can
    // never create a stacking context that fights the sticky header.
    <MotionConfig reducedMotion="user">
      <div
        className={cn(
          "dark relative isolate min-h-svh bg-background text-foreground",
          className,
        )}
      >
        {/* Decorative canvas. Both classes already exist in globals.css and
            are used on the marketing pages — this reuses them rather than
            inventing a new background. `pointer-events-none` + `aria-hidden`
            because they carry no information. */}
        <div
          aria-hidden="true"
          className="pointer-events-none absolute inset-0 -z-10"
        >
          <div className="absolute inset-0 mesh-gradient-dark" />
          {/* `dot-pattern`, NOT `dot-pattern-dark`. The "-dark" suffix names
              the LINE colour, not the surface: `dot-pattern-dark` draws
              rgba(0,0,0,.05) black dots meant for a light background, which
              would be invisible here. Plain `dot-pattern` is neutral grey and
              reads correctly on the dark canvas. Same trap applies to
              `grid-pattern` (white lines) vs `grid-pattern-dark`. */}
          <div className="absolute inset-0 dot-pattern opacity-40" />
        </div>

        <header className="sticky top-maintenance z-50 border-b border-border bg-background/80 backdrop-blur-sm">
          {header}
        </header>

        <main
          className={cn(
            "container mx-auto px-4 py-8",
            // A fixed breakpoint width, not a percentage. The old
            // `max-w-[80%]` scaled continuously with the viewport, so the
            // slot grid reflowed unpredictably between breakpoints; stepping
            // at `xl` is both calmer and matches the config's 2xl=1400 screen.
            wide ? "max-w-[80rem]" : "max-w-3xl",
          )}
        >
          {stepper && <div className="mb-8">{stepper}</div>}
          {children}
          {footer && (
            <div className="mt-6 text-center text-sm text-muted-foreground">
              {footer}
            </div>
          )}
        </main>
      </div>
    </MotionConfig>
  );
}
