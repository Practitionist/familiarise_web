/**
 * @jest-environment node
 */

/**
 * Staff/admin session doors (#1856, ADR 35).
 *
 * - GET (users.read, OPERATORS): visibility into a user's devices.
 * - POST (users.moderate, ADMIN_ONLY): revoke one or all sessions with
 *   a reason and an OpsActionLog row. Staff see, admin acts; staff act
 *   through the moderation ban path, which shares the same helper.
 */

jest.mock("@sentry/nextjs", () => ({
  captureException: jest.fn(),
  logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn() },
}));

const sessionFindMany = jest.fn();
const sessionDeleteMany = jest.fn();
const opsActionLogCreate = jest.fn();
jest.mock("../../lib/prisma", () => ({
  __esModule: true,
  default: {
    session: {
      findMany: (...a: unknown[]) => sessionFindMany(...a),
      deleteMany: (...a: unknown[]) => sessionDeleteMany(...a),
    },
    opsActionLog: {
      create: (...a: unknown[]) => opsActionLogCreate(...a),
    },
  },
}));

const mockRequireBackofficeSurface = jest.fn();
jest.mock("../../lib/auth-helpers", () => ({
  __esModule: true,
  requireBackofficeSurface: (...a: unknown[]) =>
    mockRequireBackofficeSurface(...a),
}));

jest.mock("../../lib/observability/report", () => ({
  __esModule: true,
  reportSentryError: jest.fn(),
}));

import { NextRequest } from "next/server";
import { GET as listUserSessions } from "../../app/api/admin/users/[userId]/sessions/route";
import { POST as revokeUserSessions } from "../../app/api/admin/users/[userId]/sessions/revoke/route";

const paramsFor = (userId: string) => ({
  params: Promise.resolve({ userId }),
});

const authedAdmin = () =>
  mockRequireBackofficeSurface.mockResolvedValue({
    session: { user: { id: "admin1", role: "ADMIN" } },
  });

const post = (userId: string, body: unknown) =>
  revokeUserSessions(
    new NextRequest("http://localhost/", {
      method: "POST",
      body: JSON.stringify(body),
    }),
    paramsFor(userId),
  );

beforeEach(() => {
  jest.clearAllMocks();
});

describe("GET /api/admin/users/[userId]/sessions (#1856)", () => {
  it("lists through the allowlist under users.read", async () => {
    authedAdmin();
    sessionFindMany.mockResolvedValue([]);

    const res = await listUserSessions({} as Request, paramsFor("u9"));

    expect(res.status).toBe(200);
    expect(mockRequireBackofficeSurface).toHaveBeenCalledWith("users.read");
    expect(sessionFindMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { userId: "u9", expiresAt: { gt: expect.any(Date) } },
      }),
    );
    const select = sessionFindMany.mock.calls[0][0].select;
    expect(select).not.toHaveProperty("token");
    await expect(res.json()).resolves.toEqual({ sessions: [] });
  });

  it("passes the surface refusal through", async () => {
    const err = Response.json({ error: "Forbidden" }, { status: 403 });
    mockRequireBackofficeSurface.mockResolvedValue({ error: err });

    expect(await listUserSessions({} as Request, paramsFor("u9"))).toBe(err);
  });
});

describe("POST /api/admin/users/[userId]/sessions/revoke (#1856)", () => {
  it("revokes one session with a reason and writes the audit row", async () => {
    authedAdmin();
    sessionDeleteMany.mockResolvedValue({ count: 1 });
    opsActionLogCreate.mockImplementation(
      async ({ data }: { data: object }) => ({
        ...data,
      }),
    );

    const res = await post("u9", {
      reason: "compromised account, ticket 123",
      sessionId: "s1",
    });

    expect(res.status).toBe(200);
    expect(sessionDeleteMany).toHaveBeenCalledWith({
      where: { id: "s1", userId: "u9" },
    });
    expect(opsActionLogCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          actorUserId: "admin1",
          surface: "users.moderate",
          action: "user.revoke-sessions",
          targetKind: "User",
          targetId: "u9",
          reason: "compromised account, ticket 123",
        }),
      }),
    );
    const body = await res.json();
    expect(body.revoked).toBe(1);
    expect(body.opsActionId).toEqual(expect.any(String));
  });

  it("revokes all sessions when no sessionId is given", async () => {
    authedAdmin();
    sessionDeleteMany.mockResolvedValue({ count: 4 });
    opsActionLogCreate.mockImplementation(
      async ({ data }: { data: object }) => ({
        ...data,
      }),
    );

    const res = await post("u9", { reason: "account takeover containment" });

    expect(sessionDeleteMany).toHaveBeenCalledWith({
      where: { userId: "u9" },
    });
    await expect(res.json()).resolves.toMatchObject({ revoked: 4 });
  });

  it("rejects a missing reason", async () => {
    authedAdmin();

    const res = await post("u9", {});

    expect(res.status).toBe(400);
    expect(sessionDeleteMany).not.toHaveBeenCalled();
  });
});
