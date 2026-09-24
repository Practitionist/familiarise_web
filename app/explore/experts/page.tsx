import { Suspense } from "react";
import { ArrowDownRight, Users, Star, TrendingUp } from "lucide-react";
import type { LucideIcon } from "lucide-react";
import { FeaturedExperts } from "./components/FeaturedExperts";
import ExpertsInteractiveContent from "./ExpertsInteractiveContent";
import {
  getExpertsMetadata,
  getCuratedExperts,
} from "@/lib/data/explore-experts";
import { withBuildTimeRetry } from "@/lib/data/fail-open";
import {
  buildExpertHeroStats,
  type ExpertStatKey,
  type IPublicStat,
} from "@/lib/data/public-stats";

// ISR, not force-dynamic. This listing reads no session and takes no
// searchParams (filtering happens in the client component below), so the
// rendered HTML is identical for every visitor and safe to share.
//
// force-dynamic made this route uncacheable at the CDN (Next sends dynamic pages
// `private, no-store`), so every visitor paid a cross-region cold DB round trip.
// Prerendered HTML is served off the CDN with no function invocation.
//
// This route IS prerendered during `next build`, which is exactly the read #932
// saw fail on a cold cross-region pooler connect. That is guarded rather than
// avoided: these reads no longer degrade at all (#1119), so a flaky build fails
// loudly instead of shipping an empty experts directory. `withBuildTimeRetry`
// gives the build two extra attempts before it gives up.
//
// 5 minutes, matched by the unstable_cache windows on the reads below so the
// declared interval is the effective one — Next resolves a route's revalidate to
// the MINIMUM of the segment value and every data-cache entry read during the
// render, so a shorter window underneath would silently win. New and updated
// profiles purge this path on demand at the write sites.
export const revalidate = 300;

const STAT_ICONS: Record<ExpertStatKey, LucideIcon> = {
  experts: Users,
  rating: Star,
  sessions: TrendingUp,
};

function HeroSection({ stats }: { stats: IPublicStat<ExpertStatKey>[] }) {
  return (
    <section className="explore-hero relative overflow-hidden pb-14 pt-28 text-white md:pb-20 md:pt-36">
      <div
        className="absolute inset-0 grid-pattern opacity-10"
        aria-hidden="true"
      />
      <div className="relative mx-auto grid max-w-[1600px] items-end gap-10 px-4 md:px-8 lg:grid-cols-[minmax(0,1fr)_auto] lg:gap-16 lg:px-12">
        <div className="max-w-3xl">
          <p className="mb-5 inline-flex items-center gap-2 text-xs font-semibold uppercase tracking-[0.2em] text-zinc-300">
            <span className="h-px w-8 bg-zinc-400" /> Familiarise experts
          </p>
          <h1 className="text-fluid-5xl font-semibold tracking-tight text-white">
            Find expertise that moves you forward.
          </h1>
          <p className="mt-6 max-w-2xl text-base leading-relaxed text-zinc-300 md:text-lg">
            Explore specialists across disciplines, compare their experience,
            and choose the right person for your next step.
          </p>
          <a
            href="#all-experts"
            className="mt-8 inline-flex items-center gap-2 rounded-full border border-white/25 px-5 py-3 text-sm font-medium text-white transition-colors hover:bg-white hover:text-zinc-950 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white"
          >
            Browse all experts{" "}
            <ArrowDownRight className="h-4 w-4" aria-hidden="true" />
          </a>
        </div>

        {/* #1485 — real figures or nothing. Before launch every one of these
              is zero, and the honest line below is what a visitor sees instead
              of the "10K+ / 4.9 / 50K+" that used to be rendered from nowhere. */}
        {stats.length > 0 ? (
          <div className="flex flex-wrap gap-6 border-t border-white/15 pt-6 lg:max-w-[360px] lg:justify-end lg:border-l lg:border-t-0 lg:pl-8 lg:pt-0">
            {stats.map((stat) => {
              const Icon = STAT_ICONS[stat.key];
              return (
                <div key={stat.key} className="min-w-[88px]">
                  <div className="mb-3 flex h-9 w-9 items-center justify-center rounded-lg border border-white/15 bg-white/5">
                    <Icon className="h-4 w-4 text-zinc-200" />
                  </div>
                  <div className="text-xl font-semibold text-white md:text-2xl">
                    {stat.display}
                  </div>
                  <div className="text-xs text-zinc-400">{stat.label}</div>
                </div>
              );
            })}
          </div>
        ) : (
          <p className="border-t border-white/15 pt-6 text-sm text-zinc-400 lg:border-l lg:border-t-0 lg:pl-8 lg:pt-0">
            Check back for newly verified experts.
          </p>
        )}
      </div>
    </section>
  );
}

export default async function ExploreExperts() {
  // These used to degrade to empty rows on a transient timeout. This route is ISR,
  // so that empty page would be cached and served to everyone until the window
  // expired; retry once and otherwise throw, which caches nothing (#1119).
  const [metadata, featuredExperts, trendingExperts, newestExperts] =
    await Promise.all([
      withBuildTimeRetry(getExpertsMetadata),
      withBuildTimeRetry(() => getCuratedExperts("rating", 5)),
      withBuildTimeRetry(() => getCuratedExperts("trending", 8)),
      withBuildTimeRetry(() => getCuratedExperts("newest", 8)),
    ]);

  return (
    <main className="min-h-screen bg-background">
      <HeroSection stats={buildExpertHeroStats(metadata.consultantMetadata)} />

      <FeaturedExperts experts={featuredExperts} isLoading={false} />

      <Suspense
        fallback={
          <section className="mx-auto max-w-[1600px] space-y-6 px-4 py-10 md:px-8 lg:px-12">
            <div className="flex flex-wrap gap-2">
              {Array.from({ length: 5 }).map((_, i) => (
                <div
                  key={i}
                  className="h-10 w-28 animate-pulse rounded-full bg-muted"
                />
              ))}
            </div>
            <div className="grid gap-5 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
              {Array.from({ length: 8 }).map((_, i) => (
                <div
                  key={i}
                  className="h-56 animate-pulse rounded-xl bg-muted"
                />
              ))}
            </div>
          </section>
        }
      >
        <ExpertsInteractiveContent
          metadata={metadata}
          trendingExperts={trendingExperts}
          newestExperts={newestExperts}
        />
      </Suspense>
    </main>
  );
}
