"use client";

import { useQuery } from "@tanstack/react-query";

import { AnimatePresence, motion } from "framer-motion";
import { Star, StarHalf, User } from "lucide-react";
import Link from "next/link";
import { Suspense, useEffect, useState } from "react";

import {
  Accordion,
  AccordionContent,
  AccordionItem,
  AccordionTrigger,
} from "@/components/ui/accordion";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";

import {
  ProcessFlowDisplay,
  ProcessFlowStepProps,
} from "@/components/home/flows/ProcessFlowDisplay";
import { OFFERINGS } from "@/constants/homePageData";
import type { SupabaseImageFile } from "@/lib/supabase"; // Use SupabaseImageFile directly
import { fetchImagesFromSupabaseStorage } from "@/lib/supabase";
import { renderLCPImage } from "@/utils/image";

import type { TConsultantProfile } from "@/types/consultant";
import type { ReviewWithProfiles } from "@/types/review";

// Styles from CSS modules, combined into a single object
const pageStyles = {
  // From FeaturedExpertsSection.module.css
  "featured-marquee-container": {
    width: "100%",
    overflow: "hidden",
    position: "relative" as const,
    maskImage:
      "linear-gradient(to right, transparent, black 5%, black 95%, transparent)",
    WebkitMaskImage:
      "linear-gradient(to right, transparent, black 5%, black 95%, transparent)",
  },
  "featured-marquee-track": {
    display: "flex",
    width: "fit-content",
    animation: "marquee-featured 60s linear infinite",
    transform: "translateX(0)",
  },
  // From Testimonials.module.css
  "testimonials-marqueeContainer": {
    width: "100%",
    overflow: "hidden",
    position: "relative" as const,
    maskImage:
      "linear-gradient(to right, transparent, black 20%, black 80%, transparent)",
    WebkitMaskImage:
      "linear-gradient(to right, transparent, black 20%, black 80%, transparent)",
  },
  "testimonials-marquee-track-ltr": {
    display: "flex",
    width: "fit-content",
    animationName: "marquee-testimonials-ltr",
    animationDuration: "180s",
    animationTimingFunction: "linear",
    animationIterationCount: "infinite",
    willChange: "transform",
    transition: "transform 0.5s ease",
    transform: "translateX(calc(-100% / 3))",
  },
  "testimonials-marquee-track-rtl": {
    display: "flex",
    width: "fit-content",
    animationName: "marquee-testimonials-rtl",
    animationDuration: "180s",
    animationTimingFunction: "linear",
    animationIterationCount: "infinite",
    willChange: "transform",
    transition: "transform 0.5s ease",
    transform: "translateX(calc(-100% / 3))",
  },
};

// Keyframes need to be global or injected. For simplicity, we'll assume they are in a global CSS file or use a library for animations.
// Or, if using a CSS-in-JS solution, they can be defined there.
// For this example, I'll add a <style jsx global> tag for keyframes.

// --- Helper Components ---

function RatingStars({ rating }: Readonly<{ rating: number }>) {
  const fullStars = Math.floor(rating);
  const hasHalfStar = rating % 1 >= 0.5;
  return (
    <div className="flex items-center gap-0.5 justify-center">
      {Array.from({ length: fullStars }, (_, i) => (
        <Star
          key={`star-${i}`}
          className="w-4 h-4 fill-yellow-400 text-yellow-400"
        />
      ))}
      {hasHalfStar && (
        <StarHalf className="w-4 h-4 fill-yellow-400 text-yellow-400" />
      )}
      <span className="text-sm text-gray-600 ml-1">{rating.toFixed(1)}</span>
    </div>
  );
}

function ExpertCard({
  expert,
  className = "",
}: Readonly<{ expert: TConsultantProfile; className?: string }>) {
  const [isAvatarLoaded, setIsAvatarLoaded] = useState(false);
  return (
    <Link
      href={`/explore/experts/${expert.id}`}
      className={`block hover:no-underline flex-shrink-0 w-[280px] ${className}`}
    >
      <Card className="hover:shadow-lg transition-shadow duration-300 hover:-translate-y-0.5 h-full mx-3">
        <CardHeader className="space-y-3">
          <div className="relative mx-auto h-16 w-16">
            {!isAvatarLoaded && (
              <div className="absolute inset-0 h-16 w-16 rounded-full bg-gray-300 animate-pulse" />
            )}
            <Avatar
              className={`mx-auto h-16 w-16 ${isAvatarLoaded ? "opacity-100" : "opacity-0"} transition-opacity duration-300`}
            >
              <AvatarImage
                src={expert.user.image ?? "/placeholder-user.jpg"}
                alt={expert.user.name ?? "Expert"}
                onLoad={() => setIsAvatarLoaded(true)}
                onError={() => setIsAvatarLoaded(true)} // Also set to true on error to show fallback
              />
              <AvatarFallback>
                <User className="h-8 w-8" />
              </AvatarFallback>
            </Avatar>
          </div>
          <h3 className="text-lg font-semibold text-center line-clamp-1">
            {expert.user.name}
          </h3>
          <RatingStars rating={expert.rating} />
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="text-center">
            <p className="text-sm text-gray-600 font-medium line-clamp-1">
              {expert.specialization || expert.domain.name}
            </p>
            <p className="text-xs text-gray-500 mt-1">
              {expert.experience} experience
            </p>
          </div>
          <div className="flex flex-wrap gap-2 justify-center">
            {expert.tags?.slice(0, 3).map((tag) => (
              <Badge
                key={tag.id}
                variant="secondary"
                className="text-xs px-2 py-0.5"
              >
                {tag.name}
              </Badge>
            ))}
          </div>
        </CardContent>
      </Card>
    </Link>
  );
}

