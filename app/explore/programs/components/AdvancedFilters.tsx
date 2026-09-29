"use client";

import { useEffect, useRef, useState } from "react";
import { LayoutGrid, List, Search, SlidersHorizontal, X } from "lucide-react";
import { PlanLevel } from "@prisma/client";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { TopicWithCount, ProgramFilters } from "@/lib/explore/programs";
import { planLevelLabel } from "@/lib/labels/plan-labels";
import { cn } from "@/utils/tailwind";

interface AdvancedFiltersProps {
  filters: ProgramFilters;
  onFiltersChange: (filters: Partial<ProgramFilters>) => void;
  localSearch: string;
  onLocalSearchChange: (value: string) => void;
  selectedLevel: string;
  onLevelChange: (level: string) => void;
  uniqueLevels: PlanLevel[];
  viewMode: "grid" | "list";
  onViewModeChange: (mode: "grid" | "list") => void;
  topics: TopicWithCount[];
  /** e.g. "48 programs" or "12 matching". The listing had none at all. */
  resultSummary?: string | null;
  /** How many filter chips are active — drives the "More filters (n)" badge. */
  activeFilterCount?: number;
}

const PRICE_RANGES = [
  { label: "Any price", value: "all" },
  { label: "Free", value: "0-0" },
  { label: "Under 500", value: "0-500" },
  { label: "500 – 2,000", value: "500-2000" },
  { label: "2,000 – 5,000", value: "2000-5000" },
  { label: "5,000+", value: "5000-" },
];

const SORT_OPTIONS = [
  { label: "Most popular", value: "trending" },
  { label: "Newest", value: "newest" },
  { label: "Price: low to high", value: "price-asc" },
  { label: "Price: high to low", value: "price-desc" },
  { label: "Title: A to Z", value: "title-asc" },
  { label: "Title: Z to A", value: "title-desc" },
];

const LANGUAGES = ["English", "Hindi", "Spanish", "French"];

/**
 * The programs filter bar.
 *
 * ── What it was ─────────────────────────────────────────────────────────────
 * A permanently-visible card: a 40px primary-filled icon chip, a heading, a
 * subheading, and a **six-column grid of selects** — topics, price, language,
 * level, sort, plus a search box and a pair of view-mode buttons. Roughly
 * 300px tall, before a single program was on screen, on a page whose entire
 * job is showing programs. It also scrolled away, so it was gone by the time
 * you wanted to change it, and it showed no result count anywhere.
 *
 * ── What it is ──────────────────────────────────────────────────────────────
 * One row: search, level, price, view mode, "More filters", and the count.
 * The rest — topics, language, sort — is behind the disclosure. Same facets,
 * same handlers, no second control for any one filter.
 *
 * A static `Sheet` was considered for the overflow facets, and rejected: it
 * costs a click and a focus trap to change a sort order, and it makes the
 * active state invisible. A disclosure keeps everything on the page, one
 * keystroke of interaction away, and costs 0px until asked for.
 */
