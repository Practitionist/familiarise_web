"use client";

import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";

export type SortOption = "nameAsc" | "nameDesc" | "reviewCount" | "rating";

interface SearchBarProps {
  onSearch: (value: string) => void;
  onSort: (option: SortOption) => void;
  sortBy: SortOption;
}

export function SearchBar({ onSearch, onSort, sortBy }: SearchBarProps) {
  return (
    <div className="bg-gradient-to-br from-gray-900/80 to-gray-800/60 border border-gray-800/50 rounded-3xl grid grid-cols-[1fr,auto] items-center p-2 gap-4 backdrop-blur-sm">
      <Input
        className="appearance-none border-0 focus:outline-none placeholder-gray-500 bg-transparent text-gray-100"
        placeholder="Search for experts"
        type="search"
        onChange={(e) => onSearch(e.target.value)}
      />
      <div className="w-48">
        <Select
          value={sortBy}
          onValueChange={(value) => onSort(value as SortOption)}
        >
          <SelectTrigger className="bg-gray-800/50 border-gray-700 text-gray-100">
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
