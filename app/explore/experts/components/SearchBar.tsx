"use client";

import { Input } from "@/components/ui/input";

interface SearchBarProps {
  onSearch: (value: string) => void;
}

export function SearchBar({ onSearch }: SearchBarProps) {
  return (
    <div className="border border-gray-200 rounded-lg grid items-center p-2 dark:border-gray-800">
      <Input
        className="appearance-none w-full border-0 focus:outline-none placeholder-gray-500 dark:placeholder-gray-400"
        placeholder="Search for experts"
        type="search"
        onChange={(e) => onSearch(e.target.value)}
      />
    </div>
  );
}
