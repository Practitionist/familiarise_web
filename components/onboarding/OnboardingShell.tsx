"use client";

/**
 * The onboarding wizard's page shell.
 *
 * Two things here are load-bearing, and both were previously implicit.
 *
 * ── 1. The dark scope ──────────────────────────────────────────────────────
 * The design direction is a dark canvas, and this app already ships a
 * COMPLETE `.dark` token block in `globals.css` plus roughly 370 `dark:`
 * utility usages — all authored but dormant, because nothing ever set the
 * class.
 *
 * This route activates that system without any of the theme machinery,
 * because onboarding is a DARK-ONLY route rather than a user-toggleable
 * theme. The tokens are keyed off `body:has(.onboarding-shell)`, and the
 * `onboarding-shell` class on the div below is only the marker for that
 * selector. The long note on the token block in globals.css covers why the
 * two rejected alternatives are wrong: a pre-paint inline script on <html>
 * (wrong position, needs the `suppressHydrationWarning` this repo forbids,
 * and loses the scope when the fullBleed org step unmounts the shell), and a
 * class on the shell alone (Radix portals mount to document.body, so every
 * dropdown and modal would resolve light tokens over a dark card).
 *
 * Promoting `.dark` to a real app-wide theme is then a matter of starting to
 * set the class — no change to this component.
 *
 * ── 2. The sticky offset ───────────────────────────────────────────────────
 * The root layout renders `MaintenanceBanner` (fixed, `z-[10001]`) and
 * `AnnouncementBar` (fixed, `z-[1001]`) above this route, and body carries
 * `padding-top: var(--maintenance-banner-height)`. The old header pinned to
 * the very top of the viewport, so it slid under BOTH fixed banners. The
 * repo's `top-maintenance` utility covers the maintenance banner alone, and
 * AnnouncementBar is not gated by NO_CHROME, so it stacks on top of it here.
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
    // MotionConfig is set ONCE here rather than per variant, so a newly added
    // animated block cannot forget it. Under it, framer-motion drops transform
    // animations and keeps opacity.
    //
    // `onboarding-shell` is a MARKER, not a style. The dark tokens are applied
    // by `body:has(.onboarding-shell)` in globals.css, which reaches Radix
    // portals because they mount to document.body — a class here alone would
    // not, and a class on <html> would need a pre-paint script that this
    // repo's hydration contract forbids. See the note on that block.
    //
    // `relative` + `isolate` contain the decorative layer below, which is a
    // grandchild at `-z-10`: without a stacking context here it would join the
    // root's negative-z step and paint behind the shell's own background, i.e.
    // be invisible.
    <MotionConfig reducedMotion="user">
      <div
        className={cn(
          "onboarding-shell relative isolate min-h-svh bg-background text-foreground",
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
          {/* globals.css defines only two dot patterns: the neutral-grey
              one used here, and a near-black one for LIGHT surfaces. There is
              no third variant, so the "-dark" suffix that appears on the
              grid patterns names the LINE colour, not the surface — a
              grid-pattern has white lines for dark backgrounds and
              grid-pattern-dark has black ones. Hence the neutral dot pattern. */}
          <div className="absolute inset-0 dot-pattern opacity-40" />
        </div>

        <header className="sticky top-[calc(var(--maintenance-banner-height,0px)+var(--announcement-bar-height,0px))] z-50 border-b border-border bg-background/80 backdrop-blur-sm">
          {header}
        </header>

        <main
          className={cn(
            "container mx-auto px-4 py-8",
            // A fixed breakpoint width, not a percentage of the container.
            // The old percentage scaled continuously with the viewport, so the
            // weekly slot grid reflowed unpredictably between breakpoints;
            // stepping at a named width is calmer and matches the config.
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
