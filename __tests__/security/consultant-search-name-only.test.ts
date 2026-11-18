/**
 * @jest-environment node
 */

/**
 * GET /api/consultants/search answers a masked address, so the search itself
 * must never match on the address: a hit would confirm what the mask hides.
 */

const mockSearchFindMany = jest.fn();
jest.mock("@sentry/nextjs", () => ({ captureException: jest.fn() }));
jest.mock("../../lib/prisma", () => ({
  __esModule: true,
  default: {
    consultantProfile: {
      findMany: (...a: unknown[]) => mockSearchFindMany(...a),
    },
  },
}));
jest.mock("../../lib/auth-server", () => ({
  __esModule: true,
  getSession: jest.fn(async () => ({
    user: { id: "host-user", consultantProfileId: "host-profile" },
  })),
}));
jest.mock("../../lib/rate-limit", () => ({
  __esModule: true,
  applyRateLimit: jest.fn(async () => null),
  getClientIp: () => "203.0.113.7",
  searchLimiter: {},
}));

import { GET } from "../../app/api/consultants/search/route";

describe("consultant search", () => {
  it("matches on the name alone and still masks the address it shows", async () => {
    mockSearchFindMany.mockResolvedValue([
      {
        id: "cp-1",
        user: {
          name: "Priya Sharma",
          email: "priya.sharma@example.com",
          image: null,
        },
      },
    ]);
    const res = await GET(
      new Request("http://x/api/consultants/search?q=priya.sharma@") as never,
    );
    const { where } = mockSearchFindMany.mock.calls[0][0];
    expect(where.user).toEqual({
      name: { contains: "priya.sharma@", mode: "insensitive" },
    });
    expect(where.user).not.toHaveProperty("email");
    expect(where.user).not.toHaveProperty("OR");
    const body = (await res.json()) as { data: { user: { email: string } }[] };
    expect(body.data[0].user.email).toBe("p***@example.com");
  });
});
