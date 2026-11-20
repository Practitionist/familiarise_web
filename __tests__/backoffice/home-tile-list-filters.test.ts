/**
 * @jest-environment node
 */

/** Each Home money tile opens a list filtered to exactly the set the tile counts. */

import { NextRequest } from "next/server";
import type { ReactElement } from "react";

import { GET as getDisputes } from "../../app/api/admin/disputes/route";
import { GET as getPayments } from "../../app/api/admin/payments/route";
import { GET as getRefunds } from "../../app/api/admin/refunds/route";
import { MoneyTabBody } from "../../components/dashboard/backoffice/money/MoneyTabBody";
import type { BackofficeCapability } from "../../lib/backoffice/capability";
import { HOME_TILE_LIST_QUERY } from "../../lib/backoffice/money-list-schemas";
import { OPEN_DISPUTE_WHERE } from "../../lib/backoffice/queue-predicates";

const mockPrisma = {
  payment: { findMany: jest.fn(), count: jest.fn() },
  refund: { findMany: jest.fn(), count: jest.fn() },
  dispute: { findMany: jest.fn(), count: jest.fn() },
};

jest.mock("../../lib/auth-helpers", () => ({
  requireBackofficeSurface: async () => ({
    session: { user: { id: "op-1", role: "ADMIN" } },
  }),
}));
jest.mock("../../lib/prisma", () => ({
  __esModule: true,
  get default() {
    return mockPrisma;
  },
}));

const CAP = {
  tree: "admin",
  basePath: "/dashboard/admin",
  role: "ADMIN",
  audience: "ADMIN",
} as unknown as BackofficeCapability;

/** The `initialStatus` MoneyTabBody hands the list for a tile's query string. */
async function initialStatusFor(tab: keyof typeof HOME_TILE_LIST_QUERY) {
  const query = new URLSearchParams(HOME_TILE_LIST_QUERY[tab]);
  const el = (await MoneyTabBody({
    tabKey: tab,
    cap: CAP,
    viewer: { userId: "op-1", role: "ADMIN" },
    searchParams: Object.fromEntries(query),
  })) as ReactElement<{ initialStatus?: string }>;
  return el.props.initialStatus;
}

const listUrl = (path: string, status: string | undefined) =>
  new NextRequest(`http://localhost${path}?status=${status}&page=1&limit=20`);

beforeEach(() => {
  jest.clearAllMocks();
  for (const model of Object.values(mockPrisma)) {
    model.findMany.mockResolvedValue([]);
    model.count.mockResolvedValue(0);
  }
});

it("opens Payments on SUCCEEDED, the set the tile counts", async () => {
  const status = await initialStatusFor("payments");
  expect(status).toBe("SUCCEEDED");
  const res = await getPayments(listUrl("/api/admin/payments", status));
  expect(res.status).toBe(200);
  expect(mockPrisma.payment.count).toHaveBeenCalledWith({
    where: { paymentStatus: "SUCCEEDED" },
  });
});

it("opens Refunds on SUCCEEDED, the set the tile counts", async () => {
  const status = await initialStatusFor("refunds");
  expect(status).toBe("SUCCEEDED");
  const res = await getRefunds(listUrl("/api/admin/refunds", status));
  expect(res.status).toBe(200);
  expect(mockPrisma.refund.count).toHaveBeenNthCalledWith(1, {
    where: { status: "SUCCEEDED" },
  });
});

it("opens Disputes on the open set the Active disputes tile counts", async () => {
  const status = await initialStatusFor("disputes");
  expect(status).toBe("OPEN");
  const res = await getDisputes(listUrl("/api/admin/disputes", status));
  expect(res.status).toBe(200);
  // The list total uses the same predicate as the tile's count.
  expect(mockPrisma.dispute.count).toHaveBeenNthCalledWith(1, {
    where: OPEN_DISPUTE_WHERE,
  });
  // The open/closed page split keeps the open set instead of overwriting it.
  for (const [args] of mockPrisma.dispute.count.mock.calls.slice(4))
    expect(args.where.AND[0]).toEqual(OPEN_DISPUTE_WHERE);
});

it("ignores a status the list does not know", async () => {
  const el = (await MoneyTabBody({
    tabKey: "disputes",
    cap: CAP,
    viewer: { userId: "op-1", role: "ADMIN" },
    searchParams: { status: "NOT_A_STATUS" },
  })) as ReactElement<{ initialStatus?: string }>;
  expect(el.props.initialStatus).toBeUndefined();
});
