import * as React from "react";

import { cn } from "@/utils/tailwind";

/**
 * The container and header every explore surface shares.
 *
 * ── One container, because there were three ─────────────────────────────────
 * The listings used `max-w-[1600px]`, the class/webinar plan details used
 * `max-w-[92%] xl:max-w-[88%] 2xl:max-w-[1600px]`, and the
 * consultation/subscription details used `max-w-7xl`. Three widths, two gutter
 * ramps, and a user who opened a class and then clicked into a consultation
 * watched the page narrow by ~320px and change background mid-session.
 *
 * 1400px is the compromise: wide enough for a 4-up card grid with real gutters,
 * narrow enough that a line of body copy never runs to 1600px. The gutter is
 * the same ramp everywhere.
 */
export function ExploreShell({
  children,
  className,
  width = "default",
}: {
  children: React.ReactNode;
  className?: string;
  /** `wide` is for the listing pages; `default` for detail pages. */
  width?: "default" | "wide" | "prose";
}) {
  return (
    <div
      className={cn(
        "mx-auto w-full px-4 sm:px-6 lg:px-8",
        width === "wide" ? "max-w-[1400px]" : "max-w-[1200px]",
        className,
      )}
    >
      {children}
    </div>
  );
}

/**
 * The eyebrow / title / lede triple.
 *
 * Three different hero treatments existed: the dark band on both listings, the
 * image hero on class/webinar details, and a flat `text-3xl` on
 * consultation/subscription details — with the listings' h1 on the fluid scale
 * and the third on none at all, and no two of them sharing a tracking value.
 * One component, so the four pages cannot drift again.
 */
export function ExploreHeader({
  eyebrow,
  title,
  description,
  meta,
  tone = "light",
  align = "center",
  className,
  children,
}: {
  eyebrow?: React.ReactNode;
  title: React.ReactNode;
  description?: React.ReactNode;
  /** A row of stat/meta items under the lede. */
  meta?: React.ReactNode;
  /**
   * `dark` is the banded hero the two listings open with. `flat` is the
   * unbanded treatment for a detail page that already has an image behind it.
   */
  tone?: "light" | "dark";
  align?: "center" | "start";
  className?: string;
  children?: React.ReactNode;
}) {
  const dark = tone === "dark";
  return (
    <header
      className={cn(
        "flex flex-col",
        align === "center" ? "items-center text-center" : "items-start text-left",
        className,
      )}
    >
      {eyebrow && (
        <p
          className={cn(
            "mb-3 text-[0.6875rem] font-medium uppercase tracking-[0.14em]",
            dark ? "text-brand-foreground-subtle" : "text-muted-foreground",
          )}
        >
          {eyebrow}
        </p>
      )}
      <h1
        className={cn(
          "font-display font-bold",
          // One scale for all four pages, rather than the previous mixture of
          // text-fluid-4xl, text-4xl md:text-5xl lg:text-6xl and text-3xl
          // md:text-4xl for what is visually the same job.
          "text-fluid-3xl tracking-[-0.02em]",
          dark ? "text-white" : "text-foreground",
        )}
      >
        {title}
      </h1>
      {description && (
        <p
          className={cn(
            // `text-pretty` so a title with a forced break does not leave a
            // one-word rag line.
            "mt-3 text-pretty text-fluid-base",
            align === "center" && "mx-auto",
            "max-w-2xl",
            dark ? "text-white/70" : "text-muted-foreground",
          )}
        >
          {description}
        </p>
      )}
      {meta && (
        <div
          className={cn(
            "mt-6 flex flex-wrap items-center gap-x-8 gap-y-3",
            align === "center" && "justify-center",
          )}
        >
          {meta}
        </div>
      )}
      {children}
    </header>
  );
}

/** One number + label pair for the header meta row. */
export function ExploreStat({
  value,
  label,
  tone = "light",
}: {
  value: React.ReactNode;
  label: React.ReactNode;
  tone?: "light" | "dark";
}) {
  return (
    <div className="flex flex-col items-start">
      <span
        className={cn(
          "tnum font-display text-xl font-bold",
          tone === "dark" ? "text-white" : "text-foreground",
        )}
      >
        {value}
      </span>
      <span
        className={cn(
          "mt-0.5 text-xs",
          tone === "dark" ? "text-white/60" : "text-muted-foreground",
        )}
      >
        {label}
      </span>
    </div>
  );
}

/**
 * The section title used above every curated row and results block.
 *
 * Four icon-chip sizes were in use on the expert profile alone — `w-8`,
 * `w-9`, `w-10`, `w-10` — and two different section-title sizes (`text-lg`
 * in three places, `text-xl md:text-2xl` in a fourth), so two sections on the
 * same page did not look like the same kind of thing.
 */
export function ExploreSectionHeader({
  title,
  description,
  icon: Icon,
  action,
  className,
}: {
  title: React.ReactNode;
  description?: React.ReactNode;
  icon?: React.ComponentType<{ className?: string }>;
  action?: React.ReactNode;
  className?: string;
}) {
  return (
    <div
      className={cn(
        "mb-5 flex items-end justify-between gap-4",
        className,
      )}
    >
      <div className="flex min-w-0 items-center gap-3">
        {Icon && (
          <span
            className="flex h-9 w-9 shrink-0 items-center justify-center rounded-control bg-brand-subtle text-brand-foreground-subtle"
            aria-hidden="true"
          >
            <Icon className="h-4 w-4" />
          </span>
        )}
        <div className="min-w-0">
          <h2 className="font-display text-lg font-semibold tracking-tight text-foreground">
            {title}
          </h2>
          {description && (
            <p className="mt-0.5 text-sm text-muted-foreground">
              {description}
            </p>
          )}
        </div>
      </div>
      {action && <div className="shrink-0">{action}</div>}
    </div>
  );
}
