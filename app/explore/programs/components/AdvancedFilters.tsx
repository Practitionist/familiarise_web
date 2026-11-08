"use client";

import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { ChevronsUpDown, Search, X } from "lucide-react";
import { TopicWithCount, ProgramFilters } from "@/lib/explore/programs";
import { planLevelLabel } from "@/lib/labels/plan-labels";
import { useCurrency } from "@/hooks/useCurrency";
import { PlanLevel } from "@prisma/client";
import { memo, useState } from "react";

interface AdvancedFiltersProps {
  filters: ProgramFilters;
  onFiltersChange: (filters: Partial<ProgramFilters>) => void;
  localSearch: string;
  onLocalSearchChange: (value: string) => void;
  selectedLevel: string;
  onLevelChange: (level: string) => void;
  uniqueLevels: PlanLevel[];
  languages: string[];
  topics: TopicWithCount[];
}

/** Bounds in paise, the unit prices are stored and filtered in. */
const PRICE_BANDS = [
  { value: "0-0", min: 0, max: 0 },
  { value: "0-50000", min: 0, max: 50_000 },
  { value: "50000-200000", min: 50_000, max: 200_000 },
  { value: "200000-500000", min: 200_000, max: 500_000 },
  { value: "500000-", min: 500_000, max: undefined },
] as const;

const FIELD_LABEL =
  "mb-1.5 block text-xs font-medium uppercase tracking-wide text-muted-foreground";
const FIELD_TRIGGER = "h-11 rounded-xl border-border bg-card focus:ring-ring";

