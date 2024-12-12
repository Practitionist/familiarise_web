"use client";

import { useState, useEffect, useMemo } from "react";
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

function FindExperts() {
  const [metadata, setMetadata] = useState<MetaData | null>(null);
  const [consultants, setConsultants] = useState<TConsultantProfile[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [selectedTags, setSelectedTags] = useState<string[]>([]);
  const [searchTerm, setSearchTerm] = useState("");
  const [experienceYears, setExperienceYears] = useState(0);
  const [selectedDomain, setSelectedDomain] = useState<string | null>(null);
  const [selectedSubdomain, setSelectedSubdomain] = useState<string | null>(
    null,
  );
  const [sortBy, setSortBy] = useState<SortOption>("nameAsc");

  useEffect(() => {
    async function fetchData() {
      setIsLoading(true);
      try {
        const [metaResponse, consultantsResponse] = await Promise.all([
          fetch("/api/user/consultants/meta"),
          fetch("/api/user/consultants"),
        ]);
        const metaData = await metaResponse.json();
        const consultantsData = await consultantsResponse.json();

        setMetadata(metaData.data);
        setConsultants(consultantsData.data);
      } catch (error) {
        console.error("Error fetching data:", error);
      } finally {
        setIsLoading(false);
      }
    }
    fetchData();
  }, []);

  // Filter functions
  const filterBySearch = (consultant: TConsultantProfile) => {
    if (!searchTerm) return true;
    const searchLower = searchTerm.toLowerCase();

    // Search in user details
    if (consultant.user.name?.toLowerCase().includes(searchLower)) return true;
    if (consultant.user.email?.toLowerCase().includes(searchLower)) return true;

    // Search in consultant details
    if (consultant.description?.toLowerCase().includes(searchLower))
      return true;
    if (consultant.specialization?.toLowerCase().includes(searchLower))
      return true;
    if (consultant.qualifications?.toLowerCase().includes(searchLower))
      return true;

    // Search in domain and subdomain names
    if (consultant.domain.name.toLowerCase().includes(searchLower)) return true;
    if (
      consultant.subDomains.some((sd) =>
        sd.name.toLowerCase().includes(searchLower),
      )
    )
      return true;

    // Search in tags
    if (
      consultant.tags.some((tag) =>
        tag.name.toLowerCase().includes(searchLower),
      )
    )
      return true;

    return false;
  };

  const filterByDomain = (consultant: TConsultantProfile) => {
    if (!selectedDomain) return true;
    return consultant.domainId === selectedDomain;
  };

  const filterBySubdomain = (consultant: TConsultantProfile) => {
    if (!selectedSubdomain) return true;
    return consultant.subDomains.some((sd) => sd.id === selectedSubdomain);
  };

  const filterByTags = (consultant: TConsultantProfile) => {
    if (selectedTags.length === 0) return true;
    return selectedTags.every((tagName) =>
      consultant.tags.some((t) => t.name === tagName),
    );
  };

  const filterByExperience = (consultant: TConsultantProfile) => {
    if (experienceYears === 0) return true;
    if (!consultant.experience) return false;

    // Parse experience range (e.g., "5-10 years" -> 5)
    const match = consultant.experience.match(/\d+/);
    if (!match) return false;

    const years = parseInt(match[0]);
    return years >= experienceYears;
  };

  // Sort function
  const sortConsultants = (consultants: TConsultantProfile[]) => {
    return [...consultants].sort((a, b) => {
      switch (sortBy) {
        case "nameAsc":
          return (a.user.name || "").localeCompare(b.user.name || "");
        case "nameDesc":
          return (b.user.name || "").localeCompare(a.user.name || "");
        case "reviewCount":
          return (b.reviews?.length || 0) - (a.reviews?.length || 0);
        case "rating":
          return (b.rating || 0) - (a.rating || 0);
        default:
          return 0;
      }
    });
  };

  // Apply all filters and sorting using useMemo
  const filteredAndSortedConsultants = useMemo(() => {
    const filtered = consultants.filter(
      (consultant) =>
        filterBySearch(consultant) &&
        filterByDomain(consultant) &&
        filterBySubdomain(consultant) &&
        filterByTags(consultant) &&
        filterByExperience(consultant),
    );
    return sortConsultants(filtered);
  }, [
    consultants,
    searchTerm,
    selectedDomain,
    selectedSubdomain,
    selectedTags,
    experienceYears,
    sortBy,
  ]);

  // Group consultants by domain
  const groupedConsultants = useMemo(() => {
    const grouped = new Map<string, TConsultantProfile[]>();

    filteredAndSortedConsultants.forEach((consultant) => {
      if (!grouped.has(consultant.domain.id)) {
        grouped.set(consultant.domain.id, []);
      }
      grouped.get(consultant.domain.id)?.push(consultant);
    });

    return grouped;
  }, [filteredAndSortedConsultants]);

  if (isLoading) {
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

      <div className="space-y-4">
        {metadata?.domains.map((domain) => {
          const domainConsultants = groupedConsultants.get(domain.id) || [];

          if (domainConsultants.length === 0) return null;

          return (
            <div key={domain.id} className="space-y-4">
              <h2 className="text-2xl font-bold">{domain.name}</h2>
              {domainConsultants.map((consultant) => (
                <ConsultantCard
                  key={consultant.id}
                  consultant={consultant}
                  metadata={metadata}
                />
              ))}
            </div>
          );
        })}

        {filteredAndSortedConsultants.length === 0 && (
          <div className="text-center py-8">
            <p className="text-gray-500 text-lg">
              No consultants found matching your criteria. Try adjusting your
              filters.
            </p>
          </div>
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
