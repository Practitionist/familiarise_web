"use client";

import { useQuery } from "@tanstack/react-query";

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

import type { SupabaseImageFile } from "@/lib/supabase";
import { fetchImagesFromSupabaseStorage } from "@/lib/supabase";
import type { TConsultantProfile } from "@/types/consultant";
import type { ReviewWithProfiles } from "@/types/review";

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
