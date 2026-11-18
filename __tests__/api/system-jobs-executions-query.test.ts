/** @jest-environment node */
/**
 * The executions list parses its query at the edge: an unknown status is a
 * 400 with a code (never a Prisma validation 500), and page and limit are bounded.
 */
const mockFindMany = jest.fn();
const mockCount = jest.fn();
jest.mock("@/lib/prisma", () => ({
  __esModule: true,
  default: {
    systemJobExecution: {
      findMany: (...a: unknown[]) => mockFindMany(...a),
      count: (...a: unknown[]) => mockCount(...a),
    },
    user: { findMany: jest.fn().mockResolvedValue([]) },
  },
}));
jest.mock("@/lib/auth-helpers", () => ({
  requireBackofficeSurface: jest.fn().mockResolvedValue({ session: {} }),
}));
const mockCapture = jest.fn();
jest.mock("@sentry/nextjs", () => ({
  captureException: (...a: unknown[]) => mockCapture(...a),
}));

import { NextRequest } from "next/server";
import { GET } from "@/app/api/staff/system-jobs/executions/route";

const get = (query: string) =>
  GET(
    new NextRequest(
      `http://localhost/api/staff/system-jobs/executions?${query}`,
    ),
  );

beforeEach(() => {
  jest.clearAllMocks();
  mockFindMany.mockResolvedValue([]);
  mockCount.mockResolvedValue(0);
});

it("answers an unknown status 400 with a code, without reading or capturing", async () => {
  const res = await get("status=bogus");
  expect(res.status).toBe(400);
  expect(await res.json()).toMatchObject({ code: "INVALID_QUERY" });
  expect(mockFindMany).not.toHaveBeenCalled();
  expect(mockCapture).not.toHaveBeenCalled();
});

it.each(["page=0", "page=-3", "limit=0", "limit=101", "page=abc"])(
  "refuses %s",
  async (query) => {
    const res = await get(query);
    expect(res.status).toBe(400);
    expect(mockFindMany).not.toHaveBeenCalled();
  },
);

it("reads a valid page with a real status", async () => {
  const res = await get("status=COMPLETED&page=2&limit=50");
  expect(res.status).toBe(200);
  expect(mockFindMany).toHaveBeenCalledWith(
    expect.objectContaining({
      where: expect.objectContaining({ status: "COMPLETED" }),
      take: 50,
      skip: 50,
    }),
  );
});
