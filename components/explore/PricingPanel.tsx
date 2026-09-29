import * as React from "react";

import { cn } from "@/utils/tailwind";

/**
 * The booking panel on the expert profile.
 *
 * This was a dark-glass island on a light page:
 *
 *   `bg-zinc-950/90 backdrop-blur-xl rounded-3xl p-6 shadow-2xl
 *    shadow-black/40 border border-white/[0.07] ring-1 ring-white/[0.04]`
 *
 * — the only `rounded-3xl` and the only `shadow-2xl` anywhere in the explore
 * surfaces, sitting directly above light `bg-card rounded-2xl` sections with
 * the *same* heading size, so it read as an embedded third-party widget rather
 * than part of the page. Everything inside it was `zinc-*` or `white/[0.0x]`,
 * which is why 51 hardcoded palette classes lived in the two pricing toggles
 * and almost nowhere else.
 *
 * The trade-off worth naming: the dark panel *was* a deliberate focal point —
 * it is the thing you came to the page to do. So this keeps the emphasis and
 * drops the mismatch. It is now a **card with a brand-tinted border in dark
 * mode and a strong shadow**, using the same radius as every other card, so it
 * leads by weight rather than by being a different product.
 *
 * `tone="raised"` is the default for the booking panel; `tone="quiet"` is for
 * the supporting panels (instructor, schedule) so they recede.
 */
export function PricingPanel({
  title,
  eyebrow,
  children,
  className,
  tone = "raised",
  ...props
}: React.HTMLAttributes<HTMLDivElement> & {
  title?: React.ReactNode;
  /** The small uppercase line under the title. */
  eyebrow?: React.ReactNode;
  tone?: "raised" | "quiet";
}) {
  return (
    <div
      className={cn(
        "rounded-card border bg-card p-6 text-card-foreground",
        // The brand border is the "this is the action" signal. It is a border
        // colour, not a fill, so it works in both modes without a `dark:`
        // variant — and it survives the editorial direction, whose accent is
        // terracotta rather than indigo.
        tone === "raised"
          ? "border-brand-border shadow-elevation-3 shadow-edge"
          : "border-border shadow-elevation-1 shadow-edge",
        className,
      )}
      {...props}
    >
      {title && (
        <div className="mb-5">
          <h3 className="font-display text-lg font-bold tracking-tight text-foreground">
            {title}
          </h3>
          {eyebrow && (
            <p className="mt-1 text-xs font-medium uppercase tracking-[0.12em] text-muted-foreground">
              {eyebrow}
            </p>
          )}
        </div>
      )}
      {children}
    </div>
  );
}

/**
 * The large price, in the display face with tabular figures.
 *
 * Was `text-5xl font-bold` inside a 450px sidebar — the largest type on any
 * explore surface, louder than the page heading it sat under. `text-3xl` at
 * the sidebar width reads as a price rather than as a billboard.
 */
export function PriceFigure({
  value,
  suffix,
  className,
}: {
  value: React.ReactNode;
  suffix?: React.ReactNode;
  className?: string;
}) {
  return (
    <p className={cn("tnum font-display text-3xl font-bold text-foreground", className)}>
      {value}
      {suffix && (
        <span className="ml-1.5 font-sans text-sm font-normal text-muted-foreground">
          {suffix}
        </span>
      )}
    </p>
  );
}

/** A label/value row, as used by the "what's included" lists. */
export function PriceRow({
  label,
  value,
  className,
}: {
  label: React.ReactNode;
  value: React.ReactNode;
  className?: string;
}) {
  return (
    <div
      className={cn(
        "flex items-baseline justify-between gap-4 py-2",
        className,
      )}
    >
      <span className="text-sm text-muted-foreground">{label}</span>
      <span className="tnum text-sm font-medium text-foreground">{value}</span>
    </div>
  );
}
