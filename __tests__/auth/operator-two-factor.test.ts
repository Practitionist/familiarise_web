/**
 * @jest-environment node
 */

/**
 * Staff sign-in is password + TOTP and nothing else. Two layers hold that:
 * `refusesOperatorSession` (the session.create.before gate in lib/auth.ts)
 * refuses every other way an operator session could be minted, and
 * `requireApiAuth` refuses an operator session that exists but has no
 * enrolled second factor.
 */
jest.mock("../../lib/auth-session-lookup", () => ({
  lookupSession: jest.fn(),
}));
jest.mock("@sentry/nextjs", () => ({}));
jest.mock("../../lib/observability/identity", () => ({
  setSentryIdentityFromSession: jest.fn(),
  setSentryOrgContext: jest.fn(),
}));
jest.mock("../../lib/observability/report", () => ({
  reportSentryError: jest.fn(),
}));
jest.mock("../../lib/prisma", () => ({ __esModule: true, default: {} }));

import { lookupSession } from "../../lib/auth-session-lookup";
import { requireApiAuth, requireApiSession } from "../../lib/auth-helpers";
import {
  isOperatorRole,
  refusesOperatorAccount,
  refusesOperatorSession,
} from "../../lib/auth/operator-session-policy";

const mockLookup = lookupSession as jest.MockedFunction<typeof lookupSession>;

function sessionFor(role: string, twoFactorEnabled?: boolean) {
  return {
    kind: "found",
    session: {
      session: { id: "s1", userId: "u1" },
      user: { id: "u1", role, banned: false, twoFactorEnabled },
    },
  } as unknown as Awaited<ReturnType<typeof lookupSession>>;
}

describe("refusesOperatorSession", () => {
  it.each([
    "/sign-in/email",
    "/two-factor/verify-totp",
    "/two-factor/verify-backup-code",
    "/change-password",
  ])("lets an operator session be minted by %s", (path) => {
    expect(refusesOperatorSession("STAFF", path)).toBe(false);
    expect(refusesOperatorSession("ADMIN", path)).toBe(false);
  });

  it.each([
    "/callback/:id",
    "/sign-in/social",
    "/sso/callback/:providerId",
    "/magic-link/verify",
    "/verify-email",
    "/sign-up/email",
    "/two-factor/enable",
    "/two-factor/disable",
    "/admin/impersonate-user",
    "/reset-password",
  ])("refuses an operator session minted by %s", (path) => {
    expect(refusesOperatorSession("STAFF", path)).toBe(true);
    expect(refusesOperatorSession("ADMIN", path)).toBe(true);
  });

  it("refuses an operator session with no request path (server-side mint)", () => {
    expect(refusesOperatorSession("ADMIN", undefined)).toBe(true);
  });

  it("never refuses a non-operator", () => {
    expect(refusesOperatorSession("USER", "/callback/:id")).toBe(false);
    expect(refusesOperatorSession("HOST", undefined)).toBe(false);
    expect(refusesOperatorSession(null, "/magic-link/verify")).toBe(false);
  });

  it("knows who the operators are", () => {
    expect(isOperatorRole("STAFF")).toBe(true);
    expect(isOperatorRole("ADMIN")).toBe(true);
    expect(isOperatorRole("USER")).toBe(false);
    expect(isOperatorRole(undefined)).toBe(false);
  });
});

describe("refusesOperatorAccount", () => {
  it.each(["google", "github", "sso-acme"])(
    "refuses linking %s to an operator",
    (providerId) => {
      expect(refusesOperatorAccount("STAFF", providerId)).toBe(true);
      expect(refusesOperatorAccount("ADMIN", providerId)).toBe(true);
    },
  );

  it("lets an operator hold a credential account", () => {
    expect(refusesOperatorAccount("ADMIN", "credential")).toBe(false);
  });

  it("never refuses a non-operator", () => {
    expect(refusesOperatorAccount("CONSULTEE", "google")).toBe(false);
    expect(refusesOperatorAccount(null, "sso-acme")).toBe(false);
  });
});

describe("requireApiAuth operator 2FA precondition", () => {
  beforeEach(() => mockLookup.mockReset());

  it.each(["STAFF", "ADMIN"])(
    "answers 428 enroll-2fa for an unenrolled %s",
    async (role) => {
      mockLookup.mockResolvedValue(sessionFor(role, false));
      const result = await requireApiAuth();
      expect(result.error?.status).toBe(428);
      expect(result.error?.headers.get("X-Auth-Action")).toBe("enroll-2fa");
      await expect(result.error?.json()).resolves.toMatchObject({
        code: "TWO_FACTOR_REQUIRED",
      });
    },
  );

  it("treats a missing flag as not enrolled", async () => {
    mockLookup.mockResolvedValue(sessionFor("STAFF", undefined));
    const result = await requireApiAuth();
    expect(result.error?.status).toBe(428);
  });

  it("passes an enrolled operator", async () => {
    mockLookup.mockResolvedValue(sessionFor("ADMIN", true));
    const result = await requireApiAuth();
    expect(result.error).toBeUndefined();
    expect(result.session?.user.role).toBe("ADMIN");
  });

  it("does not ask consumers for a second factor", async () => {
    mockLookup.mockResolvedValue(sessionFor("USER", false));
    const result = await requireApiAuth();
    expect(result.error).toBeUndefined();
  });

  it("requireApiSession lets an unenrolled operator reach the liveness probe", async () => {
    mockLookup.mockResolvedValue(sessionFor("STAFF", false));
    const result = await requireApiSession();
    expect(result.error).toBeUndefined();
  });
});
