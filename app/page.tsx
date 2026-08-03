import { Suspense } from "react";

import { HeroSection } from "@/components/home/HeroSection";
import { TrustedBySection } from "@/components/home/TrustedBySection";
import { FeaturesSection } from "@/components/home/FeaturesSection";
import { CategoriesSection } from "@/components/home/CategoriesSection";
import { BenefitsSection } from "@/components/home/BenefitsSection";
import { SuccessStoriesSection } from "@/components/home/SuccessStoriesSection";
import { FeaturedExpertsSection } from "@/components/home/FeaturedExpertsSection";
import { PlatformFeaturesSection } from "@/components/home/PlatformFeaturesSection";
import { TestimonialsSection } from "@/components/home/TestimonialsSection";
import { UpcomingEventsSection } from "@/components/home/UpcomingEventsSection";
import { TrustBadgesSection } from "@/components/home/TrustBadgesSection";
import { HowItWorksSection } from "@/components/home/HowItWorksSection";
import { BecomeExpertSection } from "@/components/home/BecomeExpertSection";
import { EnterpriseSection } from "@/components/home/EnterpriseSection";
import { FAQSection } from "@/components/home/FAQSection";
import { SatisfiedTestimonial } from "@/app/explore/experts/components/SatisfiedTestimonial";
import { getHomeExperts, getHomeReviews, getHomeImages } from "@/lib/data/home";
import { emptyOnTransientDbError } from "@/lib/data/fail-open";
import {
  BenefitsSkeleton,
  FeaturedExpertsSkeleton,
  TestimonialsSkeleton,
} from "@/components/home/HomeSectionSkeletons";

// ISR, not force-dynamic. Nothing here is per-viewer — the root layout reads no
// session (the Navbar is a client component on useSession()), and every section
// below renders the same curated marketing data for signed-in and anonymous
// visitors alike — so one cached HTML document is correct for everyone.
//
// This does NOT reintroduce the build-time cross-region DB connect that #932
// avoided: revalidation happens on a request in the deployed region, never
// during `next build`, so please don't "fix" this back to force-dynamic.
//
// 5 minutes: the underlying reads are already unstable_cache'd at 120-600s
// (lib/data/home.ts), so this mostly saves the render, not the query. A newly
// featured expert or review appears within one window, which is fine for a
// curated marketing surface.
export const revalidate = 300;

// Each section reads independently; a transient pooler timeout (cross-region cold
// connect, #932) in any one degrades that section to empty rather than throwing
// past its Suspense boundary and crashing the whole landing page. (FAMILIARISE_WEB-A)
async function BenefitsLoader() {
  const images = await getHomeImages().catch(
    emptyOnTransientDbError("home images"),
  );
  return <BenefitsSection images={images} />;
}

async function FeaturedExpertsLoader() {
  const experts = await getHomeExperts().catch(
    emptyOnTransientDbError("home experts"),
  );
  // Hide the section rather than render an empty marquee under its headers when
  // there's nothing to show — whether a transient timeout degraded it or the
  // platform genuinely has no featured experts yet. (#934 review.)
  if (experts.length === 0) return null;
  return <FeaturedExpertsSection experts={experts} isLoading={false} />;
}

async function ReviewsLoader() {
  const reviews = await getHomeReviews().catch(
    emptyOnTransientDbError("home reviews"),
  );
  if (reviews.length === 0) return null;
  return (
    <>
      <TestimonialsSection reviews={reviews} isLoading={false} />
      <UpcomingEventsSection reviews={reviews} />
    </>
  );
}

export default function Home() {
  return (
    <main className="flex-1 w-full overflow-hidden">
      {/* Hero - Black with animated orbs */}
      <HeroSection />

      {/* Trusted By / Logo Cloud - Dark */}
      <TrustedBySection />

      {/* Our Offerings - Dark charcoal with dot pattern */}
      <FeaturesSection />

      {/* Browse by Category - Light gradient */}
      <CategoriesSection />

      {/* Why Familiarise / Benefits - Light silver gradient */}
      <Suspense fallback={<BenefitsSkeleton />}>
        <BenefitsLoader />
      </Suspense>

      {/* Success Stories - Dark gradient */}
      <SuccessStoriesSection />

      {/* Featured Experts Marquee - White with dot pattern */}
      <Suspense fallback={<FeaturedExpertsSkeleton />}>
        <FeaturedExpertsLoader />
      </Suspense>

      {/* Platform Features - Light with diagonal stripes */}
      <PlatformFeaturesSection />

      {/* Testimonials Marquee + Upcoming Events - Dark */}
      <Suspense fallback={<TestimonialsSkeleton />}>
        <ReviewsLoader />
      </Suspense>

      {/* Trust & Security Badges - Dark strip */}
      <TrustBadgesSection />

      {/* How It Works - Light with circles */}
      <HowItWorksSection />

      {/* For teams & organisations - Dark. Sits next to the expert CTA so the
          two "which side are you on?" paths are adjacent at the page's end. */}
      <EnterpriseSection />

      {/* Become an Expert CTA - Light mesh gradient */}
      <BecomeExpertSection />

      {/* Explore Testimonials - Dark */}
      <SatisfiedTestimonial />

      {/* FAQ - Clean white */}
      <FAQSection />
    </main>
  );
}
