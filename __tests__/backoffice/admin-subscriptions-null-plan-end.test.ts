/**
 * @jest-environment node
 */

/**
 * The admin subscriptions filters and stat counts bucket a row with no stored
 * plan end by its derived end, the same end the list renders for it.
 */

jest.mock("../../lib/auth-helpers", () => ({
  requireBackofficeSurface: jest.fn(async () => ({ error: null })),
}));
jest.mock("../../lib/backoffice/ops-action-log", () => ({
  withOpsAction: () => jest.fn(),
}));
jest.mock("../../lib/prisma", () => ({
  __esModule: true,
  default: {
    subscription: { findMany: jest.fn() },
    payment: { findMany: jest.fn(), count: jest.fn() },
  },
}));

import { NextRequest } from "next/server";
import prisma from "@/lib/prisma";
import { GET } from "@/app/api/admin/subscriptions/route";

const NOW = new Date("2026-10-29T12:00:00.000Z");
const DAY = 24 * 3_600_000;
const m = prisma as unknown as {
  subscription: { findMany: jest.Mock };
  payment: { findMany: jest.Mock; count: jest.Mock };
};

/** A pre-reset row: a one-month plan that started `daysAgo` days back. */
const legacy = (id: string, daysAgo: number) => ({
  id,
  planEndsAt: null,
  schedulingPeriodStartsAt: new Date(NOW.getTime() - daysAgo * DAY),
  schedulingTimezone: "UTC",
  subscriptionPlan: { durationInMonths: 1 },
});

beforeEach(() => {
  jest.useFakeTimers({ now: NOW });
  jest.clearAllMocks();
  m.subscription.findMany.mockResolvedValue([
    legacy("sub-ended", 40),
    legacy("sub-soon", 28),
    legacy("sub-fresh", 3),
  ]);
  m.payment.findMany.mockResolvedValue([]);
  m.payment.count.mockResolvedValue(0);
});

afterEach(() => jest.useRealTimers());

const call = (status: string) =>
  GET(
    new NextRequest(
      `http://localhost/api/admin/subscriptions?status=${status}`,
    ),
  );

const nullArmIds = (where: {
  appointment: { subscription: { OR: { id?: { in: string[] } }[] } };
}) => where.appointment.subscription.OR.find((arm) => arm.id)?.id?.in;

describe("GET /api/admin/subscriptions — rows without a stored plan end", () => {
  it.each([
    ["expired", ["sub-ended"]],
    ["expiring_soon", ["sub-soon"]],
    ["active", ["sub-fresh"]],
  ])(
    "the %s filter includes them by their derived end",
    async (status, ids) => {
      expect((await call(status)).status).toBe(200);
      const where = m.payment.findMany.mock.calls[0][0].where;
      expect(where.appointment.subscription.status).toEqual({
        not: "CANCELLED",
      });
      expect(nullArmIds(where)).toEqual(ids);
    },
  );

  it("counts them in the stat tiles, one bucket each", async () => {
    // The cancelled list's own total carries no plan-end arm.
    await call("cancelled");
    const counted = m.payment.count.mock.calls
      .map(([args]) => args.where)
      .filter((where) => where.appointment?.subscription?.OR)
      .map(nullArmIds);
    expect(counted).toEqual([["sub-fresh"], ["sub-soon"], ["sub-ended"]]);
  });

  it("reads only uncancelled rows without a stored end", async () => {
    await call("expired");
    expect(m.subscription.findMany.mock.calls[0][0].where).toEqual({
      planEndsAt: null,
      status: { not: "CANCELLED" },
    });
  });

  it("reads them in bounded keyset pages and stops at the cap", async () => {
    const page = (from: number) =>
      Array.from({ length: 500 }, (_, i) =>
        legacy(`sub-${String(from + i).padStart(5, "0")}`, 3),
      );
    m.subscription.findMany.mockImplementation(
      async (args: { where: { id?: { gt: string } } }) => {
        const after = args.where.id?.gt;
        return page(after ? Number(after.slice(4)) + 1 : 0);
      },
    );

    expect((await call("active")).status).toBe(200);

    const reads = m.subscription.findMany.mock.calls.map(([args]) => args);
    expect(reads).toHaveLength(10);
    expect(reads.every((r) => r.take === 500)).toBe(true);
    expect(reads[0].where.id).toBeUndefined();
    expect(reads[1].where.id).toEqual({ gt: "sub-00499" });
    expect(reads[1].orderBy).toEqual({ id: "asc" });
  });
});
