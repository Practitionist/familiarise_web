/**
 * @jest-environment node
 */

/**
 * The Metrics totals run the same reads the Analytics page ran: the same
 * models, `where`s and aggregates. The one change is "this month", which
 * starts at 00:00 IST on the first.
 */

type Call = { model: string; method: string; args: unknown };
const mockCalls: Call[] = [];
const mockAnswers = new Map<string, unknown>();
const key = (model: string, method: string, args: unknown) =>
  `${model}.${method} ${JSON.stringify(args ?? null)}`;

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
              return mockAnswers.get(key(model, method, args));
            },
          },
        ),
    },
  ),
}));

import { getPlatformTotals } from "../../lib/backoffice/platform-totals";

// 01:30 IST on 1 Apr 2026: still 31 Mar in UTC.
const now = new Date("2026-03-31T20:00:00.000Z");
const monthStart = "2026-03-31T18:30:00.000Z";

// The deleted route's reads, with its server-local month start replaced by the IST one.
const expected: Array<[string, string, unknown, unknown]> = [
  ["user", "count", undefined, 120],
  ["user", "count", { where: { createdAt: { gte: monthStart } } }, 7],
  ["user", "count", { where: { role: "CONSULTANT" } }, 30],
  [
    "user",
    "count",
    { where: { role: "CONSULTANT", onboardingCompleted: true } },
    21,
  ],
  ["user", "count", { where: { role: "CONSULTEE" } }, 80],
  [
    "user",
    "count",
    { where: { role: "CONSULTEE", onboardingCompleted: true } },
    64,
  ],
  ["user", "count", { where: { role: "STAFF" } }, 4],
  ["appointment", "count", undefined, 500],
  [
    "appointment",
    "count",
    { where: { occurrences: { some: { endsAt: { lt: now.toISOString() } } } } },
    410,
  ],
  [
    "appointment",
    "count",
    {
      where: { occurrences: { some: { startsAt: { gt: now.toISOString() } } } },
    },
    60,
  ],
  ["consultation", "count", { where: { status: "CANCELLED" } }, 9],
  [
    "payment",
    "aggregate",
    { _sum: { amount: true }, where: { paymentStatus: "SUCCEEDED" } },
    { _sum: { amount: BigInt(12_345_600) } },
  ],
  [
    "payment",
    "aggregate",
    {
      _sum: { amount: true },
      where: { paymentStatus: "SUCCEEDED", createdAt: { gte: monthStart } },
    },
    { _sum: { amount: 99_900 } },
  ],
  [
    "refund",
    "aggregate",
    { _sum: { amountPaise: true }, where: { status: "SUCCEEDED" } },
    { _sum: { amountPaise: null } },
  ],
];

beforeEach(() => {
  mockCalls.length = 0;
  mockAnswers.clear();
  // Dates reach the mock as Date objects; key them as their ISO strings.
  for (const [model, method, args, answer] of expected) {
    mockAnswers.set(key(model, method, args), answer);
  }
});

it("runs exactly the Analytics reads, with the month cut at 00:00 IST", async () => {
  await getPlatformTotals(now);
  const seen = mockCalls.map((c) => key(c.model, c.method, c.args)).sort();
  const want = expected
    .map(([model, method, args]) => key(model, method, args))
    .sort();
  expect(seen).toEqual(want);
});

it("maps each read to its card, money in paise", async () => {
  expect(await getPlatformTotals(now)).toEqual({
    monthStartsAt: monthStart,
    users: { total: 120, newThisMonth: 7 },
    experts: { total: 30, active: 21 },
    learners: { total: 80, active: 64 },
    staff: { total: 4 },
    sessions: { total: 500, completed: 410, upcoming: 60, cancelled: 9 },
    revenue: { totalPaise: 12_345_600, thisMonthPaise: 99_900 },
    refunds: { totalPaise: 0 },
  });
});
