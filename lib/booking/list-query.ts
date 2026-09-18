import { AppointmentStatus, type Prisma } from "@prisma/client";
import { z } from "zod";

/**
 * Query contract for the two request lists (`/api/bookings/consultations`,
 * `/api/bookings/subscriptions`). #1704 — bare `parseInt` let `?page=abc`
 * reach Prisma as NaN (a 500) and the status/sort params were cast, not
 * checked. The clamp matches `listAppointmentsScoped` (1..100, default 10).
 */
export const REQUEST_LIST_DEFAULT_LIMIT = 10;

export const RequestListQuerySchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce
    .number()
    .int()
    .min(1)
    .max(100)
    .default(REQUEST_LIST_DEFAULT_LIMIT),
  status: z.nativeEnum(AppointmentStatus).optional(),
  sortOrder: z.enum(["asc", "desc"]).default("desc"),
});

export type RequestListQuery = z.infer<typeof RequestListQuerySchema>;

export type RequestListQueryResult =
  | { ok: true; query: RequestListQuery }
  | { ok: false; error: string; code: "VALIDATION_ERROR" };

/** Reads only the keys the schema owns; absent keys fall to their defaults. */
export function parseRequestListQuery(
  searchParams: URLSearchParams,
): RequestListQueryResult {
  const raw: Record<string, string> = {};
  for (const key of ["page", "limit", "status", "sortOrder"] as const) {
    const value = searchParams.get(key);
    if (value !== null) raw[key] = value;
  }
  const parsed = RequestListQuerySchema.safeParse(raw);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    return {
      ok: false,
      code: "VALIDATION_ERROR",
      error: issue
        ? `${issue.path.join(".")}: ${issue.message}`
        : "Invalid query",
    };
  }
  return { ok: true, query: parsed.data };
}

/**
 * `requestedAt` alone is not a total order — two requests submitted in the
 * same millisecond could swap pages between reads. The id tiebreaker makes
 * paging deterministic (#1704).
 */
export function requestListOrderBy(
  sortOrder: RequestListQuery["sortOrder"],
): Array<{ requestedAt: Prisma.SortOrder } | { id: Prisma.SortOrder }> {
  return [{ requestedAt: sortOrder }, { id: sortOrder }];
}
