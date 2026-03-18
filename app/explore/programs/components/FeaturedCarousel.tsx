"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { ChevronLeft, ChevronRight } from "lucide-react";
import { ArrowRight, Sparkles } from "lucide-react";
import Image from "next/image";
import { useRouter } from "next/navigation";
import { CompanyLogo } from "@/components/ui/company-logo";
import { isClassProgram, Program } from "../utils";

interface FeaturedCarouselProps {
  programs: Program[];
  isLoading?: boolean;
}

function SkeletonSlide() {
  return (
    <div className="flex-shrink-0 w-full rounded-2xl overflow-hidden border border-zinc-200 bg-zinc-100 animate-pulse">
      <div className="flex flex-col md:flex-row h-[320px] md:h-[280px]">
        <div className="md:w-[400px] bg-zinc-200 flex-shrink-0 h-[160px] md:h-full" />
        <div className="flex-1 p-6 md:p-8 space-y-4">
          <div className="h-4 bg-zinc-200 rounded w-20" />
          <div className="h-7 bg-zinc-200 rounded w-3/4" />
          <div className="h-4 bg-zinc-200 rounded w-full" />
          <div className="h-4 bg-zinc-200 rounded w-2/3" />
          <div className="h-10 bg-zinc-200 rounded w-32 mt-4" />
        </div>
      </div>
    </div>
  );
}

export default function FeaturedCarousel({
  programs,
  isLoading,
}: FeaturedCarouselProps) {
  const router = useRouter();
  const [currentIndex, setCurrentIndex] = useState(0);
  const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const startAutoScroll = useCallback(() => {
    if (intervalRef.current) clearInterval(intervalRef.current);
    if (programs.length <= 1) return;
    intervalRef.current = setInterval(() => {
      setCurrentIndex((prev) => (prev + 1) % programs.length);
    }, 5000);
  }, [programs.length]);

  useEffect(() => {
    startAutoScroll();
    return () => {
      if (intervalRef.current) clearInterval(intervalRef.current);
    };
  }, [startAutoScroll]);

  const goTo = (index: number) => {
    setCurrentIndex(index);
    startAutoScroll();
  };

  const prev = () =>
    goTo((currentIndex - 1 + programs.length) % programs.length);
  const next = () => goTo((currentIndex + 1) % programs.length);

  if (isLoading) return <SkeletonSlide />;
  if (programs.length === 0) return null;

  const program = programs[currentIndex];

  // Extract instructor work experiences for company logos
  const cp = (program as Record<string, unknown>).consultantProfile as
    | { user?: { workExperiences?: Array<{ company: string; companyDomain: string | null }> } }
    | undefined;
  const workExperiences = cp?.user?.workExperiences ?? [];

  const handleClick = () => {
    if (isClassProgram(program)) {
      router.push(`/explore/programs/plans/classes/${program.id}`);
    } else {
      router.push(`/explore/programs/plans/webinars/${program.id}`);
    }
  };

  return (
    <div className="relative">
      <div
        className="group bg-white rounded-2xl overflow-hidden border border-zinc-200 hover:border-zinc-300 hover:shadow-xl transition-all duration-300 cursor-pointer"
        onClick={handleClick}
        role="button"
        tabIndex={0}
        onKeyDown={(e) => {
          if (e.key === "Enter" || e.key === " ") {
            e.preventDefault();
            handleClick();
          }
        }}
        aria-label={`View details for ${program.title}`}
      >
        <div className="flex flex-col md:flex-row h-auto md:h-[280px]">
          {/* Image */}
          <div className="relative md:w-[400px] flex-shrink-0 h-[200px] md:h-full overflow-hidden">
            <Image
              src={program.imageUrl}
              alt={program.title}
              fill
              className="object-cover group-hover:scale-105 transition-transform duration-500"
              sizes="(max-width: 768px) 100vw, 400px"
              priority
            />
            <div className="absolute top-4 left-4 flex gap-2">
              <span
                className={`px-3 py-1 rounded-full text-xs font-medium ${
                  program.type === "class"
                    ? "bg-zinc-900 text-white"
                    : "bg-white text-zinc-900"
                }`}
              >
                {program.type === "class" ? "Class" : "Webinar"}
              </span>
              <span className="inline-flex items-center gap-1 px-2.5 py-1 rounded-full text-xs font-medium bg-amber-500 text-white">
                <Sparkles className="w-3 h-3" />
                Featured
              </span>
            </div>
          </div>

          {/* Content */}
          <div className="flex-1 p-6 md:p-8 flex flex-col justify-center">
            <h3 className="text-xl md:text-2xl font-bold text-zinc-900 mb-3 line-clamp-2 group-hover:text-zinc-700 transition-colors">
              {program.title}
            </h3>
            <p className="text-sm md:text-base text-zinc-500 mb-6 line-clamp-3">
              {program.description}
            </p>
            <div className="flex items-center gap-4">
              <span className="text-2xl font-bold text-zinc-900">
                ${program.price}
              </span>
              {workExperiences.length > 0 && (
                <div className="flex items-center gap-1.5">
                  {workExperiences.slice(0, 3).map((exp, i) => (
                    <CompanyLogo
                      key={`featured-company-${program.id}-${i}`}
                      companyName={exp.company}
                      companyDomain={exp.companyDomain ?? undefined}
                      size={24}
                      className="border-zinc-200"
                    />
                  ))}
                </div>
              )}
              <span className="inline-flex items-center gap-1.5 text-sm font-medium text-zinc-500 group-hover:text-zinc-900 transition-colors">
                View Details
                <ArrowRight className="w-4 h-4 group-hover:translate-x-1 transition-transform" />
              </span>
            </div>
          </div>
        </div>
      </div>

      {/* Navigation */}
      {programs.length > 1 && (
        <>
          <button
            onClick={(e) => {
              e.stopPropagation();
              prev();
            }}
            className="absolute left-3 top-1/2 -translate-y-1/2 z-10 w-9 h-9 rounded-full bg-white/90 backdrop-blur border border-zinc-200 shadow-md flex items-center justify-center hover:bg-white transition-colors"
            aria-label="Previous"
          >
            <ChevronLeft className="w-4 h-4 text-zinc-700" />
          </button>
          <button
            onClick={(e) => {
              e.stopPropagation();
              next();
            }}
            className="absolute right-3 top-1/2 -translate-y-1/2 z-10 w-9 h-9 rounded-full bg-white/90 backdrop-blur border border-zinc-200 shadow-md flex items-center justify-center hover:bg-white transition-colors"
            aria-label="Next"
          >
            <ChevronRight className="w-4 h-4 text-zinc-700" />
          </button>

          {/* Dots */}
          <div className="flex justify-center gap-2 mt-4">
            {programs.map((_, i) => (
              <button
                key={i}
                onClick={(e) => {
                  e.stopPropagation();
                  goTo(i);
                }}
                className={`w-2 h-2 rounded-full transition-all duration-200 ${
                  i === currentIndex
                    ? "bg-zinc-900 w-6"
                    : "bg-zinc-300 hover:bg-zinc-400"
                }`}
                aria-label={`Go to slide ${i + 1}`}
              />
            ))}
          </div>
        </>
      )}
    </div>
  );
}
