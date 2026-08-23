import { Prisma, type OrgPlanVisibility } from "@prisma/client";
import { MARKETPLACE_VISIBILITY } from "@/lib/api/plans/visibility";

/**
 * Query builders for the public plan list endpoints.
 *
 * Moved from app/api/plans/shared/plan-filters.ts (which re-exports these)
 * so lib/data/explore-programs.ts can build the /explore/programs RSC seed
 * with the exact same where/orderBy the API serves — app/ is the routing
 * layer and lib/ must not import from it.
 */

export interface PlanFilterParams {
  consultantId: string | null;
  topicIds: string | null;
  language: string | null;
  domainId: string | null;
  sort: string | null;
  minPrice: number | undefined;
  maxPrice: number | undefined;
  search: string | null;
  level: string | null;
  page: number;
  limit: number;
  skip: number;
}

// Public pagination inputs are clamped, not rejected: malformed values fall
// back to the defaults and oversized ones are bounded, so a crafted query
// cannot reach Prisma with a negative `skip` (it throws), a negative `take`
// (it reads from the END of the table), or an arbitrarily large slice.
const MAX_PAGE = 10_000;
const MAX_LIMIT = 100;

function clampPositiveInt(
  raw: string | null,
  fallback: number,
  max: number,
): number {
  const parsed = Number.parseInt(raw ?? "", 10);
  if (Number.isNaN(parsed) || parsed < 1) return fallback;
  return Math.min(parsed, max);
}

/**
 * Parse filter query params from a URLSearchParams with NaN guards on numeric values.
 */
export function parsePlanFilters(
  searchParams: URLSearchParams,
): PlanFilterParams {
  const page = clampPositiveInt(searchParams.get("page"), 1, MAX_PAGE);
  const limit = clampPositiveInt(searchParams.get("limit"), 10, MAX_LIMIT);
  const skip = (page - 1) * limit;

  const rawMin = searchParams.get("minPrice");
  const rawMax = searchParams.get("maxPrice");
  const parsedMin = rawMin ? Number.parseInt(rawMin, 10) : undefined;
  const parsedMax = rawMax ? Number.parseInt(rawMax, 10) : undefined;

  return {
    consultantId: searchParams.get("consultantId"),
    topicIds: searchParams.get("topicIds"),
    language: searchParams.get("language"),
    domainId: searchParams.get("domainId"),
    sort: searchParams.get("sort"),
    minPrice:
      parsedMin !== undefined && !isNaN(parsedMin) ? parsedMin : undefined,
    maxPrice:
      parsedMax !== undefined && !isNaN(parsedMax) ? parsedMax : undefined,
    search: searchParams.get("search"),
    // "all" is the UI's no-op sentinel, not a stored level value.
    level:
      searchParams.get("level") === "all" ? null : searchParams.get("level"),
    page,
    limit,
    skip,
  };
}

/**
 * Shared plan WHERE clause — structurally compatible with both
 * Prisma.WebinarPlanWhereInput and Prisma.ClassPlanWhereInput.
 */
export interface PlanWhereClause {
  consultantProfileId?: string;
  language?: string;
  level?: string;
  price?: { gte?: number; lte?: number };
  title?: { contains: string; mode: "insensitive" };
  topics?: { some: { id: { in: string[] } } };
  consultantProfile?: { domainId: string };
  visibility?: { in: OrgPlanVisibility[] };
  /** #catalog-archive — `null` keeps withdrawn plans out of public lists. */
  archivedAt?: null;
}

/**
 * Build a Prisma where clause from parsed plan filters.
 * The returned object is structurally compatible with both
 * Prisma.WebinarPlanWhereInput and Prisma.ClassPlanWhereInput.
 */
export function buildPlanWhereClause(
  filters: PlanFilterParams,
): PlanWhereClause {
  // #726 — public marketplace must not surface ORG_ONLY plans. The filter
  // is applied unconditionally here because every caller of this helper
  // is a public surface; org-internal catalog endpoints have their own
  // where-builders.
  // #catalog-archive — an archived plan is withdrawn from sale. It is kept
  // rather than deleted because the row carries the terms of every booking made
  // against it (and the FK chain cascades to Payment), so discovery has to
  // filter it out explicitly. Same reasoning as the visibility gate above: every
  // caller here is a public surface.
  const where: PlanWhereClause = {
    visibility: { in: MARKETPLACE_VISIBILITY },
    archivedAt: null,
  };

  if (filters.consultantId) {
    where.consultantProfileId = filters.consultantId;
  }
  if (filters.language) {
    where.language = filters.language;
  }
  // Level used to be filtered client-side over the already-loaded infinite-scroll
  // page, so a matching program on a later page simply never appeared.
  if (filters.level) {
    where.level = filters.level;
  }
  if (filters.minPrice !== undefined || filters.maxPrice !== undefined) {
    const price: { gte?: number; lte?: number } = {};
    if (filters.minPrice !== undefined) price.gte = filters.minPrice;
    if (filters.maxPrice !== undefined) price.lte = filters.maxPrice;
    where.price = price;
  }
  if (filters.search) {
    where.title = { contains: filters.search, mode: "insensitive" };
  }
  if (filters.topicIds) {
    const ids = filters.topicIds.split(",").filter(Boolean);
    if (ids.length > 0) {
      where.topics = { some: { id: { in: ids } } };
    }
  }
  if (filters.domainId) {
    where.consultantProfile = { domainId: filters.domainId };
  }

  return where;
}

/**
 * Shared plan ORDER BY clause — structurally compatible with both
 * Prisma.WebinarPlanOrderByWithRelationInput and Prisma.ClassPlanOrderByWithRelationInput.
 */
export interface PlanOrderByClause {
  createdAt?: Prisma.SortOrder;
  price?: Prisma.SortOrder;
  title?: Prisma.SortOrder;
}

/**
 * Build a Prisma orderBy object from a sort string.
 */
export function buildPlanOrderBy(
  sort: string | null,
): PlanOrderByClause | undefined {
  if (sort === "newest") return { createdAt: "desc" };
  if (sort === "price-asc") return { price: "asc" };
  if (sort === "price-desc") return { price: "desc" };
  if (sort === "title-asc") return { title: "asc" };
  if (sort === "title-desc") return { title: "desc" };
  return undefined;
}
