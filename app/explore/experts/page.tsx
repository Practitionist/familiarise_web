"use client";

import { useState, useRef, useCallback, useEffect } from "react";
import { TConsultantProfile } from "@/types/consultant";
import { FiltersSection } from "./components/FiltersSection";
import { ConsultantCard } from "./components/ConsultantCard";
import { FeaturedExperts } from "./components/FeaturedExperts";
import { SatisfiedTestimonial } from "./components/SatisfiedTestimonial";
import { SearchBar, SortOption } from "./components/SearchBar";
import {
  useConsultantsMetadata,
  useConsultants,
  groupConsultantsByDomain,
} from "./utils";

function FindExperts() {
  const [selectedTags, setSelectedTags] = useState<string[]>([]);
  const [searchTerm, setSearchTerm] = useState("");
  const [experienceYears, setExperienceYears] = useState(0);
  const [selectedDomain, setSelectedDomain] = useState<string | null>(null);
  const [selectedSubdomain, setSelectedSubdomain] = useState<string | null>(
    null,
  );
  const [sortBy, setSortBy] = useState<SortOption>("nameAsc");

  const {
    metadata,
    isLoading: isLoadingMetadata,
    refresh: _refreshMetadata,
  } = useConsultantsMetadata();

  const {
    consultants,
    isLoading: isLoadingConsultants,
    isLoadingMore,
    hasMore,
    loadMore,
    refresh: refreshConsultants,
  } = useConsultants({
    selectedDomain,
    selectedSubdomain,
    selectedTags,
    experienceYears,
    searchTerm,
    sortBy,
  });

  const observer = useRef<IntersectionObserver | null>(null);
  const lastConsultantRef = useCallback(
    (node: HTMLDivElement) => {
      if (isLoadingMore) return;
      if (observer.current) observer.current.disconnect();

      observer.current = new IntersectionObserver((entries) => {
        if (entries[0].isIntersecting && hasMore) {
          loadMore();
        }
      });

      if (node) observer.current.observe(node);
    },
    [isLoadingMore, hasMore, loadMore],
  );

  // Group consultants by domain
  const groupedConsultants = groupConsultantsByDomain(consultants);

  if (isLoadingMetadata) {
    return (
      <div className="flex items-center justify-center min-h-screen bg-black">
        <div className="animate-spin rounded-full h-12 w-12 border-t-2 border-b-2 border-gray-100" />
      </div>
    );
  }

  return (
    <div key="1" className="w-full px-4 py-6 space-y-6 md:px-6 md:py-12">
      <div className="flex flex-col space-y-2">
        <h1 className="text-3xl font-bold tracking-tighter sm:text-4xl md:text-5xl bg-gradient-to-r from-gray-300 via-gray-100 to-gray-400 bg-clip-text text-transparent">
          Meet Your Perfect Mentor
        </h1>
        <p className="text-gray-400">
          Ready to level up? Our amazing mentors are here to guide you! Use
          keywords to find someone who matches your goals.
        </p>
      </div>

      <FiltersSection
        metadata={metadata}
        selectedDomain={selectedDomain}
        setSelectedDomain={setSelectedDomain}
        selectedSubdomain={selectedSubdomain}
        setSelectedSubdomain={setSelectedSubdomain}
        selectedTags={selectedTags}
        setSelectedTags={setSelectedTags}
        experienceYears={experienceYears}
        setExperienceYears={setExperienceYears}
      />

      <SearchBar
        onSearch={(term) => {
          setSearchTerm(term);
          // Reset to first page when search changes
          refreshConsultants();
        }}
        onSort={(option) => {
          setSortBy(option);
          // Reset to first page when sort changes
          refreshConsultants();
        }}
        sortBy={sortBy}
      />

      <div className="space-y-4 min-h-[400px] relative">
        {isLoadingConsultants ? (
          <div className="absolute inset-0 flex items-center justify-center bg-black/50">
            <div className="animate-spin rounded-full h-12 w-12 border-t-2 border-b-2 border-gray-100" />
          </div>
        ) : (
          <>
            {metadata?.domains.map((domain) => {
              const domainConsultants = groupedConsultants[domain.name] || [];

              if (domainConsultants.length === 0) return null;

              return (
                <div key={domain.id} className="space-y-4">
                  <h2 className="text-2xl font-bold text-gray-100">
                    {domain.name}
                  </h2>
                  {domainConsultants.map(
                    (consultant: TConsultantProfile, index: number) => {
                      if (domainConsultants.length === index + 1) {
                        return (
                          <div key={consultant.id} ref={lastConsultantRef}>
                            <ConsultantCard
                              consultant={consultant}
                              metadata={metadata}
                            />
                          </div>
                        );
                      }
                      return (
                        <ConsultantCard
                          key={consultant.id}
                          consultant={consultant}
                          metadata={metadata}
                        />
                      );
                    },
                  )}
                </div>
              );
            })}

            {consultants.length === 0 && (
              <div className="text-center py-8">
                <p className="text-gray-400 text-lg">
                  Oops! We couldn't find any mentors matching your search. Try
                  tweaking your filters to discover more awesome mentors!
                </p>
              </div>
            )}

            {isLoadingMore && (
              <div className="flex justify-center py-4">
                <div className="animate-spin rounded-full h-8 w-8 border-t-2 border-b-2 border-gray-100" />
              </div>
            )}
          </>
        )}
      </div>
    </div>
  );
}

export default function ExploreExperts() {
  return (
    <div className="w-full min-h-screen bg-black">
      <FeaturedExperts />
      <FindExperts />
      <SatisfiedTestimonial />
    </div>
  );
}
