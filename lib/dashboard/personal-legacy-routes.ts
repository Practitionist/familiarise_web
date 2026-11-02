import type { LibraryTab } from "./library-tabs";

type SearchParams = Record<string, string | string[] | undefined>;

interface LegacyTarget {
  page: string;
  /** Null opens the page's default tab. */
  tab: LibraryTab | null;
}

/** Retired consultee routes; each answers a 308 to its Library tab. */
export const CONSULTEE_LEGACY_ROUTES = {
  documents: { page: "library", tab: "documents" },
  recordings: { page: "library", tab: "recordings" },
  products: { page: "library", tab: "purchases" },
} as const satisfies Record<string, LegacyTarget>;

/** Retired consultant routes; each answers a 308 to its new page. */
export const CONSULTANT_LEGACY_ROUTES = {
  purchases: { page: "library", tab: null },
} as const satisfies Record<string, LegacyTarget>;

export type ConsulteeLegacyRoute = keyof typeof CONSULTEE_LEGACY_ROUTES;
export type ConsultantLegacyRoute = keyof typeof CONSULTANT_LEGACY_ROUTES;

/**
 * `path` with the old URL's query kept; a stale `tab` never survives, and the
 * destination's `tab`, when there is one, is set last.
 */
export function retiredRouteHref(
  path: string,
  tab: string | null,
  searchParams: SearchParams = {},
): string {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(searchParams)) {
    if (key === "tab" || value === undefined) continue;
    for (const v of Array.isArray(value) ? value : [value]) {
      params.append(key, v);
    }
  }
  if (tab) params.set("tab", tab);
  const qs = params.toString();
  return qs ? `${path}?${qs}` : path;
}

export function consulteeLegacyHref(
  consulteeId: string,
  route: ConsulteeLegacyRoute,
  searchParams: SearchParams = {},
): string {
  const target: LegacyTarget = CONSULTEE_LEGACY_ROUTES[route];
  return retiredRouteHref(
    `/dashboard/consultee/${consulteeId}/${target.page}`,
    target.tab,
    searchParams,
  );
}

export function consultantLegacyHref(
  consultantId: string,
  route: ConsultantLegacyRoute,
  searchParams: SearchParams = {},
): string {
  const target: LegacyTarget = CONSULTANT_LEGACY_ROUTES[route];
  return retiredRouteHref(
    `/dashboard/consultant/${consultantId}/${target.page}`,
    target.tab,
    searchParams,
  );
}