function ExpertLoadingSkeleton() {
  return (
    <div className="flex-shrink-0 w-[280px]">
      <Card className="mx-3">
        <CardHeader>
          <div className="w-16 h-16 rounded-full bg-gray-200 animate-pulse mx-auto mb-3" />
          <div className="h-5 bg-gray-200 rounded animate-pulse w-3/4 mx-auto" />
        </CardHeader>
        <CardContent>
          <div className="space-y-2">
            <div className="h-4 bg-gray-200 rounded animate-pulse w-1/2 mx-auto" />
            <div className="h-3 bg-gray-200 rounded animate-pulse w-1/3 mx-auto" />
          </div>
        </CardContent>
      </Card>
    </div>
  );
}

const ReviewCard = ({ review }: { review: ReviewWithProfiles }) => {
  const stars = Array.from({ length: 5 }, (_, position) => ({
    id: `star-${position}-${review.id}`,
    filled: position < review.rating,
  }));
  return (
    <div className="w-[300px] flex-shrink-0 mx-3 bg-gradient-to-br from-gray-900 to-gray-800 border border-gray-700 rounded-2xl hover:border-teal-500/50 transition-all duration-300 hover:-translate-y-1 p-5">
      <div className="flex items-start gap-3">
        <Avatar className="h-10 w-10 border border-gray-600">
          {review.consulteeProfile?.user?.image ? (
            <AvatarImage
              src={review.consulteeProfile.user.image}
              alt={review.consulteeProfile.user.name || "Reviewer"}
            />
          ) : (
            <AvatarFallback className="bg-gray-700">
              <User className="h-5 w-5 text-gray-300" />
            </AvatarFallback>
          )}
        </Avatar>
        <div className="flex-1 min-w-0">
          <div className="flex justify-between items-start gap-2">
            <div className="min-w-0">
              <h4 className="font-semibold truncate text-white">
                {review.consulteeProfile?.user?.name || "Anonymous"}
              </h4>
              <p className="text-sm text-gray-400 truncate">
                Review for {review.consultantProfile?.user?.name}
              </p>
            </div>
            <div className="flex items-center flex-shrink-0">
              {stars.map((star) => (
                <Star
                  key={star.id}
                  className={`w-3 h-3 ${star.filled ? "text-yellow-400 fill-yellow-400" : "text-gray-600"}`}
                />
              ))}
            </div>
          </div>
          <p className="mt-3 text-gray-300 text-sm line-clamp-3">
            {review.reviewDescription || "No review description provided"}
          </p>
        </div>
      </div>
    </div>
  );
};

const TestimonialLoadingSkeleton = () => {
  const skeletonIds = Array.from(
    { length: 3 },
    (_, i) => `skeleton-${i}-${Math.random()}`,
  );
  return (
    <section className="py-16">
      <div className="container mx-auto px-4">
        <h2 className="text-3xl font-bold text-center mb-12">
          What Our Users Say
        </h2>
        <div className="flex justify-center">
          <div className="animate-pulse space-x-4 flex">
            {skeletonIds.map((id) => (
              <div
                key={id}
                className="w-[300px] h-[160px] bg-gray-200 rounded-lg flex-shrink-0"
              />
            ))}
          </div>
        </div>
      </div>
    </section>
  );
};

