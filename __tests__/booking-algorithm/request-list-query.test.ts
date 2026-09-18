/**
 * @jest-environment node
 */

/**
 * #1704 items 1, 4 — the request lists parse their query through one
 * validated schema (bad input is a 400, never a NaN reaching Prisma) and
 * page with an id tiebreaker.
 */

import {
  parseRequestListQuery,
  requestListOrderBy,
} from "../../lib/booking/list-query";

describe("parseRequestListQuery", () => {
  it("defaults page/limit/sortOrder and leaves status unset", () => {
    const result = parseRequestListQuery(new URLSearchParams(""));
    expect(result).toEqual({
      ok: true,
      query: { page: 1, limit: 10, sortOrder: "desc", status: undefined },
    });
  });

  it("answers VALIDATION_ERROR for a non-numeric page", () => {
    expect(parseRequestListQuery(new URLSearchParams("page=abc"))).toEqual(
      expect.objectContaining({ ok: false, code: "VALIDATION_ERROR" }),
    );
  });

  it("rejects an unknown status and a limit above the clamp", () => {
    expect(parseRequestListQuery(new URLSearchParams("status=NOPE")).ok).toBe(
      false,
    );
    expect(parseRequestListQuery(new URLSearchParams("limit=500")).ok).toBe(
      false,
    );
    const ok = parseRequestListQuery(
      new URLSearchParams("status=PENDING&sortOrder=asc&page=2&limit=25"),
    );
    expect(ok).toEqual({
      ok: true,
      query: { page: 2, limit: 25, sortOrder: "asc", status: "PENDING" },
    });
  });

  it("orders by requestedAt then id so paging is deterministic", () => {
    expect(requestListOrderBy("asc")).toEqual([
      { requestedAt: "asc" },
      { id: "asc" },
    ]);
  });
});
