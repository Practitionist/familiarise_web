"use client";

import { useInfiniteQuery, keepPreviousData } from "@tanstack/react-query";
import { useCallback, useMemo } from "react";
import type { IConsultantCardData } from "@/types/consultant";
import {
  CONSULTANTS_PER_PAGE,
  isDefaultFilters,
  type IExpertFilters,
} from "../utils";

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

interface DefaultPage {
  data: IConsultantCardData[];
  meta: { total: number; page: number; limit: number; totalPages: number };
}

export function useConsultants(
  filters: IExpertFilters,
  /**
   * Server-rendered first page for the DEFAULT filter set. When the visitor
   * arrives with no query params, the listing paints from the RSC payload
   * with zero client roundtrips — no extra function invocation, no pooled
   * query on the critical path (#1769 follow-up). Any active filter (sort,
   * domain, search, …) serializes to a non-empty query string, in which case
   * this seed is ignored and the hook fetches normally.
   */
  defaultPage?: DefaultPage,
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
    // Seed the default view from the server render. filtersToSearchParams
    // emits '' exactly for the default filter set (every non-default writes
    // at least one param), so a share-link visitor (?sort=rating, ?domain=…)
    // never sees a flash of the wrong list.
    ...(isDefaultFilters(filters) &&
      defaultPage && {
        initialData: { pages: [defaultPage], pageParams: [0] },
      }),
    getNextPageParam: (lastPage, pages) => {
      if (lastPage?.data?.length === CONSULTANTS_PER_PAGE) {
        return pages.length;
      }
      return undefined;
    },
    initialPageParam: 0,
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
