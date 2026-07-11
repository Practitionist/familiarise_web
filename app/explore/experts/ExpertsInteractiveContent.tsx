"use client";

import { useCallback, useRef } from "react";
import { motion } from "framer-motion";
import { Search, Zap, Building2, Users } from "lucide-react";
import type { IConsultantCardData } from "@/types/consultant";
import { useCurrency } from "@/hooks/useCurrency";
import SectionHeader from "@/app/explore/components/SectionHeader";
import FilterChips from "@/app/explore/components/FilterChips";
import {
  useConsultants,
  useExpertsFilters,
  useInfiniteScroll,
  useExpertFilterChips,
} from "./hooks";
import type { IExpertsMetaData, AffiliationType } from "./utils";
import { FilterPanel } from "./components/FilterPanel";
import { SearchBar, type SortOption } from "./components/SearchBar";
import StaticTopRows from "./components/StaticTopRows";
import ExpertResults from "./components/ExpertResults";

const AFFILIATION_TABS: {
  value: AffiliationType;
  label: string;
  icon: React.ElementType;
}[] = [
  { value: null, label: "All Experts", icon: Users },
  { value: "independent", label: "Independent", icon: Zap },
  { value: "agency", label: "Agency / Org", icon: Building2 },
];

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
  const { filters, updateFilters, clearFilters } = useExpertsFilters();
  const browseSectionRef = useRef<HTMLDivElement>(null);
  const { formatPrice } = useCurrency();

  // Main listing — keepPreviousData inside the hook keeps stale results
  // visible during refetch.
  const {
    consultants,
    isLoading,
    isLoadingMore,
    isRefetching,
    hasMore,
    loadMore,
  } = useConsultants(filters);

  // Sentinel-driven infinite scroll. The hook owns the IntersectionObserver
  // lifecycle (one observer per hasMore/isLoading transition, not one per
  // render).
  const sentinelRef = useInfiniteScroll({
    hasMore,
    isLoading: isLoading || isLoadingMore,
    onLoadMore: loadMore,
  });

  // Active chip array + structured-key removal handler.
  const { chips, removeChip, clearAll } = useExpertFilterChips(
    filters,
    metadata,
    updateFilters,
    clearFilters,
    formatPrice,
  );

  // Scroll to the browse section, optionally setting a sort first.
  const scrollToBrowse = useCallback(
    (sort?: SortOption) => {
      if (sort) updateFilters({ sort });
      browseSectionRef.current?.scrollIntoView({ behavior: "smooth" });
    },
    [updateFilters],
  );

  // Domain grid click → set domain filter + scroll to browse section.
  const handleDomainSelect = useCallback(
    (domainId: string) => {
      updateFilters({ domain: domainId, subdomain: null, tags: [] });
      browseSectionRef.current?.scrollIntoView({ behavior: "smooth" });
    },
    [updateFilters],
  );

  return (
    <section className="py-10 md:py-16">
      <div className="max-w-[1600px] mx-auto px-4 md:px-8 lg:px-12">
        <StaticTopRows
          metadata={metadata}
          trendingExperts={trendingExperts}
          newestExperts={newestExperts}
          onSeeAllSort={scrollToBrowse}
          onDomainSelect={handleDomainSelect}
        />

        {/* Browse All Experts */}
        <div ref={browseSectionRef} id="all-experts">
          <SectionHeader
            title="Browse Familiarise Experts"
            icon={<Search className="w-5 h-5 text-white" />}
          />

          {/* Affiliation type toggle: All | Independent | Agency/Org */}
          <motion.div
            className="mb-6"
            initial={{ opacity: 0, y: 20 }}
            whileInView={{ opacity: 1, y: 0 }}
            viewport={{ once: true }}
            transition={{ duration: 0.5, delay: 0.05 }}
          >
            <div className="inline-flex items-center gap-1 p-1 bg-muted rounded-xl border border-border">
              {AFFILIATION_TABS.map(({ value, label, icon: Icon }) => {
                const isActive = filters.affiliationType === value;
                return (
                  <button
                    key={String(value)}
                    onClick={() => updateFilters({ affiliationType: value })}
                    className={`inline-flex items-center gap-1.5 px-4 py-2 rounded-lg text-sm font-medium transition-all ${
                      isActive
                        ? "bg-card text-foreground shadow-sm border border-border"
                        : "text-muted-foreground hover:text-foreground"
                    }`}
                  >
                    <Icon className="w-4 h-4" />
                    {label}
                  </button>
                );
              })}
            </div>
          </motion.div>

          {/* Filters */}
          <motion.div
            className="mb-8"
            initial={{ opacity: 0, y: 20 }}
            whileInView={{ opacity: 1, y: 0 }}
            viewport={{ once: true }}
            transition={{ duration: 0.5, delay: 0.1 }}
          >
            <FilterPanel
              metadata={metadata}
              filters={filters}
              updateFilters={updateFilters}
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
            {/* Compact dark search panel — flat zinc-950, no decoration. */}
            <div className="rounded-2xl bg-zinc-950 border border-zinc-800 p-5 md:p-6">
              <div className="text-center mb-5">
                <h2 className="text-2xl md:text-3xl font-bold tracking-tight text-white mb-1.5">
                  Find Your Perfect Expert
                </h2>
                <p className="text-zinc-400 text-sm md:text-base max-w-lg mx-auto">
                  Search by name, skill, or specialty to connect with top
                  consultants
                </p>
              </div>
              <SearchBar
                onSearch={(term) => updateFilters({ search: term })}
                onSort={(option) => updateFilters({ sort: option })}
                sortBy={filters.sort}
                initialSearch={filters.search}
              />
            </div>
          </motion.div>

          {/* Active Filter Chips */}
          {chips.length > 0 && (
            <div className="mb-6">
              <FilterChips
                filters={chips}
                onRemove={removeChip}
                onClearAll={clearAll}
              />
            </div>
          )}

          {/* Results */}
          <ExpertResults
            consultants={consultants}
            metadata={metadata}
            isLoading={isLoading}
            isRefetching={isRefetching}
            isLoadingMore={isLoadingMore}
            groupByDomainId={filters.domain}
            sentinelRef={sentinelRef}
          />
        </div>
      </div>
    </section>
  );
}
