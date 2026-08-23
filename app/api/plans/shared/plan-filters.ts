import { NextResponse } from "next/server";

// The query builders live in lib/api/plans/plan-filters.ts so that
// lib/data/explore-programs.ts (the /explore/programs RSC seed) can share
// them — lib/ must not import from app/. Re-exported here to keep the
// routes' existing import paths working.
export {
  parsePlanFilters,
  buildPlanWhereClause,
  buildPlanOrderBy,
  type PlanFilterParams,
  type PlanWhereClause,
  type PlanOrderByClause,
} from "@/lib/api/plans/plan-filters";

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
