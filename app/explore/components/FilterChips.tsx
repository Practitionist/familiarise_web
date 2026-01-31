"use client";

import { X } from "lucide-react";

export interface ActiveFilter {
  key: string;
  label: string;
  value: string;
}

interface FilterChipsProps {
  filters: ActiveFilter[];
  onRemove: (key: string) => void;
  onClearAll: () => void;
}

export default function FilterChips({
  filters,
  onRemove,
  onClearAll,
}: FilterChipsProps) {
  if (filters.length === 0) return null;

  return (
    <div className="flex flex-wrap items-center gap-2">
      {filters.map((filter) => (
        <span
          key={filter.key}
          className="inline-flex items-center gap-1.5 px-3 py-1.5 bg-zinc-100 text-zinc-700 text-xs font-medium rounded-full border border-zinc-200"
        >
          <span className="text-zinc-400">{filter.label}:</span>
          {filter.value}
          <button
            onClick={() => onRemove(filter.key)}
            className="hover:bg-zinc-200 rounded-full p-0.5 transition-colors"
            aria-label={`Remove ${filter.label} filter`}
          >
            <X className="h-3 w-3" />
          </button>
        </span>
      ))}
      <button
        onClick={onClearAll}
        className="text-xs font-medium text-zinc-500 hover:text-zinc-900 px-2 py-1.5 transition-colors"
      >
        Clear All
      </button>
    </div>
  );
}
