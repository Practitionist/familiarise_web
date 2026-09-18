/**
 * @jest-environment node
 */

/**
 * #1716 — a session lookup that fails is not "no session". On a cold
 * instance a ~27 s stalled adapter read on a VALID cookie came back as 401
 * and the client offered sign-in to a signed-in consultant. The
 * `customSession` plugin swallows the adapter's rejection into `null`
 * (better-auth 1.6.5, `plugins/custom-session/index.mjs:50`), so the helper
 * has to tell the two apart itself: a thrown lookup, or a null while the
 * session row is live, answers 503 `SESSION_LOOKUP_FAILED` + Retry-After;
 * only a null with no live row is 401.
 */

const getSession = jest.fn();
jest.mock("../../lib/auth-server", () => ({
  __esModule: true,
  getSession: (...a: unknown[]) => getSession(...a),
}));

const cookieGet = jest.fn();
jest.mock("next/headers", () => ({
  cookies: async () => ({ get: (name: string) => cookieGet(name) }),
  headers: async () => new Headers(),
}));

const sessionFindUnique = jest.fn();
jest.mock("../../lib/prisma", () => ({
  __esModule: true,
  default: {
    session: { findUnique: (...a: unknown[]) => sessionFindUnique(...a) },
  },
}));

jest.mock("../../lib/observability/report", () => ({
  __esModule: true,
  reportSentryError: jest.fn(),
}));

import { requireApiAuth } from "../../lib/auth-helpers";

const LIVE_COOKIE = { value: "tok_live.c2ln" };

beforeEach(() => {
  jest.clearAllMocks();
  cookieGet.mockImplementation((name: string) =>
    name === "__Secure-better-auth.session_token" ? LIVE_COOKIE : undefined,
  );
});

describe("requireApiAuth — session lookup failure is 503, not 401 (#1716)", () => {
  it("answers 503 with Retry-After when the adapter promise rejects", async () => {
    getSession.mockRejectedValue(new Error("connect ETIMEDOUT"));

    const out = await requireApiAuth();

    expect(out.error?.status).toBe(503);
    expect(out.error?.headers.get("Retry-After")).toBe("2");
    await expect(out.error?.json()).resolves.toMatchObject({
      code: "SESSION_LOOKUP_FAILED",
    });
  });

  it("answers 503 when the plugin swallowed the failure into null but the row is live", async () => {
    getSession.mockResolvedValue(null);
    sessionFindUnique.mockResolvedValue({
      expiresAt: new Date(Date.now() + 60_000),
    });

    const out = await requireApiAuth();

    expect(sessionFindUnique).toHaveBeenCalledWith({
      where: { token: "tok_live" },
      select: { expiresAt: true },
    });
    expect(out.error?.status).toBe(503);
  });

  it("keeps 401 for a cookie whose session row is gone, and for no cookie at all", async () => {
    getSession.mockResolvedValue(null);
    sessionFindUnique.mockResolvedValue(null);
    expect((await requireApiAuth()).error?.status).toBe(401);

    cookieGet.mockReturnValue(undefined);
    expect((await requireApiAuth()).error?.status).toBe(401);
    expect(sessionFindUnique).toHaveBeenCalledTimes(1);
  });
});
