import { Suspense } from "react";

import { HeroSection } from "@/components/home/HeroSection";
import { LogoMarqueeSection } from "@/components/home/LogoMarqueeSection";
import { FeaturesSection } from "@/components/home/FeaturesSection";
import { CategoriesSection } from "@/components/home/CategoriesSection";
import { BenefitsSection } from "@/components/home/BenefitsSection";
import { FeaturedExpertsSection } from "@/components/home/FeaturedExpertsSection";
import { TestimonialsSection } from "@/components/home/TestimonialsSection";
import { HowItWorksSection } from "@/components/home/HowItWorksSection";
import { BecomeExpertSection } from "@/components/home/BecomeExpertSection";
import { FAQSection } from "@/components/home/FAQSection";
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
  return <TestimonialsSection reviews={reviews} isLoading={false} />;
}

export default function Home() {
  return (
    <main className="flex-1 w-full overflow-hidden">
      {/* Hero - Black with animated orbs */}
      <HeroSection />

      {/* Logo marquee + proof strip - Dark, reads as hero's coda */}
      <LogoMarqueeSection />

      {/* Offerings bento - Light */}
      <FeaturesSection />

      {/* Browse by Category - Light gradient */}
      <CategoriesSection />

      {/* Why Familiarise / Benefits - Light silver gradient */}
      <Suspense fallback={<BenefitsSkeleton />}>
        <BenefitsLoader />
      </Suspense>

      {/* Testimonials + trust badges - Dark */}
      <Suspense fallback={<TestimonialsSkeleton />}>
        <ReviewsLoader />
      </Suspense>

      {/* Featured Experts Marquee - White with dot pattern */}
      <Suspense fallback={<FeaturedExpertsSkeleton />}>
        <FeaturedExpertsLoader />
      </Suspense>

      {/* How It Works - Light with circles */}
      <HowItWorksSection />

      {/* Become an Expert CTA - Dark split */}
      <BecomeExpertSection />

      {/* FAQ - Clean white */}
      <FAQSection />
    </main>
  );
}
