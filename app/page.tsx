import { Suspense } from "react";

import { HeroSection } from "@/components/home/HeroSection";
import { TrustedBySection } from "@/components/home/TrustedBySection";
import { CategoriesSection } from "@/components/home/CategoriesSection";
import { FeaturesSection } from "@/components/home/FeaturesSection";
import { FeaturedExpertsSection } from "@/components/home/FeaturedExpertsSection";
import { HowItWorksSection } from "@/components/home/HowItWorksSection";
import { TestimonialsSection } from "@/components/home/TestimonialsSection";
import { FAQSection } from "@/components/home/FAQSection";
import { EnterpriseSection } from "@/components/home/EnterpriseSection";
import { BecomeExpertSection } from "@/components/home/BecomeExpertSection";
import { LandingMotionProvider } from "@/components/home/LandingMotionProvider";
import {
  getHomeExperts,
  getHomeReviews,
  getHomeStats,
} from "@/lib/data/home";
import { buildExpertHeroStats } from "@/lib/data/public-stats";
import { withBuildTimeRetry } from "@/lib/data/fail-open";
import {
  FeaturedExpertsSkeleton,
  TestimonialsSkeleton,
} from "@/components/home/HomeSectionSkeletons";

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
async function FeaturedExpertsLoader() {
  const experts = await withBuildTimeRetry(getHomeExperts);
  // Hide the section rather than render an empty grid under its headers when
  // there's nothing to show — whether a transient timeout degraded it or the
  // platform genuinely has no featured experts yet. (#934 review.)
  if (experts.length === 0) return null;
  return <FeaturedExpertsSection experts={experts} isLoading={false} />;
}

async function ReviewsLoader() {
  const reviews = await withBuildTimeRetry(getHomeReviews);
  if (reviews.length === 0) return null;
  return <TestimonialsSection reviews={reviews} isLoading={false} />;
}

// #1490 — the hero and the category cards render real figures now, so the page
// component awaits them. That is affordable precisely here: `/` is prerendered
// at build and served from the CDN, so no visitor pays for this read, and the
// loader is cached on the same 1-hour window as the segment so a regeneration
// reads a blob rather than the pooler. The heavy curated sections keep their
// Suspense boundaries below; this one small read is not worth a skeleton in the
// LCP element.
export default async function Home() {
  const stats = await withBuildTimeRetry(getHomeStats);

  return (
    <LandingMotionProvider>
      <main className="flex-1 w-full overflow-hidden">
        {/* 1. Hero — Dark two-column layout with inline search & booking preview */}
        <HeroSection stats={buildExpertHeroStats(stats)} />

        {/* 2. Trusted By — Dark logo strip */}
        <TrustedBySection />

        {/* 3. Browse by Domain — Crisp light grid with real consultant counts */}
        <CategoriesSection consultantsByDomain={stats.consultantsByDomain} />

        {/* 4. Session Formats & Built-in Platform Capabilities — Dark bento */}
        <FeaturesSection />

        {/* 5. Featured Experts — Static 4-column bento grid */}
        <Suspense fallback={<FeaturedExpertsSkeleton />}>
          <FeaturedExpertsLoader />
        </Suspense>

        {/* 6. How It Works — 3-step horizontal flow on bg-muted */}
        <HowItWorksSection />

        {/* 7. Verified Reviews & Trust Guarantees — Static 3-column grid on dark */}
        <Suspense fallback={<TestimonialsSkeleton />}>
          <ReviewsLoader />
        </Suspense>

        {/* 8. FAQ — Single-container editorial accordion */}
        <FAQSection />

        {/* 9. Closing Audience Paths — Enterprise (bg-muted) + Become an Expert (bg-zinc-950) */}
        <EnterpriseSection />
        <BecomeExpertSection />
      </main>
    </LandingMotionProvider>
  );
}
