import { useQuery, useInfiniteQuery } from "@tanstack/react-query";
import type { IConsultantCardData } from "@/types/consultant";
import { SortOption } from "./components/SearchBar";
import { useCallback, useMemo } from "react";
import { CONSULTANTS_PER_PAGE, type IExpertFilters, type IExpertsMetaData } from "./utils";

// Enhanced React Query fetcher function with error handling for consultants
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

export function useConsultantsMetadata() {
  const { data, error, isLoading, refetch } = useQuery<{ data: IExpertsMetaData }>({
    queryKey: ["consultants-metadata"],
    queryFn: () => fetchConsultantsData("/api/user/consultants/meta"),
    staleTime: 5 * 60 * 1000,
    gcTime: 10 * 60 * 1000,
    retry: 3,
    retryDelay: 5000,
  });

  return {
    metadata: data?.data || null,
    isLoading,
    error,
    refresh: refetch,
  };
}

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

export function useConsultants(filters: IExpertFilters) {
  const {
    domain: selectedDomain,
    subdomain: selectedSubdomain,
    tags: selectedTags,
    experience: experienceYears,
    search: searchTerm,
    sort: sortBy,
    minPrice,
    maxPrice,
    availability,
    language,
  } = filters;

  const getKey = useCallback(
    (pageIndex: number) => {
      const params = new URLSearchParams({
        page: (pageIndex + 1).toString(),
        limit: CONSULTANTS_PER_PAGE.toString(),
        ...(selectedDomain && { domain: selectedDomain }),
        ...(selectedSubdomain && { subdomain: selectedSubdomain }),
        ...(selectedTags.length && { tags: selectedTags.join(",") }),
        ...(experienceYears > 0 && { experience: experienceYears.toString() }),
        ...(searchTerm && { search: searchTerm }),
        sort: sortBy,
        ...(minPrice !== undefined && { minPrice: String(minPrice) }),
        ...(maxPrice !== undefined && { maxPrice: String(maxPrice) }),
        ...(availability && { availability }),
        ...(language && { language }),
      });

      return `/api/user/consultants?${params}`;
    },
    [
      selectedDomain,
      selectedSubdomain,
      selectedTags,
      experienceYears,
      searchTerm,
      sortBy,
      minPrice,
      maxPrice,
      availability,
      language,
    ],
  );

  const {
    data,
    error,
    fetchNextPage,
    hasNextPage,
    isLoading,
    isFetchingNextPage,
    refetch,
  } = useInfiniteQuery({
    queryKey: [
      "consultants",
      selectedDomain,
      selectedSubdomain,
      selectedTags,
      experienceYears,
      searchTerm,
      sortBy,
      minPrice,
      maxPrice,
      availability,
      language,
    ],
    queryFn: ({ pageParam = 0 }) => fetchConsultantsData(getKey(pageParam)),
    getNextPageParam: (lastPage, pages) => {
      if (lastPage?.data?.length === CONSULTANTS_PER_PAGE) {
        return pages.length;
      }
      return undefined;
    },
    initialPageParam: 0,
    staleTime: 2 * 60 * 1000,
    gcTime: 10 * 60 * 1000,
    retry: 3,
    retryDelay: 3000,
  });

  const consultants: IConsultantCardData[] = useMemo(
    () => (data ? data.pages.flatMap((page) => page.data) : []),
    [data],
  );

  const hasMore = hasNextPage;
  const isLoadingMore = isFetchingNextPage;

  return {
    consultants,
    error,
    isLoading,
    isLoadingMore,
    hasMore,
    loadMore: () => fetchNextPage(),
    refresh: refetch,
    firstPageKey: getKey(0),
  };
}
