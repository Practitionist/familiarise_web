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
const sessionCount = jest.fn();
const sessionDeleteMany = jest.fn();
jest.mock("../../lib/prisma", () => ({
  __esModule: true,
  default: {
    session: {
      findMany: (...a: unknown[]) => sessionFindMany(...a),
      count: (...a: unknown[]) => sessionCount(...a),
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

const mockApplyRateLimit = jest.fn();
jest.mock("../../lib/rate-limit", () => ({
  __esModule: true,
  applyRateLimit: (...a: unknown[]) => mockApplyRateLimit(...a),
  sessionMgmtUserLimiter: {},
}));

// `lib/auth/session-revoke` is deliberately NOT mocked: the routes are
// exercised through the real helper, so the assertions below pin the
// effect, not a re-implementation in the test.
import { NextRequest } from "next/server";
import { GET as listSessionsRoute } from "../../app/api/user/sessions/route";
import { DELETE as revokeSession } from "../../app/api/user/sessions/[sessionId]/route";
import { POST as revokeOthers } from "../../app/api/user/sessions/revoke-others/route";

const listSessions = (query = "") =>
  listSessionsRoute(
    new NextRequest(`https://app.test/api/user/sessions${query}`),
  );

const authedAs = (userId: string, sessionId: string) =>
  mockRequireApiAuth.mockResolvedValue({
    session: { user: { id: userId }, session: { id: sessionId } },
  });

beforeEach(() => {
  jest.clearAllMocks();
  mockApplyRateLimit.mockResolvedValue(null);
  sessionCount.mockResolvedValue(1);
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
    expect(body.total).toBe(1);
    expect(body.nextCursor).toBeNull();
    // Only unexpired rows, one page (plus one row to detect the next page).
    expect(sessionFindMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { userId: "u1", expiresAt: { gt: expect.any(Date) } },
        take: 26,
      }),
    );
    // The select is the allowlist — assert no token at the query level.
    const select = sessionFindMany.mock.calls[0][0].select;
    expect(select).not.toHaveProperty("token");
  });

  it("pages with a cursor and reports the next one", async () => {
    authedAs("u1", "s-current");
    const row = (i: number) => ({
      id: `s-${i}`,
      createdAt: new Date(2026, 0, 30 - i),
      updatedAt: new Date(2026, 0, 30 - i),
      expiresAt: new Date(2026, 2, 1),
      ipAddress: null,
      userAgent: null,
    });
    sessionFindMany.mockResolvedValue(
      Array.from({ length: 26 }, (_, i) => row(i)),
    );
    sessionCount.mockResolvedValue(40);

    const body = await (await listSessions("?cursor=s-prev")).json();
    expect(body.sessions).toHaveLength(25);
    expect(body.total).toBe(40);
    expect(body.nextCursor).toBe("s-24");
    expect(sessionFindMany).toHaveBeenCalledWith(
      expect.objectContaining({ cursor: { id: "s-prev" }, skip: 1 }),
    );
  });

  it("passes auth errors through", async () => {
    const err = Response.json({ error: "Unauthorized" }, { status: 401 });
    mockRequireApiAuth.mockResolvedValue({ error: err });

    expect(await listSessions()).toBe(err);
    expect(sessionFindMany).not.toHaveBeenCalled();
  });

  it("keys the per-user limiter and passes 429s through untouched", async () => {
    authedAs("u1", "s-current");
    const limited = Response.json(
      {
        error: "Too many requests. Please try again later.",
        code: "RATE_LIMITED",
      },
      { status: 429 },
    );
    mockApplyRateLimit.mockResolvedValueOnce(limited);

    expect(await listSessions()).toBe(limited);
    // The IP rule is coarse friction for NAT offices; this per-user
    // bucket is the precise gate — assert it is consulted with the
    // caller's id before any database read.
    expect(mockApplyRateLimit).toHaveBeenCalledWith({}, "session-mgmt-user:u1");
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
  });

  it("revoking the current session reports it", async () => {
    authedAs("u1", "s-current");
    sessionDeleteMany.mockResolvedValue({ count: 1 });

    const res = await req("s-current");
    await expect(res.json()).resolves.toEqual({
      revoked: 1,
      currentSessionEnded: true,
    });
  });

  it("rejects an empty id", async () => {
    authedAs("u1", "s-current");

    const res = await req("");
    expect(res.status).toBe(400);
    expect(sessionDeleteMany).not.toHaveBeenCalled();
  });
});

describe("POST /api/user/sessions/revoke-others (#1856)", () => {
  it("keeps the caller's session and removes the rest", async () => {
    authedAs("u1", "s-current");
    sessionDeleteMany.mockResolvedValue({ count: 2 });

    const res = await revokeOthers();
    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toEqual({ revoked: 2 });
    expect(sessionDeleteMany).toHaveBeenCalledWith({
      where: { userId: "u1", id: { not: "s-current" } },
    });
  });

  it("reports 0 when there was nothing else to revoke", async () => {
    authedAs("u1", "s-current");
    sessionDeleteMany.mockResolvedValue({ count: 0 });

    const res = await revokeOthers();
    await expect(res.json()).resolves.toEqual({ revoked: 0 });
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