const flowData: Record<string, ProcessFlowStepProps[]> = {
  consultation: [
    {
      number: 1,
      title: "Select a Consultation Plan",
      description:
        "Browse and choose from various consultation plans offered by experts",
    },
    {
      number: 2,
      title: "Create Consultation Request",
      description:
        "Submit your request with preferred time slots and specific requirements",
    },
    {
      number: 3,
      title: "Schedule Appointment",
      description:
        "Once approved, an appointment is created for your consultation",
    },
    {
      number: 4,
      title: "Complete Payment",
      description: "Secure your booking by completing the payment process",
    },
    {
      number: 5,
      title: "Join Consultation",
      description:
        "Access your consultation at the scheduled time through our platform",
      isLast: true,
    },
  ],
  subscription: [
    {
      number: 1,
      title: "Choose Subscription Plan",
      description:
        "Select from monthly subscription plans with different benefits",
    },
    {
      number: 2,
      title: "Submit Subscription Request",
      description: "Provide your preferred schedule and learning goals",
    },
    {
      number: 3,
      title: "Schedule Multiple Sessions",
      description:
        "Get access to multiple appointments throughout your subscription period",
    },
    {
      number: 4,
      title: "One-time Payment",
      description: "Make a single payment to activate your subscription",
    },
    {
      number: 5,
      title: "Access All Benefits",
      description:
        "Enjoy regular sessions and additional subscription benefits",
      isLast: true,
    },
  ],
  webinar: [
    {
      number: 1,
      title: "Select Webinar",
      description: "Choose from upcoming webinars on various topics",
    },
    {
      number: 2,
      title: "Check Availability",
      description: "View scheduled dates and remaining spots",
    },
    {
      number: 3,
      title: "Book Your Spot",
      description: "Reserve your place in the webinar",
    },
    {
      number: 4,
      title: "Complete Payment",
      description: "Secure your spot by completing the payment",
    },
    {
      number: 5,
      title: "Join Webinar",
      description: "Get access to the webinar at the scheduled time",
      isLast: true,
    },
  ],
  class: [
    {
      number: 1,
      title: "Choose Class Plan",
      description: "Browse structured class programs with detailed curricula",
    },
    {
      number: 2,
      title: "Check Class Schedule",
      description: "View class timings and batch availability",
    },
    {
      number: 3,
      title: "Secure Your Seat",
      description: "Book your place in the upcoming batch",
    },
    {
      number: 4,
      title: "Complete Payment",
      description: "Process payment to confirm your enrollment",
    },
    {
      number: 5,
      title: "Start Learning",
      description: "Access class materials and attend scheduled sessions",
      isLast: true,
    },
  ],
};

const faqItems = [
  {
    question: "What services does our consultancy provide?",
    answer:
      "We offer a range of services including business strategy, market research, and project management.",
  },
  {
    question: "How can our consultancy help your business grow?",
    answer:
      "We provide expert advice and strategies tailored to your business needs, helping you to improve efficiency and increase profits.",
  },
  {
    question: "What industries do we specialize in?",
    answer:
      "Our consultants have experience in a wide range of industries, including technology, healthcare, and finance.",
  },
  {
    question: "How can you get started with our consultancy?",
    answer:
      "Contact us to schedule a consultation. We will discuss your business needs and how our services can help you achieve your goals.",
  },
  {
    question: "What is our consultancy approach to problem-solving?",
    answer:
      "We use a collaborative approach, working closely with your team to understand your business and develop effective solutions.",
  },
];
const DarkBackground = () => {
  return (
    <div className="absolute inset-0 -z-10 overflow-hidden">
      {/* Base dark gradient */}
      <div className="absolute inset-0 bg-gradient-to-b from-black via-gray-950 to-gray-900" />

      {/* Subtle accent gradients - no animation for performance */}
      <div className="absolute top-0 left-1/4 h-[600px] w-[600px] rounded-full bg-teal-500/10 blur-3xl" />
      <div className="absolute top-1/3 right-1/4 h-[500px] w-[500px] rounded-full bg-gray-700/20 blur-3xl" />
      <div className="absolute bottom-1/4 left-1/3 h-[400px] w-[400px] rounded-full bg-gray-800/30 blur-3xl" />
    </div>
  );
};

// Define a custom error type for fetcher
interface FetchError extends Error {
  info?: any; // Keep 'any' for info as it can be diverse, or define a more specific type if known
  status?: number;
}

// Fetcher function for home page APIs (expects API to return { data: [...] })
const fetchHomePageData = async <T = unknown,>(url: string): Promise<T> => {
  const res = await fetch(url);
  if (!res.ok) {
    const error: FetchError = new Error(
      "An error occurred while fetching the data.",
    );
    try {
      error.info = await res.json();
    } catch (_e) {
      // Renamed 'e' to '_e' as it's not used
      error.info = await res.text(); // Fallback if response is not JSON
    }
    error.status = res.status;
    throw error;
  }
  const jsonData = await res.json();
  return jsonData.data as T; // Modify if your API structure is different, ensure type assertion is safe
};

// Specific fetcher for Supabase storage images
const supabaseImagesFetcher = async ([, bucket, path]: [
  string,
  string,
  string,
]): Promise<SupabaseImageFile[]> => {
  // Ensure fetchImagesFromSupabaseStorage is correctly imported and available in this scope
  const imageData = await fetchImagesFromSupabaseStorage(bucket, path);
  return imageData || []; // Default to empty array if null/undefined
};

