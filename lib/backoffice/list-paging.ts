/**
 * Paging for the back-office lists: a value that is not a positive whole
 * number falls back to the default, and a page never holds more than 100 rows.
 */

import { z } from "zod";

export const MAX_PAGE_SIZE = 100;

/** A positive whole number, else `fallback`; never above `max`. */
const positiveInt = (fallback: number, max: number) =>
  z.coerce
    .number()
    .int()
    .positive()
    .catch(fallback)
    .transform((n) => Math.min(n, max));

const nonNegativeInt = z.coerce.number().int().min(0).catch(0);

export interface PageParams {
  page: number;
  limit: number;
  skip: number;
}

/** `?page` and `?limit` from a request, clamped. */
export function readPageParams(
  searchParams: URLSearchParams,
  defaultLimit = 20,
): PageParams {
  const { page, limit } = z
    .object({
      page: positiveInt(1, 10_000),
      limit: positiveInt(defaultLimit, MAX_PAGE_SIZE),
    })
    .parse({
      page: searchParams.get("page") ?? undefined,
      limit: searchParams.get("limit") ?? undefined,
    });
  return { page, limit, skip: (page - 1) * limit };
}

/** `?limit` and `?offset` from a request, clamped, for the lists that page by offset. */
export function readOffsetParams(
  searchParams: URLSearchParams,
  defaultLimit = 20,
): { limit: number; offset: number } {
  return z
    .object({
      limit: positiveInt(defaultLimit, MAX_PAGE_SIZE),
      offset: nonNegativeInt.transform((n) => Math.min(n, 1_000_000)),
    })
    .parse({
      limit: searchParams.get("limit") ?? undefined,
      offset: searchParams.get("offset") ?? undefined,
    });
}
