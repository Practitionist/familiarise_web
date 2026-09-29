"use client";

import { Hash } from "lucide-react";

import {
  CategoryGrid as SharedCategoryGrid,
  CategoryGridSkeleton,
} from "@/components/explore/CategoryGrid";

/**
 * A thin wrapper over the shared `CategoryGrid` — the twin of
 * `experts/components/DomainGrid.tsx`. The two were 98 and 93 lines differing
 * only by icon, count noun and "view all" label; now `noun` is a prop.
 */
export function CategoryGrid({
  topics,
  isLoading = false,
  onTopicSelect,
}: {
  topics: { id: string; name: string; count: number }[];
  isLoading?: boolean;
  onTopicSelect?: (name: string) => void;
}) {
  if (isLoading) return <CategoryGridSkeleton count={10} />;
  if (topics.length === 0) return null;

  // Name → id, for the same reason as the experts shim: the shared grid links
  // by name, the filter takes an id.
  const idByName = new Map(topics.map((t) => [t.name, t.id]));

  return (
    <SharedCategoryGrid
      categories={topics}
      noun={["program", "programs"]}
      icon={Hash}
      heading="Browse by category"
      onSelect={(name) => {
        const id = idByName.get(name);
        if (id) onTopicSelect?.(id);
      }}
    />
  );
}

export default CategoryGrid;