function AdvancedFiltersImpl({
  filters,
  onFiltersChange,
  localSearch,
  onLocalSearchChange,
  selectedLevel,
  onLevelChange,
  uniqueLevels,
  viewMode,
  onViewModeChange,
  topics,
  resultSummary,
  activeFilterCount = 0,
}: AdvancedFiltersProps) {
  const [expanded, setExpanded] = useState(false);
  const [topicSearch, setTopicSearch] = useState("");
  const [topicOpen, setTopicOpen] = useState(false);
  const topicRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!topicOpen) return;
    const onDown = (e: MouseEvent) => {
      if (!topicRef.current?.contains(e.target as Node)) {
        setTopicOpen(false);
        setTopicSearch("");
      }
    };
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
  }, [topicOpen]);

  const priceValue = (() => {
    if (filters.minPrice === undefined && filters.maxPrice === undefined)
      return "all";
    if (filters.minPrice === 0 && filters.maxPrice === 0) return "0-0";
    const min = filters.minPrice ?? 0;
    return filters.maxPrice === undefined
      ? `${min}-`
      : `${min}-${filters.maxPrice}`;
  })();

  const setPrice = (value: string) => {
    if (value === "all") {
      onFiltersChange({ minPrice: undefined, maxPrice: undefined });
      return;
    }
    const [min, max] = value.split("-");
    onFiltersChange({
      minPrice: min ? parseInt(min, 10) : undefined,
      maxPrice: max ? parseInt(max, 10) : undefined,
    });
  };

  const toggleTopic = (id: string) => {
    const current = filters.topicIds ?? [];
    const next = current.includes(id)
      ? current.filter((x) => x !== id)
      : [...current, id];
    onFiltersChange({ topicIds: next.length > 0 ? next : undefined });
    setTopicOpen(false);
    setTopicSearch("");
  };

  const selectedTopics = (filters.topicIds ?? [])
    .map((id) => topics.find((t) => t.id === id)?.name)
    .filter((n): n is string => Boolean(n));

  const topicOptions = topics.filter(
    (t) =>
      t.name.toLowerCase().includes(topicSearch.toLowerCase()) &&
      !(filters.topicIds ?? []).includes(t.id),
  );

  return (
    <div className="rounded-card border border-border bg-card p-4 shadow-elevation-1 shadow-edge sm:p-5">
      <div className="flex flex-col gap-3 lg:flex-row lg:items-center">
        {/* Search */}
        <div className="relative flex-1">
          <Search
            className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground"
            aria-hidden="true"
          />
          <Input
            type="text"
            value={localSearch}
            onChange={(e) => onLocalSearchChange(e.target.value)}
            placeholder="Search programs by title or topic"
            aria-label="Search programs"
            className="pl-9"
          />
        </div>

        <div className="flex flex-wrap items-center gap-2">
          {/* Level — one of the two facets worth permanent space: it is the
              coarsest way to narrow a catalogue this size. */}
          <div className="w-[9.5rem]">
            <Select value={selectedLevel} onValueChange={onLevelChange}>
              <SelectTrigger aria-label="Level">
                <SelectValue placeholder="Level" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All levels</SelectItem>
                {uniqueLevels.map((lvl) => (
                  <SelectItem key={lvl} value={lvl}>
                    {planLevelLabel(lvl)}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          <div className="w-[8.5rem]">
            <Select value={priceValue} onValueChange={setPrice}>
              <SelectTrigger aria-label="Price">
                <SelectValue placeholder="Price" />
              </SelectTrigger>
              <SelectContent>
                {PRICE_RANGES.map((r) => (
                  <SelectItem key={r.value} value={r.value}>
                    {r.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          {/* View mode, beside the other controls rather than at the end of a
              six-column grid where it was easy to miss. */}
          <div
            role="group"
            aria-label="Result layout"
            className="flex items-center gap-0.5 rounded-control border border-border bg-muted p-1"
          >
            {(["grid", "list"] as const).map((m) => (
              <button
                key={m}
                type="button"
                onClick={() => onViewModeChange(m)}
                aria-pressed={viewMode === m}
                aria-label={`${m} view`}
                className={cn(
                  "flex h-7 w-8 items-center justify-center rounded-[0.3rem] transition-colors",
                  "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2",
                  viewMode === m
                    ? "bg-card text-foreground shadow-elevation-1"
                    : "text-muted-foreground hover:text-foreground",
                )}
              >
                {m === "grid" ? (
                  <LayoutGrid className="h-3.5 w-3.5" aria-hidden="true" />
                ) : (
                  <List className="h-3.5 w-3.5" aria-hidden="true" />
                )}
              </button>
            ))}
          </div>

          <Button
            variant="outline"
            className="h-10 gap-2"
            onClick={() => setExpanded((v) => !v)}
            aria-expanded={expanded}
          >
            <SlidersHorizontal className="h-4 w-4" aria-hidden="true" />
            More filters
            {activeFilterCount > 0 && (
              <span className="tnum rounded-full bg-brand-subtle px-1.5 text-xs font-semibold text-brand-foreground-subtle">
                {activeFilterCount}
                <span className="sr-only"> active</span>
              </span>
            )}
          </Button>

          {resultSummary && (
            <span className="tnum shrink-0 text-sm text-muted-foreground lg:ml-2">
              {resultSummary}
            </span>
          )}
        </div>
      </div>

      {/* ── The rest, on demand ── */}
      {expanded && (
        <div className="mt-4 grid grid-cols-1 gap-4 border-t border-border-subtle pt-4 sm:grid-cols-2 lg:grid-cols-4">
          {/* Topics */}
          <div className="relative" ref={topicRef}>
            <p
              className="mb-1.5 text-xs font-medium uppercase tracking-wider text-muted-foreground"
              id="af-topics-label"
            >
              Topics
            </p>
            <button
              type="button"
              onClick={() => setTopicOpen((v) => !v)}
              aria-expanded={topicOpen}
              aria-labelledby="af-topics-label"
              className="flex h-10 w-full items-center justify-between gap-2 rounded-control border border-input bg-background px-3 text-sm transition-colors hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
            >
              <span
                className={cn(
                  "truncate",
                  selectedTopics.length === 0 && "text-muted-foreground",
                )}
              >
                {selectedTopics.length > 0
                  ? selectedTopics.length === 1
                    ? selectedTopics[0]
                    : `${selectedTopics[0]} +${selectedTopics.length - 1}`
                  : "All topics"}
              </span>
              <SlidersHorizontal
                className="h-3.5 w-3.5 shrink-0 opacity-50"
                aria-hidden="true"
              />
            </button>

            {topicOpen && (
              <div className="absolute z-30 mt-1 w-full rounded-card border border-border bg-popover shadow-elevation-3">
                <div className="border-b border-border-subtle p-2">
                  <Input
                    autoFocus
                    value={topicSearch}
                    onChange={(e) => setTopicSearch(e.target.value)}
                    placeholder="Search topics"
                    aria-label="Search topics"
                    className="h-8"
                  />
                </div>
                <ul className="max-h-52 overflow-y-auto p-1">
                  {topicOptions.length === 0 && (
                    <li className="px-2 py-3 text-center text-sm text-muted-foreground">
                      No matching topics
                    </li>
                  )}
                  {topicOptions.map((t) => (
                    <li key={t.id}>
                      <button
                        type="button"
                        onClick={() => toggleTopic(t.id)}
                        className="flex w-full items-center justify-between gap-2 rounded-control px-2 py-1.5 text-left text-sm transition-colors hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                      >
                        <span className="truncate">{t.name}</span>
                        <span className="tnum shrink-0 text-xs text-muted-foreground">
                          {t.programCount}
                        </span>
                      </button>
                    </li>
                  ))}
                </ul>
              </div>
            )}

            {selectedTopics.length > 0 && (
              <ul className="mt-2 flex flex-wrap gap-1.5">
                {selectedTopics.map((name) => {
                  const topic = topics.find((t) => t.name === name);
                  if (!topic) return null;
                  return (
                    <li key={topic.id}>
                      <button
                        type="button"
                        onClick={() => toggleTopic(topic.id)}
                        className="inline-flex items-center gap-1 rounded-chip border border-brand-border bg-brand-subtle px-2 py-0.5 text-xs text-brand-foreground-subtle transition-colors hover:opacity-80 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
                      >
                        {name}
                        <X className="h-3 w-3" aria-hidden="true" />
                        <span className="sr-only">Remove {name} filter</span>
                      </button>
                    </li>
                  );
                })}
              </ul>
            )}
          </div>

          {/* Language */}
          <div>
            <p className="mb-1.5 text-xs font-medium uppercase tracking-wider text-muted-foreground">
              Language
            </p>
            <Select
              value={filters.language ?? "all"}
              onValueChange={(v) =>
                onFiltersChange({ language: v === "all" ? undefined : v })
              }
            >
              <SelectTrigger aria-label="Language">
                <SelectValue placeholder="Any language" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">Any language</SelectItem>
                {LANGUAGES.map((l) => (
                  <SelectItem key={l} value={l}>
                    {l}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          {/* Sort */}
          <div>
            <p className="mb-1.5 text-xs font-medium uppercase tracking-wider text-muted-foreground">
              Sort by
            </p>
            <Select
              value={filters.sort ?? "trending"}
              onValueChange={(v) => onFiltersChange({ sort: v })}
            >
              <SelectTrigger aria-label="Sort by">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {SORT_OPTIONS.map((o) => (
                  <SelectItem key={o.value} value={o.value}>
                    {o.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        </div>
      )}
    </div>
  );
}

export default AdvancedFiltersImpl;
