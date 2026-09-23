"use client";

import { PlanLevel } from "@prisma/client";
import { useCallback, useMemo } from "react";
import {
  GraduationCap,
  Video,
  Users,
  ArrowDownRight,
  type LucideIcon,
} from "lucide-react";
import { useSession } from "@/lib/auth-client";
import { useCurrency } from "@/hooks/useCurrency";
import { type Program, type TopicWithCount } from "@/lib/explore/programs";
import {
  buildProgramHeroStats,
  type ProgramStatKey,
} from "@/lib/data/public-stats";
import {
  useCuratedPrograms,
  useInfiniteScroll,
  usePrograms,
  useProgramFilterChips,
  useProgramsFilters,
  useTopicsWithCount,
} from "./hooks";
import ProgramTabs from "./components/ProgramTabs";
import SectionHeader from "./components/SectionHeader";
import AdvancedFilters from "./components/AdvancedFilters";
import FilterChips from "./components/FilterChips";
import StaticTopRows from "./components/StaticTopRows";
import ProgramResults from "./components/ProgramResults";

interface ProgramStats {
  publishedClassCount: number;
  publishedWebinarCount: number;
  enrolledLearnerCount: number;
}

interface ProgramsInteractiveContentProps {
  initialTrending: Program[];
  initialNewest: Program[];
  initialTopics: TopicWithCount[];
  initialStats: ProgramStats | null;
  /** #664 — viewer's ACTIVE org memberships as { orgId: orgName }. */
  viewerOrgs?: Record<string, string>;
  /** Every level in the catalog, read server-side — not just loaded rows. */
  availableLevels?: PlanLevel[];
}

// #1490 — there is no FALLBACK_STATS any more. It rendered "500+ Classes
// Available", "200+ Live Webinars" and "25K+ Students Enrolled" whenever the
// stats read returned null, and the data path kept the "25K+" regardless, so
// that one was fabricated even when the others were real. A figure now either
// comes from the database or is not shown.
const PROGRAM_STAT_ICONS: Record<ProgramStatKey, LucideIcon> = {
  classes: GraduationCap,
  webinars: Video,
  learners: Users,
};

