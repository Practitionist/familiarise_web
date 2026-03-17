"use client";

import {
  GraduationCap,
  Video,
  Users,
  Sparkles,
  Search,
  Flame,
  Clock,
  Hash,
} from "lucide-react";
import { motion } from "framer-motion";
import { useSession } from "@/lib/auth-client";
import { useRouter, useSearchParams } from "next/navigation";
import { useCallback, useMemo, useRef, useState, Suspense } from "react";
import { useDebouncedCallback } from "use-debounce";
import { useCurrency } from "@/hooks/useCurrency";
import { usePrograms, useCuratedPrograms, useTopicsWithCount } from "./hooks";
import {
  filterAndSortPrograms,
  getUniqueLevels,
  Program,
  ProgramType,
  ProgramFilters,
} from "./utils";
import ProgramCard from "./components/ProgramCard";
import ProgramTabs from "./components/ProgramTabs";
import SectionHeader from "./components/SectionHeader";
import FeaturedCarousel from "./components/FeaturedCarousel";
import ProgramRow from "./components/ProgramRow";
import CategoryGrid from "./components/CategoryGrid";
import AdvancedFilters from "./components/AdvancedFilters";
import FilterChips, { ActiveFilter } from "./components/FilterChips";

const STATS = [
  { icon: GraduationCap, value: "500+", label: "Classes Available" },
  { icon: Video, value: "200+", label: "Live Webinars" },
  { icon: Users, value: "25K+", label: "Students Enrolled" },
];

