/** @jest-environment node */
/** Query values that name an enum are parsed at the edge: an unknown one is a 400 with a code. */
const mockUserFindMany = jest.fn().mockResolvedValue([]);
const mockRead = jest.fn().mockResolvedValue({ rows: [] });
jest.mock("@/lib/prisma", () => ({
  __esModule: true,
  default: {
    user: {
      findMany: (...a: unknown[]) => mockUserFindMany(...a),
      count: jest.fn().mockResolvedValue(0),
    },
    consulteeProfile: {
      findUnique: jest.fn().mockResolvedValue({ userId: "u-1" }),
    },
    membership: { findMany: jest.fn().mockResolvedValue([]) },
  },
}));
jest.mock("@/lib/auth-server", () => ({
  getSession: jest
    .fn()
    .mockResolvedValue({ user: { id: "u-a", role: "ADMIN" } }),
}));
jest.mock("@/lib/auth-helpers", () => ({
  requireApiAuth: jest.fn().mockResolvedValue({
    session: {
      user: { id: "u-1", role: "CONSULTEE", consulteeProfileId: "ce-1" },
    },
  }),
  isPrivileged: () => false,
  forbiddenResponse: jest.fn(),
}));
jest.mock("@/lib/api/scope/parse", () => ({
  resolveOrgScope: () => ({ ok: true, scope: { kind: "personal" } }),
}));
jest.mock("@/lib/data/consultee-payments", () => ({
  ...jest.requireActual("@/lib/data/consultee-payments"),
  readConsulteePayments: (...a: unknown[]) => mockRead(...a),
}));
jest.mock("@sentry/nextjs", () => ({ captureException: jest.fn() }));

import { NextRequest } from "next/server";
import { GET as listUsers } from "@/app/api/user/route";
import { GET as consulteePayments } from "@/app/api/dashboard/consultee/[consulteeId]/payments/route";

const usersAt = (q: string) =>
  listUsers(new NextRequest(`http://localhost/api/user?${q}`));
const paymentsAt = (q: string) =>
  consulteePayments(
    new Request(`http://localhost/api/dashboard/consultee/ce-1/payments?${q}`),
    { params: Promise.resolve({ consulteeId: "ce-1" }) },
  );

beforeEach(() => jest.clearAllMocks());

describe("GET /api/user", () => {
  it.each(["role=bogus", "page=0", "limit=500"])(
    "refuses %s with 400",
    async (q) => {
      const res = await usersAt(q);
      expect(res.status).toBe(400);
      expect(await res.json()).toMatchObject({ code: "INVALID_QUERY" });
      expect(mockUserFindMany).not.toHaveBeenCalled();
    },
  );

  it("reads a real role", async () => {
    expect((await usersAt("role=CONSULTANT")).status).toBe(200);
    expect(mockUserFindMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { role: "CONSULTANT" } }),
    );
  });
});

describe("GET consultee payments", () => {
  it.each(["status=bogus", "range=forever"])(
    "refuses %s with 400",
    async (q) => {
      const res = await paymentsAt(q);
      expect(res.status).toBe(400);
      expect(await res.json()).toMatchObject({ code: "INVALID_QUERY" });
      expect(mockRead).not.toHaveBeenCalled();
    },
  );

  it("passes a real filter through", async () => {
    expect((await paymentsAt("status=paid&range=90d")).status).toBe(200);
    expect(mockRead).toHaveBeenCalledWith(
      expect.objectContaining({
        query: expect.objectContaining({ status: "paid", range: "90d" }),
      }),
    );
  });
});
