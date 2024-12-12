"use client";

import { useState, useEffect, useMemo, useRef, useCallback } from "react";
import { Domain, SubDomain, Tag } from "@prisma/client";
import { TConsultantProfile } from "@/types/consultant";
import { FiltersSection } from "./components/FiltersSection";
import { ConsultantCard } from "./components/ConsultantCard";
import { FeaturedExperts } from "./components/FeaturedExperts";
import { Testimonials } from "./components/Testimonials";
import { SearchBar, SortOption } from "./components/SearchBar";

interface MetaData {
  domains: Domain[];
  subdomains: SubDomain[];
  tags: Tag[];
  consultantMetadata: {
    totalConsultants: number;
    consultantsByDomain: {
      id: string;
      name: string;
      consultantCount: number;
    }[];
    averageRating: number;
  };
}

const CONSULTANTS_PER_PAGE = 10;

function FindExperts() {
  const [metadata, setMetadata] = useState<MetaData | null>(null);
  const [consultants, setConsultants] = useState<TConsultantProfile[]>([]);
  const [isLoadingMetadata, setIsLoadingMetadata] = useState(true);
  const [isLoadingConsultants, setIsLoadingConsultants] = useState(false);
  const [isLoadingMore, setIsLoadingMore] = useState(false);
  const [hasMore, setHasMore] = useState(true);
  const [page, setPage] = useState(1);
  const [selectedTags, setSelectedTags] = useState<string[]>([]);
  const [searchTerm, setSearchTerm] = useState("");
  const [experienceYears, setExperienceYears] = useState(0);
  const [selectedDomain, setSelectedDomain] = useState<string | null>(null);
  const [selectedSubdomain, setSelectedSubdomain] = useState<string | null>(
    null,
  );
  const [sortBy, setSortBy] = useState<SortOption>("nameAsc");

  const observer = useRef<IntersectionObserver | null>(null);
  const lastConsultantRef = useCallback(
    (node: HTMLDivElement) => {
      if (isLoadingMore) return;
      if (observer.current) observer.current.disconnect();

      observer.current = new IntersectionObserver((entries) => {
        if (entries[0].isIntersecting && hasMore) {
          setPage((prevPage) => prevPage + 1);
        }
      });

      if (node) observer.current.observe(node);
    },
    [isLoadingMore, hasMore],
  );

  // Reset page when filters change
  useEffect(() => {
    setPage(1);
    setConsultants([]);
    setHasMore(true);
  }, [
    searchTerm,
    selectedDomain,
    selectedSubdomain,
    selectedTags,
    experienceYears,
    sortBy,
  ]);

  // Fetch metadata only once
  useEffect(() => {
    async function fetchMetadata() {
      try {
        const metaResponse = await fetch("/api/user/consultants/meta");
        const metaData = await metaResponse.json();
        setMetadata(metaData.data);
      } catch (error) {
        console.error("Error fetching metadata:", error);
      } finally {
        setIsLoadingMetadata(false);
      }
    }

    fetchMetadata();
  }, []);

  // Fetch consultants
  useEffect(() => {
    async function fetchConsultants() {
      if (page === 1) {
        setIsLoadingConsultants(true);
      } else {
        setIsLoadingMore(true);
      }

      try {
        const params = new URLSearchParams({
          page: page.toString(),
          limit: CONSULTANTS_PER_PAGE.toString(),
          ...(selectedDomain && { domain: selectedDomain }),
          ...(selectedSubdomain && { subdomain: selectedSubdomain }),
          ...(selectedTags.length && { tags: selectedTags.join(",") }),
          ...(experienceYears > 0 && {
            experience: experienceYears.toString(),
          }),
          ...(searchTerm && { search: searchTerm }),
          sort: sortBy,
        });

        const consultantsResponse = await fetch(
          `/api/user/consultants?${params}`,
        );
        const consultantsData = await consultantsResponse.json();

        if (page === 1) {
          setConsultants(consultantsData.data);
        } else {
          setConsultants((prev) => [...prev, ...consultantsData.data]);
        }

        setHasMore(consultantsData.data.length === CONSULTANTS_PER_PAGE);
      } catch (error) {
        console.error("Error fetching consultants:", error);
      } finally {
        setIsLoadingConsultants(false);
        setIsLoadingMore(false);
      }
    }

    fetchConsultants();
  }, [
    page,
    selectedDomain,
    selectedSubdomain,
    selectedTags,
    experienceYears,
    searchTerm,
    sortBy,
  ]);

  // Group consultants by domain
  const groupedConsultants = useMemo(() => {
    const grouped = new Map<string, TConsultantProfile[]>();

    consultants.forEach((consultant) => {
      if (!grouped.has(consultant.domain.id)) {
        grouped.set(consultant.domain.id, []);
      }
      grouped.get(consultant.domain.id)?.push(consultant);
    });

    return grouped;
  }, [consultants]);

  if (isLoadingMetadata) {
    return (
      <div className="flex items-center justify-center min-h-screen">
        <div className="animate-spin rounded-full h-12 w-12 border-t-2 border-b-2 border-gray-900 dark:border-gray-100" />
      </div>
    );
  }

  return (
    <div key="1" className="w-full px-4 py-6 space-y-6 md:px-6 md:py-12">
      <div className="flex flex-col space-y-2">
        <h1 className="text-3xl font-bold tracking-tighter sm:text-4xl md:text-5xl">
          Find an Expert
        </h1>
        <p className="text-gray-500 grid-rows-2 dark:text-gray-400">
          Search for experts in various fields. Enter keywords to find experts
          in specific areas.
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

      <SearchBar onSearch={setSearchTerm} onSort={setSortBy} sortBy={sortBy} />

      <div className="space-y-4 min-h-[400px] relative">
        {isLoadingConsultants ? (
          <div className="absolute inset-0 flex items-center justify-center bg-white/50 dark:bg-black/50">
            <div className="animate-spin rounded-full h-12 w-12 border-t-2 border-b-2 border-gray-900 dark:border-gray-100" />
          </div>
        ) : (
          <>
            {metadata?.domains.map((domain) => {
              const domainConsultants = groupedConsultants.get(domain.id) || [];

              if (domainConsultants.length === 0) return null;

              return (
                <div key={domain.id} className="space-y-4">
                  <h2 className="text-2xl font-bold">{domain.name}</h2>
                  {domainConsultants.map((consultant, index) => {
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
                  })}
                </div>
              );
            })}

            {consultants.length === 0 && (
              <div className="text-center py-8">
                <p className="text-gray-500 text-lg">
                  No consultants found matching your criteria. Try adjusting
                  your filters.
                </p>
              </div>
            )}

            {isLoadingMore && (
              <div className="flex justify-center py-4">
                <div className="animate-spin rounded-full h-8 w-8 border-t-2 border-b-2 border-gray-900 dark:border-gray-100" />
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
    <>
      <FeaturedExperts />
      <FindExperts />
      <Testimonials />
    </>
  );
}
