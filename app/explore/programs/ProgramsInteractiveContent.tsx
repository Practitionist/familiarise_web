"use client";

import { PlanLevel } from "@prisma/client";
import { useCallback, useMemo } from "react";
import { motion } from "framer-motion";
import { Sparkles } from "lucide-react";
import { useSession } from "@/lib/auth-client";
import { useCurrency } from "@/hooks/useCurrency";
import { type Program, type TopicWithCount } from "@/lib/explore/programs";
import { buildProgramHeroStats } from "@/lib/data/public-stats";
import {
  useCuratedPrograms,
  useInfiniteScroll,
  usePrograms,
  useProgramFilterChips,
  useProgramsFilters,
  useTopicsWithCount,
} from "./hooks";
import ProgramTabs from "./components/ProgramTabs";
import AdvancedFilters from "./components/AdvancedFilters";
import FilterChips from "./components/FilterChips";
import StaticTopRows from "./components/StaticTopRows";
import ProgramResults from "./components/ProgramResults";
import {
  ExploreHeader,
  ExploreShell,
  ExploreStat,
} from "@/components/explore/ExploreShell";

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

  // #1490's rule, applied to the listing: the total is only honest when no
  // filter is narrowing the set.
  const resultSummary = useMemo(() => {
    // `stats` is an array of { key, value, display, label }. Summing `value`
    // gives the real catalogue total; it is a count of PUBLISHED plans, so it
    // only matches the rows on screen when nothing is filtered.
    const total = stats?.reduce((sum, s) => sum + s.value, 0) ?? 0;
    if (total === 0) return null;
    if (chips.length === 0) return `${total} programs`;
    return `${filteredAndSortedPrograms.length} matching`;
  }, [stats, chips.length, filteredAndSortedPrograms.length]);

  return (
    <main className="min-h-screen bg-background">
      {/* Hero band.
          Was a hand-rolled slab: `bg-zinc-950`, two 600px `blur-[120px]`
          `animate-blob` orbs, a `grid-pattern` overlay, a `rounded-full`
          `bg-zinc-800/50` pill, `text-zinc-300/400/500` for the three text
          roles, and a `text-4xl md:text-5xl lg:text-6xl` h1 that shared no
          tracking or scale with the experts page beside it.

          All of that is now `ExploreHeader` + one `--surface-inverse` token, so
          the two listings cannot drift again and the dark band re-themes with
          the direction instead of being hard-coded to near-black. The orbs are
          `--brand` at low alpha, which is why they now read as brand-tinted
          rather than as grey smudge. */}
      <section className="relative overflow-hidden border-b border-border-subtle bg-surface-inverse">
        <div aria-hidden="true" className="absolute inset-0">
          <div className="absolute -left-24 -top-24 h-[480px] w-[480px] rounded-full bg-brand/15 blur-[120px] motion-reduce:hidden" />
          <div className="absolute -bottom-32 -right-16 h-[420px] w-[420px] rounded-full bg-brand/10 blur-[110px] motion-reduce:hidden" />
        </div>
        <div className="relative py-12 md:py-16">
          <ExploreShell width="wide">
            <motion.div
              initial={{ opacity: 0, y: 20 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ duration: 0.5 }}
            >
              <ExploreHeader
                tone="dark"
                eyebrow={
                  <span className="inline-flex items-center gap-1.5">
                    <Sparkles className="h-3.5 w-3.5" aria-hidden="true" />
                    Learn from the best
                  </span>
                }
                title={
                  <>
                    Classes &amp; <span className="text-brand">webinars</span>
                  </>
                }
                description="Expert-led classes and live webinars. Learn at your own pace, or join an interactive session."
                meta={
                  stats.length > 0
                    ? stats.map((stat) => {
                        return (
                          <ExploreStat
                            key={stat.key}
                            tone="dark"
                            value={stat.display}
                            label={stat.label}
                          />
                        );
                      })
                    : undefined
                }
              />
              {stats.length === 0 && (
                <p className="mt-6 text-sm text-white/50">
                  Check back for new classes and webinars.
                </p>
              )}
            </motion.div>
          </ExploreShell>
        </div>
      </section>

      {/* Content Section */}
      <section className="py-10 md:py-16">
        <ExploreShell width="wide">
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

          {/* All Programs Section. The nav deep-links to #all-programs, so it
              clears the fixed header and the tabs above it. */}
          <div
            id="all-programs"
            className="scroll-mt-[calc(var(--header-height,5rem)+5rem)]"
          >
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
              resultSummary={resultSummary}
              activeFilterCount={chips.length}
            />

            {/* Active Filter Chips */}
            {chips.length > 0 && (
              <div className="mt-4">
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
        </ExploreShell>
      </section>
    </main>
  );
}
