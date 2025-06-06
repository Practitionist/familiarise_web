"use client";

import useSWR from "swr";

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
    <Card className="w-[300px] flex-shrink-0 mx-3 bg-white hover:shadow-lg transition-all duration-300 hover:-translate-y-1 hover:scale-[1.02] border border-gray-100">
      <CardContent className="p-5">
        <div className="flex items-start gap-3">
          <Avatar className="h-10 w-10 border border-gray-100">
            {review.consulteeProfile?.user?.image ? (
              <AvatarImage
                src={review.consulteeProfile.user.image}
                alt={review.consulteeProfile.user.name || "Reviewer"}
              />
            ) : (
              <AvatarFallback>
                <User className="h-5 w-5" />
              </AvatarFallback>
            )}
          </Avatar>
          <div className="flex-1 min-w-0">
            <div className="flex justify-between items-start gap-2">
              <div className="min-w-0">
                <h4 className="font-semibold truncate">
                  {review.consulteeProfile?.user?.name || "Anonymous"}
                </h4>
                <p className="text-sm text-gray-500 truncate">
                  Review for {review.consultantProfile?.user?.name}
                </p>
              </div>
              <div className="flex items-center flex-shrink-0">
                {stars.map((star) => (
                  <Star
                    key={star.id}
                    className={`w-3 h-3 ${star.filled ? "text-yellow-400 fill-yellow-400" : "text-gray-300"}`}
                  />
                ))}
              </div>
            </div>
            <p className="mt-3 text-gray-700 text-sm line-clamp-3">
              {review.reviewDescription || "No review description provided"}
            </p>
          </div>
        </div>
      </CardContent>
    </Card>
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
const BlurryBackground = () => {
  return (
    <div className="absolute inset-0 -z-10 overflow-hidden bg-transparent">
      {/* === HERO SECTION === */}
      <div className="absolute -top-32 -left-48 h-[400px] w-[400px] rounded-full bg-gradient-to-br from-pink-500 to-purple-600 opacity-50 blur-3xl animate-blob animation-delay-1000"></div>
      <div className="absolute -top-32 -right-48 h-[400px] w-[400px] rounded-full bg-gradient-to-bl from-teal-400 to-blue-500 opacity-50 blur-3xl animate-blob animation-delay-3000"></div>
      <div className="absolute -top-40 left-1/2 h-[450px] w-[450px] -translate-x-1/3 rounded-full bg-gradient-to-b from-cyan-400 to-indigo-500 opacity-50 blur-3xl animate-blob animation-delay-2500"></div>
      <div className="absolute top-1/6 left-1/4 h-[500px] w-[500px] -translate-x-1/2 rounded-full bg-gradient-to-tr from-[#ff5ca0] to-[#7b73fc] opacity-45 blur-3xl animate-blob animation-delay-2000"></div>
      <div className="absolute top-1/6 right-1/4 h-[450px] w-[450px] translate-x-1/2 rounded-full bg-gradient-to-tl from-amber-400 to-orange-500 opacity-45 blur-3xl animate-blob animation-delay-4000"></div>
      <div className="absolute top-[20%] left-1/6 h-[500px] w-[800px] rounded-full bg-gradient-to-t from-emerald-400 to-teal-500 opacity-45 blur-3xl animate-blob animation-delay-5000"></div>
      <div className="absolute top-[25%] right-1/6 h-[500px] w-[800px] rounded-full bg-gradient-to-t from-rose-400 to-pink-500 opacity-45 blur-3xl animate-blob animation-delay-6000"></div>
      <div className="absolute top-[32%] left-1/5 h-[500px] w-[800px] rounded-full bg-gradient-to-t from-emerald-400 to-teal-500 opacity-45 blur-3xl animate-blob animation-delay-5000"></div>
      <div className="absolute top-[37%] right-1/5 h-[500px] w-[800px] rounded-full bg-gradient-to-t from-rose-400 to-pink-500 opacity-45 blur-3xl animate-blob animation-delay-6000"></div>
      <div className="absolute top-[42%] left-1/4 h-[500px] w-[800px] rounded-full bg-gradient-to-t from-emerald-400 to-teal-500 opacity-45 blur-3xl animate-blob animation-delay-5000"></div>
      <div className="absolute top-[36%] -left-48 h-[500px] w-[500px] rounded-full bg-gradient-to-tr from-violet-200 to-purple-300 opacity-45 blur-3xl animate-blob animation-delay-1500"></div>
      <div className="absolute top-[36%] -right-48 h-[500px] w-[500px] rounded-full bg-gradient-to-tl from-sky-200 to-blue-300 opacity-45 blur-3xl animate-blob animation-delay-3500"></div>
      <div className="absolute top-[48%] left-1/6 h-[500px] w-[800px] rounded-full bg-gradient-to-t from-emerald-200 to-teal-300 opacity-45 blur-3xl animate-blob animation-delay-5000"></div>
      <div className="absolute top-[48%] right-1/6 h-[500px] w-[800px] rounded-full bg-gradient-to-t from-rose-200 to-pink-300 opacity-45 blur-3xl animate-blob animation-delay-6000"></div>

      {/* === TRANSFORM YOUR CAREER SECTION === */}
      <div className="absolute top-[55%] -left-12 h-[300px] w-[300px] rounded-full bg-gradient-to-r from-green-200 to-cyan-300 opacity-55 blur-3xl animate-blob animation-delay-500"></div>
      <div className="absolute top-[55%] -right-12 h-[300px] w-[300px] rounded-full bg-gradient-to-l from-blue-200 to-green-300 opacity-55 blur-3xl animate-blob animation-delay-3200"></div>
      <div className="absolute top-[60%] -left-24 h-[300px] w-[300px] -translate-y-1/2 rounded-full bg-gradient-to-r from-cyan-200 to-sky-300 opacity-50 blur-3xl animate-blob animation-delay-4800"></div>
      <div className="absolute top-[65%] left-1/3 h-[700px] w-[700px] -translate-x-1/2 -translate-y-1/2 rounded-full bg-gradient-to-r from-purple-200 to-pink-300 opacity-45 blur-3xl animate-blob animation-delay-7000"></div>
      <div className="absolute top-[57%] left-[15%] h-[350px] w-[350px] rounded-full bg-gradient-to-br from-emerald-200 to-green-400 opacity-50 blur-3xl animate-blob animation-delay-6000"></div>
      <div className="absolute top-[61%] right-[20%] h-[250px] w-[250px] rounded-full bg-gradient-to-tl from-rose-200 to-red-300 opacity-45 blur-3xl animate-blob animation-delay-7500"></div>

      {/* === UNLOCK POTENTIAL SECTION === */}
      <div className="absolute top-[72%] -left-56 h-[350px] w-[350px] rounded-full bg-gradient-to-r from-sky-400 to-indigo-500 opacity-50 blur-3xl animate-blob animation-delay-1500"></div>
      <div className="absolute top-[78%] -right-56 h-[350px] w-[350px] rounded-full bg-gradient-to-l from-rose-400 to-fuchsia-500 opacity-50 blur-3xl animate-blob animation-delay-3500"></div>
      <div className="absolute top-[75%] left-1/2 h-[300px] w-[300px] -translate-x-1/4 -translate-y-1/4 rounded-full bg-gradient-to-tr from-yellow-300 to-orange-400 opacity-55 blur-3xl animate-blob animation-delay-8000"></div>
      <div className="absolute top-[74%] left-[10%] h-[400px] w-[400px] rounded-full bg-gradient-to-bl from-cyan-300 to-sky-500 opacity-45 blur-3xl animate-blob animation-delay-5500"></div>
      <div className="absolute top-[77%] right-[5%] h-[300px] w-[300px] rounded-full bg-gradient-to-tr from-pink-300 to-purple-400 opacity-50 blur-3xl animate-blob animation-delay-9000"></div>

      {/* === BEST EXPERTS SECTION === */}
      <div className="absolute top-2/3 -right-48 h-[300px] w-[300px] -translate-y-1/2 rounded-full bg-gradient-to-l from-pink-300 to-orange-300 opacity-50 blur-3xl animate-blob animation-delay-2200"></div>
      <div className="absolute top-2/3 left-1/4 h-[500px] w-[500px] -translate-x-1/2 rounded-full bg-gradient-to-br from-purple-300 to-pink-400 opacity-50 blur-3xl animate-blob animation-delay-9500"></div>

      {/* === FEATURED EXPERTS SECTION === */}
      <div className="absolute top-3/4 right-1/4 h-[450px] w-[450px] translate-x-1/2 rounded-full bg-gradient-to-tl from-orange-300 to-yellow-400 opacity-50 blur-3xl animate-blob animation-delay-10000"></div>
      <div className="absolute top-3/5 -right-32 h-[400px] w-[400px] rounded-full bg-gradient-to-l from-red-200 to-rose-300 opacity-50 blur-3xl animate-blob animation-delay-11000"></div>

      {/* === OFFERINGS SECTION === */}
      <div className="absolute bottom-1/3 left-1/2 -translate-x-1/2 h-[350px] w-[350px] rounded-full bg-gradient-to-t from-cyan-200 to-blue-300 opacity-50 blur-3xl animate-blob animation-delay-5500"></div>
      <div className="absolute bottom-1/3 left-1/2 -translate-x-1/3 h-[600px] w-[600px] rounded-full bg-gradient-to-t from-green-300 to-teal-400 opacity-45 blur-3xl animate-blob animation-delay-10500"></div>
      <div className="absolute bottom-1/4 right-1/3 translate-x-1/2 translate-y-1/2 h-[600px] w-[600px] rounded-full bg-gradient-to-l from-teal-200 to-cyan-300 opacity-45 blur-3xl animate-blob animation-delay-7500"></div>

      {/* === TESTIMONIALS SECTION === */}
      <div className="absolute -bottom-1/4 right-1/4 h-[500px] w-[500px] translate-x-1/2 rounded-full bg-gradient-to-tr from-[#facc15] to-[#fb923c] opacity-50 blur-3xl animate-blob animation-delay-4000"></div>
      <div className="absolute -bottom-32 -left-32 h-[400px] w-[400px] rounded-full bg-gradient-to-tr from-lime-300 to-green-400 opacity-50 blur-3xl animate-blob animation-delay-5000"></div>
      <div className="absolute -bottom-32 -right-32 h-[400px] w-[400px] rounded-full bg-gradient-to-tl from-orange-300 to-red-400 opacity-50 blur-3xl animate-blob animation-delay-6000"></div>

      {/* === HOW PROCESS WORKS SECTION === */}
      <div className="absolute -bottom-40 left-1/2 h-[450px] w-[450px] -translate-x-1/2 rounded-full bg-gradient-to-t from-amber-300 to-yellow-500 opacity-50 blur-3xl animate-blob animation-delay-4500"></div>
      <div className="absolute -bottom-60 left-1/2 h-[600px] w-[600px] -translate-x-1/2 rounded-full bg-gradient-to-tr from-green-300 to-yellow-400 opacity-45 blur-3xl animate-blob animation-delay-1000"></div>
      <div className="absolute -bottom-80 left-1/3 h-[700px] w-[700px] -translate-x-1/2 rounded-full bg-gradient-to-tr from-lime-200 to-teal-400 opacity-50 blur-3xl animate-blob animation-delay-3800"></div>
      <div className="absolute -bottom-80 right-1/3 h-[700px] w-[700px] translate-x-1/2 rounded-full bg-gradient-to-tl from-sky-300 to-indigo-400 opacity-50 blur-3xl animate-blob animation-delay-5200"></div>

      {/* === JOIN COMMUNITY SECTION === */}
      <div className="absolute top-[78%] -left-32 h-[400px] w-[400px] rounded-full bg-gradient-to-tr from-teal-300 to-cyan-400 opacity-50 blur-3xl animate-blob animation-delay-6500"></div>
      <div className="absolute top-[78%] -right-32 h-[450px] w-[450px] rounded-full bg-gradient-to-tl from-purple-300 to-indigo-400 opacity-50 blur-3xl animate-blob animation-delay-7200"></div>
      <div className="absolute bottom-0 left-1/4 h-[400px] w-[400px] rounded-full bg-gradient-to-tr from-blue-300 to-indigo-400 opacity-45 blur-3xl animate-blob animation-delay-9000"></div>

      {/* === FAQ SECTION === */}
      <div className="absolute top-[82%] left-1/2 -translate-x-1/2 h-[500px] w-[700px] rounded-full bg-gradient-to-t from-orange-200 to-yellow-300 opacity-45 blur-3xl animate-blob animation-delay-8200"></div>
      <div className="absolute top-[86%] left-1/2 -translate-x-1/4 h-[500px] w-[700px] rounded-full bg-gradient-to-t from-orange-200 to-yellow-300 opacity-45 blur-3xl animate-blob animation-delay-8200"></div>
      <div className="absolute top-[92%] left-1/2 -translate-x-3/4 h-[500px] w-[700px] rounded-full bg-gradient-to-t from-orange-200 to-yellow-300 opacity-45 blur-3xl animate-blob animation-delay-8200"></div>
      <div className="absolute top-[98%] left-1/2 -translate-x-1/2 h-[500px] w-[700px] rounded-full bg-gradient-to-t from-orange-200 to-yellow-300 opacity-45 blur-3xl animate-blob animation-delay-8200"></div>
      <div className="absolute -bottom-96 left-1/2 h-[800px] w-[800px] -translate-x-1/2 rounded-full bg-gradient-to-t from-green-200 to-cyan-300 opacity-45 blur-3xl animate-blob animation-delay-1800"></div>

      {/* === NEWSLETTER SECTION === */}
      <div className="absolute -bottom-40 left-1/2 h-[450px] w-[450px] -translate-x-1/2 rounded-full bg-gradient-to-t from-gray-800 to-gray-600 opacity-35 blur-3xl animate-blob animation-delay-4500"></div>
    </div>
  );
};

