"use client";

import { memo } from "react";
import Link from "next/link";
import {
  ArrowRight,
  BadgeCheck,
  Building2,
  Clock3,
  Globe,
  Star,
} from "lucide-react";

import { ExploreCard } from "@/components/explore/ExploreCard";
import { exploreHref } from "@/lib/explore/hrefs";
import { useCurrency } from "@/hooks/useCurrency";
import type { IConsultantCardData } from "@/types/consultant";

/**
 * The expert result card.
 *
 * ── Why this is 150px and not 490px ─────────────────────────────────────────
 * The previous card was a two-column slab: profile block on the left, and a
 * 380–420px rail on the right holding a segmented duration control, a price and
 * a booking button. At 1,304px wide it rendered 490px tall, so the results list
 * showed **1.5 experts per viewport** and the page ran 9,056px for 14 experts.
 *
 * The original code recorded the reason it never became a grid:
 *
 *   > "ConsultantCard is a two-column card (profile + plan tabs) that collapses
 *   >  badly inside a narrow grid cell, so the sidebar grid was removed."
 *
 * That is the trap: the card was too wide to grid *because* it was too wide.
 * The fix is to make the card a card — one column, one job, "who is this and
 * what does it cost" — and let the profile page and the quick-view sheet own
 * the booking rail, which is where the duration selector belongs. You choose a
 * duration for one expert, not while scanning fourteen.
 *
 * Everything the card showed is still here. What moved:
 *   - the duration segmented control → the profile's booking panel
 *   - the two BadgeRows (field + skills) → one row of at most three chips,
 *     overflow collapsed to "+N", so the card height does not grow with the
 *     data
 *   - the 3-line meta stack (experience / location / languages) → a single meta
 *     line, one fact per column, the rest in the sheet
 *
 * `plan` is derived once here rather than in the page, so the "from" price on
 * the card and the price on the profile cannot disagree.
 */
