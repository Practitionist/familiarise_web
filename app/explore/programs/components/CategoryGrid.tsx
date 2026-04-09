"use client";

import { memo, useState } from "react";
import { Hash, ChevronDown, ChevronUp } from "lucide-react";
import { TopicWithCount } from "../utils";

interface CategoryGridProps {
  topics: TopicWithCount[];
  isLoading?: boolean;
  onTopicSelect: (topicId: string) => void;
}

const INITIAL_DISPLAY = 9;

function SkeletonCard() {
  return (
    <div className="rounded-xl border border-zinc-200 p-5 animate-pulse">
      <div className="w-10 h-10 bg-zinc-200 rounded-lg mb-3" />
      <div className="h-5 bg-zinc-200 rounded w-3/4 mb-2" />
      <div className="h-4 bg-zinc-100 rounded w-1/2" />
    </div>
  );
}

function CategoryGridImpl({
  topics,
  isLoading,
  onTopicSelect,
}: CategoryGridProps) {
  const [expanded, setExpanded] = useState(false);

  if (isLoading) {
    return (
      <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5 gap-4">
        {Array.from({ length: 6 }).map((_, i) => (
          <SkeletonCard key={i} />
        ))}
      </div>
    );
  }

  if (topics.length === 0) return null;

  const displayed = expanded ? topics : topics.slice(0, INITIAL_DISPLAY);
  const hasMore = topics.length > INITIAL_DISPLAY;

  return (
    <div>
      <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5 gap-4">
        {displayed.map((topic) => (
          <button
            key={topic.id}
            onClick={() => onTopicSelect(topic.id)}
            className="group text-left rounded-xl border border-zinc-200 bg-white p-5 hover:border-zinc-300 hover:shadow-md transition-all duration-200"
          >
            <div className="w-10 h-10 rounded-lg bg-zinc-100 group-hover:bg-zinc-900 flex items-center justify-center mb-3 transition-colors">
              <Hash className="w-5 h-5 text-zinc-500 group-hover:text-white transition-colors" />
            </div>
            <h3 className="font-semibold text-zinc-900 text-sm mb-1 line-clamp-1">
              {topic.name}
            </h3>
            <p className="text-xs text-zinc-500">
              {topic.programCount}{" "}
              {topic.programCount === 1 ? "program" : "programs"}
            </p>
          </button>
        ))}
      </div>

      {hasMore && (
        <div className="flex justify-center mt-6">
          <button
            onClick={() => setExpanded(!expanded)}
            className="inline-flex items-center gap-2 px-5 py-2.5 text-sm font-medium text-zinc-600 bg-zinc-100 rounded-lg hover:bg-zinc-200 transition-colors"
          >
            {expanded ? (
              <>
                Show Less <ChevronUp className="w-4 h-4" />
              </>
            ) : (
              <>
                View All Categories <ChevronDown className="w-4 h-4" />
              </>
            )}
          </button>
        </div>
      )}
    </div>
  );
}

const CategoryGrid = memo(CategoryGridImpl);
export default CategoryGrid;
