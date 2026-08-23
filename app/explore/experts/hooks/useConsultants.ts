"use client";

import { useInfiniteQuery, keepPreviousData } from "@tanstack/react-query";
import { useCallback, useMemo } from "react";
import type { IConsultantCardData } from "@/types/consultant";
import {
  CONSULTANTS_PER_PAGE,
  DEFAULT_EXPERT_FILTERS,
  type IExpertFilters,
} from "../utils";

/** One page of /api/user/consultants — also the shape of the RSC-seeded
 *  default page from getDefaultConsultantsPage (same function backs both). */
export interface ConsultantsPage {
  data: IConsultantCardData[];
  meta: { total: number; page: number; limit: number; totalPages: number };
}

// Seed only the exact query the server pre-rendered: the unfiltered default
// view (the API's isDefaultView predicate). A deep link like ?sort=rating has
// a different key and must fetch normally — seeding it with the nameAsc page
// would show wrongly-ordered results without a refetch.
function isDefaultExpertFilters(filters: IExpertFilters): boolean {
  const d = DEFAULT_EXPERT_FILTERS;
  return (
    filters.domain === d.domain &&
    filters.subdomain === d.subdomain &&
    filters.tags.length === 0 &&
    filters.experience === d.experience &&
    filters.search === d.search &&
    filters.sort === d.sort &&
    filters.minPrice === d.minPrice &&
    filters.maxPrice === d.maxPrice &&
    filters.minRating === d.minRating &&
    filters.companies.length === 0 &&
    filters.language === d.language &&
    filters.affiliationType === d.affiliationType
  );
}

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

export function useConsultants(
  filters: IExpertFilters,
  initialPage?: ConsultantsPage,
) {
  const {
    domain: selectedDomain,
    subdomain: selectedSubdomain,
    tags: selectedTags,
    experience: experienceYears,
    search: searchTerm,
    sort: sortBy,
    minPrice,
    maxPrice,
    minRating,
    companies,
    language,
    affiliationType,
  } = filters;

  const getKey = useCallback(
    (pageIndex: number) => {
      const params = new URLSearchParams({
        page: (pageIndex + 1).toString(),
        limit: CONSULTANTS_PER_PAGE.toString(),
        ...(selectedDomain && { domain: selectedDomain }),
        ...(selectedSubdomain && { subdomain: selectedSubdomain }),
        ...(experienceYears > 0 && { experience: experienceYears.toString() }),
        ...(searchTerm && { search: searchTerm }),
        sort: sortBy,
        ...(minPrice !== undefined && { minPrice: String(minPrice) }),
        ...(maxPrice !== undefined && { maxPrice: String(maxPrice) }),
        ...(minRating !== undefined && { minRating: String(minRating) }),
        ...(language && { language }),
        ...(affiliationType && { affiliationType }),
      });
      // Repeated params (not comma-joined) so a literal comma in a tag/company
      // name can't corrupt the filter — must match the API's getAll() read.
      for (const tag of selectedTags) params.append("tags", tag);
      for (const company of companies) params.append("companies", company);

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
      minRating,
      companies,
      language,
      affiliationType,
    ],
  );

  const {
    data,
    error,
    fetchNextPage,
    hasNextPage,
    isLoading,
    isFetching,
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
      minRating,
      companies,
      language,
      affiliationType,
    ],
    queryFn: ({ pageParam = 0 }) => fetchConsultantsData(getKey(pageParam)),
    getNextPageParam: (lastPage, pages) => {
      if (lastPage?.data?.length === CONSULTANTS_PER_PAGE) {
        return pages.length;
      }
      return undefined;
    },
    initialPageParam: 0,
    // The RSC already rendered page 1 of the default view — hand it to React
    // Query so the grid paints data instead of a second skeleton pass and no
    // duplicate /api/user/consultants request fires on mount. The key is
    // built purely from filter state (never the session), so server and
    // client derive the identical key value from the first render.
    ...(initialPage && isDefaultExpertFilters(filters)
      ? { initialData: { pages: [initialPage], pageParams: [0] } }
      : {}),
    placeholderData: keepPreviousData,
    staleTime: 2 * 60 * 1000,
    gcTime: 10 * 60 * 1000,
    retry: 3,
    retryDelay: 3000,
  });

  const consultants: IConsultantCardData[] = useMemo(
    () => (data ? data.pages.flatMap((page) => page.data) : []),
    [data],
  );

  return {
    consultants,
    error,
    isLoading,
    isLoadingMore: isFetchingNextPage,
    isRefetching: isFetching && !isLoading && !isFetchingNextPage,
    hasMore: hasNextPage ?? false,
    loadMore: () => fetchNextPage(),
    refresh: refetch,
    firstPageKey: getKey(0),
  };
}
