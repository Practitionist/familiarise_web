import * as React from "react";

import { cn } from "@/utils/tailwind";

/**
 * The one card treatment for the explore surfaces.
 *
 * Five separate idioms were in use across the two listings, and they did not
 * agree on anything:
 *
 *   - `bg-card rounded-2xl border hover:border-border hover:shadow-xl`  (ProgramCard ×3, ConsultantCard)
 *   - `bg-card rounded-2xl p-5 … hover:shadow-lg` + a resting `shadow-sm` (ExpertMiniCard, FeaturedExperts)
 *   - `rounded-xl … hover:shadow-md`                                    (DomainGrid, CategoryGrid)
 *   - `rounded-3xl bg-zinc-950/90 ring-1 ring-white/[0.07] shadow-2xl`   (ExpertPricing — the only 3xl and 2xl in scope)
 *
 * Two of those had a resting shadow, three did not; three said `rounded-2xl`,
 * two said `rounded-xl`, one said `rounded-3xl`. And **`hover:border-border`
 * was a no-op in six files** — the resting border was already `--border`, so
 * half of every hover treatment did literally nothing, and the shadow was
 * carrying the entire interaction.
 *
 * So: the resting state is a hairline plus `elevation-1`, the hover state is
 * `elevation-3` plus a real border colour change, and the title gets STRONGER
 * on hover rather than `text-muted-foreground`. That last one is the change
 * with the most bite — seven call sites were dimming the thing the user is
 * being invited to click.
 *
 * `shadow-edge` is transparent in light and becomes a 1px inner highlight in
 * dark, so depth reads on both without a single `dark:` variant.
 */
export function ExploreCard({
  className,
  interactive = true,
  as: Comp = "div",
  ...props
}: React.HTMLAttributes<HTMLDivElement> & {
  interactive?: boolean;
  as?: React.ElementType;
}) {
  return (
    <Comp
      className={cn(
        "rounded-card border border-border bg-card text-card-foreground shadow-elevation-1 shadow-edge",
        interactive &&
          "group transition-[transform,box-shadow,border-color] duration-200 ease-out hover:-translate-y-0.5 hover:border-brand-border hover:shadow-elevation-3",
        className,
      )}
      {...props}
    />
  );
}

/**
 * A card title that responds to its card's hover by getting more prominent.
 *
 * Replaces the `group-hover:text-muted-foreground` on seven call sites. When a
 * card is a link, the title is the label for the action — dimming it is the
 * opposite of an affordance, and it also fought the small "View Details" arrow
 * sitting at the other end of the same card.
 */
export function ExploreCardTitle({
  className,
  as: Comp = "h3",
  ...props
}: React.HTMLAttributes<HTMLHeadingElement> & { as?: React.ElementType }) {
  return (
    <Comp
      className={cn(
        "font-display text-base font-semibold leading-snug tracking-tight text-foreground",
        "transition-colors group-hover:text-brand-foreground-subtle",
        className,
      )}
      {...props}
    />
  );
}

/**
 * The label under a card title — consultant name, org, category.
 *
 * The previous version truncated with a bare `truncate` at `text-xs`, which
 * is below the 12px floor that WCAG 1.4.4 allows for real content, and left
 * the most identifying string on the card the least readable.
 */
export function ExploreCardMeta({
  className,
  ...props
}: React.HTMLAttributes<HTMLParagraphElement>) {
  return (
    <p
      className={cn(
        "truncate text-sm text-muted-foreground",
        className,
      )}
      {...props}
    />
  );
}

/**
 * A price, set in the display face with tabular figures.
 *
 * Prices, ratings and counts are compared vertically, not read as prose.
 * Proportional figures make a column of prices ragged and make tabular ones
 * shimmer as a value changes — hence `tnum`.
 */
export function PriceTag({
  value,
  className,
  suffix,
}: {
  value: React.ReactNode;
  className?: string;
  suffix?: React.ReactNode;
}) {
  return (
    <span className={cn("tnum font-display font-bold text-foreground", className)}>
      {value}
      {suffix && (
        <span className="ml-1 font-sans text-sm font-normal text-muted-foreground">
          {suffix}
        </span>
      )}
    </span>
  );
}
