import type { IConsultantCardData } from "@/types/consultant";
import { SortOption } from "./components/SearchBar";
import type { ReadonlyParams } from "@/lib/explore/filter-codec";

export const CONSULTANTS_PER_PAGE = 10;

export type AffiliationType = "independent" | "agency" | null;

export interface IExpertFilters {
  domain: string | null;
  subdomain: string | null;
  tags: string[];
  experience: number;
  search: string;
  sort: SortOption;
  minPrice?: number;
  maxPrice?: number;
  minRating?: number;
  companies: string[];
  language?: string;
  affiliationType: AffiliationType;
  /** Drill-down to one host org's roster (by slug). */
  orgSlug?: string | null;
}

export const DEFAULT_EXPERT_FILTERS: IExpertFilters = {
  domain: null,
  subdomain: null,
  tags: [],
  experience: 0,
  search: "",
  sort: "recommended",
  minPrice: undefined,
  maxPrice: undefined,
  minRating: undefined,
  companies: [],
  language: undefined,
  affiliationType: null,
  orgSlug: null,
};

export interface IExpertsMetaData {
  domains: { id: string; name: string }[];
  subdomains: { id: string; name: string; domainId: string | null }[];
  tags: { id: string; name: string; domainId: string | null }[];
  consultantMetadata: {
    totalConsultants: number;
    /** Counts for the All / Independent / Agency-Org expert-type filter. */
    affiliationCounts?: {
      all: number;
      independent: number;
      agency: number;
    };
    consultantsByDomain: {
      id: string;
      name: string;
      consultantCount: number;
    }[];
    /** Mean of the PUBLISHED per-consultant scores, 0 when none qualify. */
    averageRating: number;
    /** Denominator behind `averageRating` — published reviews across the
     *  directory. Gates whether the rating is shown at all (#1485). */
    publishedReviewCount: number;
    /** Meetings actually held across the platform — COMPLETED slots, not
     *  appointments (#1485). */
    completedSessions: number;
  };
  availableLanguages: string[];
  availableCompanies: string[];
}

/**
 * Links written by hand (`?domain=Technology`) name a domain or specialty
 * instead of carrying its id. Returns the id-form patch for any such value so
 * the field select and the filter chip can find it; null when nothing needs
 * rewriting.
 */
export function resolveTaxonomyFilters(
  filters: Pick<IExpertFilters, "domain" | "subdomain">,
  metadata: Pick<IExpertsMetaData, "domains" | "subdomains">,
): Partial<Pick<IExpertFilters, "domain" | "subdomain">> | null {
  const patch: Partial<Pick<IExpertFilters, "domain" | "subdomain">> = {};
  const byName = (items: { id: string; name: string }[], value: string) => {
    if (items.some((item) => item.id === value)) return null;
    const wanted = value.trim().toLowerCase();
    return items.find((item) => item.name.toLowerCase() === wanted)?.id ?? null;
  };
  if (filters.domain) {
    const id = byName(metadata.domains, filters.domain);
    if (id) patch.domain = id;
  }
  if (filters.subdomain) {
    const id = byName(metadata.subdomains, filters.subdomain);
    if (id) patch.subdomain = id;
  }
  return Object.keys(patch).length > 0 ? patch : null;
}

export interface IConsultantsByDomain {
  /** Keyed by `domain.id` (with the literal string `"other"` as the
   *  fallback when a consultant has no domain). Renamed semantics from
   *  the previous name-keyed shape so domain renames can't break the
   *  grouped-by-domain layout. */
  [domainId: string]: IConsultantCardData[];
}

export function groupConsultantsByDomain(
  consultants: IConsultantCardData[],
): IConsultantsByDomain {
  return consultants.reduce((acc, consultant) => {
    const domainId = consultant.domain?.id || "other";
    if (!acc[domainId]) {
      acc[domainId] = [];
    }
    acc[domainId].push(consultant);
    return acc;
  }, {} as IConsultantsByDomain);
}

/** Parse a non-negative finite number from a URL param. Returns
 *  `undefined` for missing / blank / non-finite / negative values. */
