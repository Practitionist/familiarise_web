"use client";

import { useQuery } from "@tanstack/react-query";
import type { IConsultantCardData } from "@/types/consultant";
import type { SortOption } from "../components/SearchBar";

const fetchConsultantsData = async (url: string) => {
  const res = await fetch(url);
  if (!res.ok) {
    const error = new Error(
      "An error occurred while fetching the data.",
    ) as Error & {
      info: { message: string; [key: string]: unknown };
      status: number;
    };
    error.info = await res.json();
    error.status = res.status;
    throw error;
  }
  return res.json();
};

// Hook for fetching a curated set of experts (for trending/newest rows)
export function useCuratedExperts(sort: SortOption, limit: number = 8) {
  const { data, isLoading } = useQuery<{ data: IConsultantCardData[] }>({
    queryKey: ["curated-experts", sort, limit],
    queryFn: () =>
      fetchConsultantsData(`/api/user/consultants?sort=${sort}&limit=${limit}`),
    staleTime: 5 * 60 * 1000,
    gcTime: 15 * 60 * 1000,
    retry: 2,
  });

  return { experts: data?.data || [], isLoading };
}
