import { Suspense } from "react";
import Link from "next/link";
import { PlayCircle, Clock, ArrowRight } from "lucide-react";

import { listPublicRecordings } from "@/lib/data/recordings-explore";
import { withBuildTimeRetry } from "@/lib/data/fail-open";
import { formatCurrencyAmount } from "@/utils/formatting";
import { EmptyState } from "@/components/ui/empty-state";
import { Skeleton } from "@/components/ui/skeleton";
import { ExploreCard, ExploreCardMeta, ExploreCardTitle } from "@/components/explore/ExploreCard";
import {
  ExploreHeader,
  ExploreShell,
} from "@/components/explore/ExploreShell";
import { exploreHref } from "@/lib/explore/hrefs";

// ISR — same rationale as /explore/experts: anonymous, session-free listing;
// prerendered HTML off the CDN. Publish/unpublish purge on demand at the
// write sites (see publish route follow-up).
export const revalidate = 300;

export const metadata = {
  title: "Recordings Library | Familiarise",
  description:
    "Buy recorded webinars and classes from verified consultants — learn on your schedule.",
};

function formatPrice(paise: number): string {
  return formatCurrencyAmount(paise, "INR");
}

async function RecordingsGrid() {
  // Deliberately LOUD: __tests__/explore/isr-routes-never-fail-open.test.ts
  // enforces that ISR listings never mask data-layer failures.
  const { items } = await withBuildTimeRetry(() =>
    listPublicRecordings({ perPage: 48 }),
  );

  if (items.length === 0) {
    return (
      <EmptyState
        icon={PlayCircle}
        title="No published recordings yet"
        description="Consultants can publish webinar and class replays from their dashboard — check back soon."
      />
    );
  }

  return (
    <div className="grid grid-cols-1 gap-5 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
      {items.map((rec) => (
        <Link
          key={rec.id}
          href={
            rec.slug
              ? exploreHref.recordings.detail(rec.slug)
              : exploreHref.recordings.list
          }
          className="block h-full"
        >
          <ExploreCard className="flex h-full flex-col overflow-hidden">
            <div className="relative aspect-video overflow-hidden bg-muted">
              {rec.thumbnailUrl ? (
                // eslint-disable-next-line @next/next/no-img-element
                <img
                  src={rec.thumbnailUrl}
                  alt=""
                  className="h-full w-full object-cover transition-transform duration-500 group-hover:scale-[1.03] motion-reduce:transform-none"
                />
              ) : (
                <div className="flex h-full items-center justify-center">
                  <PlayCircle
                    className="h-10 w-10 text-muted-foreground/50"
                    aria-hidden="true"
                  />
                </div>
              )}
              <span className="tnum absolute bottom-2 right-2 inline-flex items-center gap-1 rounded-chip bg-black/70 px-1.5 py-0.5 text-xs text-white backdrop-blur">
                <Clock className="h-3 w-3" aria-hidden="true" />
                {rec.durationInMinutes}m
              </span>
            </div>

            <div className="flex flex-1 flex-col p-4">
              <div className="mb-2 flex items-baseline justify-between gap-2">
                <span className="text-xs font-medium uppercase tracking-wider text-muted-foreground">
                  {rec.planType}
                </span>
                <span className="tnum font-display text-base font-bold text-foreground">
                  {formatPrice(rec.listPricePaise)}
                </span>
              </div>
              <ExploreCardTitle className="line-clamp-2">
                {rec.listingTitle}
              </ExploreCardTitle>
              <ExploreCardMeta className="mt-1.5">
                {rec.consultant.name}
                {rec.consultant.headline
                  ? ` · ${rec.consultant.headline}`
                  : ""}
              </ExploreCardMeta>
            </div>
          </ExploreCard>
        </Link>
      ))}
    </div>
  );
}

/**
 * A 4-up grid of video thumbnails, under one header.
 *
 * The previous version was a bare `<img>` (no `next/image`, so no AVIF/WebP
 * and no responsive `sizes`), `rounded-xl border bg-card` with
 * `hover:shadow-md` — a fourth shadow value against the other cards' `xl` —
 * and a `text-[10px]`-adjacent `text-xs` price sitting *above* the title at
 * `text-primary`. There was no page header, and the empty state was a bare
 * centred paragraph.
 */
export default function ExploreRecordingsPage() {
  return (
    <main className="min-h-screen bg-background">
      <section className="border-b border-border-subtle bg-surface py-14 md:py-20">
        <ExploreShell width="wide">
          <ExploreHeader
            eyebrow="Watch on your schedule"
            title="Recordings library"
            description="Replays of paid webinars and classes, published by their consultants. Buy once, watch anytime."
          />
        </ExploreShell>
      </section>

      <section className="py-10 md:py-14">
        <ExploreShell width="wide">
          <Suspense
            fallback={
              <div className="grid grid-cols-1 gap-5 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
                {Array.from({ length: 8 }).map((_, i) => (
                  <div
                    key={i}
                    className="overflow-hidden rounded-card border border-border bg-card"
                  >
                    <Skeleton className="aspect-video w-full rounded-none" />
                    <div className="space-y-2 p-4">
                      <Skeleton className="h-4 w-1/3" />
                      <Skeleton className="h-4 w-full" />
                      <Skeleton className="h-3 w-2/3" />
                    </div>
                  </div>
                ))}
              </div>
            }
          >
            <RecordingsGrid />
          </Suspense>

          <p className="mt-10 flex items-center gap-1.5 text-sm text-muted-foreground">
            Looking for live sessions instead?
            <a
              href={exploreHref.programs.list}
              className="inline-flex items-center gap-1 font-medium text-brand-foreground-subtle underline-offset-4 hover:underline"
            >
              Browse programs
              <ArrowRight className="h-3.5 w-3.5" aria-hidden="true" />
            </a>
          </p>
        </ExploreShell>
      </section>
    </main>
  );
}
