import { Suspense } from "react";
import { Star, TrendingUp, Users } from "lucide-react";
import type { LucideIcon } from "lucide-react";
import { FeaturedExperts } from "./components/FeaturedExperts";
import ExpertsInteractiveContent from "./ExpertsInteractiveContent";
import ExploreHero from "@/app/explore/components/ExploreHero";
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
    <ExploreHero
      eyebrow="World-Class Mentorship"
      title={
        <>
          Meet Your Perfect <span className="silver-text">Mentor</span>
        </>
      }
      description="Ready to level up? Our amazing mentors are here to guide you! Connect with industry experts who understand your journey."
      stats={stats.map((stat) => ({ ...stat, icon: STAT_ICONS[stat.key] }))}
      // #1485 — real figures or nothing. Before launch every one of these
      // is zero, and the honest line below is what a visitor sees instead
      // of the "10K+ / 4.9 / 50K+" that used to be rendered from nowhere.
      emptyStatsCopy="Check back for newly verified experts."
    />
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
