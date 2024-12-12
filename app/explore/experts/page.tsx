"use client";

import { useState, useEffect } from "react";
import { Domain, SubDomain, Tag } from "@prisma/client";
import { TConsultantProfile } from "@/types/consultant";
import { FiltersSection } from "./components/FiltersSection";
import { ConsultantCard } from "./components/ConsultantCard";
import { FeaturedExperts } from "./components/FeaturedExperts";
import { Testimonials } from "./components/Testimonials";
import { SearchBar } from "./components/SearchBar";

interface MetaData {
  domains: Domain[];
  subdomains: SubDomain[];
  tags: Tag[];
}

function FindExperts() {
  const [metadata, setMetadata] = useState<MetaData | null>(null);
  const [consultants, setConsultants] = useState<TConsultantProfile[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [selectedTags, setSelectedTags] = useState<string[]>([]);
  const [searchTerm, setSearchTerm] = useState("");
  const [experienceYears, setExperienceYears] = useState(0);
  const [pricing, setPricing] = useState(0);
  const [selectedDomain, setSelectedDomain] = useState<string | null>(null);
  const [selectedSubdomain, setSelectedSubdomain] = useState<string | null>(null);

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
          Search for experts in various fields. Enter keywords to find experts in
          specific areas.
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
        pricing={pricing}
        setPricing={setPricing}
      />

      <SearchBar onSearch={setSearchTerm} />

      <div className="space-y-4">
        {metadata?.domains.map((domain) => {
          const domainConsultants = consultants?.filter(
            (consultant) => consultant.domainId === domain.id,
          ) ?? [];

          return (
            <div key={domain.id} className="space-y-4">
              <h2 className="text-2xl font-bold">{domain.name}</h2>
              {domainConsultants.length > 0 ? (
                domainConsultants.map((consultant) => (
                  <ConsultantCard
                    key={consultant.id}
                    consultant={consultant}
                    metadata={metadata}
                  />
                ))
              ) : (
                <p className="text-gray-500">
                  No consultants available in this domain at the moment.
                </p>
              )}
            </div>
          );
        })}
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
