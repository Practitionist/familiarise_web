"use client";

import { memo } from "react";
import { Sparkles, Hash } from "lucide-react";
import type { Program, TopicWithCount } from "@/lib/explore/programs";
import SectionHeader from "./SectionHeader";
import FeaturedCarousel from "./FeaturedCarousel";
import CategoryGrid from "./CategoryGrid";

interface StaticTopRowsProps {
  featuredPrograms: Program[];
  topics: TopicWithCount[];
  trendingLoading: boolean;
  topicsLoading: boolean;
  onTopicSelect: (topicId: string) => void;
}

/**
 * The "above the fold" rows that depend only on RSC-pre-warmed curated
 * data: Featured carousel + Browse by Category grid.
 *
 * Trending / Newly Added rows were removed: both orders already exist as
 * Sort options (Most Popular / Newest) in the All Programs filter bar, so
 * the rails only pushed the filterable grid further down the page.
 *
 * Memoized so filter mutations on the all-programs section can never
 * re-render any of these.
 */
function StaticTopRowsImpl({
  featuredPrograms,
  topics,
  trendingLoading,
  topicsLoading,
  onTopicSelect,
}: StaticTopRowsProps) {
  return (
    <>
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

      {/* Browse by Category — doubles as the topic-filter on-ramp. */}
      <div className="mb-14">
        <SectionHeader
          title="Browse by Category"
          icon={<Hash className="w-5 h-5 text-white" />}
        />
        <CategoryGrid
          topics={topics}
          isLoading={topicsLoading}
          onTopicSelect={onTopicSelect}
        />
      </div>
    </>
  );
}

const StaticTopRows = memo(StaticTopRowsImpl);
export default StaticTopRows;
