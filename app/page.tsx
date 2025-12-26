"use client";

import dynamic from "next/dynamic";
import { useQuery } from "@tanstack/react-query";

// Keep HeroSection static (above fold - critical for LCP)
import { HeroSection } from "@/components/home";

import type { SupabaseImageFile } from "@/lib/supabase";
import { fetchImagesFromSupabaseStorage } from "@/lib/supabase";
import type { TConsultantProfile } from "@/types/consultant";
import type { ReviewWithProfiles } from "@/types/review";

// Code-split below-fold sections (SSR enabled to prevent layout shift)
const TrustedBySection = dynamic(() =>
  import("@/components/home/TrustedBySection").then((m) => m.TrustedBySection)
);
const FeaturesSection = dynamic(() =>
  import("@/components/home/FeaturesSection").then((m) => m.FeaturesSection)
);
const CategoriesSection = dynamic(() =>
  import("@/components/home/CategoriesSection").then((m) => m.CategoriesSection)
);
const BenefitsSection = dynamic(() =>
  import("@/components/home/BenefitsSection").then((m) => m.BenefitsSection)
);
const SuccessStoriesSection = dynamic(() =>
  import("@/components/home/SuccessStoriesSection").then(
    (m) => m.SuccessStoriesSection
  )
);
const FeaturedExpertsSection = dynamic(() =>
  import("@/components/home/FeaturedExpertsSection").then(
    (m) => m.FeaturedExpertsSection
  )
);
const PlatformFeaturesSection = dynamic(() =>
  import("@/components/home/PlatformFeaturesSection").then(
    (m) => m.PlatformFeaturesSection
  )
);
const TestimonialsSection = dynamic(() =>
  import("@/components/home/TestimonialsSection").then(
    (m) => m.TestimonialsSection
  )
);
const UpcomingEventsSection = dynamic(() =>
  import("@/components/home/UpcomingEventsSection").then(
    (m) => m.UpcomingEventsSection
  )
);
const TrustBadgesSection = dynamic(() =>
  import("@/components/home/TrustBadgesSection").then(
    (m) => m.TrustBadgesSection
  )
);
const HowItWorksSection = dynamic(() =>
  import("@/components/home/HowItWorksSection").then((m) => m.HowItWorksSection)
);
const BecomeExpertSection = dynamic(() =>
  import("@/components/home/BecomeExpertSection").then(
    (m) => m.BecomeExpertSection
  )
);
const FAQSection = dynamic(() =>
  import("@/components/home/FAQSection").then((m) => m.FAQSection)
);

// ===== FETCHERS =====
const fetchHomePageData = async <T,>(url: string): Promise<T> => {
  const res = await fetch(url);
  if (!res.ok) throw new Error("Failed to fetch data");
  const jsonData = await res.json();
  return jsonData.data as T;
};

const supabaseImagesFetcher = async ([, bucket, path]: [
  string,
  string,
  string,
]): Promise<SupabaseImageFile[]> => {
  const imageData = await fetchImagesFromSupabaseStorage(bucket, path);
  return imageData || [];
};

// ===== MAIN COMPONENT =====
export default function Home() {
  // Data fetching
  const { data: imagesData } = useQuery<SupabaseImageFile[]>({
    queryKey: ["supabase_landing_images", "assets", "images/landing-page"],
    queryFn: ({ queryKey }) =>
      supabaseImagesFetcher(queryKey as [string, string, string]),
    staleTime: 5 * 60 * 1000,
  });

  const { data: expertsData, isLoading: isLoadingExperts } = useQuery<
    TConsultantProfile[]
  >({
    queryKey: ["home-experts"],
    queryFn: () =>
      fetchHomePageData<TConsultantProfile[]>("/api/user/consultants?limit=10"),
    staleTime: 2 * 60 * 1000,
  });

  const { data: reviewsData, isLoading: isLoadingReviews } = useQuery<
    ReviewWithProfiles[]
  >({
    queryKey: ["home-reviews"],
    queryFn: () =>
      fetchHomePageData<ReviewWithProfiles[]>("/api/user/reviews?rating=4"),
    staleTime: 5 * 60 * 1000,
  });

  const images = imagesData || [];
  const experts = expertsData || [];
  const reviews = reviewsData || [];

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
      <BenefitsSection images={images} />

      {/* Success Stories - Dark gradient */}
      <SuccessStoriesSection />

      {/* Featured Experts Marquee - White with dot pattern */}
      <FeaturedExpertsSection experts={experts} isLoading={isLoadingExperts} />

      {/* Platform Features - Light with diagonal stripes */}
      <PlatformFeaturesSection />

      {/* Testimonials Marquee - Dark gradient (RESTORED) */}
      <TestimonialsSection reviews={reviews} isLoading={isLoadingReviews} />

      {/* Reviews + Upcoming Events Split - Dark */}
      <UpcomingEventsSection reviews={reviews} />

      {/* Trust & Security Badges - Dark strip */}
      <TrustBadgesSection />

      {/* How It Works - Light with circles */}
      <HowItWorksSection />

      {/* Become an Expert CTA - Light mesh gradient */}
      <BecomeExpertSection />

      {/* FAQ - Clean white */}
      <FAQSection />

      {/* Newsletter is now merged into Footer for seamless dark block */}
    </main>
  );
}
