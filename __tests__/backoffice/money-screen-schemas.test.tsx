/**
 * @jest-environment jsdom
 */

/**
 * Every money screen that fetches parses the body with its schema, so a
 * malformed 200 takes the error path instead of rendering a broken table.
 * Paging values outside the bounds fall back or clamp.
 */

import { z } from "zod";

import {
  breachSchema,
  erasureSchema,
  failedEmailSchema,
  pageOf,
} from "@/app/dashboard/(backoffice)/[tree]/compliance/CompliancePageClient";
import { consultantsPageSchema } from "@/app/dashboard/(backoffice)/[tree]/tds/TdsPageClient";
import { opsLogPageSchema } from "@/components/dashboard/backoffice/money/AuditTab";
import { incidentsPageSchema } from "@/components/dashboard/backoffice/money/IncidentsTab";
import { supportSpendReportSchema } from "@/components/dashboard/backoffice/money/SupportSpendTab";
import { payoutTrendSchema } from "@/components/dashboard/backoffice/payouts/PayoutsBoard";
import {
  payoutListPageSchema,
  readListBody,
} from "@/lib/backoffice/money-list-schemas";
import { readOffsetParams, readPageParams } from "@/lib/backoffice/list-paging";

const page = { total: 0, page: 1, pageSize: 20 };

/** [schema, a body the route sends, the same body broken] */
const CASES: [string, z.ZodTypeAny, unknown, unknown][] = [
  [
    "erasure requests",
    pageOf(erasureSchema),
    { data: [], ...page },
    { data: [{ id: "e1", status: "PENDING" }], ...page },
  ],
  [
    "data breaches",
    pageOf(breachSchema),
    { data: [], ...page },
    { data: [], total: -1, page: 1, pageSize: 20 },
  ],
  [
    "failed emails",
    pageOf(failedEmailSchema),
    { data: [], ...page },
    { data: [{ id: "m1", replayRefusal: "WHATEVER" }], ...page },
  ],
  [
    "TDS consultants",
    consultantsPageSchema,
    { financialYear: "2026-27", consultants: [], deducteeCount: 0, ...page },
    { financialYear: "2026-27", consultants: [{ totalTDS: "12" }], ...page },
  ],
  [
    "audit log",
    opsLogPageSchema,
    { rows: [], fetchedAt: "2026-11-17T00:00:00.000Z", ...page },
    { rows: [{ id: "r1" }], fetchedAt: "x", ...page },
  ],
  [
    "incidents",
    incidentsPageSchema,
    { incidents: [], suggestions: [], ...page },
    { incidents: [], suggestions: [{ startsAt: 1 }], ...page },
  ],
  [
    "support spend",
    supportSpendReportSchema,
    {
      operators: [],
      windows: { istDayStart: "a", rolling24hStart: "b", rolling30dStart: "c" },
      caps: { perPaymentPaise: 500_000, rolling24hPaise: 5_000_000 },
      fetchedAt: "d",
      ...page,
    },
    { operators: [{ userId: "u1" }], ...page },
  ],
  [
    "payouts trend",
    payoutTrendSchema,
    { series: [{ day: "2026-11-17", label: "17 Nov", totalPaise: 0 }] },
    { series: [{ day: "2026-11-17", totalPaise: "0" }] },
  ],
  [
    "payouts",
    payoutListPageSchema,
    {
      payouts: [],
      pagination: { total: 0, limit: 20, offset: 0, hasMore: false },
    },
    { payouts: [{ id: "p1", status: "SENT" }], pagination: {} },
  ],
];

describe.each(CASES)("%s", (_name, schema, good, bad) => {
  it("parses the route's body and rejects a malformed one", async () => {
    const body = (value: unknown) =>
      ({ ok: true, json: async () => value }) as unknown as Response;
    await expect(readListBody(body(good), schema, "failed")).resolves.toEqual(
      good,
    );
    await expect(readListBody(body(bad), schema, "failed")).rejects.toThrow(
      "failed",
    );
  });
});

it("a non-2xx answer takes the error path before parsing", async () => {
  const res = { ok: false, json: jest.fn() } as unknown as Response;
  await expect(readListBody(res, payoutTrendSchema, "nope")).rejects.toThrow(
    "nope",
  );
  expect(res.json).not.toHaveBeenCalled();
});

describe("list paging", () => {
  const params = (q: string) => new URLSearchParams(q);
  it.each([
    ["", { page: 1, limit: 20, skip: 0 }],
    ["page=0&limit=-5", { page: 1, limit: 20, skip: 0 }],
    ["page=2.5&limit=abc", { page: 1, limit: 20, skip: 0 }],
    ["page=3&limit=100", { page: 3, limit: 100, skip: 200 }],
    ["page=3&limit=101", { page: 3, limit: 100, skip: 200 }],
    ["page=99999", { page: 10_000, limit: 20, skip: 199_980 }],
  ])("?%s pages as %o", (q, expected) => {
    expect(readPageParams(params(q))).toEqual(expected);
  });

  it("clamps offset paging the same way", () => {
    expect(readOffsetParams(params("limit=500&offset=-1"))).toEqual({
      limit: 100,
      offset: 0,
    });
    expect(readOffsetParams(params("limit=0&offset=40"), 50)).toEqual({
      limit: 50,
      offset: 40,
    });
  });
});
