"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { motion } from "framer-motion";
import { Search } from "lucide-react";
import type { IConsultantCardData } from "@/types/consultant";
import { useCurrency } from "@/hooks/useCurrency";
import SectionHeader from "@/app/explore/components/SectionHeader";
import {
  useConsultants,
  useExpertsFilters,
  useInfiniteScroll,
  useExpertFilterChips,
} from "./hooks";
import type { IExpertsMetaData } from "./utils";
import StickyFilterBar from "./components/StickyFilterBar";
import StaticTopRows from "./components/StaticTopRows";
import ExpertResults from "./components/ExpertResults";
import ExpertDetailsSheet from "./components/ExpertDetailsSheet";
import type { SortOption } from "./components/SearchBar";

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

  // Details drawer: selected expert id synced to ?expert=<id> (shareable,
  // back-button closable). Opening/closing pushes a history entry so browser
  // Back closes (or reopens) the sheet, and a popstate listener syncs
  // selectedId both ways. The drawer resolves the id against the loaded list,
  // so list scroll + infinite-query cache are preserved. Deep links to experts
  // beyond the loaded pages resolve once their page loads (or stay closed if
  // the id matches nothing — no single-expert endpoint exists yet).
  const [selectedId, setSelectedId] = useState<string | null>(null);
  useEffect(() => {
    const syncFromUrl = () => {
      const params = new URLSearchParams(window.location.search);
      setSelectedId(params.get("expert"));
    };
    syncFromUrl();
    window.addEventListener("popstate", syncFromUrl);
    return () => window.removeEventListener("popstate", syncFromUrl);
  }, []);
  const selectedConsultant = useMemo(
    () => consultants.find((c) => c.id === selectedId) ?? null,
    [consultants, selectedId],
  );
  const openDetails = useCallback((consultant: IConsultantCardData) => {
    setSelectedId(consultant.id);
    const url = new URL(window.location.href);
    url.searchParams.set("expert", consultant.id);
    window.history.pushState(window.history.state, "", url.toString());
  }, []);
  const closeDetails = useCallback(() => {
    setSelectedId(null);
    const url = new URL(window.location.href);
    url.searchParams.delete("expert");
    window.history.pushState(
      window.history.state,
      "",
      `${url.pathname}${url.search}${url.hash}`,
    );
  }, []);

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

  const resultSummary = useMemo(() => {
    const total = metadata?.consultantMetadata.totalConsultants;
    // The global total is only honest when NO filter is active — affiliation
    // tabs (and orgKind/orgSlug) don't emit chips, so they must be checked
    // explicitly or an Independent-filtered list would claim the full count.
    const isUnfiltered =
      chips.length === 0 &&
      !filters.search &&
      !filters.affiliationType &&
      !filters.orgKind &&
      !filters.orgSlug;
    if (typeof total === "number" && isUnfiltered) {
      return `${total} experts`;
    }
    return `${consultants.length}${hasMore ? "+" : ""} shown`;
  }, [
    metadata,
    chips.length,
    filters.search,
    filters.affiliationType,
    filters.orgKind,
    filters.orgSlug,
    consultants.length,
    hasMore,
  ]);

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
        {/* The nav's "Top rated" deep-links here with ?sort=rating, so the
            anchor needs the same fixed-navbar offset as #domains. */}
        <div
          ref={browseSectionRef}
          id="all-experts"
          // The sticky bar takes over the viewport top when stuck, so a small
          // margin suffices — the bar is in-flow (unstuck) at this anchor.
          className="scroll-mt-4"
        >
          <SectionHeader
            title="Browse Familiarise Experts"
            icon={<Search className="w-5 h-5 text-white" />}
          />

          {/* Search banner (not sticky) */}
          <motion.div
            className="mb-6"
            initial={{ opacity: 0, y: 20 }}
            whileInView={{ opacity: 1, y: 0 }}
            viewport={{ once: true }}
            transition={{ duration: 0.5, delay: 0.2 }}
          >
            <div className="relative mb-6 py-10 px-6 rounded-2xl bg-gradient-to-br from-zinc-900 via-zinc-800 to-zinc-700 overflow-hidden">
              <div className="absolute inset-0 opacity-10">
                <div className="absolute top-0 right-0 w-72 h-72 bg-white rounded-full blur-3xl -translate-y-1/2 translate-x-1/4" />
                <div className="absolute bottom-0 left-0 w-56 h-56 bg-white rounded-full blur-3xl translate-y-1/2 -translate-x-1/4" />
              </div>
              <div className="relative text-center">
                <h2 className="text-2xl md:text-3xl font-bold text-white mb-2">
                  Find Your Perfect Expert
                </h2>
                <p className="text-zinc-400 text-sm md:text-base max-w-lg mx-auto">
                  Search by name, skill, or specialty to connect with top
                  consultants
                </p>
              </div>
            </div>
          </motion.div>

          {/* Sticky settings navbar: search + sort + affiliation tabs +
              org-kind sub-filter + chips. Advanced facets live in the
              Filters sheet (no sidebar grid). */}
          <StickyFilterBar
            metadata={metadata}
            filters={filters}
            updateFilters={updateFilters}
            chips={chips}
            onRemoveChip={removeChip}
            onClearAll={clearAll}
            resultSummary={resultSummary}
          />

          {/* Single-column results: ConsultantCard is a two-column card
              (profile + plan tabs) that collapses badly inside a narrow
              grid cell, so the sidebar grid was removed. */}
          <ExpertResults
            consultants={consultants}
            metadata={metadata}
            isLoading={isLoading}
            isRefetching={isRefetching}
            isLoadingMore={isLoadingMore}
            groupByDomainId={filters.domain}
            sentinelRef={sentinelRef}
            onSelect={openDetails}
          />
        </div>
      </div>

      <ExpertDetailsSheet
        consultant={selectedConsultant}
        onClose={closeDetails}
      />
    </section>
  );
}