function ProgramsContent() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const { data: session } = useSession();
  const userId = session?.user?.id;
  const { formatPrice } = useCurrency();

  // Tab state from URL
  const tabParam = searchParams.get("tab");
  const [programType, setProgramType] = useState<ProgramType>(
    (tabParam as ProgramType) || "all",
  );

  // Filter state
  const [searchTerm, setSearchTerm] = useState("");
  const [localSearchValue, setLocalSearchValue] = useState("");
  const [selectedLevel, setSelectedLevel] = useState("all");
  const [viewMode, setViewMode] = useState<"list" | "grid">("grid");
  const [filters, setFilters] = useState<ProgramFilters>({});
  const observer = useRef<IntersectionObserver>();

  const debouncedSetSearch = useDebouncedCallback((value: string) => {
    setSearchTerm(value);
  }, 300);

  // Update URL when tab changes
  const handleTabChange = useCallback(
    (tab: ProgramType) => {
      setProgramType(tab);
      const params = new URLSearchParams(searchParams.toString());
      if (tab === "all") {
        params.delete("tab");
      } else {
        params.set("tab", tab);
      }
      const qs = params.toString();
      router.replace(`/explore/programs${qs ? `?${qs}` : ""}`, {
        scroll: false,
      });
    },
    [router, searchParams],
  );

  const handleFiltersChange = useCallback(
    (partial: Partial<ProgramFilters>) => {
      setFilters((prev) => ({ ...prev, ...partial }));
    },
    [],
  );

  // Data hooks
  const { programs, isLoading, hasMore, loadMore } = usePrograms(programType, {
    userId,
    filters,
  });

  const { programs: trendingPrograms, isLoading: trendingLoading } =
    useCuratedPrograms(programType, "trending", 8);

  const { programs: newPrograms, isLoading: newLoading } = useCuratedPrograms(
    programType,
    "newest",
    8,
  );

  const { topics: topicsWithCount, isLoading: topicsLoading } =
    useTopicsWithCount(programType);

  // Build active filter chips
  const activeFilterChips = useMemo(() => {
    const chips: ActiveFilter[] = [];
    if (filters.topicIds && filters.topicIds.length > 0) {
      filters.topicIds.forEach((id) => {
        const topic = topicsWithCount.find((t) => t.id === id);
        if (topic) {
          chips.push({
            key: `topic-${id}`,
            label: "Topic",
            value: topic.name,
          });
        }
      });
    }
    if (filters.language) {
      chips.push({
        key: "language",
        label: "Language",
        value: filters.language,
      });
    }
    if (filters.minPrice !== undefined || filters.maxPrice !== undefined) {
      const min = filters.minPrice ?? 0;
      const max = filters.maxPrice;
      const label =
        min === 0 && max === 0
          ? "Free"
          : max === undefined
            ? `${formatPrice(min)}+`
            : `${formatPrice(min)} - ${formatPrice(max)}`;
      chips.push({ key: "price", label: "Price", value: label });
    }
    if (filters.sort) {
      const sortLabels: Record<string, string> = {
        trending: "Most Popular",
        newest: "Newest",
        "price-asc": "Price Low-High",
        "price-desc": "Price High-Low",
        "title-asc": "Title A-Z",
        "title-desc": "Title Z-A",
      };
      chips.push({
        key: "sort",
        label: "Sort",
        value: sortLabels[filters.sort] || filters.sort,
      });
    }
    if (selectedLevel !== "all") {
      chips.push({ key: "level", label: "Level", value: selectedLevel });
    }
    if (searchTerm) {
      chips.push({ key: "search", label: "Search", value: searchTerm });
    }
    return chips;
  }, [filters, topicsWithCount, selectedLevel, searchTerm, formatPrice]);

  const handleRemoveFilter = useCallback((key: string) => {
    if (key.startsWith("topic-")) {
      const topicId = key.replace("topic-", "");
      setFilters((prev) => ({
        ...prev,
        topicIds: prev.topicIds?.filter((id) => id !== topicId),
      }));
    } else if (key === "language") {
      setFilters((prev) => ({ ...prev, language: undefined }));
    } else if (key === "price") {
      setFilters((prev) => ({
        ...prev,
        minPrice: undefined,
        maxPrice: undefined,
      }));
    } else if (key === "sort") {
      setFilters((prev) => ({ ...prev, sort: undefined }));
    } else if (key === "level") {
      setSelectedLevel("all");
    } else if (key === "search") {
      setSearchTerm("");
      setLocalSearchValue("");
    }
  }, []);

  const handleClearAll = useCallback(() => {
    setFilters({});
    setSelectedLevel("all");
    setSearchTerm("");
    setLocalSearchValue("");
  }, []);

  // Handle topic selection from category grid
  const handleTopicSelect = useCallback((topicId: string) => {
    setFilters((prev) => {
      const current = prev.topicIds || [];
      if (current.includes(topicId)) return prev;
      return { ...prev, topicIds: [...current, topicId] };
    });
    document
      .getElementById("all-programs")
      ?.scrollIntoView({ behavior: "smooth" });
  }, []);

  // Use trending programs as featured (proxy until admin-flagged feature exists)
  const featuredPrograms = trendingPrograms.slice(0, 5);

  const lastElementRef = useCallback(
    (node: HTMLDivElement) => {
      if (isLoading) return;
      if (observer.current) observer.current.disconnect();
      observer.current = new IntersectionObserver((entries) => {
        if (entries[0].isIntersecting && hasMore) {
          loadMore();
        }
      });
      if (node) observer.current.observe(node);
    },
    [isLoading, hasMore, loadMore],
  );

  const filteredAndSortedPrograms = useMemo(
    () => filterAndSortPrograms(programs, searchTerm, selectedLevel),
    [programs, searchTerm, selectedLevel],
  );

  const uniqueLevels = useMemo(() => getUniqueLevels(programs), [programs]);

  return (
    <main className="min-h-screen bg-white">
      {/* Hero Section */}
      <section className="relative pt-32 pb-20 bg-zinc-950 overflow-hidden">
        <div className="absolute inset-0">
          <div className="absolute top-1/4 left-1/4 w-[600px] h-[600px] bg-zinc-800/30 rounded-full blur-[120px] animate-blob" />
          <div className="absolute bottom-1/4 right-1/4 w-[500px] h-[500px] bg-zinc-700/20 rounded-full blur-[100px] animate-blob animation-delay-2000" />
        </div>
        <div className="absolute inset-0 grid-pattern opacity-20" />

        <div className="max-w-[1600px] mx-auto px-4 md:px-8 lg:px-12 relative z-10">
          <motion.div
            className="max-w-4xl mx-auto text-center"
            initial={{ opacity: 0, y: 30 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.6 }}
          >
            <div className="inline-flex items-center gap-2 px-4 py-2 bg-zinc-800/50 backdrop-blur-sm border border-zinc-700/50 rounded-full mb-8">
              <Sparkles className="w-4 h-4 text-white" />
              <span className="text-sm font-medium text-zinc-300">
                Learn from the Best
              </span>
            </div>

            <h1 className="text-4xl md:text-5xl lg:text-6xl font-bold text-white mb-6">
              Classes & <span className="silver-text">Webinars</span>
            </h1>

            <p className="text-lg md:text-xl text-zinc-400 mb-12 max-w-2xl mx-auto">
              Expand your knowledge with expert-led classes and live webinars.
              Learn at your own pace or join interactive sessions.
            </p>

            <div className="flex flex-wrap justify-center gap-8 md:gap-16">
              {STATS.map((stat, index) => (
                <motion.div
                  key={stat.label}
                  className="text-center"
                  initial={{ opacity: 0, y: 20 }}
                  animate={{ opacity: 1, y: 0 }}
                  transition={{ duration: 0.5, delay: 0.2 + index * 0.1 }}
                >
                  <div className="w-12 h-12 mx-auto mb-3 rounded-xl bg-zinc-800/50 border border-zinc-700/50 flex items-center justify-center">
                    <stat.icon className="w-6 h-6 text-white" />
                  </div>
                  <div className="text-2xl md:text-3xl font-bold text-white">
                    {stat.value}
                  </div>
                  <div className="text-sm text-zinc-500">{stat.label}</div>
                </motion.div>
              ))}
            </div>
          </motion.div>
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

          {/* Featured Carousel */}
          <div className="mb-14">
            <SectionHeader
              title="Familiarise Featured"
              icon={<Sparkles className="w-5 h-5 text-white" />}
            />
            <FeaturedCarousel
              programs={featuredPrograms}
              isLoading={trendingLoading}
            />
          </div>

          {/* Trending Now */}
          <div className="mb-14">
            <SectionHeader
              title="Trending Now"
              icon={<Flame className="w-5 h-5 text-white" />}
              seeAllHref="/explore/programs?sort=trending"
            />
            <ProgramRow
              programs={trendingPrograms}
              badge="trending"
              isLoading={trendingLoading}
            />
          </div>

          {/* Newly Added */}
          <div className="mb-14">
            <SectionHeader
              title="Newly Added"
              icon={<Clock className="w-5 h-5 text-white" />}
              seeAllHref="/explore/programs?sort=newest"
            />
            <ProgramRow
              programs={newPrograms}
              badge="new"
              isLoading={newLoading}
            />
          </div>

          {/* Browse by Category */}
          <div className="mb-14">
            <SectionHeader
              title="Browse by Category"
              icon={<Hash className="w-5 h-5 text-white" />}
            />
            <CategoryGrid
              topics={topicsWithCount}
              isLoading={topicsLoading}
              onTopicSelect={handleTopicSelect}
            />
          </div>

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
                onFiltersChange={handleFiltersChange}
                localSearch={localSearchValue}
                onLocalSearchChange={(value) => {
                  setLocalSearchValue(value);
                  debouncedSetSearch(value);
                }}
                selectedLevel={selectedLevel}
                onLevelChange={setSelectedLevel}
                uniqueLevels={uniqueLevels}
                viewMode={viewMode}
                onViewModeChange={setViewMode}
                topics={topicsWithCount}
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

            {/* Programs Grid/List */}
            {viewMode === "grid" ? (
              <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-6">
                {filteredAndSortedPrograms.map(
                  (item: Program, index: number) => (
                    <motion.div
                      key={item.id}
                      ref={
                        index === filteredAndSortedPrograms.length - 1
                          ? lastElementRef
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
                      <ProgramCard program={item} variant="grid" />
                    </motion.div>
                  ),
                )}
              </div>
            ) : (
              <div className="space-y-4">
                {filteredAndSortedPrograms.map(
                  (item: Program, index: number) => (
                    <motion.div
                      key={item.id}
                      ref={
                        index === filteredAndSortedPrograms.length - 1
                          ? lastElementRef
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
                      <ProgramCard program={item} variant="list" />
                    </motion.div>
                  ),
                )}
              </div>
            )}

            {/* Empty State */}
            {filteredAndSortedPrograms.length === 0 && !isLoading && (
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
                  No programs found
                </h3>
                <p className="text-zinc-500 max-w-md mx-auto">
                  Try adjusting your filters or search terms to discover more
                  programs
                </p>
              </motion.div>
            )}

            {/* Loading State */}
            {isLoading && (
              <div className="flex items-center justify-center py-12">
                <div className="flex items-center gap-3">
                  <div className="w-8 h-8 border-3 border-zinc-200 border-t-zinc-900 rounded-full animate-spin" />
                  <span className="text-zinc-500">Loading programs...</span>
                </div>
              </div>
            )}
          </div>
        </div>
      </section>
    </main>
  );
}

export default function Programs() {
  return (
    <Suspense
      fallback={
        <main className="min-h-screen bg-white">
          <div className="flex items-center justify-center py-32">
            <div className="w-8 h-8 border-3 border-zinc-200 border-t-zinc-900 rounded-full animate-spin" />
          </div>
        </main>
      }
    >
      <ProgramsContent />
    </Suspense>
  );
}
