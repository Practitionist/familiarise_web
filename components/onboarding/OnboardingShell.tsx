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
 * `dark:` utility usages — but nothing ever set the `.dark` class, so the
 * whole system is dormant and every dark surface has to be hand-written.
 *
 * Activating the real token system instead: the stepper, the progress bar,
 * `Card`, `Input` and every other shared primitive resolve to their dark values
 * with no `dark:` variant and no per-component override. The class is applied
 * by the ROUTE LAYOUT, not here — see the note there for why (Radix portals
 * escape a subtree scope) and for the pre-paint script that avoids a flash.
 * Promoting `.dark` to an app-wide theme is then a matter of deleting that
 * script, not untangling a special route.
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
import { useEffect, type ReactNode } from "react";

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
  // Keep the root `.dark` scope in step with this shell's lifetime.
  //
  // The class is first applied pre-paint by the route layout's inline script
  // (app/form/onboarding/layout.tsx explains why it cannot be done from here).
  // Re-asserting it on mount covers the case the script cannot: the
  // ORG_WORKSPACE org step is `fullBleed`, so page.tsx returns before the
  // shell renders, the cleanup below strips the class, and the script — which
  // only ever runs during SSR HTML parsing — does not run again. Without this
  // the wizard would come back from the org wizard in LIGHT mode for the rest
  // of the session.
  //
  // The cleanup is still required: onboarding ends in a router.replace to the
  // dashboard, and that client-side navigation must not inherit a dark <html>.
  useEffect(() => {
    document.documentElement.classList.add("dark");
    return () => {
      document.documentElement.classList.remove("dark");
    };
  }, []);

  return (
    // `MotionConfig reducedMotion="user"` is set ONCE here rather than per
    // variant, so a newly added animated block cannot forget it. Under it,
    // framer-motion drops transform animations and keeps opacity.
    //
    // No `dark` class on this div: the scope is on <html>. Radix portals
    // (Select, Dialog, Popover, DropdownMenu, Tooltip) mount to document.body,
    // outside this subtree, so a scope here left every dropdown and modal
    // resolving light tokens over a dark card. The `.dark` token block in
    // globals.css and its ~370 `dark:` utilities are what this activates —
    // they are authored but dormant today, because nothing set the class.
    <MotionConfig reducedMotion="user">
      <div
        className={cn(
          // `relative` + `isolate` contain the decorative layer below, which
          // is a grandchild at `-z-10`: without a stacking context here it
          // would join the root's negative-z step and paint behind the shell's
          // own background, i.e. be invisible.
          "relative isolate min-h-svh bg-background text-foreground",
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
