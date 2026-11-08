"use client";

import { memo } from "react";
import { LayoutGrid, List } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";

type ViewMode = "grid" | "list";

interface ResultsToolbarProps {
  /** Programs loaded so far. */
  count: number;
  /** More pages exist, so `count` is a floor, not the total. */
  hasMore: boolean;
  isLoading: boolean;
  sort: string | undefined;
  onSortChange: (sort: string | undefined) => void;
  viewMode: ViewMode;
  onViewModeChange: (mode: ViewMode) => void;
}

const SORT_OPTIONS = [
  { label: "Most Popular", value: "trending" },
  { label: "Newest", value: "newest" },
  { label: "Price: Low to High", value: "price-asc" },
  { label: "Price: High to Low", value: "price-desc" },
  { label: "Title: A to Z", value: "title-asc" },
  { label: "Title: Z to A", value: "title-desc" },
];

const VIEW_OPTIONS = [
  { mode: "list" as const, label: "List view", Icon: List },
  { mode: "grid" as const, label: "Grid view", Icon: LayoutGrid },
];

/** What sits directly above the results: how many, in what order, shown how. */
function ResultsToolbarImpl({
  count,
  hasMore,
  isLoading,
  sort,
  onSortChange,
  viewMode,
  onViewModeChange,
}: ResultsToolbarProps) {
  const summary =
    isLoading && count === 0
      ? "Loading programs…"
      : `${count}${hasMore ? "+" : ""} ${count === 1 && !hasMore ? "program" : "programs"}`;

  return (
    <div className="mb-6 flex flex-wrap items-center justify-between gap-3">
      <p role="status" className="text-sm text-muted-foreground">
        {summary}
      </p>

      <div className="flex items-center gap-2">
        <Select
          value={sort ?? "none"}
          onValueChange={(v) => onSortChange(v === "none" ? undefined : v)}
        >
          <SelectTrigger
            aria-label="Sort programs"
            className="h-10 w-[11.5rem] rounded-xl border-border bg-card focus:ring-ring"
          >
            <SelectValue placeholder="Sort by" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="none">Default order</SelectItem>
            {SORT_OPTIONS.map((opt) => (
              <SelectItem key={opt.value} value={opt.value}>
                {opt.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>

        <div role="group" aria-label="Layout" className="flex gap-1">
          {VIEW_OPTIONS.map(({ mode, label, Icon }) => (
            <Button
              key={mode}
              type="button"
              variant={viewMode === mode ? "default" : "outline"}
              size="icon"
              aria-label={label}
              aria-pressed={viewMode === mode}
              className={`h-10 w-10 rounded-xl ${viewMode === mode ? "bg-primary hover:bg-primary/90" : "border-border"}`}
              onClick={() => onViewModeChange(mode)}
            >
              <Icon className="h-4 w-4" />
            </Button>
          ))}
        </div>
      </div>
    </div>
  );
}

const ResultsToolbar = memo(ResultsToolbarImpl);
export default ResultsToolbar;
