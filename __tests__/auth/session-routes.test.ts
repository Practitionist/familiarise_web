/**
 * @jest-environment node
 */

/**
 * User session/device routes (#1856).
 *
 * - GET lists through the allowlist (never the token).
 * - DELETE is idempotent: foreign/gone ids answer 200 `{ revoked: 0 }`,
 *   never 404 (which would leak row existence across users).
 * - The cross-device signal fires only when a row was actually removed
 *   — and never for the current session (the revoking tab signs
 *   itself out off the `currentSessionEnded` flag).
 */

jest.mock("@sentry/nextjs", () => ({
  captureException: jest.fn(),
}));

const sessionFindMany = jest.fn();
const sessionDeleteMany = jest.fn();
jest.mock("../../lib/prisma", () => ({
  __esModule: true,
  default: {
    session: {
      findMany: (...a: unknown[]) => sessionFindMany(...a),
      // Closure defers the reference past factory evaluation (TDZ).
      deleteMany: (...a: unknown[]) => sessionDeleteMany(...a),
    },
  },
}));

const mockRequireApiAuth = jest.fn();
jest.mock("../../lib/auth-helpers", () => ({
  __esModule: true,
  requireApiAuth: (...a: unknown[]) => mockRequireApiAuth(...a),
}));

const mockSignalRevocation = jest.fn();
jest.mock("../../lib/auth/session-revoke", () => ({
  __esModule: true,
  revokeSessionById: jest.fn(
    async (_db: unknown, userId: string, sessionId: string) => {
      const { count } = await sessionDeleteMany({
        where: { id: sessionId, userId },
      });
      return { revoked: count };
    },
  ),
  revokeUserSessionsExcept: jest.fn(
    async (_db: unknown, userId: string, keep: string) => {
      const { count } = await sessionDeleteMany({
        where: { userId, id: { not: keep } },
      });
      return { revoked: count };
    },
  ),
  signalRevocation: (...a: unknown[]) => mockSignalRevocation(...a),
}));

import { GET as listSessions } from "../../app/api/user/sessions/route";
import { DELETE as revokeSession } from "../../app/api/user/sessions/[sessionId]/route";
import { POST as revokeOthers } from "../../app/api/user/sessions/revoke-others/route";

const authedAs = (userId: string, sessionId: string) =>
  mockRequireApiAuth.mockResolvedValue({
    session: { user: { id: userId }, session: { id: sessionId } },
  });

beforeEach(() => {
  jest.clearAllMocks();
});

describe("GET /api/user/sessions (#1856)", () => {
  it("returns mapped sessions with the current marker, newest first", async () => {
    authedAs("u1", "s-current");
    sessionFindMany.mockResolvedValue([
      {
        id: "s-current",
        createdAt: new Date("2026-01-02T00:00:00Z"),
        updatedAt: new Date("2026-01-03T00:00:00Z"),
        expiresAt: new Date("2026-02-01T00:00:00Z"),
        ipAddress: "1.2.3.4",
        userAgent: "Mozilla/5.0 (Windows NT 10.0) Chrome/126.0",
        deviceLabel: null,
        lastSeenAt: null,
        impersonatedBy: null,
      },
    ]);

    const res = await listSessions();
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.sessions).toHaveLength(1);
    expect(body.sessions[0]).toMatchObject({
      id: "s-current",
      isCurrent: true,
      label: "Chrome on Windows",
    });
    expect(body.sessions[0]).not.toHaveProperty("token");
    expect(body.sessions[0]).not.toHaveProperty("userAgent");
    // Only unexpired rows, bounded.
    expect(sessionFindMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { userId: "u1", expiresAt: { gt: expect.any(Date) } },
        take: 25,
      }),
    );
    // The select is the allowlist — assert no token at the query level.
    const select = sessionFindMany.mock.calls[0][0].select;
    expect(select).not.toHaveProperty("token");
  });

  it("passes auth errors through", async () => {
    const err = Response.json({ error: "Unauthorized" }, { status: 401 });
    mockRequireApiAuth.mockResolvedValue({ error: err });

    expect(await listSessions()).toBe(err);
    expect(sessionFindMany).not.toHaveBeenCalled();
  });
});

