import useSWR from "swr";
import useSWRInfinite from "swr/infinite";
import { Domain, SubDomain, Tag } from "@prisma/client";
import { TConsultantProfile } from "@/types/consultant";
import { SortOption } from "./components/SearchBar";
import { useCallback } from "react";

export const CONSULTANTS_PER_PAGE = 10;

export interface MetaData {
  domains: Domain[];
  subdomains: SubDomain[];
  tags: Tag[];
  consultantMetadata: {
    totalConsultants: number;
    consultantsByDomain: {
      id: string;
      name: string;
      consultantCount: number;
    }[];
    averageRating: number;
  };
}

// Enhanced SWR fetcher function with error handling
const fetcher = async (url: string) => {
  const res = await fetch(url);

  // If the status code is not in the range 200-299, throw an error
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
  const { data, error, isLoading, mutate } = useSWR<{ data: MetaData }>(
    "/api/user/consultants/meta",
    fetcher,
    {
      revalidateOnFocus: false,
      revalidateIfStale: true,
      dedupingInterval: 60000, // 1 minute
      errorRetryCount: 3,
      errorRetryInterval: 5000, // 5 seconds
      loadingTimeout: 10000, // 10 seconds
      suspense: false,
    },
  );

  return {
    metadata: data?.data || null,
    isLoading,
    error,
    refresh: mutate,
  };
}

export function useConsultants({
  selectedDomain,
  selectedSubdomain,
  selectedTags,
  experienceYears,
  searchTerm,
  sortBy,
}: {
  selectedDomain: string | null;
  selectedSubdomain: string | null;
  selectedTags: string[];
  experienceYears: number;
  searchTerm: string;
  sortBy: SortOption;
}) {
  // Create a stable getKey function with useCallback
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
    ],
  );

  // Generate the key for the first page to use for prefetching
  const firstPageKey = getKey(0);

  const { data, error, size, setSize, isLoading, isValidating, mutate } =
    useSWRInfinite(getKey, fetcher, {
      revalidateFirstPage: false,
      revalidateOnFocus: false,
      revalidateAll: false,
      persistSize: true,
      dedupingInterval: 30000, // 30 seconds
      errorRetryCount: 3,
      errorRetryInterval: 3000, // 3 seconds
      loadingTimeout: 8000, // 8 seconds
      suspense: false,
      parallel: true, // Fetch pages in parallel for faster loading
    });

  const consultants: TConsultantProfile[] = data
    ? data.flatMap((page) => page.data)
    : [];
  const hasMore = data
    ? data[data.length - 1]?.data.length === CONSULTANTS_PER_PAGE
    : true;
  const isLoadingMore =
    isLoading || (size > 0 && data && typeof data[size - 1] === "undefined");

  // Prefetch the next page if we have data and there might be more
  const prefetchNextPage = useCallback(() => {
    if (hasMore && !isLoadingMore && data) {
      // Prefetch the next page
      const nextPageKey = getKey(size);
      if (nextPageKey) {
        // Use the fetcher to preload the data without storing it
        fetcher(nextPageKey);
      }
    }
  }, [hasMore, isLoadingMore, data, getKey, size]);

  return {
    consultants,
    error,
    isLoading,
    isLoadingMore,
    hasMore,
    loadMore: () => setSize(size + 1),
    refresh: () => mutate(),
    prefetchNextPage,
    firstPageKey,
  };
}

export function groupConsultantsByDomain(consultants: TConsultantProfile[]) {
  const grouped = new Map<string, TConsultantProfile[]>();

  consultants.forEach((consultant) => {
    if (!grouped.has(consultant.domain.id)) {
      grouped.set(consultant.domain.id, []);
    }
    grouped.get(consultant.domain.id)?.push(consultant);
  });

  return grouped;
}
