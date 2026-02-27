"use client";

import { useState, useRef, useCallback, useMemo, useEffect } from "react";
import { motion } from "framer-motion";
import { useRouter, useSearchParams } from "next/navigation";
import { Search, Flame, Clock, Briefcase } from "lucide-react";
import type { IConsultantCardData } from "@/types/consultant";
import { useCurrency } from "@/hooks/useCurrency";
import { FiltersSection } from "./components/FiltersSection";
import { ConsultantCard } from "./components/ConsultantCard";
import { SearchBar, SortOption } from "./components/SearchBar";
import ExpertRow from "./components/ExpertRow";
import DomainGrid from "./components/DomainGrid";
import SectionHeader from "@/app/explore/components/SectionHeader";
import FilterChips, {
  ActiveFilter,
} from "@/app/explore/components/FilterChips";
import { useConsultants } from "./hooks";
import {
  groupConsultantsByDomain,
  IExpertFilters,
  DEFAULT_EXPERT_FILTERS,
  filtersFromSearchParams,
  filtersToSearchParams,
  IExpertsMetaData,
} from "./utils";

function EmptyState() {
  return (
    <motion.div
      className="text-center py-16"
      initial={{ opacity: 0, scale: 0.95 }}
      animate={{ opacity: 1, scale: 1 }}
      transition={{ duration: 0.3 }}
    >
      <div className="w-20 h-20 mx-auto mb-6 rounded-full bg-zinc-100 flex items-center justify-center">
        <Search className="w-10 h-10 text-zinc-400" />
      </div>
      <h3 className="text-xl font-semibold text-zinc-900 mb-2">
        No experts found
      </h3>
      <p className="text-zinc-500 max-w-md mx-auto">
        Try adjusting your filters or search terms to discover more amazing
        mentors
      </p>
    </motion.div>
  );
}

interface ExpertsInteractiveContentProps {
  metadata: IExpertsMetaData | null;
  trendingExperts: IConsultantCardData[];
  newestExperts: IConsultantCardData[];
}

