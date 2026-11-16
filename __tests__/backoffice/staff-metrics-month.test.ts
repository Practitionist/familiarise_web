/**
 * @jest-environment node
 */

/**
 * Metrics has one month boundary: its support and payment "this month" reads
 * and the platform totals all count from 00:00 IST on the first.
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

// 01:30 IST on 1 Apr 2026, still 31 Mar in UTC and in a UTC server's local month.
const NOW = new Date("2026-03-31T20:00:00.000Z");
const IST_MONTH_START = "2026-03-31T18:30:00.000Z";

beforeEach(() => {
  mockCalls.length = 0;
  jest.useFakeTimers({ now: NOW, doNotFake: ["nextTick", "setImmediate"] });
});
afterEach(() => jest.useRealTimers());

const gte = (c: Call, field: string): string | undefined => {
  const where = (c.args as { where?: Record<string, { gte?: Date }> })?.where;
  return where?.[field]?.gte?.toISOString();
};

it("cuts every month-scoped read at 00:00 IST", async () => {
  const res = await GET();
  expect(res.status).toBe(200);
  const body = await res.json();

  const resolvedCuts = mockCalls
    .filter((c) => c.model === "supportCase" && c.method === "count")
    .map((c) => gte(c, "updatedAt"));
  expect(resolvedCuts).toContain(IST_MONTH_START);

  const activeUsers = mockCalls.filter(
    (c) => c.model === "payment" && c.method === "findMany",
  );
  expect(activeUsers.map((c) => gte(c, "createdAt"))).toEqual([
    IST_MONTH_START,
  ]);

  // No read on the page counts from the server-local month start.
  const monthCuts = mockCalls
    .flatMap((c) => [gte(c, "createdAt"), gte(c, "updatedAt")])
    .filter((iso): iso is string => !!iso && iso.endsWith("-01T00:00:00.000Z"));
  expect(monthCuts).toEqual([]);
  expect(body.platformTotals.monthStartsAt).toBe(IST_MONTH_START);
});
