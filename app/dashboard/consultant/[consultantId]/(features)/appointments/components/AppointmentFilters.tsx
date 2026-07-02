"use client";

import { Search } from "lucide-react";
import { Input } from "@/components/ui/input";

export type AppointmentStatusFilter = "ALL" | "UPCOMING" | "PAST";

interface AppointmentFiltersProps {
  searchQuery: string;
  onSearchChange: (value: string) => void;
  statusFilter: AppointmentStatusFilter;
  onStatusChange: (value: AppointmentStatusFilter) => void;
}

const STATUS_TABS: { label: string; value: AppointmentStatusFilter }[] = [
  { label: "All", value: "ALL" },
  { label: "Upcoming", value: "UPCOMING" },
  { label: "Past", value: "PAST" },
];

/** Search box + All/Upcoming/Past tab strip for the appointments list. */
export function AppointmentFilters({
  searchQuery,
  onSearchChange,
  statusFilter,
  onStatusChange,
}: AppointmentFiltersProps) {
  return (
    <div className="space-y-3 mb-4">
      <div className="relative">
        <Search className="absolute left-3 top-1/2 transform -translate-y-1/2 h-4 w-4 text-zinc-400" />
        <Input
          placeholder="Search by name or plan..."
          value={searchQuery}
          onChange={(e) => onSearchChange(e.target.value)}
          className="pl-10 h-10"
        />
      </div>
      <div className="flex items-center gap-2 border-b border-zinc-200 overflow-x-auto">
        {STATUS_TABS.map((tab) => (
          <button
            key={tab.value}
            onClick={() => onStatusChange(tab.value)}
            className={`px-4 py-2.5 text-sm font-medium whitespace-nowrap border-b-2 transition-colors ${
              statusFilter === tab.value
                ? "border-zinc-900 text-zinc-900"
                : "border-transparent text-zinc-500 hover:text-zinc-700 hover:border-zinc-300"
            }`}
          >
            {tab.label}
          </button>
        ))}
      </div>
    </div>
  );
}
