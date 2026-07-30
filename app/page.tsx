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

// Stream behind the (now static) layout's instant skeleton instead of prerendering
// at build — the static layout makes loading.tsx prefetchable, and force-dynamic
// keeps the curated data fresh + off the build-time cross-region DB connect. (#932)
export const dynamic = "force-dynamic";

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
