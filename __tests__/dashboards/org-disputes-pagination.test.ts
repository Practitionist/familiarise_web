/** @jest-environment node */
jest.mock("../../lib/auth-helpers", () => ({ requireOrgAccess: jest.fn() }));
jest.mock("../../lib/prisma", () => ({
  __esModule: true,
  default: {
    dispute: { findMany: jest.fn(), count: jest.fn(), groupBy: jest.fn() },
  },
}));

import { NextRequest, NextResponse } from "next/server";
import prisma from "../../lib/prisma";
import { requireOrgAccess } from "../../lib/auth-helpers";
import { GET } from "../../app/api/organizations/[orgId]/disputes/route";

const findMany = jest.mocked(prisma.dispute.findMany);
const count = jest.mocked(prisma.dispute.count);
const groupBy = jest.mocked(prisma.dispute.groupBy);
const access = jest.mocked(requireOrgAccess);
const params = { params: Promise.resolve({ orgId: "org-1" }) };
const get = (query = "") =>
  GET(
    new NextRequest(`https://test/api/organizations/org-1/disputes${query}`),
    params,
  );

beforeEach(() => {
  jest.clearAllMocks();
  (access as jest.Mock).mockResolvedValue({});
  (findMany as jest.Mock).mockResolvedValue([]);
  (count as jest.Mock).mockResolvedValue(0);
  (groupBy as jest.Mock).mockResolvedValue([]);
});

it("paginates the list and computes totals over all buyer and host disputes", async () => {
  (count as jest.Mock)
    .mockResolvedValueOnce(60)
    .mockResolvedValueOnce(80)
    .mockResolvedValueOnce(50);
  (groupBy as jest.Mock).mockResolvedValue([
    { currency: "INR", _sum: { amountPaise: 90000 } },
  ]);
  const response = await get("?limit=10&offset=25&status=LOST");
  const body = await response.json();
  expect(findMany).toHaveBeenCalledWith(
    expect.objectContaining({
      skip: 25,
      take: 10,
      where: expect.objectContaining({ status: "LOST" }),
    }),
  );
  expect(count.mock.calls[1][0]).toEqual({
    where: {
      payment: {
        OR: [
          { organizationId: "org-1" },
          { hostOrganizationId: "org-1" },
          { organizationEarnings: { some: { organizationId: "org-1" } } },
        ],
      },
    },
  });
  expect(body.stats).toEqual({
    totalCount: 80,
    openCount: 50,
    lostAmounts: [{ currency: "INR", amountPaise: 90000 }],
  });
  expect(body.pagination).toEqual({
    total: 60,
    limit: 10,
    offset: 25,
    hasMore: true,
  });
});

it("redacts buyer payment and reason for the host and never returns billing account or organization identifiers", async () => {
  (findMany as jest.Mock).mockResolvedValue([
    {
      id: "host",
      reason: "private buyer reason",
      payment: {
        id: "private-payment",
        organizationId: "buyer-org",
        hostOrganizationId: "org-1",
        organizationEarnings: [],
      },
    },
    {
      id: "buyer",
      reason: "buyer reason",
      payment: {
        id: "own-payment",
        organizationId: "org-1",
        hostOrganizationId: "host-org",
        organizationEarnings: [],
      },
    },
  ]);
  const body = await (await get()).json();
  expect(body.data).toEqual([
    { id: "host", reason: null, payment: null, relationship: "HOST" },
    {
      id: "buyer",
      reason: "buyer reason",
      payment: { id: "own-payment" },
      relationship: "BUYER",
    },
  ]);
  expect(JSON.stringify(body)).not.toContain("billingAccountId");
  expect(JSON.stringify(body)).not.toContain("buyer-org");
});

it("rejects invalid page bounds before database reads", async () => {
  expect((await get("?offset=-1")).status).toBe(400);
  expect(findMany).not.toHaveBeenCalled();
});

it("preserves the finance read permission boundary", async () => {
  (access as jest.Mock).mockResolvedValue({
    error: NextResponse.json({ error: "Forbidden" }, { status: 403 }),
  });
  expect((await get()).status).toBe(403);
  expect(findMany).not.toHaveBeenCalled();
});
