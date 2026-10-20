/**
 * @jest-environment node
 */

// ConsultationPlan ids are cuids, so the rate-card planId filter must accept one.

const mockFindMany = jest.fn(async (_args: unknown) => []);
jest.mock("../../lib/prisma", () => ({
  __esModule: true,
  default: { rateCard: { findMany: (args: unknown) => mockFindMany(args) } },
}));
jest.mock("../../lib/auth-helpers", () => ({
  requireOrgAccess: jest.fn(async () => ({ member: { id: "m1" } })),
}));

import { NextRequest } from "next/server";
import { GET } from "@/app/api/organizations/[orgId]/rate-cards/route";

it("accepts a cuid planId", async () => {
  const res = await GET(
    new NextRequest(
      "http://x/api/organizations/org1/rate-cards?planId=clx9f3k2a0000qz8h1b2c3d4e",
    ),
    { params: Promise.resolve({ orgId: "org1" }) },
  );
  expect(res.status).toBe(200);
  expect(mockFindMany).toHaveBeenCalledWith(
    expect.objectContaining({
      where: expect.objectContaining({
        ownerOrgId: "org1",
        planId: "clx9f3k2a0000qz8h1b2c3d4e",
      }),
    }),
  );
});
