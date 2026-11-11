"use client";

import {
  useUrlSyncedFilters,
  type UrlSyncedFilters,
} from "@/app/explore/hooks/useUrlSyncedFilters";
import {
  DEFAULT_EXPERT_FILTERS,
  filtersFromSearchParams,
  filtersToSearchParams,
  type IExpertFilters,
} from "../utils";

// `?expert=` is the details-drawer selection; the filter rewrite carries it.
const PRESERVED_PARAMS = ["expert"] as const;

/**
 * Experts filter state plus its URL mirror. Soft navigation into this route
 * with a new query (nav "Top rated", category links) rehydrates the filters;
 * see `useUrlSyncedFilters` for the sync rules.
 */
export function useExpertsFilters(): UrlSyncedFilters<IExpertFilters> {
  return useUrlSyncedFilters<IExpertFilters>({
    basePath: "/explore/experts",
    defaults: DEFAULT_EXPERT_FILTERS,
    fromSearchParams: filtersFromSearchParams,
    toSearchParams: filtersToSearchParams,
    preserveParams: PRESERVED_PARAMS,
  });
}
