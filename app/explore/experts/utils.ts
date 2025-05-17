import useSWR from "swr";
import useSWRInfinite from "swr/infinite";
import { Domain, SubDomain, Tag } from "@prisma/client";
import { TConsultantProfile } from "@/types/consultant";
import { SortOption } from "./components/SearchBar";

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

// SWR fetcher function
const fetcher = (url: string) => fetch(url).then((res) => res.json());

export function useConsultantsMetadata() {
  const { data, error, isLoading } = useSWR<{ data: MetaData }>(
    "/api/user/consultants/meta",
    fetcher,
    {
      revalidateOnFocus: false,
    },
  );

  return {
    metadata: data?.data || null,
    isLoading,
    error,
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
  const getKey = (pageIndex: number) => {
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
  };

  const { data, error, size, setSize, isLoading, isValidating } =
    useSWRInfinite(getKey, fetcher, {
      revalidateFirstPage: false,
      revalidateOnFocus: false,
      revalidateAll: false,
      persistSize: false,
    });

  const consultants: TConsultantProfile[] = data
    ? data.flatMap((page) => page.data)
    : [];
  const hasMore = data
    ? data[data.length - 1]?.data.length === CONSULTANTS_PER_PAGE
    : true;
  const isLoadingMore =
    isLoading || (size > 0 && data && typeof data[size - 1] === "undefined");

  return {
    consultants,
    error,
    isLoading,
    isLoadingMore,
    hasMore,
    loadMore: () => setSize(size + 1),
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
