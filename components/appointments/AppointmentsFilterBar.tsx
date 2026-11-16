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
import { FilterMenu } from "@/components/dashboard/FilterMenu";
import type { AppointmentKind } from "@/lib/appointments/view-model";

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

const TYPE_VALUES = new Set<string>(TYPE_OPTIONS.map((o) => o.value));

function isTypeFilter(value: string | null): value is TypeFilter {
  return value !== null && TYPE_VALUES.has(value);
}

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
    <div className="flex flex-wrap items-center gap-2">
      <div className="relative min-w-[180px] basis-full sm:max-w-sm sm:flex-1 sm:basis-auto">
        <Search
          className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground"
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

      <FilterMenu
        label="Type"
        options={TYPE_OPTIONS}
        value={typeFilter}
        allValue="ALL"
        onChange={(value) => onTypeChange(isTypeFilter(value) ? value : "ALL")}
      />

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
  );
}