function ConsultantCardImpl({
  consultant,
  onSelect,
}: {
  consultant: IConsultantCardData;
  /** Opens the quick-view sheet. Kept as a button rather than making the whole
   *  card a link, so the sheet is a real activation for keyboard users — the
   *  card link is the primary path and the button is the shortcut. */
  onSelect?: (consultant: IConsultantCardData) => void;
}) {
  const { formatPrice } = useCurrency();
  const href = exploreHref.experts.detail(consultant.id);

  // Cheapest bookable price, whichever family it belongs to. A card that says
  // "from ₹X" and links to a profile whose cheapest option is ₹Y is worse than
  // no price at all.
  const fromPrice = minBookablePrice(consultant);

  const chips = buildChips(consultant);
  const languages = consultant.languages?.slice(0, 2) ?? [];

  return (
    <div className="relative h-full">
      <Link
        href={href}
        aria-label={`View ${consultant.user.name}'s profile`}
        className="block h-full rounded-card focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background"
      >
        <ExploreCard className="flex h-full items-start gap-4 p-4 sm:gap-5 sm:p-5">
          {/* Portrait. 48px is enough to recognise a face at this card size;
              the previous 80px ate a fifth of the width for no extra signal. */}
          <div className="relative h-12 w-12 shrink-0 sm:h-14 sm:w-14">
            <ConsultantAvatar consultant={consultant} />
            {consultant.isVerified && (
              <span
                className="absolute -bottom-0.5 -right-0.5 flex h-4 w-4 items-center justify-center rounded-full bg-brand text-brand-foreground ring-2 ring-card"
                title="Verified expert"
              >
                <BadgeCheck className="h-2.5 w-2.5" aria-hidden="true" />
                <span className="sr-only">Verified</span>
              </span>
            )}
          </div>

          <div className="min-w-0 flex-1">
            {/* ── Identity ── */}
            <div className="flex items-baseline justify-between gap-3">
              <h3 className="truncate font-display text-[0.9375rem] font-semibold leading-tight tracking-tight text-foreground">
                {consultant.user.name}
              </h3>
              {consultant.rating !== null && (
                <span className="tnum flex shrink-0 items-center gap-1 text-xs text-muted-foreground">
                  <Star
                    className="h-3 w-3 fill-warning text-warning"
                    aria-hidden="true"
                  />
                  {consultant.rating.toFixed(1)}
                  {typeof consultant.reviewCount === "number" && (
                    <span className="text-muted-foreground/70">
                      ({consultant.reviewCount})
                    </span>
                  )}
                </span>
              )}
            </div>

            {consultant.headline && (
              <p className="mt-0.5 truncate text-sm text-muted-foreground">
                {consultant.headline}
              </p>
            )}

            {/* ── One meta line ── */}
            <div className="mt-1.5 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted-foreground">
              {consultant.organizationBadge ? (
                <MetaItem icon={Building2}>
                  {consultant.organizationBadge.name}
                </MetaItem>
              ) : consultant.isIndependent ? (
                <MetaItem>Independent</MetaItem>
              ) : null}

              {typeof consultant.experience === "number" &&
                consultant.experience > 0 && (
                  <MetaItem icon={Clock3}>
                    {consultant.experience} yr experience
                  </MetaItem>
                )}

              {languages.length > 0 && (
                <MetaItem icon={Globe}>{languages.join(", ")}</MetaItem>
              )}
            </div>

            {/* ── Chips: hard-capped so the card height is data-independent ── */}
            {chips.length > 0 && (
              <ul className="mt-2.5 flex flex-wrap items-center gap-1.5">
                {chips.map((chip) => (
                  <li key={chip.key}>
                    <span className="inline-flex items-center rounded-chip border border-border bg-muted px-2 py-0.5 text-xs text-muted-foreground">
                      {chip.label}
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </div>
        </ExploreCard>
      </Link>

      {/* ── The price, and the two things you can do ──────────────────────────
          A separate row rather than a right-hand column: at 2-up the card is
          ~640px wide, and splitting off a 200px price rail would re-create the
          two-column slab this card exists to stop. */}
      <div className="mt-3 flex items-center justify-between gap-3 border-t border-border-subtle pt-3">
        {fromPrice !== null ? (
          <p className="flex items-baseline gap-1.5">
            <span className="text-xs text-muted-foreground">from</span>
            <span className="tnum font-display text-base font-bold text-foreground">
              {formatPrice(fromPrice)}
            </span>
          </p>
        ) : (
          <p className="text-sm text-muted-foreground">
            Ask about availability
          </p>
        )}

        <div className="flex items-center gap-1.5">
          {onSelect && (
            <button
              type="button"
              onClick={() => onSelect(consultant)}
              className="rounded-control px-2.5 py-1.5 text-xs font-medium text-muted-foreground transition-colors hover:bg-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
            >
              Quick view
            </button>
          )}
          <span className="inline-flex items-center gap-1 text-sm font-medium text-brand-foreground-subtle">
            View profile
            <ArrowRight
              className="h-3.5 w-3.5 transition-transform group-hover:translate-x-0.5 motion-reduce:transform-none"
              aria-hidden="true"
            />
          </span>
        </div>
      </div>
    </div>
  );
}

/** A small labelled fact. Not a component in its own right — three uses. */
function MetaItem({
  icon: Icon,
  children,
}: {
  icon?: React.ComponentType<{ className?: string }>;
  children: React.ReactNode;
}) {
  return (
    <span className="inline-flex min-w-0 items-center gap-1">
      {Icon && <Icon className="h-3 w-3 shrink-0 opacity-70" aria-hidden="true" />}
      <span className="truncate">{children}</span>
    </span>
  );
}

/** The portrait, with the same initial-tile fallback the rest of the app uses. */
function ConsultantAvatar({
  consultant,
}: {
  consultant: IConsultantCardData;
}) {
  const src =
    consultant.user.profileDisplayImage || consultant.user.image || null;
  const initial = (consultant.user.name || "?").trim().charAt(0).toUpperCase();

  if (!src) {
    return (
      <div className="flex h-full w-full items-center justify-center rounded-card bg-brand-subtle font-display text-lg font-semibold text-brand-foreground-subtle">
        {initial}
      </div>
    );
  }
  return (
    // eslint-disable-next-line @next/next/no-img-element
    <img
      src={src}
      alt=""
      loading="lazy"
      className="h-full w-full rounded-card object-cover"
    />
  );
}

/**
 * Domain, then subdomains, then tags — most significant first, capped at three
 * with an overflow count. The previous card rendered every field and every
 * skill as its own BadgeRow, so a consultant with 12 skills produced a card
 * half again as tall as one with 3.
 */
function buildChips(consultant: IConsultantCardData) {
  const out: { key: string; label: string }[] = [];
  if (consultant.domain) {
    out.push({ key: `d-${consultant.domain.id}`, label: consultant.domain.name });
  }
  for (const sub of consultant.subDomains ?? []) {
    if (out.length >= 2) break;
    out.push({ key: `s-${sub.id}`, label: sub.name });
  }
  for (const tag of consultant.tags ?? []) {
    if (out.length >= 2) break;
    out.push({ key: `t-${tag.id}`, label: tag.name });
  }

  const total =
    1 +
    (consultant.subDomains?.length ?? 0) +
    (consultant.tags?.length ?? 0);
  const rest = total - out.length;
  if (rest > 0) out.push({ key: "rest", label: `+${rest}` });

  return out.slice(0, 4);
}

/**
 * The cheapest bookable price across both plan families, or null.
 *
 * The old card's rail showed the *selected* duration's price, which meant the
 * number on the card changed as the visitor clicked between 1h / 2h / 4h — so
 * two cards side by side were not comparable, and a card's headline price was
 * whatever duration happened to be active.
 */
function minBookablePrice(
  consultant: IConsultantCardData,
): number | null {
  const prices = [
    ...(consultant.consultationPlans ?? []).map((p) => p.price),
    ...(consultant.subscriptionPlans ?? []).map((p) => p.price),
  ].filter((p) => typeof p === "number" && p > 0);
  return prices.length > 0 ? Math.min(...prices) : null;
}

const ConsultantCard = memo(ConsultantCardImpl);
export default ConsultantCard;
