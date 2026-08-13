import { Suspense } from "react";
import { Sparkles, Users, Star, TrendingUp } from "lucide-react";
import { FeaturedExperts } from "./components/FeaturedExperts";
import ExpertsInteractiveContent from "./ExpertsInteractiveContent";
import {
  getExpertsMetadata,
  getCuratedExperts,
  getDefaultConsultantsPage,
} from "@/lib/data/explore-experts";
import { withBuildTimeRetry } from "@/lib/data/fail-open";
import { CONSULTANTS_PER_PAGE } from "./utils";

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

function HeroSection({
  totalConsultants,
  averageRating,
}: {
  totalConsultants: number;
  averageRating: number;
}) {
  const STATS = [
    {
      icon: Users,
      value: totalConsultants > 0 ? `${totalConsultants}` : "10K+",
      label: "Active Experts",
    },
    {
      icon: Star,
      value: averageRating > 0 ? averageRating.toFixed(1) : "4.9",
      label: "Average Rating",
    },
    { icon: TrendingUp, value: "50K+", label: "Sessions Completed" },
  ];

  return (
    <section className="relative pt-32 pb-20 bg-zinc-950 overflow-hidden">
      <div className="absolute inset-0">
        <div className="absolute top-1/4 left-1/4 w-[600px] h-[600px] bg-zinc-800/30 rounded-full blur-[120px] animate-blob" />
        <div className="absolute bottom-1/4 right-1/4 w-[500px] h-[500px] bg-zinc-700/20 rounded-full blur-[100px] animate-blob animation-delay-2000" />
      </div>
      <div className="absolute inset-0 grid-pattern opacity-20" />

      <div className="max-w-[1600px] mx-auto px-4 md:px-8 lg:px-12 relative z-10">
        <div className="max-w-4xl mx-auto text-center">
          <div className="inline-flex items-center gap-2 px-4 py-2 bg-zinc-800/50 backdrop-blur-sm border border-zinc-700/50 rounded-full mb-8">
            <Sparkles className="w-4 h-4 text-white" />
            <span className="text-sm font-medium text-zinc-300">
              World-Class Mentorship
            </span>
          </div>

          <h1 className="text-fluid-4xl md:text-fluid-5xl font-bold tracking-tight text-white mb-6">
            Meet Your Perfect <span className="silver-text">Mentor</span>
          </h1>

          <p className="text-lg md:text-xl text-zinc-400 mb-12 max-w-2xl mx-auto">
            Ready to level up? Our amazing mentors are here to guide you!
            Connect with industry experts who understand your journey.
          </p>

          <div className="flex flex-wrap justify-center gap-8 md:gap-16">
            {STATS.map((stat) => (
              <div key={stat.label} className="text-center">
                <div className="w-12 h-12 mx-auto mb-3 rounded-xl bg-zinc-800/50 border border-zinc-700/50 flex items-center justify-center">
                  <stat.icon className="w-6 h-6 text-white" />
                </div>
                <div className="text-2xl md:text-3xl font-bold text-white">
                  {stat.value}
                </div>
                <div className="text-sm text-zinc-500">{stat.label}</div>
              </div>
            ))}
          </div>
        </div>
      </div>
    </section>
  );
}

export default async function ExploreExperts() {
  // These used to degrade to empty rows on a transient timeout. This route is ISR,
  // so that empty page would be cached and served to everyone until the window
  // expired; retry once and otherwise throw, which caches nothing (#1119).
  const [
    metadata,
    featuredExperts,
    trendingExperts,
    newestExperts,
    initialConsultantsPage,
  ] = await Promise.all([
    withBuildTimeRetry(getExpertsMetadata),
    withBuildTimeRetry(() => getCuratedExperts("rating", 5)),
    withBuildTimeRetry(() => getCuratedExperts("trending", 8)),
    withBuildTimeRetry(() => getCuratedExperts("newest", 8)),
    // Page 1 of the default grid — the same cached read the API's default
    // view serves. Seeds the client useConsultants query so the browse grid
    // paints with the HTML instead of a second skeleton-then-fetch pass.
    // "nameAsc" must stay in sync with DEFAULT_EXPERT_FILTERS.sort: the
    // client only applies this seed when its filters are exactly the
    // defaults, so a mismatched sort here would go unused, not mis-render.
    withBuildTimeRetry(() =>
      getDefaultConsultantsPage("nameAsc", CONSULTANTS_PER_PAGE),
    ),
  ]);

  return (
    <main className="min-h-screen bg-background">
      <HeroSection
        totalConsultants={metadata.consultantMetadata.totalConsultants}
        averageRating={metadata.consultantMetadata.averageRating}
      />

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
          initialConsultantsPage={initialConsultantsPage}
        />
      </Suspense>
    </main>
  );
}
