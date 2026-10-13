"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Search } from "lucide-react";
import type { IConsultantCardData } from "@/types/consultant";
import { useCurrency } from "@/hooks/useCurrency";
import { pushUrl } from "@/lib/navigation/history";
import SectionHeader from "@/app/explore/components/SectionHeader";
import {
  useConsultants,
  useExpertsFilters,
  useInfiniteScroll,
  useExpertFilterChips,
} from "./hooks";
import type { IExpertFilters, IExpertsMetaData } from "./utils";
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
}: Readonly<ExpertsInteractiveContentProps>) {
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
    pushUrl(url.toString());
  }, []);
  const closeDetails = useCallback(() => {
    setSelectedId(null);
    const url = new URL(window.location.href);
    url.searchParams.delete("expert");
    pushUrl(`${url.pathname}${url.search}${url.hash}`);
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

  // Resolve human-readable domain/subdomain names from URL query params
  // (e.g., ?domain=Technology&subdomain=Marketing from Hero/Category/Footer links)
  // to their canonical metadata IDs so FilterPanel and groupByDomainId match.
  useEffect(() => {
    if (!metadata) return;
    const updates: Partial<IExpertFilters> = {};
    if (filters.domain) {
      const matchedDomain = metadata.domains.find(
        (d) =>
          d.id === filters.domain ||
          d.name.toLowerCase() === filters.domain?.toLowerCase(),
      );
      if (matchedDomain && matchedDomain.id !== filters.domain) {
        updates.domain = matchedDomain.id;
      }
    }
    if (filters.subdomain) {
      const matchedSubdomain = metadata.subdomains.find(
        (s) =>
          s.id === filters.subdomain ||
          s.name.toLowerCase() === filters.subdomain?.toLowerCase(),
      );
      if (matchedSubdomain && matchedSubdomain.id !== filters.subdomain) {
        updates.subdomain = matchedSubdomain.id;
      }
    }
    if (Object.keys(updates).length > 0) {
      updateFilters(updates);
    }
  }, [metadata, filters.domain, filters.subdomain, updateFilters]);

  // Auto-scroll to #all-experts when landing on /explore/experts from a hero
  // search/selection, domain card, or #all-experts deep-link.
  const hasInitialScrollRef = useRef(false);
  useEffect(() => {
    if (hasInitialScrollRef.current) return;
    const params = new URLSearchParams(window.location.search);
    const hasFilterParam = [
      "search",
      "domain",
      "subdomain",
      "tags",
      "sort",
      "affiliationType",
      "orgKind",
      "orgSlug",
      "minPrice",
      "maxPrice",
      "minRating",
      "experience",
      "language",
      "companies",
    ].some((key) => params.has(key));
    if (window.location.hash === "#all-experts" || hasFilterParam) {
      hasInitialScrollRef.current = true;
      requestAnimationFrame(() => {
        browseSectionRef.current?.scrollIntoView({
          behavior: "smooth",
          block: "start",
        });
      });
    }
  }, []);

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
          style={{
            scrollMarginTop:
              "calc(var(--maintenance-banner-height, 0px) + var(--header-height, 5rem) + 1.5rem)",
          }}
        >
          <SectionHeader
            title="Browse Familiarise Experts"
            icon={<Search className="w-5 h-5 text-white" />}
          />

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
