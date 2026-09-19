import { NextResponse } from "next/server";
import { unstable_cache } from "next/cache";
import prisma from "@/lib/prisma";
import { Prisma, type OrgPlanVisibility } from "@prisma/client";
import { MARKETPLACE_VISIBILITY } from "@/lib/api/plans/visibility";

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

/**
 * Parse filter query params from a URLSearchParams with NaN guards on numeric values.
 */
export function parsePlanFilters(
  searchParams: URLSearchParams,
): PlanFilterParams {
  const page = Math.max(
    1,
    Number.parseInt(searchParams.get("page") || "1") || 1,
  );
  // Bounded: an uncapped `take` lets one request scan the whole table.
  // Callers ask for 8–12 rows; 50 is generous headroom, not a behavior cap.
  const limit = Math.min(
    50,
    Math.max(1, Number.parseInt(searchParams.get("limit") || "10") || 10),
  );
  const skip = (page - 1) * limit;

  const rawMin = searchParams.get("minPrice");
  const rawMax = searchParams.get("maxPrice");
  const parsedMin = rawMin ? parseInt(rawMin) : undefined;
  const parsedMax = rawMax ? parseInt(rawMax) : undefined;

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

/**
 * Build a standard paginated JSON response.
 */
export function paginatedResponse(
  data: unknown[],
  total: number,
  page: number,
  limit: number,
) {
  return NextResponse.json(
    {
      data,
      meta: { total, page, limit, totalPages: Math.ceil(total / limit) },
    },
    {
      status: 200,
      headers: {
        "Cache-Control": "public, s-maxage=60, stale-while-revalidate=300",
      },
    },
  );
}

/**
 * Shared logic for rank-then-paginate (used by trending sort).
 * Takes pre-ranked items (with id & count), paginates, then fetches
 * full records via the provided callback.
 */
export async function rankAndPaginate<T extends { id: string }>(
  ranked: { id: string; count: number }[],
  fetchByIds: (ids: string[]) => Promise<T[]>,
  skip: number,
  limit: number,
  page: number,
): Promise<NextResponse> {
  const total = ranked.length;
  const paginatedIds = ranked.slice(skip, skip + limit).map((r) => r.id);

  const items = paginatedIds.length > 0 ? await fetchByIds(paginatedIds) : [];

  // Re-sort to match the ranking order
  const idOrder = new Map(paginatedIds.map((id, i) => [id, i]));
  items.sort((a, b) => (idOrder.get(a.id) ?? 0) - (idOrder.get(b.id) ?? 0));

  return paginatedResponse(items, total, page, limit);
}

/**
 * Trending rank, cached 60s per filter combination.
 *
 * The rank scans every plan's nested occurrences in a 30-day window — the
 * heaviest read on these list endpoints — while the ORDER it produces is
 * insensitive to minute-level freshness (a plan jumping rank within 60s is
 * invisible). The cache key is the JSON of the public where clause, which
 * is pure data (strings/numbers/arrays/null) by construction in
 * buildPlanWhereClause, so keying is exact and user-agnostic.
 */
async function webinarTrendingRankUncached(
  whereKey: string,
): Promise<{ id: string; count: number }[]> {
  const where = JSON.parse(whereKey) as Prisma.WebinarPlanWhereInput;
  const thirtyDaysAgo = new Date();
  thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 30);

  const plansForRanking = await prisma.webinarPlan.findMany({
    where,
    select: {
      id: true,
      webinars: {
        select: {
          appointment: {
            select: {
              occurrences: {
                where: { createdAt: { gte: thirtyDaysAgo } },
                select: { id: true },
              },
            },
          },
        },
      },
    },
  });

  return (
    plansForRanking
      .map((p) => ({
        id: p.id,
        count: p.webinars.reduce(
          (sum, w) => sum + (w.appointment?.occurrences?.length ?? 0),
          0,
        ),
      }))
      // Deterministic tie-break: equal counts must not reshuffle across
      // revalidations, or paged clients see duplicates/gaps.
      .sort((a, b) => b.count - a.count || a.id.localeCompare(b.id))
  );
}

export const getWebinarTrendingRank = unstable_cache(
  webinarTrendingRankUncached,
  ["webinar-trending-rank"],
  { revalidate: 60 },
);

async function classTrendingRankUncached(
  whereKey: string,
): Promise<{ id: string; count: number }[]> {
  const where = JSON.parse(whereKey) as Prisma.ClassPlanWhereInput;
  const thirtyDaysAgo = new Date();
  thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 30);

  const plansForRanking = await prisma.classPlan.findMany({
    where,
    select: {
      id: true,
      classes: {
        select: {
          appointment: {
            select: {
              id: true,
              // #1554 — one row per held call, so the count is the rows.
              _count: {
                select: {
                  occurrences: {
                    where: {
                      createdAt: { gte: thirtyDaysAgo },
                      deletedAt: null,
                      completionStatus: {
                        notIn: ["CANCELLED", "RESCHEDULED"],
                      },
                    },
                  },
                },
              },
            },
          },
        },
      },
    },
  });

  // The ranking measures how much of a plan is running: one occurrence
  // row is one held call (#1554), so the live rows are the count.
  return (
    plansForRanking
      .map((p) => ({
        id: p.id,
        count: p.classes.reduce(
          (sum, cls) => sum + (cls.appointment?._count.occurrences ?? 0),
          0,
        ),
      }))
      // Deterministic tie-break (see webinar rank above).
      .sort((a, b) => b.count - a.count || a.id.localeCompare(b.id))
  );
}

export const getClassTrendingRank = unstable_cache(
  classTrendingRankUncached,
  ["class-trending-rank"],
  { revalidate: 60 },
);
