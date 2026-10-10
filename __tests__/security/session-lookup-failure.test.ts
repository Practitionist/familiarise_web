/**
 * @jest-environment node
 */

/**
 * A session lookup that fails is not "no session". The `customSession`
 * plugin swallows an adapter rejection into `null`, so `getSession()` settles
 * a null on a validly signed cookie with one row read: a thrown read, or a
 * null while the row is live, is a failure (`SessionLookupFailedError`, 503
 * `SESSION_LOOKUP_FAILED` + Retry-After from the guards); only a null with no
 * live row is "none" (401).
 */

const getSession = jest.fn();
jest.mock("../../lib/auth", () => ({
  __esModule: true,
  auth: { api: { getSession: (...a: unknown[]) => getSession(...a) } },
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

import { serializeSignedCookie } from "better-call";
import { requireApiAuth } from "../../lib/auth-helpers";
import { getSession as getServerSession } from "../../lib/auth-server";
import { lookupSession } from "../../lib/auth-session-lookup";
import { SessionLookupFailedError } from "../../lib/auth/session-lookup-error";
import { cookieSigningSecret } from "../../lib/auth/session-cookie";
import { apiError } from "../../lib/errors/api-error";

const SECRET = "test-secret-that-is-at-least-32-characters";
let liveCookie: { value: string };

/** The cookie value exactly as BetterAuth sets it (signed, URL-encoded). */
async function signedCookieValue(token: string) {
  const header = await serializeSignedCookie("c", token, SECRET);
  return header.split(";")[0].slice("c=".length);
}

beforeAll(async () => {
  process.env.BETTER_AUTH_SECRET = SECRET;
  liveCookie = { value: await signedCookieValue("tok_live") };
});

beforeEach(() => {
  jest.clearAllMocks();
  cookieGet.mockImplementation((name: string) =>
    name === "__Secure-better-auth.session_token" ? liveCookie : undefined,
  );
});

describe("requireApiAuth — session lookup failure is 503, not 401", () => {
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

  it("lets Next's prerender bail-out through untouched", async () => {
    // The build prerenders pages whose guards call this; the DYNAMIC_SERVER_USAGE
    // throw is how Next marks the route dynamic and must not read as a fault.
    const bailout = Object.assign(new Error("Dynamic server usage: headers"), {
      digest: "DYNAMIC_SERVER_USAGE",
    });
    getSession.mockRejectedValue(bailout);

    await expect(requireApiAuth()).rejects.toBe(bailout);
  });

  it("keeps 401 for a cookie whose session row is gone, and for no cookie at all", async () => {
    getSession.mockResolvedValue(null);
    sessionFindUnique.mockResolvedValue(null);
    expect((await requireApiAuth()).error?.status).toBe(401);

    cookieGet.mockReturnValue(undefined);
    expect((await requireApiAuth()).error?.status).toBe(401);
    expect(sessionFindUnique).toHaveBeenCalledTimes(1);
  });

  it.each([
    ["an unsigned token", async () => "tok_live"],
    ["a forged signature", async () => "tok_live.c2ln"],
    [
      "another token's signature",
      async () =>
        `tok_live.${decodeURIComponent(await signedCookieValue("tok_other")).split(".")[1]}`,
    ],
  ])("treats %s as no cookie: 401, no row read", async (_label, value) => {
    getSession.mockResolvedValue(null);
    sessionFindUnique.mockResolvedValue({
      expiresAt: new Date(Date.now() + 60_000),
    });
    liveCookie = { value: await value() };
    try {
      expect((await requireApiAuth()).error?.status).toBe(401);
      expect(sessionFindUnique).not.toHaveBeenCalled();
    } finally {
      liveCookie = { value: await signedCookieValue("tok_live") };
    }
  });
});

describe("getSession() is tri-state", () => {
  it("returns the session when the lookup finds one", async () => {
    const found = { user: { id: "u1", role: "CONSULTEE" }, session: {} };
    getSession.mockResolvedValue(found);
    await expect(getServerSession()).resolves.toBe(found);
    await expect(lookupSession()).resolves.toEqual({
      kind: "found",
      session: found,
    });
  });

  it("returns null (none) when the cookie's row is gone", async () => {
    getSession.mockResolvedValue(null);
    sessionFindUnique.mockResolvedValue(null);
    await expect(getServerSession()).resolves.toBeNull();
    await expect(lookupSession()).resolves.toEqual({ kind: "none" });
  });

  it("throws SessionLookupFailedError when the read rejects or the row is live", async () => {
    getSession.mockRejectedValue(new Error("connect ETIMEDOUT"));
    await expect(getServerSession()).rejects.toBeInstanceOf(
      SessionLookupFailedError,
    );

    getSession.mockResolvedValue(null);
    sessionFindUnique.mockResolvedValue({
      expiresAt: new Date(Date.now() + 60_000),
    });
    await expect(getServerSession()).rejects.toBeInstanceOf(
      SessionLookupFailedError,
    );
    await expect(lookupSession()).resolves.toMatchObject({ kind: "failed" });
  });

  it("maps the thrown error to 503 + Retry-After through apiError", async () => {
    const res = apiError({
      tag: "[test]",
      error: new SessionLookupFailedError(new Error("stall")),
    });
    expect(res.status).toBe(503);
    expect(res.headers.get("Retry-After")).toBe("2");
    await expect(res.json()).resolves.toMatchObject({
      code: "SESSION_LOOKUP_FAILED",
    });
  });
});

describe("cookie signing secret", () => {
  it("uses the current BETTER_AUTH_SECRETS entry when rotation is configured", async () => {
    expect(cookieSigningSecret("2:new-secret, 1:old-secret", "legacy")).toBe(
      "new-secret",
    );
    expect(cookieSigningSecret(undefined, "legacy")).toBe("legacy");
  });

  it("verifies a cookie signed with the rotated secret", async () => {
    const rotated = "rotated-secret-that-is-at-least-32-chars";
    process.env.BETTER_AUTH_SECRETS = `2:${rotated},1:${SECRET}`;
    const header = await serializeSignedCookie("c", "tok_rot", rotated);
    const value = header.split(";")[0].slice("c=".length);
    cookieGet.mockImplementation((name: string) =>
      name === "__Secure-better-auth.session_token" ? { value } : undefined,
    );
    getSession.mockResolvedValue(null);
    sessionFindUnique.mockResolvedValue({
      expiresAt: new Date(Date.now() + 60_000),
    });
    try {
      expect((await requireApiAuth()).error?.status).toBe(503);
      expect(sessionFindUnique).toHaveBeenCalledWith({
        where: { token: "tok_rot" },
        select: { expiresAt: true },
      });
    } finally {
      delete process.env.BETTER_AUTH_SECRETS;
    }
  });
});
