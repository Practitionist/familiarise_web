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

/**
 * Statuses only the `[id]` PATCH may write. The list PATCH has no approval
 * lock, no payment-link step and no self-approval check, so a consultee could
 * flip their own PENDING row to APPROVED through it (#1704).
 */
export const APPROVAL_STATUSES_DETAIL_ONLY: ReadonlySet<AppointmentStatus> =
  new Set([
    AppointmentStatus.APPROVED,
    AppointmentStatus.APPROVED_PENDING_PAYMENT,
    AppointmentStatus.SCHEDULED,
  ]);

export const USE_DETAIL_APPROVAL_MESSAGE =
  "Approval is not available on the list route. Use the request's own endpoint.";
