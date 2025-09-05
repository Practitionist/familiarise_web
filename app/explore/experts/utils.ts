import { useQuery, useInfiniteQuery } from "@tanstack/react-query";
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

export interface ConsultantsByDomain {
  [domain: string]: TConsultantProfile[];
}

export function groupConsultantsByDomain(
  consultants: TConsultantProfile[],
): ConsultantsByDomain {
  return consultants.reduce((acc, consultant) => {
    const domainName = consultant.domain?.name || "Other";
    if (!acc[domainName]) {
      acc[domainName] = [];
    }
    acc[domainName].push(consultant);
    return acc;
  }, {} as ConsultantsByDomain);
}

// Enhanced React Query fetcher function with error handling for consultants
const fetchConsultantsData = async (url: string) => {
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
  const { data, error, isLoading, refetch } = useQuery<{ data: MetaData }>({
    queryKey: ["consultants-metadata"],
    queryFn: () => fetchConsultantsData("/api/user/consultants/meta"),
    staleTime: 5 * 60 * 1000, // 5 minutes
    gcTime: 10 * 60 * 1000, // 10 minutes
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
    ],
    queryFn: ({ pageParam = 0 }) => fetchConsultantsData(getKey(pageParam)),
    getNextPageParam: (lastPage, pages) => {
      if (lastPage?.data?.length === CONSULTANTS_PER_PAGE) {
        return pages.length;
      }
      return undefined;
    },
    initialPageParam: 0,
    staleTime: 2 * 60 * 1000, // 2 minutes
    gcTime: 10 * 60 * 1000, // 10 minutes
    retry: 3,
    retryDelay: 3000,
  });

  const consultants: TConsultantProfile[] = data
    ? data.pages.flatMap((page) => page.data)
    : [];

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