function parseNumberParam(raw: string | null): number | undefined {
  if (raw === null || raw === "") return undefined;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed)) return undefined;
  if (parsed < 0) return undefined;
  return parsed;
}

/** A price bound in paise, read as the API reads it: only a safe whole number >= 0. */
function parsePricePaiseParam(raw: string | null): number | undefined {
  const parsed = parseNumberParam(raw);
  return parsed !== undefined && Number.isSafeInteger(parsed)
    ? parsed
    : undefined;
}

/** Like `parseNumberParam` but floors the result to an integer. Used for
 *  filter params the API also parses as integers (`parseInt`) so the UI
 *  state and the filter we send to the API can't drift apart on
 *  values like `?experience=1.5`. */
function parseIntegerParam(raw: string | null): number | undefined {
  const parsed = parseNumberParam(raw);
  if (parsed === undefined) return undefined;
  return Math.floor(parsed);
}

const VALID_SORT_OPTIONS: ReadonlySet<SortOption> = new Set<SortOption>([
  "recommended",
  "nameAsc",
  "nameDesc",
  "reviewCount",
  "rating",
  "trending",
  "newest",
]);

const VALID_AFFILIATIONS: ReadonlySet<string> = new Set([
  "independent",
  "agency",
]);

// Parse IExpertFilters from URL search params
export function filtersFromSearchParams(
  params: ReadonlyParams,
): IExpertFilters {
  const rawSort = params.get("sort");
  const sort: SortOption =
    rawSort && VALID_SORT_OPTIONS.has(rawSort as SortOption)
      ? (rawSort as SortOption)
      : "recommended";

  return {
    domain: params.get("domain"),
    subdomain: params.get("subdomain"),
    // Repeated params (?tags=a&tags=b), not comma-joined, so a literal comma in
    // a tag/company name can't split one value into two bogus filter terms.
    tags: params.getAll("tags").filter(Boolean),
    // API uses parseInt — keep both sides aligned so a hand-edited
    // ?experience=1.5 doesn't make the UI show 1.5 while the API filters at 1.
    experience: parseIntegerParam(params.get("experience")) ?? 0,
    search: params.get("search") || "",
    sort,
    // Don't treat 0 as unset — the slider's "Free" state writes both
    // minPrice=0 and maxPrice=0 and reloading that bookmarkable URL
    // must round-trip to the same Free filter. The slider's isDefault
    // check at write time already coerces the all-range default to
    // undefined, so the read side doesn't need to.
    minPrice: parsePricePaiseParam(params.get("minPrice")),
    maxPrice: parsePricePaiseParam(params.get("maxPrice")),
    minRating: parseNumberParam(params.get("minRating")),
    companies: params.getAll("companies").filter(Boolean),
    language: params.get("language") || undefined,
    affiliationType: VALID_AFFILIATIONS.has(params.get("affiliationType") ?? "")
      ? (params.get("affiliationType") as AffiliationType)
      : null,
    orgSlug: params.get("orgSlug") || null,
  };
}

// Serialize IExpertFilters to URLSearchParams string
export function filtersToSearchParams(filters: IExpertFilters): string {
  const params = new URLSearchParams();
  if (filters.domain) params.set("domain", filters.domain);
  if (filters.subdomain) params.set("subdomain", filters.subdomain);
  for (const tag of filters.tags) params.append("tags", tag);
  if (filters.experience > 0)
    params.set("experience", String(filters.experience));
  if (filters.search) params.set("search", filters.search);
  if (filters.sort !== "recommended") params.set("sort", filters.sort);
  if (filters.minPrice !== undefined)
    params.set("minPrice", String(filters.minPrice));
  if (filters.maxPrice !== undefined)
    params.set("maxPrice", String(filters.maxPrice));
  if (filters.minRating !== undefined)
    params.set("minRating", String(filters.minRating));
  for (const company of filters.companies) params.append("companies", company);
  if (filters.language) params.set("language", filters.language);
  if (filters.affiliationType)
    params.set("affiliationType", filters.affiliationType);
  if (filters.orgSlug) params.set("orgSlug", filters.orgSlug);
  return params.toString();
}
