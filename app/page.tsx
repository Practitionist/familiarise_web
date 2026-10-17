import { Suspense } from "react";
import { LandingHero } from "@/components/home/LandingHero";
import { LandingDiscovery } from "@/components/home/LandingDiscovery";
import { ProductPreview } from "@/components/home/ProductPreview";
import { LandingReviews } from "@/components/home/LandingReviews";
import { LandingFAQ } from "@/components/home/LandingFAQ";
import {
  LandingFormats,
  LandingHowItWorks,
  LandingAudiencePaths,
  LandingFinalCTA,
} from "@/components/home/LandingSections";
import { ReviewSkeleton } from "@/components/home/LandingSkeletons";
import { getHomeExperts, getHomeReviews, getHomeStats } from "@/lib/data/home";
import { buildExpertHeroStats } from "@/lib/data/public-stats";
import { withBuildTimeRetry } from "@/lib/data/fail-open";

// ISR, not force-dynamic. Nothing here is per-viewer — the root layout reads no
// session (the Navbar is a client component on useSession()), and every section
// below renders the same curated marketing data for signed-in and anonymous
// visitors alike — so one cached HTML document is correct for everyone.
//
// force-dynamic was actively harmful on this route: Next marks a dynamic page
// `private, no-cache, no-store, max-age=0, must-revalidate`, which is uncacheable
// at every CDN, so every first-time visitor paid a Netlify ap-southeast-1 ->
// Supabase ap-south-1 round trip behind a cold function boot. Prerendered HTML is
// served straight off the CDN with no function invocation at all, on the one page
// where LCP matters most.
//
// This route IS prerendered during `next build` and its reads therefore run in
// the build environment — the #932 risk. That is deliberate and guarded: these
// reads no longer degrade at all (#1119), so a transient pooler failure fails the
// build loudly instead of baking an empty landing page into static HTML for a
// whole window. `withBuildTimeRetry` gives the build two extra attempts first.
//
// 1 hour: curated marketing content that changes on the order of days. Publishing
// a featured expert or review purges this path on demand (revalidateTag/
// revalidatePath at the write sites), so the interval is a backstop, not the SLA.
export const revalidate = 3600;

// Each section reads independently. A transient pooler timeout (cross-region cold
// connect, #932) now throws past its Suspense boundary rather than rendering the
// section empty, because this route is ISR and an empty section would be cached
// and replayed for the whole window (#1119).
//
// Be clear about the trade, because it is worse for one visitor than it used to
// be: this replaces the entire landing page with app/error.tsx, hero and all, not
// just the section that failed. It is the right trade only because `/` is
// prerendered at build, so a cached copy almost always exists and a failed
// revalidation keeps serving it. The exposed window is a regeneration with no
// cached copy — i.e. straight after a revalidatePath purge from a write site.
// (FAMILIARISE_WEB-A)
async function ReviewsLoader() {
  const reviews = await withBuildTimeRetry(getHomeReviews);
  return <LandingReviews reviews={reviews} />;
}

// Await the hero's real figures and expert preview in parallel. `/` remains ISR
// on the same 1-hour window: this is build/regeneration work, not a per-viewer
// availability read. Passing the one expert result to both sections avoids a
// duplicate query and keeps the hero/profile links visible without JavaScript.
// Lower-priority reviews retain their independent streaming boundary.
export default async function Home() {
  const [stats, experts] = await Promise.all([
    withBuildTimeRetry(getHomeStats),
    withBuildTimeRetry(getHomeExperts),
  ]);

  return (
    <main className="flex-1 w-full overflow-hidden bg-white text-zinc-950">
      <LandingHero
        stats={buildExpertHeroStats(stats)}
        preview={<ProductPreview experts={experts} />}
      />
      <LandingDiscovery experts={experts} domains={stats.domains} />
      <LandingFormats />
      <LandingHowItWorks />
      <Suspense fallback={<ReviewSkeleton />}>
        <ReviewsLoader />
      </Suspense>
      <LandingAudiencePaths />
      <LandingFAQ />
      <LandingFinalCTA />
    </main>
  );
}
