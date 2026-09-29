import { Suspense } from "react";
import { Sparkles } from "lucide-react";
import {
  ExploreHeader,
  ExploreShell,
  ExploreStat,
} from "@/components/explore/ExploreShell";
import { FeaturedExperts } from "./components/FeaturedExperts";
import ExpertsInteractiveContent from "./ExpertsInteractiveContent";
import {
  getExpertsMetadata,
  getCuratedExperts,
} from "@/lib/data/explore-experts";
import { withBuildTimeRetry } from "@/lib/data/fail-open";
import { buildExpertHeroStats } from "@/lib/data/public-stats";

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

  // #1485 — real figures or nothing. Before launch every one of these is zero,
  // and the honest fallback line below is what a visitor sees instead of the
  // "10K+ / 4.9 / 50K+" that used to be rendered from nowhere.
  const heroStats = buildExpertHeroStats(metadata.consultantMetadata);
  const hasHeroStats = heroStats.length > 0;

  return (
    <main className="min-h-screen bg-background">
      {/* Hero band — see ProgramsInteractiveContent.tsx for the same block and
          the reasoning. Was a hand-rolled slab: `bg-zinc-950`, two
          `animate-blob` orbs, a `grid-pattern` overlay, a `rounded-full`
          `bg-zinc-800/50` pill, and a `silver-text` gradient word. The two
          listings were visually near-identical while sharing no code. */}
      <section className="relative overflow-hidden border-b border-border-subtle bg-surface-inverse">
        <div aria-hidden="true" className="absolute inset-0">
          <div className="absolute -left-24 -top-24 h-[480px] w-[480px] rounded-full bg-brand/15 blur-[120px] motion-reduce:hidden" />
          <div className="absolute -bottom-32 -right-16 h-[420px] w-[420px] rounded-full bg-brand/10 blur-[110px] motion-reduce:hidden" />
        </div>
        <div className="relative py-12 md:py-16">
          <ExploreShell width="wide">
            {/* The hero reveal is a CSS animation, not framer-motion.
                This file is a SERVER component (it is ISR-prerendered), and a
                `motion.*` element rendered here fails static prerendering with
                "Element type is invalid" — the client reference has no
                boundary to attach to. `.reveal-up` is the same 0.8s ease-out
                rise, needs no client JS, and is already neutralised under
                prefers-reduced-motion in globals.css. */}
            <div className="reveal-up">
              <ExploreHeader
                tone="dark"
                eyebrow={
                  <span className="inline-flex items-center gap-1.5">
                    <Sparkles className="h-3.5 w-3.5" aria-hidden="true" />
                    World-class mentorship
                  </span>
                }
                title={
                  <>
                    Meet your perfect{" "}
                    <span className="text-brand">mentor</span>
                  </>
                }
                description="Connect with industry experts who understand where you want to go."
                meta={hasHeroStats ? (
                  <>
                    {heroStats.map((stat) => (
                      <ExploreStat
                        key={stat.key}
                        tone="dark"
                        value={stat.display}
                        label={stat.label}
                      />
                    ))}
                  </>
                ) : undefined}
              />
              {!hasHeroStats && (
                <p className="mt-6 text-sm text-white/50">
                  Check back for newly verified experts.
                </p>
              )}
            </div>
          </ExploreShell>
        </div>
      </section>

      <FeaturedExperts experts={featuredExperts} isLoading={false} />

      <Suspense
        fallback={
          <section className="mx-auto max-w-[1400px] space-y-6 px-4 py-10 md:px-8 lg:px-12">
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