export default function Home() {
  // React Query hooks for data fetching
  const {
    data: imagesData,
    error: imagesError,
    isLoading: isLoadingImages,
  } = useQuery<SupabaseImageFile[]>({
    queryKey: ["supabase_landing_images", "assets", "images/landing-page"],
    queryFn: ({ queryKey }) =>
      supabaseImagesFetcher(queryKey as [string, string, string]),
    staleTime: 5 * 60 * 1000, // 5 minutes
    gcTime: 10 * 60 * 1000, // 10 minutes
    retry: 2,
  });

  const {
    data: expertsData,
    error: expertsError,
    isLoading: isLoadingExperts,
  } = useQuery<TConsultantProfile[]>({
    queryKey: ["home-experts"],
    queryFn: () =>
      fetchHomePageData<TConsultantProfile[]>("/api/user/consultants?limit=10"),
    staleTime: 2 * 60 * 1000, // 2 minutes
    gcTime: 10 * 60 * 1000, // 10 minutes
    retry: 2,
  });

  const {
    data: reviewsData,
    error: reviewsError,
    isLoading: isLoadingReviews,
  } = useQuery<ReviewWithProfiles[]>({
    queryKey: ["home-reviews"],
    queryFn: () =>
      fetchHomePageData<ReviewWithProfiles[]>("/api/user/reviews?rating=4"),
    staleTime: 5 * 60 * 1000, // 5 minutes
    gcTime: 10 * 60 * 1000, // 10 minutes
    retry: 2,
  });

  // Provide default empty arrays for rendering and downstream logic
  const images: SupabaseImageFile[] = imagesData || [];
  const experts: TConsultantProfile[] = expertsData || [];
  const reviews: ReviewWithProfiles[] = reviewsData || []; // This 'reviews' will be used by displayReviews

  // Combined loading state for initial page load, mimics previous global 'loading'
  // Individual isLoadingImages, isLoadingExperts, isLoadingReviews can be used for per-section skeletons if needed.
  const isLoading = isLoadingImages || isLoadingExperts || isLoadingReviews;

  // Log errors from Fetch. Ensure useEffect is imported from 'react'.
  useEffect(() => {
    if (imagesError)
      console.error("Fetch - Failed to fetch images:", imagesError);
    if (expertsError)
      console.error("Fetch - Failed to fetch experts:", expertsError);
    if (reviewsError)
      console.error("Fetch - Failed to fetch reviews:", reviewsError);
  }, [imagesError, expertsError, reviewsError]);

  // For Testimonials marquee effect (reduced duplication for performance)
  const displayReviews =
    reviews.length >= 4
      ? reviews
      : [...reviews, ...reviews]; // Reduced from 4x to 2x for performance
  const marqueeGroups = Array.from({ length: 2 }, (_, i) => ({
    ltrId: `ltr-group-${i}-${Math.random()}`,
    rtlId: `rtl-group-${i}-${Math.random()}`,
  }));

  return (
    <AnimatePresence>
      <style jsx global key="global-styles">{`
        @keyframes marquee-featured {
          0% {
            transform: translateX(0);
          }
          100% {
            transform: translateX(calc(-100% / 2));
          }
        }
        @keyframes marquee-testimonials-ltr {
          0% {
            transform: translateX(calc(-100% / 3));
          }
          100% {
            transform: translateX(calc(-200% / 3));
          }
        }
        @keyframes marquee-testimonials-rtl {
          0% {
            transform: translateX(calc(-100% / 3));
          }
          100% {
            transform: translateX(0);
          }
        }
        .animation-delay-2000 {
          animation-delay: 2s;
        }
        .animation-delay-3000 {
          animation-delay: 3s;
        }
        .animation-delay-4000 {
          animation-delay: 4s;
        }
        .animation-delay-5000 {
          animation-delay: 5s;
        }
        .animation-delay-6000 {
          animation-delay: 6s;
        }
        @keyframes blob {
          0% {
            transform: scale(1) translate(0px, 0px);
          }
          33% {
            transform: scale(1.1) translate(30px, -50px);
          }
          66% {
            transform: scale(0.9) translate(-20px, 20px);
          }
          100% {
            transform: scale(1) translate(0px, 0px);
          }
        }
        .animate-blob {
          animation: blob 15s infinite ease-in-out;
          will-change: transform;
        }
      `}</style>
      <main key="main-content-wrapper" className="flex-1 w-full relative bg-black">
        <DarkBackground key="dark-background" />

        {/* HeroSection */}
        <section
          key="hero-section"
          className="relative min-h-screen flex items-center justify-center overflow-hidden"
        >
          <div className="container relative z-10 mx-auto px-4 md:px-6 py-32">
            <div className="flex flex-col items-center space-y-8 text-center max-w-4xl mx-auto">
              <h1 className="text-5xl sm:text-6xl md:text-7xl lg:text-8xl font-bold tracking-tighter text-white">
                Launch a Personal Site That Wins Opportunities
              </h1>
              <p className="max-w-[700px] text-xl md:text-2xl text-gray-400">
                Whether you're a designer, developer, or creator, Familiarise helps you stand out with a site that feels professional, and you.
              </p>
              <div className="flex space-x-4 pt-4">
                <Link
                  href="/explore/experts"
                  className="inline-flex h-14 items-center justify-center rounded-lg bg-white px-8 py-4 text-base font-semibold text-black shadow-lg transition-all hover:bg-gray-100 hover:scale-105 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white"
                >
                  Start Building
                </Link>
                <Link
                  href="/explore/programs"
                  className="inline-flex h-14 items-center justify-center rounded-lg bg-gray-800/50 px-8 py-4 text-base font-semibold text-white border border-gray-700 shadow-lg transition-all hover:bg-gray-700/50 hover:scale-105 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white"
                >
                  See Examples
                </Link>
              </div>
            </div>
          </div>
        </section>

        {/* Features / How It Works Section */}
        <section
          key="features-section"
          className="w-full py-24 md:py-32 lg:py-40 bg-black"
        >
          <div className="container mx-auto px-4 md:px-6">
            <div className="text-center mb-16">
              <h2 className="text-4xl sm:text-5xl md:text-6xl font-bold tracking-tight text-white mb-4">
                Notes with an AI assistant
              </h2>
              <p className="max-w-2xl mx-auto text-lg text-gray-400">
                Reflect uses GPT-4 and Whisper from OpenAI to improve your writing, organize your thoughts, and act as your intellectual thought partner.
              </p>
            </div>
            <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-8 max-w-7xl mx-auto">
              {/* Card 1: Create Account */}
              <div className="relative group">
                <div className="h-full bg-gradient-to-br from-gray-900 to-gray-800 border border-gray-700 rounded-2xl p-8 hover:border-teal-500/50 transition-all duration-300">
                  <div className="flex flex-col items-center text-center space-y-4">
                    <div className="w-16 h-16 rounded-full bg-teal-500/10 flex items-center justify-center">
                      <svg className="w-8 h-8 text-teal-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M16 7a4 4 0 11-8 0 4 4 0 018 0zM12 14a7 7 0 00-7 7h14a7 7 0 00-7-7z" />
                      </svg>
                    </div>
                    <h3 className="text-2xl font-semibold text-white">Create your account</h3>
                    <p className="text-gray-400">
                      Sign up easily and secure your profile in just a few steps.
                    </p>
                  </div>
                </div>
              </div>

              {/* Card 2: Browse Experts */}
              <div className="relative group">
                <div className="h-full bg-gradient-to-br from-gray-900 to-gray-800 border border-gray-700 rounded-2xl p-8 hover:border-teal-500/50 transition-all duration-300">
                  <div className="flex flex-col items-center text-center space-y-4">
                    <div className="w-16 h-16 rounded-full bg-teal-500/10 flex items-center justify-center">
                      <svg className="w-8 h-8 text-teal-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z" />
                      </svg>
                    </div>
                    <h3 className="text-2xl font-semibold text-white">Browse experts</h3>
                    <p className="text-gray-400">
                      Explore our curated list of industry professionals and find your perfect mentor.
                    </p>
                  </div>
                </div>
              </div>

              {/* Card 3: Book Session */}
              <div className="relative group">
                <div className="h-full bg-gradient-to-br from-gray-900 to-gray-800 border border-gray-700 rounded-2xl p-8 hover:border-teal-500/50 transition-all duration-300">
                  <div className="flex flex-col items-center text-center space-y-4">
                    <div className="w-16 h-16 rounded-full bg-teal-500/10 flex items-center justify-center">
                      <svg className="w-8 h-8 text-teal-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M8 7V3m8 4V3m-9 8h10M5 21h14a2 2 0 002-2V7a2 2 0 00-2-2H5a2 2 0 00-2 2v12a2 2 0 002 2z" />
                      </svg>
                    </div>
                    <h3 className="text-2xl font-semibold text-white">Start selling or convert</h3>
                    <p className="text-gray-400">
                      Enjoy the simplicity of a platform that makes every transaction seamless.
                    </p>
                  </div>
                </div>
              </div>
            </div>
          </div>
        </section>

        {/* Platform Stats Section */}
        <section
          key="platform-stats-section"
          className="w-full py-24 md:py-32 lg:py-40 bg-gradient-to-b from-black to-gray-950"
        >
          <div className="container mx-auto px-4 md:px-6">
            <div className="text-center mb-16">
              <h2 className="text-4xl sm:text-5xl md:text-6xl font-bold tracking-tight text-white mb-4">
                Token Performance & Market Analytics
              </h2>
              <p className="max-w-2xl mx-auto text-lg text-gray-400">
                Tracking price action, trading volume, liquidity, and volatility to gauge market sentiment and investor behavior.
              </p>
            </div>
            <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-6 max-w-7xl mx-auto">
              {/* Stat 1: Total Experts */}
              <div className="bg-gradient-to-br from-gray-900 to-gray-800 border border-gray-700 rounded-2xl p-8 hover:border-teal-500/50 transition-all duration-300">
                <div className="flex flex-col space-y-2">
                  <div className="flex items-center gap-2">
                    <div className="w-3 h-3 rounded-full bg-teal-400"></div>
                    <p className="text-gray-400 text-sm uppercase tracking-wide">Total Experts</p>
                  </div>
                  <p className="text-5xl font-bold text-teal-400">6M+</p>
                  <p className="text-gray-500 text-sm">Market Cap</p>
                </div>
              </div>

              {/* Stat 2: Sessions Completed */}
              <div className="bg-gradient-to-br from-gray-900 to-gray-800 border border-gray-700 rounded-2xl p-8 hover:border-teal-500/50 transition-all duration-300">
                <div className="flex flex-col space-y-2">
                  <div className="flex items-center gap-2">
                    <div className="w-3 h-3 rounded-full bg-purple-400"></div>
                    <p className="text-gray-400 text-sm uppercase tracking-wide">Sessions Complete</p>
                  </div>
                  <p className="text-5xl font-bold text-purple-400">2M+</p>
                  <p className="text-gray-500 text-sm">Burned Tokens</p>
                </div>
              </div>

              {/* Stat 3: Average Rating */}
              <div className="bg-gradient-to-br from-gray-900 to-gray-800 border border-gray-700 rounded-2xl p-8 hover:border-teal-500/50 transition-all duration-300">
                <div className="flex flex-col space-y-2">
                  <div className="flex items-center gap-2">
                    <div className="w-3 h-3 rounded-full bg-yellow-400"></div>
                    <p className="text-gray-400 text-sm uppercase tracking-wide">Average Rating</p>
                  </div>
                  <p className="text-5xl font-bold text-yellow-400">4.8</p>
                  <p className="text-gray-500 text-sm">out of 5.0</p>
                </div>
              </div>

              {/* Stat 4: Active Students */}
              <div className="bg-gradient-to-br from-gray-900 to-gray-800 border border-gray-700 rounded-2xl p-8 hover:border-teal-500/50 transition-all duration-300">
                <div className="flex flex-col space-y-2">
                  <div className="flex items-center gap-2">
                    <div className="w-3 h-3 rounded-full bg-blue-400"></div>
                    <p className="text-gray-400 text-sm uppercase tracking-wide">Active Students</p>
                  </div>
                  <p className="text-5xl font-bold text-blue-400">$1.89K</p>
                  <p className="text-gray-500 text-sm">Total Revenue</p>
                </div>
              </div>
            </div>
          </div>
        </section>

        {/* BestExpertsSection */}
        <section
          key="best-experts-section"
          className="w-full py-16 md:py-24 lg:py-32 bg-black"
        >
          <div className="container mx-auto px-4 md:px-6">
            <div className="flex flex-col md:flex-row items-center justify-between gap-8 max-w-6xl mx-auto">
              <div className="flex-1">
                <h2 className="text-4xl sm:text-5xl md:text-6xl font-bold tracking-tight text-white mb-4">
                  The Best Experts in the World
                </h2>
                <p className="text-lg text-gray-400 mb-6">
                  Explore our wide range of consultants and find the right one for your business.
                </p>
                <Link
                  href="/explore/experts"
                  className="inline-flex h-12 items-center justify-center rounded-lg bg-white px-6 py-3 text-sm font-semibold text-black shadow-lg transition-all hover:bg-gray-100 hover:scale-105 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white"
                >
                  Browse All Experts
                </Link>
              </div>
            </div>
          </div>
        </section>

        {/* FeaturedExpertsSection */}
        <section
          key="featured-experts-section"
          className="w-full py-12 md:py-24 lg:py-32 bg-gradient-to-b from-gray-950 to-black"
        >
          <div className="container mx-auto px-4 md:px-6 mb-12">
            <div className="text-center">
              <h2 className="text-3xl sm:text-4xl md:text-5xl lg:text-6xl font-bold tracking-tighter text-white">
                Meet our Featured Experts
              </h2>
              <p className="mt-4 mx-auto max-w-[700px] text-gray-400 md:text-xl">
                We have a diverse team of experts ready to share their knowledge
                and expertise with you.
              </p>
              <Link href="/explore/experts">
                <Button className="mt-8 bg-white text-black hover:bg-gray-100 hover:scale-105 transition-all duration-300 shadow-lg">
                  View All Experts
                </Button>
              </Link>
            </div>
          </div>
          <div
            className="w-full overflow-hidden"
            style={pageStyles["featured-marquee-container"]}
          >
            <div style={pageStyles["featured-marquee-track"]}>
              {isLoading
                ? Array.from({ length: 10 }, (_, index) => (
                    <ExpertLoadingSkeleton key={`skeleton-expert-${index}`} />
                  ))
                : (() => {
                    if (experts.length > 0) {
                      return (
                        <>
                          {/* Render 2 sets for marquee effect (reduced from 4 for performance) */}
                          {Array.from({ length: 2 }).flatMap(
                            (_, marqueeSetIndex) =>
                              experts.map((expert) => (
                                <ExpertCard
                                  key={`${expert.id}-marquee-${marqueeSetIndex + 1}`}
                                  expert={expert}
                                />
                              )),
                          )}
                        </>
                      );
                    } else {
                      return (
                        <p className="text-center text-gray-500">
                          No featured experts available at the moment.
                        </p>
                      );
                    }
                  })()}
            </div>
          </div>
        </section>

        {/* OfferingsSection */}
        <section key="offerings-section" className="py-24 md:py-32 bg-black">
          <div className="container mx-auto px-4 md:px-6">
            <h2 className="text-3xl sm:text-4xl md:text-5xl font-bold text-center mb-16 text-white">
              Check out our various offerings
            </h2>
            <div className="grid gap-6 md:grid-cols-2 lg:grid-cols-4 max-w-7xl mx-auto">
              {OFFERINGS.map((offering) => (
                <div
                  key={offering.title}
                  className="bg-gradient-to-br from-gray-900 to-gray-800 border border-gray-700 rounded-2xl p-6 hover:border-teal-500/50 transition-all duration-300 hover:-translate-y-1"
                >
                  <h3 className="text-xl font-semibold mb-3 text-white">
                    {offering.title}
                  </h3>
                  <p className="text-gray-400 text-sm">{offering.description}</p>
                </div>
              ))}
            </div>
          </div>
        </section>

        {/* TestimonialsSection */}
        <section
          key="testimonials-section"
          className="py-24 md:py-32 overflow-hidden relative bg-gradient-to-b from-black to-gray-950"
        >
          <div
            className="absolute inset-0 opacity-5"
            style={{
              backgroundImage: `radial-gradient(circle at 1px 1px, rgb(255 255 255 / 0.1) 1px, transparent 0)`,
              backgroundSize: "40px 40px",
            }}
          />
          <div className="container mx-auto px-4 relative">
            <h2 className="text-4xl sm:text-5xl font-bold text-center mb-16 text-white">
              What Our Users Say
            </h2>
          </div>
          {isLoading && reviews.length === 0 ? (
            <TestimonialLoadingSkeleton />
          ) : (
            <div className="space-y-12">
              <div className="relative py-4">
                <div style={pageStyles["testimonials-marqueeContainer"]}>
                  <div style={pageStyles["testimonials-marquee-track-ltr"]}>
                    {marqueeGroups.map((group) => (
                      <div key={group.ltrId} className="flex">
                        {displayReviews.map((review) => (
                          <ReviewCard
                            key={`${review.id}-${group.ltrId}`}
                            review={review}
                          />
                        ))}
                      </div>
                    ))}
                  </div>
                </div>
              </div>
              <div className="relative py-4">
                <div style={pageStyles["testimonials-marqueeContainer"]}>
                  <div style={pageStyles["testimonials-marquee-track-rtl"]}>
                    {marqueeGroups.map((group) => (
                      <div key={group.rtlId} className="flex">
                        {displayReviews.map((review) => (
                          <ReviewCard
                            key={`${review.id}-${group.rtlId}`}
                            review={review}
                          />
                        ))}
                      </div>
                    ))}
                  </div>
                </div>
              </div>
            </div>
          )}
        </section>

        {/* HowProcessWorksSection */}
        <section key="how-process-works-section" className="py-24 md:py-32 bg-black">
          <div className="container mx-auto px-4 md:px-6">
            <motion.div
              className="text-center mb-16"
              initial={{ opacity: 0, y: 20 }}
              whileInView={{ opacity: 1, y: 0 }}
              transition={{ duration: 0.5 }}
            >
              <h2 className="text-4xl sm:text-5xl font-bold mb-4 text-white">How The Process Works</h2>
              <p className="text-gray-400 max-w-2xl mx-auto text-lg">
                Choose from our various learning formats and follow these simple
                steps to start your journey
              </p>
            </motion.div>
            <div className="bg-gradient-to-br from-gray-900 to-gray-800 border border-gray-700 rounded-2xl p-8 shadow-lg max-w-5xl mx-auto">
            <Tabs defaultValue="consultation" className="w-full">
              <TabsList className="grid w-full grid-cols-2 lg:grid-cols-4 p-1 mb-2">
                <TabsTrigger value="consultation">Consultation</TabsTrigger>
                <TabsTrigger value="subscription">Subscription</TabsTrigger>
                <TabsTrigger value="webinar">Webinar</TabsTrigger>
                <TabsTrigger value="class">Class</TabsTrigger>
              </TabsList>
              <div className="mt-8">
                <Suspense fallback={<div>Loading process flows...</div>}>
                  {Object.entries(flowData).map(([flowType, steps]) => (
                    <TabsContent key={flowType} value={flowType}>
                      <div className="space-y-6">
                        {steps.map((step) => (
                          <ProcessFlowDisplay key={step.number} {...step} />
                        ))}
                      </div>
                    </TabsContent>
                  ))}
                </Suspense>
              </div>
            </Tabs>
            </div>
          </div>
        </section>

        {/* JoinCommunitySection */}
        <section
          key="join-community-section"
          className="w-full py-24 md:py-32 bg-gradient-to-b from-black to-gray-950"
        >
          <div className="container mx-auto px-4 md:px-6 text-center">
            <h2 className="text-4xl sm:text-5xl md:text-6xl font-bold tracking-tighter mb-6 text-white">
              Join our Community of Experts
            </h2>
            <p className="text-lg text-gray-400 md:text-xl max-w-[600px] mx-auto mb-8">
              Share your expertise with people who need it and grow your
              personal brand.
            </p>
            <Button className="w-full sm:w-auto bg-white text-black hover:bg-gray-100 hover:scale-105 transition-all duration-300 shadow-lg h-12 px-8">
              Become an Expert
            </Button>
          </div>
        </section>

        {/* Faq */}
        <section className="flex justify-center items-center py-24 md:py-32 bg-black">
          <div className="container mx-auto px-4 md:px-6">
            <div className="bg-gradient-to-br from-gray-900 to-gray-800 border border-gray-700 rounded-2xl shadow-lg w-full max-w-4xl mx-auto p-8">
              <h2 className="text-3xl sm:text-4xl font-semibold mb-6 text-white">
                Frequently Asked Questions
              </h2>
              <Accordion
                className="w-full mt-4"
                type="multiple"
                defaultValue={[]}
              >
                {faqItems.map((item, index) => (
                  <AccordionItem
                    key={`item-${index + 1}`}
                    value={`item-${index + 1}`}
                  >
                    <AccordionTrigger className="w-full text-left text-white hover:text-teal-400 transition-colors">
                      <span className="flex-1">{item.question}</span>
                    </AccordionTrigger>
                    <AccordionContent>
                      <p className="text-sm text-gray-400">{item.answer}</p>
                    </AccordionContent>
                  </AccordionItem>
                ))}
              </Accordion>
            </div>
          </div>
        </section>

        {/* Newsletter */}
        <section className="w-full py-8 md:py-16 lg:py-24 xl:py-40 bg-black">
          <div className="px-4 md:px-6">
            <div className="grid gap-6 items-center">
              <div className="flex flex-col justify-center space-y-4 text-center">
                <div className="space-y-2">
                  <h1 className="text-3xl font-bold tracking-tighter sm:text-5xl xl:text-6xl/none bg-clip-text text-transparent bg-gradient-to-r from-white to-gray-500">
                    Revolutionize Your Email Experience
                  </h1>
                  <p className="max-w-[600px] text-zinc-200 md:text-xl dark:text-zinc-100 mx-auto">
                    Join us and take control of your inbox. Fast, secure, and
                    designed for modern life.
                  </p>
                </div>
                <div className="w-full max-w-sm space-y-2 mx-auto">
                  <form className="flex space-x-2">
                    <Input
                      className="max-w-lg flex-1 bg-gray-800 text-white border-gray-900"
                      placeholder="Enter your email"
                      type="email"
                    />
                    <Button className="bg-white text-black" type="submit">
                      Join Now
                    </Button>
                  </form>
                  <p className="text-xs text-zinc-200 dark:text-zinc-100">
                    Get ready to redefine your email experience.{" "}
                    <Link
                      className="underline underline-offset-2 text-white"
                      href="#"
                    >
                      Terms & Conditions
                    </Link>
                  </p>
                </div>
              </div>
            </div>
          </div>
        </section>
      </main>
    </AnimatePresence>
  );
}
