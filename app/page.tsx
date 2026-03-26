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
import { FAQSection } from "@/components/home/FAQSection";
import { SatisfiedTestimonial } from "@/app/explore/experts/components/SatisfiedTestimonial";
import { getHomeExperts, getHomeReviews, getHomeImages } from "@/lib/data/home";
import {
  BenefitsSkeleton,
  FeaturedExpertsSkeleton,
  TestimonialsSkeleton,
} from "@/components/home/HomeSectionSkeletons";

async function BenefitsLoader() {
  const images = await getHomeImages();
  return <BenefitsSection images={images} />;
}

async function FeaturedExpertsLoader() {
  const experts = await getHomeExperts();
  return <FeaturedExpertsSection experts={experts} isLoading={false} />;
}

async function ReviewsLoader() {
  const reviews = await getHomeReviews();
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

      {/* Become an Expert CTA - Light mesh gradient */}
      <BecomeExpertSection />

      {/* Explore Testimonials - Dark */}
      <SatisfiedTestimonial />

      {/* FAQ - Clean white */}
      <FAQSection />
    </main>
  );
}
