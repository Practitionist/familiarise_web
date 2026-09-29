"use client";

import { useState } from "react";
import { Building2, SlidersHorizontal, Users, Zap } from "lucide-react";
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
import { SegmentedControl } from "@/components/ui/segmented-control";
import { SearchBar } from "./SearchBar";
import { FilterPanel } from "./FilterPanel";
import type {
  AffiliationType,
  IExpertFilters,
  IExpertsMetaData,
  OrgKind,
} from "../utils";

const AFFILIATION_TABS: {
  value: AffiliationType;
  label: string;
  icon: React.ElementType;
  countKey: "all" | "independent" | "agency";
}[] = [
  { value: null, label: "All Experts", icon: Users, countKey: "all" },
  { value: "independent", label: "Independent", icon: Zap, countKey: "independent" },
  { value: "agency", label: "Agency / Org", icon: Building2, countKey: "agency" },
];

const ORG_KIND_OPTIONS: { value: OrgKind; label: string }[] = [
  { value: "AGENCY", label: "Agency" },
  { value: "ENTERPRISE", label: "Enterprise" },
  { value: "SOLO_PRACTICE", label: "Solo practice" },
];

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
 * Replaces the 280px sidebar rail: Search + Sort + All/Independent/Agency tabs
 * (with per-tab counts) + org-kind sub-filter stay pinned under the fixed
 * global navbar (`sticky top-[var(--header-height)]`), while the full
 * FilterPanel lives in a Sheet (all viewports) so tall sliders/selects never
 * clip inside the sticky container. Plain div — never wrap in motion.*
 * (transform breaks sticky).
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
  const counts = metadata?.consultantMetadata.affiliationCounts;
  const orgKindCounts = metadata?.consultantMetadata.orgKindCounts;

  const selectAffiliation = (value: AffiliationType) => {
    // Leaving Agency/Org clears the org-kind sub-filter so it can't linger
    // as an invisible predicate on the other tabs.
    if (value !== "agency") {
      updateFilters({ affiliationType: value, orgKind: null, orgSlug: null });
    } else {
      updateFilters({ affiliationType: value });
    }
  };

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
      <div className="mx-auto max-w-[1400px] space-y-3 px-4 py-3 md:px-8 lg:px-12">
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
              <Button variant="outline" className="h-10 shrink-0 gap-2 px-3.5">
                <SlidersHorizontal className="h-4 w-4" />
                <span className="hidden sm:inline">Filters</span>
                {chips.length > 0 && (
                  // 10px -> text-xs, and the count is announced as "3 filters"
                  // rather than as a bare numeral glued to the button name.
                  <span className="tnum rounded-full bg-brand-subtle px-1.5 text-xs font-semibold text-brand-foreground-subtle">
                    {chips.length}
                    <span className="sr-only"> active filters</span>
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

        {/* Row 2: affiliation tabs (part of the settings panel) + org-kind */}
        <div className="flex flex-wrap items-center gap-2">
          {/* Was the 4th hand-rolled copy of this pattern in the app (the
              others: ProgramTabs with no roles, ExpertPricing and
              ClassesAndWebinars as layoutId springs). `role="group"` with
              `aria-pressed` is the accurate semantics — these filter the list
              in place, they do not switch tabpanels, so tablist would promise
              an arrow-key contract these do not honour. */}
          <SegmentedControl
            label="Affiliation"
            value={String(filters.affiliationType)}
            onChange={(v) => {
              const match = AFFILIATION_TABS.find(
                (t) => String(t.value) === v,
              );
              if (match) selectAffiliation(match.value);
            }}
            options={AFFILIATION_TABS.map(({ value, label, icon: Icon, countKey }) => {
              const count = counts?.[countKey];
              return {
                value: String(value),
                label: (
                  <>
                    <Icon className="h-3.5 w-3.5" aria-hidden="true" />
                    {label}
                  </>
                ),
                srSuffix:
                  typeof count === "number" ? `, ${count} available` : undefined,
              };
            })}
          />

          {filters.affiliationType === "agency" && (
            <div className="flex flex-wrap items-center gap-1.5">
              {ORG_KIND_OPTIONS.map((opt) => {
                const isActive = filters.orgKind === opt.value;
                const count = orgKindCounts?.[opt.value];
                // Disabled at zero: pre-migration (column not live yet) all
                // counts are 0, and filtering by orgKind then would 500
                // (P2022) instead of returning empty. The count is shown, so
                // this never hides a non-empty set behind a stale zero — the
                // metadata revalidates every 5 minutes.
                const disabled = !isActive && count === 0;
                return (
                  <button
                    key={opt.value}
                    aria-pressed={isActive}
                    disabled={disabled}
                    title={
                      disabled
                        ? "No experts in this category yet"
                        : undefined
                    }
                    onClick={() =>
                      updateFilters({
                        orgKind: isActive ? null : opt.value,
                      })
                    }
                    className={`inline-flex items-center gap-1 rounded-chip border px-2.5 py-1 text-xs font-medium transition-colors disabled:cursor-not-allowed disabled:opacity-50 ${
                      isActive
                        ? "border-brand-border bg-brand-subtle text-brand-foreground-subtle"
                        : "border-border bg-card text-muted-foreground hover:bg-muted hover:text-foreground"
                    }`}
                  >
                    {opt.label}
                    {typeof count === "number" && (
                      <span className="tabular-nums opacity-80">{count}</span>
                    )}
                  </button>
                );
              })}
            </div>
          )}

          {resultSummary && (
            <span className="tnum ml-auto text-sm text-muted-foreground">
              {resultSummary}
            </span>
          )}
        </div>

        {/* Row 3: active chips (stay visible while scrolling) */}
        {chips.length > 0 && (
          <FilterChips
            filters={chips}
            onRemove={onRemoveChip}
            onClearAll={onClearAll}
          />
        )}
      </div>
    </div>
  );
}
