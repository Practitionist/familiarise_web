import { NextResponse } from "next/server";

export interface PlanFilterParams {
  consultantId: string | null;
  topicIds: string | null;
  language: string | null;
  domainId: string | null;
  sort: string | null;
  minPrice: number | undefined;
  maxPrice: number | undefined;
  search: string | null;
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
  const page = parseInt(searchParams.get("page") || "1") || 1;
  const limit = parseInt(searchParams.get("limit") || "10") || 10;
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
    page,
    limit,
    skip,
  };
}

/**
 * Build a Prisma where clause from parsed plan filters.
 * Returns a plain object that can be cast to ClassPlanWhereInput or WebinarPlanWhereInput.
 */
export function buildPlanWhereClause(
  filters: PlanFilterParams,
): Record<string, unknown> {
  const where: Record<string, unknown> = {};

  if (filters.consultantId) {
    where.consultantProfileId = filters.consultantId;
  }
  if (filters.language) {
    where.language = filters.language;
  }
  if (filters.minPrice !== undefined || filters.maxPrice !== undefined) {
    const price: Record<string, number> = {};
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
 * Build a Prisma orderBy object from a sort string.
 */
export function buildPlanOrderBy(
  sort: string | null,
): Record<string, unknown> | undefined {
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
