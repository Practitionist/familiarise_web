"use client";

import { memo, useState } from "react";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Search, SlidersHorizontal } from "lucide-react";

export type SortOption =
  | "nameAsc"
  | "nameDesc"
  | "reviewCount"
  | "rating"
  | "trending"
  | "newest";

interface SearchBarProps {
  onSearch: (value: string) => void;
  onSort: (option: SortOption) => void;
  sortBy: SortOption;
  initialSearch?: string;
}

/**
 * Controlled search input. Forwards every keystroke to `onSearch` —
 * the parent (`useExpertsFilters`) owns the single 300 ms debounce that
 * coalesces filter mutations into one URL sync + React Query refetch.
 */
function SearchBarImpl({
  onSearch,
  onSort,
  sortBy,
  initialSearch = "",
}: SearchBarProps) {
  const [localValue, setLocalValue] = useState(initialSearch);

  return (
    <div className="flex flex-col sm:flex-row gap-4">
      {/* Search Input */}
      <div className="flex-1 relative rounded-xl focus-within:ring-2 focus-within:ring-zinc-900 transition-shadow">
        <div className="absolute left-4 top-1/2 -translate-y-1/2">
          <Search className="w-6 h-6 text-zinc-400" />
        </div>
        <Input
          className="w-full h-14 pl-14 pr-4 bg-zinc-100 border border-zinc-300 rounded-xl focus:ring-0 focus-visible:ring-0 placeholder:text-zinc-400 text-base"
          placeholder="Search experts by name, skill, or specialty..."
          type="search"
          value={localValue}
          onChange={(e) => {
            setLocalValue(e.target.value);
            onSearch(e.target.value);
          }}
        />
      </div>

      {/* Sort Dropdown */}
      <div className="flex items-center gap-2">
        <div className="flex items-center gap-2 px-4 h-14 bg-zinc-100 border border-zinc-300 rounded-xl">
          <SlidersHorizontal className="w-4 h-4 text-zinc-500" />
          <span className="text-sm font-medium text-zinc-600 hidden sm:inline">
            Sort by
          </span>
        </div>
        <Select
          value={sortBy}
          onValueChange={(value) => onSort(value as SortOption)}
        >
          <SelectTrigger className="w-[180px] h-14 bg-zinc-100 border border-zinc-300 rounded-xl focus:ring-zinc-400">
            <SelectValue placeholder="Sort by" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="nameAsc">Name (A-Z)</SelectItem>
            <SelectItem value="nameDesc">Name (Z-A)</SelectItem>
            <SelectItem value="reviewCount">Most Reviews</SelectItem>
            <SelectItem value="rating">Highest Rating</SelectItem>
            <SelectItem value="trending">Trending</SelectItem>
            <SelectItem value="newest">Newest</SelectItem>
          </SelectContent>
        </Select>
      </div>
    </div>
  );
}

export const SearchBar = memo(SearchBarImpl);
