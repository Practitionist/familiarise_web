/**
 * @jest-environment node
 */

/**
 * Metrics counts "today", "this week" (the calendar week from Sunday) and
 * "this month" from 00:00 IST, whatever zone the server runs in. Run under
 * TZ=UTC and TZ=America/Los_Angeles; the expectations do not change.
 */

jest.mock("@sentry/nextjs", () => ({ captureException: jest.fn() }));
jest.mock("../../lib/auth-helpers", () => ({
  requireBackofficeSurface: async () => ({
    session: { user: { id: "staff-1", role: "STAFF" } },
  }),
}));

type Call = { model: string; method: string; args: unknown };
const mockCalls: Call[] = [];
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
