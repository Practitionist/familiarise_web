import type { IConsultantCardData } from "@/types/consultant";
import { SortOption } from "./components/SearchBar";
import { ReadonlyURLSearchParams } from "next/navigation";

export const CONSULTANTS_PER_PAGE = 10;

export interface IExpertFilters {
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

export const DEFAULT_EXPERT_FILTERS: IExpertFilters = {
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

export interface IExpertsMetaData {
  domains: { id: string; name: string }[];
  subdomains: { id: string; name: string; domainId: string | null }[];
  tags: { id: string; name: string; domainId: string | null }[];
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

export interface IConsultantsByDomain {
  [domain: string]: IConsultantCardData[];
}

export function groupConsultantsByDomain(
  consultants: IConsultantCardData[],
): IConsultantsByDomain {
  return consultants.reduce((acc, consultant) => {
    const domainName = consultant.domain?.name || "Other";
    if (!acc[domainName]) {
      acc[domainName] = [];
    }
    acc[domainName].push(consultant);
    return acc;
  }, {} as IConsultantsByDomain);
}

// Parse IExpertFilters from URL search params
export function filtersFromSearchParams(
  params: ReadonlyURLSearchParams,
): IExpertFilters {
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

// Serialize IExpertFilters to URLSearchParams string
export function filtersToSearchParams(filters: IExpertFilters): string {
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
