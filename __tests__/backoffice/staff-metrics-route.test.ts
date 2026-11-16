/**
 * @jest-environment node
 */

/**
 * The Metrics API. It counts "today", "this week" (the calendar week from
 * Sunday) and "this month" from 00:00 IST whatever zone the server runs in
 * (run under TZ=UTC and TZ=America/Los_Angeles); it counts open cases as the
 * support inbox does; and a failed totals read leaves the support figures up.
 */

jest.mock("@sentry/nextjs", () => ({ captureException: jest.fn() }));
const mockReport = jest.fn();
jest.mock("../../lib/observability/report", () => ({
  reportSentryError: (...args: unknown[]) => mockReport(...args),
}));
jest.mock("../../lib/auth-helpers", () => ({
  requireBackofficeSurface: async () => ({
    session: { user: { id: "staff-1", role: "STAFF" } },
  }),
}));

type Call = { model: string; method: string; args: unknown };
const mockCalls: Call[] = [];
const mockFail = { model: "" };
jest.mock("../../lib/prisma", () => ({
  __esModule: true,
  default: new Proxy(
    {},
    {
      get: (_target, model: string) =>
        new Proxy(
          {},
          {
            get: (_inner, method: string) => async (args?: unknown) => {
              mockCalls.push({ model, method, args });
              if (model === mockFail.model) throw new Error("read failed");
              if (method === "findMany") return [];
              if (method === "aggregate") return { _sum: {} };
              return 0;
            },
          },
        ),
    },
  ),
}));

import { GET } from "../../app/api/staff/metrics/route";
import { CASE_OPEN_WHERE } from "../../lib/support/inbox-query";

beforeEach(() => {
  mockFail.model = "";
  mockReport.mockClear();
});

const gte = (c: Call, field: string): string | undefined => {
  const where = (c.args as { where?: Record<string, { gte?: Date }> })?.where;
  return where?.[field]?.gte?.toISOString();
};
const status = (c: Call) =>
  (c.args as { where?: { status?: unknown } })?.where?.status;

async function cutsAt(now: string) {
  mockCalls.length = 0;
  jest.useFakeTimers({
    now: new Date(now),
    doNotFake: ["nextTick", "setImmediate"],
  });
  const res = await GET();
  jest.useRealTimers();
  expect(res.status).toBe(200);
  const body = await res.json();
  const support = mockCalls.filter((c) => c.model === "supportCase");
  return {
    resolved: support
      .filter((c) => c.method === "count" && status(c) === "RESOLVED")
      .map((c) => gte(c, "updatedAt")),
    weekReads: support
      .filter((c) => c.method === "findMany")
      .map((c) => gte(c, "updatedAt")),
    activeUsers: mockCalls
      .filter((c) => c.model === "payment" && c.method === "findMany")
      .map((c) => gte(c, "createdAt")),
    totalsMonth: body.platformTotals.monthStartsAt as string,
  };
}

it("cuts today, this week and this month at 00:00 IST mid-month", async () => {
  // Thu 16 Apr 2026, 01:30 IST: still the 15th in UTC and in Los Angeles.
  const day = "2026-04-15T18:30:00.000Z";
  const week = "2026-04-11T18:30:00.000Z"; // Sun 12 Apr, 00:00 IST
  const month = "2026-03-31T18:30:00.000Z"; // 1 Apr, 00:00 IST
  expect(await cutsAt("2026-04-15T20:00:00.000Z")).toEqual({
    resolved: [day, week, month],
    weekReads: [week, week],
    activeUsers: [month],
    totalsMonth: month,
  });
});

it("opens a new IST month while UTC is still in the old one", async () => {
  // Wed 1 Apr 2026, 01:30 IST: still 31 Mar in UTC.
  const start = "2026-03-31T18:30:00.000Z";
  const week = "2026-03-28T18:30:00.000Z"; // Sun 29 Mar, 00:00 IST
  expect(await cutsAt("2026-03-31T20:00:00.000Z")).toEqual({
    resolved: [start, week, start],
    weekReads: [week, week],
    activeUsers: [start],
    totalsMonth: start,
  });
});

it("counts open cases with the support inbox's definition", async () => {
  mockCalls.length = 0;
  expect((await GET()).status).toBe(200);
  const counts = mockCalls.filter(
    (c) => c.model === "supportCase" && c.method === "count",
  );
  expect(counts.map((c) => c.args)).toContainEqual({ where: CASE_OPEN_WHERE });
  expect(
    counts.filter(
      (c) =>
        JSON.stringify(c.args).includes("IN_PROGRESS") ||
        JSON.stringify(c.args).includes('"OPEN"'),
    ),
  ).toEqual([]);
});

it("answers the support figures with platformTotals null when the totals fail", async () => {
  // Refunds are read only by the totals.
  mockFail.model = "refund";
  const res = await GET();
  expect(res.status).toBe(200);
  const body = await res.json();
  expect(body.platformTotals).toBeNull();
  expect(body.supportMetrics).toMatchObject({ openTickets: 0 });
  expect(mockReport).toHaveBeenCalledTimes(1);
  expect(mockReport).toHaveBeenCalledWith(expect.any(Error), {
    subsystem: "staff",
    op: "metrics.platform-totals",
  });
});

it("still fails whole when a support read fails", async () => {
  mockFail.model = "supportCase";
  expect((await GET()).status).toBe(500);
});
