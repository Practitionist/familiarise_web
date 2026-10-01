/**
 * @jest-environment node
 */

/**
 * Operator onboarding and 2FA reset doors (D7/D8).
 *
 * - POST /api/admin/team/members creates the account through
 *   `auth.api.mockCreateUser` with no headers (a trusted server call), adds the
 *   profile, sends the set-password link and writes one OpsActionLog row.
 * - DELETE /api/admin/team/members/{id}/two-factor removes the second factor
 *   and every session, for operators only.
 */

jest.mock("@sentry/nextjs", () => ({ captureException: jest.fn() }));

const mockDb = {
  user: {
    findUnique: jest.fn(),
    update: jest.fn(),
    delete: jest.fn(),
  },
  staffProfile: { create: jest.fn() },
  adminProfile: { create: jest.fn() },
  twoFactor: { deleteMany: jest.fn() },
  session: { deleteMany: jest.fn() },
  opsActionLog: { create: jest.fn() },
  $transaction: jest.fn(),
};
jest.mock("../../lib/prisma", () => ({
  __esModule: true,
  get default() {
    return mockDb;
  },
}));

const mockCreateUser = jest.fn();
const mockRequestPasswordReset = jest.fn();
jest.mock("../../lib/auth", () => ({
  __esModule: true,
  auth: {
    api: {
      createUser: (...a: unknown[]) => mockCreateUser(...a),
      requestPasswordReset: (...a: unknown[]) => mockRequestPasswordReset(...a),
    },
  },
}));

const mockRequireBackofficeSurface = jest.fn();
jest.mock("../../lib/auth-helpers", () => ({
  __esModule: true,
  requireBackofficeSurface: (...a: unknown[]) =>
    mockRequireBackofficeSurface(...a),
}));
jest.mock("../../lib/rate-limit", () => ({
  __esModule: true,
  applyRateLimit: jest.fn(async () => null),
}));
jest.mock("../../lib/rate-limit/policies", () => ({
  __esModule: true,
  accountKey: jest.fn(async (id: string) => id),
  staffCreateLimiter: {},
}));
jest.mock("../../lib/observability/report", () => ({
  __esModule: true,
  reportSentryError: jest.fn(),
}));

import { NextRequest } from "next/server";
import { POST as createMember } from "../../app/api/admin/team/members/route";
import { DELETE as resetTwoFactor } from "../../app/api/admin/team/members/[userId]/two-factor/route";

const request = (method: string, body: unknown) =>
  new NextRequest("http://localhost/", {
    method,
    body: JSON.stringify(body),
  });

beforeEach(() => {
  jest.clearAllMocks();
  mockRequireBackofficeSurface.mockResolvedValue({
    session: { user: { id: "admin1", role: "ADMIN" } },
  });
  mockDb.$transaction.mockImplementation((fn: (tx: typeof mockDb) => unknown) =>
    fn(mockDb),
  );
  mockDb.opsActionLog.create.mockResolvedValue({ id: "log1" });
});

describe("POST /api/admin/team/members", () => {
  const body = {
    email: "New.Person@Example.com",
    name: "New Person",
    role: "STAFF",
    reason: "Joining support on Monday",
  };

  it("creates a STAFF operator and sends the set-password link", async () => {
    mockDb.user.findUnique.mockResolvedValue(null);
    mockCreateUser.mockResolvedValue({ user: { id: "u1" } });
    mockDb.staffProfile.create.mockResolvedValue({ id: "sp1" });

    const res = await createMember(request("POST", body), {
      params: Promise.resolve({}),
    });

    expect(res.status).toBe(201);
    expect(mockRequireBackofficeSurface).toHaveBeenCalledWith("users.moderate");
    const call = mockCreateUser.mock.calls[0][0];
    expect(call.headers).toBeUndefined();
    expect(call.body).toMatchObject({
      email: "new.person@example.com",
      role: "STAFF",
      data: { emailVerified: true, onboardingCompleted: true },
    });
    expect(call.body.password).toHaveLength(43);
    expect(mockDb.user.update).toHaveBeenCalledWith({
      where: { id: "u1" },
      data: {
        staffProfileId: "sp1",
        emailVerified: true,
        onboardingCompleted: true,
      },
    });
    expect(mockRequestPasswordReset).toHaveBeenCalledWith({
      body: {
        email: "new.person@example.com",
        redirectTo: "/auth/reset-password",
      },
    });
    expect(mockDb.opsActionLog.create).toHaveBeenCalledTimes(1);
    expect(mockDb.opsActionLog.create.mock.calls[0][0].data).toMatchObject({
      action: "team.member.create",
      targetId: "u1",
    });
  });

  it("answers 409 for an address that already has an account", async () => {
    mockDb.user.findUnique.mockResolvedValue({ id: "existing" });
    const res = await createMember(request("POST", body), {
      params: Promise.resolve({}),
    });
    expect(res.status).toBe(409);
    expect(mockCreateUser).not.toHaveBeenCalled();
  });

  it("refuses a non-operator role", async () => {
    const res = await createMember(
      request("POST", { ...body, role: "CONSULTANT" }),
      { params: Promise.resolve({}) },
    );
    expect(res.status).toBe(400);
    expect(mockCreateUser).not.toHaveBeenCalled();
  });
});

describe("DELETE /api/admin/team/members/[userId]/two-factor", () => {
  const params = { params: Promise.resolve({ userId: "op1" }) };

  it("removes the second factor and every session", async () => {
    mockDb.user.findUnique.mockResolvedValue({
      id: "op1",
      role: "STAFF",
      twoFactorEnabled: true,
    });
    mockDb.twoFactor.deleteMany.mockResolvedValue({ count: 1 });
    mockDb.session.deleteMany.mockResolvedValue({ count: 3 });

    const res = await resetTwoFactor(
      request("DELETE", { reason: "Lost phone, verified on a call" }),
      params,
    );

    expect(res.status).toBe(200);
    expect(mockDb.twoFactor.deleteMany).toHaveBeenCalledWith({
      where: { userId: "op1" },
    });
    expect(mockDb.user.update).toHaveBeenCalledWith({
      where: { id: "op1" },
      data: { twoFactorEnabled: false },
    });
    expect(mockDb.session.deleteMany).toHaveBeenCalledWith({
      where: { userId: "op1" },
    });
    await expect(res.json()).resolves.toMatchObject({ sessionsRevoked: 3 });
  });

  it("refuses to touch a customer account", async () => {
    mockDb.user.findUnique.mockResolvedValue({
      id: "op1",
      role: "CONSULTEE",
      twoFactorEnabled: true,
    });
    const res = await resetTwoFactor(
      request("DELETE", { reason: "Lost phone, verified on a call" }),
      params,
    );
    expect(res.status).toBe(400);
    expect(mockDb.twoFactor.deleteMany).not.toHaveBeenCalled();
  });

  it("requires a reason", async () => {
    const res = await resetTwoFactor(request("DELETE", {}), params);
    expect(res.status).toBe(400);
  });
});
