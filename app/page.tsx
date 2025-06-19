"use client";

import useSWR from "swr";
import { AnimatePresence, motion } from "framer-motion";
import Link from "next/link";
import { Suspense, useEffect } from "react";

import {
  Accordion,
  AccordionContent,
  AccordionItem,
  AccordionTrigger,
} from "@/components/ui/accordion";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";

import { ProcessFlowDisplay } from "@/components/home/flows/ProcessFlowDisplay";
import { OFFERINGS } from "@/constants/homePageData";
import type { SupabaseImageFile } from "@/lib/supabase";
import { fetchImagesFromSupabaseStorage } from "@/lib/supabase";
import { renderLCPImage } from "@/utils/image";

import BlurryBackground from "@/components/home/BlurryBackground";
import ExpertCard from "@/components/home/components/ExpertCard";
import ReviewCard from "@/components/home/components/ReviewCard";
import {
  ExpertLoadingSkeleton,
  TestimonialLoadingSkeleton,
} from "@/components/home/components/LoadingSkeletons";
import OptimizedMarquee from "@/components/home/components/OptimizedMarquee";
import {
  useOptimizedReviews,
  useMarqueeGroups,
  consultantsFetcher,
  reviewsFetcher,
} from "@/components/home/components/hooks";
import { swrOptions, flowData, faqItems } from "@/components/home/constants";

