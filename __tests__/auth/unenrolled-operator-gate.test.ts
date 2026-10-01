/**
 * @jest-environment node
 */

/**
 * The fail-closed operator 2FA gate in lib/auth-server.ts. A STAFF/ADMIN
 * session without enrolled 2FA reads as no session through `getSession()`, so
 * a route with an inline role check (app/api/user/[id]) answers 401, while
 * the enrolment path still sees the session: `requireApiAuth` answers 428 and
 * the setup page's guard lets the operator in.
 */

const mockGetSession = jest.fn();
jest.mock("../../lib/auth", () => ({
  auth: { api: { getSession: (...a: unknown[]) => mockGetSession(...a) } },
}));
jest.mock("next/headers", () => ({
  headers: async () => new Headers(),
  cookies: async () => ({ get: () => undefined }),
}));
jest.mock("next/navigation", () => ({
  redirect: (to: string) => {
    throw new Error(`REDIRECT ${to}`);
  },
}));
jest.mock("@sentry/nextjs", () => ({ captureException: jest.fn() }));
jest.mock("../../lib/observability/report", () => ({
  reportSentryError: jest.fn(),
  reportSentryMessage: jest.fn(),
}));
jest.mock("../../lib/observability/identity", () => ({
  setSentryIdentityFromSession: jest.fn(),
  setSentryOrgContext: jest.fn(),
}));
jest.mock("../../lib/prisma", () => ({ __esModule: true, default: {} }));
jest.mock("../../lib/data/user-details", () => ({
  getUserDetails: jest.fn(async (id: string) => ({ id })),
}));
jest.mock("../../utils/onboarding-server", () => ({}));
jest.mock("../../lib/compliance/erasure/scrub-user", () => ({}));
jest.mock("../../lib/novu/subscriber", () => ({}));
jest.mock("../../lib/profiles/ensure-org-workspace-profile", () => ({}));

import { NextRequest } from "next/server";
import { GET } from "@/app/api/user/[id]/route";
import { requireApiAuth } from "@/lib/auth-helpers";
import { requireOperatorAwaitingTwoFactor } from "@/lib/auth-guard";

function operator(twoFactorEnabled: boolean) {
  return {
    session: { id: "s1", userId: "admin_1" },
    user: {
      id: "admin_1",
      role: "ADMIN",
      banned: false,
      onboardingCompleted: true,
      twoFactorEnabled,
    },
  };
}

const getUser = (id: string) =>
  GET(new NextRequest(`https://x.test/api/user/${id}`), {
    params: Promise.resolve({ id }),
  });

beforeEach(() => mockGetSession.mockReset());

describe("an operator who has not enrolled 2FA", () => {
  beforeEach(() => mockGetSession.mockResolvedValue(operator(false)));

  it("gets 401 from a route that checks the role inline", async () => {
    expect((await getUser("someone_else")).status).toBe(401);
    expect((await getUser("admin_1")).status).toBe(401);
  });

  it("gets 428 TWO_FACTOR_REQUIRED, not 401, from requireApiAuth", async () => {
    const result = await requireApiAuth();
    expect(result.error?.status).toBe(428);
    const body = await result.error?.json();
    expect(body?.code).toBe("TWO_FACTOR_REQUIRED");
  });

  it("is let into the setup page", async () => {
    await expect(requireOperatorAwaitingTwoFactor()).resolves.toMatchObject({
      user: { id: "admin_1" },
    });
  });
});

describe("an enrolled operator", () => {
  beforeEach(() => mockGetSession.mockResolvedValue(operator(true)));

  it("passes the inline role check", async () => {
    expect((await getUser("someone_else")).status).toBe(200);
  });

  it("is sent from the setup page to the dashboard", async () => {
    await expect(requireOperatorAwaitingTwoFactor()).rejects.toThrow(
      "REDIRECT /dashboard",
    );
  });
});

it("leaves a consumer session alone", async () => {
  mockGetSession.mockResolvedValue({
    session: { id: "s2", userId: "u1" },
    user: { id: "u1", role: "CONSULTEE", banned: false },
  });
  expect((await getUser("u1")).status).toBe(200);
});
