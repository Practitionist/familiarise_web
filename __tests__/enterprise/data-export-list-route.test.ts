/** @jest-environment node */

const mockFindMany = jest.fn();
const mockRequireOrgAccess = jest.fn();

jest.mock("../../lib/prisma", () => ({
  __esModule: true,
  default: {
    orgDataExportJob: {
      findMany: (...args: unknown[]) => mockFindMany(...args),
    },
  },
}));

jest.mock("../../lib/auth-helpers", () => ({
  requireOrgAccess: (...args: unknown[]) => mockRequireOrgAccess(...args),
}));

jest.mock("../../lib/rate-limit", () => ({
  applyRateLimit: jest.fn(),
  orgDataExportLimiter: {},
}));

import { GET } from "../../app/api/organizations/[orgId]/data-exports/route";

beforeEach(() => {
  jest.clearAllMocks();
  mockRequireOrgAccess.mockResolvedValue({ member: { role: "OWNER" } });
  mockFindMany.mockResolvedValue([
    {
      id: "export-failed",
      kind: "PEOPLE",
      status: "FAILED",
      requestedByMembershipId: "membership-1",
      fileSizeBytes: null,
      expiresAt: null,
      error: "PrismaClientKnownRequestError: secret table and stack details",
      createdAt: new Date("2026-10-26T00:00:00.000Z"),
      startedAt: null,
      completedAt: new Date("2026-10-26T00:00:00.000Z"),
    },
  ]);
});

it("replaces legacy raw failure details with the safe export message", async () => {
  const response = await GET({} as never, {
    params: Promise.resolve({ orgId: "org-1" }),
  });

  const body = await response.json();
  expect(body.data[0].error).toBe(
    "The data export could not be generated. Please retry or contact support.",
  );
  expect(JSON.stringify(body)).not.toContain("PrismaClientKnownRequestError");
  expect(mockFindMany.mock.calls[0][0].select.error).toBeUndefined();
});
