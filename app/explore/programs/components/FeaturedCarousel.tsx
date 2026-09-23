"use client";

import { memo, useState } from "react";
import { ChevronLeft, ChevronRight } from "lucide-react";
import { ArrowRight, Sparkles } from "lucide-react";
import Image from "next/image";
import Link from "next/link";
import { CompanyLogo } from "@/components/ui/company-logo";
import { useCurrency } from "@/hooks/useCurrency";
import { isClassProgram, Program } from "@/lib/explore/programs";

interface FeaturedCarouselProps {
  programs: Program[];
  isLoading?: boolean;
}

function SkeletonSlide() {
  return (
    <div className="flex-shrink-0 w-full rounded-2xl overflow-hidden border border-border bg-muted animate-pulse">
      <div className="flex flex-col md:flex-row h-[320px] md:h-[280px]">
        <div className="md:w-[400px] bg-muted flex-shrink-0 h-[160px] md:h-full" />
        <div className="flex-1 p-6 md:p-8 space-y-4">
          <div className="h-4 bg-muted rounded w-20" />
          <div className="h-7 bg-muted rounded w-3/4" />
          <div className="h-4 bg-muted rounded w-full" />
          <div className="h-4 bg-muted rounded w-2/3" />
          <div className="h-10 bg-muted rounded w-32 mt-4" />
        </div>
      </div>
    </div>
  );
}

function FeaturedCarouselImpl({ programs, isLoading }: FeaturedCarouselProps) {
  const { formatPrice } = useCurrency();
  const [currentIndex, setCurrentIndex] = useState(0);
  const goTo = (index: number) => {
    setCurrentIndex(index);
  };

  if (isLoading) return <SkeletonSlide />;
  if (programs.length === 0) return null;

  const activeIndex = Math.min(currentIndex, programs.length - 1);
  const prev = () => goTo((activeIndex - 1 + programs.length) % programs.length);
  const next = () => goTo((activeIndex + 1) % programs.length);
  const program = programs[activeIndex];

  // Extract instructor work experiences for company logos
  const workExperiences =
    program.consultantProfile?.user?.workExperiences ?? [];

  // Plain href (not router.push) so the featured slide prefetches on hover.
  const programHref = isClassProgram(program)
    ? `/explore/programs/plans/classes/${program.id}`
    : `/explore/programs/plans/webinars/${program.id}`;

  return (
    <div className="relative">
      <Link
        href={programHref}
        className="explore-card group block cursor-pointer overflow-hidden rounded-2xl focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
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
                    ? "bg-primary text-primary-foreground"
                    : "bg-card text-foreground"
                }`}
              >
                {program.type === "class" ? "Class" : "Webinar"}
              </span>
              <span className="inline-flex items-center gap-1 rounded-full border border-border bg-background px-2.5 py-1 text-xs font-medium text-foreground">
                <Sparkles className="w-3 h-3" />
                In focus
              </span>
            </div>
          </div>

          {/* Content */}
          <div className="flex-1 p-6 md:p-8 flex flex-col justify-center min-w-0">
            <h3 className="text-xl md:text-2xl font-bold text-foreground mb-3 line-clamp-2 group-hover:text-muted-foreground transition-colors">
              {program.title}
            </h3>
            <p className="text-sm md:text-base text-muted-foreground mb-6 line-clamp-3">
              {program.description}
            </p>
            <div className="flex items-center gap-4">
              <span className="text-2xl font-bold text-foreground">
                {formatPrice(program.price)}
              </span>
              {workExperiences.length > 0 && (
                <div className="flex items-center gap-1.5">
                  {workExperiences.slice(0, 3).map((exp, i) => (
                    <CompanyLogo
                      key={`featured-company-${program.id}-${i}`}
                      companyName={exp.company}
                      companyDomain={exp.companyDomain ?? undefined}
                      size={24}
                      className="border-border"
                    />
                  ))}
                </div>
              )}
              <span className="inline-flex items-center gap-1.5 text-sm font-medium text-muted-foreground group-hover:text-foreground transition-colors">
                View Details
                <ArrowRight className="w-4 h-4 group-hover:translate-x-1 transition-transform" />
              </span>
            </div>
          </div>
        </div>
      </Link>

      {/* Navigation */}
      {programs.length > 1 && (
        <>
          <button
            onClick={() => prev()}
            className="absolute left-3 top-1/2 z-10 flex h-9 w-9 -translate-y-1/2 items-center justify-center rounded-full border border-border bg-card/90 shadow-md transition-colors hover:bg-card focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            aria-label="Previous"
          >
            <ChevronLeft className="w-4 h-4 text-muted-foreground" />
          </button>
          <button
            onClick={() => next()}
            className="absolute right-3 top-1/2 z-10 flex h-9 w-9 -translate-y-1/2 items-center justify-center rounded-full border border-border bg-card/90 shadow-md transition-colors hover:bg-card focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            aria-label="Next"
          >
            <ChevronRight className="w-4 h-4 text-muted-foreground" />
          </button>

          {/* Dots */}
          <div className="flex justify-center gap-2 mt-4">
            {programs.map((_, i) => (
              <button
                key={i}
                onClick={() => goTo(i)}
                className={`w-2 h-2 rounded-full transition-all duration-200 ${
                  i === activeIndex
                    ? "bg-primary w-6"
                    : "bg-muted-foreground/30 hover:bg-muted-foreground/50"
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

const FeaturedCarousel = memo(FeaturedCarouselImpl);
export default FeaturedCarousel;
