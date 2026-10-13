/**
 * @jest-environment node
 */

/**
 * Money and IAM writes carry `X-Expected-User` (the user the page was
 * rendered for). `requireApiAuth({ expectUser: true })` answers 409
 * `IDENTITY_CHANGED` when the cookie now belongs to someone else, so a tab
 * left open across an account switch cannot spend or grant as the new user.
 */

const lookupSession = jest.fn();
jest.mock("../../lib/auth-session-lookup", () => ({
  __esModule: true,
  lookupSession: () => lookupSession(),
}));

let requestHeaders = new Headers();
jest.mock("next/headers", () => ({
  headers: async () => requestHeaders,
}));

jest.mock("../../lib/observability/identity", () => ({
  setSentryIdentityFromSession: jest.fn(),
  setSentryOrgContext: jest.fn(),
}));
jest.mock("../../lib/observability/report", () => ({
  reportSentryError: jest.fn(),
}));
jest.mock("../../lib/prisma", () => ({ __esModule: true, default: {} }));

import { requireApiAuth } from "../../lib/auth-helpers";
import { EXPECTED_USER_HEADER } from "../../lib/auth/identity-header";

beforeEach(() => {
  lookupSession.mockResolvedValue({
    kind: "found",
    session: {
      session: { id: "s1" },
      user: { id: "u-new", role: "CONSULTEE", banned: false },
    },
  });
  requestHeaders = new Headers();
});

describe("requireApiAuth({ expectUser: true })", () => {
  it("answers 409 IDENTITY_CHANGED when the page belongs to another user", async () => {
    requestHeaders.set(EXPECTED_USER_HEADER, "u-old");
    const out = await requireApiAuth({ expectUser: true });
    expect(out.error?.status).toBe(409);
    await expect(out.error?.json()).resolves.toMatchObject({
      code: "IDENTITY_CHANGED",
    });
  });

  it("passes when the expected user matches", async () => {
    requestHeaders.set(EXPECTED_USER_HEADER, "u-new");
    const out = await requireApiAuth({ expectUser: true });
    expect(out.session?.user.id).toBe("u-new");
  });

  it("passes when no expected user was sent", async () => {
    const out = await requireApiAuth({ expectUser: true });
    expect(out.error).toBeUndefined();
  });

  it("ignores the header unless the route opts in", async () => {
    requestHeaders.set(EXPECTED_USER_HEADER, "u-old");
    const out = await requireApiAuth();
    expect(out.error).toBeUndefined();
  });
});
