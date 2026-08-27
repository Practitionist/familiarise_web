import { Suspense } from "react";
import { Sparkles } from "lucide-react";
import { SpotlightGrid } from "@/components/motion";
import { FeaturedExperts } from "./components/FeaturedExperts";
import ExpertsInteractiveContent from "./ExpertsInteractiveContent";
import {
  getExpertsMetadata,
  getCuratedExperts,
} from "@/lib/data/explore-experts";
import { withBuildTimeRetry } from "@/lib/data/fail-open";

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
      value: totalConsultants > 0 ? `${totalConsultants}` : "10K+",
      label: "Active Experts",
    },
    {
      value: averageRating > 0 ? averageRating.toFixed(1) : "4.9",
      label: "Avg Rating",
    },
    { value: "50K+", label: "Sessions" },
  ];

  return (
    <section className="relative bg-zinc-950 pb-16 pt-36 overflow-hidden">
      <SpotlightGrid className="opacity-60" />
      <div
        aria-hidden
        className="pointer-events-none absolute -top-32 left-1/2 h-[360px] w-[720px] -translate-x-1/2 rounded-full bg-zinc-500/10 blur-[120px]"
      />

      <div className="max-w-[1600px] mx-auto px-4 md:px-8 lg:px-12 relative z-10">
        {/* Server-rendered hero: CSS entrance animations only — this file is
            a server component and must not import framer-motion directly. */}
        <div className="max-w-3xl">
          <div
            className="reveal-up inline-flex items-center gap-2 rounded-full border border-white/10 bg-white/[0.04] px-3.5 py-1 text-xs text-zinc-300 mb-6"
          >
            <Sparkles className="h-3.5 w-3.5" />
            World-Class Mentorship
          </div>

          <h1
            className="reveal-up stagger-2 text-fluid-4xl md:text-fluid-5xl font-bold tracking-tight text-white leading-[1.05]"
          >
            Meet your perfect{" "}
            <span className="silver-text">mentor</span>
          </h1>

          <p
            className="reveal-up stagger-3 mt-5 max-w-xl text-lg text-zinc-400"
          >
            Verified experts who understand your journey — book a session and
            start levelling up today.
          </p>

          <dl
            className="reveal-up stagger-4 mt-10 flex flex-wrap items-center gap-x-10 gap-y-4 border-t border-white/[0.07] pt-7"
          >
            {STATS.map((stat) => (
              <div key={stat.label}>
                <dt className="sr-only">{stat.label}</dt>
                <dd className="text-2xl font-semibold tabular-nums text-white">
                  {stat.value}
                </dd>
                <dd className="text-xs uppercase tracking-wider text-zinc-500">
                  {stat.label}
                </dd>
              </div>
            ))}
          </dl>
        </div>
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
        />
      </Suspense>
    </main>
  );
}
