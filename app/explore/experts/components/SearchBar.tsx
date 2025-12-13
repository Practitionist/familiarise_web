"use client";

import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Search, SlidersHorizontal } from "lucide-react";

export type SortOption = "nameAsc" | "nameDesc" | "reviewCount" | "rating";

interface SearchBarProps {
  onSearch: (value: string) => void;
  onSort: (option: SortOption) => void;
  sortBy: SortOption;
}

export function SearchBar({ onSearch, onSort, sortBy }: SearchBarProps) {
  return (
    <div className="flex flex-col sm:flex-row gap-4">
      {/* Search Input */}
      <div className="flex-1 relative">
        <div className="absolute left-4 top-1/2 -translate-y-1/2">
          <Search className="w-5 h-5 text-zinc-400" />
        </div>
        <Input
          className="w-full h-12 pl-12 pr-4 bg-white border-zinc-200 rounded-xl focus:border-zinc-400 focus:ring-zinc-400 placeholder:text-zinc-400"
          placeholder="Search experts by name, skill, or specialty..."
          type="search"
          onChange={(e) => onSearch(e.target.value)}
        />
      </div>

      {/* Sort Dropdown */}
      <div className="flex items-center gap-2">
        <div className="flex items-center gap-2 px-4 h-12 bg-zinc-100 rounded-xl">
          <SlidersHorizontal className="w-4 h-4 text-zinc-500" />
          <span className="text-sm font-medium text-zinc-600 hidden sm:inline">Sort by</span>
        </div>
        <Select
          value={sortBy}
          onValueChange={(value) => onSort(value as SortOption)}
        >
          <SelectTrigger className="w-[180px] h-12 bg-white border-zinc-200 rounded-xl focus:ring-zinc-400">
            <SelectValue placeholder="Sort by" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="nameAsc">Name (A-Z)</SelectItem>
            <SelectItem value="nameDesc">Name (Z-A)</SelectItem>
            <SelectItem value="reviewCount">Most Reviews</SelectItem>
            <SelectItem value="rating">Highest Rating</SelectItem>
          </SelectContent>
        </Select>
      </div>
    </div>
  );
}
