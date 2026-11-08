"use client";

import { useState } from "react";
import { SlidersHorizontal } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
  SheetTrigger,
} from "@/components/ui/sheet";
import FilterChips, {
  type ActiveFilter,
} from "@/app/explore/components/FilterChips";
import { SearchBar } from "./SearchBar";
import { FilterPanel } from "./FilterPanel";
import type { IExpertFilters, IExpertsMetaData } from "../utils";

interface StickyFilterBarProps {
  metadata: IExpertsMetaData | null;
  filters: IExpertFilters;
  updateFilters: (partial: Partial<IExpertFilters>) => void;
  chips: ActiveFilter[];
  onRemoveChip: (key: string) => void;
  onClearAll: () => void;
  resultSummary?: string;
}

/**
 * Compact sticky settings navbar for the explore-experts listing.
 *
 * Replaces the 280px sidebar rail: Search + Sort + the Filters button, with the
 * result count and active-filter chips beneath, stay pinned under the fixed
 * global navbar (`sticky top-[var(--header-height)]`). Every facet, expert type
 * (All / Independent / Agency-Org) included, lives in the Filters sheet (all
 * viewports) so tall sliders/selects never clip inside the sticky container.
 * Plain div — never wrap in motion.* (transform breaks sticky).
 */
export default function StickyFilterBar({
  metadata,
  filters,
  updateFilters,
  chips,
  onRemoveChip,
  onClearAll,
  resultSummary,
}: Readonly<StickyFilterBarProps>) {
  const [advancedOpen, setAdvancedOpen] = useState(false);

  return (
    <div
      className="sticky z-30 ml-[calc(50%-50vw)] w-[100vw] border-b border-border bg-background/80 backdrop-blur-xl"
      // Flush under the fixed header stack (banner + announcement/navbar
      // height, no gap) and full viewport width via the margin breakout;
      // inner content stays aligned to the page container. Same offset
      // formula as the FacetRail sidebar — one formula, nothing to measure.
      style={{
        top: "calc(var(--maintenance-banner-height, 0px) + var(--header-height, 5rem))",
      }}
    >
      <div className="mx-auto max-w-[1600px] space-y-3 px-4 py-3 md:px-8 lg:px-12">
        {/* Row 1: search + advanced-filters trigger */}
        <div className="flex items-center gap-3">
          <div className="min-w-0 flex-1">
            <SearchBar
              onSearch={(term) => updateFilters({ search: term })}
              onSort={(option) => updateFilters({ sort: option })}
              sortBy={filters.sort}
              initialSearch={filters.search}
            />
          </div>
          <Sheet open={advancedOpen} onOpenChange={setAdvancedOpen}>
            <SheetTrigger asChild>
              <Button
                variant="outline"
                aria-label="Filters"
                className="h-14 shrink-0 gap-2 px-4"
              >
                <SlidersHorizontal className="h-4 w-4" />
                <span className="hidden sm:inline">Filters</span>
                {chips.length > 0 && (
                  <span className="rounded-full bg-primary px-1.5 py-0.5 text-[10px] font-semibold tabular-nums text-primary-foreground">
                    {chips.length}
                  </span>
                )}
              </Button>
            </SheetTrigger>
            <SheetContent
              side="left"
              className="w-[88%] max-w-sm overflow-y-auto"
            >
              <SheetHeader>
                <SheetTitle>Filters</SheetTitle>
              </SheetHeader>
              <div className="mt-4 px-6 pb-8">
                <FilterPanel
                  metadata={metadata}
                  filters={filters}
                  updateFilters={updateFilters}
                />
              </div>
            </SheetContent>
          </Sheet>
        </div>

        {/* Row 2: how many, then what is narrowing it (chips stay visible
            while scrolling) */}
        {(resultSummary || chips.length > 0) && (
          <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
            {resultSummary && (
              <span className="text-sm text-muted-foreground">
                {resultSummary}
              </span>
            )}
            {chips.length > 0 && (
              <FilterChips
                filters={chips}
                onRemove={onRemoveChip}
                onClearAll={onClearAll}
              />
            )}
          </div>
        )}
      </div>
    </div>
  );
}