import type { TConsultantProfile } from "@/types/consultant";
import type { ReviewWithProfiles } from "@/types/review";

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
  // SWR hooks for data fetching
  const {
    data: imagesData,
    error: imagesError,
    isLoading: isLoadingImages,
  } = useSWR<SupabaseImageFile[]>(
    ["supabase_landing_images", "assets", "images/landing-page"],
    supabaseImagesFetcher,
    swrOptions,
  );

  const {
    data: expertsData,
    error: expertsError,
    isLoading: isLoadingExperts,
  } = useSWR<TConsultantProfile[]>(
    "/api/user/consultants?limit=10",
    consultantsFetcher,
    swrOptions,
  );

  const {
    data: reviewsData,
    error: reviewsError,
    isLoading: isLoadingReviews,
  } = useSWR<ReviewWithProfiles[]>(
    "/api/user/reviews?rating=4",
    reviewsFetcher,
    swrOptions,
  );

  // Provide default empty arrays for rendering and downstream logic
  const images: SupabaseImageFile[] = imagesData || [];
  const experts: TConsultantProfile[] = expertsData || [];
  const reviews: ReviewWithProfiles[] = reviewsData || []; // This 'reviews' will be used by displayReviews

  // Combined loading state for initial page load, mimics previous global 'loading'
  // Individual isLoadingImages, isLoadingExperts, isLoadingReviews can be used for per-section skeletons if needed.
  const isLoading = isLoadingImages || isLoadingExperts || isLoadingReviews;

  // Log errors from SWR. Ensure useEffect is imported from 'react'.
  useEffect(() => {
    if (imagesError)
      console.error("SWR - Failed to fetch images:", imagesError);
    if (expertsError)
      console.error("SWR - Failed to fetch experts:", expertsError);
    if (reviewsError)
      console.error("SWR - Failed to fetch reviews:", reviewsError);
  }, [imagesError, expertsError, reviewsError]);

  const displayReviews = useOptimizedReviews(reviews);
  const marqueeGroups = useMarqueeGroups();

  return (
    <AnimatePresence>
      <main key="main-content-wrapper" className="flex-1 w-full relative">
        <BlurryBackground key="blurry-background" />

        {/* HeroSection */}
        <section
          key="hero-section"
          className="relative py-12 md:py-24 lg:py-32 xl:py-40 overflow-hidden"
        >
          <div className="absolute bottom-0 left-0 w-full h-24 bg-gradient-to-t from-white to-transparent"></div>
          <div className="container relative z-10 mx-auto px-4 md:px-6">
            <div className="flex flex-col items-center space-y-6 text-center mb-10">
              <div className="flex space-x-2 mb-2">
                <div className="inline-flex items-center rounded-full px-3 py-1 text-sm bg-amber-100 text-amber-800 border border-amber-200">
                  <span className="mr-1">🏆</span> Project of the week
                </div>
                <div className="inline-flex items-center rounded-full px-3 py-1 text-sm bg-rose-100 text-rose-800 border border-rose-200">
                  <span className="mr-1">🥇</span> #2 Product of the Day
                </div>
              </div>
              <h1 className="text-4xl sm:text-5xl md:text-6xl lg:text-7xl font-bold tracking-tighter text-gray-900">
                Elevate Your Career with Familiarise
              </h1>
              <p className="max-w-[700px] text-xl md:text-2xl text-gray-800">
                A platform where experts share their advice through 1-1
                sessions, classes, webinars, and conferences.
              </p>
              <div className="flex space-x-4">
                <Link
                  href="/explore/experts"
                  className="inline-flex h-12 items-center justify-center rounded-md bg-gray-900 px-6 py-3 text-sm font-medium text-white shadow transition-colors hover:bg-gray-800 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-gray-950"
                >
                  <span className="mr-2">Get Started</span>
                  <svg
                    width="16"
                    height="16"
                    viewBox="0 0 16 16"
                    fill="none"
                    xmlns="http://www.w3.org/2000/svg"
                  >
                    <path
                      d="M6 12L10 8L6 4"
                      stroke="currentColor"
                      strokeWidth="2"
                      strokeLinecap="round"
                      strokeLinejoin="round"
                    />
                  </svg>
                </Link>
              </div>
            </div>
            <div className="relative max-w-5xl mx-auto rounded-xl overflow-hidden shadow-2xl border border-gray-200 bg-white">
              <div className="relative w-full aspect-[16/9]">
                {renderLCPImage(images, 0, "/placeholder.svg", 1920, 1080)}
              </div>
            </div>
          </div>
        </section>

        {/* TransformCareerSection */}
        <section
          key="transform-career-section"
          className="w-full py-16 md:py-24 lg:py-32"
        >
          <div className="container mx-auto px-4 md:px-6">
            <div className="grid items-center gap-12 lg:grid-cols-2">
              <div className="flex flex-col justify-center space-y-6">
                <h2 className="text-3xl sm:text-4xl md:text-5xl font-bold tracking-tighter">
                  Transform Your Career with Expert Guidance
                </h2>
                <ul className="space-y-4 text-lg text-gray-600 md:text-xl">
                  <li>
                    <span className="font-semibold">
                      ✓ Accelerate Your Growth:
                    </span>{" "}
                    Gain years of industry insights in just hours through our
                    1-1 sessions.
                  </li>
                  <li>
                    <span className="font-semibold">
                      ✓ Expand Your Network:
                    </span>{" "}
                    Connect with industry leaders and peers in our exclusive
                    classes and webinars.
                  </li>
                  <li>
                    <span className="font-semibold">
                      ✓ Stay Ahead of the Curve:
                    </span>{" "}
                    Access cutting-edge knowledge and trends through our
                    conferences.
                  </li>
                </ul>
                <Link
                  href="#"
                  className="inline-flex w-full sm:w-auto items-center justify-center rounded-md bg-gray-900 px-6 py-3 text-sm font-medium text-white shadow transition-colors hover:bg-gray-800 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-gray-950"
                >
                  Start Your Journey
                </Link>
              </div>
              <div className="flex justify-center">
                {renderLCPImage(images, 1, "/placeholder.svg", 550, 310)}
              </div>
            </div>
          </div>
        </section>

        {/* UnlockPotentialSection */}
        <section
          key="unlock-potential-section"
          className="w-full py-16 md:py-24 lg:py-32"
        >
          <div className="container mx-auto px-4 md:px-6">
            <div className="flex flex-col items-center justify-center space-y-6 text-center">
              <h2 className="text-3xl sm:text-4xl md:text-5xl font-bold tracking-tighter">
                Unlock Your Full Potential
              </h2>
              <p className="max-w-[900px] text-lg text-gray-600 md:text-xl">
                Experience transformative growth with our comprehensive
                mentorship program.
              </p>
            </div>
            <div className="grid lg:grid-cols-2 gap-12 mt-12">
              <div className="flex flex-col justify-center space-y-6">
                <ul className="space-y-6">
                  <li>
                    <h3 className="text-xl font-bold">
                      Tailored Career Acceleration
                    </h3>
                    <p className="text-gray-600">
                      Receive a personalized roadmap to fast-track your career
                      goals, designed by industry experts who've walked the
                      path.
                    </p>
                  </li>
                  <li>
                    <h3 className="text-xl font-bold">
                      Insider Knowledge & Strategies
                    </h3>
                    <p className="text-gray-600">
                      Gain exclusive insights and proven strategies to navigate
                      complex career challenges and seize hidden opportunities.
                    </p>
                  </li>
                  <li>
                    <h3 className="text-xl font-bold">
                      Confidence & Skill Mastery
                    </h3>
                    <p className="text-gray-600">
                      Develop unshakeable confidence and master critical skills
                      through hands-on guidance and real-world application.
                    </p>
                  </li>
                </ul>
              </div>
              <div className="flex justify-center items-center">
                {renderLCPImage(images, 2, "/placeholder.svg", 550, 310)}
              </div>
            </div>
          </div>
        </section>

        {/* BestExpertsSection */}
        <section
          key="best-experts-section"
          className="w-full pt-6 md:pt-12 lg:pt-16 xl:pt-20"
        >
          <div className="px-4 md:px-6 space-y-10 xl:space-y-16">
            <div className="grid max-w-[1300px] mx-auto gap-4 px-4 sm:px-6 md:px-10 md:grid-cols-2 md:gap-16">
              <div>
                <h1 className="lg:leading-tighter text-3xl font-bold tracking-tighter sm:text-4xl md:text-5xl xl:text-[3.4rem] 2xl:text-[3.75rem]">
                  The Best Experts in the World
                </h1>
              </div>
              <div className="flex flex-col items-start space-y-4">
                <p className="mx-auto max-w-[700px] text-gray-500 md:text-xl dark:text-gray-400">
                  Explore our wide range of consultants and find the right one
                  for your business.
                </p>
                <div className="space-x-4">
                  <Link
                    href="#"
                    className="inline-flex h-9 items-center justify-center rounded-md bg-gray-900 px-4 py-2 text-sm font-medium text-gray-50 shadow transition-colors hover:bg-gray-900/90 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-gray-950 disabled:pointer-events-none disabled:opacity-55 dark:bg-gray-50 dark:text-gray-900 dark:hover:bg-gray-50/90 dark:focus-visible:ring-gray-300"
                  >
                    Get Started
                  </Link>
                </div>
              </div>
            </div>
            <div className="w-full max-w-[1600px] mx-auto overflow-hidden">
              {renderLCPImage(images, 3, "/placeholder.svg", 1300, 867)}
            </div>
          </div>
        </section>

        {/* FeaturedExpertsSection */}
        <section
          key="featured-experts-section"
          className="w-full py-12 md:py-24 lg:py-32"
        >
          <div className="container mx-auto px-4 md:px-6 mb-12">
            <div className="text-center">
              <h2 className="text-3xl sm:text-4xl md:text-5xl lg:text-6xl font-bold tracking-tighter">
                Meet our Featured Experts
              </h2>
              <p className="mt-4 mx-auto max-w-[700px] text-gray-500 md:text-xl">
                We have a diverse team of experts ready to share their knowledge
                and expertise with you.
              </p>
              <Link href="/explore/experts">
                <Button className="mt-8 dark:bg-gray-800 text-white hover:bg-gray-700 transition-colors duration-300">
                  View All Experts
                </Button>
              </Link>
            </div>
          </div>
          <OptimizedMarquee type="featured">
            {(() => {
              if (isLoading) {
                return Array.from({ length: 10 }, (_, index) => (
                  <ExpertLoadingSkeleton key={`skeleton-expert-${index}`} />
                ));
              }

              if (experts.length > 0) {
                return Array.from({ length: 4 }).flatMap((_, marqueeSetIndex) =>
                  experts.map((expert) => (
                    <ExpertCard
                      key={`${expert.id}-marquee-${marqueeSetIndex + 1}`}
                      expert={expert}
                    />
                  )),
                );
              }

              return (
                <p className="text-center text-gray-500">
                  No featured experts available at the moment.
                </p>
              );
            })()}
          </OptimizedMarquee>
        </section>

        {/* OfferingsSection */}
        <section key="offerings-section" className="py-16">
          <h2 className="text-3xl sm:text-4xl md:text-5xl font-bold text-center mb-12">
            Check out our various offerings
          </h2>
          <div className="grid gap-8 md:grid-cols-2 lg:grid-cols-4">
            {OFFERINGS.map((offering) => (
              <Card
                key={offering.title}
                className="rounded-lg shadow-md transition-transform duration-300 hover:-translate-y-2"
              >
                <CardHeader className="text-xl font-semibold">
                  {offering.title}
                </CardHeader>
                <CardContent>
                  <p className="text-gray-600">{offering.description}</p>
                </CardContent>
              </Card>
            ))}
          </div>
        </section>

        {/* TestimonialsSection */}
        <section
          key="testimonials-section"
          className="py-16 overflow-hidden relative"
        >
          <div
            className="absolute inset-0 opacity-50"
            style={{
              backgroundImage: `radial-gradient(circle at 1px 1px, rgb(0 0 0 / 0.05) 1px, transparent 0)`,
              backgroundSize: "40px 40px",
            }}
          />
          <div className="container mx-auto px-4 relative">
            <h2 className="text-3xl font-bold text-center mb-16">
              What Our Users Say
            </h2>
          </div>
          {isLoading && reviews.length === 0 ? (
            <TestimonialLoadingSkeleton />
          ) : (
            <div className="space-y-12">
              <div className="relative py-4">
                <OptimizedMarquee type="testimonials" direction="ltr">
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
                </OptimizedMarquee>
              </div>
              <div className="relative py-4">
                <OptimizedMarquee type="testimonials" direction="rtl">
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
                </OptimizedMarquee>
              </div>
            </div>
          )}
        </section>

        {/* HowProcessWorksSection */}
        <section key="how-process-works-section" className="py-20">
          <motion.div
            className="text-center mb-16"
            initial={{ opacity: 0, y: 20 }}
            whileInView={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.5 }}
          >
            <h2 className="text-3xl font-bold mb-4">How The Process Works</h2>
            <p className="text-muted-foreground max-w-2xl mx-auto">
              Choose from our various learning formats and follow these simple
              steps to start your journey
            </p>
          </motion.div>
          <Card className="p-8 shadow-lg border-t-2 border-t-primary/50 max-w-5xl mx-auto">
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
          </Card>
        </section>

        {/* JoinCommunitySection */}
        <section
          key="join-community-section"
          className="w-full py-16 md:py-24 lg:py-32"
        >
          <div className="container mx-auto px-4 md:px-6 text-center">
            <h2 className="text-3xl sm:text-4xl md:text-5xl font-bold tracking-tighter mb-4">
              Join our Community of Experts
            </h2>
            <p className="text-lg text-gray-600 md:text-xl max-w-[600px] mx-auto mb-8">
              Share your expertise with people who need it and grow your
              personal brand.
            </p>
            <Button className="w-full sm:w-auto bg-gray-900 text-white hover:bg-gray-800">
              Become an Expert
            </Button>
          </div>
        </section>

        {/* Faq */}
        <section className="flex justify-center items-center py-10">
          <Card className="shadow-lg w-full max-w-4xl mx-auto">
            <CardContent className="p-6">
              <h2 className="text-2xl font-semibold">
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
                    <AccordionTrigger className="w-full text-left">
                      <span className="flex-1">{item.question}</span>
                    </AccordionTrigger>
                    <AccordionContent>
                      <p className="text-sm text-gray-600">{item.answer}</p>
                    </AccordionContent>
                  </AccordionItem>
                ))}
              </Accordion>
            </CardContent>
          </Card>
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
