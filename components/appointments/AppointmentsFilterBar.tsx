"use client";

import type { ReactNode } from "react";
import { Search } from "lucide-react";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import {
  DateRangeMenu,
  type DateRange,
  type DateRangeDirection,
} from "@/components/dashboard/DateRangeMenu";
import type { AppointmentKind } from "@/lib/appointments/view-model";
import { cn } from "@/utils/tailwind";

export type { DateRange } from "@/components/dashboard/DateRangeMenu";

export type TypeFilter =
  "ALL" | "CONSULTATION" | "SUBSCRIPTION" | "TRIAL" | "WEBINAR" | "CLASS";

export function matchesTypeFilter(
  kind: AppointmentKind,
  filter: TypeFilter,
): boolean {
  if (filter === "ALL") return true;
  return kind === filter;
}

const TYPE_OPTIONS: Array<{ value: TypeFilter; label: string }> = [
  { value: "ALL", label: "All types" },
  { value: "CONSULTATION", label: "Consultations" },
  { value: "SUBSCRIPTION", label: "Subscriptions" },
  { value: "TRIAL", label: "Trials" },
  { value: "WEBINAR", label: "Webinars" },
  { value: "CLASS", label: "Classes" },
];

interface AppointmentsFilterBarProps {
  typeFilter: TypeFilter;
  onTypeChange: (value: TypeFilter) => void;
  search: string;
  onSearchChange: (value: string) => void;
  dateRange: DateRange;
  onDateRangeChange: (value: DateRange) => void;
  /** The viewer's IANA zone, which the date presets count days in. */
  zone: string;
  /** Which date presets fit the open tab: coming-up, past, or both. */
  dateDirection?: DateRangeDirection;
  /** Role-specific filter control rendered at the end of the bar. */
  orgFilterSlot?: ReactNode;
}

export function AppointmentsFilterBar({
  typeFilter,
  onTypeChange,
  search,
  onSearchChange,
  dateRange,
  onDateRangeChange,
  zone,
  dateDirection = "any",
  orgFilterSlot,
}: AppointmentsFilterBarProps) {
  const hasRange = dateRange.from !== "" || dateRange.to !== "";
  const activeCount =
    (typeFilter === "ALL" ? 0 : 1) +
    (search.trim() === "" ? 0 : 1) +
    (hasRange ? 1 : 0);

  return (
    <div className="space-y-3">
      {/* Every type stays in view, one tap away; the padding keeps focus rings unclipped. */}
      <div
        role="group"
        aria-label="Type"
        className="-mx-1 flex items-center gap-2 overflow-x-auto px-1 py-0.5 scrollbar-hide"
      >
        {TYPE_OPTIONS.map((option) => {
          const pressed = typeFilter === option.value;
          return (
            <button
              key={option.value}
              type="button"
              aria-pressed={pressed}
              onClick={() => onTypeChange(option.value)}
              className={cn(
                "shrink-0 rounded-full border px-3 py-1 text-xs font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
                pressed
                  ? "border-foreground bg-foreground text-background"
                  : "border-border bg-card text-muted-foreground hover:border-foreground/30 hover:text-foreground",
              )}
            >
              {option.label}
            </button>
          );
        })}
      </div>

      <div className="flex flex-wrap items-center gap-2">
        <div className="relative min-w-[180px] basis-full sm:max-w-sm sm:flex-1 sm:basis-auto">
          <Search
            className="pointer-events-none absolute left-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground"
            aria-hidden
          />
          <Input
            type="search"
            value={search}
            onChange={(e) => onSearchChange(e.target.value)}
            placeholder="Search by name or plan…"
            aria-label="Search appointments"
            className="h-9 pl-8 text-sm"
          />
        </div>

        <DateRangeMenu
          value={dateRange}
          onChange={onDateRangeChange}
          zone={zone}
          direction={dateDirection}
        />

        {activeCount > 0 && (
          <Button
            type="button"
            variant="ghost"
            size="sm"
            className="h-9 text-muted-foreground"
            onClick={() => {
              onTypeChange("ALL");
              onSearchChange("");
              onDateRangeChange({ from: "", to: "" });
            }}
          >
            Clear ({activeCount})
          </Button>
        )}

        {orgFilterSlot && <div className="ml-auto">{orgFilterSlot}</div>}
      </div>
    </div>
  );
}