describe("DELETE /api/user/sessions/[sessionId] (#1856)", () => {
  const req = (id: string) =>
    revokeSession({} as Request, {
      params: Promise.resolve({ sessionId: id }),
    });

  it("revokes a sibling session and signals peers", async () => {
    authedAs("u1", "s-current");
    sessionDeleteMany.mockResolvedValue({ count: 1 });

    const res = await req("s-old");
    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toEqual({
      revoked: 1,
      currentSessionEnded: false,
    });
    expect(mockSignalRevocation).toHaveBeenCalledWith("u1");
  });

  it("is idempotent: a foreign or already-gone id is 200 with revoked 0", async () => {
    authedAs("u1", "s-current");
    sessionDeleteMany.mockResolvedValue({ count: 0 });

    const res = await req("someone-elses-or-gone");
    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toEqual({
      revoked: 0,
      currentSessionEnded: false,
    });
    // Nothing removed — no peer needs waking.
    expect(mockSignalRevocation).not.toHaveBeenCalled();
  });

  it("revoking the current session reports it and skips the signal", async () => {
    authedAs("u1", "s-current");
    sessionDeleteMany.mockResolvedValue({ count: 1 });

    const res = await req("s-current");
    await expect(res.json()).resolves.toEqual({
      revoked: 1,
      currentSessionEnded: true,
    });
    expect(mockSignalRevocation).not.toHaveBeenCalled();
  });

  it("rejects an empty id", async () => {
    authedAs("u1", "s-current");

    const res = await req("");
    expect(res.status).toBe(400);
    expect(sessionDeleteMany).not.toHaveBeenCalled();
  });
});

describe("POST /api/user/sessions/revoke-others (#1856)", () => {
  it("keeps the caller's session and signals when something was removed", async () => {
    authedAs("u1", "s-current");
    sessionDeleteMany.mockResolvedValue({ count: 2 });

    const res = await revokeOthers();
    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toEqual({ revoked: 2 });
    expect(sessionDeleteMany).toHaveBeenCalledWith({
      where: { userId: "u1", id: { not: "s-current" } },
    });
    expect(mockSignalRevocation).toHaveBeenCalledWith("u1");
  });

  it("stays silent when there was nothing else to revoke", async () => {
    authedAs("u1", "s-current");
    sessionDeleteMany.mockResolvedValue({ count: 0 });

    const res = await revokeOthers();
    await expect(res.json()).resolves.toEqual({ revoked: 0 });
    expect(mockSignalRevocation).not.toHaveBeenCalled();
  });
});

describe("GET /api/user/sessions failure paths (#1856)", () => {
  it("a DB failure is a 500 with the generic message, never a 401", async () => {
    authedAs("u1", "s-current");
    sessionFindMany.mockRejectedValue(new Error("connect ETIMEDOUT"));

    const res = await listSessions();

    // Mapping DB-down to 401 here would make the UI say "session ended"
    // instead of "retry" — the distinction the allowlist of messages
    // depends on.
    expect(res.status).toBe(500);
    await expect(res.json()).resolves.toMatchObject({
      error: "We couldn't load your sessions. Please try again.",
    });
  });

  it("a session-lookup failure (503) passes through untouched", async () => {
    const err = Response.json(
      { error: "unavailable", code: "SESSION_LOOKUP_FAILED" },
      { status: 503, headers: { "Retry-After": "2" } },
    );
    mockRequireApiAuth.mockResolvedValue({ error: err });

    expect(await listSessions()).toBe(err);
    expect(sessionFindMany).not.toHaveBeenCalled();
  });
});
