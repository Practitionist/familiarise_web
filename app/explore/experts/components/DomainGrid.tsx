"use client";

import { Layers } from "lucide-react";

import {
  CategoryGrid,
  CategoryGridSkeleton,
} from "@/components/explore/CategoryGrid";

/**
 * A thin wrapper over the shared `CategoryGrid`.
 *
 * This and `programs/components/CategoryGrid.tsx` were 98 and 93 lines and
 * differed in exactly three things: the icon, the count noun, and the "view
 * all" label. The tile's class string was byte-identical between them, and so
 * were the `INITIAL_DISPLAY = 9` cap, the `+N more` arithmetic, the
 * `See all domains` / `See all categories` toggle and the skeleton.
 *
 * Kept as a named export because the experts page and its tests refer to
 * "Browse by Domain" as a distinct concept — the difference is now a prop.
 */
export function DomainGrid({
  domains,
  isLoading = false,
  onDomainSelect,
}: {
  domains: { id: string; name: string; count: number }[];
  isLoading?: boolean;
  onDomainSelect?: (name: string) => void;
}) {
  if (isLoading) return <CategoryGridSkeleton count={10} />;
  if (domains.length === 0) return null;

  // The shared grid hands back a category NAME (that is what a link needs);
  // the filter wants an ID. Both shapes are in hand here, so the mapping lives
  // in the shim rather than at each of the two call sites.
  const idByName = new Map(domains.map((d) => [d.name, d.id]));

  return (
    <CategoryGrid
      categories={domains}
      noun={["expert", "experts"]}
      icon={Layers}
      heading="Browse by domain"
      onSelect={(name) => {
        const id = idByName.get(name);
        if (id) onDomainSelect?.(id);
      }}
    />
  );
}

export default DomainGrid;
