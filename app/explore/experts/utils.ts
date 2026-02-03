import { useQuery, useInfiniteQuery } from "@tanstack/react-query";
import { Domain, SubDomain, Tag } from "@prisma/client";
import { TConsultantProfile } from "@/types/consultant";
import { SortOption } from "./components/SearchBar";
import { useCallback, useMemo } from "react";
import { ReadonlyURLSearchParams } from "next/navigation";

export const CONSULTANTS_PER_PAGE = 10;

export interface ExpertFilters {
  domain: string | null;
  subdomain: string | null;
  tags: string[];
  experience: number;
  search: string;
  sort: SortOption;
  minPrice?: number;
  maxPrice?: number;
  availability?: "has_slots" | "this_week";
  language?: string;
}

export const DEFAULT_EXPERT_FILTERS: ExpertFilters = {
  domain: null,
  subdomain: null,
  tags: [],
  experience: 0,
  search: "",
  sort: "nameAsc",
  minPrice: undefined,
  maxPrice: undefined,
  availability: undefined,
  language: undefined,
};

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
  availableLanguages: string[];
  availabilityStats: {
    hasSlots: number;
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

// Parse ExpertFilters from URL search params
export function filtersFromSearchParams(
  params: ReadonlyURLSearchParams,
): ExpertFilters {
  const rawMinPrice = params.get("minPrice");
  const rawMaxPrice = params.get("maxPrice");
  const rawExperience = params.get("experience");
  const rawAvailability = params.get("availability");

  return {
    domain: params.get("domain"),
    subdomain: params.get("subdomain"),
    tags: params.get("tags")?.split(",").filter(Boolean) || [],
    experience: rawExperience ? parseInt(rawExperience) || 0 : 0,
    search: params.get("search") || "",
    sort: (params.get("sort") as SortOption) || "nameAsc",
    minPrice: rawMinPrice ? parseFloat(rawMinPrice) || undefined : undefined,
    maxPrice: rawMaxPrice ? parseFloat(rawMaxPrice) || undefined : undefined,
    availability:
      rawAvailability === "has_slots" || rawAvailability === "this_week"
        ? rawAvailability
        : undefined,
    language: params.get("language") || undefined,
  };
}

// Serialize ExpertFilters to URLSearchParams string
export function filtersToSearchParams(filters: ExpertFilters): string {
  const params = new URLSearchParams();
  if (filters.domain) params.set("domain", filters.domain);
  if (filters.subdomain) params.set("subdomain", filters.subdomain);
  if (filters.tags.length > 0) params.set("tags", filters.tags.join(","));
  if (filters.experience > 0)
    params.set("experience", String(filters.experience));
  if (filters.search) params.set("search", filters.search);
  if (filters.sort !== "nameAsc") params.set("sort", filters.sort);
  if (filters.minPrice !== undefined)
    params.set("minPrice", String(filters.minPrice));
  if (filters.maxPrice !== undefined)
    params.set("maxPrice", String(filters.maxPrice));
  if (filters.availability) params.set("availability", filters.availability);
  if (filters.language) params.set("language", filters.language);
  return params.toString();
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

export function useConsultantsMetadata() {
  const { data, error, isLoading, refetch } = useQuery<{ data: MetaData }>({
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
  const { data, isLoading } = useQuery<{ data: TConsultantProfile[] }>({
    queryKey: ["curated-experts", sort, limit],
    queryFn: () =>
      fetchConsultantsData(`/api/user/consultants?sort=${sort}&limit=${limit}`),
    staleTime: 5 * 60 * 1000,
    gcTime: 15 * 60 * 1000,
    retry: 2,
  });

  return { experts: data?.data || [], isLoading };
}

export function useConsultants(filters: ExpertFilters) {
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

  const consultants: TConsultantProfile[] = useMemo(
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