// Define a custom error type for fetcher
interface FetchError extends Error {
  info?: any; // Keep 'any' for info as it can be diverse, or define a more specific type if known
  status?: number;
}

// Fetcher function for useSWR (expects API to return { data: [...] })
const fetcher = async <T = unknown,>(url: string): Promise<T> => {
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

// Optimized SWR configuration for a SaaS landing page
const swrOptions = {
  revalidateOnFocus: false,
  revalidateOnReconnect: false,
  refreshInterval: 0, // Disable polling, landing page data is not typically real-time
  shouldRetryOnError: true, // Retry on error for critical data
  errorRetryCount: 2, // Number of retry attempts
  dedupingInterval: 5000, // 5 seconds to prevent duplicate requests for the same key
  keepPreviousData: true, // Show stale data while revalidating, prevents UI flashes
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
    fetcher,
    swrOptions,
  );

  const {
    data: reviewsData,
    error: reviewsError,
    isLoading: isLoadingReviews,
  } = useSWR<ReviewWithProfiles[]>(
    "/api/user/reviews?rating=4",
    fetcher,
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

  // For Testimonials marquee effect
  const displayReviews =
    reviews.length >= 4
      ? reviews
      : [...reviews, ...reviews, ...reviews, ...reviews]; // Ensure enough for smooth scroll
  const marqueeGroups = Array.from({ length: 3 }, (_, i) => ({
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
                          {/* Render multiple sets for marquee effect */}
                          {Array.from({ length: 4 }).flatMap(
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