export default function ProgramsInteractiveContent({
  initialTrending,
  initialNewest,
  initialTopics,
  initialStats,
  viewerOrgs = {},
  availableLevels = [],
}: ProgramsInteractiveContentProps) {
  const { data: session } = useSession();
  const userId = session?.user?.id;
  const { formatPrice } = useCurrency();

  // All UI state lives in one hook so the orchestrator stays thin.
  const {
    programType,
    handleTabChange,
    filters,
    updateFilters,
    localSearchValue,
    onLocalSearchChange,
    selectedLevel,
    setSelectedLevel,
    viewMode,
    setViewMode,
    clearAll: clearAllFilters,
  } = useProgramsFilters();

  // Stats: server-fetched or absent. `null` means the read failed, and a hero
  // with no numbers is the honest rendering of "we could not count them".
  // No client useEffect — the RSC paid that cost.
  const stats = useMemo(
    () => (initialStats ? buildProgramHeroStats(initialStats) : []),
    [initialStats],
  );

  // Data hooks. Curated and topics are pre-warmed via initialData for the
  // default `programType === "all"` query keys; tab switches still trigger
  // normal client fetches via the existing query-key plumbing.
  const { programs, isLoading, hasMore, loadMore } = usePrograms(programType, {
    userId,
    filters,
  });

  const { programs: trendingPrograms, isLoading: trendingLoading } =
    useCuratedPrograms(
      programType,
      "trending",
      8,
      programType === "all" ? initialTrending : undefined,
    );

  const { programs: newPrograms, isLoading: newLoading } = useCuratedPrograms(
    programType,
    "newest",
    8,
    programType === "all" ? initialNewest : undefined,
  );

  const { topics: topicsWithCount, isLoading: topicsLoading } =
    useTopicsWithCount(
      programType,
      programType === "all" ? initialTopics : undefined,
    );

  // Sentinel-driven infinite scroll. Hook owns the IntersectionObserver
  // lifecycle, no per-render disconnect/reconnect.
  const sentinelRef = useInfiniteScroll({
    hasMore,
    isLoading,
    onLoadMore: loadMore,
  });

  // Active filter chips with structured-key removal.
  const clearSearch = useCallback(() => {
    onLocalSearchChange("");
  }, [onLocalSearchChange]);

  const {
    chips,
    removeChip,
    clearAll: clearAllChips,
  } = useProgramFilterChips({
    filters,
    topics: topicsWithCount,
    selectedLevel,
    searchTerm: filters.search ?? "",
    formatPrice,
    updateFilters,
    setSelectedLevel,
    clearSearch,
    clearAll: clearAllFilters,
  });

  // Use trending programs as featured (proxy until admin-flagged feature exists)
  const featuredPrograms = useMemo(
    () => trendingPrograms.slice(0, 5),
    [trendingPrograms],
  );

  const handleTopicSelect = useCallback(
    (topicId: string) => {
      updateFilters({
        topicIds: filters.topicIds?.includes(topicId)
          ? filters.topicIds
          : [...(filters.topicIds || []), topicId],
      });
      document
        .getElementById("all-programs")
        ?.scrollIntoView({ behavior: "smooth" });
    },
    [filters.topicIds, updateFilters],
  );

  // `programs` is already fully filtered by the API — search and level used to
  // be re-applied here over the loaded page only, which silently dropped
  // matches that lived on later pages.
  const filteredAndSortedPrograms = programs;

  const uniqueLevels = availableLevels;

  return (
    <main className="min-h-screen bg-background">
      {/* The two directories use the same visual rhythm while keeping their own data. */}
      <section className="explore-hero relative overflow-hidden pb-14 pt-28 text-white md:pb-20 md:pt-36">
        <div
          className="absolute inset-0 grid-pattern opacity-10"
          aria-hidden="true"
        />
        <div className="relative mx-auto grid max-w-[1600px] items-end gap-10 px-4 md:px-8 lg:grid-cols-[minmax(0,1fr)_auto] lg:gap-16 lg:px-12">
          <div className="max-w-3xl">
            <p className="mb-5 inline-flex items-center gap-2 text-xs font-semibold uppercase tracking-[0.2em] text-zinc-300">
              <span className="h-px w-8 bg-zinc-400" /> Familiarise programs
            </p>
            <h1 className="text-fluid-5xl font-semibold tracking-tight text-white">
              Learn with people who know the work.
            </h1>
            <p className="mt-6 max-w-2xl text-base leading-relaxed text-zinc-300 md:text-lg">
              Discover expert-led classes and live webinars designed to turn
              curiosity into useful skills.
            </p>
            <a
              href="#all-programs"
              className="mt-8 inline-flex items-center gap-2 rounded-full border border-white/25 px-5 py-3 text-sm font-medium text-white transition-colors hover:bg-white hover:text-zinc-950 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white"
            >
              Browse all programs{" "}
              <ArrowDownRight className="h-4 w-4" aria-hidden="true" />
            </a>
          </div>

          {stats.length > 0 ? (
            <div className="flex flex-wrap gap-6 border-t border-white/15 pt-6 lg:max-w-[360px] lg:justify-end lg:border-l lg:border-t-0 lg:pl-8 lg:pt-0">
              {stats.map((stat) => {
                const Icon = PROGRAM_STAT_ICONS[stat.key];
                return (
                  <div key={stat.key} className="min-w-[88px]">
                    <div className="mb-3 flex h-9 w-9 items-center justify-center rounded-lg border border-white/15 bg-white/5">
                      <Icon className="h-4 w-4 text-zinc-200" />
                    </div>
                    <div className="text-xl font-semibold text-white md:text-2xl">
                      {stat.display}
                    </div>
                    <div className="text-xs text-zinc-400">{stat.label}</div>
                  </div>
                );
              })}
            </div>
          ) : (
            <p className="border-t border-white/15 pt-6 text-sm text-zinc-400 lg:border-l lg:border-t-0 lg:pl-8 lg:pt-0">
              Check back for new classes and webinars.
            </p>
          )}
        </div>
      </section>

      {/* Content Section */}
      <section className="py-10 md:py-16">
        <div className="max-w-[1600px] mx-auto px-4 md:px-8 lg:px-12">
          {/* Tabs */}
          <div className="mb-10">
            <ProgramTabs
              activeTab={programType}
              onTabChange={handleTabChange}
            />
          </div>

          <StaticTopRows
            featuredPrograms={featuredPrograms}
            trendingPrograms={trendingPrograms}
            newPrograms={newPrograms}
            topics={topicsWithCount}
            trendingLoading={trendingLoading}
            newLoading={newLoading}
            topicsLoading={topicsLoading}
            onTopicSelect={handleTopicSelect}
          />

          {/* All Programs Section */}
          <div
            id="all-programs"
            className="explore-section scroll-mt-[calc(var(--header-height,5rem)+1rem)]"
          >
            <SectionHeader title="All Programs" />
            <p className="mb-7 text-sm text-muted-foreground md:text-base">
              Find a class or webinar that fits your goals, schedule, and
              experience.
            </p>

            {/* Advanced Filters */}
            <div className="mb-8">
              <AdvancedFilters
                filters={filters}
                onFiltersChange={updateFilters}
                localSearch={localSearchValue}
                onLocalSearchChange={onLocalSearchChange}
                selectedLevel={selectedLevel}
                onLevelChange={setSelectedLevel}
                uniqueLevels={uniqueLevels}
                viewMode={viewMode}
                onViewModeChange={setViewMode}
                topics={topicsWithCount}
              />
            </div>

            {/* Active Filter Chips */}
            {chips.length > 0 && (
              <div className="mb-6">
                <FilterChips
                  filters={chips}
                  onRemove={removeChip}
                  onClearAll={clearAllChips}
                />
              </div>
            )}

            <ProgramResults
              programs={filteredAndSortedPrograms}
              isLoading={isLoading}
              viewMode={viewMode}
              sentinelRef={sentinelRef}
              viewerOrgs={viewerOrgs}
            />
          </div>
        </div>
      </section>
    </main>
  );
}