function AdvancedFiltersImpl({
  filters,
  onFiltersChange,
  localSearch,
  onLocalSearchChange,
  selectedLevel,
  onLevelChange,
  uniqueLevels,
  languages,
  topics,
}: AdvancedFiltersProps) {
  const { formatPrice } = useCurrency();
  const [topicQuery, setTopicQuery] = useState("");

  const selectedTopicIds = filters.topicIds ?? [];

  const priceFilterActive =
    filters.minPrice !== undefined || filters.maxPrice !== undefined;
  const activeBand = PRICE_BANDS.find(
    (b) => b.min === (filters.minPrice ?? 0) && b.max === filters.maxPrice,
  );
  // A range that is no band (an old bookmark, a hand-edited URL) still filters,
  // so it is shown as selected rather than as "Any price".
  const currentPriceRange = !priceFilterActive
    ? "all"
    : (activeBand?.value ?? "custom");

  const rangeLabel = (min: number, max: number | undefined) => {
    if (max === 0) return "Free";
    if (min === 0 && max !== undefined) return `Under ${formatPrice(max)}`;
    if (max === undefined) return `${formatPrice(min)}+`;
    return `${formatPrice(min)} – ${formatPrice(max)}`;
  };

  const handlePriceChange = (value: string) => {
    if (value === "all") {
      onFiltersChange({ minPrice: undefined, maxPrice: undefined });
      return;
    }
    const band = PRICE_BANDS.find((b) => b.value === value);
    if (band) onFiltersChange({ minPrice: band.min, maxPrice: band.max });
  };

  const handleTopicToggle = (topicId: string) => {
    const updated = selectedTopicIds.includes(topicId)
      ? selectedTopicIds.filter((id) => id !== topicId)
      : [...selectedTopicIds, topicId];
    onFiltersChange({ topicIds: updated.length > 0 ? updated : undefined });
  };

  const visibleTopics = topics.filter((t) =>
    t.name.toLowerCase().includes(topicQuery.trim().toLowerCase()),
  );

  return (
    <div className="space-y-4 rounded-2xl border border-border bg-muted p-4 sm:p-6">
      {/* Search leads: it is the fastest way in, so it gets the full width. */}
      <div className="relative">
        <Search
          className="absolute left-4 top-1/2 h-5 w-5 -translate-y-1/2 text-muted-foreground"
          aria-hidden="true"
        />
        <Input
          type="search"
          aria-label="Search programs"
          placeholder="Search programs or experts"
          value={localSearch}
          onChange={(e) => onLocalSearchChange(e.target.value)}
          className={`h-12 rounded-xl border-border bg-card pl-12 text-sm focus:ring-ring sm:text-base [&::-webkit-search-cancel-button]:appearance-none ${localSearch ? "pr-11" : "pr-4"}`}
        />
        {localSearch && (
          <button
            type="button"
            aria-label="Clear search"
            onClick={() => onLocalSearchChange("")}
            className="absolute right-3 top-1/2 -translate-y-1/2 rounded-full p-1.5 text-muted-foreground transition-colors hover:bg-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          >
            <X className="h-4 w-4" />
          </button>
        )}
      </div>

      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
        {/* Topics: pick any number without the list closing on each click. */}
        <div>
          <Label className={FIELD_LABEL}>Topics</Label>
          <Popover onOpenChange={(open) => !open && setTopicQuery("")}>
            <PopoverTrigger asChild>
              <button
                type="button"
                className="flex h-11 w-full items-center justify-between gap-2 rounded-xl border border-border bg-card px-3 text-sm text-foreground focus:outline-none focus:ring-2 focus:ring-ring"
              >
                <span className="truncate">
                  {selectedTopicIds.length > 0
                    ? `${selectedTopicIds.length} selected`
                    : "All topics"}
                </span>
                <ChevronsUpDown
                  className="h-4 w-4 shrink-0 opacity-50"
                  aria-hidden="true"
                />
              </button>
            </PopoverTrigger>
            <PopoverContent className="w-72 p-2" align="start">
              <Input
                type="search"
                aria-label="Find a topic"
                placeholder="Find a topic"
                value={topicQuery}
                onChange={(e) => setTopicQuery(e.target.value)}
                className="h-9 rounded-lg border-border bg-card"
              />
              <fieldset className="mt-2 max-h-60 min-w-0 overflow-auto">
                <legend className="sr-only">Topics</legend>
                {visibleTopics.map((topic) => (
                  <label
                    key={topic.id}
                    className="flex cursor-pointer items-center gap-2 rounded-lg px-2 py-2 text-sm text-foreground hover:bg-muted"
                  >
                    <Checkbox
                      checked={selectedTopicIds.includes(topic.id)}
                      onCheckedChange={() => handleTopicToggle(topic.id)}
                    />
                    <span className="flex-1 truncate">{topic.name}</span>
                    <span className="text-xs text-muted-foreground">
                      {topic.programCount}
                    </span>
                  </label>
                ))}
                {visibleTopics.length === 0 && (
                  <p className="px-2 py-3 text-sm text-muted-foreground">
                    No topics match.
                  </p>
                )}
              </fieldset>
            </PopoverContent>
          </Popover>
        </div>

        <div>
          <Label className={FIELD_LABEL}>Price</Label>
          <Select value={currentPriceRange} onValueChange={handlePriceChange}>
            <SelectTrigger className={FIELD_TRIGGER}>
              <SelectValue placeholder="Any price" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">Any price</SelectItem>
              {PRICE_BANDS.map((band) => (
                <SelectItem key={band.value} value={band.value}>
                  {rangeLabel(band.min, band.max)}
                </SelectItem>
              ))}
              {currentPriceRange === "custom" && (
                <SelectItem value="custom">
                  {rangeLabel(filters.minPrice ?? 0, filters.maxPrice)}
                </SelectItem>
              )}
            </SelectContent>
          </Select>
        </div>

        <div>
          <Label className={FIELD_LABEL}>Language</Label>
          <Select
            value={filters.language || "all"}
            onValueChange={(v) =>
              onFiltersChange({ language: v === "all" ? undefined : v })
            }
          >
            <SelectTrigger className={FIELD_TRIGGER}>
              <SelectValue placeholder="All languages" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All languages</SelectItem>
              {languages.map((language) => (
                <SelectItem key={language} value={language}>
                  {language}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>

        <div>
          <Label className={FIELD_LABEL}>Level</Label>
          <Select value={selectedLevel} onValueChange={onLevelChange}>
            <SelectTrigger className={FIELD_TRIGGER}>
              <SelectValue placeholder="All levels" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All levels</SelectItem>
              {uniqueLevels.map((level) => (
                <SelectItem key={level} value={level}>
                  {planLevelLabel(level)}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
      </div>
    </div>
  );
}

const AdvancedFilters = memo(AdvancedFiltersImpl);
export default AdvancedFilters;
