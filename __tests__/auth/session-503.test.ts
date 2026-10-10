/**
 * @jest-environment node
 */

/**
 * `/api/auth/get-session` must not answer "signed out" for a lookup that
 * failed: with a validly signed cookie whose row is live (or unreadable), a
 * `200 null` becomes 503 + Retry-After, which the BetterAuth client treats
 * as an error and keeps its last session.
 */

const handlerGet = jest.fn();
jest.mock("better-auth/next-js", () => ({
  toNextJsHandler: () => ({
    GET: (...a: unknown[]) => handlerGet(...a),
    POST: jest.fn(),
  }),
}));
jest.mock("../../lib/auth", () => ({ __esModule: true, auth: {} }));

const sessionFindUnique = jest.fn();
jest.mock("../../lib/prisma", () => ({
  __esModule: true,
  default: {
    session: { findUnique: (...a: unknown[]) => sessionFindUnique(...a) },
  },
}));

import { serializeSignedCookie } from "better-call";
import { GET } from "../../app/api/auth/[...all]/route";

const SECRET = "test-secret-that-is-at-least-32-characters";
let cookie: string;

beforeAll(async () => {
  process.env.BETTER_AUTH_SECRET = SECRET;
  const header = await serializeSignedCookie(
    "__Secure-better-auth.session_token",
    "tok_live",
    SECRET,
  );
  cookie = header.split(";")[0];
});

beforeEach(() => {
  jest.clearAllMocks();
  handlerGet.mockImplementation(
    async () =>
      new Response("null", {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
  );
});

function getSession(withCookie = true) {
  return GET(
    new Request("https://app.test/api/auth/get-session", {
      headers: withCookie ? { cookie } : {},
    }),
  );
}

describe("GET /api/auth/get-session", () => {
  it("answers 503 + Retry-After when the cookie's row is live", async () => {
    sessionFindUnique.mockResolvedValue({
      expiresAt: new Date(Date.now() + 60_000),
    });
    const res = await getSession();
    expect(res.status).toBe(503);
    expect(res.headers.get("Retry-After")).toBe("2");
    await expect(res.json()).resolves.toMatchObject({
      code: "SESSION_LOOKUP_FAILED",
    });
    expect(sessionFindUnique).toHaveBeenCalledWith({
      where: { token: "tok_live" },
      select: { expiresAt: true },
    });
  });

  it("answers 503 when the row read itself fails", async () => {
    sessionFindUnique.mockRejectedValue(new Error("ETIMEDOUT"));
    expect((await getSession()).status).toBe(503);
  });

  it("passes the null through when the row is gone or expired", async () => {
    sessionFindUnique.mockResolvedValue(null);
    const gone = await getSession();
    expect(gone.status).toBe(200);
    expect(await gone.text()).toBe("null");

    sessionFindUnique.mockResolvedValue({ expiresAt: new Date(0) });
    expect((await getSession()).status).toBe(200);
  });

  it("passes the null through with no cookie, without a row read", async () => {
    const res = await getSession(false);
    expect(res.status).toBe(200);
    expect(sessionFindUnique).not.toHaveBeenCalled();
  });

  it("leaves a found session and other endpoints alone", async () => {
    handlerGet.mockResolvedValue(
      new Response(JSON.stringify({ user: { id: "u1" } }), { status: 200 }),
    );
    expect((await getSession()).status).toBe(200);
    expect(sessionFindUnique).not.toHaveBeenCalled();
  });
});
