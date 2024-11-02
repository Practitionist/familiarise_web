"use client";

import { useRouter, useSearchParams } from "next/navigation";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { LayoutGrid, List, Search } from "lucide-react";
import Link from "next/link";
import { useCallback } from "react";

export function SearchControls({
  searchQuery,
  sortOption,
  currentView,
  searchParams,
}: Readonly<{
  searchQuery: string;
  sortOption: string;
  currentView: string;
  searchParams: { [key: string]: string | string[] | undefined };
}>) {
  const router = useRouter();
  const params = useSearchParams();

  const createQueryString = useCallback(
    (name: string, value: string) => {
      const newParams = new URLSearchParams(params.toString());
      newParams.set(name, value);
      return newParams.toString();
    },
    [params],
  );

  return (
    <div className="flex items-center gap-4">
      <div className="relative w-64">
        <Search className="absolute left-2 top-2.5 h-4 w-4 text-muted-foreground" />
        <Input
          placeholder="Search programs..."
          className="pl-8"
          defaultValue={searchQuery}
          onChange={(e) => {
            router.push("?" + createQueryString("search", e.target.value));
          }}
        />
      </div>
      <Select
        defaultValue={sortOption}
        onValueChange={(value) => {
          router.push("?" + createQueryString("sort", value));
        }}
      >
        <SelectTrigger className="w-40">
          <SelectValue placeholder="Sort by" />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value="price_asc">Price: Low to High</SelectItem>
          <SelectItem value="price_desc">Price: High to Low</SelectItem>
          <SelectItem value="duration_asc">Duration: Low to High</SelectItem>
          <SelectItem value="duration_desc">Duration: High to Low</SelectItem>
        </SelectContent>
      </Select>
      <div className="flex gap-1 border rounded-md p-1">
        <Link
          href={{ query: { ...searchParams, view: "grid" } }}
          className={`p-2 rounded ${currentView === "grid" ? "bg-muted" : ""}`}
        >
          <LayoutGrid className="h-4 w-4" />
        </Link>
        <Link
          href={{ query: { ...searchParams, view: "list" } }}
          className={`p-2 rounded ${currentView === "list" ? "bg-muted" : ""}`}
        >
          <List className="h-4 w-4" />
        </Link>
      </div>
    </div>
  );
}
