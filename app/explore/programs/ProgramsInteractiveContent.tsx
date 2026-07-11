"use client";

import { useCallback, useMemo } from "react";
import { motion } from "framer-motion";
import { GraduationCap, Video, Users } from "lucide-react";
import { useSession } from "@/lib/auth-client";
import { useCurrency } from "@/hooks/useCurrency";
import {
  filterAndSortPrograms,
  getUniqueLevels,
  type Program,
  type TopicWithCount,
} from "./utils";
import {
  useCuratedPrograms,
  useInfiniteScroll,
  usePrograms,
  useProgramFilterChips,
  useProgramsFilters,
  useTopicsWithCount,
} from "./hooks";
import { ExploreHero } from "../components/ExploreHero";
import ProgramTabs from "./components/ProgramTabs";
import SectionHeader from "@/app/explore/components/SectionHeader";
import AdvancedFilters from "./components/AdvancedFilters";
import FilterChips from "@/app/explore/components/FilterChips";
import StaticTopRows from "./components/StaticTopRows";
import ProgramResults from "./components/ProgramResults";

interface ProgramStats {
  classCount: number;
  webinarCount: number;
}

interface ProgramsInteractiveContentProps {
  initialTrending: Program[];
  initialNewest: Program[];
  initialTopics: TopicWithCount[];
  initialStats: ProgramStats | null;
}

const FALLBACK_STATS = [
  { icon: GraduationCap, value: "500+", label: "Classes Available" },
  { icon: Video, value: "200+", label: "Live Webinars" },
  { icon: Users, value: "25K+", label: "Students Enrolled" },
];

function buildStatsFromData(data: ProgramStats) {
  return [
    {
      icon: GraduationCap,
      value: `${data.classCount || 0}`,
      label: "Classes Available",
    },
    {
      icon: Video,
      value: `${data.webinarCount || 0}`,
      label: "Live Webinars",
    },
    { icon: Users, value: "25K+", label: "Students Enrolled" },
  ];
}

export default function ProgramsInteractiveContent({
  initialTrending,
  initialNewest,
  initialTopics,
  initialStats,
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
    searchTerm,
    localSearchValue,
    onLocalSearchChange,
    selectedLevel,
    setSelectedLevel,
    viewMode,
    setViewMode,
    clearAll: clearAllFilters,
  } = useProgramsFilters();

  // Stats: render server-fetched value if present, otherwise marketing
  // fallbacks. No client useEffect — the RSC paid that cost.
  const stats = useMemo(
    () => (initialStats ? buildStatsFromData(initialStats) : FALLBACK_STATS),
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

  const { chips, removeChip, clearAll: clearAllChips } = useProgramFilterChips({
    filters,
    topics: topicsWithCount,
    selectedLevel,
    searchTerm,
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

  const filteredAndSortedPrograms = useMemo(
    () => filterAndSortPrograms(programs, searchTerm, selectedLevel),
    [programs, searchTerm, selectedLevel],
  );

  const uniqueLevels = useMemo(() => getUniqueLevels(programs), [programs]);

  return (
    <main className="min-h-screen bg-background">
      {/* Hero Section */}
      <ExploreHero
        badge="Learn from the Best"
        title={
          <>
            Classes & <span className="silver-text">Webinars</span>
          </>
        }
        description="Expand your knowledge with expert-led classes and live webinars. Learn at your own pace or join interactive sessions."
        stats={stats}
      />

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
          <div id="all-programs">
            <SectionHeader title="All Programs" />

            {/* Advanced Filters */}
            <motion.div
              className="mb-8"
              initial={{ opacity: 0, y: 20 }}
              whileInView={{ opacity: 1, y: 0 }}
              viewport={{ once: true }}
              transition={{ duration: 0.5 }}
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
              />
            </motion.div>

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
            />
          </div>
        </div>
      </section>
    </main>
  );
}