export default function ExpertsInteractiveContent({
  metadata,
  trendingExperts,
  newestExperts,
}: ExpertsInteractiveContentProps) {
  const router = useRouter();
  const searchParams = useSearchParams();

  const [filters, setFilters] = useState<IExpertFilters>(() =>
    filtersFromSearchParams(searchParams),
  );

  const browseSectionRef = useRef<HTMLDivElement>(null);

  const { formatPrice: formatCurrencyPrice } = useCurrency();

  // Main listing with infinite scroll
  const {
    consultants,
    isLoading: isLoadingConsultants,
    isLoadingMore,
    hasMore,
    loadMore,
  } = useConsultants(filters);

  // Sync filters to URL
  useEffect(() => {
    const qs = filtersToSearchParams(filters);
    const target = `/explore/experts${qs ? `?${qs}` : ""}`;
    const current = window.location.pathname + window.location.search;
    if (target !== current) {
      router.replace(target, { scroll: false });
    }
  }, [filters, router]);

  const updateFilters = useCallback((partial: Partial<IExpertFilters>) => {
    setFilters((prev) => ({ ...prev, ...partial }));
  }, []);

  // Infinite scroll observer
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

  // Scroll to browse section and optionally set sort
  const scrollToBrowse = useCallback(
    (sort?: SortOption) => {
      if (sort) updateFilters({ sort });
      browseSectionRef.current?.scrollIntoView({ behavior: "smooth" });
    },
    [updateFilters],
  );

  // Domain grid click -> set domain filter + scroll to browse section
  const handleDomainSelect = useCallback(
    (domainId: string) => {
      updateFilters({ domain: domainId, subdomain: null, tags: [] });
      browseSectionRef.current?.scrollIntoView({ behavior: "smooth" });
    },
    [updateFilters],
  );

  // Group consultants by domain for grouped layout
  const groupedConsultants = useMemo(
    () => groupConsultantsByDomain(consultants),
    [consultants],
  );

  // Build active filter chips
  const activeFilterChips = useMemo(() => {
    const chips: ActiveFilter[] = [];
    if (filters.domain) {
      const domain = metadata?.domains.find((d) => d.id === filters.domain);
      if (domain) {
        chips.push({ key: "domain", label: "Domain", value: domain.name });
      }
    }
    if (filters.subdomain) {
      const sub = metadata?.subdomains.find((s) => s.id === filters.subdomain);
      if (sub) {
        chips.push({
          key: "subdomain",
          label: "Subdomain",
          value: sub.name,
        });
      }
    }
    if (filters.tags.length > 0) {
      filters.tags.forEach((tag) => {
        chips.push({ key: `tag-${tag}`, label: "Tag", value: tag });
      });
    }
    if (filters.experience > 0) {
      chips.push({
        key: "experience",
        label: "Experience",
        value: `${filters.experience}+ years`,
      });
    }
    if (filters.minPrice !== undefined || filters.maxPrice !== undefined) {
      const min = filters.minPrice ?? 0;
      const max = filters.maxPrice;
      const label =
        min === 0 && max === 0
          ? "Free"
          : max === undefined
            ? `${formatCurrencyPrice(min)}+`
            : `${formatCurrencyPrice(min)} - ${formatCurrencyPrice(max)}`;
      chips.push({ key: "price", label: "Price", value: label });
    }
    if (filters.availability) {
      const availLabel =
        filters.availability === "has_slots"
          ? "Has Open Slots"
          : "Available This Week";
      chips.push({
        key: "availability",
        label: "Availability",
        value: availLabel,
      });
    }
    if (filters.language) {
      chips.push({
        key: "language",
        label: "Language",
        value: filters.language,
      });
    }
    if (filters.search) {
      chips.push({ key: "search", label: "Search", value: filters.search });
    }
    if (filters.sort !== "nameAsc") {
      const sortLabels: Record<string, string> = {
        nameDesc: "Name (Z-A)",
        reviewCount: "Most Reviews",
        rating: "Highest Rating",
        trending: "Trending",
        newest: "Newest",
      };
      chips.push({
        key: "sort",
        label: "Sort",
        value: sortLabels[filters.sort] || filters.sort,
      });
    }
    return chips;
  }, [filters, metadata, formatCurrencyPrice]);

  const handleRemoveFilter = useCallback(
    (key: string) => {
      if (key === "domain") {
        updateFilters({ domain: null, subdomain: null, tags: [] });
      } else if (key === "subdomain") {
        updateFilters({ subdomain: null });
      } else if (key.startsWith("tag-")) {
        const tagName = key.replace("tag-", "");
        updateFilters({ tags: filters.tags.filter((t) => t !== tagName) });
      } else if (key === "experience") {
        updateFilters({ experience: 0 });
      } else if (key === "price") {
        updateFilters({ minPrice: undefined, maxPrice: undefined });
      } else if (key === "availability") {
        updateFilters({ availability: undefined });
      } else if (key === "language") {
        updateFilters({ language: undefined });
      } else if (key === "search") {
        updateFilters({ search: "" });
      } else if (key === "sort") {
        updateFilters({ sort: "nameAsc" });
      }
    },
    [updateFilters, filters.tags],
  );

  const handleClearAll = useCallback(() => {
    setFilters(DEFAULT_EXPERT_FILTERS);
  }, []);

  return (
    <section className="py-10 md:py-16">
      <div className="max-w-[1600px] mx-auto px-4 md:px-8 lg:px-12">
        {/* Trending Experts Row */}
        <div className="mb-14">
          <SectionHeader
            title="Trending Experts"
            icon={<Flame className="w-5 h-5 text-white" />}
            onSeeAllClick={() => scrollToBrowse("trending")}
          />
          <ExpertRow
            experts={trendingExperts}
            badge="trending"
            isLoading={false}
          />
        </div>

        {/* Newly Joined Row */}
        <div className="mb-14">
          <SectionHeader
            title="Newly Joined"
            icon={<Clock className="w-5 h-5 text-white" />}
            onSeeAllClick={() => scrollToBrowse("newest")}
          />
          <ExpertRow experts={newestExperts} badge="new" isLoading={false} />
        </div>

        {/* Browse by Domain */}
        {metadata?.consultantMetadata?.consultantsByDomain && (
          <div className="mb-14">
            <SectionHeader
              title="Browse by Domain"
              icon={<Briefcase className="w-5 h-5 text-white" />}
            />
            <DomainGrid
              domains={metadata.consultantMetadata.consultantsByDomain}
              isLoading={false}
              onDomainSelect={handleDomainSelect}
            />
          </div>
        )}

        {/* Browse All Experts */}
        <div ref={browseSectionRef} id="all-experts">
          <SectionHeader
            title="Browse All Experts"
            icon={<Search className="w-5 h-5 text-white" />}
          />

          {/* Filters */}
          <motion.div
            className="mb-8"
            initial={{ opacity: 0, y: 20 }}
            whileInView={{ opacity: 1, y: 0 }}
            viewport={{ once: true }}
            transition={{ duration: 0.5, delay: 0.1 }}
          >
            <FiltersSection
              metadata={metadata}
              selectedDomain={filters.domain}
              setSelectedDomain={(val) =>
                updateFilters({
                  domain: val,
                  subdomain: null,
                  tags: [],
                })
              }
              selectedSubdomain={filters.subdomain}
              setSelectedSubdomain={(val) => updateFilters({ subdomain: val })}
              selectedTags={filters.tags}
              setSelectedTags={(tags) => updateFilters({ tags })}
              experienceYears={filters.experience}
              setExperienceYears={(years) =>
                updateFilters({ experience: years })
              }
              minPrice={filters.minPrice}
              onMinPriceChange={(val) => updateFilters({ minPrice: val })}
              maxPrice={filters.maxPrice}
              onMaxPriceChange={(val) => updateFilters({ maxPrice: val })}
              availability={filters.availability}
              onAvailabilityChange={(val) =>
                updateFilters({ availability: val })
              }
              language={filters.language}
              onLanguageChange={(val) => updateFilters({ language: val })}
            />
          </motion.div>

          {/* Search Bar */}
          <motion.div
            className="mb-6"
            initial={{ opacity: 0, y: 20 }}
            whileInView={{ opacity: 1, y: 0 }}
            viewport={{ once: true }}
            transition={{ duration: 0.5, delay: 0.2 }}
          >
            <SearchBar
              onSearch={(term) => updateFilters({ search: term })}
              onSort={(option) => updateFilters({ sort: option })}
              sortBy={filters.sort}
              initialSearch={filters.search}
            />
          </motion.div>

          {/* Active Filter Chips */}
          {activeFilterChips.length > 0 && (
            <div className="mb-6">
              <FilterChips
                filters={activeFilterChips}
                onRemove={handleRemoveFilter}
                onClearAll={handleClearAll}
              />
            </div>
          )}

          {/* Results */}
          <div className="mt-8 min-h-[400px] relative">
            {isLoadingConsultants ? (
              <div className="absolute inset-0 flex items-center justify-center bg-white/80 backdrop-blur-sm rounded-2xl">
                <div className="flex flex-col items-center gap-4">
                  <div className="w-12 h-12 border-4 border-zinc-200 border-t-zinc-900 rounded-full animate-spin" />
                  <p className="text-zinc-500 text-sm">Finding experts...</p>
                </div>
              </div>
            ) : filters.domain ? (
              <>
                {metadata?.domains.map((domain) => {
                  const domainConsultants =
                    groupedConsultants[domain.name] || [];
                  if (domainConsultants.length === 0) return null;

                  return (
                    <motion.div
                      key={domain.id}
                      className="mb-12"
                      initial={{ opacity: 0, y: 20 }}
                      whileInView={{ opacity: 1, y: 0 }}
                      viewport={{ once: true }}
                      transition={{ duration: 0.5 }}
                    >
                      <div className="flex items-center gap-3 mb-6">
                        <div className="w-1 h-8 bg-gradient-to-b from-zinc-900 to-zinc-400 rounded-full" />
                        <h3 className="text-2xl font-bold text-zinc-900">
                          {domain.name}
                        </h3>
                        <span className="px-3 py-1 bg-zinc-100 rounded-full text-sm text-zinc-600">
                          {domainConsultants.length} expert
                          {domainConsultants.length !== 1 ? "s" : ""}
                        </span>
                      </div>
                      <div className="space-y-6">
                        {domainConsultants.map(
                          (consultant: IConsultantCardData, index: number) => (
                            <div
                              key={consultant.id}
                              ref={
                                index === domainConsultants.length - 1
                                  ? lastConsultantRef
                                  : undefined
                              }
                            >
                              <ConsultantCard
                                consultant={consultant}
                                metadata={metadata}
                              />
                            </div>
                          ),
                        )}
                      </div>
                    </motion.div>
                  );
                })}

                {consultants.length === 0 && <EmptyState />}
              </>
            ) : (
              <>
                <div className="space-y-6">
                  {consultants.map(
                    (consultant: IConsultantCardData, index: number) => (
                      <motion.div
                        key={consultant.id}
                        ref={
                          index === consultants.length - 1
                            ? lastConsultantRef
                            : undefined
                        }
                        initial={{ opacity: 0, y: 20 }}
                        whileInView={{ opacity: 1, y: 0 }}
                        viewport={{ once: true }}
                        transition={{
                          duration: 0.4,
                          delay: Math.min(index * 0.05, 0.6),
                        }}
                      >
                        <ConsultantCard
                          consultant={consultant}
                          metadata={metadata}
                        />
                      </motion.div>
                    ),
                  )}
                </div>

                {consultants.length === 0 && <EmptyState />}
              </>
            )}

            {isLoadingMore && (
              <div className="flex justify-center py-8">
                <div className="flex items-center gap-3">
                  <div className="w-8 h-8 border-3 border-zinc-200 border-t-zinc-900 rounded-full animate-spin" />
                  <span className="text-zinc-500 text-sm">Loading more...</span>
                </div>
              </div>
            )}
          </div>
        </div>
      </div>
    </section>
  );
}
